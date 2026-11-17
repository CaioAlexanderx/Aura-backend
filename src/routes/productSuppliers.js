// ============================================================
// AURA. — Fornecedores do produto e entrada de mercadoria (03/11/2026)
//
// Migration 424. Mockup aprovado: aura-app
// docs/mockups/estoque-entrada-por-fornecedor.html (telas 1-9).
//
//   GET  /products/:pid/suppliers      fornecedores do produto, cada um com o seu custo
//   PUT  /products/:pid/suppliers      troca a lista inteira (como PUT /variations)
//   POST /products/:pid/stock-entries  entrada: fornecedor + quantidade + custo
//   GET  /products/:pid/stock-entries  compras do produto (por fornecedor + últimas)
//
// Montado em /products ANTES de ./products (que tem /:pid curinga). As
// leituras e escritas passam pelo estoqueSoConsulta do mount: consulta leva
// 403 (rota nova nasce fechada para esse perfil) e quem não vê custo
// recebe tudo sem custo — e grava sem custo (a chave sai do corpo; aqui,
// `cost` ausente = manter o gravado).
//
// Visibilidade: produto pela regra única (productVisibilityWhere); fornecedor
// pelo grupo econômico (companyGroupWhere), igual a resolveSupplier.
// Nomes de campo de dinheiro na resposta (cost, unit_cost, avg_cost,
// cost_price) são os que o middleware já corta.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { companyGroupWhere } = require('../utils/companyGroup');
// O miolo da entrada (e os ajudantes que ela usa) mora no serviço desde o B1
// (17/11/2026), para a entrada de vários itens usar o mesmo caminho.
const {
  lerEntrada, lerListaDeFornecedores, round,
  falhaDeSchema, produtoVisivel, travarVariantes, conferirGrade, achaOuCriaFornecedor,
  espelharPrincipal, darEntradaNoProduto,
} = require('../services/entradaDeMercadoria');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function listar(conn, pid) {
  const { rows } = await conn.query(
    `SELECT ps.supplier_id, s.name, s.cnpj, s.phone, ps.cost, ps.supplier_code,
            ps.is_main, ps.last_purchase_at
       FROM product_suppliers ps
       JOIN suppliers s ON s.id = ps.supplier_id
      WHERE ps.product_id = $1
      ORDER BY ps.is_main DESC, lower(s.name)`,
    [pid]
  );
  return rows.map((r) => ({ ...r, cost: num(r.cost) }));
}

// ─── GET /:pid/suppliers ─────────────────────────────────────
router.get('/:pid/suppliers', async (req, res) => {
  const { id: cid, pid } = req.params;
  if (!UUID.test(pid)) return res.status(404).json({ error: 'Produto não encontrado' });
  try {
    const p = await produtoVisivel(db, pid, cid);
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
    const suppliers = await listar(db, pid);
    res.json({
      suppliers,
      product: { id: p.id, cost_price: num(p.cost_price), avg_cost: num(p.weighted_avg_cost) },
    });
  } catch (err) {
    if (falhaDeSchema(err)) return res.json({ suppliers: [], product: null, indisponivel: true });
    console.error('[productSuppliers] get error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar fornecedores do produto' });
  }
});

