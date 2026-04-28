// ============================================================
// AURA. — Transactions CRUD + Recorrencia
//
// FONTE DE RECEITA/DESPESA (revisao 27/04 — fix despesas pendentes):
//   summary.income   = SUM(transactions WHERE type=income  AND status=confirmed) no periodo
//   summary.expenses = SUM(transactions WHERE type=expense AND status=confirmed) no periodo
//   summary.pending_* exposto separadamente (parcelas futuras de recorrentes
//   nao devem inflar o periodo atual — bug 27/04 detectado no fechamento da
//   Finesse, R$29.282 de Simples Nacional pending entrando no mes).
//   Alinhado com dashboard.js que sempre filtrou status='confirmed'.
//
// FIX DESPESAS 27/04: filtro de data padronizado para
// (created_at AT TIME ZONE 'America/Sao_Paulo')::date em todas as
// queries (listing + summary). Antes usava COALESCE(due_date, created_at::date)
// o que fazia despesas com due_date em outro mes desaparecerem do Financeiro
// mesmo aparecendo no Dashboard (que sempre usou created_at SP).
// ============================================================
var router = require('express').Router({ mergeParams: true });
var db = require('../config/database');
var crypto = require('crypto');

function todayBR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function advanceDate(dateStr, type, steps) {
  var d = new Date(dateStr + 'T12:00:00');
  if (type === 'weekly') d.setDate(d.getDate() + (7 * steps));
  else if (type === 'monthly') d.setMonth(d.getMonth() + steps);
  else if (type === 'yearly') d.setFullYear(d.getFullYear() + steps);
  return d.toISOString().split('T')[0];
}

function extractSaleId(idempotencyKey) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') return null;
  var m = idempotencyKey.match(/^pdv-sale-([0-9a-f-]+)$/i);
  return m ? m[1] : null;
}

var VALID_PAYMENTS = ['pix', 'cash', 'credit', 'debit', 'voucher', 'transfer', 'boleto'];
var RECURRENCE_DEFAULTS = { weekly: 4, monthly: 12, yearly: 3 };
var RECURRENCE_MAX = { weekly: 52, monthly: 24, yearly: 10 };
var RECURRENCE_LABELS = { weekly: 'semanal', monthly: 'mensal', yearly: 'anual' };

// Helper: clausula de data por created_at em fuso SP (consistente com Dashboard)
function dateClauseSP(op, paramIdx) {
  return "(created_at AT TIME ZONE 'America/Sao_Paulo')::date " + op + ' $' + paramIdx;
}

