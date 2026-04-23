// ============================================================
// AURA. — S11 D-18/D-19/D-20/D-21: Specialty, Perio, Waitlist, Checkin
// D-UNIFY: todos usam customer_id. Compat via patient_id aceita em body.
// Fix: u.name -> u.full_name (coluna correta em users).
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

async function resolveCustomerId(companyId, body) {
  const id = body.customer_id || body.patient_id;
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT id FROM customers WHERE id=$1 AND company_id=$2 AND is_patient=true`,
    [id, companyId]
  );
  return rows.length ? rows[0].id : null;
}

// ===== D-18: SPECIALTY FORMS =====
// :patientId na URL = customer_id (convencao pos-D-UNIFY)

router.get('/specialty/:patientId', requireAuth, async (req, res) => {
  const { specialty } = req.query;
  try {
    const params = [req.params.id, req.params.patientId];
    let where = 'WHERE company_id=$1 AND customer_id=$2';
    if (specialty) { params.push(specialty); where += ` AND specialty=$${params.length}`; }
    const { rows } = await db.query(
      `SELECT *, customer_id AS patient_id
       FROM dental_specialty_forms ${where} ORDER BY created_at DESC`, params
    );
    res.json({ total: rows.length, forms: rows });
  } catch (err) {
    console.error('[advanced specialty GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar fichas' });
  }
});

router.post('/specialty', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { specialty, form_data, professional_id, appointment_id, notes } = req.body;
  if (!specialty || !form_data) return res.status(400).json({ error: 'specialty e form_data obrigatorios' });

  const customerId = await resolveCustomerId(req.params.id, req.body);
  if (!customerId) return res.status(400).json({ error: 'Paciente (customer_id ou patient_id) invalido' });

  const validSpecialties = ['ortodontia','endodontia','periodontia','cirurgia','implante','protese','odontopediatria'];
  if (!validSpecialties.includes(specialty)) return res.status(400).json({ error: 'Especialidade invalida. Opcoes: ' + validSpecialties.join(', ') });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_specialty_forms (company_id, customer_id, specialty, form_data, professional_id, appointment_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *, customer_id AS patient_id`,
      [req.params.id, customerId, specialty, JSON.stringify(form_data), professional_id||null, appointment_id||null, notes||null]
    );
    res.status(201).json({ form: rows[0] });
  } catch (err) {
    console.error('[advanced specialty POST]', err.message);
    res.status(500).json({ error: 'Erro ao salvar ficha' });
  }
});

// ===== D-19: PERIODONTAL CHART =====

router.get('/perio/:patientId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT *, customer_id AS patient_id
       FROM dental_periodontal_chart WHERE company_id=$1 AND customer_id=$2 ORDER BY exam_date DESC`,
      [req.params.id, req.params.patientId]
    );
    res.json({ total: rows.length, charts: rows });
  } catch (err) {
    console.error('[advanced perio GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar periograma' });
  }
});

router.post('/perio', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { professional_id, exam_date, measurements, bleeding_sites, total_sites, plaque_index, diagnosis, notes } = req.body;
  if (!measurements) return res.status(400).json({ error: 'measurements obrigatorio' });

  const customerId = await resolveCustomerId(req.params.id, req.body);
  if (!customerId) return res.status(400).json({ error: 'Paciente invalido' });

  const bleedingIdx = total_sites > 0 ? Math.round((bleeding_sites || 0) / total_sites * 10000) / 100 : 0;
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_periodontal_chart (company_id, customer_id, professional_id, exam_date, measurements, bleeding_sites, total_sites, bleeding_index, plaque_index, diagnosis, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *, customer_id AS patient_id`,
      [req.params.id, customerId, professional_id||null, exam_date||new Date().toISOString().split('T')[0],
       JSON.stringify(measurements), bleeding_sites||0, total_sites||0, bleedingIdx, plaque_index||0, diagnosis||null, notes||null]
    );
    res.status(201).json({ chart: rows[0] });
  } catch (err) {
    console.error('[advanced perio POST]', err.message);
    res.status(500).json({ error: 'Erro ao salvar periograma' });
  }
});

// ===== D-20: WAITLIST =====

