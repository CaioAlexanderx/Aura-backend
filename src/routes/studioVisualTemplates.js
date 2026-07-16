// ============================================================
// AURA Studio · Visual Engine F0 — templates visuais + renders
//
// Mount em private.js sob /studio (plan-gated negocio+expansao).
//
// Templates (studio_visual_templates) são GLOBAIS, mantidos pela Aura:
//   - GET  /visual-templates           → lojista lê publicados (staff vê tudo c/ ?all=1)
//   - GET  /visual-templates/:key      → spec completa de um template
//   - POST /visual-templates           → staff-only (cria)
//   - PUT  /visual-templates/:key      → staff-only (edita; spec nova incrementa version)
//
// Renders (studio_visual_renders) são por empresa:
//   - POST /visual-renders             → registra render gerado (content_hash server-side)
//   - GET  /visual-renders             → lista por sale_item_id | digital_order_item_id
//
// Vínculo produto → template (F4, 03/07/2026):
//   - GET  /products/:pid/visual-template → template publicado do produto (ou null)
//   - PUT  /products/:pid/visual-template → lojista vincula/desvincula ({ key | null })
//
// Defensivo 42P01/42703 (migrations 208/209 pendentes) → 503
// MIGRATION_STUDIO_VISUAL_PENDING, mesmo padrão do studioSaleItemPatch.
//
// 02/07/2026 — F0 do escopo Visualização 3D/2D (contrato no chat c/ Caio)
// ============================================================
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

const TEMPLATE_KINDS = ['photo2d', 'model3d'];
const TEMPLATE_STATUS = ['draft', 'published', 'archived'];
const RENDER_KINDS = ['preview', 'hd_2d', 'snapshot_3d', 'turntable_video'];
const STAFF_DOMAIN = '@getaura.com.br';

// ── Staff check (users.is_staff; fallback domínio interno) ──
let staffColMissing = false; // cache module-level (padrão CLAUDE.md)
async function isStaff(userId) {
  if (!userId) return false;
  try {
    const { rows } = await db.query(
      staffColMissing
        ? 'SELECT email FROM users WHERE id = $1'
        : 'SELECT email, is_staff FROM users WHERE id = $1',
      [userId]
    );
    if (!rows.length) return false;
    const u = rows[0];
    if (u.is_staff === true) return true;
    return typeof u.email === 'string' && u.email.toLowerCase().endsWith(STAFF_DOMAIN);
  } catch (e) {
    if (e.code === '42703' && !staffColMissing) {
      staffColMissing = true;
      return isStaff(userId);
    }
    throw e;
  }
}

async function requireStaff(req, res, next) {
  try {
    if (await isStaff(req.user && req.user.id)) return next();
    return res.status(403).json({ error: 'Apenas equipe Aura pode gerenciar templates visuais' });
  } catch (err) {
    console.error('[studio/visual-templates] staff check error:', err.message);
    return res.status(500).json({ error: 'Erro ao verificar permissão' });
  }
}

// ── Hash canônico do render (prova de aprovação) ───────────
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function renderHash(templateKey, templateVersion, customization) {
  const payload = String(templateKey) + '@' + String(templateVersion) + '|' + stableStringify(customization || {});
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function isMigrationPending(err) {
  return err && (err.code === '42P01' || err.code === '42703');
}

function migrationPendingRes(res) {
  return res.status(503).json({
    error: 'Schema do Visual Engine ainda não aplicado (migrations 208/209). Aguarde alguns minutos.',
    code: 'MIGRATION_STUDIO_VISUAL_PENDING',
  });
}

// Visibility canonica de products (mesma de studioSaleItemPatch/products.js)
function productVisibilityWhere(pidParam, cidParam) {
  return `p.id = ${pidParam} AND (p.company_id = ${cidParam} OR (
    p.is_group_shared = true
    AND p.company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

// ── GET /studio/visual-templates ────────────────────────────
// Lojista: só published. Staff com ?all=1 vê draft/archived também.
router.get('/visual-templates', async (req, res) => {
  try {
    const wantAll = req.query.all === '1' || req.query.all === 'true';
    const staff = wantAll ? await isStaff(req.user && req.user.id) : false;
    const params = [];
    let where = '';
    if (!(wantAll && staff)) {
      params.push('published');
      where = 'WHERE status = $1';
    }
    if (req.query.kind && TEMPLATE_KINDS.includes(req.query.kind)) {
      params.push(req.query.kind);
      where += (where ? ' AND' : 'WHERE') + ' kind = $' + params.length;
    }
    const { rows } = await db.query(
      `SELECT id, key, name, kind, status, version, updated_at
         FROM studio_visual_templates ${where}
        ORDER BY name ASC`,
      params
    );
    res.json({ templates: rows, count: rows.length });
  } catch (err) {
    if (isMigrationPending(err)) return migrationPendingRes(res);
    console.error('[studio/visual-templates] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar templates visuais' });
  }
});

// ── GET /studio/visual-templates/:key ───────────────────────
router.get('/visual-templates/:key', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, key, name, kind, status, version, spec, created_at, updated_at
         FROM studio_visual_templates WHERE key = $1`,
      [req.params.key]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Template visual não encontrado' });
    }
    const t = rows[0];
    if (t.status !== 'published') {
      const staff = await isStaff(req.user && req.user.id);
      if (!staff) return res.status(404).json({ error: 'Template visual não encontrado' });
    }
    res.json({ template: t });
  } catch (err) {
    if (isMigrationPending(err)) return migrationPendingRes(res);
    console.error('[studio/visual-templates] get error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar template visual' });
  }
});