router.get('/', async function(req, res) {
  var cid = req.params.id;
  var limit = Math.min(parseInt(req.query.limit) || 200, 10000);
  var offset = parseInt(req.query.offset) || 0;
  var type = req.query.type;
  var start = req.query.start;
  var end = req.query.end;
  try {
    // --- Listagem ---
    // Filtro de data: created_at em fuso SP (igual ao Dashboard).
    var where = 'WHERE company_id = $1';
    var params = [cid];
    if (type === 'income' || type === 'expense') { params.push(type); where += ' AND type = $' + params.length; }
    if (start) { params.push(start); where += ' AND ' + dateClauseSP('>=', params.length); }
    if (end)   { params.push(end);   where += ' AND ' + dateClauseSP('<=', params.length); }
    var countRes = await db.query('SELECT COUNT(*) AS total FROM transactions ' + where, params);
    var dataParams = params.concat([limit, offset]);
    var dataRes = await db.query(
      'SELECT id, type, amount, description, category, status, notes, due_date, paid_at, created_at,' +
      '       recurrence_type, recurrence_group_id, recurrence_index,' +
      '       payment_method, employee_id, employee_name, idempotency_key' +
      ' FROM transactions ' + where +
      " ORDER BY COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC, created_at DESC" +
      ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2), dataParams
    );

    // --- Summary: income/expenses CONFIRMED + pending_* separado ---
    // status='confirmed' alinha com dashboard.js (cash flow real do periodo).
    // Pending exposto a parte para o frontend mostrar como badge informativo
    // sem inflar o saldo (ex: parcelas futuras de recorrentes mensais).
    var defaultW = !start && !end
      ? " AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))"
      : '';

    var sumP = [cid];
    var sumW = 'WHERE company_id = $1';
    if (start) { sumP.push(start); sumW += " AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= $" + sumP.length; }
    if (end)   { sumP.push(end);   sumW += " AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date <= $" + sumP.length; }
    sumW += defaultW;

    var sumRes = await db.query(
      'SELECT' +
      "  COALESCE(SUM(amount) FILTER (WHERE type = 'income'  AND status = 'confirmed'), 0) AS income," +
      "  COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND status = 'confirmed'), 0) AS expenses," +
      "  COALESCE(SUM(amount) FILTER (WHERE type = 'income'  AND status = 'pending'),   0) AS pending_income," +
      "  COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND status = 'pending'),   0) AS pending_expenses" +
      ' FROM transactions ' + sumW,
      sumP
    );

    var income           = parseFloat(sumRes.rows[0]?.income)           || 0;
    var expenses         = parseFloat(sumRes.rows[0]?.expenses)         || 0;
    var pendingIncome    = parseFloat(sumRes.rows[0]?.pending_income)   || 0;
    var pendingExpenses  = parseFloat(sumRes.rows[0]?.pending_expenses) || 0;

    var transactions = dataRes.rows.map(function(r) {
      return {
        id: r.id, type: r.type, amount: parseFloat(r.amount) || 0,
        desc: r.description || '', description: r.description || '',
        category: r.category || 'Outros', status: r.status || 'confirmed',
        notes: r.notes || '',
        date: r.due_date
          ? new Date(r.due_date + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
          : (r.created_at ? new Date(r.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' }) : '--/--'),
        due_date: r.due_date, paid_at: r.paid_at, created_at: r.created_at,
        recurrence_type: r.recurrence_type || null,
        recurrence_label: r.recurrence_type ? RECURRENCE_LABELS[r.recurrence_type] : null,
        recurrence_group_id: r.recurrence_group_id || null,
        recurrence_index: r.recurrence_index || 0,
        payment_method: r.payment_method || null,
        employee_id: r.employee_id || null,
        employee_name: r.employee_name || null,
        idempotency_key: r.idempotency_key || null,
        source: r.idempotency_key && /^pdv-sale-/i.test(r.idempotency_key) ? 'pdv' : 'manual',
      };
    });

    res.json({
      transactions: transactions,
      total: parseInt(countRes.rows[0]?.total) || 0,
      limit: limit, offset: offset,
      summary: {
        income:           income,           // transactions income confirmed no periodo
        expenses:         expenses,         // transactions expense confirmed no periodo
        pending_income:   pendingIncome,    // income pending (nao soma no saldo do periodo)
        pending_expenses: pendingExpenses,  // expense pending (parcelas futuras de recorrentes)
      },
    });
  } catch (err) { console.error('[transactions] list:', err.message); res.status(500).json({ error: 'Erro ao listar lancamentos' }); }
});

router.post('/', async function(req, res) {
  var cid = req.params.id;
  var body = req.body;
  if (!body.type || (body.type !== 'income' && body.type !== 'expense')) return res.status(400).json({ error: 'type deve ser income ou expense' });
  if (!body.amount || parseFloat(body.amount) <= 0) return res.status(400).json({ error: 'amount deve ser maior que zero' });
  if (!body.description || !String(body.description).trim()) return res.status(400).json({ error: 'description e obrigatoria' });
  var finalStatus = (body.status === 'pending') ? 'pending' : 'confirmed';
  var dueDate = body.due_date || todayBR();
  var recurrenceType = body.recurrence_type || null;
  var recurrenceCount = parseInt(body.recurrence_count) || 0;
  if (recurrenceType && !RECURRENCE_DEFAULTS[recurrenceType]) return res.status(400).json({ error: 'recurrence_type deve ser weekly, monthly ou yearly' });
  if (recurrenceType) {
    if (recurrenceCount <= 0) recurrenceCount = RECURRENCE_DEFAULTS[recurrenceType];
    recurrenceCount = Math.min(recurrenceCount, RECURRENCE_MAX[recurrenceType]);
  }
  var paymentMethod = body.payment_method || null;
  if (paymentMethod && VALID_PAYMENTS.indexOf(paymentMethod) === -1) return res.status(400).json({ error: 'payment_method invalido (aceitos: ' + VALID_PAYMENTS.join(', ') + ')' });
  var employeeId = body.employee_id || null;
  var employeeName = body.employee_name || null;
  if (employeeId) {
    try {
      var empRes = await db.query('SELECT id, name FROM employees WHERE id = $1 AND company_id = $2', [employeeId, cid]);
      if (!empRes.rows.length) return res.status(404).json({ error: 'Funcionario nao encontrado' });
      employeeName = empRes.rows[0].name;
    } catch (err) { console.error('[transactions] validate employee:', err.message); }
  }
  try {
    if (!recurrenceType) {
      var paidAt = finalStatus === 'confirmed' ? 'NOW()' : 'NULL';
      var result = await db.query(
        'INSERT INTO transactions (company_id, type, amount, description, category, notes, due_date, status, paid_at, created_by, payment_method, employee_id, employee_name)' +
        ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ' + paidAt + ', $9, $10, $11, $12)' +
        ' RETURNING id, type, amount, description, category, status, due_date, paid_at, created_at, payment_method, employee_id, employee_name',
        [cid, body.type, parseFloat(body.amount), String(body.description).trim(), body.category || 'Outros',
         body.notes || null, dueDate, finalStatus, req.user?.id || null, paymentMethod, employeeId, employeeName]
      );
      var tx = result.rows[0];
      return res.status(201).json({ id: tx.id, type: tx.type, amount: parseFloat(tx.amount), description: tx.description, category: tx.category, status: tx.status, due_date: tx.due_date, paid_at: tx.paid_at, created_at: tx.created_at, payment_method: tx.payment_method, employee_id: tx.employee_id, employee_name: tx.employee_name });
    }
    var groupId = crypto.randomUUID();
    var amount = parseFloat(body.amount); var description = String(body.description).trim();
    var category = body.category || 'Outros'; var notes = body.notes || null; var userId = req.user?.id || null;
    var created = [];
    for (var i = 0; i < recurrenceCount; i++) {
      var itemDueDate = advanceDate(dueDate, recurrenceType, i);
      var itemStatus = i === 0 ? finalStatus : 'pending';
      var itemPaidAt = itemStatus === 'confirmed' ? 'NOW()' : 'NULL';
      var r = await db.query(
        'INSERT INTO transactions (company_id, type, amount, description, category, notes, due_date, status, paid_at, created_by, recurrence_type, recurrence_group_id, recurrence_index, payment_method, employee_id, employee_name)' +
        ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ' + itemPaidAt + ', $9, $10, $11, $12, $13, $14, $15)' +
        ' RETURNING id, type, amount, description, category, status, due_date, recurrence_index',
        [cid, body.type, amount, description, category, notes, itemDueDate, itemStatus, userId, recurrenceType, groupId, i, paymentMethod, employeeId, employeeName]
      );
      created.push(r.rows[0]);
    }
    res.status(201).json({
      recurrence: { type: recurrenceType, label: RECURRENCE_LABELS[recurrenceType], group_id: groupId, count: created.length, first_date: created[0]?.due_date, last_date: created[created.length - 1]?.due_date },
      transactions: created.map(function(tx) { return { id: tx.id, type: tx.type, amount: parseFloat(tx.amount), description: tx.description, category: tx.category, status: tx.status, due_date: tx.due_date, recurrence_index: tx.recurrence_index }; }),
    });
  } catch (err) { console.error('[transactions] create:', err.message); res.status(500).json({ error: 'Erro ao criar lancamento' }); }
});

