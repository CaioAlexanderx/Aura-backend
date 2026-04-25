const express = require('express');
const db = require('../config/database');

const router = express.Router({ mergeParams: true });

// ─────────────────────────────────────────────────────────────
// HELPER: 7 fases-padrao criadas automaticamente ao criar tratamento
// ─────────────────────────────────────────────────────────────
const DEFAULT_PHASES = [
  { phase_number: 1, kind: 'planning',        title: 'Planejamento' },
  { phase_number: 2, kind: 'surgery',         title: 'Cirurgia de instalacao' },
  { phase_number: 3, kind: 'osseointegration',title: 'Cicatrizacao osseointegração' },
  { phase_number: 4, kind: 'reopening',       title: 'Reabertura / 2a cirurgia' },
  { phase_number: 5, kind: 'impression',      title: 'Moldagem protetica' },
  { phase_number: 6, kind: 'prosthesis',      title: 'Instalacao da protese' },
  { phase_number: 7, kind: 'followup',        title: 'Acompanhamento' },
];

// ─────────────────────────────────────────────────────────────
// BRANDS
// ─────────────────────────────────────────────────────────────

// GET /dental/implants/brands
// Retorna marcas globais + marcas customizadas da empresa
router.get('/brands', async (req, res) => {
  const { companyId } = req;
  try {
    const { rows } = await db.query(
      `SELECT id, company_id, name, manufacturer, country, notes, is_active, created_at
         FROM dental_implant_brands
        WHERE (company_id IS NULL OR company_id = $1)
          AND is_active = true
        ORDER BY company_id NULLS FIRST, name ASC`,
      [companyId]
    );
    res.json({ brands: rows });
  } catch (err) {
    console.error('GET /dental/implants/brands', err);
    res.status(500).json({ error: 'Erro ao buscar marcas' });
  }
});

// POST /dental/implants/brands
// Cria marca customizada para a empresa
router.post('/brands', async (req, res) => {
  const { companyId } = req;
  const { name, manufacturer, country, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name obrigatorio' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_implant_brands (company_id, name, manufacturer, country, notes)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [companyId, name, manufacturer || null, country || null, notes || null]
    );
    res.status(201).json({ brand: rows[0] });
  } catch (err) {
    console.error('POST /dental/implants/brands', err);
    res.status(500).json({ error: 'Erro ao criar marca' });
  }
});

