// ============================================================
// AURA. — Matcon M4: compras (sugestao de compra e pedido ao fornecedor)
//
// 23/09/2026. Montado em private.js sob /matcon. Schema: migration 354.
// Contrato: aura-app/docs/CONTRACT_MATCON.md secao "M4 › Compras"; o
// client que consome e aura-app/services/matconApi.ts (purchaseSuggestions,
// listPurchaseOrders, createPurchaseOrder, updatePurchaseOrder) e a tela e
// app/(tabs)/matcon/compras.tsx.
//
// GET   /matcon/purchase-suggestions      → {suggestions, summary}
// GET   /matcon/purchase-orders?status=   → {orders, summary}
// POST  /matcon/purchase-orders           → 201 {order}   (status draft)
// PATCH /matcon/purchase-orders/:oid      → {order}
// POST  /matcon/purchase-receipts         → {products_updated, ignored, orders}
//
// GATE: pdv_settings.matcon_enabled, so na ESCRITA (403 MATCON_DISABLED).
// Mesmo desenho do assertOticaEnabled (otica.js): le do BANCO (o JWT nunca
// revalida plano/modulo) e deixa a leitura aberta — desligar o toggle com
// um pedido a caminho nao pode esconder da loja o que ela ainda vai
// receber. Definido aqui dentro de proposito: M1/M3 estao sendo feitos em
// paralelo e ainda nao ha servico compartilhado de gate do Matcon.
//
// MULTI-CNPJ: compra e de UMA loja (estoque e pedido sao da empresa da
// rota). Produto compartilhado no grupo (is_group_shared) entra na
// sugestao com a mesma visibilidade da lista do Estoque (products.js,
// listVisibilityWhere), para a tela Compras nunca dizer "nada faltando"
// enquanto o Estoque mostra alerta.
//
// REGRA DA LISTA (23/09/2026, decisao do Caio: a regra e a do Estoque):
// todo produto com estoque <= minimo entra na sugestao — EXATAMENTE o
// alerta de estoque baixo do Estoque, inclusive minimo 0 com estoque
// zerado. Antes a conta de reposicao dava 0 nesses casos e o produto
// sumia: o Estoque mostrava "23 alertas" e Compras "1 item". Quando a
// conta nao pede nada, a sugestao e o minimo que faz sentido (ver
// montarSugestao) e `reason` diz por que o item esta ali.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const {
  round2, round3, round4, texto, numOuNull, cnpjDigitos,
  normalizarItens, totalDosItens, tudoRecebido, serializarPedido,
  gravarUltimaCompra, casarNotaComPedidos,
} = require('../services/matconPurchases');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['draft', 'sent', 'received', 'cancelled'];
const MAX_ITENS = 200;

// ─── Gate do modulo ──────────────────────────────────────────
function erroMatconDesligado() {
  const err = new Error('Materiais de construção não está ligado. Ative em Configurações › Caixa.');
  err.status = 403;
  err.code = 'MATCON_DISABLED';
  return err;
}

async function assertMatconEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'matcon_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) {
    const err = new Error('Empresa não encontrada');
    err.status = 404;
    throw err;
  }
  if (rows[0].enabled !== 'true') throw erroMatconDesligado();
}

function erro(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function falhar(res, err, contexto) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(`[matconPurchases:${contexto}]`, err && err.message);
  return res.status(500).json({ error: 'Erro ao processar compras' });
}