router.patch('/:txId', async function(req, res) {
  var cid = req.params.id; var txId = req.params.txId;
  var fields = ['type', 'amount', 'description', 'category', 'status', 'notes', 'due_date', 'payment_method', 'employee_id', 'employee_name'];
  var updates = [], values = []; var idx = 1;
  if (req.body.payment_method !== undefined && req.body.payment_method !== null) {
    if (VALID_PAYMENTS.indexOf(req.body.payment_method) === -1) return res.status(400).json({ error: 'payment_method invalido (aceitos: ' + VALID_PAYMENTS.join(', ') + ')' });
  }
  if (req.body.employee_id !== undefined && req.body.employee_id !== null) {
    try {
      var empRes = await db.query('SELECT id, name FROM employees WHERE id = $1 AND company_id = $2', [req.body.employee_id, cid]);
      if (!empRes.rows.length) return res.status(404).json({ error: 'Funcionario nao encontrado' });
      req.body.employee_name = empRes.rows[0].name;
    } catch (err) { console.error('[transactions] validate employee:', err.message); }
  } else if (req.body.employee_id === null) { req.body.employee_name = null; }
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (req.body[f] !== undefined) { updates.push(f + ' = $' + idx); values.push(f === 'amount' ? parseFloat(req.body[f]) : req.body[f]); idx++; }
  }
  if (req.body.status === 'confirmed') { updates.push('paid_at = COALESCE(paid_at, NOW())'); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()'); values.push(txId, cid);
  try {
    var result = await db.query('UPDATE transactions SET ' + updates.join(', ') + ' WHERE id = $' + idx + ' AND company_id = $' + (idx + 1) + ' RETURNING *', values);
    if (!result.rows.length) return res.status(404).json({ error: 'Lancamento nao encontrado' });
    var updated = result.rows[0];
    var saleId = extractSaleId(updated.idempotency_key);
    if (saleId) {
      var saleUpdates = [], saleValues = []; var saleIdx = 1;
      if (req.body.payment_method !== undefined) { saleUpdates.push('payment_method = $' + (saleIdx++)); saleValues.push(req.body.payment_method); }
      if (req.body.employee_id !== undefined) {
        saleUpdates.push('seller_id = $' + (saleIdx++)); saleValues.push(req.body.employee_id);
        saleUpdates.push('employee_id = $' + (saleIdx++)); saleValues.push(req.body.employee_id);
        saleUpdates.push('seller_name = $' + (saleIdx++)); saleValues.push(req.body.employee_name);
      }
      if (saleUpdates.length > 0) {
        saleUpdates.push('updated_at = NOW()'); saleValues.push(saleId, cid);
        await db.query('UPDATE sales SET ' + saleUpdates.join(', ') + ' WHERE id = $' + saleIdx + ' AND company_id = $' + (saleIdx + 1), saleValues).catch(function(err) { console.error('[transactions] sync sale:', err.message); });
      }
    }
    res.json(updated);
  } catch (err) { console.error('[transactions] update:', err.message); res.status(500).json({ error: 'Erro ao atualizar lancamento' }); }
});

