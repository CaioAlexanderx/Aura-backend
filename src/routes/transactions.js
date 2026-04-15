// ============================================================
// AURA. — Transactions CRUD
// FIX: Added start/end date params for server-side period filter
// ============================================================
var router = require('express').Router({ mergeParams: true });
var db = require('../config/database');

router.get('/', async function(req, res) {
  var cid = req.params.id;
  var limit = Math.min(parseInt(req.query.limit) || 200, 10000);
  var offset = parseInt(req.query.offset) || 0;
  var type = req.query.type;
  var start = req.query.start; // ISO date e.g. 2026-01-01
  var end = req.query.end;     // ISO date e.g. 2026-12-31

  try {
    var where = 'WHERE company_id = $1';
    var params = [cid];

    if (type === 'income' || type === 'expense') {
      params.push(type);
      where += ' AND type = $' + params.length;
    }
    if (start) {
      params.push(start);
      where += ' AND COALESCE(due_date, created_at::date) >= $' + params.length;
    }
    if (end) {
      params.push(end);
      where += ' AND COALESCE(due_date, created_at::date) <= $' + params.length;
    }

    var countRes = await db.query('SELECT COUNT(*) AS total FROM transactions ' + where, params);

    var dataParams = params.concat([limit, offset]);
    var dataRes = await db.query(
      'SELECT id, type, amount, description, category, status, notes, due_date, paid_at, created_at' +
      ' FROM transactions ' + where +
      ' ORDER BY COALESCE(due_date, created_at::date) DESC, created_at DESC' +
      ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2),
      dataParams
    );

    // Summary respects period filter too
    var sumWhere = 'WHERE company_id = $1';
    var sumParams = [cid];
    if (start) { sumParams.push(start); sumWhere += ' AND COALESCE(due_date, created_at::date) >= $' + sumParams.length; }
    if (end) { sumParams.push(end); sumWhere += ' AND COALESCE(due_date, created_at::date) <= $' + sumParams.length; }
    // Fallback: if no period, use current month
    if (!start && !end) { sumWhere += ' AND created_at >= date_trunc(\'month\', CURRENT_DATE)'; }

    var sumRes = await db.query(
      'SELECT COALESCE(SUM(CASE WHEN type=\'income\' THEN amount ELSE 0 END), 0) AS income,' +
      '       COALESCE(SUM(CASE WHEN type=\'expense\' THEN amount ELSE 0 END), 0) AS expenses' +
      ' FROM transactions ' + sumWhere, sumParams
    );

    var transactions = dataRes.rows.map(function(r) {
      return {
        id: r.id, type: r.type, amount: parseFloat(r.amount) || 0,
        desc: r.description || '', description: r.description || '',
        category: r.category || 'Outros', status: r.status || 'confirmed',
        notes: r.notes || '',
        date: r.created_at ? new Date(r.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '--/--',
        due_date: r.due_date, paid_at: r.paid_at, created_at: r.created_at,
      };
    });

    res.json({
      transactions: transactions,
      total: parseInt(countRes.rows[0]?.total) || 0,
      limit: limit, offset: offset,
      summary: {
        income: parseFloat(sumRes.rows[0]?.income) || 0,
        expenses: parseFloat(sumRes.rows[0]?.expenses) || 0,
      },
    });
  } catch (err) {
    console.error('[transactions] list:', err.message);
    res.status(500).json({ error: 'Erro ao listar lancamentos' });
  }
});

router.post('/', async function(req, res) {
  var cid = req.params.id;
  var body = req.body;
  if (!body.type || (body.type !== 'income' && body.type !== 'expense')) return res.status(400).json({ error: 'type deve ser income ou expense' });
  if (!body.amount || parseFloat(body.amount) <= 0) return res.status(400).json({ error: 'amount deve ser maior que zero' });
  if (!body.description || !String(body.description).trim()) return res.status(400).json({ error: 'description e obrigatoria' });
  var finalStatus = (body.status === 'pending') ? 'pending' : 'confirmed';
  var paidAt = finalStatus === 'confirmed' ? 'NOW()' : 'NULL';
  try {
    var result = await db.query(
      'INSERT INTO transactions (company_id, type, amount, description, category, notes, due_date, status, paid_at, created_by)' +
      ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ' + paidAt + ', $9)' +
      ' RETURNING id, type, amount, description, category, status, paid_at, created_at',
      [cid, body.type, parseFloat(body.amount), String(body.description).trim(), body.category || 'Outros',
       body.notes || null, body.due_date || new Date().toISOString().slice(0, 10), finalStatus, req.user?.id || null]
    );
    var tx = result.rows[0];
    res.status(201).json({ id: tx.id, type: tx.type, amount: parseFloat(tx.amount), description: tx.description, category: tx.category, status: tx.status, paid_at: tx.paid_at, created_at: tx.created_at });
  } catch (err) { console.error('[transactions] create:', err.message); res.status(500).json({ error: 'Erro ao criar lancamento' }); }
});

router.patch('/:txId', async function(req, res) {
  var cid = req.params.id;
  var txId = req.params.txId;
  var fields = ['type', 'amount', 'description', 'category', 'status', 'notes', 'due_date'];
  var updates = [], values = []; var idx = 1;
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (req.body[f] !== undefined) {
      updates.push(f + ' = $' + idx); values.push(f === 'amount' ? parseFloat(req.body[f]) : req.body[f]); idx++;
    }
  }
  if (req.body.status === 'confirmed') { updates.push('paid_at = COALESCE(paid_at, NOW())'); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()'); values.push(txId, cid);
  try {
    var result = await db.query(
      'UPDATE transactions SET ' + updates.join(', ') + ' WHERE id = $' + idx + ' AND company_id = $' + (idx + 1) + ' RETURNING *', values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Lancamento nao encontrado' });
    res.json(result.rows[0]);
  } catch (err) { console.error('[transactions] update:', err.message); res.status(500).json({ error: 'Erro ao atualizar lancamento' }); }
});

router.delete('/:txId', async function(req, res) {
  var cid = req.params.id;
  var txId = req.params.txId;
  try {
    var result = await db.query('DELETE FROM transactions WHERE id = $1 AND company_id = $2 RETURNING id', [txId, cid]);
    if (!result.rows.length) return res.status(404).json({ error: 'Lancamento nao encontrado' });
    res.json({ deleted: true, id: txId });
  } catch (err) { console.error('[transactions] delete:', err.message); res.status(500).json({ error: 'Erro ao deletar lancamento' }); }
});

module.exports = router;
