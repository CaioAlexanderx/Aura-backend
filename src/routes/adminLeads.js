// ============================================================
// AURA. — CRM Comercial — Leads (prospects pre-venda)
// Fase 3: filtros completos + stats de conversao + export CSV
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

// ── GET /admin/leads ─────────────────────────────────────────
// Filtros: status, city, category, followup_due, has_phone,
//          min_rating, no_contact, search, limit, offset
router.get('/', ...adminOnly, asyncHandler(async (req, res) => {
  const {
    status, city, category, followup_due, has_phone,
    min_rating, no_contact, search,
    limit = 200, offset = 0,
  } = req.query;

  const conditions = [];
  const params = [];
  let idx = 1;

  if (status)                { conditions.push(`l.status = $${idx++}`);                                                      params.push(status); }
  if (city)                  { conditions.push(`l.city ILIKE $${idx++}`);                                                    params.push(`%${city}%`); }
  if (category)              { conditions.push(`l.category ILIKE $${idx++}`);                                                params.push(`%${category}%`); }
  if (followup_due === 'true') { conditions.push(`l.next_followup_at IS NOT NULL AND l.next_followup_at <= NOW()`);          }
  if (has_phone === 'true')  { conditions.push(`l.phone IS NOT NULL AND l.phone != ''`);                                     }
  if (min_rating)            { conditions.push(`l.google_rating >= $${idx++}`);                                              params.push(parseFloat(min_rating)); }
  // no_contact: status = 'new' E nenhuma interacao registrada ainda
  if (no_contact === 'true') { conditions.push(`l.status = 'new' AND NOT EXISTS (SELECT 1 FROM lead_interactions li WHERE li.lead_id = l.id)`); }
  if (search) {
    conditions.push(`(l.name ILIKE $${idx} OR l.phone ILIKE $${idx + 1} OR l.address ILIKE $${idx + 2})`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    idx += 3;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT l.*,
            COUNT(i.id)::int           AS interaction_count,
            MAX(i.created_at)          AS last_interaction_at,
            -- flag follow-up vencido para highlight no FE
            (l.next_followup_at IS NOT NULL AND l.next_followup_at <= NOW()) AS followup_overdue
     FROM sales_leads l
     LEFT JOIN lead_interactions i ON i.lead_id = l.id
     ${where}
     GROUP BY l.id
     ORDER BY
       -- prioridade: follow-up vencido primeiro
       (l.next_followup_at IS NOT NULL AND l.next_followup_at <= NOW()) DESC,
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
       l.google_rating DESC NULLS LAST,
       l.updated_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, parseInt(limit), parseInt(offset)]
  );

  // Pipeline: totais por status (sem filtros — visao geral)
  const { rows: counts } = await pool.query(
    `SELECT status, COUNT(*) AS total FROM sales_leads GROUP BY status`
  );
  const pipeline = Object.fromEntries(VALID_STATUSES.map(s => [s, 0]));
  counts.forEach(r => { pipeline[r.status] = parseInt(r.total); });

  res.json({ total: rows.length, pipeline, leads: rows });
}));

// ── GET /admin/leads/meta ─────────────────────────────────────
// Cidades, categorias e stats agregadas para os filtros do FE
router.get('/meta', ...adminOnly, asyncHandler(async (req, res) => {
  const [citiesRes, categoriesRes, statsRes] = await Promise.all([
    pool.query(`SELECT DISTINCT city, COUNT(*) as total FROM sales_leads WHERE city IS NOT NULL AND city != '' GROUP BY city ORDER BY total DESC`),
    pool.query(`SELECT DISTINCT category, COUNT(*) as total FROM sales_leads WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY total DESC`),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone != '')::int AS with_phone,
        COUNT(*) FILTER (WHERE google_rating >= 4)::int                AS high_rated,
        COUNT(*) FILTER (WHERE next_followup_at <= NOW())::int         AS followup_overdue,
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

// ── GET /admin/leads/stats ────────────────────────────────────
// Funil de conversao com taxas para o Pipeline view
router.get('/stats', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int                                                         AS total,
      COUNT(*) FILTER (WHERE status != 'new')::int                         AS contacted_total,
      COUNT(*) FILTER (WHERE status IN ('responded','interested','demo','converted'))::int AS responded_total,
      COUNT(*) FILTER (WHERE status IN ('interested','demo','converted'))::int             AS interested_total,
      COUNT(*) FILTER (WHERE status IN ('demo','converted'))::int           AS demo_total,
      COUNT(*) FILTER (WHERE status = 'converted')::int                    AS converted_total,
      COUNT(*) FILTER (WHERE status = 'lost')::int                         AS lost_total,
      COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone != '')::int        AS with_phone,
      ROUND(AVG(google_rating) FILTER (WHERE google_rating IS NOT NULL), 1) AS avg_rating,
      COUNT(*) FILTER (WHERE next_followup_at IS NOT NULL AND next_followup_at <= NOW())::int AS overdue
    FROM sales_leads
  `);

  const s = rows[0];
  const total = s.total || 1; // evitar divisao por zero

  res.json({
    ...s,
    rate_contacted:  Math.round((s.contacted_total  / total) * 100),
    rate_responded:  Math.round((s.responded_total  / (s.contacted_total  || 1)) * 100),
    rate_interested: Math.round((s.interested_total / (s.responded_total  || 1)) * 100),
    rate_demo:       Math.round((s.demo_total       / (s.interested_total || 1)) * 100),
    rate_converted:  Math.round((s.converted_total  / total) * 100),
  });
}));

// ── GET /admin/leads/export ───────────────────────────────────
// Exporta CSV do filtro atual
router.get('/export', ...adminOnly, asyncHandler(async (req, res) => {
  const { status, city, category, has_phone, min_rating, search } = req.query;

  const conditions = [];
  const params = [];
  let idx = 1;

  if (status)               { conditions.push(`status = $${idx++}`);                          params.push(status); }
  if (city)                 { conditions.push(`city ILIKE $${idx++}`);                        params.push(`%${city}%`); }
  if (category)             { conditions.push(`category ILIKE $${idx++}`);                    params.push(`%${category}%`); }
  if (has_phone === 'true') { conditions.push(`phone IS NOT NULL AND phone != ''`);            }
  if (min_rating)           { conditions.push(`google_rating >= $${idx++}`);                  params.push(parseFloat(min_rating)); }
  if (search)               { conditions.push(`(name ILIKE $${idx} OR phone ILIKE $${idx + 1})`); params.push(`%${search}%`, `%${search}%`); idx += 2; }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT name, phone, city, category, address, website,
            google_rating, google_reviews, status, source,
            last_contact_at, next_followup_at, created_at
     FROM sales_leads ${where} ORDER BY status, google_rating DESC NULLS LAST`,
    params
  );

  // Gerar CSV
  const header = ['nome','telefone','cidade','categoria','endereco','site','nota_google','num_avaliacoes','status','fonte','ultimo_contato','proximo_followup','cadastrado_em'];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    header.join(','),
    ...rows.map(r => [
      r.name, r.phone, r.city, r.category, r.address, r.website,
      r.google_rating, r.google_reviews, r.status, r.source,
      r.last_contact_at ? new Date(r.last_contact_at).toLocaleDateString('pt-BR') : '',
      r.next_followup_at ? new Date(r.next_followup_at).toLocaleDateString('pt-BR') : '',
      r.created_at ? new Date(r.created_at).toLocaleDateString('pt-BR') : '',
    ].map(escape).join(',')),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n')); // BOM para Excel abrir com acentos
}));

