// ============================================================
// AURA Studio — rotas do vertical (Fase 0 + Fase 1)
// 24/05/2026
//
// Endpoints:
//   GET  /companies/:id/studio/health
//   GET  /companies/:id/studio/products/:pid/customization-config
//   PUT  /companies/:id/studio/products/:pid/customization-config
//   POST /companies/:id/studio/products/:pid/personalize
//
// Gate de plano (requirePlan('expansao')) é aplicado no mount em
// src/routes/private.js. Não duplicar aqui.
//
// Doc: Projects/Aura/BACKLOG_AURA_STUDIO.md
// Memory: plano_aura_studio_vertical_24mai2026
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

// ─── Schema da customization_config ─────────────────────────
// {
//   print_area: { width_cm: number, height_cm: number, position: 'center'|'left'|'right' },
//   fields: [
//     { id: string, type: 'text'|'image'|'template'|'color'|'option',
//       label: string, required: boolean,
//       config: { max_chars?, fonts?, colors?, formats?, max_mb?, choices? } }
//   ]
// }
const VALID_FIELD_TYPES = ['text', 'image', 'template', 'color', 'option'];
const VALID_POSITIONS   = ['center', 'left', 'right'];

function validateCustomizationConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'config obrigatório';
  if (!cfg.print_area || typeof cfg.print_area !== 'object') return 'print_area obrigatório';
  const pa = cfg.print_area;
  if (typeof pa.width_cm !== 'number' || pa.width_cm <= 0) return 'print_area.width_cm inválido';
  if (typeof pa.height_cm !== 'number' || pa.height_cm <= 0) return 'print_area.height_cm inválido';
  if (pa.position && !VALID_POSITIONS.includes(pa.position)) return 'print_area.position inválido (center/left/right)';
  if (!Array.isArray(cfg.fields)) return 'fields deve ser array';
  if (cfg.fields.length === 0) return 'pelo menos 1 field obrigatório';
  if (cfg.fields.length > 12) return 'máximo 12 fields por produto';
  for (const [i, f] of cfg.fields.entries()) {
    if (!f.id || typeof f.id !== 'string') return `fields[${i}].id obrigatório`;
    if (!f.type || !VALID_FIELD_TYPES.includes(f.type)) return `fields[${i}].type inválido (text/image/template/color/option)`;
    if (!f.label || typeof f.label !== 'string') return `fields[${i}].label obrigatório`;
    if (typeof f.required !== 'boolean') return `fields[${i}].required deve ser boolean`;
  }
  return null;
}

// ─── GET /health ────────────────────────────────────────────
// Sentinel do vertical: prova que /studio está montado e retorna
// se a empresa tem o toggle ligado.
router.get('/health', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT
         COALESCE((pdv_settings->>'studio_enabled')::boolean, false)         AS enabled,
         COALESCE((pdv_settings->>'studio_kds_enabled')::boolean, false)     AS kds_enabled,
         COALESCE((pdv_settings->>'studio_gallery_enabled')::boolean, false) AS gallery_enabled,
         COALESCE((pdv_settings->>'studio_approval_enabled')::boolean, false) AS approval_enabled,
         COALESCE(pdv_settings->>'studio_approval_mode', 'wa_me')            AS approval_mode,
         COALESCE(studio_settings, '{}'::jsonb)                              AS settings
       FROM companies
       WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    res.json({
      vertical: 'studio',
      version: 0,
      ...r.rows[0],
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[studio/health]', err.message);
    res.status(500).json({ error: 'Erro ao consultar Studio' });
  }
});

// ─── GET /products/:pid/customization-config ────────────────
router.get('/products/:pid/customization-config', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT id, name, is_personalizable, customization_config
         FROM products
        WHERE id = $1 AND company_id = $2
        LIMIT 1`,
      [req.params.pid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json({
      product_id: r.rows[0].id,
      name: r.rows[0].name,
      is_personalizable: Boolean(r.rows[0].is_personalizable),
      config: r.rows[0].customization_config || null,
    });
  } catch (err) {
    console.error('[studio/customization-config:GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar configuração' });
  }
});

// ─── PUT /products/:pid/customization-config ────────────────
// Salva/atualiza a config E liga is_personalizable=true automaticamente.
router.put('/products/:pid/customization-config', async function(req, res) {
  const cfg = req.body;
  const err = validateCustomizationConfig(cfg);
  if (err) return res.status(400).json({ error: err });

  try {
    const r = await db.query(
      `UPDATE products
          SET customization_config = $1::jsonb,
              is_personalizable    = TRUE,
              updated_at           = NOW()
        WHERE id = $2 AND company_id = $3
        RETURNING id, name, is_personalizable, customization_config`,
      [JSON.stringify(cfg), req.params.pid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json({
      product_id: r.rows[0].id,
      name: r.rows[0].name,
      is_personalizable: r.rows[0].is_personalizable,
      config: r.rows[0].customization_config,
    });
  } catch (e) {
    console.error('[studio/customization-config:PUT]', e.message);
    res.status(500).json({ error: 'Erro ao salvar configuração' });
  }
});

// ─── POST /products/:pid/personalize ─────────────────────────
// Toggle simples is_personalizable on/off (sem mexer na config).
// Útil pra desligar temporariamente um produto sem perder a config salva.
router.post('/products/:pid/personalize', async function(req, res) {
  const enabled = Boolean(req.body.enabled);
  try {
    const r = await db.query(
      `UPDATE products SET is_personalizable = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3
        RETURNING id, is_personalizable`,
      [enabled, req.params.pid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[studio/personalize]', err.message);
    res.status(500).json({ error: 'Erro ao alterar produto' });
  }
});

module.exports = router;
