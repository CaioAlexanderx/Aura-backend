// ============================================================
// AURA. — Venda do Caixa com menos idas ao banco (cards p-141 a p-144,
// 17/11/2026)
//
// O servico e o banco ficam em regioes diferentes: cada `client.query` em
// fila custa ~190 ms (src/config/database.js). A venda de 1 item no PIX
// fazia 16 idas dentro do handleSale, mais 4 por item. Este arquivo junta as
// consultas que podem ir juntas, SEM mudar o que a venda grava nem o que ela
// responde:
//
//   abrir()          BEGIN + trava da chave de idempotencia + busca da chave
//                    + pdv_settings + sessao do caixa num envio so (p-144,
//                    p-143). Antes: 3 a 6 idas.
//   lerProdutos()    todos os produtos e variacoes da venda numa consulta,
//                    com a promocao De/Por e a vendedora junto (p-141).
//                    Antes: 1 por item, +1 por variacao, +2 da promocao,
//                    +1 da vendedora.
//   gravarItens()    sale_items, baixa de estoque, stock_movements, contador
//                    da vendedora e uso do cupom num comando so, que ja
//                    devolve os itens da resposta (p-142, p-143). Antes: 3
//                    por item, +1 da vendedora, +1 do cupom, +1 da releitura.
//   gravarPagamentos() sale_payments e a receita no financeiro num comando
//                    so (p-143). Antes: 1 por forma de pagamento + 1.
//
// O CAMINHO DE SEMPRE CONTINUA NO CODIGO (routes/pdv.js), intocado:
//   - PDV_VENDA_CAMINHO=fila volta a venda inteira para ele, sem deploy de
//     codigo;
//   - cada funcao daqui devolve null quando o caso foge do comum (id que nao
//     e uuid minusculo, quantidade negativa em linha repetida...) e a venda
//     segue pelo caminho de sempre naquele trecho;
//   - __tests__/pdv.vendaRapida.banco.test.js roda cada cenario nos dois
//     caminhos, no Postgres de verdade, e exige banco e resposta identicos.
//
// UMA DIFERENCA DE PROPOSITO (p-142): a leitura dos produtos trava as linhas
// de estoque que a venda vai baixar (FOR NO KEY UPDATE, a mesma trava que o
// UPDATE da baixa ja pegava, so que antes da conferencia). Duas vendas
// simultaneas do ultimo item: a segunda espera a primeira, enxerga o saldo
// ja baixado e recebe o 409 de estoque. No caminho de sempre as duas liam o
// saldo antes de qualquer baixa e as duas entravam.
// ============================================================
'use strict';

const { productVisibilityWhere } = require('../utils/companyGroup');
const vendaNaPromocao = require('./vendaNaPromocao');

// So uuid minusculo no formato canonico entra no caminho novo. Qualquer outra
// forma (maiuscula, sem hifen, texto solto) segue pelo caminho de sempre, que
// trata cada uma como sempre tratou.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ehUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// Mesmo formato que services/vendaIdempotente.js aceita no cabecalho.
const CHAVE_RE = /^[A-Za-z0-9_-]{8,128}$/;

function caminhoRapido() {
  return String(process.env.PDV_VENDA_CAMINHO || '').trim().toLowerCase() !== 'fila';
}

// ── abrir ────────────────────────────────────────────────────
// Um envio com varios comandos nao aceita parametros ($1). Os dois unicos
// valores que entram no texto sao conferidos aqui, caractere a caractere:
// o id da empresa (uuid minusculo) e a chave de idempotencia (letras,
// numeros, _ e -). Nenhum dos dois formatos admite aspas ou barra.
function textoSeguro(v) {
  const s = String(v);
  if (!/^[A-Za-z0-9_:-]+$/.test(s)) throw new Error('valor fora do formato para a abertura da venda');
  return `'${s}'`;
}

