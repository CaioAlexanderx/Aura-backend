// ============================================================
// AURA Studio — Visual Engine F3 · template visual público
//
// GET /storefront/:slug/studio/products/:pid/visual-template
//   → { template: { key, name, kind, version, spec } | null }
//
// Sem auth (mesmo modelo do studioStorefront): resolve a loja pelo
// slug publicado e devolve o template visual (global, mantido pela
// Aura) vinculado ao produto via products.visual_template_key.
// Só templates status='published' saem aqui. Montado em index.js
// ANTES de studioStorefront (rota específica, sem colisão).
//
// CORS: coberto pelo handler app-level de /api/v1/storefront (app.js).
// Defensivo 42703/42P01 (migration 208 pendente) → template null.
//
// 03/07/2026 — F3 do escopo Visualização 2D/3D (contrato no chat)
// ============================================================
'use strict';

const router = require('express').Router();
const db     = require('../config/database');

router.get('/:slug/studio/products/:pid/visual-template', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const { rows: configs } = await db.query(
      `SELECT company_id FROM digital_channel_config
        WHERE slug = $1 AND is_published = true LIMIT 1`,
      [slug]
    );
    if (!configs.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const cid = configs[0].company_id;

    let rows;
    try {
      const r = await db.query(
        `SELECT t.key, t.name, t.kind, t.version, t.spec
           FROM products p
           JOIN studio_visual_templates t
             ON t.key = p.visual_template_key AND t.status = 'published'
          WHERE p.id = $1
            AND p.is_active IS NOT FALSE
            AND p.is_personalizable = true
            AND (p.company_id = $2 OR (
              p.is_group_shared = true
              AND p.company_id IN (
                SELECT id FROM companies
                WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
                  SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
                  FROM companies WHERE id = $2
                )
              )
            ))
          LIMIT 1`,
        [req.params.pid, cid]
      );
      rows = r.rows;
    } catch (e) {
      if (e.code === '42703' || e.code === '42P01') {
        // Migration 208 ainda nao aplicada neste ambiente — preview cai
        // no fallback SVG do storefront (comportamento atual).
        return res.json({ template: null, deferred: true });
      }
      throw e;
    }

    res.json({ template: rows.length ? rows[0] : null });
  } catch (err) {
    console.error('[studio-storefront/visual-template] error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar template visual' });
  }
});

module.exports = router;
