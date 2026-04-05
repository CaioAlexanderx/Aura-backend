// ============================================================
// AURA. — S11 D-16/D-17: Dental Insurance + TISS Guides
// Mounted at: /companies/:id/dental/insurance
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// ===== D-16: INSURANCE (Convênios) =====

router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT i.*,
        (SELECT COUNT(*)::int FROM dental_insurance_procedures p WHERE p.insurance_id=i.id) AS procedures_count
       FROM dental_insurance i WHERE i.company_id=$1 ORDER BY i.is_active DESC, i.name`,
      [req.params.id]
    );
    res.json({ total: rows.length, insurance: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar convênios' }); }
});

router.post('/', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { name, registration, ans_code, contact_phone, contact_email, default_discount_pct, payment_deadline_days, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name obrigatório' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_insurance (company_id, name, registration, ans_code, contact_phone, contact_email, default_discount_pct, payment_deadline_days, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, name, registration||null, ans_code||null, contact_phone||null, contact_email||null, default_discount_pct||0, payment_deadline_days||30, notes||null]
    );
    res.status(201).json({ insurance: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao criar convênio' }); }
});

// TUSS codes (global, read-only for clients)
router.get('/tuss', requireAuth, async (req, res) => {
  const { specialty, search } = req.query;
  try {
    const params = [];
    let where = 'WHERE is_active=true';
    if (specialty) { params.push(specialty); where += ` AND specialty=$${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND (code ILIKE $${params.length} OR description ILIKE $${params.length})`; }
    const { rows } = await db.query(`SELECT * FROM dental_tuss_codes ${where} ORDER BY code LIMIT 100`, params);
    res.json({ total: rows.length, codes: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar TUSS' }); }
});

// Insurance procedures (tabela do convênio)
router.get('/:insId/procedures', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM dental_insurance_procedures WHERE insurance_id=$1 ORDER BY tuss_code', [req.params.insId]
    );
    res.json({ total: rows.length, procedures: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar procedimentos' }); }
});

router.post('/:insId/procedures', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { tuss_code, tuss_description, covered_price, requires_auth, notes } = req.body;
  if (!tuss_code || covered_price === undefined) return res.status(400).json({ error: 'tuss_code e covered_price obrigatórios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_insurance_procedures (insurance_id, tuss_code, tuss_description, covered_price, requires_auth, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.insId, tuss_code, tuss_description||null, covered_price, requires_auth||false, notes||null]
    );
    res.status(201).json({ procedure: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao adicionar procedimento' }); }
});

// ===== D-17: TISS GUIDES =====

router.get('/tiss', requireAuth, async (req, res) => {
  const { status } = req.query;
  try {
    const params = [req.params.id];
    let where = 'WHERE g.company_id=$1';
    if (status) { params.push(status); where += ` AND g.status=$${params.length}`; }
    const { rows } = await db.query(
      `SELECT g.*, dp.full_name AS patient_name, di.name AS insurance_name
       FROM dental_tiss_guides g
       JOIN dental_patients dp ON dp.id=g.patient_id
       JOIN dental_insurance di ON di.id=g.insurance_id
       ${where} ORDER BY g.created_at DESC LIMIT 50`, params
    );
    const { rows: stats } = await db.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_value),0)::numeric AS total
       FROM dental_tiss_guides WHERE company_id=$1 GROUP BY status`, [req.params.id]
    );
    res.json({ guides: rows, stats });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar guias' }); }
});

router.post('/tiss', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { patient_id, insurance_id, treatment_plan_id, procedures, professional_id, professional_cro } = req.body;
  if (!patient_id || !insurance_id || !procedures?.length) return res.status(400).json({ error: 'patient_id, insurance_id e procedures obrigatórios' });
  const totalValue = procedures.reduce((s, p) => s + (p.value || 0), 0);
  try {
    const { rows: configs } = await db.query('SELECT COUNT(*)::int AS c FROM dental_tiss_guides WHERE company_id=$1', [req.params.id]);
    const guideNumber = `GTO-${String((configs[0]?.c || 0) + 1).padStart(6, '0')}`;
    const { rows } = await db.query(
      `INSERT INTO dental_tiss_guides (company_id, patient_id, insurance_id, treatment_plan_id, guide_number, procedures, total_value, professional_id, professional_cro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, patient_id, insurance_id, treatment_plan_id||null, guideNumber, JSON.stringify(procedures), totalValue, professional_id||null, professional_cro||null]
    );
    res.status(201).json({ guide: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao criar guia TISS' }); }
});

router.patch('/tiss/:guideId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { status, authorized_value, denied_reason } = req.body;
  const fields = [], values = []; let idx = 1;
  if (status) {
    fields.push(`status=$${idx++}`); values.push(status);
    if (status === 'autorizada') fields.push('authorized_at=NOW()');
    if (status === 'enviada') fields.push('sent_at=NOW()');
  }
  if (authorized_value !== undefined) { fields.push(`authorized_value=$${idx++}`); values.push(authorized_value); }
  if (denied_reason) { fields.push(`denied_reason=$${idx++}`); values.push(denied_reason); }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo' });
  fields.push('updated_at=NOW()'); values.push(req.params.guideId, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE dental_tiss_guides SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Guia não encontrada' });
    res.json({ guide: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar guia' }); }
});

module.exports = router;