// Mesma visibilidade de products.js (listVisibilityWhere), com alias:
// produto da empresa OU compartilhado por outra empresa do mesmo grupo.
// Copiada (e nao importada) porque products.js nao exporta o helper.
function produtoVisivel(cidParam, alias = 'p') {
  return `(${alias}.company_id = ${cidParam} OR (
    ${alias}.is_group_shared = true
    AND ${alias}.company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

// ─── Regra da sugestao ───────────────────────────────────────
//
// Unidades de medida (vendidas fracionadas) — espelho de
// aura-app/utils/matconUnits.ts (FRACTIONAL_UNITS + milheiro, com os
// apelidos m2/m3/lt). Sem purchase_factor, a sugestao dessas unidades fica
// em decimal (3 casas); as demais (un, sc, pç, cx...) sobem para o inteiro
// seguinte — ninguem pede "4,98 sacos" ao fornecedor.
const UNIT_ALIASES = { m2: 'm²', m3: 'm³', lt: 'l', litro: 'l' };
const UNIDADES_DECIMAIS = new Set(['m', 'm²', 'm³', 'kg', 'g', 'l', 'ml', 'ton', 'mlh']);

function unidadeDecimal(unit) {
  const norm = String(unit || '').trim().toLowerCase();
  return UNIDADES_DECIMAIS.has(UNIT_ALIASES[norm] || norm);
}

const SEMANAS_EM_30_DIAS = 4.3;
const DIAS_ALERTA = 14;
const EPS = 1e-9;

/** Arredonda para cima em passos de `passo` (evita 3 × 2,32 virar 7,0000001). */
function arredondarParaCima(valor, passo) {
  return Math.ceil(valor / passo - EPS) * passo;
}

/**
 * Uma linha de produto (+ vendido nos 30 dias) -> sugestao, ou null quando
 * o produto nao precisa de compra. Exportada para teste.
 *
 * - estoque = soma das variantes quando o produto tem variantes (mesma
 *   conta de useProducts.ts no front), senao stock_qty.
 * - "abaixo do minimo" = estoque <= minimo: EXATAMENTE a regra do alerta
 *   de estoque baixo do Estoque (estoque.tsx / AlertsList.tsx).
 * - weekly_sales = vendido nos ultimos 30 dias ÷ 4,3.
 * - suggested_qty = max(minimo × 1,5, weekly_sales × 3) − estoque,
 *   arredondada para cima na unidade de compra (caixa de 2,32 m² ->
 *   multiplo de 2,32) quando ha purchase_factor.
 * - Entra na lista: abaixo do minimo (SEMPRE — regra do Estoque, decisao
 *   de 23/09) OU suggested_qty > 0 e acaba em ate 14 dias no ritmo de
 *   venda.
 * - Abaixo do minimo e a conta acima deu <= 0 (minimo 0 com estoque
 *   zerado, por exemplo): suggested_qty = max(minimo − estoque,
 *   weekly_sales × 3, 1 unidade de compra) — 1 caixa com purchase_factor,
 *   senao 1 na unidade de venda — com o mesmo arredondamento.
 * - reason: "zerado_sem_minimo" (minimo <= 0 e estoque <= 0),
 *   "abaixo_do_minimo" (demais casos de estoque <= minimo) ou
 *   "vai_acabar" (acima do minimo, acaba em ate 14 dias).
 */
function montarSugestao(r) {
  const temVariantes = r.has_variants === true;
  const estoque = round3(temVariantes ? r.variants_stock_total : r.stock_qty);
  const minimo = round3(r.stock_min);
  const vendido30 = Number(r.sold_30d) || 0;
  const semanal = vendido30 / SEMANAS_EM_30_DIAS;

  const abaixoDoMinimo = estoque <= minimo;
  const fator = numOuNull(r.purchase_factor);
  const temFator = !!(fator && fator > 0);
  const naUnidadeDeCompra = (qtd) => {
    let q;
    if (temFator) q = arredondarParaCima(qtd, fator);
    else if (unidadeDecimal(r.unit)) q = arredondarParaCima(qtd, 0.001);
    else q = Math.ceil(qtd - EPS);
    return round3(q);
  };

  const alvo = Math.max(minimo * 1.5, semanal * 3);
  const falta = alvo - estoque;
  let sugerido = falta > EPS ? naUnidadeDeCompra(falta) : 0;
  if (sugerido <= 0) {
    if (!abaixoDoMinimo) return null;
    // Regra do Estoque: estoque <= minimo entra sempre. A conta de
    // reposicao nao pediu nada (minimo 0 e estoque zerado, tipicamente):
    // o minimo que faz sentido e 1 unidade de compra.
    const umaUnidade = temFator ? fator : 1;
    sugerido = naUnidadeDeCompra(Math.max(minimo - estoque, semanal * 3, umaUnidade));
  }

  const porDia = semanal / 7;
  const diasParaAcabar = porDia > 0 ? Math.floor(Math.max(0, estoque) / porDia) : null;

  if (!abaixoDoMinimo && !(diasParaAcabar !== null && diasParaAcabar <= DIAS_ALERTA)) return null;

  let reason = 'vai_acabar';
  if (abaixoDoMinimo) reason = minimo <= 0 && estoque <= 0 ? 'zerado_sem_minimo' : 'abaixo_do_minimo';

  // Custo na unidade de venda: ultima nota ÷ fator; sem nota, o custo do
  // cadastro. Sem nenhum dos dois, 0 (a tela mostra ~R$ 0, nao some).
  const ultimaNota = numOuNull(r.last_purchase_unit_cost);
  const custoUnit = ultimaNota && ultimaNota > 0
    ? ultimaNota / (temFator ? fator : 1)
    : (Number(r.cost_price) || 0);

  // Fornecedor: o da ultima nota; senao o cadastrado no produto
  // (suppliers, migration 342); senao as colunas soltas antigas.
  let fornecedor;
  if (r.last_supplier_name || r.last_supplier_cnpj) {
    fornecedor = {
      supplier_name: r.last_supplier_name || null,
      supplier_cnpj: r.last_supplier_cnpj || null,
      supplier_phone: r.last_supplier_phone || r.last_supplier_registry_phone || null,
    };
  } else if (r.registry_supplier_name || r.registry_supplier_cnpj) {
    fornecedor = {
      supplier_name: r.registry_supplier_name || null,
      supplier_cnpj: cnpjDigitos(r.registry_supplier_cnpj),
      supplier_phone: r.registry_supplier_phone || null,
    };
  } else {
    fornecedor = {
      supplier_name: texto(r.supplier_name, 200),
      supplier_cnpj: cnpjDigitos(r.supplier_cnpj),
      supplier_phone: null,
    };
  }

  return {
    product_id: r.id,
    name: r.name || '',
    unit: r.unit || null,
    stock: estoque,
    min_stock: minimo,
    weekly_sales: round2(semanal),
    suggested_qty: sugerido,
    est_cost: round2(sugerido * custoUnit),
    ...fornecedor,
    days_to_stockout: diasParaAcabar,
    reason,
    _abaixo_do_minimo: abaixoDoMinimo,
  };
}

// ─── GET /purchase-suggestions ───────────────────────────────
router.get('/purchase-suggestions', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `WITH visiveis AS (
         SELECT p.id, p.name, p.unit, p.stock_qty, p.stock_min, p.cost_price,
                p.purchase_factor, p.last_supplier_name, p.last_supplier_cnpj,
                p.last_supplier_phone, p.last_purchase_unit_cost,
                p.supplier_id, p.supplier_name, p.supplier_cnpj,
                EXISTS (SELECT 1 FROM product_variants pv
                         WHERE pv.product_id = p.id AND pv.is_active = true) AS has_variants,
                COALESCE((SELECT SUM(pv.stock_qty) FROM product_variants pv
                           WHERE pv.product_id = p.id AND pv.is_active = true), 0) AS variants_stock_total
           FROM products p
          WHERE p.is_active = true
            AND COALESCE(p.unit, 'un') <> 'srv'
            AND ${produtoVisivel('$1')}
       ),
       vendas AS (
         -- Por produto, sem filtrar a empresa da venda: o estoque de um
         -- produto compartilhado no grupo e UM so, e a venda de qualquer
         -- loja do grupo baixa o mesmo saldo.
         SELECT si.product_id, SUM(si.quantity) AS qty
           FROM sale_items si
           JOIN sales s ON s.id = si.sale_id
          WHERE si.product_id IN (SELECT id FROM visiveis)
            AND s.created_at >= NOW() - INTERVAL '30 days'
            AND COALESCE(s.status, 'completed') <> 'cancelled'
          GROUP BY si.product_id
       )
       SELECT v.*,
              COALESCE(vd.qty, 0) AS sold_30d,
              sup.name  AS registry_supplier_name,
              sup.cnpj  AS registry_supplier_cnpj,
              sup.phone AS registry_supplier_phone,
              (SELECT s2.phone FROM suppliers s2
                WHERE v.last_supplier_cnpj IS NOT NULL
                  AND s2.cnpj = v.last_supplier_cnpj
                  AND s2.phone IS NOT NULL
                  AND s2.company_id IN (
                    SELECT id FROM companies
                    WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
                      SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
                      FROM companies WHERE id = $1
                    )
                  )
                LIMIT 1) AS last_supplier_registry_phone
         FROM visiveis v
         LEFT JOIN vendas vd ON vd.product_id = v.id
         LEFT JOIN suppliers sup ON sup.id = v.supplier_id`,
      [cid]
    );

    const sugestoes = rows.map(montarSugestao).filter(Boolean);
    // Mais urgente primeiro: acaba antes; sem prazo (nao vende) no fim.
    sugestoes.sort((a, b) => {
      const da = a.days_to_stockout === null ? Infinity : a.days_to_stockout;
      const dbb = b.days_to_stockout === null ? Infinity : b.days_to_stockout;
      if (da !== dbb) return da - dbb;
      return String(a.name).localeCompare(String(b.name), 'pt-BR');
    });

    const fornecedores = new Set();
    let total = 0;
    let abaixo = 0;
    for (const s of sugestoes) {
      total += s.est_cost;
      if (s._abaixo_do_minimo) abaixo += 1;
      // Mesma chave de agrupamento do front (comprasUtil.agruparPorFornecedor).
      fornecedores.add(s.supplier_cnpj || s.supplier_name || 'sem-fornecedor');
      delete s._abaixo_do_minimo;
    }

    res.json({
      suggestions: sugestoes,
      summary: {
        total_est_cost: round2(total),
        items_below_min: abaixo,
        suppliers: fornecedores.size,
      },
    });
  } catch (err) {
    return falhar(res, err, 'suggestions');
  }
});

// ─── GET /purchase-orders?status= ────────────────────────────
const COLS_PEDIDO = `id, seq, status, supplier_name, supplier_cnpj, supplier_phone,
  items, total_est, sent_at, received_at, received_invoice, created_at`;

router.get('/purchase-orders', async (req, res) => {
  const cid = req.params.id;
  const status = req.query.status ? String(req.query.status) : 'all';
  if (status !== 'all' && !STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Status inválido. Use draft, sent, received, cancelled ou all.' });
  }
  try {
    const params = [cid];
    let where = 'WHERE company_id = $1';
    if (status !== 'all') { params.push(status); where += ' AND status = $2'; }

    const [lista, resumo] = await Promise.all([
      db.query(
        `SELECT ${COLS_PEDIDO} FROM matcon_purchase_orders ${where}
          ORDER BY created_at DESC LIMIT 200`,
        params
      ),
      db.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'draft')::int                AS draft_count,
                COALESCE(SUM(total_est) FILTER (WHERE status = 'draft'), 0)  AS draft_total,
                COUNT(*) FILTER (WHERE status = 'sent')::int                 AS sent_count,
                COALESCE(SUM(total_est) FILTER (WHERE status = 'sent'), 0)   AS sent_total,
                COUNT(*) FILTER (WHERE status = 'received'
                                   AND received_at >= NOW() - INTERVAL '7 days')::int AS rec_count,
                COALESCE(SUM(total_est) FILTER (WHERE status = 'received'
                                   AND received_at >= NOW() - INTERVAL '7 days'), 0) AS rec_total
           FROM matcon_purchase_orders
          WHERE company_id = $1`,
        [cid]
      ),
    ]);

    const r = resumo.rows[0] || {};
    res.json({
      orders: lista.rows.map(serializarPedido),
      summary: {
        draft: { count: r.draft_count || 0, total: round2(r.draft_total) },
        sent: { count: r.sent_count || 0, total: round2(r.sent_total) },
        received_7d: { count: r.rec_count || 0, total: round2(r.rec_total) },
      },
    });
  } catch (err) {
    // Base sem a migration 354 ainda: lista vazia em vez de 500.
    if (err && err.code === '42P01') {
      return res.json({
        orders: [],
        summary: { draft: { count: 0, total: 0 }, sent: { count: 0, total: 0 }, received_7d: { count: 0, total: 0 } },
      });
    }
    return falhar(res, err, 'list');
  }
});

