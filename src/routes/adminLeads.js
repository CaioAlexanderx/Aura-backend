// ============================================================
// AURA. — CRM Comercial — Leads (prospects pre-venda)
// Fase 1+2: CRUD + importacao em lote + interacoes
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
// Listagem com filtros: status, city, category, followup_due
router.get('/', ...adminOnly, asyncHandler(async (req, res) => {
  const { status, city, category, followup_due, search, limit = 200, offset = 0 } = req.query;

  const conditions = [];
  const params = [];
  let idx = 1;

  if (status)       { conditions.push(`l.status = $${idx++}`);                              params.push(status); }
  if (city)         { conditions.push(`l.city ILIKE $${idx++}`);                            params.push(`%${city}%`); }
  if (category)     { conditions.push(`l.category ILIKE $${idx++}`);                        params.push(`%${category}%`); }
  if (followup_due === 'true') { conditions.push(`l.next_followup_at <= NOW()`);             }
  if (search)       { conditions.push(`(l.name ILIKE $${idx++} OR l.phone ILIKE $${idx++})`); params.push(`%${search}%`, `%${search}%`); idx++; }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT l.*,
            COUNT(i.id) AS interaction_count,
            MAX(i.created_at) AS last_interaction_at
     FROM sales_leads l
     LEFT JOIN lead_interactions i ON i.lead_id = l.id
     ${where}
     GROUP BY l.id
     ORDER BY
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

  // Totais por status para o pipeline
  const { rows: counts } = await pool.query(
    `SELECT status, COUNT(*) AS total FROM sales_leads GROUP BY status`
  );
  const pipeline = Object.fromEntries(VALID_STATUSES.map(s => [s, 0]));
  counts.forEach(r => { pipeline[r.status] = parseInt(r.total); });

  res.json({ total: rows.length, pipeline, leads: rows });
}));

// ── GET /admin/leads/meta ─────────────────────────────────────
// Cidades e categorias distintas para os filtros do FE
router.get('/meta', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: cities }     = await pool.query(`SELECT DISTINCT city FROM sales_leads WHERE city IS NOT NULL ORDER BY city`);
  const { rows: categories } = await pool.query(`SELECT DISTINCT category FROM sales_leads WHERE category IS NOT NULL ORDER BY category`);
  res.json({
    cities:     cities.map(r => r.city),
    categories: categories.map(r => r.category),
  });
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
// Criar lead individual
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
// Importacao em lote vinda do Excel gerado pelo script Python
// Body: { leads: [{ name, phone, city, category, address, website, google_rating, google_reviews }] }
router.post('/import', ...adminOnly, asyncHandler(async (req, res) => {
  const { leads } = req.body;
  if (!Array.isArray(leads) || !leads.length) throw new AppError('leads deve ser um array nao vazio', 400);
  if (leads.length > 2000) throw new AppError('Maximo 2000 leads por importacao', 400);

  let inserted = 0;
  let skipped = 0;

  // Processar em chunks de 100
  const CHUNK = 100;
  for (let i = 0; i < leads.length; i += CHUNK) {
    const chunk = leads.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((lead, j) => {
      const base = j * 8;
      values.push(
        String(lead.name || '').trim() || 'Sem nome',
        lead.phone   ? String(lead.phone).replace(/\D/g, '') : null,
        lead.city    ? String(lead.city).trim()   : null,
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
// Atualizar campos do lead (status, followup, etc)
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

  // Se status mudou para 'contacted' ou mais avancado, atualiza last_contact_at
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
// Registrar contato + opcionalmente mover status
router.post('/:id/interactions', ...adminOnly, asyncHandler(async (req, res) => {
  const { body, channel, new_status, next_followup_at } = req.body;
  if (!body) throw new AppError('body (texto) e obrigatorio', 400);
  if (channel && !VALID_CHANNELS.includes(channel))
    throw new AppError(`channel invalido. Use: ${VALID_CHANNELS.join(', ')}`, 400);
  if (new_status && !VALID_STATUSES.includes(new_status))
    throw new AppError(`status invalido. Use: ${VALID_STATUSES.join(', ')}`, 400);

  // Verificar que o lead existe
  const { rows: leadRows } = await pool.query(`SELECT id FROM sales_leads WHERE id=$1`, [req.params.id]);
  if (!leadRows.length) throw new AppError('Lead nao encontrado', 404);

  const authorName = req.user?.full_name || req.user?.email || 'Staff';

  // Inserir interacao
  const { rows: intRows } = await pool.query(
    `INSERT INTO lead_interactions (lead_id, author_id, author_name, body, channel)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.id, req.user?.id || null, authorName, body, channel || null]
  );

  // Atualizar lead: status, last_contact_at, next_followup_at
  const updateFields = ['last_contact_at=NOW()'];
  const updateValues = [];
  let uIdx = 1;

  if (new_status) { updateFields.push(`status=$${uIdx++}`); updateValues.push(new_status); }
  if (next_followup_at) { updateFields.push(`next_followup_at=$${uIdx++}`); updateValues.push(next_followup_at); }

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
