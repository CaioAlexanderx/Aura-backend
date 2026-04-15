// ============================================================
// AURA. — Support Tickets (client-facing)
// ============================================================
var router = require('express').Router({ mergeParams: true });
var db = require('../config/database');
var { requireAuth } = require('../middleware/auth');

// GET /support/tickets — list own tickets
router.get('/tickets', requireAuth, async function(req, res) {
  var cid = req.params.id;
  var uid = req.user.id;
  var { status } = req.query;
  try {
    var where = 'company_id=$1';
    var params = [cid];
    if (status) { where += ' AND status=$2'; params.push(status); }
    var { rows } = await db.query(
      'SELECT t.*, (SELECT COUNT(*)::int FROM support_messages m WHERE m.ticket_id=t.id AND m.sender_role=\'admin\' AND m.created_at > t.updated_at) AS new_replies,' +
      ' (SELECT m.message FROM support_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,' +
      ' (SELECT m.sender_role FROM support_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender' +
      ' FROM support_tickets t WHERE ' + where + ' ORDER BY t.updated_at DESC LIMIT 50', params);
    res.json({ tickets: rows });
  } catch (err) { console.error('support list error:', err); res.status(500).json({ error: 'Erro' }); }
});

// POST /support/tickets — create ticket
router.post('/tickets', requireAuth, async function(req, res) {
  var cid = req.params.id;
  var uid = req.user.id;
  var { subject, message, category, priority, metadata } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'subject e message obrigatorios' });
  try {
    var { rows } = await db.query(
      'INSERT INTO support_tickets (company_id, user_id, subject, category, priority, metadata) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [cid, uid, subject, category || 'suporte', priority || 'normal', JSON.stringify(metadata || {})]);
    var ticket = rows[0];
    await db.query(
      'INSERT INTO support_messages (ticket_id, sender_id, sender_role, message) VALUES ($1,$2,$3,$4)',
      [ticket.id, uid, 'client', message]);
    res.status(201).json({ ticket });
  } catch (err) { console.error('support create error:', err); res.status(500).json({ error: 'Erro' }); }
});

// GET /support/tickets/:tid — get ticket with messages
router.get('/tickets/:tid', requireAuth, async function(req, res) {
  var cid = req.params.id;
  var tid = req.params.tid;
  try {
    var { rows: tickets } = await db.query('SELECT * FROM support_tickets WHERE id=$1 AND company_id=$2', [tid, cid]);
    if (!tickets.length) return res.status(404).json({ error: 'Ticket nao encontrado' });
    var { rows: messages } = await db.query(
      'SELECT m.*, u.full_name AS sender_name, u.email AS sender_email FROM support_messages m JOIN users u ON u.id=m.sender_id WHERE m.ticket_id=$1 ORDER BY m.created_at ASC', [tid]);
    res.json({ ticket: tickets[0], messages });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// POST /support/tickets/:tid/messages — send message
router.post('/tickets/:tid/messages', requireAuth, async function(req, res) {
  var cid = req.params.id;
  var tid = req.params.tid;
  var uid = req.user.id;
  var { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message obrigatoria' });
  try {
    var { rows: tickets } = await db.query('SELECT id, status FROM support_tickets WHERE id=$1 AND company_id=$2', [tid, cid]);
    if (!tickets.length) return res.status(404).json({ error: 'Ticket nao encontrado' });
    var { rows } = await db.query(
      'INSERT INTO support_messages (ticket_id, sender_id, sender_role, message) VALUES ($1,$2,$3,$4) RETURNING *',
      [tid, uid, 'client', message]);
    await db.query('UPDATE support_tickets SET updated_at=NOW(), status=CASE WHEN status=\'respondido\' THEN \'aberto\' ELSE status END WHERE id=$1', [tid]);
    res.status(201).json({ message: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

module.exports = router;
