// ============================================================
// AURA Studio — rotas do vertical (Fase 0 + 1 + 2 + 3 + Nivel 1 + Fase 10A)
// Atualizado 26/05/2026 — Fase 10A: IA Haiku sugere templates pro produto
//                       + Issue 2: qty_multiplier_by_option em compositions
//                       + Verso: has_back + back_print_area + field.side
//                       + Meio:  has_middle + middle_print_area (caneca/copo)
//
// Fase 0+1: /health, /products/:pid/customization-config, /personalize
// Fase 2  : /gallery/* (categorias + templates + vinculação)
// Fase 3  : /inputs/* + /compositions/* (BOM + custo + margem)
// Nivel 1 : /settings, /metrics, /sla/estimate (25/05/2026)
// Fase 10A: /products/:pid/suggest-templates (IA Haiku, 26/05/2026)
//
// IMPORTANTE: pedidos Studio são armazenados em `digital_orders`
// com `vertical = 'studio'` (NÃO existe tabela studio_orders).
// View studio_hub_kpis já agrega KPIs comuns.
//
//
// Gate de plano (requirePlan) aplicado no mount em src/routes/private.js.
//
// 30/05/2026 (Camada 1 P1): require_deposit_for_production adicionado ao
// whitelist de settings — permite FE salvar via PATCH /studio/settings.
// 01/06/2026: guide_dismissed adicionado ao whitelist (bug fix).
// 10/06/2026 (Onda 0 · 0.5): pix_key adicionado ao whitelist de settings —
//   o charge-link de sinal (studioPayments.js) LÊ studio_settings->>'pix_key',
//   mas o PATCH dropava a chave. Fix de inconsistência, sem migration.
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const {
  margemMinima, pecasEmRisco, precoParaOPiso, recadoDoRisco,
} = require('../services/margemEmRisco');

// ─── Schema customization_config (Fase 1 + Verso 26/05/2026) ─
const VALID_FIELD_TYPES = ['text', 'image', 'template', 'color', 'option'];
const VALID_POSITIONS   = ['center', 'left', 'right'];
// 'middle' (19/08/2026): faixa central / wrap 360 — o caso de caneca e
// copo, onde a arte da a volta e nao e nem frente nem verso. Espelha
// has_back em tudo: area propria, cobranca opcional e side nos fields.
const VALID_SIDES       = ['front', 'back', 'middle'];

function validateCustomizationConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'config obrigatório';
  if (!cfg.print_area || typeof cfg.print_area !== 'object') return 'print_area obrigatório';
  const pa = cfg.print_area;
  if (typeof pa.width_cm !== 'number' || pa.width_cm <= 0) return 'print_area.width_cm inválido';
  if (typeof pa.height_cm !== 'number' || pa.height_cm <= 0) return 'print_area.height_cm inválido';
  if (pa.position && !VALID_POSITIONS.includes(pa.position)) return 'print_area.position inválido (center/left/right)';

  if (cfg.has_back !== undefined && typeof cfg.has_back !== 'boolean') {
    return 'has_back deve ser boolean';
  }
  if (cfg.has_back === true) {
    if (!cfg.back_print_area || typeof cfg.back_print_area !== 'object') {
      return 'back_print_area obrigatório quando has_back=true';
    }
    const bpa = cfg.back_print_area;
    if (typeof bpa.width_cm !== 'number' || !isFinite(bpa.width_cm) || bpa.width_cm <= 0) {
      return 'back_print_area.width_cm inválido';
    }
    if (typeof bpa.height_cm !== 'number' || !isFinite(bpa.height_cm) || bpa.height_cm <= 0) {
      return 'back_print_area.height_cm inválido';
    }
    if (bpa.position !== undefined && !VALID_POSITIONS.includes(bpa.position)) {
      return 'back_print_area.position inválido (center/left/right)';
    }
  }
  if (cfg.back_charge_enabled !== undefined && typeof cfg.back_charge_enabled !== 'boolean') {
    return 'back_charge_enabled deve ser boolean';
  }
  if (cfg.back_charge_enabled === true) {
    if (typeof cfg.back_price_delta !== 'number' || !isFinite(cfg.back_price_delta) || cfg.back_price_delta <= 0) {
      return 'back_price_delta deve ser número > 0 quando back_charge_enabled=true';
    }
  }

  if (cfg.has_middle !== undefined && typeof cfg.has_middle !== 'boolean') {
    return 'has_middle deve ser boolean';
  }
  if (cfg.has_middle === true) {
    if (!cfg.middle_print_area || typeof cfg.middle_print_area !== 'object') {
      return 'middle_print_area obrigatório quando has_middle=true';
    }
    const mpa = cfg.middle_print_area;
    if (typeof mpa.width_cm !== 'number' || !isFinite(mpa.width_cm) || mpa.width_cm <= 0) {
      return 'middle_print_area.width_cm inválido';
    }
    if (typeof mpa.height_cm !== 'number' || !isFinite(mpa.height_cm) || mpa.height_cm <= 0) {
      return 'middle_print_area.height_cm inválido';
    }
    if (mpa.position !== undefined && !VALID_POSITIONS.includes(mpa.position)) {
      return 'middle_print_area.position inválido (center/left/right)';
    }
  }
  if (cfg.middle_charge_enabled !== undefined && typeof cfg.middle_charge_enabled !== 'boolean') {
    return 'middle_charge_enabled deve ser boolean';
  }
  if (cfg.middle_charge_enabled === true) {
    if (typeof cfg.middle_price_delta !== 'number' || !isFinite(cfg.middle_price_delta) || cfg.middle_price_delta <= 0) {
      return 'middle_price_delta deve ser número > 0 quando middle_charge_enabled=true';
    }
  }

  if (!Array.isArray(cfg.fields)) return 'fields deve ser array';
  if (cfg.fields.length === 0) return 'pelo menos 1 field obrigatório';
  if (cfg.fields.length > 12) return 'máximo 12 fields por produto';
  for (const [i, f] of cfg.fields.entries()) {
    if (!f.id || typeof f.id !== 'string') return `fields[${i}].id obrigatório`;
    if (!f.type || !VALID_FIELD_TYPES.includes(f.type)) return `fields[${i}].type inválido`;
    if (!f.label || typeof f.label !== 'string') return `fields[${i}].label obrigatório`;
    if (typeof f.required !== 'boolean') return `fields[${i}].required deve ser boolean`;
    if (f.side !== undefined) {
      if (!VALID_SIDES.includes(f.side)) {
        return `fields[${i}].side inválido (front/back/middle)`;
      }
      if (f.side === 'back' && cfg.has_back !== true) {
        return `fields[${i}].side='back' requer has_back=true`;
      }
      if (f.side === 'middle' && cfg.has_middle !== true) {
        return `fields[${i}].side='middle' requer has_middle=true`;
      }
    }
  }
  return null;
}

function validateQtyMultiplier(m) {
  if (m === null || m === undefined) return null;
  if (typeof m !== 'object' || Array.isArray(m)) {
    return 'qty_multiplier_by_option deve ser objeto';
  }
  for (const fieldId of Object.keys(m)) {
    if (typeof fieldId !== 'string' || !fieldId.trim()) {
      return 'qty_multiplier_by_option: chave de fieldId inválida';
    }
    const inner = m[fieldId];
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
      return `qty_multiplier_by_option["${fieldId}"] deve ser objeto`;
    }
    for (const optValue of Object.keys(inner)) {
      if (typeof optValue !== 'string') {
        return `qty_multiplier_by_option["${fieldId}"]: chave de valor inválida`;
      }
      const mult = inner[optValue];
      if (typeof mult !== 'number' || !isFinite(mult) || mult < 0) {
        return `qty_multiplier_by_option["${fieldId}"]["${optValue}"] deve ser número >= 0`;
      }
    }
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
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao alterar produto' }); }
});

// ═══════════════════════════════════════════════════════════
// FASE 2: Galeria de templates
// ═══════════════════════════════════════════════════════════

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

