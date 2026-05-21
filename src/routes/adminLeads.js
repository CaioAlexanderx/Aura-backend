// ============================================================
// AURA. - CRM Comercial - Leads (prospects pre-venda)
// Fase 4: dynamic_score, expected_plan/mrr, batch, cadence apply, rotten
// Fase 5 (21/05): filtros stale_days, recent_hours, status_in/status_not_in
// Fase 5.1 (21/05): GET /queue agora aceita TODOS os filtros + GET /leads
//                   retorna pipeline_filtered (sem perder o pipeline global)
// ============================================================

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];

const VALID_STATUSES = ['new', 'contacted', 'responded', 'interested', 'demo', 'converted', 'lost'];
const VALID_CHANNELS = ['whatsapp', 'ligacao', 'email', 'visita', 'sem_resposta', 'outro'];
const VALID_PLANS    = ['essencial', 'negocio', 'expansao'];

// Whitelist editavel via PATCH e BATCH
const EDITABLE_FIELDS = [
  'name','phone','city','category','address','website',
  'status','lost_reason','next_followup_at','converted_company_id',
  'expected_plan','expected_mrr','cadence_name','cadence_day','rotten_since',
];

// ── Helper: extrai conditions/params a partir do filter object ────────
// Usado tanto em GET /admin/leads quanto em GET /admin/lead-views (count)
// quanto em GET /admin/leads/queue (Fase 5.1: filtros aplicaveis a queue).
function buildLeadFilterConditions(filters) {
  const {
    status, city, category, followup_due, has_phone,
    min_rating, no_contact, search,
    min_score, expected_plan, is_rotten,
    status_in, status_not_in, stale_days, recent_hours,
  } = filters || {};

  const conditions = [];
  const params = [];
  let idx = 1;

  if (status)                  { conditions.push(`l.status = $${idx++}`); params.push(status); }
  if (city)                    { conditions.push(`l.city ILIKE $${idx++}`); params.push(`%${city}%`); }
  if (category)                { conditions.push(`l.category ILIKE $${idx++}`); params.push(`%${category}%`); }
  if (followup_due === 'true' || followup_due === true) {
    conditions.push(`l.next_followup_at IS NOT NULL AND l.next_followup_at <= NOW()`);
  }
  if (has_phone === 'true' || has_phone === true) {
    conditions.push(`l.phone IS NOT NULL AND l.phone != ''`);
  }
  if (min_rating)              { conditions.push(`l.google_rating >= $${idx++}`); params.push(parseFloat(min_rating)); }
  if (min_score)               { conditions.push(`l.dynamic_score >= $${idx++}`); params.push(parseInt(min_score)); }
  if (expected_plan)           { conditions.push(`l.expected_plan = $${idx++}`); params.push(expected_plan); }
  if (is_rotten === 'true' || is_rotten === true)   { conditions.push(`l.rotten_since IS NOT NULL`); }
  if (is_rotten === 'false' || is_rotten === false) { conditions.push(`l.rotten_since IS NULL`); }
  if (no_contact === 'true' || no_contact === true) {
    conditions.push(`l.status = 'new' AND NOT EXISTS (SELECT 1 FROM lead_interactions li WHERE li.lead_id = l.id)`);
  }

  // ── Fase 5: filtros novos ─────────────────────────────────────────
  if (status_in) {
    const arr = String(status_in).split(',').map(s => s.trim()).filter(s => VALID_STATUSES.includes(s));
    if (arr.length) {
      conditions.push(`l.status = ANY($${idx++}::text[])`);
      params.push(arr);
    }
  }
  if (status_not_in) {
    const arr = String(status_not_in).split(',').map(s => s.trim()).filter(s => VALID_STATUSES.includes(s));
    if (arr.length) {
      conditions.push(`l.status <> ALL($${idx++}::text[])`);
      params.push(arr);
    }
  }
  if (stale_days) {
    const days = parseInt(stale_days);
    if (!isNaN(days) && days > 0) {
      conditions.push(`(l.last_activity_at IS NULL OR l.last_activity_at < NOW() - ($${idx++}::int * INTERVAL '1 day'))`);
      params.push(days);
    }
  }
  if (recent_hours) {
    const hours = parseInt(recent_hours);
    if (!isNaN(hours) && hours > 0) {
      conditions.push(`l.created_at > NOW() - ($${idx++}::int * INTERVAL '1 hour')`);
      params.push(hours);
    }
  }

  if (search) {
    conditions.push(`(l.name ILIKE $${idx} OR l.phone ILIKE $${idx + 1} OR l.address ILIKE $${idx + 2})`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    idx += 3;
  }

  return { conditions, params, idx };
}

module.exports.buildLeadFilterConditions = buildLeadFilterConditions;

// ── Helper: pipeline FILTRADO (sem o filtro status, pra mostrar a quebra
//    do mesmo conjunto filtrado por OUTRAS dimensoes em cada status). ──
async function buildPipelineFiltered(filters) {
  // Remove status/status_in/status_not_in pra ver TODOS os status do conjunto filtrado
  const cleanedFilters = { ...filters };
  delete cleanedFilters.status;
  delete cleanedFilters.status_in;
  delete cleanedFilters.status_not_in;

  const { conditions, params } = buildLeadFilterConditions(cleanedFilters);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows: counts } = await pool.query(
    `SELECT l.status, COUNT(*) AS total, COALESCE(SUM(l.expected_mrr),0) AS potential_mrr
     FROM sales_leads l ${where} GROUP BY l.status`,
    params
  );
  const pipeline = Object.fromEntries(VALID_STATUSES.map(s => [s, { count: 0, potential_mrr: 0 }]));
  counts.forEach(r => {
    pipeline[r.status] = { count: parseInt(r.total), potential_mrr: parseFloat(r.potential_mrr) };
  });
  return pipeline;
}