// ── POST /studio/visual-templates (staff) ───────────────────
// body: { key, name, kind, spec?, status? }
router.post('/visual-templates', requireStaff, async (req, res) => {
  const { key, name, kind, spec = {}, status = 'draft' } = req.body || {};
  if (!key || typeof key !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(key)) {
    return res.status(400).json({ error: 'key obrigatória (slug: a-z, 0-9, hífen)' });
  }
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name obrigatório' });
  }
  if (!TEMPLATE_KINDS.includes(kind)) {
    return res.status(400).json({ error: 'kind inválido', allowed: TEMPLATE_KINDS });
  }
  if (!TEMPLATE_STATUS.includes(status)) {
    return res.status(400).json({ error: 'status inválido', allowed: TEMPLATE_STATUS });
  }
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    return res.status(400).json({ error: 'spec deve ser objeto JSON' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO studio_visual_templates (key, name, kind, status, spec)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (key) DO NOTHING
       RETURNING id, key, name, kind, status, version`,
      [key, name, kind, status, JSON.stringify(spec)]
    );
    if (!rows.length) {
      return res.status(409).json({ error: 'Já existe template com esta key', key });
    }
    res.status(201).json({ template: rows[0] });
  } catch (err) {
    if (isMigrationPending(err)) return migrationPendingRes(res);
    console.error('[studio/visual-templates] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar template visual' });
  }
});

// ── PUT /studio/visual-templates/:key (staff) ───────────────
// body: { name?, spec?, status? } — spec nova incrementa version
router.put('/visual-templates/:key', requireStaff, async (req, res) => {
  const { name, spec, status } = req.body || {};
  if (name === undefined && spec === undefined && status === undefined) {
    return res.status(400).json({ error: 'Nada para atualizar (name, spec ou status)' });
  }
  if (status !== undefined && !TEMPLATE_STATUS.includes(status)) {
    return res.status(400).json({ error: 'status inválido', allowed: TEMPLATE_STATUS });
  }
  if (spec !== undefined && (typeof spec !== 'object' || spec === null || Array.isArray(spec))) {
    return res.status(400).json({ error: 'spec deve ser objeto JSON' });
  }
  try {
    const sets = [];
    const params = [];
    if (name !== undefined) {
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (status !== undefined) {
      params.push(status);
      sets.push(`status = $${params.length}`);
    }
    if (spec !== undefined) {
      params.push(JSON.stringify(spec));
      sets.push(`spec = $${params.length}::jsonb`);
      sets.push(`version = version + (CASE WHEN spec IS DISTINCT FROM $${params.length}::jsonb THEN 1 ELSE 0 END)`);
    }
    sets.push('updated_at = NOW()');
    params.push(req.params.key);
    const { rows } = await db.query(
      `UPDATE studio_visual_templates SET ${sets.join(', ')}
        WHERE key = $${params.length}
        RETURNING id, key, name, kind, status, version, updated_at`,
      params
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Template visual não encontrado' });
    }
    res.json({ template: rows[0] });
  } catch (err) {
    if (isMigrationPending(err)) return migrationPendingRes(res);
    console.error('[studio/visual-templates] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar template visual' });
  }
});

// ── GET /studio/products/:pid/visual-template (F4) ───────────
// Template publicado do produto (visibilidade canônica). null = sem vínculo.
router.get('/products/:pid/visual-template', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT p.id AS product_id, p.visual_template_key,
              t.key, t.name, t.kind, t.version, t.spec
         FROM products p
         LEFT JOIN studio_visual_templates t
           ON t.key = p.visual_template_key AND t.status = 'published'
        WHERE ${productVisibilityWhere('$1', '$2')}
        LIMIT 1`,
      [req.params.pid, cid]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    const r = rows[0];
    res.json({
      product_id: r.product_id,
      visual_template_key: r.visual_template_key || null,
      template: r.key ? { key: r.key, name: r.name, kind: r.kind, version: r.version, spec: r.spec } : null,
    });
  } catch (err) {
    if (isMigrationPending(err)) return migrationPendingRes(res);
    console.error('[studio/products/visual-template] get error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar template do produto' });
  }
});