// Se o envio unico falhar (por exemplo, um pooler que nao aceite varios
// comandos de uma vez), a venda NAO cai: abre pelo caminho de sempre e este
// processo para de tentar por um tempo.
const PAUSA_DA_ABERTURA_MS = 5 * 60 * 1000;
let aberturaPausadaAte = 0;

function _resetarParaTeste() { aberturaPausadaAte = 0; }

const SQL_CONTEXTO = (empresa) =>
  `SELECT c.pdv_settings,
          (SELECT s.id FROM caixa_sessoes s
            WHERE s.company_id = c.id AND s.status = 'aberta' LIMIT 1) AS sessao_id
     FROM companies c WHERE c.id = ${empresa}::uuid`;

/**
 * Abre a transacao da venda num envio so.
 *
 * Com chave de idempotencia, os comandos sao os MESMOS de
 * vendaIdempotente.travarEBuscar, na mesma ordem: a trava
 * (pg_advisory_xact_lock) e depois a busca da venda da chave. Cada comando
 * do envio e executado em separado pelo Postgres, entao a busca roda DEPOIS
 * que a trava foi concedida e enxerga a venda que a outra requisicao acabou
 * de gravar — a garantia contra venda em dobro e a mesma.
 *
 * Devolve:
 *   { jaFeita, contexto: { pdvSettings, sessaoId } }  transacao aberta
 *   null  nao abriu por aqui (nada ficou aberto): quem chamou abre pelo
 *         caminho de sempre.
 */
async function abrir(client, { companyId, idemKey }) {
  if (!ehUuid(companyId)) return null;
  if (idemKey && !CHAVE_RE.test(String(idemKey))) return null;
  if (Date.now() < aberturaPausadaAte) return null;

  const empresa = textoSeguro(companyId);
  const comandos = ['BEGIN'];
  if (idemKey) {
    comandos.push(`SELECT pg_advisory_xact_lock(hashtext(${textoSeguro(`pdv-sale:${companyId}:${idemKey}`)}::text))`);
    comandos.push(`SELECT id FROM sales WHERE company_id = ${empresa}::uuid AND idempotency_key = ${textoSeguro(idemKey)}::text LIMIT 1`);
  }
  comandos.push(SQL_CONTEXTO(empresa));

  let resultados;
  try {
    resultados = await client.query(comandos.join(';\n'));
    if (!Array.isArray(resultados) || resultados.length !== comandos.length) {
      throw new Error('a abertura em um envio nao devolveu um resultado por comando');
    }
  } catch (e) {
    aberturaPausadaAte = Date.now() + PAUSA_DA_ABERTURA_MS;
    console.warn('[PDV] abertura da venda em um envio falhou; seguindo pelo caminho de sempre:', e && e.message);
    // O BEGIN pode ter entrado: garante que nada fica aberto antes de devolver.
    try { await client.query('ROLLBACK'); } catch (_) { /* nada aberto */ }
    return null;
  }

  const linhaDoContexto = resultados[resultados.length - 1].rows?.[0] || null;
  const busca = idemKey ? resultados[resultados.length - 2] : null;
  return {
    jaFeita: busca?.rows?.[0]?.id || null,
    contexto: {
      pdvSettings: linhaDoContexto ? (linhaDoContexto.pdv_settings || null) : null,
      sessaoId: linhaDoContexto ? (linhaDoContexto.sessao_id || null) : null,
    },
  };
}

/** A loja exige caixa aberto e nao ha sessao aberta? (mesma regra de assertCaixaOpenOrAllowed) */
function caixaFechado(contexto) {
  const exige = !!(contexto && contexto.pdvSettings && contexto.pdvSettings.caixa_enabled);
  return exige && !contexto.sessaoId;
}

