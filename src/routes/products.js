// ============================================================
// AURA. -- S4: Products CRUD
// GET    /companies/:id/products          -- list
// POST   /companies/:id/products          -- create
// PATCH  /companies/:id/products/:prodId  -- update
// DELETE /companies/:id/products/:prodId  -- delete
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

// GET / -- list products
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const category = req.query.category;
  const search = req.query.search;

  try {
    let where = 'WHERE company_id = $1';
    const params = [cid];
    if (category) {
      where += ` AND category = $${params.length + 1}`;
      params.push(category);
    }
    if (search) {
      where += ` AND (LOWER(name) LIKE $${params.length + 1} OR LOWER(sku) LIKE $${params.length + 1})`;
      params.push('%' + search.toLowerCase() + '%');
    }

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM products ${where}`, params
    );

    const dataRes = await db.query(
      `SELECT id, name, sku, barcode, category, price, cost_price,
              stock_qty, min_stock, unit, brand, notes, abc_class,
              created_at, updated_at
       FROM products ${where}
       ORDER BY name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    // Summary
    const sumRes = await db.query(
      `SELECT
         COUNT(*) AS total_products,
         COALESCE(SUM(stock_qty), 0) AS total_units,
         COALESCE(SUM(stock_qty * cost_price), 0) AS total_value,
         COUNT(*) FILTER (WHERE stock_qty <= min_stock AND min_stock > 0) AS low_stock
       FROM products WHERE company_id = $1`,
      [cid]
    );

    const products = dataRes.rows.map(r => ({
      id: r.id,
      name: r.name || '',
      code: r.sku || '',
      sku: r.sku || '',
      barcode: r.barcode || '',
      category: r.category || 'Produtos',
      price: parseFloat(r.price) || 0,
      cost: parseFloat(r.cost_price) || 0,
      cost_price: parseFloat(r.cost_price) || 0,
      stock: parseInt(r.stock_qty) || 0,
      stock_qty: parseInt(r.stock_qty) || 0,
      minStock: parseInt(r.min_stock) || 0,
      min_stock: parseInt(r.min_stock) || 0,
      unit: r.unit || 'un',
      brand: r.brand || '',
      notes: r.notes || '',
      abc: r.abc_class || 'C',
      abc_class: r.abc_class || 'C',
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    res.json({
      products,
      total: parseInt(countRes.rows[0]?.total) || 0,
      limit,
      offset,
      summary: {
        total_products: parseInt(sumRes.rows[0]?.total_products) || 0,
        total_units: parseInt(sumRes.rows[0]?.total_units) || 0,
        total_value: parseFloat(sumRes.rows[0]?.total_value) || 0,
        low_stock: parseInt(sumRes.rows[0]?.low_stock) || 0,
      },
    });
  } catch (err) {
    console.error('[products] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar produtos' });
  }
});

// POST / -- create product
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { name, sku, barcode, category, price, cost_price, stock_qty, min_stock, unit, brand, notes } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }

  try {
    const result = await db.query(
      `INSERT INTO products (company_id, name, sku, barcode, category, price, cost_price, stock_qty, min_stock, unit, brand, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        cid,
        String(name).trim(),
        sku || null,
        barcode || null,
        category || 'Produtos',
        parseFloat(price) || 0,
        parseFloat(cost_price) || 0,
        parseInt(stock_qty) || 0,
        parseInt(min_stock) || 0,
        unit || 'un',
        brand || null,
        notes || null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[products] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar produto' });
  }
});

// PATCH /:prodId -- update
router.patch('/:prodId', async (req, res) => {
  const { id: cid, prodId } = req.params;
  const fields = ['name', 'sku', 'barcode', 'category', 'price', 'cost_price', 'stock_qty', 'min_stock', 'unit', 'brand', 'notes'];
  const updates = [];
  const values = [];
  let idx = 1;

  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = $${idx}`);
      const val = ['price', 'cost_price'].includes(f) ? parseFloat(req.body[f]) :
                  ['stock_qty', 'min_stock'].includes(f) ? parseInt(req.body[f]) : req.body[f];
      values.push(val);
      idx++;
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  updates.push('updated_at = NOW()');
  values.push(prodId, cid);

  try {
    const result = await db.query(
      `UPDATE products SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[products] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

// DELETE /:prodId
router.delete('/:prodId', async (req, res) => {
  const { id: cid, prodId } = req.params;
  try {
    const result = await db.query(
      'DELETE FROM products WHERE id = $1 AND company_id = $2 RETURNING id, name',
      [prodId, cid]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    res.json({ deleted: true, id: prodId, name: result.rows[0].name });
  } catch (err) {
    console.error('[products] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao deletar produto' });
  }
});

module.exports = router;