// ─── Itens do corpo ──────────────────────────────────────────
//
// [{product_id, quantity}] -> Map product_id -> quantidade (soma
// repetidos). `aceitaZero`: no PATCH, quantidade 0 tira o item.
function lerItensDoCorpo(items, { aceitaZero }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw erro(400, 'O pedido precisa de pelo menos um item.');
  }
  if (items.length > MAX_ITENS) {
    throw erro(400, `O pedido aceita até ${MAX_ITENS} itens.`);
  }
  const qtds = new Map();
  for (const it of items) {
    const pid = it && it.product_id ? String(it.product_id) : '';
    if (!UUID_RE.test(pid)) throw erro(400, 'Item sem produto válido.');
    const q = numOuNull(it.quantity);
    if (q === null || q < 0 || (!aceitaZero && q === 0)) {
      throw erro(400, 'Quantidade inválida: use um número maior que zero.');
    }
    qtds.set(pid, round3((qtds.get(pid) || 0) + q));
  }
  return qtds;
}

/** Retrato dos produtos para o pedido (nome, unidade, custo estimado). */
async function carregarProdutos(client, cid, ids) {
  if (!ids.length) return new Map();
  const { rows } = await client.query(
    `SELECT p.id, p.name, p.unit, p.cost_price, p.purchase_factor, p.last_purchase_unit_cost
       FROM products p
      WHERE p.id = ANY($2::uuid[]) AND ${produtoVisivel('$1')}`,
    [cid, ids]
  );
  const mapa = new Map();
  for (const p of rows) {
    const fator = numOuNull(p.purchase_factor);
    const ultimaNota = numOuNull(p.last_purchase_unit_cost);
    const custo = ultimaNota && ultimaNota > 0
      ? ultimaNota / (fator && fator > 0 ? fator : 1)
      : (Number(p.cost_price) || 0);
    mapa.set(String(p.id), { name: p.name || '', unit: p.unit || null, unit_cost_est: round4(custo) });
  }
  const faltando = ids.filter((id) => !mapa.has(id));
  if (faltando.length) throw erro(404, 'Produto não encontrado nesta loja.');
  return mapa;
}