// ── lerProdutos ──────────────────────────────────────────────
/**
 * Le, numa consulta, o que o laco de validacao lia item a item:
 *   - o produto (nome, custo, saldo, empresa dona), pela MESMA regra de
 *     visibilidade (utils/companyGroup.js);
 *   - a variacao (saldo, sufixo), so quando e do produto;
 *   - com `comPromocao`, as colunas da promocao De/Por do produto e da
 *     variacao (o que vendaNaPromocao.marcarItens relia depois);
 *   - com `employeeId`, se a vendedora e da empresa.
 *
 * Trava (FOR NO KEY UPDATE) exatamente as linhas que a venda vai baixar: o
 * produto do item sem variacao e a variacao do item com variacao. O saldo
 * devolvido e o da linha travada. As travas sao pegas em ordem de id, os
 * produtos antes das variacoes.
 *
 * Devolve null quando algum id nao e uuid minusculo (a venda valida item a
 * item, como sempre). Senao:
 *   { porItem: [{ p: [linha]|[], v: [linha]|[], marcacao }|null], vendedora }
 *   porItem[i] e null para item sem product_id; `vendedora` e true/false
 *   quando foi conferida aqui e undefined quando nao foi.
 */
async function lerProdutos(client, { companyId, items, employeeId, comPromocao, agora = new Date() }) {
  if (!ehUuid(companyId)) return null;
  const indices = [];
  for (const [idx, item] of items.entries()) {
    if (!item || !item.product_id) continue;
    if (!ehUuid(item.product_id)) return null;
    if (item.variant_id && !ehUuid(item.variant_id)) return null;
    indices.push(idx);
  }
  const porItem = items.map(() => null);
  if (!indices.length) return { porItem, vendedora: undefined };

  const comVendedora = ehUuid(employeeId);
  const params = [
    indices.map((idx) => items[idx].product_id),
    companyId,
    indices.map((idx) => items[idx].variant_id || null),
  ];
  if (comVendedora) params.push(employeeId);

  const { rows } = await client.query(
    `WITH itens AS (
       SELECT i.ord, i.product_id, i.variant_id
         FROM unnest($1::uuid[], $3::uuid[]) WITH ORDINALITY AS i(product_id, variant_id, ord)
     ),
     prod AS (
       SELECT p.id, p.name, p.cost_price, p.stock_qty, p.company_id, p.unit
              ${comPromocao ? ', p.price, p.promo_price, p.promo_starts_at, p.promo_ends_at' : ''}
         FROM products p JOIN companies c ON c.id = $2
        WHERE p.id IN (SELECT product_id FROM itens) AND ${productVisibilityWhere('$2', 'p.')}
     ),
     trava_p AS (
       SELECT p.id, p.stock_qty
         FROM products p
        WHERE p.id IN (SELECT i.product_id FROM itens i JOIN prod ON prod.id = i.product_id
                        WHERE i.variant_id IS NULL)
        ORDER BY p.id
          FOR NO KEY UPDATE
     ),
     trava_v AS (
       SELECT v.id, v.product_id, v.stock_qty, v.sku_suffix
              ${comPromocao ? ', v.price_override, v.promo_price, v.promo_starts_at, v.promo_ends_at' : ''}
         FROM product_variants v
        WHERE (v.id, v.product_id) IN (SELECT i.variant_id, i.product_id FROM itens i
                                         JOIN prod ON prod.id = i.product_id
                                        WHERE i.variant_id IS NOT NULL)
          -- as travas dos produtos sao pegas antes das travas das variacoes
          AND (SELECT COUNT(*) FROM trava_p) >= 0
        ORDER BY v.id
          FOR NO KEY UPDATE
     )
     SELECT i.ord, prod.name, prod.cost_price,
            COALESCE(tp.stock_qty, prod.stock_qty) AS stock_qty,
            prod.company_id AS stock_company_id, prod.unit,
            tv.id AS variante_id, tv.stock_qty AS variante_stock_qty, tv.sku_suffix AS variante_sku_suffix
            ${comPromocao ? `, prod.price, prod.promo_price, prod.promo_starts_at, prod.promo_ends_at,
            tv.price_override AS variante_price_override, tv.promo_price AS variante_promo_price,
            tv.promo_starts_at AS variante_promo_starts_at, tv.promo_ends_at AS variante_promo_ends_at` : ''}
            ${comVendedora ? ', (SELECT e.id FROM employees e WHERE e.id = $4 AND e.company_id = $2) AS vendedora_id' : ''}
       FROM itens i
       JOIN prod ON prod.id = i.product_id
       LEFT JOIN trava_p tp ON tp.id = i.product_id AND i.variant_id IS NULL
       LEFT JOIN trava_v tv ON tv.id = i.variant_id AND tv.product_id = i.product_id
      ORDER BY i.ord`,
    params
  );

  for (const idx of indices) porItem[idx] = { p: [], v: [], marcacao: comPromocao ? vendaNaPromocao.NULO : null };
  for (const r of rows) {
    const idx = indices[Number(r.ord) - 1];
    const item = items[idx];
    const alvo = porItem[idx];
    alvo.p = [{ name: r.name, cost_price: r.cost_price, stock_qty: r.stock_qty, stock_company_id: r.stock_company_id, unit: r.unit }];
    if (item.variant_id && r.variante_id) {
      alvo.v = [{ stock_qty: r.variante_stock_qty, sku_suffix: r.variante_sku_suffix }];
    }
    if (comPromocao) {
      // Mesma conta de vendaNaPromocao.marcarItens, com as linhas ja lidas.
      const produto = {
        price: r.price, promo_price: r.promo_price,
        promo_starts_at: r.promo_starts_at, promo_ends_at: r.promo_ends_at,
      };
      if (!item.variant_id) {
        alvo.marcacao = vendaNaPromocao.marcacaoDoItem(produto, null, agora);
      } else if (r.variante_id) {
        alvo.marcacao = vendaNaPromocao.marcacaoDoItem(produto, {
          price_override: r.variante_price_override, promo_price: r.variante_promo_price,
          promo_starts_at: r.variante_promo_starts_at, promo_ends_at: r.variante_promo_ends_at,
        }, agora);
      }
      // Variacao que nao e deste produto: sem marcacao (NULO), como sempre.
    }
  }
  // Sem nenhuma linha, a subconsulta da vendedora nao foi devolvida.
  const vendedora = comVendedora && rows.length ? !!rows[0].vendedora_id : undefined;
  return { porItem, vendedora };
}