// ============================================================
// GET /admin/leads - lista + filtros completos + pipeline (global e filtrado)
// ============================================================
router.get('/', ...adminOnly, asyncHandler(async (req, res) => {
  const { limit = 200, offset = 0 } = req.query;
  const { conditions, params, idx: startIdx } = buildLeadFilterConditions(req.query);
  let idx = startIdx;
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT l.*,
            COUNT(i.id)::int  AS interaction_count,
            MAX(i.created_at) AS last_interaction_at,
            (l.next_followup_at IS NOT NULL AND l.next_followup_at <= NOW()) AS followup_overdue
     FROM sales_leads l
     LEFT JOIN lead_interactions i ON i.lead_id = l.id
     ${where}
     GROUP BY l.id
     ORDER BY
       (l.next_followup_at IS NOT NULL AND l.next_followup_at <= NOW()) DESC,
       l.dynamic_score DESC NULLS LAST,
       CASE l.status
         WHEN 'demo'        THEN 1
         WHEN 'interested'  THEN 2
         WHEN 'responded'   THEN 3
         WHEN 'contacted'   THEN 4
         WHEN 'new'         THEN 5
         WHEN 'converted'   THEN 6
         WHEN 'lost'        THEN 7
       END,
       l.next_followup_at ASC NULLS LAST,
       l.updated_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, parseInt(limit), parseInt(offset)]
  );

  // Pipeline GLOBAL (base inteira, sem filtros) - mantido pra retrocompat
  const { rows: counts } = await pool.query(
    `SELECT status, COUNT(*) AS total, COALESCE(SUM(expected_mrr),0) AS potential_mrr
     FROM sales_leads GROUP BY status`
  );
  const pipeline = Object.fromEntries(VALID_STATUSES.map(s => [s, { count: 0, potential_mrr: 0 }]));
  counts.forEach(r => {
    pipeline[r.status] = { count: parseInt(r.total), potential_mrr: parseFloat(r.potential_mrr) };
  });

  // Pipeline FILTRADO (Fase 5.1): ignora apenas o filtro de status pra mostrar
  // a quebra do conjunto filtrado por OUTRAS dimensoes em cada status.
  // Ex: filtrei por city=Jacarei, vejo quantos sao new/contacted/etc DESSA cidade.
  const pipelineFiltered = await buildPipelineFiltered(req.query);

  res.json({
    total: rows.length,
    pipeline,           // base inteira
    pipeline_filtered: pipelineFiltered,  // respeitando filtros (menos status)
    leads: rows,
  });
}));

