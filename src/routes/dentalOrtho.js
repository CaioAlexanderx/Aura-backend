const express = require('express');
const db = require('../config/database');

const router = express.Router({ mergeParams: true });

// ─────────────────────────────────────────────────────────────
// APPLIANCE TYPE / SESSION TYPE helpers (validacao)
// ─────────────────────────────────────────────────────────────
const VALID_APPLIANCE = [
  'brackets_metal', 'brackets_ceramic', 'brackets_sapphire',
  'alinhadores', 'retainer', 'expansor', 'aparelho_movel', 'outro',
];

const VALID_SESSION_TYPE = [
  'avaliacao', 'instalacao', 'adjustment', 'wire_change',
  'bracket_repair', 'retainer_check', 'removal', 'photos',
  'xray', 'other',
];

// ─────────────────────────────────────────────────────────────
// TREATMENTS — lista e detalhe
// ─────────────────────────────────────────────────────────────

// GET /dental/ortho/treatments
// Filtros opcionais: status, customer_id, page, limit
router.get('/treatments', async (req, res) => {
  const { companyId } = req;
  const { status, customer_id, page = 1, limit = 30 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const conditions = ['t.company_id = $1'];
  const params = [companyId];
  let idx = 2;

  if (status) { conditions.push(`t.status = $${idx++}`); params.push(status); }
  if (customer_id) { conditions.push(`t.customer_id = $${idx++}`); params.push(customer_id); }

  const where = conditions.join(' AND ');

  try {
    const { rows } = await db.query(
      `SELECT
          t.*,
          c.name  AS patient_name,
          c.phone AS patient_phone,
          p.name  AS practitioner_name,
          (SELECT COUNT(*) FROM dental_ortho_sessions s WHERE s.treatment_id = t.id AND s.status = 'completed') AS sessions_done,
          (SELECT COUNT(*) FROM dental_ortho_sessions s WHERE s.treatment_id = t.id) AS sessions_total
        FROM dental_ortho_treatments t
        JOIN customers c ON c.id = t.customer_id
        LEFT JOIN dental_practitioners p ON p.id = t.practitioner_id
       WHERE ${where}
       ORDER BY t.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, Number(limit), offset]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM dental_ortho_treatments t WHERE ${where}`,
      params
    );

    res.json({
      treatments: rows,
      total: Number(countRows[0].total),
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    console.error('GET /dental/ortho/treatments', err);
    res.status(500).json({ error: 'Erro ao buscar tratamentos ortodonticos' });
  }
});

// POST /dental/ortho/treatments
// Cria tratamento. Nao auto-cria sessoes — dentista adiciona conforme evolucao.
router.post('/treatments', async (req, res) => {
  const { companyId } = req;
  const {
    customer_id, practitioner_id, treatment_plan_id,
    appliance_type, arch, status,
    start_date, expected_end_date, estimated_duration_months,
    total_sessions_planned, total_value,
    chief_complaint, diagnosis, notes,
  } = req.body;

  if (!customer_id) return res.status(400).json({ error: 'customer_id obrigatorio' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: numRows } = await client.query(
      'SELECT ortho_treatment_next_number($1) AS num',
      [companyId]
    );
    const treatment_number = numRows[0].num;

    const { rows } = await client.query(
      `INSERT INTO dental_ortho_treatments
         (company_id, customer_id, practitioner_id, treatment_plan_id,
          treatment_number, appliance_type, arch, status,
          start_date, expected_end_date,
          estimated_duration_months, total_sessions_planned,
          total_value, chief_complaint, diagnosis, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        companyId,
        customer_id,
        practitioner_id || null,
        treatment_plan_id || null,
        treatment_number,
        appliance_type || 'brackets_metal',
        arch || 'both',
        status || 'planning',
        start_date || null,
        expected_end_date || null,
        estimated_duration_months || 18,
        total_sessions_planned || 18,
        total_value || null,
        chief_complaint || null,
        diagnosis || null,
        notes || null,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ treatment: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /dental/ortho/treatments', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Numero de tratamento duplicado' });
    res.status(500).json({ error: 'Erro ao criar tratamento ortodontico' });
  } finally {
    client.release();
  }
});

// GET /dental/ortho/treatments/:treatmentId
// Detalhe completo com sessoes
router.get('/treatments/:treatmentId', async (req, res) => {
  const { companyId } = req;
  const { treatmentId } = req.params;
  try {
    const { rows: tRows } = await db.query(
      `SELECT t.*,
              c.name  AS patient_name,
              c.phone AS patient_phone,
              c.email AS patient_email,
              p.name  AS practitioner_name
         FROM dental_ortho_treatments t
         JOIN customers c ON c.id = t.customer_id
         LEFT JOIN dental_practitioners p ON p.id = t.practitioner_id
        WHERE t.id = $1 AND t.company_id = $2`,
      [treatmentId, companyId]
    );
    if (tRows.length === 0) return res.status(404).json({ error: 'Tratamento nao encontrado' });

    const { rows: sessions } = await db.query(
      `SELECT s.*,
              a.scheduled_at AS appointment_date
         FROM dental_ortho_sessions s
         LEFT JOIN dental_appointments a ON a.id = s.appointment_id
        WHERE s.treatment_id = $1
        ORDER BY s.session_number`,
      [treatmentId]
    );

    res.json({ treatment: { ...tRows[0], sessions } });
  } catch (err) {
    console.error('GET /dental/ortho/treatments/:treatmentId', err);
    res.status(500).json({ error: 'Erro ao buscar tratamento' });
  }
});

// PATCH /dental/ortho/treatments/:treatmentId
router.patch('/treatments/:treatmentId', async (req, res) => {
  const { companyId } = req;
  const { treatmentId } = req.params;
  const {
    status, appliance_type, arch,
    start_date, expected_end_date, estimated_duration_months,
    total_sessions_planned, total_value,
    chief_complaint, diagnosis, notes,
    practitioner_id, abandon_reason,
  } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE dental_ortho_treatments
          SET status                    = COALESCE($3, status),
              appliance_type            = COALESCE($4, appliance_type),
              arch                      = COALESCE($5, arch),
              start_date                = COALESCE($6, start_date),
              expected_end_date         = COALESCE($7, expected_end_date),
              estimated_duration_months = COALESCE($8, estimated_duration_months),
              total_sessions_planned    = COALESCE($9, total_sessions_planned),
              total_value               = COALESCE($10, total_value),
              chief_complaint           = COALESCE($11, chief_complaint),
              diagnosis                 = COALESCE($12, diagnosis),
              notes                     = COALESCE($13, notes),
              practitioner_id           = COALESCE($14, practitioner_id),
              abandon_reason            = COALESCE($15, abandon_reason),
              completed_at = CASE WHEN $3 = 'completed' AND completed_at IS NULL THEN NOW() ELSE completed_at END,
              abandoned_at = CASE WHEN $3 = 'abandoned' AND abandoned_at IS NULL THEN NOW() ELSE abandoned_at END
        WHERE id = $1 AND company_id = $2
        RETURNING *`,
      [
        treatmentId, companyId,
        status || null, appliance_type || null, arch || null,
        start_date || null, expected_end_date || null,
        estimated_duration_months ?? null, total_sessions_planned ?? null,
        total_value ?? null, chief_complaint || null, diagnosis || null,
        notes || null, practitioner_id || null, abandon_reason || null,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Tratamento nao encontrado' });
    res.json({ treatment: rows[0] });
  } catch (err) {
    console.error('PATCH /dental/ortho/treatments/:treatmentId', err);
    res.status(500).json({ error: 'Erro ao atualizar tratamento' });
  }
});

// ─────────────────────────────────────────────────────────────
// SESSIONS
// ─────────────────────────────────────────────────────────────

// POST /dental/ortho/treatments/:treatmentId/sessions
// Adiciona sessao ao tratamento
router.post('/treatments/:treatmentId/sessions', async (req, res) => {
  const { companyId } = req;
  const { treatmentId } = req.params;
  const {
    session_number, session_type, planned_date,
    wire_upper, wire_lower, procedures, evolution,
    next_interval_weeks, notes, appointment_id,
  } = req.body;

  // Verifica posse
  const { rows: tRows } = await db.query(
    'SELECT customer_id FROM dental_ortho_treatments WHERE id=$1 AND company_id=$2',
    [treatmentId, companyId]
  );
  if (tRows.length === 0) return res.status(404).json({ error: 'Tratamento nao encontrado' });

  // Calcula proximo numero se nao fornecido
  let sNum = session_number;
  if (!sNum) {
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(session_number), 0) + 1 AS next FROM dental_ortho_sessions WHERE treatment_id = $1',
      [treatmentId]
    );
    sNum = maxRows[0].next;
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_ortho_sessions
         (treatment_id, company_id, customer_id, session_number,
          session_type, appointment_id, planned_date,
          wire_upper, wire_lower, procedures, evolution,
          next_interval_weeks, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        treatmentId, companyId, tRows[0].customer_id, sNum,
        session_type || 'adjustment',
        appointment_id || null,
        planned_date || null,
        wire_upper || null, wire_lower || null,
        procedures || null, evolution || null,
        next_interval_weeks || 4,
        notes || null,
      ]
    );
    res.status(201).json({ session: rows[0] });
  } catch (err) {
    console.error('POST /dental/ortho/treatments/:treatmentId/sessions', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Numero de sessao ja existe neste tratamento' });
    res.status(500).json({ error: 'Erro ao criar sessao' });
  }
});

// GET /dental/ortho/treatments/:treatmentId/sessions
router.get('/treatments/:treatmentId/sessions', async (req, res) => {
  const { companyId } = req;
  const { treatmentId } = req.params;
  try {
    const { rows: tRows } = await db.query(
      'SELECT id FROM dental_ortho_treatments WHERE id=$1 AND company_id=$2',
      [treatmentId, companyId]
    );
    if (tRows.length === 0) return res.status(404).json({ error: 'Tratamento nao encontrado' });

    const { rows } = await db.query(
      `SELECT s.*, a.scheduled_at AS appointment_date
         FROM dental_ortho_sessions s
         LEFT JOIN dental_appointments a ON a.id = s.appointment_id
        WHERE s.treatment_id = $1
        ORDER BY s.session_number`,
      [treatmentId]
    );
    res.json({ sessions: rows });
  } catch (err) {
    console.error('GET /dental/ortho/treatments/:treatmentId/sessions', err);
    res.status(500).json({ error: 'Erro ao buscar sessoes' });
  }
});

// PATCH /dental/ortho/treatments/:treatmentId/sessions/:sessionId
// Atualiza sessao: concluir, registrar fio, evolucao, etc.
router.patch('/treatments/:treatmentId/sessions/:sessionId', async (req, res) => {
  const { companyId } = req;
  const { treatmentId, sessionId } = req.params;
  const {
    status, session_type, planned_date,
    wire_upper, wire_lower, procedures, evolution,
    next_interval_weeks, notes, appointment_id,
  } = req.body;

  try {
    // Verifica posse via tratamento
    const { rows: tRows } = await db.query(
      'SELECT id FROM dental_ortho_treatments WHERE id=$1 AND company_id=$2',
      [treatmentId, companyId]
    );
    if (tRows.length === 0) return res.status(404).json({ error: 'Tratamento nao encontrado' });

    const { rows } = await db.query(
      `UPDATE dental_ortho_sessions
          SET status               = COALESCE($3, status),
              session_type         = COALESCE($4, session_type),
              planned_date         = COALESCE($5, planned_date),
              wire_upper           = COALESCE($6, wire_upper),
              wire_lower           = COALESCE($7, wire_lower),
              procedures           = COALESCE($8, procedures),
              evolution            = COALESCE($9, evolution),
              next_interval_weeks  = COALESCE($10, next_interval_weeks),
              notes                = COALESCE($11, notes),
              appointment_id       = COALESCE($12, appointment_id),
              completed_date = CASE WHEN $3 = 'completed' AND completed_date IS NULL THEN NOW() ELSE completed_date END
        WHERE id = $1 AND treatment_id = $2
        RETURNING *`,
      [
        sessionId, treatmentId,
        status || null, session_type || null, planned_date || null,
        wire_upper || null, wire_lower || null,
        procedures || null, evolution || null,
        next_interval_weeks ?? null, notes || null, appointment_id || null,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Sessao nao encontrada' });
    res.json({ session: rows[0] });
  } catch (err) {
    console.error('PATCH /dental/ortho/treatments/:treatmentId/sessions/:sessionId', err);
    res.status(500).json({ error: 'Erro ao atualizar sessao' });
  }
});

module.exports = router;