// ── gravarItens ──────────────────────────────────────────────
const alvoDaBaixa = (i) => (i.variant_id ? `v:${i.variant_id}:${i.product_id}` : `p:${i.product_id}`) + `:${i.stock_company_id}`;

/**
 * O comando unico soma as quantidades das linhas que baixam o mesmo saldo.
 * Com quantidades positivas, somar e baixar de uma vez da o mesmo resultado
 * de baixar linha a linha (o saldo para em zero nos dois). Com quantidade
 * zero, negativa ou que nao e numero em linha repetida, nao: ai a venda
 * grava linha a linha, como sempre.
 */
function podeGravarDeUmaVez(itens) {
  const vistos = new Map();
  for (const i of itens) {
    if (i.product_id && !ehUuid(i.product_id)) return false;
    if (i.variant_id && !ehUuid(i.variant_id)) return false;
    if (i.product_id && !ehUuid(i.stock_company_id)) return false;
    if (!i.product_id) continue;
    const chave = alvoDaBaixa(i);
    vistos.set(chave, (vistos.get(chave) || []).concat([i.quantity]));
  }
  for (const quantidades of vistos.values()) {
    if (quantidades.length < 2) continue;
    for (const q of quantidades) {
      const n = typeof q === 'number' ? q : Number(String(q).trim());
      if (!Number.isFinite(n) || !(n > 0) || String(q).trim() === '') return false;
    }
  }
  return true;
}