// ============================================================
// GET /admin/leads/meta - cidades, categorias e stats
// ============================================================
router.get('/meta', ...adminOnly, asyncHandler(async (req, res) => {
  const [citiesRes, categoriesRes, statsRes] = await Promise.all([
    pool.query(`SELECT DISTINCT city, COUNT(*) as total FROM sales_leads WHERE city IS NOT NULL AND city != '' GROUP BY city ORDER BY total DESC`),
    pool.query(`SELECT DISTINCT category, COUNT(*) as total FROM sales_leads WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY total DESC`),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone != '')::int AS with_phone,
        COUNT(*) FILTER (WHERE google_rating >= 4)::int                AS high_rated,
        COUNT(*) FILTER (WHERE next_followup_at <= NOW())::int         AS followup_overdue,
        COUNT(*) FILTER (WHERE rotten_since IS NOT NULL)::int           AS rotten_total,
        COUNT(*) FILTER (WHERE dynamic_score >= 50)::int                AS hot_total,
        COUNT(*) FILTER (WHERE status = 'new' AND NOT EXISTS (
          SELECT 1 FROM lead_interactions li WHERE li.lead_id = sales_leads.id
        ))::int AS never_contacted,
        COUNT(*)::int AS total
      FROM sales_leads
    `),
  ]);

  res.json({
    cities:     citiesRes.rows.map(r => ({ name: r.city, total: parseInt(r.total) })),
    categories: categoriesRes.rows.map(r => ({ name: r.category, total: parseInt(r.total) })),
    stats:      statsRes.rows[0],
  });
}));

// ============================================================
// GET /admin/leads/stats - funil + taxas + MRR potencial
// ============================================================
router.get('/stats', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int                                                                       AS total,
      COUNT(*) FILTER (WHERE status != 'new')::int                                        AS contacted_total,
      COUNT(*) FILTER (WHERE status IN ('responded','interested','demo','converted'))::int AS responded_total,
      COUNT(*) FILTER (WHERE status IN ('interested','demo','converted'))::int             AS interested_total,
      COUNT(*) FILTER (WHERE status IN ('demo','converted'))::int                          AS demo_total,
      COUNT(*) FILTER (WHERE status = 'converted')::int                                    AS converted_total,
      COUNT(*) FILTER (WHERE status = 'lost')::int                                         AS lost_total,
      COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone != '')::int                       AS with_phone,
      ROUND(AVG(google_rating) FILTER (WHERE google_rating IS NOT NULL), 1)                AS avg_rating,
      COUNT(*) FILTER (WHERE next_followup_at IS NOT NULL AND next_followup_at <= NOW())::int AS overdue,
      COALESCE(SUM(expected_mrr) FILTER (WHERE status IN ('interested','demo')), 0)::numeric  AS pipeline_mrr,
      COALESCE(SUM(expected_mrr) FILTER (WHERE status = 'converted'), 0)::numeric            AS won_mrr,
      AVG(dynamic_score)::int                                                             AS avg_score
    FROM sales_leads
  `);

  const s = rows[0];
  const total = s.total || 1;

  res.json({
    ...s,
    rate_contacted:  Math.round((s.contacted_total  / total) * 100),
    rate_responded:  Math.round((s.responded_total  / (s.contacted_total  || 1)) * 100),
    rate_interested: Math.round((s.interested_total / (s.responded_total  || 1)) * 100),
    rate_demo:       Math.round((s.demo_total       / (s.interested_total || 1)) * 100),
    rate_converted:  Math.round((s.converted_total  / total) * 100),
  });
}));

