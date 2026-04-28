// ============================================================
// AURA. — Rotas Modulo Odontologia (core)
// D-UNIFY: patient_id do body = customers.id (paciente e customer sao
// a mesma entidade). Novos inserts usam customer_id, patient_id fica NULL.
// Appointments tambem gravam practitioner_id (cadeira via settings).
//
// PR42 (2026-04-28): Odontograma 2.0 — 3 axes
// GET /chart agrupa entries por tooth + axis (condition/planned/completed)
// POST /chart aceita finding_type/procedure_type/material/black_class
// DELETE /chart/:entryId pra remover entry individual
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

// ── Sub-routes (extracted) ──
router.use('/', require('./dentalPatients'));
router.use('/', require('./dentalAnamnesis'));
router.use('/', require('./dentalPerio'));
router.use('/', require('./dentalSpecialtyForms'));
router.use('/', require('./dentalProcedures'));
router.use('/', require('./dentalPractitioners'));
router.use('/', require('./dentalBookingAdmin'));
router.use('/', require('./dentalConsent')); // W2-04: TCLE templates + documents
router.use('/ai', require('./dentalAi'));     // W2-05: IA Odonto persistente (Expansao only)
router.use('/tiss', require('./dentalTiss')); // W2-02: TISS 4.01 completo

// ── Helpers ──
async function resolveCustomerId(companyId, body) {
  const id = body.customer_id || body.patient_id;
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT id FROM customers
     WHERE id = $1 AND company_id = $2 AND is_patient = true`,
    [id, companyId]
  );
  return rows.length ? rows[0].id : null;
}

// ── Agenda ──

router.get('/agenda', requireAuth, async (req, res) => {
  const now = new Date();
  const startDate = req.query.start || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const endDate   = req.query.end   || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  try {
    const appointments = await getAgendaByPeriod(req.params.id, startDate, endDate);
    res.json({ start: startDate, end: endDate, total: appointments.length, appointments });
  } catch (err) {
    console.error('[dental GET /agenda]', err.message);
    res.status(500).json({ error: 'Erro ao buscar agenda' });
  }
});

router.post('/appointments', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { scheduled_at, duration_min = 60, chief_complaint, practitioner_id } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at e obrigatorio' });

  const customerId = await resolveCustomerId(req.params.id, req.body);
  if (!customerId) return res.status(400).json({ error: 'Paciente (customer_id ou patient_id) invalido ou nao encontrado' });

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_appointments
         (company_id, customer_id, scheduled_at, duration_min, chief_complaint, practitioner_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *, customer_id AS patient_id`,
      [req.params.id, customerId, scheduled_at, duration_min, chief_complaint||null, practitioner_id||null]
    );
    res.status(201).json({ appointment: rows[0] });
  } catch (err) {
    console.error('[dental POST /appointments]', err.message);
    res.status(500).json({ error: 'Erro ao criar agendamento' });
  }
});

router.get('/appointments/:aid', requireAuth, async (req, res) => {
  try {
    const { rows: appt } = await db.query(
      `SELECT a.*,
              a.customer_id AS patient_id,
              c.name           AS patient_name,
              c.phone          AS patient_phone,
              c.insurance_name,
              c.allergies,
              pr.name          AS professional_name
       FROM dental_appointments a
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN dental_practitioners pr ON pr.id = a.practitioner_id
       WHERE a.id = $1 AND a.company_id = $2`,
      [req.params.aid, req.params.id]
    );
    if (!appt.length) return res.status(404).json({ error: 'Agendamento nao encontrado' });
    const { rows: procs } = await db.query(
      'SELECT * FROM dental_appointment_procedures WHERE appointment_id=$1 ORDER BY created_at',
      [req.params.aid]
    );
    res.json({ appointment: { ...appt[0], procedures: procs } });
  } catch (err) {
    console.error('[dental GET /appointments/:aid]', err.message);
    res.status(500).json({ error: 'Erro ao buscar agendamento' });
  }
});