// ── PUT /studio/products/:pid/visual-template (F4) ───────────
// body: { key: string | null } — lojista vincula produto a um template
// publicado (ou desvincula com null). Escrita só no produto PRÓPRIO
// (company_id = cid), espelhando a regra de write path do grupo.
router.put('/products/:pid/visual-template', async (req, res) => {
  const cid = req.params.id;
  const body = req.body || {};
  const key = body.key === undefined ? undefined : body.key;
  if (key === undefined || (key !== null && typeof key !== 'string')) {
    return res.status(400).json({ error: 'Informe { key: string } ou { key: null } para desvincular' });
  }
  try {
    if (key) {
      const t = await db.query(
        `SELECT 1 FROM studio_visual_templates WHERE key = $1 AND status = 'published' LIMIT 1`,
        [key]
      );
      if (!t.rows.length) {
        return res.status(404).json({ error: 'Template visual não encontrado ou não publicado', key });
      }
    }
    const { rows } = await db.query(
      `UPDATE products SET visual_template_key = $1
        WHERE id = $2 AND company_id = $3
        RETURNING id, visual_template_key`,
      [key, req.params.pid, cid]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Produto não encontrado nesta empresa' });
    }
    res.json({ ok: true, product_id: rows[0].id, visual_template_key: rows[0].visual_template_key });
  } catch (err) {
    if (isMigrationPending(err)) return migrationPendingRes(res);
    console.error('[studio/products/visual-template] put error:', err.message);
    res.status(500).json({ error: 'Erro ao vincular template ao produto' });
  }
});

// ── POST /studio/visual-renders ─────────────────────────────
// body: { template_key, template_version?, kind, customization,
//         file_url?, file_key?, content_type?,
//         sale_item_id? | digital_order_item_id? }
router.post('/visual-renders', async (req, res) => {
  const cid = req.params.id;
  const {
    template_key, template_version, kind, customization,
    file_url = null, file_key = null, content_type = null,
    sale_item_id = null, digital_order_item_id = null,
  } = req.body || {};

  if (!template_key || typeof template_key !== 'string') {
    return res.status(400).json({ error: 'template_key obrigatório' });
  }
  if (!RENDER_KINDS.includes(kind)) {
    return res.status(400).json({ error: 'kind inválido', allowed: RENDER_KINDS });
  }
  if (!customization || typeof customization !== 'object' || Array.isArray(customization)) {
    return res.status(400).json({ error: 'customization (objeto JSON) obrigatório' });
  }

  try {
    // Resolve versão atual do template quando não informada
    let version = parseInt(template_version, 10);
    if (!Number.isFinite(version) || version < 1) {
      const t = await db.query(
        'SELECT version FROM studio_visual_templates WHERE key = $1',
        [template_key]
      );
      if (!t.rows.length) {
        return res.status(404).json({ error: 'Template visual não encontrado', template_key });
      }
      version = t.rows[0].version;
    }

    const hash = renderHash(template_key, version, customization);
    const { rows } = await db.query(
      `INSERT INTO studio_visual_renders
         (company_id, template_key, template_version, sale_item_id,
          digital_order_item_id, kind, customization, content_hash,
          file_url, file_key, content_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
       RETURNING id, template_key, template_version, kind, content_hash, file_url, created_at`,
      [cid, template_key, version, sale_item_id, digital_order_item_id,
       kind, JSON.stringify(customization), hash,
       file_url, file_key, content_type, req.user && req.user.id]
    );
    res.status(201).json({ render: rows[0] });
  } catch (err) {
    if (isMigrationPending(err)) return migrationPendingRes(res);
    console.error('[studio/visual-renders] create error:', err.message);
    res.status(500).json({ error: 'Erro ao registrar render' });
  }
});

// ── GET /studio/visual-renders ──────────────────────────────
// query: sale_item_id | digital_order_item_id (um dos dois)
router.get('/visual-renders', async (req, res) => {
  const cid = req.params.id;
  const { sale_item_id, digital_order_item_id } = req.query;
  if (!sale_item_id && !digital_order_item_id) {
    return res.status(400).json({ error: 'Informe sale_item_id ou digital_order_item_id' });
  }
  try {
    const col = sale_item_id ? 'sale_item_id' : 'digital_order_item_id';
    const val = sale_item_id || digital_order_item_id;
    const { rows } = await db.query(
      `SELECT id, template_key, template_version, kind, customization,
              content_hash, file_url, content_type, created_at
         FROM studio_visual_renders
        WHERE company_id = $1 AND ${col} = $2
        ORDER BY created_at DESC`,
      [cid, val]
    );
    res.json({ renders: rows, count: rows.length });
  } catch (err) {
    if (isMigrationPending(err)) return migrationPendingRes(res);
    console.error('[studio/visual-renders] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar renders' });
  }
});

module.exports = router;