/**
 * sale_items + baixa do estoque + stock_movements num comando so, mais o
 * contador da vendedora e o uso do cupom quando a venda tem um ou outro.
 *
 * Cada parte e a MESMA do laco de sempre:
 *   - um sale_items por linha, na ordem do carrinho, com os mesmos valores;
 *   - item sem variacao: products.stock_qty = GREATEST(0, saldo - qtd), so
 *     na linha da empresa dona (stock_company_id);
 *   - item com variacao: product_variants.stock_qty, so quando a variacao e
 *     do produto e o produto e da empresa dona;
 *   - um stock_movements 'out' por linha com produto.
 *
 * Devolve os itens gravados, na ordem do carrinho, no formato da releitura
 * que a resposta fazia (si.* + product_name), ou null quando o caso pede o
 * caminho de sempre (nada foi gravado).
 */
async function gravarItens(client, {
  saleId, companyId, itens, marcacoes, employeeId, totalAmount, couponId,
}) {
  if (!itens.length || !podeGravarDeUmaVez(itens)) return null;
  const comMarca = !!marcacoes;
  const col = (fn) => itens.map(fn);

  const params = [
    saleId,
    col((i) => i.product_id || null),
    col((i) => i.variant_id || null),
    col((i) => i.quantity),
    col((i) => i.unit_price),
    col((i) => i.cost_price),
    col((i) => i.item_discount || 0),
    col((i) => i.line_total),
    col((i) => i.product_name_snapshot),
    col((i) => (i.product_id ? i.stock_company_id : null)),
    // INC-2026-11-18-02: servico (unit 'srv') nao baixa nem gera movimento.
    col((i) => !i.sem_baixa_de_estoque),
  ];
  let marcaCols = '';
  let marcaSrc = '';
  let marcaUnnest = '';
  let marcaAlias = '';
  if (comMarca) {
    params.push(col((_, idx) => marcacoes[idx].preco_lista), col((_, idx) => marcacoes[idx].em_promocao));
    marcaUnnest = `, $${params.length - 1}::numeric[], $${params.length}::boolean[]`;
    marcaAlias = ', preco_lista, em_promocao';
    marcaCols = ', preco_lista, em_promocao';
    marcaSrc = ', src.preco_lista, src.em_promocao';
  }
  let vendedoraCte = '';
  if (employeeId) {
    params.push(totalAmount, employeeId, companyId);
    vendedoraCte = `,
     vendedora AS (
       UPDATE employees SET total_sales = COALESCE(total_sales,0) + 1,
              total_revenue = COALESCE(total_revenue,0) + $${params.length - 2}, updated_at = NOW()
        WHERE id = $${params.length - 1} AND company_id = $${params.length}
     )`;
  }
  let cupomCte = '';
  if (couponId) {
    params.push(couponId);
    cupomCte = `,
     cupom AS (
       UPDATE coupons SET current_uses = current_uses + 1, updated_at = NOW() WHERE id = $${params.length}
     )`;
  }

  const { rows } = await client.query(
    `WITH src AS (
       SELECT t.ord, uuid_generate_v4() AS id, t.product_id, t.variant_id, t.quantity, t.unit_price,
              t.unit_cost, t.discount, t.total_price, t.nome, t.stock_company_id, t.baixa${marcaAlias ? ', t.preco_lista, t.em_promocao' : ''}
         FROM unnest($2::uuid[], $3::uuid[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[],
                     $8::numeric[], $9::text[], $10::uuid[], $11::boolean[]${marcaUnnest})
              WITH ORDINALITY AS t(product_id, variant_id, quantity, unit_price, unit_cost, discount,
                                   total_price, nome, stock_company_id, baixa${marcaAlias}, ord)
     ),
     itens_gravados AS (
       INSERT INTO sale_items (id, sale_id, product_id, variant_id, quantity, unit_price, unit_cost,
                               discount, total_price, product_name_snapshot${marcaCols})
       SELECT src.id, $1::uuid, src.product_id, src.variant_id, src.quantity, src.unit_price, src.unit_cost,
              src.discount, src.total_price, src.nome${marcaSrc}
         FROM src ORDER BY src.ord
       RETURNING *
     ),
     baixa_variacao AS (
       UPDATE product_variants v
          SET stock_qty = GREATEST(0, v.stock_qty - q.quantidade), updated_at = NOW()
         FROM (SELECT variant_id, product_id, stock_company_id, SUM(quantity) AS quantidade
                 FROM src WHERE product_id IS NOT NULL AND variant_id IS NOT NULL AND baixa
                GROUP BY variant_id, product_id, stock_company_id) q
        WHERE v.id = q.variant_id AND v.product_id = q.product_id
          AND v.product_id IN (SELECT p.id FROM products p WHERE p.id = q.product_id AND p.company_id = q.stock_company_id)
     ),
     baixa_produto AS (
       UPDATE products p
          SET stock_qty = GREATEST(0, p.stock_qty - q.quantidade), updated_at = NOW()
         FROM (SELECT product_id, stock_company_id, SUM(quantity) AS quantidade
                 FROM src WHERE product_id IS NOT NULL AND variant_id IS NULL AND baixa
                GROUP BY product_id, stock_company_id) q
        WHERE p.id = q.product_id AND p.company_id = q.stock_company_id
     ),
     movimentos AS (
       INSERT INTO stock_movements (product_id, company_id, type, quantity, reference_id, reference_type, notes)
       SELECT src.product_id, src.stock_company_id, 'out', src.quantity, $1::uuid, 'sale', 'Venda PDV'
         FROM src WHERE src.product_id IS NOT NULL AND src.baixa ORDER BY src.ord
       ON CONFLICT DO NOTHING
     )${vendedoraCte}${cupomCte}
     SELECT g.*, p.name AS product_name
       FROM itens_gravados g
       JOIN src ON src.id = g.id
       LEFT JOIN products p ON p.id = g.product_id
      ORDER BY src.ord`,
    params
  );
  return rows;
}

