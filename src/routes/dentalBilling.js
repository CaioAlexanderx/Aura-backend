// ============================================================
// AURA. — ODT-03: Regua de Cobranca Odonto
// GET  /dental/billing/overdue   — parcelas vencidas
// GET  /dental/billing/dashboard  — KPIs inadimplencia
// POST /dental/billing/send-reminder/:paymentId — enviar lembrete
// GET  /dental/billing/reminders  — historico de lembretes
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/billing/overdue', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT tp.id AS payment_id, tp.treatment_plan_id, tp.amount, tp.due_date, tp.status,
              t.id AS plan_id, p.full_name AS patient_name, p.phone AS patient_phone, p.id AS patient_id,
              CURRENT_DATE - tp.due_date AS days_overdue
       FROM dental_treatment_payments tp
       JOIN dental_treatment_plans t ON t.id = tp.treatment_plan_id
       JOIN dental_patients p ON p.id = t.patient_id
       WHERE t.company_id = $1 AND tp.status = 'pending' AND tp.due_date < CURRENT_DATE
       ORDER BY tp.due_date ASC`, [cid]);
    res.json({ overdue: rows, total: rows.length, total_amount: rows.reduce((s, r) => s + parseFloat(r.amount), 0) });
  } catch (err) {
    if (err.message && err.message.includes('does not exist')) return res.json({ overdue: [], total: 0, total_amount: 0 });
    console.error(err); res.status(500).json({ error: 'Erro ao buscar parcelas vencidas' });
  }
});

router.get('/billing/dashboard', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows: [stats] } = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tp.status='pending' AND tp.due_date >= CURRENT_DATE THEN tp.amount END),0) AS a_receber,
         COALESCE(SUM(CASE WHEN tp.status='pending' AND tp.due_date < CURRENT_DATE THEN tp.amount END),0) AS vencido,
         COALESCE(SUM(CASE WHEN tp.status='paid' AND tp.paid_at >= date_trunc('month', CURRENT_DATE) THEN tp.amount END),0) AS recebido_mes,
         COUNT(CASE WHEN tp.status='pending' AND tp.due_date < CURRENT_DATE THEN 1 END) AS parcelas_vencidas,
         COUNT(CASE WHEN tp.status='pending' THEN 1 END) AS parcelas_pendentes
       FROM dental_treatment_payments tp
       JOIN dental_treatment_plans t ON t.id = tp.treatment_plan_id
       WHERE t.company_id = $1`, [cid]);
    const total = (parseFloat(stats.a_receber) + parseFloat(stats.vencido)) || 1;
    res.json({
      a_receber: parseFloat(stats.a_receber),
      vencido: parseFloat(stats.vencido),
      recebido_mes: parseFloat(stats.recebido_mes),
      parcelas_vencidas: parseInt(stats.parcelas_vencidas),
      parcelas_pendentes: parseInt(stats.parcelas_pendentes),
      taxa_inadimplencia: Math.round((parseFloat(stats.vencido) / total) * 100),
    });
  } catch (err) {
    if (err.message && err.message.includes('does not exist')) return res.json({ a_receber: 0, vencido: 0, recebido_mes: 0, parcelas_vencidas: 0, parcelas_pendentes: 0, taxa_inadimplencia: 0 });
    console.error(err); res.status(500).json({ error: 'Erro dashboard billing' });
  }
});

router.post('/billing/send-reminder/:paymentId', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { paymentId } = req.params;
  const { channel = 'whatsapp', reminder_type = 'manual' } = req.body;
  try {
    const { rows } = await db.query(
      `SELECT tp.amount, tp.due_date, p.full_name, p.phone, p.id AS patient_id, tp.treatment_plan_id
       FROM dental_treatment_payments tp
       JOIN dental_treatment_plans t ON t.id = tp.treatment_plan_id
       JOIN dental_patients p ON p.id = t.patient_id
       WHERE tp.id = $1 AND t.company_id = $2`, [paymentId, cid]);
    if (!rows.length) return res.status(404).json({ error: 'Parcela nao encontrada' });
    const p = rows[0];
    await db.query(
      `INSERT INTO dental_billing_reminders (company_id, patient_id, payment_id, treatment_plan_id, reminder_type, channel, amount, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cid, p.patient_id, paymentId, p.treatment_plan_id, reminder_type, channel, p.amount, p.due_date]);
    res.json({
      sent: true, patient: p.full_name, phone: p.phone, amount: parseFloat(p.amount),
      message: `Ola ${p.full_name}, sua parcela de R$ ${parseFloat(p.amount).toFixed(2).replace('.',',')} ${new Date(p.due_date) < new Date() ? 'esta vencida' : 'vence em breve'}. Entre em contato para regularizar.`
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao enviar lembrete' }); }
});

router.get('/billing/reminders', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  try {
    const { rows } = await db.query(
      `SELECT r.*, p.full_name AS patient_name FROM dental_billing_reminders r
       LEFT JOIN dental_patients p ON p.id = r.patient_id
       WHERE r.company_id = $1 ORDER BY r.sent_at DESC LIMIT $2`, [cid, limit]);
    res.json({ reminders: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro' }); }
});

module.exports = router;
