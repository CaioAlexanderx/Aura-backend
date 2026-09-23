// ============================================================
// AURA. — PDV: Lookup de produto por código (BE-15 + PDV-01)
// Suporta: barcode (EAN-13, CODE-128, QR), SKU, nome parcial
// Retorna variantes quando produto tem variantes cadastradas
// ============================================================
const express = require('express');
const router  = require('express').Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// 22/09/2026 — preco no cartao (migration 351). O Caixa precisa de
// products.card_price junto do preco pra decidir o unit_price quando a
// forma e debito/credito. `rodar(col)` monta o SQL com a coluna; base
// atras da 351 da 42703 e a mesma consulta roda sem ela (o produto volta
// sem card_price e o Caixa usa o % da loja). O backend sobe antes da
// migration (CLAUDE.md, armadilha 1) — bipar nao pode cair por isso.
async function comCardPrice(rodar) {
  try {
    return await rodar(', p.card_price');
  } catch (e) {
    if (e.code !== '42703') throw e;
    return rodar('');
  }
}

// GET /companies/:id/pdv/scan/:code
// Lookup chamado pelo PDV ao receber código escaneado (jsQR / leitor USB)
router.get('/scan/:code', requireAuth, async (req, res) => {
  const { id: company_id, code } = req.params;
  const cleanCode = (code || '').trim();
  if (!cleanCode) return res.status(400).json({ error: 'Código não informado' });

  try {
    // 1. Match exato por barcode
    let { rows } = await comCardPrice((cp) => db.query(
      `SELECT p.id, p.name, p.description, p.price, p.cost_price,
              p.stock_qty, p.barcode, p.barcode_format, p.category,
              p.sku, p.is_active, p.unit${cp},
              COALESCE(json_agg(
                json_build_object(
                  'id', pv.id, 'sku_suffix', pv.sku_suffix,
                  'price_override', pv.price_override,
                  'stock_qty', pv.stock_qty, 'barcode', pv.barcode,
                  'attributes', (
                    SELECT json_agg(json_build_object('attr', pvval.attribute_name, 'val', pvval.value))
                    FROM product_variant_values pvval WHERE pvval.variant_id=pv.id
                  )
                )
              ) FILTER (WHERE pv.id IS NOT NULL), '[]') AS variants
       FROM products p
       LEFT JOIN product_variants pv ON pv.product_id=p.id AND pv.is_active=TRUE
       WHERE p.company_id=$1 AND p.barcode=$2 AND p.is_active=TRUE
       GROUP BY p.id
       LIMIT 1`,
      [company_id, cleanCode]
    ));
    if (rows.length) return res.json({ match: 'exact', source: 'barcode', product: rows[0] });

    // 2. Match por barcode de variante
    const { rows: varRows } = await comCardPrice((cp) => db.query(
      `SELECT p.id, p.name, p.price, p.cost_price, p.stock_qty,
              p.barcode, p.category, p.sku, p.is_active, p.unit${cp},
              pv.id AS variant_id, pv.sku_suffix, pv.price_override,
              pv.stock_qty AS variant_stock
       FROM product_variants pv
       JOIN products p ON p.id=pv.product_id
       WHERE p.company_id=$1 AND pv.barcode=$2 AND pv.is_active=TRUE AND p.is_active=TRUE
       LIMIT 1`,
      [company_id, cleanCode]
    ));
    if (varRows.length) {
      return res.json({
        match: 'exact', source: 'variant_barcode',
        product: varRows[0],
        variant_id: varRows[0].variant_id,
        effective_price: varRows[0].price_override || varRows[0].price,
      });
    }

    // 3. Match por SKU
    ({ rows } = await comCardPrice((cp) => db.query(
      `SELECT p.id, p.name, p.price, p.cost_price, p.stock_qty,
              p.barcode, p.category, p.sku, p.is_active, p.unit${cp}
       FROM products p
       WHERE p.company_id=$1 AND p.sku=$2 AND p.is_active=TRUE LIMIT 1`,
      [company_id, cleanCode]
    )));
    if (rows.length) return res.json({ match: 'exact', source: 'sku', product: rows[0] });

    // 4. Busca textual por nome/SKU (retorna até 8 sugestões)
    ({ rows } = await comCardPrice((cp) => db.query(
      `SELECT p.id, p.name, p.price, p.stock_qty, p.barcode, p.sku, p.category, p.unit${cp}
       FROM products p
       WHERE p.company_id=$1 AND p.is_active=TRUE
         AND (p.name ILIKE $2 OR p.sku ILIKE $2)
       ORDER BY p.name LIMIT 8`,
      [company_id, `%${cleanCode}%`]
    )));
    if (rows.length) {
      return res.status(207).json({
        match: 'partial',
        message: 'Nenhum código exato encontrado. Sugestões:',
        suggestions: rows,
      });
    }

    res.status(404).json({ match: 'none', error: 'Produto não encontrado', code: cleanCode });
  } catch (err) {
    console.error('scanner lookup error:', err);
    res.status(500).json({ error: 'Erro na busca do código' });
  }
});

// GET /companies/:id/pdv/scan/batch
// Body: { codes: ['123','456'] }
// Lookup em lote para carregar múltiplos itens de uma vez
router.post('/scan/batch', requireAuth, async (req, res) => {
  const { codes } = req.body;
  if (!codes?.length) return res.status(400).json({ error: 'codes obrigatório' });
  try {
    const { rows } = await comCardPrice((cp) => db.query(
      `SELECT p.id, p.name, p.price, p.cost_price, p.stock_qty, p.barcode, p.sku, p.category, p.unit${cp}
       FROM products p
       WHERE p.company_id=$1 AND p.is_active=TRUE
         AND (p.barcode=ANY($2) OR p.sku=ANY($2))`,
      [req.params.id, codes]
    ));
    const byCode = {};
    rows.forEach(p => {
      if (p.barcode) byCode[p.barcode] = p;
      if (p.sku)     byCode[p.sku]     = p;
    });
    res.json({ found: rows.length, products: byCode });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
