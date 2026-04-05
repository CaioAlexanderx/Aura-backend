// ============================================================
// AURA. — S11 D-18/D-19/D-20/D-21: Specialty, Perio, Waitlist, Checkin
// Mounted at: /companies/:id/dental/advanced
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const crypto  = require('crypto');

// ===== D-18: SPECIALTY FORMS =====

router.get('/specialty/:patientId', requireAuth, async (req, res) => {
  const { specialty } = req.query;
  try {
    const params = [req.params.id, req.params.patientId];
    let where = 'WHERE company_id=$1 AND patient_id=$2';
    if (specialty) { params.push(specialty); where += ` AND specialty=$${params.length}`; }
    const { rows } = await db.query(
      `SELECT * FROM dental_specialty_forms ${where} ORDER BY created_at DESC`, params
    );
    res.json({ total: rows.length, forms: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar fichas' }); }
});

router.post('/specialty', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { patient_id, specialty, form_data, professional_id, appointment_id, notes } = req.body;
  if (!patient_id || !specialty || !form_data) return res.status(400).json({ error: 'patient_id, specialty e form_data obrigatórios' });
  const validSpecialties = ['ortodontia','endodontia','periodontia','cirurgia','implante','protese','odontopediatria'];
  if (!validSpecialties.includes(specialty)) return res.status(400).json({ error: 'Especialidade inválida. Opções: ' + validSpecialties.join(', ') });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_specialty_forms (company_id, patient_id, specialty, form_data, professional_id, appointment_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, patient_id, specialty, JSON.stringify(form_data), professional_id||null, appointment_id||null, notes||null]
    );
    res.status(201).json({ form: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar ficha' }); }
});

// ===== D-19: PERIODONTAL CHART =====

router.get('/perio/:patientId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM dental_periodontal_chart WHERE company_id=$1 AND patient_id=$2 ORDER BY exam_date DESC`,
      [req.params.id, req.params.patientId]
    );
    res.json({ total: rows.length, charts: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar periograma' }); }
});

router.post('/perio', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { patient_id, professional_id, exam_date, measurements, bleeding_sites, total_sites, plaque_index, diagnosis, notes } = req.body;
  if (!patient_id || !measurements) return res.status(400).json({ error: 'patient_id e measurements obrigatórios' });
  const bleedingIdx = total_sites > 0 ? Math.round((bleeding_sites || 0) / total_sites * 10000) / 100 : 0;
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_periodontal_chart (company_id, patient_id, professional_id, exam_date, measurements, bleeding_sites, total_sites, bleeding_index, plaque_index, diagnosis, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, patient_id, professional_id||null, exam_date||new Date().toISOString().split('T')[0],
       JSON.stringify(measurements), bleeding_sites||0, total_sites||0, bleedingIdx, plaque_index||0, diagnosis||null, notes||null]
    );
    res.status(201).json({ chart: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar periograma' }); }
});

// ===== D-20: WAITLIST =====

router.get('/waitlist', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT w.*, dp.full_name AS patient_full_name FROM dental_waitlist w
       LEFT JOIN dental_patients dp ON dp.id=w.patient_id
       WHERE w.company_id=$1 AND w.status IN ('aguardando','notificado')
       ORDER BY CASE w.urgency WHEN 'prioritario' THEN 1 WHEN 'urgente' THEN 2 ELSE 3 END, w.created_at`,
      [req.params.id]
    );
    res.json({ total: rows.length, waitlist: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar lista de espera' }); }
});

router.post('/waitlist', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { patient_id, patient_name, patient_phone, procedure_name, professional_id, preferred_days, preferred_time, urgency, notes } = req.body;
  if (!patient_name) return res.status(400).json({ error: 'patient_name obrigatório' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_waitlist (company_id, patient_id, patient_name, patient_phone, procedure_name, professional_id, preferred_days, preferred_time, urgency, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.id, patient_id||null, patient_name, patient_phone||null, procedure_name||null, professional_id||null,
       JSON.stringify(preferred_days||[]), preferred_time||null, urgency||'normal', notes||null]
    );
    res.status(201).json({ entry: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao adicionar à lista' }); }
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
    if (!rows.length) return res.status(404).json({ error: 'Entrada não encontrada' });
    res.json({ entry: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar' }); }
});

// ===== D-21: CHECK-IN =====

router.get('/checkins', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows } = await db.query(
      `SELECT c.*, dp.full_name AS patient_full_name FROM dental_checkins c
       LEFT JOIN dental_patients dp ON dp.id=c.patient_id
       WHERE c.company_id=$1 AND c.checked_in_at::date=$2
       ORDER BY c.checked_in_at DESC`,
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
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar check-ins' }); }
});

router.post('/checkins', requireAuth, async (req, res) => {
  const { patient_id, appointment_id, patient_name, method } = req.body;
  if (!patient_id && !patient_name) return res.status(400).json({ error: 'patient_id ou patient_name obrigatório' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_checkins (company_id, patient_id, appointment_id, patient_name, method)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, patient_id||null, appointment_id||null, patient_name||null, method||'manual']
    );
    res.status(201).json({ checkin: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao registrar check-in' }); }
});

router.patch('/checkins/:cid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status obrigatório' });
  const tsMap = { called: 'called_at', in_service: 'started_at' };
  const tsField = tsMap[status] ? `, ${tsMap[status]}=NOW()` : '';
  try {
    const { rows } = await db.query(
      `UPDATE dental_checkins SET status=$1${tsField} WHERE id=$2 AND company_id=$3 RETURNING *`,
      [status, req.params.cid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Check-in não encontrado' });
    res.json({ checkin: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar check-in' }); }
});

// D-21: Public QR check-in (no auth required)
router.post('/checkins/public/:companyId', async (req, res) => {
  const { patient_name, patient_phone, appointment_id } = req.body;
  if (!patient_name) return res.status(400).json({ error: 'patient_name obrigatório' });
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
