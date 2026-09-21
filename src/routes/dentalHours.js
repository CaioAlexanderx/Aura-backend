// ============================================================
// AURA. — Horário de funcionamento do consultório odonto
// Montado em /companies/:id/dental (routes/dental.js)
//
//   GET /hours   → { configured, hours, default_interval_min, grid, suggestion }
//   PUT /hours   → grava (400 com mensagens por dia/turno)
//
// Um horário por empresa (company_id): no multi-CNPJ cada unidade é uma
// company e tem o seu. Regras e formato em services/dentalHours.js.
// Tabela: dental_clinic_hours (migration 346).
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const H = require('../services/dentalHours');

function payload(clinic) {
  const hours = clinic.configured ? clinic.hours : null;
  return {
    configured: clinic.configured,
    hours,
    default_interval_min: clinic.default_interval_min,
    // Faixa da grade da agenda (sem horário salvo: 07–19, como hoje).
    grid: H.gridRange(hours),
    suggestion: H.suggestion(),
  };
}

router.get('/hours', requireAuth, async (req, res) => {
  try {
    const clinic = await H.loadClinicHours(db, req.params.id);
    res.json(payload(clinic));
  } catch (err) {
    console.error('[dentalHours GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar horário de funcionamento' });
  }
});

router.put('/hours', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { hours, default_interval_min } = req.body || {};
  const v = H.validateHours(hours, default_interval_min);
  if (!v.ok) {
    return res.status(400).json({
      error: v.errors[0].message,
      code: 'INVALID_BUSINESS_HOURS',
      errors: v.errors,
    });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_clinic_hours (company_id, business_hours, default_interval_min)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (company_id) DO UPDATE
         SET business_hours       = EXCLUDED.business_hours,
             default_interval_min = EXCLUDED.default_interval_min,
             updated_at           = NOW()
       RETURNING business_hours, default_interval_min`,
      [req.params.id, JSON.stringify(v.hours), v.default_interval_min]
    );
    const saved = rows[0] || { business_hours: v.hours, default_interval_min: v.default_interval_min };
    res.json(payload({
      configured: true,
      hours: H.normalizeStored(saved.business_hours),
      default_interval_min: saved.default_interval_min ?? null,
    }));
  } catch (err) {
    console.error('[dentalHours PUT]', err.message);
    res.status(500).json({ error: 'Erro ao salvar horário de funcionamento' });
  }
});

module.exports = router;
