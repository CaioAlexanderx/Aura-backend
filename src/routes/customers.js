// ============================================================
// AURA. -- S5: Customers CRUD
// GET    /companies/:id/customers       -- list
// POST   /companies/:id/customers       -- create
// PATCH  /companies/:id/customers/:cid  -- update
// DELETE /companies/:id/customers/:cid  -- delete
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
    let where = 'WHERE company_id = $1';
    const params = [companyId];
    if (search) {
      where += ` AND (name ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1} OR phone ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM customers ${where}`, params
    );

    const dataRes = await db.query(
      `SELECT * FROM customers ${where}
       ORDER BY name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      customers: dataRes.rows,
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
  const { name, email, phone, notes, birthday, instagram } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }

  try {
    // Build dynamic INSERT based on which columns exist
    const cols = ['company_id', 'name'];
    const vals = [companyId, String(name).trim()];
    const placeholders = ['$1', '$2'];
    let idx = 3;

    const optionalFields = { email, phone, notes };
    for (const [key, val] of Object.entries(optionalFields)) {
      if (val !== undefined) {
        cols.push(key);
        vals.push(val || null);
        placeholders.push(`$${idx++}`);
      }
    }

    // Try birthday and instagram — may not exist in all schemas
    if (birthday) {
      cols.push('birthday');
      vals.push(birthday);
      placeholders.push(`$${idx++}`);
    }
    if (instagram) {
      cols.push('instagram');
      vals.push(instagram);
      placeholders.push(`$${idx++}`);
    }

    const result = await db.query(
      `INSERT INTO customers (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      vals
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[customers] create error:', err.message);
    // If column doesn't exist, retry with minimal fields
    if (err.message.includes('does not exist')) {
      try {
        const result = await db.query(
          `INSERT INTO customers (company_id, name, email, phone, notes)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [companyId, String(name).trim(), email || null, phone || null, notes || null]
        );
        return res.status(201).json(result.rows[0]);
      } catch (err2) {
        console.error('[customers] create fallback error:', err2.message);
      }
    }
    res.status(500).json({ error: 'Erro ao criar cliente' });
  }
});

// PATCH /:cid -- update customer
router.patch('/:cid', async (req, res) => {
  const { id: companyId, cid } = req.params;
  const allowed = ['name', 'email', 'phone', 'notes', 'birthday', 'instagram'];
  const updates = [];
  const values = [];
  let idx = 1;

  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = $${idx}`);
      values.push(req.body[f]);
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

// DELETE /:cid
router.delete('/:cid', async (req, res) => {
  const { id: companyId, cid } = req.params;

  try {
    const result = await db.query(
      'DELETE FROM customers WHERE id = $1 AND company_id = $2 RETURNING id, name',
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