// ============================================================
// GET /admin/leads/export - CSV
// ============================================================
router.get('/export', ...adminOnly, asyncHandler(async (req, res) => {
  // Fase 5.1: usa buildLeadFilterConditions pra reaproveitar todos os filtros
  const { conditions, params } = buildLeadFilterConditions(req.query);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT l.name, l.phone, l.city, l.category, l.address, l.website,
            l.google_rating, l.google_reviews, l.status, l.source,
            l.expected_plan, l.expected_mrr, l.dynamic_score,
            l.last_contact_at, l.next_followup_at, l.rotten_since, l.created_at
     FROM sales_leads l ${where} ORDER BY l.dynamic_score DESC NULLS LAST, l.google_rating DESC NULLS LAST`,
    params
  );

  const header = ['nome','telefone','cidade','categoria','endereco','site','nota_google','num_avaliacoes','status','fonte','plano_esperado','mrr_esperado','score','ultimo_contato','proximo_followup','rotten_desde','cadastrado_em'];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fmt = (d) => d ? new Date(d).toLocaleDateString('pt-BR') : '';
  const lines = [
    header.join(','),
    ...rows.map(r => [
      r.name, r.phone, r.city, r.category, r.address, r.website,
      r.google_rating, r.google_reviews, r.status, r.source,
      r.expected_plan, r.expected_mrr, r.dynamic_score,
      fmt(r.last_contact_at), fmt(r.next_followup_at), fmt(r.rotten_since), fmt(r.created_at),
    ].map(escape).join(',')),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n'));
}));

// ============================================================
// POST /admin/leads/batch - acoes em massa
// body: { ids: [...], action: 'update_status'|'assign_cadence'|'set_expected_plan'|'delete'|'mark_rotten', payload: {...} }
// ============================================================
router.post('/batch', ...adminOnly, asyncHandler(async (req, res) => {
  const { ids, action, payload = {} } = req.body;
  if (!Array.isArray(ids) || !ids.length) throw new AppError('ids deve ser array nao vazio', 400);
  if (ids.length > 500) throw new AppError('Maximo 500 leads por batch', 400);

  let affected = 0;

  switch (action) {
    case 'update_status': {
      if (!VALID_STATUSES.includes(payload.status))
        throw new AppError(`status invalido. Use: ${VALID_STATUSES.join(', ')}`, 400);
      const { rowCount } = await pool.query(
        `UPDATE sales_leads
         SET status = $1, last_contact_at = CASE WHEN $1 != 'new' THEN NOW() ELSE last_contact_at END
         WHERE id = ANY($2::uuid[])`,
        [payload.status, ids]
      );
      affected = rowCount;
      break;
    }
    case 'set_expected_plan': {
      if (payload.expected_plan && !VALID_PLANS.includes(payload.expected_plan))
        throw new AppError(`expected_plan invalido. Use: ${VALID_PLANS.join(', ')}`, 400);
      const { rowCount } = await pool.query(
        `UPDATE sales_leads SET expected_plan = $1, expected_mrr = $2 WHERE id = ANY($3::uuid[])`,
        [payload.expected_plan || null, payload.expected_mrr || null, ids]
      );
      affected = rowCount;
      break;
    }
    case 'assign_cadence': {
      if (!payload.cadence_name) throw new AppError('cadence_name obrigatorio', 400);
      const { rowCount } = await pool.query(
        `UPDATE sales_leads SET cadence_name = $1, cadence_day = 0, next_followup_at = NOW() WHERE id = ANY($2::uuid[])`,
        [payload.cadence_name, ids]
      );
      affected = rowCount;
      break;
    }
    case 'mark_rotten': {
      const { rowCount } = await pool.query(
        `UPDATE sales_leads SET rotten_since = NOW() WHERE id = ANY($1::uuid[]) AND rotten_since IS NULL`,
        [ids]
      );
      affected = rowCount;
      break;
    }
    case 'unmark_rotten': {
      const { rowCount } = await pool.query(
        `UPDATE sales_leads SET rotten_since = NULL WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      affected = rowCount;
      break;
    }
    case 'set_followup': {
      if (!payload.next_followup_at) throw new AppError('next_followup_at obrigatorio', 400);
      const { rowCount } = await pool.query(
        `UPDATE sales_leads SET next_followup_at = $1 WHERE id = ANY($2::uuid[])`,
        [payload.next_followup_at, ids]
      );
      affected = rowCount;
      break;
    }
    case 'delete': {
      const { rowCount } = await pool.query(
        `DELETE FROM sales_leads WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      affected = rowCount;
      break;
    }
    default:
      throw new AppError(`Acao invalida. Use: update_status, set_expected_plan, assign_cadence, mark_rotten, unmark_rotten, set_followup, delete`, 400);
  }

  res.json({ action, affected, total: ids.length });
}));

// ============================================================
// POST /admin/leads/recompute-scores - recalcula dynamic_score em massa
// ============================================================
router.post('/recompute-scores', ...adminOnly, asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query(`
    UPDATE sales_leads
    SET dynamic_score = compute_lead_score_from_fields(
      status, expected_plan, google_rating, google_reviews,
      last_activity_at, rotten_since, phone
    )
  `);
  res.json({ recomputed: rowCount });
}));

// ============================================================
// POST /admin/leads/mark-rotten - aplica rotten flag em massa via funcao SQL
// body: { threshold_days?: number (default 14) }
// ============================================================
router.post('/mark-rotten', ...adminOnly, asyncHandler(async (req, res) => {
  const threshold = parseInt(req.body?.threshold_days) || 14;
  const { rows } = await pool.query(`SELECT mark_rotten_leads($1) AS affected`, [threshold]);
  res.json({ threshold_days: threshold, affected: rows[0].affected });
}));

// ============================================================
// GET /admin/leads/queue - Fila do dia priorizada
// Fase 5.1: aceita TODOS os filtros padrao (city, category, status_in, etc).
// A logica de priorizacao roda DEPOIS de aplicar os filtros — entao Caio pode
// fazer "fila so de Jacarei" ou "fila so de odontologia".
//
// Comportamento sutil: o filtro is_rotten=false e status_not_in=converted,lost
// SAO ENFORCED IMPLICITAMENTE (queue ignora rotten e ja-vendidos por design).
// Filtros do usuario sao ADITIVOS (AND).
// ============================================================
router.get('/queue', ...adminOnly, asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { conditions, params, idx: startIdx } = buildLeadFilterConditions(req.query);
  let idx = startIdx;

  // Enforces SEMPRE: nao mostra rotten/converted/lost na fila
  const baseConditions = [
    `l.status NOT IN ('converted','lost')`,
    `l.rotten_since IS NULL`,
    ...conditions,
  ];
  const where = 'WHERE ' + baseConditions.join(' AND ');

  // Expressao de priorizacao reutilizada em 3 lugares (SELECT/HAVING/ORDER BY)
  const priorityExpr = `CASE
    WHEN l.next_followup_at IS NOT NULL AND l.next_followup_at <= NOW() THEN 100
    WHEN l.status IN ('demo','interested') AND (l.last_activity_at IS NULL OR l.last_activity_at < NOW() - INTERVAL '3 days') THEN 80
    WHEN l.dynamic_score >= 50 AND (l.last_activity_at IS NULL OR l.last_activity_at < NOW() - INTERVAL '7 days') THEN 60
    WHEN l.status = 'new' AND l.created_at > NOW() - INTERVAL '24 hours' THEN 40
    ELSE 0
  END`;

  const reasonExpr = `CASE
    WHEN l.next_followup_at IS NOT NULL AND l.next_followup_at <= NOW() THEN 'followup_overdue'
    WHEN l.status IN ('demo','interested') AND (l.last_activity_at IS NULL OR l.last_activity_at < NOW() - INTERVAL '3 days') THEN 'funnel_stalled'
    WHEN l.dynamic_score >= 50 AND (l.last_activity_at IS NULL OR l.last_activity_at < NOW() - INTERVAL '7 days') THEN 'hot_cold'
    WHEN l.status = 'new' AND l.created_at > NOW() - INTERVAL '24 hours' THEN 'new_lead'
    ELSE 'other'
  END`;

  const { rows } = await pool.query(
    `SELECT l.*,
            COUNT(i.id)::int  AS interaction_count,
            MAX(i.created_at) AS last_interaction_at,
            (l.next_followup_at IS NOT NULL AND l.next_followup_at <= NOW()) AS followup_overdue,
            ${priorityExpr} AS priority_score,
            ${reasonExpr}   AS priority_reason
     FROM sales_leads l
     LEFT JOIN lead_interactions i ON i.lead_id = l.id
     ${where}
     GROUP BY l.id
     HAVING ${priorityExpr.replace(/CASE/g, 'CASE').trim()} > 0
     ORDER BY ${priorityExpr} DESC,
              l.dynamic_score DESC NULLS LAST,
              l.next_followup_at ASC NULLS LAST
     LIMIT $${idx}`,
    [...params, limit]
  );

  // Summary por reason
  const byReason = rows.reduce((acc, r) => {
    acc[r.priority_reason] = (acc[r.priority_reason] || 0) + 1;
    return acc;
  }, {});

  res.json({
    total: rows.length,
    by_reason: byReason,
    leads: rows,
  });
}));

// ============================================================
// GET /admin/leads/:id - detalhe + interactions
// ============================================================
router.get('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM sales_leads WHERE id = $1`, [req.params.id]);
  if (!rows.length) throw new AppError('Lead nao encontrado', 404);

  const { rows: interactions } = await pool.query(
    `SELECT * FROM lead_interactions WHERE lead_id = $1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json({ lead: rows[0], interactions });
}));

// ============================================================
// POST /admin/leads - criar manual
// ============================================================
router.post('/', ...adminOnly, asyncHandler(async (req, res) => {
  const {
    name, phone, city, category, address, website, google_rating, google_reviews,
    source = 'manual', expected_plan, expected_mrr,
  } = req.body;
  if (!name) throw new AppError('name e obrigatorio', 400);
  if (expected_plan && !VALID_PLANS.includes(expected_plan))
    throw new AppError(`expected_plan invalido. Use: ${VALID_PLANS.join(', ')}`, 400);

  const { rows } = await pool.query(
    `INSERT INTO sales_leads (name, phone, city, category, address, website, google_rating, google_reviews, source, expected_plan, expected_mrr)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [name, phone || null, city || null, category || null, address || null, website || null,
     google_rating || null, google_reviews || null, source, expected_plan || null, expected_mrr || null]
  );
  res.status(201).json({ lead: rows[0] });
}));

