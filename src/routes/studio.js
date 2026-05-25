// ============================================================
// AURA Studio — rotas do vertical (Fase 0 + 1 + 2 + 3)
// Atualizado 25/05/2026 (item #2 do follow-up UX/UI)
//
// Fase 0+1: /health, /products/:pid/customization-config, /personalize
// Fase 2  : /gallery/* (categorias + templates + vinculação)
// Fase 3  : /inputs/* + /compositions/* (BOM + custo + margem)
//
// Persistência de onboarding (markStudioOnboarding) gravada em
// companies.studio_settings.onboarding.{key} nos pontos-chave.
//
// Gate de plano (requirePlan('expansao')) aplicado no mount em
// src/routes/private.js. Não duplicar aqui.
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { markStudioOnboarding } = require('../utils/studioOnboarding');

// ─── Schema customization_config (Fase 1) ───────────────────
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
    if (!f.type || !VALID_FIELD_TYPES.includes(f.type)) return `fields[${i}].type inválido`;
    if (!f.label || typeof f.label !== 'string') return `fields[${i}].label obrigatório`;
    if (typeof f.required !== 'boolean') return `fields[${i}].required deve ser boolean`;
  }
  return null;
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .substring(0, 50) || 'item';
}

// ═══════════════════════════════════════════════════════════
// FASE 0+1: Health + Customization
// ═══════════════════════════════════════════════════════════

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
       FROM companies WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    res.json({ vertical: 'studio', version: 1, ...r.rows[0], timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[studio/health]', err.message);
    res.status(500).json({ error: 'Erro ao consultar Studio' });
  }
});