// DELETE /dental/implants/brands/:brandId
// Soft-delete de marca customizada da empresa (nao pode deletar globais)
router.delete('/brands/:brandId', async (req, res) => {
  const { companyId } = req;
  const { brandId } = req.params;
  try {
    const { rowCount } = await db.query(
      `UPDATE dental_implant_brands
          SET is_active = false
        WHERE id = $1 AND company_id = $2`,
      [brandId, companyId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Marca nao encontrada ou nao pertence a empresa' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /dental/implants/brands/:brandId', err);
    res.status(500).json({ error: 'Erro ao excluir marca' });
  }
});

// ─────────────────────────────────────────────────────────────
// TREATMENTS
// ─────────────────────────────────────────────────────────────

// GET /dental/implants/treatments
// Lista tratamentos com filtros opcionais: status, customer_id, page
router.get('/treatments', async (req, res) => {
  const { companyId } = req;
  const { status, customer_id, page = 1, limit = 30 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const conditions = ['t.company_id = $1'];
  const params = [companyId];
  let idx = 2;

  if (status) {
    conditions.push(`t.status = $${idx++}`);
    params.push(status);
  }
  if (customer_id) {
    conditions.push(`t.customer_id = $${idx++}`);
    params.push(customer_id);
  }

  const where = conditions.join(' AND ');

  try {
    const { rows } = await db.query(
      `SELECT
          t.*,
          c.name  AS patient_name,
          c.phone AS patient_phone,
          p.name  AS practitioner_name,
          (SELECT COUNT(*) FROM dental_implants i WHERE i.treatment_id = t.id AND i.status != 'failed')  AS implant_count,
          (SELECT COUNT(*) FROM dental_implant_phases ph WHERE ph.treatment_id = t.id AND ph.status = 'completed') AS phases_done,
          (SELECT COUNT(*) FROM dental_implant_phases ph WHERE ph.treatment_id = t.id) AS phases_total
        FROM dental_implant_treatments t
        JOIN customers        c ON c.id = t.customer_id
        LEFT JOIN dental_practitioners p ON p.id = t.practitioner_id
       WHERE ${where}
       ORDER BY t.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, Number(limit), offset]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM dental_implant_treatments t WHERE ${where}`,
      params
    );

    res.json({
      treatments: rows,
      total: Number(countRows[0].total),
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    console.error('GET /dental/implants/treatments', err);
    res.status(500).json({ error: 'Erro ao buscar tratamentos' });
  }
});

// POST /dental/implants/treatments
// Cria tratamento + auto-cria as 7 fases padrao (dentro de transacao)
router.post('/treatments', async (req, res) => {
  const { companyId, user } = req;
  const {
    customer_id,
    practitioner_id,
    treatment_plan_id,
    diagnosis,
    surgical_plan,
    surgery_type,
    uses_graft,
    graft_type,
    graft_notes,
    consultation_date,
    surgery_date,
    expected_completion,
    total_value,
    notes,
  } = req.body;

  if (!customer_id) return res.status(400).json({ error: 'customer_id obrigatorio' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Gera numero sequencial
    const { rows: numRows } = await client.query(
      'SELECT implant_treatment_next_number($1) AS num',
      [companyId]
    );
    const treatment_number = numRows[0].num;

    // Cria tratamento
    const { rows: tRows } = await client.query(
      `INSERT INTO dental_implant_treatments
         (company_id, customer_id, practitioner_id, treatment_plan_id,
          treatment_number, diagnosis, surgical_plan, surgery_type,
          uses_graft, graft_type, graft_notes,
          consultation_date, surgery_date, expected_completion,
          total_value, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        companyId, customer_id, practitioner_id || null, treatment_plan_id || null,
        treatment_number, diagnosis || null, surgical_plan || null, surgery_type || null,
        uses_graft || false, graft_type || null, graft_notes || null,
        consultation_date || null, surgery_date || null, expected_completion || null,
        total_value || null, notes || null,
      ]
    );
    const treatment = tRows[0];

    // Auto-cria 7 fases padrao
    for (const ph of DEFAULT_PHASES) {
      await client.query(
        `INSERT INTO dental_implant_phases (treatment_id, phase_number, kind, title)
         VALUES ($1,$2,$3,$4)`,
        [treatment.id, ph.phase_number, ph.kind, ph.title]
      );
    }

    await client.query('COMMIT');

    // Retorna com fases incluidas
    const { rows: phases } = await db.query(
      `SELECT * FROM dental_implant_phases WHERE treatment_id = $1 ORDER BY phase_number`,
      [treatment.id]
    );

    res.status(201).json({ treatment: { ...treatment, phases } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /dental/implants/treatments', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Numero de tratamento duplicado' });
    res.status(500).json({ error: 'Erro ao criar tratamento' });
  } finally {
    client.release();
  }
});

// GET /dental/implants/treatments/:treatmentId
// Retorna tratamento completo com implantes + fases
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
         FROM dental_implant_treatments t
         JOIN customers c ON c.id = t.customer_id
         LEFT JOIN dental_practitioners p ON p.id = t.practitioner_id
        WHERE t.id = $1 AND t.company_id = $2`,
      [treatmentId, companyId]
    );
    if (tRows.length === 0) return res.status(404).json({ error: 'Tratamento nao encontrado' });

    const treatment = tRows[0];

    const [{ rows: implants }, { rows: phases }] = await Promise.all([
      db.query(
        `SELECT i.*, b.name AS brand_name_global,
                s.name AS surgeon_name
           FROM dental_implants i
           LEFT JOIN dental_implant_brands b ON b.id = i.brand_id
           LEFT JOIN dental_practitioners s ON s.id = i.surgeon_id
          WHERE i.treatment_id = $1
          ORDER BY i.tooth_number`,
        [treatmentId]
      ),
      db.query(
        `SELECT ph.*,
                a.scheduled_at AS appointment_date
           FROM dental_implant_phases ph
           LEFT JOIN dental_appointments a ON a.id = ph.appointment_id
          WHERE ph.treatment_id = $1
          ORDER BY ph.phase_number`,
        [treatmentId]
      ),
    ]);

    res.json({ treatment: { ...treatment, implants, phases } });
  } catch (err) {
    console.error('GET /dental/implants/treatments/:treatmentId', err);
    res.status(500).json({ error: 'Erro ao buscar tratamento' });
  }
});

// PATCH /dental/implants/treatments/:treatmentId
// Atualiza dados do tratamento (status, datas, plano cirurgico, etc.)
router.patch('/treatments/:treatmentId', async (req, res) => {
  const { companyId } = req;
  const { treatmentId } = req.params;
  const {
    status, diagnosis, surgical_plan, surgery_type,
    uses_graft, graft_type, graft_notes,
    consultation_date, surgery_date, expected_completion,
    total_value, notes, practitioner_id,
    abandon_reason,
  } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE dental_implant_treatments
          SET status             = COALESCE($3, status),
              diagnosis          = COALESCE($4, diagnosis),
              surgical_plan      = COALESCE($5, surgical_plan),
              surgery_type       = COALESCE($6, surgery_type),
              uses_graft         = COALESCE($7, uses_graft),
              graft_type         = COALESCE($8, graft_type),
              graft_notes        = COALESCE($9, graft_notes),
              consultation_date  = COALESCE($10, consultation_date),
              surgery_date       = COALESCE($11, surgery_date),
              expected_completion= COALESCE($12, expected_completion),
              total_value        = COALESCE($13, total_value),
              notes              = COALESCE($14, notes),
              practitioner_id    = COALESCE($15, practitioner_id),
              completed_at       = CASE WHEN $3 = 'completed' AND completed_at IS NULL THEN NOW() ELSE completed_at END,
              abandoned_at       = CASE WHEN $3 = 'abandoned' AND abandoned_at IS NULL THEN NOW() ELSE abandoned_at END,
              abandon_reason     = COALESCE($16, abandon_reason)
        WHERE id = $1 AND company_id = $2
        RETURNING *`,
      [
        treatmentId, companyId, status || null, diagnosis || null, surgical_plan || null,
        surgery_type || null, uses_graft ?? null, graft_type || null, graft_notes || null,
        consultation_date || null, surgery_date || null, expected_completion || null,
        total_value || null, notes || null, practitioner_id || null, abandon_reason || null,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Tratamento nao encontrado' });
    res.json({ treatment: rows[0] });
  } catch (err) {
    console.error('PATCH /dental/implants/treatments/:treatmentId', err);
    res.status(500).json({ error: 'Erro ao atualizar tratamento' });
  }
});

// ─────────────────────────────────────────────────────────────
// IMPLANTS (pinos individuais)
// ─────────────────────────────────────────────────────────────

// POST /dental/implants/treatments/:treatmentId/implants
// Adiciona implante ao tratamento
router.post('/treatments/:treatmentId/implants', async (req, res) => {
  const { companyId } = req;
  const { treatmentId } = req.params;
  const {
    tooth_number, brand_id, brand_name, model,
    size_diameter_mm, size_length_mm, platform,
    lot_number, expiry_date, inserted_at,
    surgeon_id, insertion_torque, primary_stability,
    surgery_notes, notes,
  } = req.body;

  if (!tooth_number) return res.status(400).json({ error: 'tooth_number obrigatorio' });

  // Verifica que o tratamento pertence a empresa
  const { rows: tRows } = await db.query(
    'SELECT customer_id FROM dental_implant_treatments WHERE id=$1 AND company_id=$2',
    [treatmentId, companyId]
  );
  if (tRows.length === 0) return res.status(404).json({ error: 'Tratamento nao encontrado' });

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_implants
         (company_id, treatment_id, customer_id, tooth_number,
          brand_id, brand_name, model,
          size_diameter_mm, size_length_mm, platform,
          lot_number, expiry_date, installed_at,
          surgeon_id, insertion_torque, primary_stability,
          surgery_notes, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        companyId, treatmentId, tRows[0].customer_id, tooth_number,
        brand_id || null, brand_name || null, model || null,
        size_diameter_mm || null, size_length_mm || null, platform || null,
        lot_number || null, expiry_date || null, inserted_at || null,
        surgeon_id || null, insertion_torque || null, primary_stability || null,
        surgery_notes || null, notes || null,
      ]
    );
    res.status(201).json({ implant: rows[0] });
  } catch (err) {
    console.error('POST /dental/implants/treatments/:treatmentId/implants', err);
    res.status(500).json({ error: 'Erro ao adicionar implante' });
  }
});

// PATCH /dental/implants/treatments/:treatmentId/implants/:implantId
// Atualiza dados do pino (rastreabilidade, status, falha, etc.)
router.patch('/treatments/:treatmentId/implants/:implantId', async (req, res) => {
  const { companyId } = req;
  const { treatmentId, implantId } = req.params;
  const {
    status, lot_number, expiry_date, installed_at,
    insertion_torque, primary_stability, surgery_notes,
    fail_reason, removed_at, notes, brand_id, brand_name,
    model, size_diameter_mm, size_length_mm, platform, surgeon_id,
  } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE dental_implants
          SET status            = COALESCE($3, status),
              lot_number        = COALESCE($4, lot_number),
              expiry_date       = COALESCE($5, expiry_date),
              installed_at      = COALESCE($6, installed_at),
              insertion_torque  = COALESCE($7, insertion_torque),
              primary_stability = COALESCE($8, primary_stability),
              surgery_notes     = COALESCE($9, surgery_notes),
              fail_reason       = COALESCE($10, fail_reason),
              removed_at        = COALESCE($11, removed_at),
              notes             = COALESCE($12, notes),
              brand_id          = COALESCE($13, brand_id),
              brand_name        = COALESCE($14, brand_name),
              model             = COALESCE($15, model),
              size_diameter_mm  = COALESCE($16, size_diameter_mm),
              size_length_mm    = COALESCE($17, size_length_mm),
              platform          = COALESCE($18, platform),
              surgeon_id        = COALESCE($19, surgeon_id),
              failed_at         = CASE WHEN $3 = 'failed' AND failed_at IS NULL THEN NOW() ELSE failed_at END
        WHERE id = $1 AND treatment_id = $2 AND company_id = (
          SELECT company_id FROM dental_implant_treatments WHERE id = $2 AND company_id = ${companyId ? '$20' : 'NULL'}
        )
        RETURNING *`,
      [
        implantId, treatmentId,
        status || null, lot_number || null, expiry_date || null, installed_at || null,
        insertion_torque ?? null, primary_stability || null, surgery_notes || null,
        fail_reason || null, removed_at || null, notes || null,
        brand_id || null, brand_name || null, model || null,
        size_diameter_mm || null, size_length_mm || null, platform || null,
        surgeon_id || null, companyId,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Implante nao encontrado' });
    res.json({ implant: rows[0] });
  } catch (err) {
    console.error('PATCH /dental/implants/treatments/:treatmentId/implants/:implantId', err);
    res.status(500).json({ error: 'Erro ao atualizar implante' });
  }
});

// ─────────────────────────────────────────────────────────────
// PHASES
// ─────────────────────────────────────────────────────────────

// GET /dental/implants/treatments/:treatmentId/phases
router.get('/treatments/:treatmentId/phases', async (req, res) => {
  const { companyId } = req;
  const { treatmentId } = req.params;
  try {
    // Verifica posse
    const { rows: tRows } = await db.query(
      'SELECT id FROM dental_implant_treatments WHERE id=$1 AND company_id=$2',
      [treatmentId, companyId]
    );
    if (tRows.length === 0) return res.status(404).json({ error: 'Tratamento nao encontrado' });

    const { rows } = await db.query(
      `SELECT ph.*,
              a.scheduled_at AS appointment_date
         FROM dental_implant_phases ph
         LEFT JOIN dental_appointments a ON a.id = ph.appointment_id
        WHERE ph.treatment_id = $1
        ORDER BY ph.phase_number`,
      [treatmentId]
    );
    res.json({ phases: rows });
  } catch (err) {
    console.error('GET /dental/implants/treatments/:treatmentId/phases', err);
    res.status(500).json({ error: 'Erro ao buscar fases' });
  }
});

// PATCH /dental/implants/treatments/:treatmentId/phases/:phaseId
// Atualiza fase: data planejada, conclusao, status, vinculo com consulta
router.patch('/treatments/:treatmentId/phases/:phaseId', async (req, res) => {
  const { companyId } = req;
  const { treatmentId, phaseId } = req.params;
  const { status, planned_date, notes, appointment_id, description } = req.body;

  try {
    // Verifica posse via tratamento
    const { rows: tRows } = await db.query(
      'SELECT id FROM dental_implant_treatments WHERE id=$1 AND company_id=$2',
      [treatmentId, companyId]
    );
    if (tRows.length === 0) return res.status(404).json({ error: 'Tratamento nao encontrado' });

    const { rows } = await db.query(
      `UPDATE dental_implant_phases
          SET status         = COALESCE($3, status),
              planned_date   = COALESCE($4, planned_date),
              notes          = COALESCE($5, notes),
              appointment_id = COALESCE($6, appointment_id),
              description    = COALESCE($7, description),
              completed_date = CASE WHEN $3 = 'completed' AND completed_date IS NULL THEN NOW() ELSE completed_date END
        WHERE id = $1 AND treatment_id = $2
        RETURNING *`,
      [phaseId, treatmentId, status || null, planned_date || null, notes || null, appointment_id || null, description || null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Fase nao encontrada' });
    res.json({ phase: rows[0] });
  } catch (err) {
    console.error('PATCH /dental/implants/treatments/:treatmentId/phases/:phaseId', err);
    res.status(500).json({ error: 'Erro ao atualizar fase' });
  }
});

module.exports = router;
