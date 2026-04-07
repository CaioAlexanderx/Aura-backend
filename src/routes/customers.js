// ============================================================
// AURA. -- S5: Customers CRUD
// GET    /companies/:id/customers       -- list
// POST   /companies/:id/customers       -- create
// PATCH  /companies/:id/customers/:cid  -- update
// DELETE /companies/:id/customers/:cid  -- soft delete
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

// GET / -- list customers
router.get('/', async (req, res) => {
  const companyId = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.search;

  try {
    let where = 'WHERE company_id = $1 AND is_active = true';
    const params = [companyId];
    if (search) {
      where += ` AND (name ILIKE $${params.length + 1} OR phone ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM customers ${where}`, params
    );

    const dataRes = await db.query(
      `SELECT id, name, phone, email, birth_date, instagram_handle,
              total_purchases, total_spent, last_purchase_at, first_purchase_at,
              notes, rating, created_at
       FROM customers ${where}
       ORDER BY name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const customers = dataRes.rows.map(r => ({
      id: r.id,
      name: r.name || '',
      phone: r.phone || '',
      email: r.email || '',
      birth_date: r.birth_date || null,
      instagram: r.instagram_handle || '',
      total_spent: parseFloat(r.total_spent) || 0,
      visit_count: parseInt(r.total_purchases) || 0,
      last_purchase: r.last_purchase_at || null,
      first_visit: r.first_purchase_at || r.created_at || null,
      notes: r.notes || '',
      rating: r.rating != null ? parseInt(r.rating) : null,
      created_at: r.created_at,
    }));

    res.json({
      customers,
      total: parseInt(countRes.rows[0]?.total) || 0,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[customers] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// POST / -- create customer
router.post('/', async (req, res) => {
  const companyId = req.params.id;
  const { name, phone, email, birth_date, instagram, notes } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }

  try {
    const result = await db.query(
      `INSERT INTO customers (company_id, name, phone, email, birth_date, instagram_handle, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        companyId,
        String(name).trim(),
        phone || null,
        email || null,
        birth_date || null,
        instagram || null,
        notes || null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[customers] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar cliente' });
  }
});

// PATCH /:cid -- update customer
router.patch('/:cid', async (req, res) => {
  const { id: companyId, cid } = req.params;
  const fieldMap = {
    name: 'name', phone: 'phone', email: 'email',
    birth_date: 'birth_date', instagram: 'instagram_handle',
    notes: 'notes', rating: 'rating',
  };
  const updates = [];
  const values = [];
  let idx = 1;

  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[bodyKey] !== undefined) {
      updates.push(`${dbCol} = $${idx}`);
      values.push(req.body[bodyKey]);
      idx++;
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  updates.push('updated_at = NOW()');
  values.push(cid, companyId);

  try {
    const result = await db.query(
      `UPDATE customers SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Cliente nao encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[customers] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar cliente' });
  }
});

// DELETE /:cid -- soft delete
router.delete('/:cid', async (req, res) => {
  const { id: companyId, cid } = req.params;

  try {
    const result = await db.query(
      `UPDATE customers SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 RETURNING id, name`,
      [cid, companyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Cliente nao encontrado' });
    }

    res.json({ deleted: true, id: cid, name: result.rows[0].name });
  } catch (err) {
    console.error('[customers] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao deletar cliente' });
  }
});

module.exports = router;