// ─── PUT /:pid/suppliers ─────────────────────────────────────
router.put('/:pid/suppliers', async (req, res) => {
  const { id: cid, pid } = req.params;
  if (!UUID.test(pid)) return res.status(404).json({ error: 'Produto não encontrado' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const p = await produtoVisivel(client, pid, cid, true);
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Produto não encontrado' }); }

    const lida = lerListaDeFornecedores(req.body, p.supplier_id);
    if (lida.erro) { await client.query('ROLLBACK'); return res.status(400).json({ error: lida.erro }); }
    const ids = lida.itens.map((i) => i.supplier_id);
    if (ids.some((i) => !UUID.test(i))) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Fornecedor inválido' }); }

    if (ids.length) {
      const { rows: vis } = await client.query(
        `SELECT id FROM suppliers WHERE id = ANY($1::uuid[]) AND ${companyGroupWhere('$2')}`,
        [ids, cid]
      );
      if (vis.length !== ids.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Fornecedor não encontrado' }); }
    }

    await client.query(
      `DELETE FROM product_suppliers WHERE product_id = $1 AND NOT (supplier_id = ANY($2::uuid[]))`,
      [pid, ids]
    );
    await client.query(`UPDATE product_suppliers SET is_main = false WHERE product_id = $1 AND is_main`, [pid]);
    for (const it of lida.itens) {
      await client.query(
        `INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, supplier_code, is_main)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (product_id, supplier_id) DO UPDATE
           SET cost = CASE WHEN $7::boolean THEN EXCLUDED.cost ELSE product_suppliers.cost END,
               supplier_code = EXCLUDED.supplier_code,
               is_main = EXCLUDED.is_main,
               updated_at = NOW()`,
        [p.company_id, pid, it.supplier_id, it.custo, it.codigo, it.principal, it.temCusto]
      );
    }
    await espelharPrincipal(client, pid);

    // Sem nenhuma entrada (sem custo médio) e sem custo no produto, a margem
    // usa o custo do principal (decisão do PO, tela 8).
    const principal = lida.itens.find((i) => i.principal);
    if (principal && principal.temCusto && principal.custo && num(p.weighted_avg_cost) === null && !(num(p.cost_price) > 0)) {
      await client.query(`UPDATE products SET cost_price = $2, updated_at = NOW() WHERE id = $1`, [pid, round(principal.custo, 2)]);
    }

    await client.query('COMMIT');
    const suppliers = await listar(db, pid);
    res.json({ suppliers });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (falhaDeSchema(err)) return res.status(503).json({ error: 'Recurso ainda não disponível. Tente de novo em alguns minutos.', code: 'SCHEMA_PENDENTE' });
    console.error('[productSuppliers] put error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar fornecedores do produto' });
  } finally {
    client.release();
  }
});

// ─── POST /:pid/stock-entries ────────────────────────────────
router.post('/:pid/stock-entries', async (req, res) => {
  const { id: cid, pid } = req.params;
  if (!UUID.test(pid)) return res.status(404).json({ error: 'Produto não encontrado' });
  const entrada = lerEntrada(req.body);
  if (entrada.erro) return res.status(400).json({ error: entrada.erro });
  if (entrada.itens.some((i) => i.variant_id && !UUID.test(i.variant_id))) {
    return res.status(400).json({ error: 'Variante inválida' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const p = await produtoVisivel(client, pid, cid, true);
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Produto não encontrado' }); }

    const variantes = await travarVariantes(client, pid);
    const erroDeGrade = conferirGrade(entrada, variantes);
    if (erroDeGrade) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: erroDeGrade });
    }

    const forn = await achaOuCriaFornecedor(client, cid, req.body || {});
    if (forn.erro) { await client.query('ROLLBACK'); return res.status(forn.status).json({ error: forn.erro }); }
    const fornecedor = forn.fornecedor;

    const { estoqueAntes, custoAntes, custoDepois } = await darEntradaNoProduto(client, {
      cid, produto: p, variantes, entrada, fornecedor,
    });

    await client.query('COMMIT');
    res.status(201).json({
      supplier: fornecedor ? { id: fornecedor.id, name: fornecedor.name, created: !!forn.criado } : null,
      quantity: entrada.total,
      unit_cost: entrada.custoUnitario,
      before: { stock_qty: estoqueAntes, avg_cost: custoAntes },
      after: { stock_qty: round(estoqueAntes + entrada.total, 3), avg_cost: custoDepois },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (falhaDeSchema(err)) return res.status(503).json({ error: 'Recurso ainda não disponível. Tente de novo em alguns minutos.', code: 'SCHEMA_PENDENTE' });
    console.error('[productSuppliers] entrada error:', err.message);
    res.status(500).json({ error: 'Erro ao dar entrada' });
  } finally {
    client.release();
  }
});

// ─── GET /:pid/stock-entries ─────────────────────────────────
// Por fornecedor (comprado, último custo, custo médio, última compra) e as
// 20 entradas mais recentes, com a loja (consolidado multi-CNPJ, tela 7).
router.get('/:pid/stock-entries', async (req, res) => {
  const { id: cid, pid } = req.params;
  if (!UUID.test(pid)) return res.status(404).json({ error: 'Produto não encontrado' });
  try {
    const p = await produtoVisivel(db, pid, cid);
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
    const [{ rows: entradas }, { rows: porFornecedor }] = await Promise.all([
      db.query(
        `SELECT sm.id, sm.created_at, sm.quantity, sm.unit_cost, sm.notes, sm.variant_id,
                sm.supplier_id, s.name AS supplier_name,
                sm.company_id, COALESCE(c.trade_name, c.legal_name) AS company_name
           FROM stock_movements sm
           LEFT JOIN suppliers s ON s.id = sm.supplier_id
           LEFT JOIN companies c ON c.id = sm.company_id
          WHERE sm.product_id = $1 AND sm.type = 'in' AND sm.reference_type = 'entrada'
          ORDER BY sm.created_at DESC
          LIMIT 20`,
        [pid]
      ),
      db.query(
        `SELECT sm.supplier_id, s.name AS supplier_name,
                SUM(sm.quantity) AS quantity,
                SUM(sm.quantity * sm.unit_cost) FILTER (WHERE sm.unit_cost > 0)
                  / NULLIF(SUM(sm.quantity) FILTER (WHERE sm.unit_cost > 0), 0) AS avg_cost,
                (ARRAY_AGG(sm.unit_cost ORDER BY sm.created_at DESC) FILTER (WHERE sm.unit_cost > 0))[1] AS unit_cost,
                MAX(sm.created_at) AS last_purchase_at
           FROM stock_movements sm
           JOIN suppliers s ON s.id = sm.supplier_id
          WHERE sm.product_id = $1 AND sm.type = 'in' AND sm.reference_type = 'entrada'
          GROUP BY sm.supplier_id, s.name
          ORDER BY MAX(sm.created_at) DESC`,
        [pid]
      ),
    ]);
    res.json({
      por_fornecedor: porFornecedor.map((r) => ({
        supplier_id: r.supplier_id, supplier_name: r.supplier_name,
        quantity: num(r.quantity), unit_cost: num(r.unit_cost),
        avg_cost: r.avg_cost === null ? null : round(r.avg_cost, 4),
        last_purchase_at: r.last_purchase_at,
      })),
      entradas: entradas.map((r) => ({ ...r, quantity: num(r.quantity), unit_cost: num(r.unit_cost) })),
      product: { id: p.id, stock_qty: num(p.stock_qty), cost_price: num(p.cost_price), avg_cost: num(p.weighted_avg_cost) },
    });
  } catch (err) {
    if (falhaDeSchema(err)) return res.json({ por_fornecedor: [], entradas: [], product: null, indisponivel: true });
    console.error('[productSuppliers] entradas error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar compras do produto' });
  }
});

module.exports = router;