// ── GET /admin/leads/:id ──────────────────────────────────────
router.get('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM sales_leads WHERE id = $1`, [req.params.id]);
  if (!rows.length) throw new AppError('Lead nao encontrado', 404);

  const { rows: interactions } = await pool.query(
    `SELECT * FROM lead_interactions WHERE lead_id = $1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json({ lead: rows[0], interactions });
}));

// ── POST /admin/leads ─────────────────────────────────────────
router.post('/', ...adminOnly, asyncHandler(async (req, res) => {
  const { name, phone, city, category, address, website, google_rating, google_reviews, source = 'manual' } = req.body;
  if (!name) throw new AppError('name e obrigatorio', 400);

  const { rows } = await pool.query(
    `INSERT INTO sales_leads (name, phone, city, category, address, website, google_rating, google_reviews, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [name, phone || null, city || null, category || null, address || null, website || null,
     google_rating || null, google_reviews || null, source]
  );
  res.status(201).json({ lead: rows[0] });
}));

// ── POST /admin/leads/import ──────────────────────────────────
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

// ── PATCH /admin/leads/:id ────────────────────────────────────
router.patch('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const allowed = ['name','phone','city','category','address','website','status','lost_reason','next_followup_at','converted_company_id'];
  const fields = []; const values = []; let idx = 1;

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'status' && !VALID_STATUSES.includes(req.body[key]))
        throw new AppError(`status invalido. Use: ${VALID_STATUSES.join(', ')}`, 400);
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

// ── DELETE /admin/leads/:id ───────────────────────────────────
router.delete('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`DELETE FROM sales_leads WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!rows.length) throw new AppError('Lead nao encontrado', 404);
  res.json({ message: 'Lead removido' });
}));

// ── POST /admin/leads/:id/interactions ───────────────────────
router.post('/:id/interactions', ...adminOnly, asyncHandler(async (req, res) => {
  const { body, channel, new_status, next_followup_at } = req.body;
  if (!body) throw new AppError('body (texto) e obrigatorio', 400);
  if (channel && !VALID_CHANNELS.includes(channel))
    throw new AppError(`channel invalido. Use: ${VALID_CHANNELS.join(', ')}`, 400);
  if (new_status && !VALID_STATUSES.includes(new_status))
    throw new AppError(`status invalido. Use: ${VALID_STATUSES.join(', ')}`, 400);

  const { rows: leadRows } = await pool.query(`SELECT id FROM sales_leads WHERE id=$1`, [req.params.id]);
  if (!leadRows.length) throw new AppError('Lead nao encontrado', 404);

  const authorName = req.user?.full_name || req.user?.email || 'Staff';

  const { rows: intRows } = await pool.query(
    `INSERT INTO lead_interactions (lead_id, author_id, author_name, body, channel)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.id, req.user?.id || null, authorName, body, channel || null]
  );

  const updateFields = ['last_contact_at=NOW()'];
  const updateValues = [];
  let uIdx = 1;

  if (new_status)       { updateFields.push(`status=$${uIdx++}`);            updateValues.push(new_status); }
  if (next_followup_at) { updateFields.push(`next_followup_at=$${uIdx++}`);  updateValues.push(next_followup_at); }

  updateValues.push(req.params.id);
  const { rows: updatedLead } = await pool.query(
    `UPDATE sales_leads SET ${updateFields.join(',')} WHERE id=$${uIdx} RETURNING *`,
    updateValues
  );

  res.status(201).json({ interaction: intRows[0], lead: updatedLead[0] });
}));

// ── GET /admin/leads/:id/interactions ────────────────────────
router.get('/:id/interactions', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM lead_interactions WHERE lead_id=$1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json({ interactions: rows });
}));

module.exports = router;