router.get('/gallery/templates', async function(req, res) {
  const { category_id, tag, limit = 200 } = req.query;
  const params = [req.params.id];
  let where = 't.company_id = $1 AND t.is_active = true';
  if (category_id) { params.push(category_id); where += ` AND t.category_id = $${params.length}`; }
  if (tag)         { params.push(tag);         where += ` AND $${params.length} = ANY(t.tags)`; }
  const limitParams = [...params, Math.min(parseInt(limit) || 200, 500)];
  try {
    // linked_products: produtos vinculados diretamente ao template (galeria
    // organizada por produto — 19/08/2026). LATERAL evita GROUP BY em t.*.
    const r = await db.query(
      `SELECT t.*, c.name AS category_name, c.color AS category_color,
              COALESCE(lp.linked_products, '[]'::json) AS linked_products
         FROM studio_templates t
         LEFT JOIN studio_template_categories c ON c.id = t.category_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'image_url', p.image_url) ORDER BY p.name) AS linked_products
             FROM studio_product_templates pt
             JOIN products p ON p.id = pt.product_id
            WHERE pt.template_id = t.id AND pt.company_id = t.company_id AND pt.product_id IS NOT NULL
         ) lp ON true
        WHERE ${where}
        ORDER BY t.use_count DESC, t.created_at DESC
        LIMIT $${params.length + 1}`,
      limitParams
    );
    res.json({ templates: r.rows });
  } catch (err) {
    // 42P01: studio_product_templates ausente (deployment parcial) → lista sem vínculos
    if (err.code === '42P01') {
      try {
        const r = await db.query(
          `SELECT t.*, c.name AS category_name, c.color AS category_color
             FROM studio_templates t
             LEFT JOIN studio_template_categories c ON c.id = t.category_id
            WHERE ${where}
            ORDER BY t.use_count DESC, t.created_at DESC
            LIMIT $${params.length + 1}`,
          limitParams
        );
        return res.json({ templates: r.rows });
      } catch (err2) {
        console.error('[studio/gallery/templates] fallback error:', err2.message);
        return res.status(500).json({ error: 'Erro ao listar templates' });
      }
    }
    console.error('[studio/gallery/templates] error:', err.message);
    res.status(500).json({ error: 'Erro ao listar templates' });
  }
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


// ── Margem em risco ──────────────────────────────────────────
// A composicao e a view de resumo ja calculavam custo e margem. O que
// faltava era o AVISO: a lojista sobe o preco da louca, salva, e nada
// acontece — duas semanas depois descobre no fim do mes que vendeu no
// prejuizo. Ver services/margemEmRisco.js.
async function lerRisco(cid) {
  const { rows: cfg } = await db.query(
    `SELECT COALESCE(studio_settings, '{}'::jsonb) AS s FROM companies WHERE id = $1`,
    [cid]
  );
  const piso = margemMinima(cfg[0] ? cfg[0].s : {});
  const { rows } = await db.query(
    `SELECT product_id, product_name, product_price, total_cost, margin_pct
       FROM studio_compositions_summary
      WHERE company_id = $1 AND is_active = true`,
    [cid]
  );
  const pecas = pecasEmRisco(rows, piso).map((p) => ({
    ...p,
    preco_sugerido: precoParaOPiso(p.custo, piso),
  }));
  return { piso, pecas, recado: recadoDoRisco(pecas, piso) };
}

router.get('/margem/risco', async function(req, res) {
  try {
    res.json(await lerRisco(req.params.id));
  } catch (err) {
    // 42P01: a view de resumo nao existe nesta base. Sem composicao nao
    // ha margem para julgar — lista vazia e a resposta honesta.
    if (err.code === '42P01' || err.code === '42703') {
      return res.json({ piso: null, pecas: [], recado: null });
    }
    console.error('[studio/margem/risco]', err.message);
    res.status(500).json({ error: 'Erro ao calcular margem' });
  }
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

    // Mudou o CUSTO: devolve junto o que isso fez com as pecas. E o
    // ponto do recurso — ela sobe o preco da louca e ve na hora quais
    // pecas ficaram no prejuizo, sem ir procurar.
    if (req.body.unit_cost !== undefined) {
      try {
        return res.json({ ...r.rows[0], margem: await lerRisco(req.params.id) });
      } catch (e) {
        // Falha no calculo nao pode derrubar o salvamento do insumo.
        console.warn('[studio/inputs:PATCH] margem nao calculada:', e.message);
      }
    }
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
    if (it.qty_multiplier_by_option !== undefined && it.qty_multiplier_by_option !== null) {
      const mErr = validateQtyMultiplier(it.qty_multiplier_by_option);
      if (mErr) return res.status(400).json({ error: mErr });
    }
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
      const multiplier = it.qty_multiplier_by_option
        && typeof it.qty_multiplier_by_option === 'object'
        && !Array.isArray(it.qty_multiplier_by_option)
        && Object.keys(it.qty_multiplier_by_option).length > 0
        ? JSON.stringify(it.qty_multiplier_by_option)
        : null;
      await client.query(
        `INSERT INTO studio_composition_items
           (composition_id, input_id, qty_per_unit, notes, sort_order, qty_multiplier_by_option)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (composition_id, input_id) DO UPDATE
           SET qty_per_unit = EXCLUDED.qty_per_unit,
               notes = EXCLUDED.notes,
               qty_multiplier_by_option = EXCLUDED.qty_multiplier_by_option`,
        [compId, it.input_id, parseFloat(it.qty_per_unit), it.notes || null,
         it.sort_order != null ? parseInt(it.sort_order) : i, multiplier]
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
    // 19/08/2026 (QA): image_url via LEFT JOIN products — a aba Fichas
    // Técnicas identificava produto só por nome ("caneca branca fosca" vs
    // "caneca branca brilho"). A view não expõe a coluna; o JOIN evita
    // migration e degrada pra null se o produto sumiu.
    const r = await db.query(
      `SELECT s.composition_id, s.product_id, s.product_name, s.product_price,
              s.total_cost, s.margin_pct, s.item_count,
              p.image_url
         FROM studio_compositions_summary s
         LEFT JOIN products p ON p.id = s.product_id
        WHERE s.company_id = $1 AND s.is_active = true
        ORDER BY s.product_name`,
      [req.params.id]
    );
    res.json({ compositions: r.rows, count: r.rows.length });
  } catch (err) {
    console.error('[studio/compositions/summary]', err.message);
    res.status(500).json({ error: 'Erro ao listar composições' });
  }
});

// ═══════════════════════════════════════════════════════════
// NIVEL 1 (25/05/2026) — Settings + Metrics + SLA Estimate
// ═══════════════════════════════════════════════════════════

const ALLOWED_STUDIO_SETTINGS = [
  'default_sla_days',             // int — prazo padrão de produção (dias úteis)
  'production_capacity_per_day',  // int — capacidade diária pra calcular fila
  'approval_wa_phone',            // string — WhatsApp da loja (link wa.me)
  'approval_template_message',    // string — template da mensagem de aprovação
  'ncm_defaults',                 // jsonb — { 'caneca': 'XXXXX', 'camiseta': ... }
  'marketplace_handling_days',    // int — prazo de handling ML/Shopee (S-1)
  // Política de revisões/edições da arte (Loja Digital Studio 25/05/2026)
  'max_revisions_included',       // int — qtas revisões grátis o cliente tem (0 = ilimitado)
  'extra_revision_price',         // float — preço cobrado por revisão extra
  'revision_policy_text',         // string — texto exibido pro cliente sobre a política
  // Camada 1: gate de produção por sinal (opt-in, default false — zero quebra pra quem já opera)
  'require_deposit_for_production',  // boolean — exige deposit_paid=true antes de in_production
  // UX: guia da home Studio (dismissível pelo usuário — bug fix 01/06/2026)
  'guide_dismissed',              // boolean — oculta o guide card após o usuário fechar
  // Camada 1 Fase C: chave Pix do lojista — o charge-link de sinal LÊ daqui
  // (studio_settings->>'pix_key'). Sem isto o PATCH dropava a chave e o link
  // de cobrança degradava pro fallback "entre em contato". (Onda 0 · 0.5)
  'pix_key',                      // string — chave Pix da empresa (sinal/charge-link)
];

router.get('/settings', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT COALESCE(studio_settings, '{}'::jsonb) AS settings
         FROM companies WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    res.json({ settings: r.rows[0].settings });
  } catch (err) {
    console.error('[studio/settings:GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar configurações' });
  }
});

