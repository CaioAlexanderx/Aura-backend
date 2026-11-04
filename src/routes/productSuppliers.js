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
const { companyGroupWhere, productVisibilityWhere } = require('../utils/companyGroup');
const { onlyDigits, isValidCnpj } = require('../utils/cnpj');
const {
  custoMedioPonderado, lerEntrada, lerListaDeFornecedores, round,
} = require('../services/entradaDeMercadoria');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v) => (v === null || v === undefined ? null : Number(v));

function falhaDeSchema(err) {
  return err && (err.code === '42P01' || err.code === '42703');
}

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

    const { rows: variantes } = await client.query(
      `SELECT id, stock_qty FROM product_variants WHERE product_id = $1 AND is_active = true FOR UPDATE`,
      [pid]
    );
    const temGrade = variantes.length > 0;
    const porGrade = entrada.itens.some((i) => i.variant_id);
    if (temGrade && !porGrade) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Esse produto tem cor/tamanho: informe quantas chegaram de cada' });
    }
    if (!temGrade && porGrade) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Esse produto não tem variantes' });
    }
    const daGrade = new Set(variantes.map((v) => v.id));
    if (porGrade && entrada.itens.some((i) => !daGrade.has(i.variant_id))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Variante não é deste produto' });
    }

    const forn = await achaOuCriaFornecedor(client, cid, req.body || {});
    if (forn.erro) { await client.query('ROLLBACK'); return res.status(forn.status).json({ error: forn.erro }); }
    const fornecedor = forn.fornecedor;

    const estoqueAntes = temGrade
      ? variantes.reduce((s, v) => s + (Number(v.stock_qty) || 0), 0)
      : Number(p.stock_qty) || 0;
    const custoAntes = num(p.weighted_avg_cost) !== null ? num(p.weighted_avg_cost)
      : (num(p.cost_price) > 0 ? num(p.cost_price) : null);
    const custoDepois = custoMedioPonderado({
      estoqueAntes, custoAtual: custoAntes, quantidade: entrada.total, custoUnitario: entrada.custoUnitario,
    });

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
        [p.company_id, pid, fornecedor.id, entrada.custoUnitario]
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
