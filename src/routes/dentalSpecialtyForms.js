// ============================================================
// AURA. — Dental Specialty Forms CRUD (W1-01 f3)
//
// Fichas clinicas por especialidade. 6 specialties suportadas
// (CHECK constraint no DB): ortodontia, endodontia, periodontia,
// cirurgia, implante, protese.
//
// Rotas:
//   GET  /patients/:pid/specialty-forms              lista forms do paciente
//   POST /patients/:pid/specialty-forms              cria form novo
//   GET  /specialty-forms/:formId                    detalhe
//
// form_data eh jsonb flexivel — estrutura varia por specialty.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const VALID_SPECIALTIES = ['ortodontia','endodontia','periodontia','cirurgia','implante','protese'];

// ── GET /patients/:pid/specialty-forms ──
router.get('/patients/:pid/specialty-forms', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT sf.id, sf.customer_id AS patient_id, sf.specialty, sf.form_data,
              sf.professional_id, sf.notes, sf.created_at, sf.updated_at,
              p.name AS professional_name
       FROM dental_specialty_forms sf
       LEFT JOIN dental_practitioners p ON p.id = sf.professional_id
       WHERE sf.customer_id = $1 AND sf.company_id = $2
       ORDER BY sf.created_at DESC`,
      [req.params.pid, req.params.id]
    );
    res.json({
      patient_id: req.params.pid,
      count: rows.length,
      forms: rows,
    });
  } catch (err) {
    console.error('[dentalSpecialtyForms GET list]', err.message);
    res.status(500).json({ error: 'Erro ao buscar fichas' });
  }
});

// ── POST /patients/:pid/specialty-forms ──
router.post('/patients/:pid/specialty-forms', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { specialty, form_data = {}, professional_id, notes } = req.body;

  if (!specialty || !VALID_SPECIALTIES.includes(specialty)) {
    return res.status(400).json({
      error: `specialty deve ser um de: ${VALID_SPECIALTIES.join(', ')}`,
    });
  }
  if (form_data && (typeof form_data !== 'object' || Array.isArray(form_data))) {
    return res.status(400).json({ error: 'form_data deve ser um objeto' });
  }

  // Valida paciente
  const { rows: pat } = await db.query(
    `SELECT id FROM customers
     WHERE id = $1 AND company_id = $2 AND is_patient = true`,
    [req.params.pid, req.params.id]
  );
  if (!pat.length) {
    return res.status(404).json({ error: 'Paciente nao encontrado' });
  }

  // Valida professional_id (se fornecido) pertence ao company
  if (professional_id) {
    const { rows: prof } = await db.query(
      `SELECT id FROM dental_practitioners
       WHERE id = $1 AND company_id = $2`,
      [professional_id, req.params.id]
    );
    if (!prof.length) {
      return res.status(400).json({ error: 'Profissional invalido' });
    }
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_specialty_forms
         (company_id, customer_id, specialty, form_data, professional_id, notes, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING *`,
      [
        req.params.id, req.params.pid, specialty,
        JSON.stringify(form_data || {}),
        professional_id || null,
        notes || null,
        req.user?.id || null,
      ]
    );
    res.status(201).json({ form: rows[0] });
  } catch (err) {
    console.error('[dentalSpecialtyForms POST]', err.message);
    res.status(500).json({ error: 'Erro ao salvar ficha' });
  }
});

// ── GET /specialty-forms/:formId ──
router.get('/specialty-forms/:formId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT sf.*, p.name AS professional_name
       FROM dental_specialty_forms sf
       LEFT JOIN dental_practitioners p ON p.id = sf.professional_id
       WHERE sf.id = $1 AND sf.company_id = $2`,
      [req.params.formId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ficha nao encontrada' });
    res.json({ form: rows[0] });
  } catch (err) {
    console.error('[dentalSpecialtyForms GET detail]', err.message);
    res.status(500).json({ error: 'Erro ao buscar ficha' });
  }
});

module.exports = router;