router.patch('/settings', async function(req, res) {
  const patch = req.body || {};
  const filtered = {};
  for (const k of ALLOWED_STUDIO_SETTINGS) {
    if (patch[k] !== undefined) filtered[k] = patch[k];
  }
  if (Object.keys(filtered).length === 0) {
    console.warn('[studio/settings:PATCH] 400 — body sem chaves permitidas:', Object.keys(patch).join(', '), '| permitidas:', ALLOWED_STUDIO_SETTINGS.join(', '));
    return res.status(400).json({ error: 'nada pra atualizar (chaves permitidas: ' + ALLOWED_STUDIO_SETTINGS.join(', ') + ')' });
  }
  try {
    const r = await db.query(
      `UPDATE companies
          SET studio_settings = COALESCE(studio_settings, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE id = $2
        RETURNING COALESCE(studio_settings, '{}'::jsonb) AS settings`,
      [JSON.stringify(filtered), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    res.json({ settings: r.rows[0].settings });
  } catch (err) {
    console.error('[studio/settings:PATCH]', err.message);
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});

router.get('/metrics', async function(req, res) {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
  try {
    const kpiRes = await db.query(
      `SELECT * FROM studio_hub_kpis WHERE company_id = $1 LIMIT 1`,
      [req.params.id]
    );
    const k = kpiRes.rows[0] || {};

    let prontosHoje = 0;
    try {
      const phRes = await db.query(
        `SELECT COUNT(*)::int AS cnt
           FROM digital_orders
          WHERE company_id = $1 AND vertical = 'studio'
            AND studio_production_status = 'ready'
            AND updated_at::date = CURRENT_DATE`,
        [req.params.id]
      );
      prontosHoje = parseInt(phRes.rows[0]?.cnt || 0);
    } catch (_) {}

    let vendasTotal = 0, pedidosCount = 0;
    try {
      const vRes = await db.query(
        `SELECT COALESCE(SUM(total), 0)::float AS total,
                COUNT(*)::int AS pedidos
           FROM digital_orders
          WHERE company_id = $1 AND vertical = 'studio'
            AND created_at >= NOW() - ($2 || ' days')::interval
            AND COALESCE(status, 'completed') != 'cancelled'`,
        [req.params.id, String(days)]
      );
      vendasTotal = parseFloat(vRes.rows[0]?.total || 0);
      pedidosCount = parseInt(vRes.rows[0]?.pedidos || 0);
    } catch (_) {}

    let margemMedia = null;
    try {
      const mRes = await db.query(
        `SELECT AVG(margin_pct)::float AS avg_margin
           FROM studio_compositions_summary
          WHERE company_id = $1 AND margin_pct IS NOT NULL`,
        [req.params.id]
      );
      margemMedia = mRes.rows[0]?.avg_margin != null
        ? parseFloat(mRes.rows[0].avg_margin) : null;
    } catch (_) {}

    let tempoMedio = null;
    try {
      const tRes = await db.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0)::float AS avg_days
           FROM digital_orders
          WHERE company_id = $1 AND vertical = 'studio'
            AND studio_production_status IN ('ready', 'delivered')
            AND created_at >= NOW() - INTERVAL '30 days'`,
        [req.params.id]
      );
      tempoMedio = tRes.rows[0]?.avg_days != null
        ? parseFloat(tRes.rows[0].avg_days) : null;
    } catch (_) {}

    res.json({
      em_producao:        parseInt(k.in_production_count || 0),
      aguardando_arte:    parseInt(k.pending_art_count || 0),
      aprovados:          parseInt(k.approved_count || 0),
      ready_total:        parseInt(k.ready_count || 0),
      prontos_hoje:       prontosHoje,
      vendas_periodo:     vendasTotal,
      pedidos_periodo:    pedidosCount,
      revenue_today:      parseFloat(k.revenue_today || 0),
      revenue_7d:         parseFloat(k.revenue_7d || 0),
      orders_7d:          parseInt(k.orders_7d || 0),
      orders_today:       parseInt(k.orders_today || 0),
      delivered_7d:       parseInt(k.delivered_7d || 0),
      overdue_count:      parseInt(k.overdue_count || 0),
      total_orders:       parseInt(k.total_orders || 0),
      margem_media_pct:   margemMedia,
      tempo_medio_dias:   tempoMedio,
      period_days:        days,
      computed_at:        new Date().toISOString(),
    });
  } catch (err) {
    console.error('[studio/metrics]', err.message);
    res.status(500).json({ error: 'Erro ao calcular métricas' });
  }
});

router.get('/sla/estimate', async function(req, res) {
  const productIds = (req.query.products || '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const ssRes = await db.query(
      `SELECT COALESCE((studio_settings->>'default_sla_days')::int, 3)              AS sla_days,
              COALESCE((studio_settings->>'production_capacity_per_day')::int, 10)  AS capacity
         FROM companies WHERE id = $1`,
      [req.params.id]
    );
    if (!ssRes.rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    const slaDays  = ssRes.rows[0].sla_days;
    const capacity = Math.max(ssRes.rows[0].capacity, 1);

    let queueQty = 0;
    try {
      const queueRes = await db.query(
        `SELECT COUNT(*)::int AS qty
           FROM digital_orders
          WHERE company_id = $1 AND vertical = 'studio'
            AND studio_production_status IN ('pending_art', 'approved', 'in_production')`,
        [req.params.id]
      );
      queueQty = parseInt(queueRes.rows[0]?.qty || 0);
    } catch (_) {}

    const queueDays = Math.ceil(queueQty / capacity);
    const estimateDays = slaDays + queueDays;

    res.json({
      sla_base_days:        slaDays,
      queue_qty:            queueQty,
      capacity_per_day:     capacity,
      queue_added_days:     queueDays,
      total_estimate_days:  estimateDays,
      requested_products:   productIds.length,
    });
  } catch (err) {
    console.error('[studio/sla/estimate]', err.message);
    res.status(500).json({ error: 'Erro ao estimar prazo' });
  }
});

// ═══════════════════════════════════════════════════════════
// FASE 10A (26/05/2026) — IA Haiku sugere templates pro produto
// ═══════════════════════════════════════════════════════════

router.post('/products/:pid/suggest-templates', async function(req, res) {
  try {
    const prodRes = await db.query(
      `SELECT id, name, description, category, customization_config
         FROM products WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [req.params.pid, req.params.id]
    );
    if (!prodRes.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const product = prodRes.rows[0];

    const tplRes = await db.query(
      `SELECT t.id, t.name, t.description, t.tags, t.category_id,
              tc.name AS category_name
         FROM studio_templates t
         LEFT JOIN studio_template_categories tc ON tc.id = t.category_id
        WHERE t.company_id = $1 AND t.is_active = true
        ORDER BY t.use_count DESC
        LIMIT 100`,
      [req.params.id]
    );
    if (tplRes.rows.length === 0) {
      return res.json({
        suggestions: [],
        message: 'Cadastre templates na galeria pra receber sugestoes.',
      });
    }

    function fallbackRank() {
      const productWords = (product.name + ' ' + (product.description || ''))
        .toLowerCase().split(/\s+/);
      return tplRes.rows.map((t) => {
        const tplWords = (t.name + ' ' + (t.tags || []).join(' '))
          .toLowerCase().split(/\s+/);
        const overlap = productWords.filter((w) => w.length > 3 && tplWords.includes(w)).length;
        return {
          template_id: t.id,
          reason: `Palavras em comum: ${overlap}`,
          score: Math.min(50 + overlap * 10, 95),
        };
      }).filter((r) => r.score >= 60)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    }

    const productInfo = `Nome: ${product.name}\nDescricao: ${product.description || 'sem descricao'}\nCategoria: ${product.category || 'geral'}`;
    const templatesInfo = tplRes.rows.map((t, i) =>
      `[${i + 1}] id=${t.id}, nome="${t.name}", categoria="${t.category_name || 'geral'}", tags=[${(t.tags || []).join(', ')}]`
    ).join('\n');

    const prompt = `Voce eh um curador de arte pra loja de personalizados. Analise o produto abaixo e escolha ATE 5 templates da galeria que combinam melhor.\n\nPRODUTO:\n${productInfo}\n\nGALERIA (${tplRes.rows.length} templates disponiveis):\n${templatesInfo}\n\nResponda em JSON puro (sem markdown) com estrutura:\n{"suggestions":[{"template_id":"uuid","reason":"frase curta explicando o match","score":85}]}\n\nScore 0-100. Ordenar por score desc. Maximo 5. Se nenhum template combina bem, retorne lista vazia.`;

    let claudeClient;
    try {
      claudeClient = require('../services/claudeClient');
    } catch (importErr) {
      console.warn('[studio/suggest-templates] claudeClient indisponivel, usando fallback');
      return res.json({ suggestions: fallbackRank(), fallback: true, reason: 'service_missing' });
    }

    let aiText;
    try {
      const aiRes = await claudeClient.callClaude({
        messages: [{ role: 'user', content: prompt }],
        model: 'claude-haiku-4-5',
        maxTokens: 800,
      });
      aiText = aiRes.text;
    } catch (callErr) {
      console.warn('[studio/suggest-templates] callClaude falhou:', callErr.message);
      return res.json({ suggestions: fallbackRank(), fallback: true, reason: 'ai_error' });
    }

    let parsed;
    try {
      parsed = claudeClient.parseJsonResponse(aiText);
    } catch (parseErr) {
      console.error('[studio/suggest-templates] parse JSON falhou:', (aiText || '').slice(0, 200));
      return res.json({ suggestions: fallbackRank(), fallback: true, reason: 'parse_error' });
    }

    const validIds = new Set(tplRes.rows.map((t) => t.id));
    const suggestions = (parsed.suggestions || [])
      .filter((s) => s && validIds.has(s.template_id))
      .slice(0, 5);

    res.json({ suggestions, ai_powered: true });

  } catch (err) {
    console.error('[studio/suggest-templates]', err.message);
    res.status(500).json({ error: 'Erro ao gerar sugestoes' });
  }
});

module.exports = router;