router.delete('/:txId', async function(req, res) {
  var cid = req.params.id; var txId = req.params.txId;
  try {
    await db.query('UPDATE bank_statement_entries SET matched_transaction_id = NULL WHERE matched_transaction_id = $1', [txId]).catch(function() {});
    await db.query('UPDATE nfce_emissions SET transaction_id = NULL WHERE transaction_id = $1', [txId]).catch(function() {});
    var result = await db.query('DELETE FROM transactions WHERE id = $1 AND company_id = $2 RETURNING id, recurrence_group_id', [txId, cid]);
    if (!result.rows.length) return res.status(404).json({ error: 'Lancamento nao encontrado' });
    res.json({ deleted: true, id: txId, recurrence_group_id: result.rows[0].recurrence_group_id || null });
  } catch (err) {
    console.error('[transactions] delete:', err.message, err.code);
    if (err.code === '23503') return res.status(409).json({ error: 'Este lancamento esta vinculado a outros registros e nao pode ser excluido.', code: 'FK_VIOLATION' });
    res.status(500).json({ error: 'Erro ao deletar lancamento' });
  }
});

router.delete('/group/:groupId', async function(req, res) {
  var cid = req.params.id; var groupId = req.params.groupId;
  try {
    await db.query("UPDATE bank_statement_entries SET matched_transaction_id = NULL WHERE matched_transaction_id IN (SELECT id FROM transactions WHERE recurrence_group_id = $1 AND company_id = $2 AND status = 'pending')", [groupId, cid]).catch(function() {});
    var result = await db.query("DELETE FROM transactions WHERE recurrence_group_id = $1 AND company_id = $2 AND status = 'pending' RETURNING id", [groupId, cid]);
    res.json({ deleted: true, group_id: groupId, count: result.rows.length });
  } catch (err) { console.error('[transactions] delete group:', err.message); res.status(500).json({ error: 'Erro ao deletar grupo recorrente' }); }
});

module.exports = router;