// ============================================================
// POST /admin/leads/import - bulk via array (Google Maps scraping)
// ============================================================
router.post('/import', ...adminOnly, asyncHandler(async (req, res) => {
  const { leads } = req.body;
  if (!Array.isArray(leads) || !leads.length) throw new AppError('leads deve ser um array nao vazio', 400);
  if (leads.length > 2000) throw new AppError('Maximo 2000 leads por importacao', 400);

  let inserted = 0;
  let skipped = 0;
  const CHUNK = 100;

  for (let i = 0; i < leads.length; i += CHUNK) {
    const chunk = leads.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((lead, j) => {
      const base = j * 8;
      values.push(
        String(lead.name || '').trim() || 'Sem nome',
        lead.phone   ? String(lead.phone).replace(/\D/g, '') : null,
        lead.city    ? String(lead.city).trim()    : null,
        lead.category? String(lead.category).trim(): null,
        lead.address ? String(lead.address).trim() : null,
        lead.website ? String(lead.website).trim() : null,
        lead.google_rating  ? parseFloat(lead.google_rating)  : null,
        lead.google_reviews ? parseInt(lead.google_reviews)   : null,
      );
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},'google_maps')`;
    });

    const { rowCount } = await pool.query(
      `INSERT INTO sales_leads (name,phone,city,category,address,website,google_rating,google_reviews,source)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values
    );
    inserted += rowCount || 0;
    skipped  += chunk.length - (rowCount || 0);
  }

  res.status(201).json({ inserted, skipped, total: leads.length });
}));

