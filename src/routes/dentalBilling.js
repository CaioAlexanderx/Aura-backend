// ============================================================
// AURA. — ODT-03: Regua de Cobranca Odonto
// D-UNIFY: join com customers via tp.customer_id (treatment_plans).
// Reminders tambem usam customer_id.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/billing/overdue', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT tp.id AS payment_id, tp.treatment_plan_id, tp.amount, tp.due_date, tp.status,
              t.id AS plan_id,
              c.name  AS patient_name,
              c.phone AS patient_phone,
              c.id    AS patient_id,
              c.id    AS customer_id,
              CURRENT_DATE - tp.due_date AS days_overdue
       FROM dental_treatment_payments tp
       JOIN dental_treatment_plans t ON t.id = tp.treatment_plan_id
       JOIN customers c ON c.id = t.customer_id
       WHERE t.company_id = $1 AND tp.status = 'pending' AND tp.due_date < CURRENT_DATE
       ORDER BY tp.due_date ASC`, [cid]);
    res.json({
      overdue: rows,
      total: rows.length,
      total_amount: rows.reduce((s, r) => s + parseFloat(r.amount), 0),
    });
  } catch (err) {
    if (err.message && err.message.includes('does not exist')) {
      return res.json({ overdue: [], total: 0, total_amount: 0 });
    }
    console.error('[dentalBilling overdue]', err.message);
    res.status(500).json({ error: 'Erro ao buscar parcelas vencidas' });
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
    if (err.message && err.message.includes('does not exist')) {
      return res.json({ a_receber: 0, vencido: 0, recebido_mes: 0, parcelas_vencidas: 0, parcelas_pendentes: 0, taxa_inadimplencia: 0 });
    }
    console.error('[dentalBilling dashboard]', err.message);
    res.status(500).json({ error: 'Erro dashboard billing' });
  }
});

// ============================================================
// GET /billing/patient/:pid  (W1-01 fase 2)
//
// Retorna TODAS as parcelas (pending + paid + overdue) de UM paciente.
// Usado pela sub-tab "Cobrancas" do PatientHub.
// Tem agregados pre-calculados pra economizar render no FE.
// ============================================================
router.get('/billing/patient/:pid', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const pid = req.params.pid;
  try {
    const { rows } = await db.query(
      `SELECT tp.id AS payment_id,
              tp.treatment_plan_id,
              tp.installment_number,
              tp.amount,
              tp.due_date,
              tp.paid_at,
              tp.status,
              t.plan_number,
              t.total AS plan_total,
              CASE
                WHEN tp.status = 'pending' AND tp.due_date < CURRENT_DATE
                  THEN (CURRENT_DATE - tp.due_date)::int
                ELSE NULL
              END AS days_overdue
       FROM dental_treatment_payments tp
       JOIN dental_treatment_plans t ON t.id = tp.treatment_plan_id
       WHERE t.company_id = $1 AND t.customer_id = $2
       ORDER BY tp.due_date ASC`,
      [cid, pid]
    );

    // Agregados em JS (simples, dataset pequeno)
    let total_pending = 0;
    let total_overdue = 0;
    let total_paid = 0;
    for (const r of rows) {
      const amt = parseFloat(r.amount) || 0;
      if (r.status === 'paid') total_paid += amt;
      else if (r.status === 'pending') {
        total_pending += amt;
        if (r.days_overdue && r.days_overdue > 0) total_overdue += amt;
      }
    }

    res.json({
      patient_id: pid,
      count: rows.length,
      installments: rows,
      total_pending,
      total_overdue,
      total_paid,
    });
  } catch (err) {
    // Se as tabelas de payment ainda nao existem (migration pendente), retorna vazio
    if (err.message && err.message.includes('does not exist')) {
      return res.json({
        patient_id: pid, count: 0, installments: [],
        total_pending: 0, total_overdue: 0, total_paid: 0,
      });
    }
    console.error('[dentalBilling patient]', err.message);
    res.status(500).json({ error: 'Erro ao buscar parcelas do paciente' });
  }
});

router.post('/billing/send-reminder/:paymentId', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { paymentId } = req.params;
  const { channel = 'whatsapp', reminder_type = 'manual' } = req.body;
  try {
    const { rows } = await db.query(
      `SELECT tp.amount, tp.due_date,
              c.name  AS full_name,
              c.phone AS phone,
              c.id    AS customer_id,
              tp.treatment_plan_id
       FROM dental_treatment_payments tp
       JOIN dental_treatment_plans t ON t.id = tp.treatment_plan_id
       JOIN customers c ON c.id = t.customer_id
       WHERE tp.id = $1 AND t.company_id = $2`, [paymentId, cid]);
    if (!rows.length) return res.status(404).json({ error: 'Parcela nao encontrada' });
    const p = rows[0];
    await db.query(
      `INSERT INTO dental_billing_reminders
         (company_id, customer_id, payment_id, treatment_plan_id, reminder_type, channel, amount, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cid, p.customer_id, paymentId, p.treatment_plan_id, reminder_type, channel, p.amount, p.due_date]);
    res.json({
      sent: true,
      patient: p.full_name,
      phone: p.phone,
      amount: parseFloat(p.amount),
      message: `Ola ${p.full_name}, sua parcela de R$ ${parseFloat(p.amount).toFixed(2).replace('.',',')} ${new Date(p.due_date) < new Date() ? 'esta vencida' : 'vence em breve'}. Entre em contato para regularizar.`,
    });
  } catch (err) {
    console.error('[dentalBilling send-reminder]', err.message);
    res.status(500).json({ error: 'Erro ao enviar lembrete' });
  }
});

router.get('/billing/reminders', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  try {
    const { rows } = await db.query(
      `SELECT r.*,
              r.customer_id AS patient_id,
              c.name AS patient_name
       FROM dental_billing_reminders r
       LEFT JOIN customers c ON c.id = r.customer_id
       WHERE r.company_id = $1
       ORDER BY r.sent_at DESC
       LIMIT $2`, [cid, limit]);
    res.json({ reminders: rows });
  } catch (err) {
    console.error('[dentalBilling reminders]', err.message);
    res.status(500).json({ error: 'Erro' });
  }
});

module.exports = router;