router.patch('/appointments/:aid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { status, chief_complaint, anamnesis, clinical_notes,
          discount_type, discount_value, cancel_reason, practitioner_id, scheduled_at, duration_min } = req.body;
  try {
    if (status) {
      const updated = await updateAppointmentStatus(req.params.id, req.params.aid, status);
      return res.json({ appointment: updated });
    }
    const fields=[], values=[];
    let idx=1;
    const allowed = { chief_complaint, anamnesis, clinical_notes, discount_type, discount_value, cancel_reason, practitioner_id, scheduled_at, duration_min };
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
    if (err.message.includes('Transicao') || err.message.includes('Transição')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[dental PATCH /appointments/:aid]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar agendamento' });
  }
});

// ── Procedimentos do atendimento ──

router.post('/appointments/:aid/procedures', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const proc = await addProcedureToAppointment(req.params.aid, req.params.id, req.body);
    res.status(201).json({ procedure: proc });
  } catch (err) {
    console.error('[dental POST /appointments/:aid/procedures]', err.message);
    res.status(500).json({ error: 'Erro ao adicionar procedimento' });
  }
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
  } catch (err) {
    console.error('[dental DELETE procedure]', err.message);
    res.status(500).json({ error: 'Erro ao remover procedimento' });
  }
});

// ── Odontograma · PR42 — 3 axes (condition / treatment_planned / treatment_completed) ──

router.get('/patients/:pid/chart', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, p.name AS procedure_name, u.full_name AS performed_by_name
       FROM dental_chart_entries c
       LEFT JOIN dental_procedures p ON p.id = c.procedure_id
       LEFT JOIN users u ON u.id = c.performed_by
       WHERE c.customer_id = $1 AND c.company_id = $2
       ORDER BY c.tooth_number, c.recorded_at DESC`,
      [req.params.pid, req.params.id]
    );
    const byTooth = {};
    for (const entry of rows) {
      if (!byTooth[entry.tooth_number]) {
        byTooth[entry.tooth_number] = {
          tooth: entry.tooth_number,
          condition: [],
          planned: [],
          completed: [],
        };
      }
      const t = byTooth[entry.tooth_number];
      if (entry.axis === 'condition') t.condition.push(entry);
      else if (entry.axis === 'treatment_planned') t.planned.push(entry);
      else if (entry.axis === 'treatment_completed') t.completed.push(entry);
    }
    res.json({ patient_id: req.params.pid, teeth: Object.values(byTooth) });
  } catch (err) {
    console.error('[dental GET chart]', err.message);
    res.status(500).json({ error: 'Erro ao buscar odontograma' });
  }
});

router.post('/patients/:pid/chart', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const {
    appointment_id, tooth_number, face,
    axis = 'condition',
    finding_type, procedure_type, material, black_class,
    estimated_value, completed_at, performed_by,
    status, procedure_id, notes,
  } = req.body;

  if (!tooth_number) return res.status(400).json({ error: 'tooth_number obrigatorio' });
  if (!['condition','treatment_planned','treatment_completed'].includes(axis)) {
    return res.status(400).json({ error: 'axis invalido (use condition, treatment_planned ou treatment_completed)' });
  }
  if (axis === 'condition' && !finding_type && !status) {
    return res.status(400).json({ error: 'finding_type obrigatorio em axis=condition' });
  }
  if (axis !== 'condition' && !procedure_type) {
    return res.status(400).json({ error: 'procedure_type obrigatorio em treatment_*' });
  }

  // Backward compat: deriva status legado a partir do finding_type/procedure_type
  // (a coluna `status` ainda eh NOT NULL com enum dental_tooth_status)
  const legacyStatus = status || (
    finding_type === 'higido' ? 'saudavel' :
    finding_type === 'carie' ? 'carie' :
    finding_type === 'restauracao_antiga' ? 'restaurado' :
    finding_type === 'coroa_antiga' ? 'coroa' :
    finding_type === 'implante' ? 'implante' :
    finding_type === 'fratura' ? 'fraturado' :
    finding_type === 'ausente' ? 'ausente' :
    procedure_type === 'restauracao' ? 'restaurado' :
    procedure_type === 'coroa' ? 'coroa' :
    procedure_type === 'implante' ? 'implante' :
    procedure_type === 'extracao' ? 'ausente' :
    'outros'
  );

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_chart_entries
         (company_id, customer_id, appointment_id, tooth_number, face, status, procedure_id, notes,
          axis, finding_type, procedure_type, material, black_class, estimated_value, completed_at, performed_by)
       VALUES ($1, $2, $3, $4, $5::dental_face, $6, $7, $8,
          $9::dental_chart_axis, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        req.params.id, req.params.pid, appointment_id||null, tooth_number,
        face||null, legacyStatus, procedure_id||null, notes||null,
        axis, finding_type||null, procedure_type||null, material||null,
        black_class||null, estimated_value||null, completed_at||null, performed_by||null,
      ]
    );
    res.status(201).json({ entry: rows[0] });
  } catch (err) {
    console.error('[dental POST chart]', err.message);
    res.status(500).json({ error: 'Erro ao registrar no odontograma: ' + err.message });
  }
});

// PR42: remover entry individual
router.delete('/patients/:pid/chart/:entryId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM dental_chart_entries
       WHERE id=$1 AND customer_id=$2 AND company_id=$3
       RETURNING id`,
      [req.params.entryId, req.params.pid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Entry nao encontrado' });
    res.json({ deleted: rows[0].id });
  } catch (err) {
    console.error('[dental DELETE chart entry]', err.message);
    res.status(500).json({ error: 'Erro ao remover entry' });
  }
});