// ============================================================
// PATCH /admin/leads/:id - editar campos
// ============================================================
router.patch('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const fields = []; const values = []; let idx = 1;

  for (const key of EDITABLE_FIELDS) {
    if (req.body[key] !== undefined) {
      if (key === 'status' && !VALID_STATUSES.includes(req.body[key]))
        throw new AppError(`status invalido. Use: ${VALID_STATUSES.join(', ')}`, 400);
      if (key === 'expected_plan' && req.body[key] && !VALID_PLANS.includes(req.body[key]))
        throw new AppError(`expected_plan invalido. Use: ${VALID_PLANS.join(', ')}`, 400);
      fields.push(`${key}=$${idx++}`);
      values.push(req.body[key]);
    }
  }
  if (!fields.length) throw new AppError('Nenhum campo para atualizar', 400);

  if (req.body.status && req.body.status !== 'new') {
    fields.push(`last_contact_at=NOW()`);
  }

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE sales_leads SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`,
    values
  );
  if (!rows.length) throw new AppError('Lead nao encontrado', 404);
  res.json({ lead: rows[0] });
}));

// ============================================================
// DELETE /admin/leads/:id
// ============================================================
router.delete('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`DELETE FROM sales_leads WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!rows.length) throw new AppError('Lead nao encontrado', 404);
  res.json({ message: 'Lead removido' });
}));