// ─── POST /purchase-orders ───────────────────────────────────
router.post('/purchase-orders', async (req, res) => {
  const cid = req.params.id;
  const body = req.body || {};
  let client;
  try {
    await assertMatconEnabled(cid);
    const qtds = lerItensDoCorpo(body.items, { aceitaZero: false });

    client = await db.connect();
    await client.query('BEGIN');

    const produtos = await carregarProdutos(client, cid, Array.from(qtds.keys()));
    const itens = Array.from(qtds.entries()).map(([pid, q]) => ({
      product_id: pid,
      name: produtos.get(pid).name,
      unit: produtos.get(pid).unit,
      quantity: q,
      unit_cost_est: produtos.get(pid).unit_cost_est,
      received_qty: 0,
    }));

    // Numero sequencial por empresa (migration 354, decisao c).
    const { rows: cont } = await client.query(
      `INSERT INTO matcon_purchase_order_counters AS c (company_id, last_number)
            VALUES ($1, 1)
       ON CONFLICT (company_id) DO UPDATE
            SET last_number = c.last_number + 1, updated_at = NOW()
       RETURNING c.last_number`,
      [cid]
    );
    const seq = cont[0].last_number;

    const { rows } = await client.query(
      `INSERT INTO matcon_purchase_orders
         (company_id, seq, status, supplier_name, supplier_cnpj, supplier_phone,
          items, total_est, created_by)
       VALUES ($1, $2, 'draft', $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING ${COLS_PEDIDO}`,
      [
        cid, seq,
        texto(body.supplier_name, 200),
        cnpjDigitos(body.supplier_cnpj),
        texto(body.supplier_phone, 30),
        JSON.stringify(itens),
        totalDosItens(itens),
        req.user && UUID_RE.test(String(req.user.id || '')) ? req.user.id : null,
      ]
    );
    await client.query('COMMIT');
    res.status(201).json({ order: serializarPedido(rows[0]) });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignora */ } }
    return falhar(res, err, 'create');
  } finally {
    if (client) client.release();
  }
});

