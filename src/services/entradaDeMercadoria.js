// ============================================================
// AURA. — Entrada de mercadoria (03/11/2026)
//
// Contas puras (sem banco) e, desde 17/11/2026 (B1), o miolo da entrada de
// um produto, tirado de POST /products/:pid/stock-entries
// (src/routes/productSuppliers.js) sem mudar nada: mesmas idas ao banco, na
// mesma ordem, com o mesmo SQL (travado pelo snapshot em
// __tests__/entradaDeMercadoria.banco.test.js). A entrada de vários itens
// (stock_receipts) usa as mesmas contas.
//
// Quem chama abre a transação, trava o produto (produtoVisivel com travar) e
// as variantes (travarVariantes), confere a grade (conferirGrade), acha o
// fornecedor (achaOuCriaFornecedor) e só então chama darEntradaNoProduto.
// ============================================================
'use strict';

const { companyGroupWhere, productVisibilityWhere } = require('../utils/companyGroup');
const { onlyDigits, isValidCnpj } = require('../utils/cnpj');

const round = (n, casas) => {
  const f = 10 ** casas;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};

function numeroPositivo(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Custo médio ponderado depois de uma entrada.
 *
 * - O estoque NEGATIVO de antes não entra na média (vendeu sem ter; o custo
 *   daquelas peças nunca existiu): base = max(estoque, 0).
 * - Sem custo na entrada (quem não vê custo, ou não informou): a média não
 *   muda.
 * - Sem custo anterior, ou nada em estoque: a média é o custo da entrada.
 */
function custoMedioPonderado({ estoqueAntes, custoAtual, quantidade, custoUnitario }) {
  const q = numeroPositivo(quantidade);
  const c = numeroPositivo(custoUnitario);
  const atual = numeroPositivo(custoAtual);
  if (!q || !c) return atual === null ? null : round(atual, 4);
  const base = Math.max(Number(estoqueAntes) || 0, 0);
  if (atual === null || base === 0) return round(c, 4);
  return round((base * atual + q * c) / (base + q), 4);
}

/**
 * Normaliza o corpo do POST de entrada. Devolve { erro } ou
 * { itens: [{ variant_id|null, quantidade }], total, custoUnitario, ... }.
 */
function lerEntrada(body) {
  const b = body || {};
  let itens;
  if (Array.isArray(b.items) && b.items.length) {
    itens = [];
    for (const it of b.items) {
      const q = numeroPositivo(it && it.quantity);
      if (!q) continue;
      if (!it.variant_id) return { erro: 'Cada item da grade precisa da variante' };
      itens.push({ variant_id: String(it.variant_id), quantidade: q });
    }
    if (!itens.length) return { erro: 'Informe a quantidade que chegou' };
    const ids = itens.map((i) => i.variant_id);
    if (new Set(ids).size !== ids.length) return { erro: 'Variante repetida na entrada' };
  } else {
    const q = numeroPositivo(b.quantity);
    if (!q) return { erro: 'Informe a quantidade que chegou' };
    itens = [{ variant_id: null, quantidade: q }];
  }
  const total = round(itens.reduce((s, i) => s + i.quantidade, 0), 3);
  const nota = b.invoice_number ? String(b.invoice_number).trim().slice(0, 40) : null;
  return {
    itens,
    total,
    custoUnitario: numeroPositivo(b.unit_cost),
    nota: nota || null,
    atualizarCusto: b.update_cost !== false,
  };
}

/**
 * Normaliza a lista do PUT de fornecedores do produto. `cost` AUSENTE
 * (chave nem veio) = manter o custo gravado — quem não vê custo tem a chave
 * tirada do corpo pelo middleware e não pode apagar o custo dos outros.
 * Exatamente um principal: o marcado; se nenhum, o principal anterior se
 * continuar na lista; senão, o primeiro.
 */
function lerListaDeFornecedores(body, principalAnterior) {
  const lista = Array.isArray(body && body.suppliers) ? body.suppliers : null;
  if (!lista) return { erro: 'suppliers é obrigatório (pode ser lista vazia)' };
  const vistos = new Set();
  const itens = [];
  for (const it of lista) {
    if (!it || !it.supplier_id) return { erro: 'Cada linha precisa do fornecedor' };
    const id = String(it.supplier_id);
    if (vistos.has(id)) continue;
    vistos.add(id);
    const temCusto = Object.prototype.hasOwnProperty.call(it, 'cost');
    itens.push({
      supplier_id: id,
      temCusto,
      custo: temCusto ? numeroPositivo(it.cost) : null,
      codigo: it.supplier_code ? String(it.supplier_code).trim().slice(0, 60) || null : null,
      principal: it.is_main === true,
    });
  }
  if (itens.length > 30) return { erro: 'No máximo 30 fornecedores por produto' };
  if (itens.length) {
    let idx = itens.findIndex((i) => i.principal);
    if (idx < 0 && principalAnterior) idx = itens.findIndex((i) => i.supplier_id === String(principalAnterior));
    if (idx < 0) idx = 0;
    itens.forEach((i, k) => { i.principal = k === idx; });
  }
  return { itens };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

function falhaDeSchema(err) {
  return err && (err.code === '42P01' || err.code === '42703');
}

// ─── Miolo da entrada de um produto (banco) ──────────────────

async function produtoVisivel(conn, pid, cid, travar = false) {
  const { rows } = await conn.query(
    `SELECT id, company_id, name, stock_qty, cost_price, weighted_avg_cost, supplier_id
       FROM products
      WHERE id = $1 AND ${productVisibilityWhere('$2')}
      ${travar ? 'FOR UPDATE' : ''}`,
    [pid, cid]
  );
  return rows[0] || null;
}

async function travarVariantes(conn, pid) {
  const { rows } = await conn.query(
    `SELECT id, stock_qty FROM product_variants WHERE product_id = $1 AND is_active = true FOR UPDATE`,
    [pid]
  );
  return rows;
}

// Grade da entrada x grade do produto. Devolve a mensagem de erro ou null.
function conferirGrade(entrada, variantes) {
  const temGrade = variantes.length > 0;
  const porGrade = entrada.itens.some((i) => i.variant_id);
  if (temGrade && !porGrade) return 'Esse produto tem cor/tamanho: informe quantas chegaram de cada';
  if (!temGrade && porGrade) return 'Esse produto não tem variantes';
  const daGrade = new Set(variantes.map((v) => v.id));
  if (porGrade && entrada.itens.some((i) => !daGrade.has(i.variant_id))) return 'Variante não é deste produto';
  return null;
}

// Fornecedor existente (visível no grupo) ou novo, cadastrado na hora
// (tela 3 do mockup). Dedupe: CNPJ, senão nome sem caixa.
async function achaOuCriaFornecedor(conn, cid, body) {
  if (body.supplier_id) {
    const { rows } = await conn.query(
      `SELECT id, name, cnpj, phone FROM suppliers WHERE id = $1 AND ${companyGroupWhere('$2')}`,
      [String(body.supplier_id), cid]
    );
    return rows[0] ? { fornecedor: rows[0] } : { erro: 'Fornecedor não encontrado', status: 404 };
  }
  const novo = body.new_supplier;
  if (!novo) return { fornecedor: null };
  const nome = novo.name ? String(novo.name).trim().slice(0, 200) : '';
  if (!nome) return { erro: 'Informe o nome do fornecedor', status: 400 };
  const cnpj = novo.cnpj ? onlyDigits(String(novo.cnpj)) : '';
  if (cnpj && !isValidCnpj(cnpj)) return { erro: 'CNPJ inválido', status: 400 };
  const telefone = novo.phone ? String(novo.phone).trim().slice(0, 30) || null : null;
  const { rows: achados } = await conn.query(
    `SELECT id, name, cnpj, phone FROM suppliers
      WHERE ${companyGroupWhere('$1')}
        AND (($2::text <> '' AND cnpj = $2) OR ($2::text = '' AND lower(trim(name)) = lower($3)))
      ORDER BY (company_id = $1) DESC
      LIMIT 1`,
    [cid, cnpj, nome]
  );
  if (achados[0]) return { fornecedor: achados[0] };
  const { rows } = await conn.query(
    `INSERT INTO suppliers (company_id, name, cnpj, phone) VALUES ($1, $2, $3, $4)
     RETURNING id, name, cnpj, phone`,
    [cid, nome, cnpj || null, telefone]
  );
  return { fornecedor: rows[0], criado: true };
}

// products.supplier_id espelha o principal (migration 424, decisão b).
async function espelharPrincipal(conn, pid) {
  await conn.query(
    `UPDATE products p
        SET supplier_id = s.id, supplier_name = s.name, supplier_cnpj = s.cnpj, updated_at = NOW()
       FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
      WHERE p.id = $1 AND ps.product_id = p.id AND ps.is_main
        AND p.supplier_id IS DISTINCT FROM s.id`,
    [pid]
  );
  await conn.query(
    `UPDATE products SET supplier_id = NULL, supplier_name = NULL, supplier_cnpj = NULL, updated_at = NOW()
      WHERE id = $1 AND supplier_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM product_suppliers WHERE product_id = $1 AND is_main)`,
    [pid]
  );
}

/**
 * Estoque e custo antes e depois da entrada, sem banco. `produto` e
 * `variantes` como travados (stock_qty, cost_price, weighted_avg_cost).
 * Custo de antes: o médio; sem médio, o cost_price quando > 0.
 */
function calcularEntrada({ produto, variantes, entrada }) {
  const temGrade = variantes.length > 0;
  const estoqueAntes = temGrade
    ? variantes.reduce((s, v) => s + (Number(v.stock_qty) || 0), 0)
    : Number(produto.stock_qty) || 0;
  const custoAntes = num(produto.weighted_avg_cost) !== null ? num(produto.weighted_avg_cost)
    : (num(produto.cost_price) > 0 ? num(produto.cost_price) : null);
  const custoDepois = custoMedioPonderado({
    estoqueAntes, custoAtual: custoAntes, quantidade: entrada.total, custoUnitario: entrada.custoUnitario,
  });
  return { temGrade, estoqueAntes, custoAntes, custoDepois };
}

/**
 * Grava a entrada de UM produto já travado, dentro da transação de quem
 * chama: estoque (produto ou variantes), custo médio, última compra, custo
 * do fornecedor (o primeiro vira principal) e os movimentos.
 *
 * @param client     conexão com a transação aberta
 * @param cid        loja que recebeu (vai no movimento)
 * @param produto    linha de produtoVisivel(..., travar = true)
 * @param variantes  linhas de travarVariantes (vazio = sem grade)
 * @param entrada    resultado de lerEntrada (sem erro), grade já conferida
 * @param fornecedor { id, name, cnpj, phone } ou null
 * @returns { estoqueAntes, custoAntes, custoDepois }
 */
async function darEntradaNoProduto(client, { cid, produto, variantes, entrada, fornecedor }) {
  const pid = produto.id;
  const { temGrade, estoqueAntes, custoAntes, custoDepois } = calcularEntrada({ produto, variantes, entrada });

  // 1. estoque
  if (temGrade) {
    for (const it of entrada.itens) {
      await client.query(
        `UPDATE product_variants SET stock_qty = stock_qty + $1, updated_at = NOW() WHERE id = $2 AND product_id = $3`,
        [it.quantidade, it.variant_id, pid]
      );
    }
  } else {
    await client.query(`UPDATE products SET stock_qty = stock_qty + $1, updated_at = NOW() WHERE id = $2`, [entrada.total, pid]);
  }

  // 2. custo médio (só quando a entrada trouxe custo)
  if (entrada.custoUnitario) {
    await client.query(
      `UPDATE products
          SET weighted_avg_cost = $2,
              cost_price = CASE WHEN $3::boolean THEN ROUND($2::numeric, 2) ELSE cost_price END,
              updated_at = NOW()
        WHERE id = $1`,
      [pid, custoDepois, entrada.atualizarCusto]
    );
  }

  // 3. última compra (colunas da 354; base sem elas segue sem)
  if (fornecedor) {
    await client.query('SAVEPOINT ultima_compra');
    try {
      await client.query(
        `UPDATE products
            SET last_supplier_name = $2, last_supplier_cnpj = $3, last_supplier_phone = $4,
                last_purchase_unit_cost = COALESCE($5::numeric, last_purchase_unit_cost),
                last_purchase_at = NOW()
          WHERE id = $1`,
        [pid, fornecedor.name, fornecedor.cnpj || null, fornecedor.phone || null, entrada.custoUnitario]
      );
      await client.query('RELEASE SAVEPOINT ultima_compra');
    } catch (e) {
      if (!falhaDeSchema(e)) throw e;
      await client.query('ROLLBACK TO SAVEPOINT ultima_compra');
    }

    // 4. custo daquele fornecedor; o primeiro fornecedor vira o principal
    await client.query(
      `INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, is_main, last_purchase_at)
       VALUES ($1, $2, $3, $4,
               NOT EXISTS (SELECT 1 FROM product_suppliers WHERE product_id = $2 AND is_main), NOW())
       ON CONFLICT (product_id, supplier_id) DO UPDATE
         SET cost = COALESCE(EXCLUDED.cost, product_suppliers.cost),
             last_purchase_at = NOW(), updated_at = NOW()`,
      [produto.company_id, pid, fornecedor.id, entrada.custoUnitario]
    );
    await espelharPrincipal(client, pid);
  }

  // 5. movimentos
  for (const it of entrada.itens) {
    await client.query(
      `INSERT INTO stock_movements
         (product_id, company_id, type, quantity, reference_type, notes, supplier_id, unit_cost, variant_id)
       VALUES ($1, $2, 'in', $3, 'entrada', $4, $5, $6, $7)`,
      [pid, cid, it.quantidade, entrada.nota ? `NF ${entrada.nota}` : null,
        fornecedor ? fornecedor.id : null, entrada.custoUnitario, it.variant_id]
    );
  }

  return { estoqueAntes, custoAntes, custoDepois };
}

module.exports = {
  custoMedioPonderado, lerEntrada, lerListaDeFornecedores, numeroPositivo, round,
  falhaDeSchema, produtoVisivel, travarVariantes, conferirGrade, achaOuCriaFornecedor,
  espelharPrincipal, calcularEntrada, darEntradaNoProduto,
};