// ============================================================
// POST /admin/leads/:id/apply-cadence - aplicar cadencia a um lead
// body: { cadence_name: string, start_day?: number (default 0) }
// ============================================================
router.post('/:id/apply-cadence', ...adminOnly, asyncHandler(async (req, res) => {
  const { cadence_name, start_day = 0 } = req.body;
  if (!cadence_name) throw new AppError('cadence_name obrigatorio', 400);

  const { rows: cadRows } = await pool.query(
    `SELECT id, name, steps FROM lead_cadences WHERE name = $1 AND is_active = TRUE`,
    [cadence_name]
  );
  if (!cadRows.length) throw new AppError(`Cadencia "${cadence_name}" nao encontrada ou inativa`, 404);

  const cadence = cadRows[0];
  const steps = Array.isArray(cadence.steps) ? cadence.steps : [];

  const nextStep = steps.find(s => Number(s.day) >= Number(start_day));
  const nextFollowupAt = nextStep
    ? new Date(Date.now() + Number(nextStep.day) * 24 * 60 * 60 * 1000)
    : null;

  const { rows } = await pool.query(
    `UPDATE sales_leads
     SET cadence_name = $1, cadence_day = $2, next_followup_at = $3
     WHERE id = $4 RETURNING *`,
    [cadence_name, start_day, nextFollowupAt, req.params.id]
  );
  if (!rows.length) throw new AppError('Lead nao encontrado', 404);

  res.json({
    lead: rows[0],
    cadence: { name: cadence.name, total_steps: steps.length, next_step: nextStep },
  });
}));

// ============================================================
// POST /admin/leads/:id/interactions - registrar contato
// ============================================================
router.post('/:id/interactions', ...adminOnly, asyncHandler(async (req, res) => {
  const { body, channel, new_status, next_followup_at, advance_cadence } = req.body;
  if (!body) throw new AppError('body (texto) e obrigatorio', 400);
  if (channel && !VALID_CHANNELS.includes(channel))
    throw new AppError(`channel invalido. Use: ${VALID_CHANNELS.join(', ')}`, 400);
  if (new_status && !VALID_STATUSES.includes(new_status))
    throw new AppError(`status invalido. Use: ${VALID_STATUSES.join(', ')}`, 400);

  const { rows: leadRows } = await pool.query(
    `SELECT id, cadence_name, cadence_day FROM sales_leads WHERE id=$1`,
    [req.params.id]
  );
  if (!leadRows.length) throw new AppError('Lead nao encontrado', 404);

  const authorName = req.user?.full_name || req.user?.email || 'Staff';

  const { rows: intRows } = await pool.query(
    `INSERT INTO lead_interactions (lead_id, author_id, author_name, body, channel)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.id, req.user?.id || null, authorName, body, channel || null]
  );

  const updateFields = [];
  const updateValues = [];
  let uIdx = 1;

  if (new_status)       { updateFields.push(`status=$${uIdx++}`);            updateValues.push(new_status); }
  if (next_followup_at) { updateFields.push(`next_followup_at=$${uIdx++}`);  updateValues.push(next_followup_at); }

  if (advance_cadence && leadRows[0].cadence_name) {
    const lead = leadRows[0];
    const { rows: cadRows } = await pool.query(
      `SELECT steps FROM lead_cadences WHERE name = $1`,
      [lead.cadence_name]
    );
    if (cadRows.length) {
      const steps = Array.isArray(cadRows[0].steps) ? cadRows[0].steps : [];
      const currentIdx = steps.findIndex(s => Number(s.day) === Number(lead.cadence_day));
      const nextStep = steps[currentIdx + 1];
      if (nextStep) {
        const nextFollowup = new Date(Date.now() + (Number(nextStep.day) - Number(lead.cadence_day)) * 24 * 60 * 60 * 1000);
        updateFields.push(`cadence_day=$${uIdx++}`);   updateValues.push(Number(nextStep.day));
        updateFields.push(`next_followup_at=$${uIdx++}`); updateValues.push(nextFollowup);
      } else {
        updateFields.push(`cadence_name=NULL, cadence_day=0`);
      }
    }
  }

  let updatedLead = leadRows[0];
  if (updateFields.length) {
    updateValues.push(req.params.id);
    const { rows: ur } = await pool.query(
      `UPDATE sales_leads SET ${updateFields.join(',')} WHERE id=$${uIdx} RETURNING *`,
      updateValues
    );
    updatedLead = ur[0];
  } else {
    const { rows: ur } = await pool.query(`SELECT * FROM sales_leads WHERE id=$1`, [req.params.id]);
    updatedLead = ur[0];
  }

  res.status(201).json({ interaction: intRows[0], lead: updatedLead });
}));

// ============================================================
// GET /admin/leads/:id/interactions - timeline
// ============================================================
router.get('/:id/interactions', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM lead_interactions WHERE lead_id=$1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json({ interactions: rows });
}));

module.exports = router;
module.exports.buildLeadFilterConditions = buildLeadFilterConditions;
