// ============================================================
// AURA. -- S4: Products CRUD
// GET    /companies/:id/products       -- list
// POST   /companies/:id/products       -- create
// PATCH  /companies/:id/products/:pid  -- update
// DELETE /companies/:id/products/:pid  -- delete
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
      where += ` AND (name ILIKE $${params.length + 1} OR sku ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM products ${where}`, params
    );

    const dataRes = await db.query(
      `SELECT id, name, sku, barcode, category, description, price, cost_price,
              stock_qty, stock_min, stock_max, unit, is_active, created_at
       FROM products ${where}
       ORDER BY name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const products = dataRes.rows.map(r => ({
      id: r.id,
      name: r.name || '',
      sku: r.sku || '',
      barcode: r.barcode || '',
      category: r.category || 'Produtos',
      description: r.description || '',
      price: parseFloat(r.price) || 0,
      cost_price: parseFloat(r.cost_price) || 0,
      stock_qty: parseInt(r.stock_qty) || 0,
      min_stock: parseInt(r.stock_min) || 0,
      stock_max: parseInt(r.stock_max) || 0,
      unit: r.unit || 'un',
      is_active: r.is_active !== false,
      created_at: r.created_at,
    }));

    res.json({
      products,
      total: parseInt(countRes.rows[0]?.total) || 0,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[products] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar produtos' });
  }
});

// POST / -- create product
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { name, sku, barcode, category, description, price, cost_price, stock_qty, min_stock, stock_max, unit } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }

  try {
    const result = await db.query(
      `INSERT INTO products (company_id, name, sku, barcode, category, description, price, cost_price, stock_qty, stock_min, stock_max, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        cid,
        String(name).trim(),
        sku || null,
        barcode || null,
        category || 'Produtos',
        description || null,
        parseFloat(price) || 0,
        parseFloat(cost_price) || 0,
        parseInt(stock_qty) || 0,
        parseInt(min_stock) || 0,
        parseInt(stock_max) || 0,
        unit || 'un',
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[products] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar produto' });
  }
});

// PATCH /:pid -- update product
router.patch('/:pid', async (req, res) => {
  const { id: cid, pid } = req.params;
  // Map frontend field names to DB column names
  const fieldMap = {
    name: 'name', sku: 'sku', barcode: 'barcode', category: 'category',
    description: 'description', price: 'price', cost_price: 'cost_price',
    stock_qty: 'stock_qty', min_stock: 'stock_min', stock_max: 'stock_max',
    unit: 'unit', is_active: 'is_active',
  };
  const numFields = ['price', 'cost_price', 'stock_qty', 'stock_min', 'stock_max'];
  const updates = [];
  const values = [];
  let idx = 1;

  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[bodyKey] !== undefined) {
      updates.push(`${dbCol} = $${idx}`);
      values.push(numFields.includes(dbCol) ? parseFloat(req.body[bodyKey]) : req.body[bodyKey]);
      idx++;
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  updates.push('updated_at = NOW()');
  values.push(pid, cid);

  try {
    const result = await db.query(
      `UPDATE products SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[products] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

// DELETE /:pid
router.delete('/:pid', async (req, res) => {
  const { id: cid, pid } = req.params;

  try {
    const result = await db.query(
      'DELETE FROM products WHERE id = $1 AND company_id = $2 RETURNING id, name',
      [pid, cid]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }

    res.json({ deleted: true, id: pid, name: result.rows[0].name });
  } catch (err) {
    console.error('[products] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao deletar produto' });
  }
});

module.exports = router;
