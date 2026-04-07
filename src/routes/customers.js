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
      `SELECT id, name, cpf_cnpj, email, phone, birth_date, instagram_handle,
              total_purchases, total_spent, last_purchase_at, first_purchase_at,
              notes, is_active, created_at
       FROM customers ${where}
       ORDER BY name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const customers = dataRes.rows.map(r => ({
      id: r.id,
      name: r.name || '',
      email: r.email || '',
      phone: r.phone || '',
      cpf_cnpj: r.cpf_cnpj || '',
      birthday: r.birth_date ? new Date(r.birth_date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '',
      birth_date: r.birth_date,
      instagram: r.instagram_handle || '',
      instagram_handle: r.instagram_handle || '',
      total_spent: parseFloat(r.total_spent) || 0,
      totalSpent: parseFloat(r.total_spent) || 0,
      visits: parseInt(r.total_purchases) || 0,
      visit_count: parseInt(r.total_purchases) || 0,
      last_purchase: r.last_purchase_at,
      first_visit: r.first_purchase_at,
      notes: r.notes || '',
      is_active: r.is_active !== false,
      rating: null,
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
  const { name, email, phone, notes, birthday, birth_date, instagram, instagram_handle, cpf_cnpj } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }

  const finalBirthDate = birth_date || birthday || null;
  const finalInstagram = instagram_handle || instagram || null;

  try {
    const result = await db.query(
      `INSERT INTO customers (company_id, name, email, phone, notes, birth_date, instagram_handle, cpf_cnpj)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        companyId,
        String(name).trim(),
        email || null,
        phone || null,
        notes || null,
        finalBirthDate,
        finalInstagram,
        cpf_cnpj || null,
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
    name: 'name', email: 'email', phone: 'phone', notes: 'notes',
    cpf_cnpj: 'cpf_cnpj', birth_date: 'birth_date', birthday: 'birth_date',
    instagram: 'instagram_handle', instagram_handle: 'instagram_handle',
    is_active: 'is_active',
  };
  const updates = [];
  const values = [];
  let idx = 1;
  const seen = new Set();

  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[bodyKey] !== undefined && !seen.has(dbCol)) {
      updates.push(`${dbCol} = $${idx}`);
      values.push(req.body[bodyKey]);
      idx++;
      seen.add(dbCol);
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
