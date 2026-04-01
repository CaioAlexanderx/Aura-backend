// ============================================================
// AURA. — BE-REV-06: Generic Appointments
// Reusable scheduling for ANY vertical (salon, dental, pet, etc)
// GET  /companies/:id/appointments
// POST /companies/:id/appointments
// PATCH /companies/:id/appointments/:aid
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');

// GET /companies/:id/appointments?start=&end=&professional_id=
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const now = new Date();
  const start = req.query.start || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end   = req.query.end   || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();
  const { professional_id, status } = req.query;

  try {
    const params = [cid, start, end];
    let filters = '';
    if (professional_id) { params.push(professional_id); filters += ` AND a.professional_id=$${params.length}`; }
    if (status) { params.push(status); filters += ` AND a.status=$${params.length}`; }

    // Try barbershop_appointments first (existing table)
    // If it doesn't exist, fallback gracefully
    const { rows } = await db.query(`
      SELECT a.id, a.professional_id, a.customer_id, a.customer_name, a.customer_phone,
             a.scheduled_at, a.duration_min, a.total_amount, a.status, a.notes,
             a.created_at,
             p.name AS professional_name, p.color AS professional_color,
             COALESCE(c.name, a.customer_name) AS client_name
      FROM barbershop_appointments a
      LEFT JOIN barbershop_professionals p ON p.id = a.professional_id
      LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.company_id = $1
        AND a.scheduled_at >= $2
        AND a.scheduled_at < $3
        ${filters}
      ORDER BY a.scheduled_at ASC
    `, params);

    // KPIs for the period
    const total = rows.length;
    const confirmed = rows.filter(r => r.status === 'confirmado' || r.status === 'concluido').length;
    const pending = rows.filter(r => r.status === 'pendente' || r.status === 'agendado').length;
    const revenue = rows.reduce((s, r) => s + (parseFloat(r.total_amount) || 0), 0);

    res.json({
      start, end, total,
      kpis: { total, confirmed, pending, revenue },
      appointments: rows.map(r => ({
        ...r,
        total_amount: parseFloat(r.total_amount) || 0,
      })),
    });
  } catch (err) {
    // If barbershop tables don't exist, return empty
    if (err.message?.includes('does not exist')) {
      return res.json({ start, end, total: 0, kpis: { total: 0, confirmed: 0, pending: 0, revenue: 0 }, appointments: [] });
    }
    console.error('appointments list error:', err);
    res.status(500).json({ error: 'Erro ao buscar agendamentos' });
  }
});

// POST /companies/:id/appointments
router.post('/', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const {
    professional_id, customer_id, customer_name, customer_phone,
    scheduled_at, duration_min = 30, total_amount = 0, notes,
  } = req.body;

  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at \u00e9 obrigat\u00f3rio' });
  if (!customer_name && !customer_id) return res.status(400).json({ error: 'Informe customer_name ou customer_id' });

  try {
    const { rows } = await db.query(`
      INSERT INTO barbershop_appointments
        (company_id, professional_id, customer_id, customer_name, customer_phone,
         scheduled_at, duration_min, total_amount, notes, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'agendado')
      RETURNING *
    `, [
      cid, professional_id || null, customer_id || null,
      customer_name || null, customer_phone || null,
      scheduled_at, duration_min, total_amount, notes || null,
    ]);

    res.status(201).json({ appointment: rows[0] });
  } catch (err) {
    console.error('create appointment error:', err);
    res.status(500).json({ error: 'Erro ao criar agendamento' });
  }
});

// PATCH /companies/:id/appointments/:aid
router.patch('/:aid', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { status, notes, cancel_reason, scheduled_at, duration_min } = req.body;
  const fields = [], values = [];
  let idx = 1;

  if (status)       { fields.push(`status=$${idx++}`); values.push(status); }
  if (notes)        { fields.push(`notes=$${idx++}`); values.push(notes); }
  if (cancel_reason) { fields.push(`cancel_reason=$${idx++}`); values.push(cancel_reason); }
  if (scheduled_at) { fields.push(`scheduled_at=$${idx++}`); values.push(scheduled_at); }
  if (duration_min) { fields.push(`duration_min=$${idx++}`); values.push(duration_min); }

  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  // Timestamp fields based on status
  if (status === 'confirmado') fields.push('confirmed_at=NOW()');
  if (status === 'concluido') fields.push('concluded_at=NOW()');
  if (status === 'cancelado') fields.push('cancelled_at=NOW()');
  fields.push('updated_at=NOW()');

  values.push(req.params.aid, req.params.id);

  try {
    const { rows } = await db.query(
      `UPDATE barbershop_appointments SET ${fields.join(',')}
       WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Agendamento n\u00e3o encontrado' });
    res.json({ appointment: rows[0] });
  } catch (err) {
    console.error('update appointment error:', err);
    res.status(500).json({ error: 'Erro ao atualizar agendamento' });
  }
});

// DELETE /companies/:id/appointments/:aid
router.delete('/:aid', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE barbershop_appointments SET status='cancelado', cancelled_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND company_id=$2 RETURNING id, status`,
      [req.params.aid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agendamento n\u00e3o encontrado' });
    res.json({ cancelled: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao cancelar agendamento' });
  }
});

module.exports = router;