router.get('/products/:pid/customization-config', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT id, name, is_personalizable, customization_config
         FROM products WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [req.params.pid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json({
      product_id: r.rows[0].id, name: r.rows[0].name,
      is_personalizable: Boolean(r.rows[0].is_personalizable),
      config: r.rows[0].customization_config || null,
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar configuração' }); }
});

router.put('/products/:pid/customization-config', async function(req, res) {
  const cfg = req.body;
  const err = validateCustomizationConfig(cfg);
  if (err) return res.status(400).json({ error: err });
  try {
    const r = await db.query(
      `UPDATE products SET customization_config = $1::jsonb, is_personalizable = TRUE, updated_at = NOW()
        WHERE id = $2 AND company_id = $3
        RETURNING id, name, is_personalizable, customization_config`,
      [JSON.stringify(cfg), req.params.pid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    // Onboarding: marcou primeiro produto personalizável
    markStudioOnboarding(db, req.params.id, 'product');
    res.json({
      product_id: r.rows[0].id, name: r.rows[0].name,
      is_personalizable: r.rows[0].is_personalizable,
      config: r.rows[0].customization_config,
    });
  } catch (e) { res.status(500).json({ error: 'Erro ao salvar configuração' }); }
});

router.post('/products/:pid/personalize', async function(req, res) {
  const enabled = Boolean(req.body.enabled);
  try {
    const r = await db.query(
      `UPDATE products SET is_personalizable = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3 RETURNING id, is_personalizable`,
      [enabled, req.params.pid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    if (enabled) markStudioOnboarding(db, req.params.id, 'product');
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao alterar produto' }); }
});

// ═══════════════════════════════════════════════════════════
// FASE 2: Galeria de templates
// ═══════════════════════════════════════════════════════════

// ─── Categorias ─────────────────────────────────────────────
router.get('/gallery/categories', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT id, name, slug, icon, color, sort_order, is_active,
              (SELECT COUNT(*) FROM studio_templates t WHERE t.category_id = c.id AND t.is_active = true) AS template_count
         FROM studio_template_categories c
        WHERE company_id = $1 AND is_active = true
        ORDER BY sort_order, name`,
      [req.params.id]
    );
    res.json({ categories: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar categorias' }); }
});

router.post('/gallery/categories', async function(req, res) {
  const { name, icon, color, sort_order } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name obrigatório' });
  const slug = slugify(name);
  try {
    const r = await db.query(
      `INSERT INTO studio_template_categories (company_id, name, slug, icon, color, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, slug) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
       RETURNING *`,
      [req.params.id, String(name).trim(), slug, icon || null, color || null, parseInt(sort_order) || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[studio/gallery/categories:POST]', err.message);
    res.status(500).json({ error: 'Erro ao criar categoria' });
  }
});

router.patch('/gallery/categories/:cid', async function(req, res) {
  const fields = ['name', 'icon', 'color', 'sort_order', 'is_active'];
  const upd = [], vals = [];
  let idx = 1;
  for (const f of fields) {
    if (req.body[f] !== undefined) { upd.push(`${f} = $${idx++}`); vals.push(req.body[f]); }
  }
  if (!upd.length) return res.status(400).json({ error: 'nada pra atualizar' });
  upd.push('updated_at = NOW()');
  vals.push(req.params.cid, req.params.id);
  try {
    const r = await db.query(
      `UPDATE studio_template_categories SET ${upd.join(', ')}
        WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Categoria não encontrada' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar categoria' }); }
});

router.delete('/gallery/categories/:cid', async function(req, res) {
  try {
    const r = await db.query(
      `UPDATE studio_template_categories SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.cid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Categoria não encontrada' });
    res.json({ deleted: true, id: req.params.cid });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir categoria' }); }
});

// ─── Templates ──────────────────────────────────────────────
router.get('/gallery/templates', async function(req, res) {
  const { category_id, tag, limit = 200 } = req.query;
  const params = [req.params.id];
  let where = 'company_id = $1 AND is_active = true';
  if (category_id) { params.push(category_id); where += ` AND category_id = $${params.length}`; }
  if (tag)         { params.push(tag);         where += ` AND $${params.length} = ANY(tags)`; }
  try {
    const r = await db.query(
      `SELECT t.*, c.name AS category_name, c.color AS category_color
         FROM studio_templates t
         LEFT JOIN studio_template_categories c ON c.id = t.category_id
        WHERE ${where}
        ORDER BY t.use_count DESC, t.created_at DESC
        LIMIT $${params.length + 1}`,
      [...params, Math.min(parseInt(limit) || 200, 500)]
    );
    res.json({ templates: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar templates' }); }
});

router.post('/gallery/templates', async function(req, res) {
  const { category_id, name, description, image_url, thumb_url, tags } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name obrigatório' });
  if (!image_url || !/^https?:\/\//.test(image_url)) return res.status(400).json({ error: 'image_url obrigatório (URL válida)' });
  const tagsArr = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [];
  try {
    const r = await db.query(
      `INSERT INTO studio_templates
         (company_id, category_id, name, description, image_url, thumb_url, tags, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.params.id, category_id || null, String(name).trim(), description || null,
       image_url, thumb_url || null, tagsArr, req.user?.id || null]
    );
    // Onboarding: subiu primeiro template
    markStudioOnboarding(db, req.params.id, 'gallery');
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[studio/gallery/templates:POST]', err.message);
    res.status(500).json({ error: 'Erro ao criar template' });
  }
});

router.patch('/gallery/templates/:tid', async function(req, res) {
  const fields = ['category_id', 'name', 'description', 'image_url', 'thumb_url', 'tags', 'is_active'];
  const upd = [], vals = [];
  let idx = 1;
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      if (f === 'tags' && Array.isArray(req.body[f])) {
        upd.push(`tags = $${idx++}::text[]`);
        vals.push(req.body[f].map((t) => String(t).trim()).filter(Boolean).slice(0, 20));
      } else {
        upd.push(`${f} = $${idx++}`); vals.push(req.body[f]);
      }
    }
  }
  if (!upd.length) return res.status(400).json({ error: 'nada pra atualizar' });
  upd.push('updated_at = NOW()');
  vals.push(req.params.tid, req.params.id);
  try {
    const r = await db.query(
      `UPDATE studio_templates SET ${upd.join(', ')}
        WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Template não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar template' }); }
});

router.delete('/gallery/templates/:tid', async function(req, res) {
  try {
    const r = await db.query(
      `UPDATE studio_templates SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.tid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Template não encontrado' });
    res.json({ deleted: true, id: req.params.tid });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir template' }); }
});

// ─── Vinculação produto ↔ template ──────────────────────────
router.get('/gallery/by-product/:pid', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT t.*, c.name AS category_name, c.color AS category_color,
              (pt.product_id IS NOT NULL) AS specifically_linked
         FROM studio_templates t
         LEFT JOIN studio_template_categories c ON c.id = t.category_id
         LEFT JOIN studio_product_templates pt
                ON pt.template_id = t.id
               AND (pt.product_id = $2 OR pt.product_id IS NULL)
               AND pt.company_id = $1
        WHERE t.company_id = $1 AND t.is_active = true
          AND (pt.id IS NOT NULL OR EXISTS (
                SELECT 1 FROM studio_product_templates pt2
                 WHERE pt2.template_id = t.id AND pt2.company_id = $1
                   AND pt2.product_id IS NULL))
        ORDER BY specifically_linked DESC, t.use_count DESC
        LIMIT 200`,
      [req.params.id, req.params.pid]
    );
    res.json({ templates: r.rows });
  } catch (err) {
    console.error('[studio/gallery/by-product]', err.message);
    res.status(500).json({ error: 'Erro ao listar templates do produto' });
  }
});

router.post('/gallery/products/:pid/templates', async function(req, res) {
  const { template_id, sort_order } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id obrigatório' });
  try {
    const r = await db.query(
      `INSERT INTO studio_product_templates (company_id, product_id, template_id, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, product_id, template_id) DO NOTHING
       RETURNING *`,
      [req.params.id, req.params.pid, template_id, parseInt(sort_order) || 0]
    );
    res.status(201).json(r.rows[0] || { already_linked: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao vincular template' }); }
});

router.delete('/gallery/products/:pid/templates/:tid', async function(req, res) {
  try {
    const r = await db.query(
      `DELETE FROM studio_product_templates
        WHERE company_id = $1 AND product_id = $2 AND template_id = $3
        RETURNING id`,
      [req.params.id, req.params.pid, req.params.tid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Vinculação não encontrada' });
    res.json({ unlinked: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao remover vinculação' }); }
});

// ═══════════════════════════════════════════════════════════
// FASE 3: Insumos + Composições
// ═══════════════════════════════════════════════════════════

// ─── Insumos (matéria-prima) ────────────────────────────────
router.get('/inputs', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT *,
              (stock_min IS NOT NULL AND stock_qty < stock_min) AS is_low_stock
         FROM studio_inputs
        WHERE company_id = $1 AND is_active = true
        ORDER BY name`,
      [req.params.id]
    );
    res.json({ inputs: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar insumos' }); }
});

router.get('/inputs/low-stock', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT * FROM studio_inputs
        WHERE company_id = $1 AND is_active = true
          AND stock_min IS NOT NULL AND stock_qty < stock_min
        ORDER BY (stock_qty / NULLIF(stock_min, 0)) NULLS LAST`,
      [req.params.id]
    );
    res.json({ inputs: r.rows, count: r.rows.length });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar insumos críticos' }); }
});

router.post('/inputs', async function(req, res) {
  const { name, unit, unit_cost, stock_qty, stock_min, supplier_name, supplier_phone, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name obrigatório' });
  try {
    const r = await db.query(
      `INSERT INTO studio_inputs
         (company_id, name, unit, unit_cost, stock_qty, stock_min,
          supplier_name, supplier_phone, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.params.id, String(name).trim(), unit || 'un',
       parseFloat(unit_cost) || 0, parseFloat(stock_qty) || 0,
       stock_min != null ? parseFloat(stock_min) : null,
       supplier_name || null, supplier_phone || null, notes || null, req.user?.id || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[studio/inputs:POST]', err.message);
    res.status(500).json({ error: 'Erro ao criar insumo' });
  }
});

router.patch('/inputs/:iid', async function(req, res) {
  const fields = ['name', 'unit', 'unit_cost', 'stock_qty', 'stock_min',
                  'supplier_name', 'supplier_phone', 'notes', 'is_active'];
  const upd = [], vals = [];
  let idx = 1;
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      const v = ['unit_cost', 'stock_qty', 'stock_min'].includes(f) && req.body[f] != null
        ? parseFloat(req.body[f]) : req.body[f];
      upd.push(`${f} = $${idx++}`); vals.push(v);
    }
  }
  if (!upd.length) return res.status(400).json({ error: 'nada pra atualizar' });
  upd.push('updated_at = NOW()');
  vals.push(req.params.iid, req.params.id);
  try {
    const r = await db.query(
      `UPDATE studio_inputs SET ${upd.join(', ')}
        WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Insumo não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar insumo' }); }
});

router.delete('/inputs/:iid', async function(req, res) {
  try {
    const r = await db.query(
      `UPDATE studio_inputs SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.iid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Insumo não encontrado' });
    res.json({ deleted: true, id: req.params.iid });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir insumo' }); }
});

// ─── Composições (BOM) ──────────────────────────────────────
router.get('/compositions/by-product/:pid', async function(req, res) {
  try {
    const compRes = await db.query(
      `SELECT c.*, s.total_cost, s.margin_pct, s.product_name, s.product_price
         FROM studio_compositions c
         LEFT JOIN studio_compositions_summary s ON s.composition_id = c.id
        WHERE c.company_id = $1 AND c.product_id = $2
        LIMIT 1`,
      [req.params.id, req.params.pid]
    );
    if (!compRes.rows.length) {
      return res.json({ composition: null, items: [], summary: null });
    }
    const comp = compRes.rows[0];
    const itemsRes = await db.query(
      `SELECT ci.*, i.name AS input_name, i.unit AS input_unit, i.unit_cost AS input_unit_cost
         FROM studio_composition_items ci
         JOIN studio_inputs i ON i.id = ci.input_id
        WHERE ci.composition_id = $1
        ORDER BY ci.sort_order, i.name`,
      [comp.id]
    );
    res.json({
      composition: { id: comp.id, product_id: comp.product_id, notes: comp.notes, is_active: comp.is_active },
      items: itemsRes.rows,
      summary: {
        total_cost: parseFloat(comp.total_cost) || 0,
        margin_pct: comp.margin_pct != null ? parseFloat(comp.margin_pct) : null,
        product_price: parseFloat(comp.product_price) || 0,
        product_name: comp.product_name,
      },
    });
  } catch (err) {
    console.error('[studio/compositions/by-product]', err.message);
    res.status(500).json({ error: 'Erro ao buscar composição' });
  }
});

router.put('/compositions/by-product/:pid', async function(req, res) {
  const { notes, items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items deve ser array' });
  for (const it of items) {
    if (!it.input_id) return res.status(400).json({ error: 'cada item precisa de input_id' });
    if (!(parseFloat(it.qty_per_unit) > 0)) return res.status(400).json({ error: 'qty_per_unit > 0 obrigatório' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const compRes = await client.query(
      `INSERT INTO studio_compositions (company_id, product_id, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, product_id) DO UPDATE
         SET notes = EXCLUDED.notes, updated_at = NOW()
       RETURNING id`,
      [req.params.id, req.params.pid, notes || null]
    );
    const compId = compRes.rows[0].id;

    await client.query(`DELETE FROM studio_composition_items WHERE composition_id = $1`, [compId]);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await client.query(
        `INSERT INTO studio_composition_items
           (composition_id, input_id, qty_per_unit, notes, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (composition_id, input_id) DO UPDATE
           SET qty_per_unit = EXCLUDED.qty_per_unit, notes = EXCLUDED.notes`,
        [compId, it.input_id, parseFloat(it.qty_per_unit), it.notes || null, it.sort_order != null ? parseInt(it.sort_order) : i]
      );
    }

    await client.query('COMMIT');

    const summary = await db.query(
      `SELECT total_cost, margin_pct FROM studio_compositions_summary WHERE composition_id = $1`,
      [compId]
    );
    res.json({
      composition_id: compId,
      item_count: items.length,
      summary: summary.rows[0] || null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[studio/compositions/by-product:PUT]', err.message);
    res.status(500).json({ error: 'Erro ao salvar composição' });
  } finally {
    client.release();
  }
});

router.get('/compositions/summary', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT composition_id, product_id, product_name, product_price,
              total_cost, margin_pct, item_count
         FROM studio_compositions_summary
        WHERE company_id = $1 AND is_active = true
        ORDER BY product_name`,
      [req.params.id]
    );
    res.json({ compositions: r.rows, count: r.rows.length });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar composições' }); }
});

module.exports = router;
