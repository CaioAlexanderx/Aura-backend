// ============================================================
// AURA. — S3: Transactions CRUD
// GET    /companies/:id/transactions       — list
// POST   /companies/:id/transactions       — create single
// PATCH  /companies/:id/transactions/:txId — update
// DELETE /companies/:id/transactions/:txId — delete
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

// GET / — list transactions (paginated)
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const type = req.query.type; // income | expense

  try {
    let where = 'WHERE company_id = $1';
    const params = [cid];
    if (type === 'income' || type === 'expense') {
      where += ` AND type = $${params.length + 1}`;
      params.push(type);
    }

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM transactions ${where}`, params
    );

    const dataRes = await db.query(
      `SELECT id, type, amount, description, category, status, notes, created_at
       FROM transactions ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    // Summary
    const sumRes = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS expenses
       FROM transactions WHERE company_id = $1
         AND created_at >= date_trunc('month', CURRENT_DATE)`,
      [cid]
    );

    const transactions = dataRes.rows.map(r => ({
      id: r.id,
      type: r.type,
      amount: parseFloat(r.amount) || 0,
      desc: r.description || '',
      description: r.description || '',
      category: r.category || 'Outros',
      status: r.status || 'confirmed',
      notes: r.notes || '',
      date: r.created_at ? new Date(r.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '--/--',
      created_at: r.created_at,
    }));

    res.json({
      transactions,
      total: parseInt(countRes.rows[0]?.total) || 0,
      limit,
      offset,
      summary: {
        income: parseFloat(sumRes.rows[0]?.income) || 0,
        expenses: parseFloat(sumRes.rows[0]?.expenses) || 0,
      },
    });
  } catch (err) {
    console.error('[transactions] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar lancamentos' });
  }
});

// POST / — create single transaction
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { type, amount, description, category, notes, due_date } = req.body;

  if (!type || !['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'type deve ser income ou expense' });
  }
  if (!amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'amount deve ser maior que zero' });
  }
  if (!description || !String(description).trim()) {
    return res.status(400).json({ error: 'description e obrigatoria' });
  }

  try {
    // Insert without status — let DB default handle it
    const result = await db.query(
      `INSERT INTO transactions (company_id, type, amount, description, category, notes, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, type, amount, description, category, status, created_at`,
      [
        cid,
        type,
        parseFloat(amount),
        String(description).trim(),
        category || 'Outros',
        notes || null,
        due_date || new Date().toISOString().slice(0, 10),
        req.user?.id || null,
      ]
    );

    const tx = result.rows[0];
    res.status(201).json({
      id: tx.id,
      type: tx.type,
      amount: parseFloat(tx.amount),
      description: tx.description,
      category: tx.category,
      status: tx.status,
      created_at: tx.created_at,
    });
  } catch (err) {
    console.error('[transactions] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar lancamento' });
  }
});

// PATCH /:txId — update
router.patch('/:txId', async (req, res) => {
  const { id: cid, txId } = req.params;
  const fields = ['type', 'amount', 'description', 'category', 'status', 'notes'];
  const updates = [];
  const values = [];
  let idx = 1;

  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = $${idx}`);
      values.push(f === 'amount' ? parseFloat(req.body[f]) : req.body[f]);
      idx++;
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  updates.push(`updated_at = NOW()`);
  values.push(txId, cid);

  try {
    const result = await db.query(
      `UPDATE transactions SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Lancamento nao encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[transactions] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar lancamento' });
  }
});

// DELETE /:txId
router.delete('/:txId', async (req, res) => {
  const { id: cid, txId } = req.params;

  try {
    const result = await db.query(
      'DELETE FROM transactions WHERE id = $1 AND company_id = $2 RETURNING id',
      [txId, cid]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Lancamento nao encontrado' });
    }

    res.json({ deleted: true, id: txId });
  } catch (err) {
    console.error('[transactions] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao deletar lancamento' });
  }
});

module.exports = router;
