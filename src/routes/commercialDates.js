// src/routes/commercialDates.js
// GET /companies/:id/commercial-dates
// Calendário comercial: próxima ocorrência de cada data, ordenada por proximidade.
// Disponível em todos os planos. Defensivo a schema parcial (tabela ainda não migrada).

const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../config/database');
const { buildUpcoming } = require('../utils/commercialDates');

let catalogTableMissing = false;
let customTableMissing = false;

router.get('/', async (req, res) => {
  const companyId = req.params.id;
  const horizonDays = Math.min(parseInt(req.query.horizon, 10) || 400, 800);

  // Vertical da empresa (best-effort) para resolver vertical_intensity.
  let vertical = null;
  try {
    const cr = await db.query('SELECT vertical_active FROM companies WHERE id = $1', [companyId]);
    if (cr.rows[0]) vertical = cr.rows[0].vertical_active || null;
  } catch (e) { /* coluna pode não existir; ignora */ }

  const entries = [];

  // Catálogo global + override por empresa.
  if (!catalogTableMissing) {
    try {
      const { rows } = await db.query(
        `SELECT cd.slug, cd.name, cd.description, cd.default_intensity, cd.rule_type,
                cd.rule_config, cd.is_period, cd.window_before_days, cd.vertical_intensity,
                s.intensity_override
           FROM commercial_dates cd
           LEFT JOIN company_commercial_date_settings s
             ON s.commercial_date_id = cd.id AND s.company_id = $1
          WHERE cd.is_active = true
            AND COALESCE(s.is_hidden, false) = false`,
        [companyId]
      );
      for (const r of rows) {
        const vi = r.vertical_intensity || {};
        const intensity = r.intensity_override
          || (vertical && vi[vertical])
          || r.default_intensity;
        entries.push({
          slug: r.slug,
          name: r.name,
          description: r.description,
          intensity: intensity,
          rule_type: r.rule_type,
          rule_config: r.rule_config,
          is_period: r.is_period,
          window_before_days: r.window_before_days,
          is_custom: false,
        });
      }
    } catch (e) {
      if (e.code === '42P01') { catalogTableMissing = true; }
      else { console.error('[commercial-dates][catalog]', e.message, e.code); throw e; }
    }
  }

  // Datas próprias do lojista.
  if (!customTableMissing) {
    try {
      const { rows } = await db.query(
        `SELECT id, name, description, intensity, rule_type, rule_config, is_period, window_before_days
           FROM company_custom_commercial_dates
          WHERE company_id = $1 AND is_active = true`,
        [companyId]
      );
      for (const r of rows) {
        entries.push({
          slug: 'custom-' + r.id,
          name: r.name,
          description: r.description,
          intensity: r.intensity,
          rule_type: r.rule_type,
          rule_config: r.rule_config,
          is_period: r.is_period,
          window_before_days: r.window_before_days,
          is_custom: true,
        });
      }
    } catch (e) {
      if (e.code === '42P01') { customTableMissing = true; }
      else { console.error('[commercial-dates][custom]', e.message, e.code); throw e; }
    }
  }

  try {
    const result = buildUpcoming(entries, { horizonDays: horizonDays });
    res.json(result);
  } catch (e) {
    console.error('[commercial-dates][build]', e.message);
    res.status(500).json({ error: 'Erro ao montar o calendário comercial' });
  }
});

module.exports = router;
