// ============================================================
// AURA. — Variantes de Produto (BE-16)
// Plano mínimo: Negócio
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const pool    = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

async function checkProductOwnership(company_id, product_id) {
  const { rows } = await pool.query(
    'SELECT id FROM products WHERE id = $1 AND company_id = $2',
    [product_id, company_id]
  );
  return rows.length > 0;
}

// GET /companies/:id/products/:pid/variants
router.get('/', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  try {
    if (!await checkProductOwnership(company_id, product_id)) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    const { rows } = await pool.query(
      `SELECT
         v.id, v.sku_suffix, v.price_override, v.stock_qty,
         v.barcode, v.barcode_format, v.is_active,
         v.created_at, v.updated_at,
         JSON_AGG(
           JSON_BUILD_OBJECT('attribute', vv.attribute_name, 'value', vv.value)
           ORDER BY vv.attribute_name
         ) FILTER (WHERE vv.id IS NOT NULL) AS attributes
       FROM product_variants v
       LEFT JOIN product_variant_values vv ON vv.variant_id = v.id
       WHERE v.product_id = $1
       GROUP BY v.id
       ORDER BY v.created_at ASC`,
      [product_id]
    );
    const { rows: product } = await pool.query(
      'SELECT name, price FROM products WHERE id = $1', [product_id]
    );
    res.json({
      product_id,
      product_name: product[0]?.name,
      base_price:   product[0]?.price,
      total:        rows.length,
      variants:     rows,
    });
  } catch (err) {
    console.error('variants GET error:', err);
    res.status(500).json({ error: 'Erro ao buscar variantes' });
  }
});

// POST /companies/:id/products/:pid/variants
router.post('/', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { sku_suffix, price_override, stock_qty = 0, barcode, barcode_format, attributes = [] } = req.body;

  if (!sku_suffix || sku_suffix.trim() === '') {
    return res.status(400).json({ error: 'sku_suffix é obrigatório (ex: ROSA-38, P, Azul)' });
  }
  if (attributes.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos um atributo (ex: [{attribute: "Cor", value: "Rosa"}])' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!await checkProductOwnership(company_id, product_id)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    const dupCheck = await client.query(
      'SELECT id FROM product_variants WHERE product_id = $1 AND sku_suffix = $2',
      [product_id, sku_suffix.trim()]
    );
    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Já existe uma variante com este SKU' });
    }
    const { rows: variantRows } = await client.query(
      `INSERT INTO product_variants
         (product_id, sku_suffix, price_override, stock_qty, barcode, barcode_format)
       VALUES ($1, $2, $3, $4, $5, $6::barcode_format)
       RETURNING *`,
      [product_id, sku_suffix.trim(), price_override || null, stock_qty,
       barcode || null, barcode_format || null]
    );
    const variant = variantRows[0];
    const attrResults = [];
    for (const attr of attributes) {
      if (!attr.attribute || !attr.value) continue;
      const { rows: attrRows } = await client.query(
        `INSERT INTO product_variant_values (variant_id, attribute_name, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (variant_id, attribute_name) DO UPDATE SET value = EXCLUDED.value
         RETURNING attribute_name, value`,
        [variant.id, attr.attribute.trim(), attr.value.trim()]
      );
      attrResults.push(attrRows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ variant: { ...variant, attributes: attrResults } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('variant POST error:', err);
    res.status(500).json({ error: 'Erro ao criar variante' });
  } finally {
    client.release();
  }
});

// PATCH /companies/:id/products/:pid/variants/:vid
router.patch('/:vid', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, pid: product_id, vid: variant_id } = req.params;
  const { sku_suffix, price_override, stock_qty, barcode, barcode_format, is_active, attributes } = req.body;
  try {
    if (!await checkProductOwnership(company_id, product_id)) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    const fields = [], values = [];
    let idx = 1;
    if (sku_suffix     !== undefined) { fields.push(`sku_suffix = $${idx++}`);     values.push(sku_suffix); }
    if (price_override !== undefined) { fields.push(`price_override = $${idx++}`); values.push(price_override); }
    if (stock_qty      !== undefined) { fields.push(`stock_qty = $${idx++}`);      values.push(stock_qty); }
    if (barcode        !== undefined) { fields.push(`barcode = $${idx++}`);        values.push(barcode); }
    if (barcode_format !== undefined) { fields.push(`barcode_format = $${idx++}::barcode_format`); values.push(barcode_format); }
    if (is_active      !== undefined) { fields.push(`is_active = $${idx++}`);      values.push(is_active); }
    if (fields.length === 0 && !attributes) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }
    let variant = null;
    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(variant_id, product_id);
      const { rows } = await pool.query(
        `UPDATE product_variants SET ${fields.join(', ')}
         WHERE id = $${idx++} AND product_id = $${idx++} RETURNING *`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Variante não encontrada' });
      variant = rows[0];
    }
    if (attributes && Array.isArray(attributes)) {
      for (const attr of attributes) {
        if (!attr.attribute || !attr.value) continue;
        await pool.query(
          `INSERT INTO product_variant_values (variant_id, attribute_name, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (variant_id, attribute_name) DO UPDATE SET value = EXCLUDED.value`,
          [variant_id, attr.attribute.trim(), attr.value.trim()]
        );
      }
    }
    res.json({ variant: variant || { id: variant_id, updated: true } });
  } catch (err) {
    console.error('variant PATCH error:', err);
    res.status(500).json({ error: 'Erro ao atualizar variante' });
  }
});

// DELETE /companies/:id/products/:pid/variants/:vid
router.delete('/:vid', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, pid: product_id, vid: variant_id } = req.params;
  try {
    if (!await checkProductOwnership(company_id, product_id)) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    const { rows } = await pool.query(
      'DELETE FROM product_variants WHERE id = $1 AND product_id = $2 RETURNING id',
      [variant_id, product_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Variante não encontrada' });
    res.json({ message: 'Variante removida' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover variante' });
  }
});

module.exports = router;
