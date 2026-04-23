// ============================================================
// AURA. — Rotas Módulo Odontologia (core)
// Agenda, Appointments, Chart, Prescriptions + sub-route mounts
// Patients and Procedures extracted to dentalPatients/dentalProcedures
// D-FIX #1+#6: practitioners + settings via dentalPractitioners.js
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  getAgendaByPeriod, updateAppointmentStatus,
  addProcedureToAppointment, recalcAppointmentTotal,
  generateWsToken, validateWsToken,
} = require('../services/dental');

// ── Sub-routes (extracted) ────────────────────────────────
router.use('/', require('./dentalPatients'));
router.use('/', require('./dentalProcedures'));
router.use('/', require('./dentalPractitioners'));   // D-FIX #1+#6: settings + practitioners

// ── Agenda ────────────────────────────────────────────────

router.get('/agenda', requireAuth, async (req, res) => {
  const now = new Date();
  const startDate = req.query.start || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const endDate   = req.query.end   || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  try {
    const appointments = await getAgendaByPeriod(req.params.id, startDate, endDate);
    res.json({ start: startDate, end: endDate, total: appointments.length, appointments });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar agenda' }); }
});

router.post('/appointments', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { patient_id, scheduled_at, duration_min = 60, chief_complaint } = req.body;
  if (!patient_id || !scheduled_at) return res.status(400).json({ error: 'patient_id e scheduled_at sao obrigatorios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_appointments (company_id, patient_id, scheduled_at, duration_min, chief_complaint)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, patient_id, scheduled_at, duration_min, chief_complaint||null]
    );
    res.status(201).json({ appointment: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao criar agendamento' }); }
});

router.get('/appointments/:aid', requireAuth, async (req, res) => {
  try {
    const { rows: appt } = await db.query(
      `SELECT a.*, p.full_name AS patient_name, p.phone AS patient_phone, p.insurance_name, p.allergies
       FROM dental_appointments a JOIN dental_patients p ON p.id=a.patient_id
       WHERE a.id=$1 AND a.company_id=$2`,
      [req.params.aid, req.params.id]
    );
    if (!appt.length) return res.status(404).json({ error: 'Agendamento nao encontrado' });
    const { rows: procs } = await db.query(
      'SELECT * FROM dental_appointment_procedures WHERE appointment_id=$1 ORDER BY created_at',
      [req.params.aid]
    );
    res.json({ appointment: { ...appt[0], procedures: procs } });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar agendamento' }); }
});

router.patch('/appointments/:aid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { status, chief_complaint, anamnesis, clinical_notes,
          discount_type, discount_value, cancel_reason } = req.body;
  try {
    if (status) {
      const updated = await updateAppointmentStatus(req.params.id, req.params.aid, status);
      return res.json({ appointment: updated });
    }
    const fields=[], values=[];
    let idx=1;
    const allowed = { chief_complaint, anamnesis, clinical_notes, discount_type, discount_value, cancel_reason };
    for (const [k,v] of Object.entries(allowed)) {
      if (v !== undefined) { fields.push(`${k}=$${idx++}`); values.push(v); }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    fields.push(`updated_at=NOW()`);
    values.push(req.params.aid, req.params.id);
    const { rows } = await db.query(
      `UPDATE dental_appointments SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Agendamento nao encontrado' });
    if (discount_type !== undefined || discount_value !== undefined) await recalcAppointmentTotal(req.params.aid);
    res.json({ appointment: rows[0] });
  } catch (err) {
    if (err.message.includes('Transição')) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Erro ao atualizar agendamento' });
  }
});

// ── Procedimentos do atendimento ──────────────────────────

router.post('/appointments/:aid/procedures', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const proc = await addProcedureToAppointment(req.params.aid, req.params.id, req.body);
    res.status(201).json({ procedure: proc });
  } catch (err) { res.status(500).json({ error: 'Erro ao adicionar procedimento' }); }
});

router.delete('/appointments/:aid/procedures/:procId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM dental_appointment_procedures WHERE id=$1 AND appointment_id=$2 RETURNING id',
      [req.params.procId, req.params.aid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Procedimento nao encontrado' });
    await recalcAppointmentTotal(req.params.aid);
    res.json({ message: 'Procedimento removido' });
  } catch (err) { res.status(500).json({ error: 'Erro ao remover procedimento' }); }
});

// ── Odontograma ───────────────────────────────────────────

router.get('/patients/:pid/chart', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, p.name AS procedure_name FROM dental_chart_entries c
       LEFT JOIN dental_procedures p ON p.id=c.procedure_id
       WHERE c.patient_id=$1 AND c.company_id=$2
       ORDER BY c.tooth_number, c.face, c.recorded_at DESC`,
      [req.params.pid, req.params.id]
    );
    const byTooth = {};
    for (const entry of rows) {
      if (!byTooth[entry.tooth_number]) byTooth[entry.tooth_number] = { tooth: entry.tooth_number, faces: [] };
      byTooth[entry.tooth_number].faces.push(entry);
    }
    res.json({ patient_id: req.params.pid, teeth: Object.values(byTooth) });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar odontograma' }); }
});

router.post('/patients/:pid/chart', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { appointment_id, tooth_number, face, status, procedure_id, notes } = req.body;
  if (!tooth_number || !status) return res.status(400).json({ error: 'tooth_number e status sao obrigatorios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_chart_entries
         (company_id, patient_id, appointment_id, tooth_number, face, status, procedure_id, notes)
       VALUES ($1,$2,$3,$4,$5::dental_face,$6,$7,$8) RETURNING *`,
      [req.params.id, req.params.pid, appointment_id||null, tooth_number,
       face||null, status, procedure_id||null, notes||null]
    );
    res.status(201).json({ entry: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao registrar no odontograma' }); }
});

// ── Receituário e atestados ───────────────────────────────

router.post('/prescriptions', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { patient_id, appointment_id, doc_type = 'receituario', content } = req.body;
  if (!patient_id || !content) return res.status(400).json({ error: 'patient_id e content sao obrigatorios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_prescriptions (company_id, patient_id, appointment_id, doc_type, content)
       VALUES ($1,$2,$3,$4::dental_document_type,$5) RETURNING *`,
      [req.params.id, patient_id, appointment_id||null, doc_type, content]
    );
    res.status(201).json({ prescription: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar documento' }); }
});

router.get('/patients/:pid/prescriptions', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM dental_prescriptions WHERE patient_id=$1 AND company_id=$2 ORDER BY issued_at DESC`,
      [req.params.pid, req.params.id]
    );
    res.json({ total: rows.length, prescriptions: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar documentos' }); }
});

// ── Sub-routes (feature modules) ──────────────────────────

router.use('/treatment-plans', require('./dentalTreatmentPlans'));
router.use('/', require('./dentalImages'));
router.use('/', require('./dentalLab'));
router.use('/insurance', require('./dentalInsurance'));
router.use('/advanced', require('./dentalAdvanced'));

// ── WebSocket token ───────────────────────────────────────

router.post('/appointments/:aid/signature-token', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const result = await generateWsToken(req.params.id, req.params.aid);
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Erro ao gerar token de assinatura' }); }
});

router.get('/sign/:token', async (req, res) => {
  try {
    const tokenData = await validateWsToken(req.params.token);
    if (!tokenData) return res.status(410).json({ error: 'Link expirado ou invalido.' });
    res.json({ valid: true, appointment_id: tokenData.appointment_id, expires_at: tokenData.expires_at });
  } catch (err) { res.status(500).json({ error: 'Erro ao validar token' }); }
});

module.exports = router;