router.get('/waitlist', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT w.*,
              w.customer_id AS patient_id,
              c.name AS patient_full_name
       FROM dental_waitlist w
       LEFT JOIN customers c ON c.id=w.customer_id
       WHERE w.company_id=$1 AND w.status IN ('aguardando','notificado')
       ORDER BY CASE w.urgency WHEN 'prioritario' THEN 1 WHEN 'urgente' THEN 2 ELSE 3 END, w.created_at`,
      [req.params.id]
    );
    res.json({ total: rows.length, waitlist: rows });
  } catch (err) {
    console.error('[advanced waitlist GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar lista de espera' });
  }
});

router.post('/waitlist', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { patient_name, patient_phone, procedure_name, professional_id, preferred_days, preferred_time, urgency, notes } = req.body;
  if (!patient_name) return res.status(400).json({ error: 'patient_name obrigatorio' });

  // customer_id eh opcional aqui — waitlist pode incluir lead sem cadastro
  let customerId = null;
  if (req.body.customer_id || req.body.patient_id) {
    customerId = await resolveCustomerId(req.params.id, req.body);
    if (!customerId) return res.status(400).json({ error: 'Paciente informado e invalido' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_waitlist (company_id, customer_id, patient_name, patient_phone, procedure_name, professional_id, preferred_days, preferred_time, urgency, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *, customer_id AS patient_id`,
      [req.params.id, customerId, patient_name, patient_phone||null, procedure_name||null, professional_id||null,
       JSON.stringify(preferred_days||[]), preferred_time||null, urgency||'normal', notes||null]
    );
    res.status(201).json({ entry: rows[0] });
  } catch (err) {
    console.error('[advanced waitlist POST]', err.message);
    res.status(500).json({ error: 'Erro ao adicionar a lista' });
  }
});

router.patch('/waitlist/:wid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { status, appointment_id } = req.body;
  const fields = [], values = []; let idx = 1;
  if (status) {
    fields.push(`status=$${idx++}`); values.push(status);
    if (status === 'notificado') fields.push('notified_at=NOW()');
    if (status === 'agendado') fields.push('scheduled_at=NOW()');
  }
  if (appointment_id) { fields.push(`appointment_id=$${idx++}`); values.push(appointment_id); }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo' });
  values.push(req.params.wid, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE dental_waitlist SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Entrada nao encontrada' });
    res.json({ entry: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar' }); }
});

// ===== D-21: CHECK-IN =====

router.get('/checkins', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows } = await db.query(
      `SELECT ci.*,
              ci.customer_id AS patient_id,
              c.name AS patient_full_name
       FROM dental_checkins ci
       LEFT JOIN customers c ON c.id=ci.customer_id
       WHERE ci.company_id=$1 AND ci.checked_in_at::date=$2
       ORDER BY ci.checked_in_at DESC`,
      [req.params.id, today]
    );
    const { rows: stats } = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='arrived')::int AS waiting,
              COUNT(*) FILTER (WHERE status='called')::int AS called,
              COUNT(*) FILTER (WHERE status='in_service')::int AS in_service,
              COUNT(*) FILTER (WHERE status='done')::int AS done
       FROM dental_checkins WHERE company_id=$1 AND checked_in_at::date=$2`, [req.params.id, today]
    );
    res.json({ checkins: rows, stats: stats[0] });
  } catch (err) {
    console.error('[advanced checkins GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar check-ins' });
  }
});

router.post('/checkins', requireAuth, async (req, res) => {
  const { appointment_id, patient_name, method } = req.body;
  let customerId = null;
  if (req.body.customer_id || req.body.patient_id) {
    customerId = await resolveCustomerId(req.params.id, req.body);
    // Se foi fornecido mas e invalido, ainda aceita com patient_name
  }
  if (!customerId && !patient_name) return res.status(400).json({ error: 'customer_id/patient_id ou patient_name obrigatorio' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_checkins (company_id, customer_id, appointment_id, patient_name, method)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *, customer_id AS patient_id`,
      [req.params.id, customerId, appointment_id||null, patient_name||null, method||'manual']
    );
    res.status(201).json({ checkin: rows[0] });
  } catch (err) {
    console.error('[advanced checkins POST]', err.message);
    res.status(500).json({ error: 'Erro ao registrar check-in' });
  }
});

router.patch('/checkins/:cid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status obrigatorio' });
  const tsMap = { called: 'called_at', in_service: 'started_at' };
  const tsField = tsMap[status] ? `, ${tsMap[status]}=NOW()` : '';
  try {
    const { rows } = await db.query(
      `UPDATE dental_checkins SET status=$1${tsField} WHERE id=$2 AND company_id=$3 RETURNING *`,
      [status, req.params.cid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Check-in nao encontrado' });
    res.json({ checkin: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar check-in' }); }
});

// D-21: Public QR check-in
router.post('/checkins/public/:companyId', async (req, res) => {
  const { patient_name, appointment_id } = req.body;
  if (!patient_name) return res.status(400).json({ error: 'patient_name obrigatorio' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_checkins (company_id, patient_name, appointment_id, method)
       VALUES ($1,$2,$3,'qrcode') RETURNING id, patient_name, checked_in_at, status`,
      [req.params.companyId, patient_name, appointment_id||null]
    );
    res.status(201).json({ checkin: rows[0], message: 'Check-in realizado! Aguarde ser chamado(a).' });
  } catch (err) { res.status(500).json({ error: 'Erro no check-in' }); }
});

module.exports = router;
