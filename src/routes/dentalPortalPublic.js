// ============================================================
// AURA. — ODT-08b: Portal do Paciente (rotas PÚBLICAS)
// GET  /dental-portal/:token — dados completos do paciente
// POST /dental-portal/:token/confirm/:aid — confirmar consulta
// ============================================================
const router = require('express').Router();
const db = require('../config/database');

async function resolveToken(token) {
  const { rows } = await db.query(
    `SELECT t.company_id, t.patient_id, t.expires_at,
            p.full_name, p.phone, p.email,
            c.trade_name, c.legal_name
     FROM dental_portal_tokens t
     JOIN dental_patients p ON p.id = t.patient_id
     JOIN companies c ON c.id = t.company_id
     WHERE t.token = $1`, [token]);
  if (!rows.length) return null;
  if (new Date(rows[0].expires_at) < new Date()) return null;
  return rows[0];
}

// GET /dental-portal/:token — public patient data
router.get('/:token', async (req, res) => {
  try {
    const data = await resolveToken(req.params.token);
    if (!data) return res.status(410).json({ error: 'Link expirado ou invalido. Solicite um novo link ao seu dentista.' });

    const cid = data.company_id;
    const pid = data.patient_id;

    // Próximas consultas
    const { rows: appointments } = await db.query(
      `SELECT id, scheduled_at, duration_min, status, chief_complaint
       FROM dental_appointments
       WHERE company_id=$1 AND patient_id=$2 AND scheduled_at >= NOW() - INTERVAL '1 day'
       ORDER BY scheduled_at ASC LIMIT 10`, [cid, pid]);

    // Planos de tratamento ativos
    const { rows: plans } = await db.query(
      `SELECT id, title, total_amount, status, created_at,
              (SELECT COUNT(*) FROM dental_treatment_plan_items WHERE treatment_plan_id=tp.id AND status='completed') AS done_count,
              (SELECT COUNT(*) FROM dental_treatment_plan_items WHERE treatment_plan_id=tp.id) AS total_count
       FROM dental_treatment_plans tp
       WHERE company_id=$1 AND patient_id=$2 AND status NOT IN ('cancelled')
       ORDER BY created_at DESC LIMIT 5`, [cid, pid]);

    // Parcelas abertas
    let payments = [];
    try {
      const { rows: pays } = await db.query(
        `SELECT tp.id, tp.amount, tp.due_date, tp.status
         FROM dental_treatment_payments tp
         JOIN dental_treatment_plans t ON t.id = tp.treatment_plan_id
         WHERE t.company_id=$1 AND t.patient_id=$2 AND tp.status='pending'
         ORDER BY tp.due_date ASC`, [cid, pid]);
      payments = pays;
    } catch (_) {}

    // Documentos (receituários/atestados)
    const { rows: docs } = await db.query(
      `SELECT id, doc_type, content, issued_at
       FROM dental_prescriptions
       WHERE company_id=$1 AND patient_id=$2
       ORDER BY issued_at DESC LIMIT 10`, [cid, pid]);

    res.json({
      patient: { name: data.full_name, phone: data.phone, email: data.email },
      clinic: { name: data.trade_name || data.legal_name },
      appointments: appointments.map(a => ({
        id: a.id, date: a.scheduled_at, duration: a.duration_min,
        status: a.status, complaint: a.chief_complaint,
      })),
      treatment_plans: plans.map(p => ({
        id: p.id, title: p.title, total: parseFloat(p.total_amount),
        status: p.status, done: parseInt(p.done_count), total_items: parseInt(p.total_count),
      })),
      payments: payments.map(p => ({
        id: p.id, amount: parseFloat(p.amount), due_date: p.due_date, status: p.status,
      })),
      documents: docs,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao carregar portal' }); }
});

// POST /dental-portal/:token/confirm/:aid — confirm appointment
router.post('/:token/confirm/:aid', async (req, res) => {
  try {
    const data = await resolveToken(req.params.token);
    if (!data) return res.status(410).json({ error: 'Link expirado' });

    const { rows } = await db.query(
      `UPDATE dental_appointments SET status='confirmed', updated_at=NOW()
       WHERE id=$1 AND company_id=$2 AND patient_id=$3 AND status IN ('scheduled','pending')
       RETURNING id, scheduled_at, status`,
      [req.params.aid, data.company_id, data.patient_id]);

    if (!rows.length) return res.status(404).json({ error: 'Consulta nao encontrada ou ja confirmada' });

    // Log the confirmation
    await db.query(
      `INSERT INTO dental_automation_log (company_id, patient_id, appointment_id, type, channel, status, response)
       VALUES ($1,$2,$3,'confirm_24h','portal','responded','confirmed_by_patient')`,
      [data.company_id, data.patient_id, req.params.aid]).catch(() => {});

    res.json({ confirmed: true, appointment: rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao confirmar' }); }
});

module.exports = router;
