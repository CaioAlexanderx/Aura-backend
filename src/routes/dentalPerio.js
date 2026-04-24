// ============================================================
// AURA. — Dental Periograma CRUD (W1-01 f3)
//
// Rotas:
//   GET  /patients/:pid/perio       lista exames periodontais DESC
//   POST /patients/:pid/perio       cria novo exame
//   GET  /perio/:examId             detalhe (view-only pra historico)
//
// D-UNIFY: usa customer_id direto. Um paciente pode ter N exames
// ao longo do tempo (acompanhamento periodontal).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// ── GET /patients/:pid/perio ──
router.get('/patients/:pid/perio', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, customer_id, exam_date, measurements,
              bleeding_sites, total_sites, bleeding_index, plaque_index,
              diagnosis, notes, created_at, updated_at
       FROM dental_perio_exams
       WHERE customer_id = $1 AND company_id = $2
       ORDER BY exam_date DESC, created_at DESC`,
      [req.params.pid, req.params.id]
    );
    res.json({
      patient_id: req.params.pid,
      count: rows.length,
      charts: rows,
    });
  } catch (err) {
    console.error('[dentalPerio GET list]', err.message);
    res.status(500).json({ error: 'Erro ao buscar exames periodontais' });
  }
});

// ── POST /patients/:pid/perio ──
router.post('/patients/:pid/perio', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const {
    exam_date,
    measurements = {},
    bleeding_sites = 0,
    total_sites = 0,
    bleeding_index = 0,
    plaque_index = 0,
    diagnosis,
    notes,
  } = req.body;

  // Validacao basica — CHECK constraints do DB tambem protegem
  if (bleeding_index < 0 || bleeding_index > 100) {
    return res.status(400).json({ error: 'bleeding_index deve estar entre 0 e 100' });
  }
  if (plaque_index < 0 || plaque_index > 100) {
    return res.status(400).json({ error: 'plaque_index deve estar entre 0 e 100' });
  }
  if (measurements && (typeof measurements !== 'object' || Array.isArray(measurements))) {
    return res.status(400).json({ error: 'measurements deve ser um objeto' });
  }

  // Valida que paciente existe e e do company
  const { rows: pat } = await db.query(
    `SELECT id FROM customers
     WHERE id = $1 AND company_id = $2 AND is_patient = true`,
    [req.params.pid, req.params.id]
  );
  if (!pat.length) {
    return res.status(404).json({ error: 'Paciente nao encontrado' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_perio_exams
         (company_id, customer_id, exam_date, measurements,
          bleeding_sites, total_sites, bleeding_index, plaque_index,
          diagnosis, notes, created_by)
       VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4::jsonb,
               $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        req.params.id, req.params.pid, exam_date || null,
        JSON.stringify(measurements || {}),
        bleeding_sites | 0, total_sites | 0,
        bleeding_index | 0, plaque_index | 0,
        diagnosis || null, notes || null,
        req.user?.id || null,
      ]
    );
    res.status(201).json({ exam: rows[0] });
  } catch (err) {
    console.error('[dentalPerio POST]', err.message);
    res.status(500).json({ error: 'Erro ao salvar exame periodontal' });
  }
});

// ── GET /perio/:examId ──
router.get('/perio/:examId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM dental_perio_exams
       WHERE id = $1 AND company_id = $2`,
      [req.params.examId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Exame nao encontrado' });
    res.json({ exam: rows[0] });
  } catch (err) {
    console.error('[dentalPerio GET detail]', err.message);
    res.status(500).json({ error: 'Erro ao buscar exame' });
  }
});

module.exports = router;