// ─── PATCH /purchase-orders/:oid ─────────────────────────────
//
// Maquina de status:
//   draft → sent | cancelled
//   sent  → sent (reenvio no WhatsApp) | received | cancelled
//   received / cancelled → nada (pedido fechado)
// Itens so mudam em draft ou sent. Em sent, o que ja chegou de cada
// produto (received_qty) e mantido.
const TRANSICOES = {
  draft: ['draft', 'sent', 'cancelled'],
  sent: ['sent', 'received', 'cancelled'],
  received: [],
  cancelled: [],
};

const NOME_STATUS = { draft: 'rascunho', sent: 'enviado', received: 'recebido', cancelled: 'cancelado' };

router.patch('/purchase-orders/:oid', async (req, res) => {
  const cid = req.params.id;
  const oid = String(req.params.oid || '');
  const body = req.body || {};
  let client;
  try {
    await assertMatconEnabled(cid);
    if (!UUID_RE.test(oid)) throw erro(404, 'Pedido não encontrado.');

    const novoStatus = body.status === undefined ? undefined : String(body.status);
    if (novoStatus !== undefined && !STATUSES.includes(novoStatus)) {
      throw erro(400, 'Status inválido. Use draft, sent, received ou cancelled.');
    }
    const qtds = body.items === undefined ? null : lerItensDoCorpo(body.items, { aceitaZero: true });
    if (novoStatus === undefined && !qtds) throw erro(400, 'Nada para mudar no pedido.');

    client = await db.connect();
    await client.query('BEGIN');

    const { rows: atual } = await client.query(
      `SELECT ${COLS_PEDIDO} FROM matcon_purchase_orders
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [oid, cid]
    );
    if (!atual.length) throw erro(404, 'Pedido não encontrado.');
    const pedido = atual[0];

    if (TRANSICOES[pedido.status].length === 0) {
      throw erro(409, `Este pedido já está ${NOME_STATUS[pedido.status]} e não muda mais.`, 'PEDIDO_FECHADO');
    }
    if (novoStatus !== undefined && !TRANSICOES[pedido.status].includes(novoStatus)) {
      throw erro(409, `Um pedido ${NOME_STATUS[pedido.status]} não pode voltar para ${NOME_STATUS[novoStatus]}.`, 'TRANSICAO_INVALIDA');
    }

    let itens = normalizarItens(pedido.items);

    if (qtds) {
      const porProduto = new Map(itens.map((it) => [it.product_id, it]));
      const novos = Array.from(qtds.keys()).filter((pid) => !porProduto.has(pid) && qtds.get(pid) > 0);
      const produtos = await carregarProdutos(client, cid, novos);
      const lista = [];
      for (const [pid, q] of qtds.entries()) {
        if (q <= 0) continue; // quantidade 0 tira o item
        const existente = porProduto.get(pid);
        if (existente) lista.push({ ...existente, quantity: q });
        else lista.push({ product_id: pid, ...produtos.get(pid), quantity: q, received_qty: 0 });
      }
      if (!lista.length) throw erro(400, 'O pedido precisa de pelo menos um item.');
      itens = lista;
    }

    let status = novoStatus === undefined ? pedido.status : novoStatus;
    if (status === 'received') {
      // Recebido na mao: o que ainda nao tinha chegado conta como chegado.
      itens = itens.map((it) => ({ ...it, received_qty: Math.max(it.received_qty, it.quantity) }));
    } else if (status === 'sent' && qtds && tudoRecebido(itens)) {
      // Quantidade baixada ate o que ja chegou: nada mais a receber.
      status = 'received';
    }

    const { rows } = await client.query(
      `UPDATE matcon_purchase_orders
          SET items        = $3::jsonb,
              total_est    = $4,
              status       = $5::text,
              sent_at      = CASE WHEN $5::text IN ('sent', 'received') THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
              received_at  = CASE WHEN $5::text = 'received' THEN COALESCE(received_at, NOW()) ELSE received_at END,
              cancelled_at = CASE WHEN $5::text = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
              updated_at   = NOW()
        WHERE id = $1 AND company_id = $2
        RETURNING ${COLS_PEDIDO}`,
      [oid, cid, JSON.stringify(itens), totalDosItens(itens), status]
    );
    await client.query('COMMIT');
    res.json({ order: serializarPedido(rows[0]) });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignora */ } }
    return falhar(res, err, 'update');
  } finally {
    if (client) client.release();
  }
});

// ─── POST /purchase-receipts ─────────────────────────────────
//
// "A nota do fornecedor entrou." Chamado pela conferencia do XML
// (aura-app DanfeImportModal) DEPOIS de somar o estoque, porque o
// import-danfe-xml so faz o parse e quem sabe qual produto e qual item da
// nota e o front (LinkProductModal). Esta rota NAO mexe em estoque.
//
// Corpo: { supplier_name, supplier_cnpj, supplier_phone?, invoice_number?,
//          items: [{ product_id, quantity, unit_cost }] }
// quantity e unit_cost vao COMO ESTAO NA NOTA (unidade de compra: 10 cx a
// R$ 89,90). O backend converte para a unidade de venda com o
// purchase_factor do produto (10 cx × 2,32 = 23,2 m²) — a mesma conta de
// convertPurchaseToSale no front — para casar com o pedido, que e em
// unidade de venda. Produto sem fator: 1 para 1.
//
// Faz duas coisas: grava a ultima compra no produto (last_supplier_*,
// last_purchase_*) e casa a nota com os pedidos enviados ao mesmo CNPJ.
router.post('/purchase-receipts', async (req, res) => {
  const cid = req.params.id;
  const body = req.body || {};
  let client;
  try {
    await assertMatconEnabled(cid);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw erro(400, 'A nota precisa de pelo menos um item vinculado a um produto.');
    if (items.length > 500) throw erro(400, 'Nota grande demais: até 500 itens.');

    const validos = items.filter((it) => it && UUID_RE.test(String(it.product_id || '')));
    const ids = Array.from(new Set(validos.map((it) => String(it.product_id))));

    client = await db.connect();
    await client.query('BEGIN');

    const { rows: produtos } = ids.length
      ? await client.query(
        `SELECT p.id, p.purchase_factor FROM products p
          WHERE p.id = ANY($2::uuid[]) AND ${produtoVisivel('$1')}`,
        [cid, ids]
      )
      : { rows: [] };
    const fatores = new Map(produtos.map((p) => [String(p.id), numOuNull(p.purchase_factor)]));

    const chegou = [];
    const atualizados = new Set();
    for (const it of validos) {
      const pid = String(it.product_id);
      if (!fatores.has(pid)) continue;
      const fator = fatores.get(pid);
      const qtdNota = numOuNull(it.quantity);
      if (!atualizados.has(pid)) {
        await gravarUltimaCompra(client, pid, {
          supplierName: body.supplier_name,
          supplierCnpj: body.supplier_cnpj,
          supplierPhone: body.supplier_phone,
          unitCost: it.unit_cost,
        });
        atualizados.add(pid);
      }
      if (qtdNota !== null && qtdNota > 0) {
        chegou.push({ product_id: pid, quantity: round3(qtdNota * (fator && fator > 0 ? fator : 1)) });
      }
    }

    const pedidos = await casarNotaComPedidos(client, cid, {
      supplierCnpj: body.supplier_cnpj,
      invoiceNumber: body.invoice_number,
      items: chegou,
    });

    await client.query('COMMIT');
    res.json({
      products_updated: atualizados.size,
      ignored: items.length - validos.filter((it) => fatores.has(String(it.product_id))).length,
      orders: pedidos,
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignora */ } }
    return falhar(res, err, 'receipt');
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
module.exports._montarSugestao = montarSugestao;