// ── gravarPagamentos ─────────────────────────────────────────
/**
 * sale_payments (uma linha por forma de pagamento, na ordem) e a receita da
 * venda no financeiro, num comando so. `receita` e null quando a venda nao
 * tem valor a vista. Os textos dos INSERT sao os de sempre.
 */
async function gravarPagamentos(client, { saleId, companyId, sessaoId, pagamentos, receita }) {
  const temPagamentos = pagamentos.length > 0;
  if (!temPagamentos && !receita) return;

  const insertPagamentos =
    `INSERT INTO sale_payments (sale_id,company_id,method,amount,sessao_id)
     SELECT $1::uuid, $2::uuid, t.method, t.amount, $3::uuid
       FROM unnest($4::text[], $5::numeric[]) WITH ORDINALITY AS t(method, amount, ord)
      ORDER BY t.ord
     ON CONFLICT DO NOTHING`;
  const paramsPagamentos = [
    saleId, companyId, sessaoId || null,
    pagamentos.map((p) => p.method), pagamentos.map((p) => p.amount),
  ];
  if (!receita) {
    await client.query(insertPagamentos, paramsPagamentos);
    return;
  }

  const base = temPagamentos ? paramsPagamentos.length : 0;
  const n = (k) => `$${base + k}`;
  const params = [
    ...(temPagamentos ? paramsPagamentos : []),
    companyId, receita.amount, receita.description, receita.createdBy, receita.idempotencyKey,
  ];
  let dueDateExpr = receita.spDateNow;
  if (receita.saleDate) {
    params.push(receita.saleDate);
    dueDateExpr = `${n(6)}::date`;
  }
  await client.query(
    `${temPagamentos ? `WITH pagamentos AS (
     ${insertPagamentos}
     )
     ` : ''}INSERT INTO transactions
       (company_id,type,status,amount,description,category,due_date,paid_at,created_by,idempotency_key)
     VALUES (${n(1)},'income','confirmed',${n(2)},${n(3)},'Vendas',${dueDateExpr},NOW(),${n(4)},${n(5)})
     ON CONFLICT (idempotency_key) DO NOTHING`,
    params
  );
}

module.exports = {
  caminhoRapido,
  ehUuid,
  abrir,
  caixaFechado,
  lerProdutos,
  podeGravarDeUmaVez,
  gravarItens,
  gravarPagamentos,
  _resetarParaTeste,
};