// ── Receituario e atestados ──

router.post('/prescriptions', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { appointment_id, doc_type = 'receituario', content } = req.body;
  if (!content) return res.status(400).json({ error: 'content e obrigatorio' });

  const customerId = await resolveCustomerId(req.params.id, req.body);
  if (!customerId) return res.status(400).json({ error: 'Paciente invalido ou nao encontrado' });

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_prescriptions
         (company_id, customer_id, appointment_id, doc_type, content)
       VALUES ($1, $2, $3, $4::dental_document_type, $5)
       RETURNING *, customer_id AS patient_id`,
      [req.params.id, customerId, appointment_id||null, doc_type, content]
    );
    res.status(201).json({ prescription: rows[0] });
  } catch (err) {
    console.error('[dental POST /prescriptions]', err.message);
    res.status(500).json({ error: 'Erro ao salvar documento' });
  }
});

router.get('/patients/:pid/prescriptions', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT *, customer_id AS patient_id
       FROM dental_prescriptions
       WHERE customer_id = $1 AND company_id = $2
       ORDER BY issued_at DESC`,
      [req.params.pid, req.params.id]
    );
    res.json({ total: rows.length, prescriptions: rows });
  } catch (err) {
    console.error('[dental GET prescriptions]', err.message);
    res.status(500).json({ error: 'Erro ao buscar documentos' });
  }
});

// ── Sub-routes (feature modules) ──

router.use('/treatment-plans', require('./dentalTreatmentPlans'));
router.use('/', require('./dentalImages'));
router.use('/', require('./dentalLab'));
router.use('/', require('./dentalBilling'));
router.use('/insurance', require('./dentalInsurance'));  // legado S11 (mantido pra retrocompat)
router.use('/advanced', require('./dentalAdvanced'));

// ── WebSocket token ──

router.post('/appointments/:aid/signature-token', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const result = await generateWsToken(req.params.id, req.params.aid);
    res.json(result);
  } catch (err) {
    console.error('[dental signature-token]', err.message);
    res.status(500).json({ error: 'Erro ao gerar token de assinatura' });
  }
});

router.get('/sign/:token', async (req, res) => {
  try {
    const tokenData = await validateWsToken(req.params.token);
    if (!tokenData) return res.status(410).json({ error: 'Link expirado ou invalido.' });
    res.json({ valid: true, appointment_id: tokenData.appointment_id, expires_at: tokenData.expires_at });
  } catch (err) {
    console.error('[dental GET /sign/:token]', err.message);
    res.status(500).json({ error: 'Erro ao validar token' });
  }
});

module.exports = router;
