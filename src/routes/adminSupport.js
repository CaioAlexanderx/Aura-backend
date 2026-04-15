// ============================================================
// AURA. — Admin Support Tickets (admin-facing)
// ============================================================
var router = require('express').Router();
var db = require('../config/database');
var { requireAuth, requireRole } = require('../middleware/auth');
var asyncHandler = require('../utils/asyncHandler');
var adminOnly = [requireAuth, requireRole('admin')];

// GET /admin/tickets — list all tickets across companies
router.get('/tickets', ...adminOnly, asyncHandler(async function(req, res) {
  var { status, category, limit = 50 } = req.query;
  var where = '1=1';
  var params = [];
  if (status) { params.push(status); where += ' AND t.status=$' + params.length; }
  if (category) { params.push(category); where += ' AND t.category=$' + params.length; }
  params.push(Math.min(parseInt(limit) || 50, 200));
  var { rows } = await db.query(
    'SELECT t.*, c.trade_name AS company_name, c.plan AS company_plan, u.full_name AS user_name, u.email AS user_email,' +
    ' (SELECT COUNT(*)::int FROM support_messages m WHERE m.ticket_id=t.id) AS message_count,' +
    ' (SELECT m.message FROM support_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,' +
    ' (SELECT m.sender_role FROM support_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender,' +
    ' au.full_name AS assigned_name' +
    ' FROM support_tickets t' +
    ' JOIN companies c ON c.id=t.company_id' +
    ' JOIN users u ON u.id=t.user_id' +
    ' LEFT JOIN users au ON au.id=t.assigned_to' +
    ' WHERE ' + where +
    ' ORDER BY CASE t.status WHEN \'aberto\' THEN 0 WHEN \'em_andamento\' THEN 1 WHEN \'respondido\' THEN 2 ELSE 3 END, t.updated_at DESC' +
    ' LIMIT $' + params.length, params);

  var { rows: stats } = await db.query(
    'SELECT status, COUNT(*)::int AS count FROM support_tickets GROUP BY status');
  var summary = { aberto: 0, em_andamento: 0, respondido: 0, fechado: 0 };
  stats.forEach(function(s) { summary[s.status] = s.count; });

  // Domain requests pending
  var { rows: domainReqs } = await db.query(
    "SELECT COUNT(*)::int AS pending FROM support_tickets WHERE category='dominio' AND status IN ('aberto','em_andamento')");

  res.json({ tickets: rows, summary: summary, domain_requests_pending: domainReqs[0]?.pending || 0 });
}));

// GET /admin/tickets/:tid — get ticket with full conversation
router.get('/tickets/:tid', ...adminOnly, asyncHandler(async function(req, res) {
  var tid = req.params.tid;
  var { rows: tickets } = await db.query(
    'SELECT t.*, c.trade_name AS company_name, c.plan AS company_plan, c.id AS company_id, u.full_name AS user_name, u.email AS user_email, u.phone AS user_phone' +
    ' FROM support_tickets t JOIN companies c ON c.id=t.company_id JOIN users u ON u.id=t.user_id WHERE t.id=$1', [tid]);
  if (!tickets.length) return res.status(404).json({ error: 'Ticket nao encontrado' });
  var { rows: messages } = await db.query(
    'SELECT m.*, u.full_name AS sender_name, u.email AS sender_email FROM support_messages m JOIN users u ON u.id=m.sender_id WHERE m.ticket_id=$1 ORDER BY m.created_at ASC', [tid]);
  res.json({ ticket: tickets[0], messages: messages });
}));

// POST /admin/tickets/:tid/messages — admin reply
router.post('/tickets/:tid/messages', ...adminOnly, asyncHandler(async function(req, res) {
  var tid = req.params.tid;
  var uid = req.user.id;
  var { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message obrigatoria' });
  var { rows } = await db.query(
    'INSERT INTO support_messages (ticket_id, sender_id, sender_role, message) VALUES ($1,$2,$3,$4) RETURNING *',
    [tid, uid, 'admin', message]);
  await db.query('UPDATE support_tickets SET updated_at=NOW(), status=\'respondido\' WHERE id=$1', [tid]);
  res.status(201).json({ message: rows[0] });
}));

// PATCH /admin/tickets/:tid — update status/priority/assignment
router.patch('/tickets/:tid', ...adminOnly, asyncHandler(async function(req, res) {
  var tid = req.params.tid;
  var { status, priority, assigned_to } = req.body;
  var fields = [], values = [], idx = 1;
  if (status) { fields.push('status=$' + idx++); values.push(status); if (status === 'fechado') { fields.push('closed_at=NOW()'); } }
  if (priority) { fields.push('priority=$' + idx++); values.push(priority); }
  if (assigned_to !== undefined) { fields.push('assigned_to=$' + idx++); values.push(assigned_to); }
  fields.push('updated_at=NOW()');
  if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar' });
  values.push(tid);
  var { rows } = await db.query('UPDATE support_tickets SET ' + fields.join(', ') + ' WHERE id=$' + idx + ' RETURNING *', values);
  if (!rows.length) return res.status(404).json({ error: 'Ticket nao encontrado' });
  res.json({ ticket: rows[0] });
}));

module.exports = router;
