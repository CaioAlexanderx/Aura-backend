// ============================================================
// AURA. — Rotas Módulo Odontologia (BE-25)
// Plano mínimo: Negócio (módulo Odontologia ativo)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  listPatients, getAgendaByPeriod, updateAppointmentStatus,
  addProcedureToAppointment, recalcAppointmentTotal,
  calcAppointmentTotal, generateWsToken, validateWsToken,
} = require('../services/dental');

// ── Pacientes ──────────────────────────────────────────────

router.get('/patients', requireAuth, async (req, res) => {
  try {
    const { search, page, limit } = req.query;
    const patients = await listPatients(req.params.id, { search, page: parseInt(page), limit: parseInt(limit) });
    res.json({ total: patients.length, patients });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar pacientes' }); }
});

router.get('/patients/:pid', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM dental_patients WHERE id=$1 AND company_id=$2',
      [req.params.pid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Paciente não encontrado' });
    res.json({ patient: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar paciente' }); }
});

router.post('/patients', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { full_name, birth_date, cpf, phone, email, gender,
          allergies, medical_history, medications, notes, lgpd_consent = false } = req.body;
  if (!full_name) return res.status(400).json({ error: 'full_name é obrigatório' });
  if (!lgpd_consent) return res.status(400).json({ error: 'Consentimento LGPD Art.11 é obrigatório para dados de saúde' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_patients
         (company_id, full_name, birth_date, cpf, phone, email, gender,
          allergies, medical_history, medications, notes, lgpd_consent, lgpd_consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING *`,
      [req.params.id, full_name, birth_date||null, cpf||null, phone||null,
       email||null, gender||null, allergies||null, medical_history||null,
       medications||null, notes||null, true]
    );
    res.status(201).json({ patient: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao cadastrar paciente' }); }
});

router.patch('/patients/:pid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const allowed = ['full_name','birth_date','cpf','phone','email','gender',
                   'allergies','medical_history','medications','notes',
                   'insurance_name','insurance_card','insurance_plan','insurance_exp'];
  const fields=[], values=[];
  let idx=1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key}=$${idx++}`); values.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  fields.push(`updated_at=NOW()`);
  values.push(req.params.pid, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE dental_patients SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Paciente não encontrado' });
    res.json({ patient: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar paciente' }); }
});

// ── Catálogo de procedimentos ─────────────────────────────

router.get('/procedures', requireAuth, async (req, res) => {
  const { category } = req.query;
  try {
    const params = [req.params.id];
    let where = 'WHERE company_id=$1 AND active=true';
    if (category) { params.push(category); where += ` AND category=$2::dental_category`; }
    const { rows } = await db.query(
      `SELECT id, code_internal, category, name, description, price_private, price_plan, active
       FROM dental_procedures ${where} ORDER BY category, name`, params
    );
    res.json({ total: rows.length, procedures: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar procedimentos' }); }
});

router.post('/procedures', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { code_internal, code_tuss, category, name, description, price_private, price_plan } = req.body;
  if (!code_internal || !name || price_private === undefined)
    return res.status(400).json({ error: 'code_internal, name e price_private são obrigatórios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_procedures
         (company_id, code_internal, code_tuss, category, name, description, price_private, price_plan)
       VALUES ($1,$2,$3,$4::dental_category,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, code_internal, code_tuss||null, category||'outros',
       name, description||null, price_private, price_plan||null]
    );
    res.status(201).json({ procedure: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Código interno já existe' });
    res.status(500).json({ error: 'Erro ao cadastrar procedimento' });
  }
});

router.patch('/procedures/:procId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const allowed = ['code_internal','code_tuss','category','name','description','price_private','price_plan','active'];
  const fields=[], values=[];
  let idx=1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const cast = key === 'category' ? '::dental_category' : '';
      fields.push(`${key}=$${idx++}${cast}`);
      values.push(req.body[key]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  fields.push(`updated_at=NOW()`);
  values.push(req.params.procId, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE dental_procedures SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Procedimento não encontrado' });
    res.json({ procedure: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar procedimento' }); }
});

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
  if (!patient_id || !scheduled_at) return res.status(400).json({ error: 'patient_id e scheduled_at são obrigatórios' });
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
    if (!appt.length) return res.status(404).json({ error: 'Agendamento não encontrado' });
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
    if (!rows.length) return res.status(404).json({ error: 'Agendamento não encontrado' });
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
    if (!rows.length) return res.status(404).json({ error: 'Procedimento não encontrado' });
    await recalcAppointmentTotal(req.params.aid);
    res.json({ message: 'Procedimento removido' });
  } catch (err) { res.status(500).json({ error: 'Erro ao remover procedimento' }); }
});

// ── Odontograma (BE-25-09) ────────────────────────────────

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
  if (!tooth_number || !status) return res.status(400).json({ error: 'tooth_number e status são obrigatórios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_chart_entries
         (company_id, patient_id, appointment_id, tooth_number, face, status, procedure_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6::dental_face,$7,$8) RETURNING *`,
      [req.params.id, req.params.pid, appointment_id||null, tooth_number,
       face||null, status, procedure_id||null, notes||null]
    );
    res.status(201).json({ entry: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao registrar no odontograma' }); }
});

// ── Receituário e atestados (BE-25-05) ────────────────────

router.post('/prescriptions', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { patient_id, appointment_id, doc_type = 'receituario', content } = req.body;
  if (!patient_id || !content) return res.status(400).json({ error: 'patient_id e content são obrigatórios' });
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

// ── D-02: Planos de Tratamento / Orcamentos ───────────────

router.use('/treatment-plans', require('./dentalTreatmentPlans'));

// ── WebSocket token prep (BE-25-10) ───────────────────────

router.post('/appointments/:aid/signature-token', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const result = await generateWsToken(req.params.id, req.params.aid);
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Erro ao gerar token de assinatura' }); }
});

router.get('/sign/:token', async (req, res) => {
  try {
    const tokenData = await validateWsToken(req.params.token);
    if (!tokenData) return res.status(410).json({ error: 'Link expirado ou inválido. Solicite um novo ao dentista.' });
    res.json({
      valid: true,
      appointment_id: tokenData.appointment_id,
      expires_at: tokenData.expires_at,
      message: 'Token válido. WebSocket disponível em /ws/sign/:token — implementado no BE-25-10',
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao validar token' }); }
});

module.exports = router;
