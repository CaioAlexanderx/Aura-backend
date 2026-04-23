// ============================================================
// AURA. — ODT-08b: Portal do Paciente (PUBLICO, sem login)
// D-UNIFY: join com customers via customer_id; tudo filtra por customer_id.
// ============================================================
const router = require('express').Router();
const db = require('../config/database');

async function resolveToken(token) {
  const { rows } = await db.query(
    `SELECT t.company_id,
            t.customer_id,
            t.customer_id AS patient_id,
            t.expires_at,
            c.name  AS full_name,
            c.phone, c.email,
            co.trade_name, co.legal_name
     FROM dental_portal_tokens t
     JOIN customers c  ON c.id = t.customer_id
     JOIN companies co ON co.id = t.company_id
     WHERE t.token = $1`,
    [token]
  );
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
    const customerId = data.customer_id;

    // Proximas consultas
    const { rows: appointments } = await db.query(
      `SELECT id, scheduled_at, duration_min, status, chief_complaint
       FROM dental_appointments
       WHERE company_id=$1 AND customer_id=$2 AND scheduled_at >= NOW() - INTERVAL '1 day'
       ORDER BY scheduled_at ASC LIMIT 10`,
      [cid, customerId]
    );

    // Planos de tratamento ativos
    const { rows: plans } = await db.query(
      `SELECT id, plan_number, total, status, created_at,
              (SELECT COUNT(*) FROM dental_treatment_plan_items WHERE plan_id=tp.id AND status='concluido') AS done_count,
              (SELECT COUNT(*) FROM dental_treatment_plan_items WHERE plan_id=tp.id) AS total_count
       FROM dental_treatment_plans tp
       WHERE company_id=$1 AND customer_id=$2 AND status NOT IN ('cancelado')
       ORDER BY created_at DESC LIMIT 5`,
      [cid, customerId]
    );

    // Parcelas abertas
    let payments = [];
    try {
      const { rows: pays } = await db.query(
        `SELECT tp.id, tp.amount, tp.due_date, tp.status
         FROM dental_treatment_payments tp
         JOIN dental_treatment_plans t ON t.id = tp.treatment_plan_id
         WHERE t.company_id=$1 AND t.customer_id=$2 AND tp.status='pending'
         ORDER BY tp.due_date ASC`,
        [cid, customerId]
      );
      payments = pays;
    } catch (_) {}

    // Documentos
    const { rows: docs } = await db.query(
      `SELECT id, doc_type, content, issued_at
       FROM dental_prescriptions
       WHERE company_id=$1 AND customer_id=$2
       ORDER BY issued_at DESC LIMIT 10`,
      [cid, customerId]
    );

    res.json({
      patient: { name: data.full_name, phone: data.phone, email: data.email },
      clinic:  { name: data.trade_name || data.legal_name },
      appointments: appointments.map(a => ({
        id: a.id, date: a.scheduled_at, duration: a.duration_min,
        status: a.status, complaint: a.chief_complaint,
      })),
      treatment_plans: plans.map(p => ({
        id: p.id, title: p.plan_number, total: parseFloat(p.total),
        status: p.status, done: parseInt(p.done_count), total_items: parseInt(p.total_count),
      })),
      payments: payments.map(p => ({
        id: p.id, amount: parseFloat(p.amount), due_date: p.due_date, status: p.status,
      })),
      documents: docs,
    });
  } catch (err) {
    console.error('[dentalPortalPublic GET]', err.message);
    res.status(500).json({ error: 'Erro ao carregar portal' });
  }
});

// POST /dental-portal/:token/confirm/:aid — confirm appointment
router.post('/:token/confirm/:aid', async (req, res) => {
  try {
    const data = await resolveToken(req.params.token);
    if (!data) return res.status(410).json({ error: 'Link expirado' });

    const { rows } = await db.query(
      `UPDATE dental_appointments
       SET status='confirmado', updated_at=NOW()
       WHERE id=$1 AND company_id=$2 AND customer_id=$3
         AND status IN ('agendado','confirmado')
       RETURNING id, scheduled_at, status`,
      [req.params.aid, data.company_id, data.customer_id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Consulta nao encontrada ou ja confirmada' });

    // Log
    await db.query(
      `INSERT INTO dental_automation_log
         (company_id, customer_id, appointment_id, type, channel, status, response)
       VALUES ($1,$2,$3,'confirm_24h','portal','responded','confirmed_by_patient')`,
      [data.company_id, data.customer_id, req.params.aid]
    ).catch(() => {});

    res.json({ confirmed: true, appointment: rows[0] });
  } catch (err) {
    console.error('[dentalPortalPublic confirm]', err.message);
    res.status(500).json({ error: 'Erro ao confirmar' });
  }
});

module.exports = router;
