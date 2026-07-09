// ============================================================
// AURA. — Canal Digital · Analytics do lojista (F1 Loja Virtual)
//
// GET  /companies/:id/digital-channel/analytics  — lê GA4/Pixel
// PUT  /companies/:id/digital-channel/analytics  — salva GA4/Pixel
//
// Migration 220: colunas ga4_measurement_id e meta_pixel_id em
// digital_channel_config. Handlers 42703-tolerantes (schema antes
// da migration — CLAUDE.md armadilha 1).
// String vazia limpa o campo (NULL). A vitrine só injeta os
// scripts quando o formato é válido (validado de novo no template).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

const GA4_RE = /^G-[A-Z0-9]{4,14}$/;
const PIXEL_RE = /^\d{5,20}$/;

router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT ga4_measurement_id, meta_pixel_id
       FROM digital_channel_config WHERE company_id = $1`,
      [cid]
    );
    res.json({
      ga4_measurement_id: rows[0]?.ga4_measurement_id || null,
      meta_pixel_id: rows[0]?.meta_pixel_id || null,
    });
  } catch (e) {
    if (e.code === '42703') {
      return res.json({ ga4_measurement_id: null, meta_pixel_id: null, migration_pending: true });
    }
    console.error('[canal-analytics] get error:', e.message);
    res.status(500).json({ error: 'Erro ao carregar analytics' });
  }
});

router.put('/', async (req, res) => {
  const cid = req.params.id;
  const { ga4_measurement_id, meta_pixel_id } = req.body || {};

  const sets = [];
  const params = [];
  let idx = 1;

  if (ga4_measurement_id !== undefined) {
    const v = String(ga4_measurement_id || '').trim().toUpperCase();
    if (v && !GA4_RE.test(v)) {
      return res.status(400).json({ error: 'GA4 Measurement ID inválido. Formato: G-XXXXXXXXXX' });
    }
    params.push(v || null);
    sets.push(`ga4_measurement_id = $${idx++}`);
  }
  if (meta_pixel_id !== undefined) {
    const digits = String(meta_pixel_id || '').replace(/\D/g, '');
    if (String(meta_pixel_id || '').trim() && !PIXEL_RE.test(digits)) {
      return res.status(400).json({ error: 'Meta Pixel ID inválido. Use apenas os números do Pixel.' });
    }
    params.push(digits || null);
    sets.push(`meta_pixel_id = $${idx++}`);
  }
  if (!sets.length) {
    return res.status(400).json({ error: 'Informe ga4_measurement_id e/ou meta_pixel_id' });
  }

  try {
    params.push(cid);
    const { rows } = await db.query(
      `UPDATE digital_channel_config
         SET ${sets.join(', ')}, updated_at = NOW()
       WHERE company_id = $${idx}
       RETURNING ga4_measurement_id, meta_pixel_id`,
      params
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Configure e publique sua loja antes de definir analytics' });
    }
    res.json({ saved: true, ...rows[0] });
  } catch (e) {
    if (e.code === '42703') {
      return res.status(503).json({ error: 'Migração 220 pendente. Tente novamente em instantes.' });
    }
    console.error('[canal-analytics] put error:', e.message);
    res.status(500).json({ error: 'Erro ao salvar analytics' });
  }
});

module.exports = router;
