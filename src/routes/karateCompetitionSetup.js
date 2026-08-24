// ============================================================
// AURA KARATÊ — P0 Hub de Campeonatos: SETUP da competição (federação)
// Montado em /federation/:id (guards de karateRoles).
//
// Divisões (migration 294 — "Principal" / "Aspirantes" no mesmo evento):
//   GET    /competitions/:cid/divisions               (read)
//   POST   /competitions/:cid/divisions               (staffWrite)
//   PATCH  /competitions/:cid/divisions/:divId        (staffWrite)
//   DELETE /competitions/:cid/divisions/:divId        (staffWrite)
//          — só sem categorias vinculadas (409 DIVISION_IN_USE)
//
// Precificação e ciclo operacional:
//   PATCH  /competitions/:cid/pricing                 (staffWrite)
//          — pricing_config (validado) + rectification_deadline
//
// Delegações recebidas (fundação da fila de conferência — a confirmação
// entra no PR seguinte):
//   GET    /competitions/:cid/delegations             (read)
//
// Kotos e ordem do dia (migration 297 — P1):
//   GET/POST     /competitions/:cid/areas                    (read/staffWrite)
//   PATCH/DELETE /competitions/:cid/areas/:areaId            (staffWrite)
//   PATCH        /competitions/:cid/categories/:catId/area   (staffWrite)
//   GET          /competitions/:cid/schedule-board           (read)
//
// Defensivo 42P01: seguro mergear antes das migrações 294/297 (GET devolve
// vazio; escrita devolve 503 SCHEMA_PENDING).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

async function findCompetition(federationId, cid) {
  const r = await db.query(
    `SELECT id, status FROM karate_competitions WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [cid, federationId]
  );
  return r.rows[0] || null;
}

// Valida o shape do pricing_config (ver migration 294 / pricing service).
// Retorna { ok } ou { ok:false, error }.
function validatePricingConfig(cfg) {
  if (cfg == null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: 'pricing_config deve ser um objeto' };
  }
  if (cfg.individual !== undefined) {
    const ind = cfg.individual;
    if (!ind || typeof ind !== 'object') return { ok: false, error: 'individual deve ser objeto' };
    if (ind.mode !== undefined && !['per_athlete', 'per_entry'].includes(ind.mode)) {
      return { ok: false, error: "individual.mode deve ser 'per_athlete' ou 'per_entry'" };
    }
    if (!Array.isArray(ind.bands) || !ind.bands.length) {
      return { ok: false, error: 'individual.bands deve ser um array não-vazio' };
    }
    for (let i = 0; i < ind.bands.length; i++) {
      const b = ind.bands[i];
      if (!b || typeof b !== 'object') return { ok: false, error: `bands[${i}] deve ser objeto` };
      const amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: `bands[${i}].amount inválido` };
      if (b.max_age !== undefined && b.max_age !== null) {
        const ma = Number(b.max_age);
        if (!Number.isInteger(ma) || ma < 0) return { ok: false, error: `bands[${i}].max_age inválido` };
      }
    }
  }
  if (cfg.team !== undefined) {
    const t = cfg.team;
    if (!t || typeof t !== 'object') return { ok: false, error: 'team deve ser objeto' };
    for (const k of ['per_prova', 'bundle_both']) {
      if (t[k] !== undefined && t[k] !== null) {
        const v = Number(t[k]);
        if (!Number.isFinite(v) || v < 0) return { ok: false, error: `team.${k} inválido` };
      }
    }
  }
  if (cfg.exemptions !== undefined) {
    const e = cfg.exemptions;
    if (!e || typeof e !== 'object') return { ok: false, error: 'exemptions deve ser objeto' };
    for (const k of ['officials_per_exemption', 'max_exemptions']) {
      if (e[k] !== undefined && e[k] !== null) {
        const v = Number(e[k]);
        if (!Number.isInteger(v) || v < 0) return { ok: false, error: `exemptions.${k} inválido` };
      }
    }
  }
  return { ok: true };
}

// Valida rules da divisão (cotas por clube).
function validateDivisionRules(rules) {
  if (rules == null) return { ok: true };
  if (typeof rules !== 'object' || Array.isArray(rules)) {
    return { ok: false, error: 'rules deve ser um objeto' };
  }
  for (const k of ['max_individual_per_dojo_per_category', 'max_teams_per_dojo_per_category']) {
    if (rules[k] !== undefined && rules[k] !== null) {
      const v = Number(rules[k]);
      if (!Number.isInteger(v) || v < 0) return { ok: false, error: `rules.${k} inválido` };
    }
  }
  return { ok: true };
}

// ── GET /competitions/:cid/divisions ────────────────────────
router.get('/competitions/:cid/divisions', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const { rows } = await db.query(
      `SELECT d.id, d.name, d.sort_order, d.rules,
              COUNT(cat.id)::int AS category_count
         FROM karate_competition_divisions d
         LEFT JOIN karate_competition_categories cat ON cat.division_id = d.id
        WHERE d.competition_id = $1
        GROUP BY d.id
        ORDER BY d.sort_order ASC, d.name ASC`,
      [cid]
    );
    return res.json(rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    console.error('[karateCompetitionSetup] divisions list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar divisões' });
  }
});

// ── POST /competitions/:cid/divisions ───────────────────────
router.post('/competitions/:cid/divisions', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const name = req.body && req.body.name != null ? String(req.body.name).trim() : '';
  const sortOrder = parseInt(req.body && req.body.sort_order, 10) || 0;
  const rules = (req.body && req.body.rules) || {};

  if (!name) return res.status(422).json({ error: 'name é obrigatório', code: 'VALIDATION_ERROR' });
  const rv = validateDivisionRules(rules);
  if (!rv.ok) return res.status(422).json({ error: rv.error, code: 'VALIDATION_ERROR' });

  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const ins = await db.query(
      `INSERT INTO karate_competition_divisions (competition_id, name, sort_order, rules)
       VALUES ($1,$2,$3,$4::jsonb)
       RETURNING id, name, sort_order, rules, created_at`,
      [cid, name, sortOrder, JSON.stringify(rules)]
    );
    return res.status(201).json(Object.assign({}, ins.rows[0], { category_count: 0 }));
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(503).json({ error: 'Divisões indisponíveis (migração 294 pendente)', code: 'SCHEMA_PENDING' });
    }
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Já existe divisão com este nome nesta competição', code: 'CONFLICT' });
    }
    console.error('[karateCompetitionSetup] division create error:', e.message);
    return res.status(500).json({ error: 'Erro ao criar divisão' });
  }
});

// ── PATCH /competitions/:cid/divisions/:divId ───────────────
router.patch('/competitions/:cid/divisions/:divId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, divId } = req.params;
  const sets = [];
  const vals = [];
  let i = 1;

  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(422).json({ error: 'name não pode ser vazio', code: 'VALIDATION_ERROR' });
    sets.push(`name = $${i++}`); vals.push(name);
  }
  if (req.body.sort_order !== undefined) {
    sets.push(`sort_order = $${i++}`); vals.push(parseInt(req.body.sort_order, 10) || 0);
  }
  if (req.body.rules !== undefined) {
    const rv = validateDivisionRules(req.body.rules);
    if (!rv.ok) return res.status(422).json({ error: rv.error, code: 'VALIDATION_ERROR' });
    sets.push(`rules = $${i++}::jsonb`); vals.push(JSON.stringify(req.body.rules || {}));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    vals.push(divId, cid);
    const upd = await db.query(
      `UPDATE karate_competition_divisions SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} AND competition_id = $${i + 1}
      RETURNING id, name, sort_order, rules, updated_at`,
      vals
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Divisão não encontrada', code: 'NOT_FOUND' });
    return res.json(upd.rows[0]);
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(503).json({ error: 'Divisões indisponíveis (migração 294 pendente)', code: 'SCHEMA_PENDING' });
    }
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Já existe divisão com este nome nesta competição', code: 'CONFLICT' });
    }
    console.error('[karateCompetitionSetup] division patch error:', e.message);
    return res.status(500).json({ error: 'Erro ao atualizar divisão' });
  }
});

// ── DELETE /competitions/:cid/divisions/:divId ──────────────
// Só divisão SEM categorias vinculadas (senão a grade perderia o vínculo
// silenciosamente — mova as categorias antes).
router.delete('/competitions/:cid/divisions/:divId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, divId } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const inUse = await db.query(
      `SELECT COUNT(*)::int AS n FROM karate_competition_categories WHERE division_id = $1`,
      [divId]
    );
    if (inUse.rows[0].n > 0) {
      return res.status(409).json({
        error: `Divisão tem ${inUse.rows[0].n} categoria(s) vinculada(s). Mova-as antes de excluir.`,
        code: 'DIVISION_IN_USE',
      });
    }
    const del = await db.query(
      `DELETE FROM karate_competition_divisions WHERE id = $1 AND competition_id = $2 RETURNING id`,
      [divId, cid]
    );
    if (!del.rows.length) return res.status(404).json({ error: 'Divisão não encontrada', code: 'NOT_FOUND' });
    return res.json({ deleted: true, id: divId });
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(503).json({ error: 'Divisões indisponíveis (migração 294 pendente)', code: 'SCHEMA_PENDING' });
    }
    console.error('[karateCompetitionSetup] division delete error:', e.message);
    return res.status(500).json({ error: 'Erro ao excluir divisão' });
  }
});

// ── PATCH /competitions/:cid/pricing ────────────────────────
// Body: { pricing_config?, rectification_deadline? ('YYYY-MM-DD'|null) }
router.patch('/competitions/:cid/pricing', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const sets = [];
  const vals = [];
  let i = 1;

  if (req.body.pricing_config !== undefined) {
    const v = validatePricingConfig(req.body.pricing_config);
    if (!v.ok) return res.status(422).json({ error: v.error, code: 'VALIDATION_ERROR' });
    sets.push(`pricing_config = $${i++}::jsonb`);
    vals.push(JSON.stringify(req.body.pricing_config || {}));
  }
  if (req.body.rectification_deadline !== undefined) {
    const raw = req.body.rectification_deadline;
    if (raw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
      return res.status(422).json({ error: 'rectification_deadline deve ser YYYY-MM-DD ou null', code: 'VALIDATION_ERROR' });
    }
    sets.push(`rectification_deadline = $${i++}::date`);
    vals.push(raw);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  try {
    vals.push(cid, federationId);
    const upd = await db.query(
      `UPDATE karate_competitions SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} AND federation_id = $${i + 1}
      RETURNING id, pricing_config, rectification_deadline, updated_at`,
      vals
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    return res.json(upd.rows[0]);
  } catch (e) {
    if (e.code === '42703') {
      return res.status(503).json({ error: 'Precificação indisponível (migração 294 pendente)', code: 'SCHEMA_PENDING' });
    }
    console.error('[karateCompetitionSetup] pricing patch error:', e.message);
    return res.status(500).json({ error: 'Erro ao atualizar precificação' });
  }
});

// ── GET /competitions/:cid/delegations — pedidos recebidos ──
// Fundação da fila de conferência (a confirmação entra no PR seguinte).
router.get('/competitions/:cid/delegations', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const status = req.query.status ? String(req.query.status) : null;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const conds = ['o.federation_id = $1', 'o.competition_id = $2'];
    const params = [federationId, cid];
    if (status) { conds.push(`o.status = $3`); params.push(status); }
    const { rows } = await db.query(
      `SELECT o.id, o.dojo_id, COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
              o.status, o.payment_mode, o.total_amount, o.officials_count,
              o.receipt_url, o.created_at, o.confirmed_at,
              COUNT(e.id)::int AS entry_count
         FROM karate_delegation_orders o
         LEFT JOIN companies dj ON dj.id = o.dojo_id
         LEFT JOIN karate_competition_entries e ON e.delegation_order_id = o.id
        WHERE ${conds.join(' AND ')}
        GROUP BY o.id, dj.trade_name, dj.legal_name
        ORDER BY o.created_at DESC`,
      params
    );
    return res.json(rows.map((r) => ({ ...r, total_amount: Number(r.total_amount) })));
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    console.error('[karateCompetitionSetup] delegations list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar delegações' });
  }
});

// ════════════════════════════════════════════════════════════
// FILA DE CONFERÊNCIA (federação) + PUBLICAÇÕES do ciclo
// ════════════════════════════════════════════════════════════
const delegationSvc = require('../services/karateDelegationService');

function mapServiceError(res, e, ctx) {
  if (e && e.isServiceError) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    return res.status(e.status).json(body);
  }
  console.error(`[karateCompetitionSetup] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
}

// ── GET /competitions/:cid/delegations/:orderId — detalhe ───
router.get('/competitions/:cid/delegations/:orderId', ...guards.read(), async (req, res) => {
  const { id: federationId, cid, orderId } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const order = await delegationSvc.getOrderForFederation(federationId, cid, orderId);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado', code: 'NOT_FOUND' });
    return res.json({ order });
  } catch (e) {
    return mapServiceError(res, e, 'GET delegations/:orderId');
  }
});

// ── POST /competitions/:cid/delegations/:orderId/confirm ────
// A conferência do comprovante: um clique → pedido 'paid' + cascata
// fee_paid em todas as inscrições do pedido. (Com Aura Pay, este clique
// não existe — o webhook faz o mesmo caminho.)
router.post('/competitions/:cid/delegations/:orderId/confirm', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, orderId } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const out = await delegationSvc.confirmOrder({
      federationId,
      competitionId: cid,
      orderId,
      actorId: (req.user && req.user.id) || null,
      actorName: (req.user && (req.user.name || req.user.email)) || null,
    });
    return res.json(out);
  } catch (e) {
    return mapServiceError(res, e, 'POST delegations/:orderId/confirm');
  }
});

// ── POST /competitions/:cid/delegations/:orderId/reject ─────
// Body: { reason? }. Pedido 'cancelled' + inscrições/equipes 'withdrawn'
// (rastro preservado — nada é apagado). Pedido já pago não é recusável.
router.post('/competitions/:cid/delegations/:orderId/reject', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, orderId } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const out = await delegationSvc.rejectOrder({
      federationId,
      competitionId: cid,
      orderId,
      reason: req.body && req.body.reason,
    });
    return res.json(out);
  } catch (e) {
    return mapServiceError(res, e, 'POST delegations/:orderId/reject');
  }
});

// ── Publicações do ciclo operacional ────────────────────────
// POST /competitions/:cid/publish-conference  { published: true|false }
// POST /competitions/:cid/publish-brackets    { published: true|false }
// Publicar liga a página pública correspondente (conferência de inscrições
// / chaves); despublicar (published:false) esconde de novo — o ciclo real
// tem retificação, então voltar atrás é operação normal, não exceção.
function makePublishRoute(column, label) {
  return async (req, res) => {
    const { id: federationId, cid } = req.params;
    const published = !(req.body && req.body.published === false);
    try {
      const upd = await db.query(
        `UPDATE karate_competitions
            SET ${column} = ${published ? 'NOW()' : 'NULL'}, updated_at = NOW()
          WHERE id = $1 AND federation_id = $2
        RETURNING id, ${column}`,
        [cid, federationId]
      );
      if (!upd.rows.length) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
      return res.json({ id: cid, [column]: upd.rows[0][column] });
    } catch (e) {
      if (e.code === '42703') {
        return res.status(503).json({ error: `${label} indisponível (migração 294 pendente)`, code: 'SCHEMA_PENDING' });
      }
      console.error(`[karateCompetitionSetup] ${label} error:`, e.message);
      return res.status(500).json({ error: `Erro ao publicar ${label}` });
    }
  };
}
router.post('/competitions/:cid/publish-conference', ...guards.staffWrite(),
  makePublishRoute('conference_published_at', 'conferência de inscrições'));
router.post('/competitions/:cid/publish-brackets', ...guards.staffWrite(),
  makePublishRoute('brackets_published_at', 'publicação de chaves'));

// ════════════════════════════════════════════════════════════
// KOTOS (áreas de competição) + ORDEM DO DIA — P1, migration 297
// A digitalização da planilha "DISTRIBUIÇÃO DE KOTOS": áreas do evento,
// categorias alocadas por área numa ordem, e a estimativa de carga
// ("(~3,5h) 58 atletas") recalculada ao vivo pelo karateScheduleService.
// ════════════════════════════════════════════════════════════
const scheduleSvc = require('../services/karateScheduleService');

// ── GET /competitions/:cid/areas ────────────────────────────
router.get('/competitions/:cid/areas', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const { rows } = await db.query(
      `SELECT a.id, a.name, a.sort_order, a.notes,
              COUNT(cat.id)::int AS category_count
         FROM karate_competition_areas a
         LEFT JOIN karate_competition_categories cat ON cat.area_id = a.id
        WHERE a.competition_id = $1
        GROUP BY a.id
        ORDER BY a.sort_order ASC, a.name ASC`,
      [cid]
    );
    return res.json(rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    console.error('[karateCompetitionSetup] areas list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar áreas' });
  }
});

// ── POST /competitions/:cid/areas ───────────────────────────
router.post('/competitions/:cid/areas', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const name = req.body && req.body.name != null ? String(req.body.name).trim() : '';
  const sortOrder = parseInt(req.body && req.body.sort_order, 10) || 0;
  const notes = req.body && req.body.notes != null ? String(req.body.notes).trim().slice(0, 500) || null : null;
  if (!name) return res.status(422).json({ error: 'name é obrigatório', code: 'VALIDATION_ERROR' });

  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const ins = await db.query(
      `INSERT INTO karate_competition_areas (competition_id, name, sort_order, notes)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, sort_order, notes, created_at`,
      [cid, name, sortOrder, notes]
    );
    return res.status(201).json(Object.assign({}, ins.rows[0], { category_count: 0 }));
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(503).json({ error: 'Áreas indisponíveis (migração 297 pendente)', code: 'SCHEMA_PENDING' });
    }
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Já existe área com este nome nesta competição', code: 'CONFLICT' });
    }
    console.error('[karateCompetitionSetup] area create error:', e.message);
    return res.status(500).json({ error: 'Erro ao criar área' });
  }
});

// ── PATCH /competitions/:cid/areas/:areaId ──────────────────
router.patch('/competitions/:cid/areas/:areaId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, areaId } = req.params;
  const sets = [];
  const vals = [];
  let i = 1;
  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(422).json({ error: 'name não pode ser vazio', code: 'VALIDATION_ERROR' });
    sets.push(`name = $${i++}`); vals.push(name);
  }
  if (req.body.sort_order !== undefined) {
    sets.push(`sort_order = $${i++}`); vals.push(parseInt(req.body.sort_order, 10) || 0);
  }
  if (req.body.notes !== undefined) {
    sets.push(`notes = $${i++}`);
    vals.push(req.body.notes != null ? String(req.body.notes).trim().slice(0, 500) || null : null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    vals.push(areaId, cid);
    const upd = await db.query(
      `UPDATE karate_competition_areas SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} AND competition_id = $${i + 1}
      RETURNING id, name, sort_order, notes, updated_at`,
      vals
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Área não encontrada', code: 'NOT_FOUND' });
    return res.json(upd.rows[0]);
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(503).json({ error: 'Áreas indisponíveis (migração 297 pendente)', code: 'SCHEMA_PENDING' });
    }
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Já existe área com este nome nesta competição', code: 'CONFLICT' });
    }
    console.error('[karateCompetitionSetup] area patch error:', e.message);
    return res.status(500).json({ error: 'Erro ao atualizar área' });
  }
});

// ── DELETE /competitions/:cid/areas/:areaId ─────────────────
// FK das categorias é ON DELETE SET NULL — as categorias do koto excluído
// voltam para "não alocadas" (nunca somem do evento).
router.delete('/competitions/:cid/areas/:areaId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, areaId } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const del = await db.query(
      `DELETE FROM karate_competition_areas WHERE id = $1 AND competition_id = $2 RETURNING id`,
      [areaId, cid]
    );
    if (!del.rows.length) return res.status(404).json({ error: 'Área não encontrada', code: 'NOT_FOUND' });
    return res.json({ deleted: true, id: areaId });
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(503).json({ error: 'Áreas indisponíveis (migração 297 pendente)', code: 'SCHEMA_PENDING' });
    }
    console.error('[karateCompetitionSetup] area delete error:', e.message);
    return res.status(500).json({ error: 'Erro ao excluir área' });
  }
});

// ── PATCH /competitions/:cid/categories/:catId/area ─────────
// A operação do drag-n-drop: move a categoria para um koto (ou tira,
// area_id=null) numa posição da ordem do dia.
router.patch('/competitions/:cid/categories/:catId/area', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, catId } = req.params;
  const areaId = req.body && req.body.area_id !== undefined ? req.body.area_id : undefined;
  const areaOrder = req.body && req.body.area_order !== undefined
    ? (req.body.area_order === null ? null : parseInt(req.body.area_order, 10))
    : undefined;
  if (areaId === undefined && areaOrder === undefined) {
    return res.status(400).json({ error: 'Informe area_id e/ou area_order' });
  }
  if (areaOrder !== undefined && areaOrder !== null && (!Number.isInteger(areaOrder) || areaOrder < 0)) {
    return res.status(422).json({ error: 'area_order deve ser inteiro >= 0 ou null', code: 'VALIDATION_ERROR' });
  }

  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    if (areaId != null) {
      const a = await db.query(
        `SELECT id FROM karate_competition_areas WHERE id = $1 AND competition_id = $2 LIMIT 1`,
        [areaId, cid]
      );
      if (!a.rows.length) {
        return res.status(404).json({ error: 'Área não encontrada nesta competição', code: 'NOT_FOUND' });
      }
    }

    const sets = [];
    const vals = [];
    let i = 1;
    if (areaId !== undefined) { sets.push(`area_id = $${i++}`); vals.push(areaId); }
    if (areaOrder !== undefined) { sets.push(`area_order = $${i++}`); vals.push(areaOrder); }
    vals.push(catId, cid);
    const upd = await db.query(
      `UPDATE karate_competition_categories SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} AND competition_id = $${i + 1}
      RETURNING id, area_id, area_order`,
      vals
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Categoria não encontrada', code: 'NOT_FOUND' });
    return res.json(upd.rows[0]);
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') {
      return res.status(503).json({ error: 'Alocação de kotos indisponível (migração 297 pendente)', code: 'SCHEMA_PENDING' });
    }
    console.error('[karateCompetitionSetup] category area patch error:', e.message);
    return res.status(500).json({ error: 'Erro ao alocar categoria' });
  }
});

// ── GET /competitions/:cid/schedule-board ───────────────────
// O board do dia: áreas com suas categorias (na ordem) + estimativa de
// carga por área ("~3,5h · 58 atletas") + categorias não alocadas.
router.get('/competitions/:cid/schedule-board', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    let areas = [];
    try {
      const a = await db.query(
        `SELECT id, name, sort_order, notes FROM karate_competition_areas
          WHERE competition_id = $1 ORDER BY sort_order ASC, name ASC`,
        [cid]
      );
      areas = a.rows;
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }

    // Categorias com contagem de inscritos ativos + kata_mode (para a
    // heurística distinguir kata por notas de kata em chave). 42703 →
    // forma sem area_id (297 pendente): tudo vira "não alocada".
    const catSql = (withArea) => `
      SELECT cat.id, cat.name, cat.modality, cat.group_label, cat.division_id,
             ${withArea ? 'cat.area_id, cat.area_order,' : 'NULL AS area_id, NULL AS area_order,'}
             d.name AS division_name,
             b.kata_mode,
             COUNT(e.id) FILTER (WHERE e.status NOT IN ('withdrawn'))::int AS entry_count
        FROM karate_competition_categories cat
        LEFT JOIN karate_competition_divisions d ON d.id = cat.division_id
        LEFT JOIN karate_brackets b ON b.category_id = cat.id
        LEFT JOIN karate_competition_entries e ON e.category_id = cat.id
       WHERE cat.competition_id = $1
       GROUP BY cat.id, d.name, b.kata_mode
       ORDER BY ${withArea ? 'cat.area_order ASC NULLS LAST,' : ''} cat.created_at ASC`;
    let cats;
    try {
      ({ rows: cats } = await db.query(catSql(true), [cid]));
    } catch (e) {
      if (e.code !== '42703') throw e;
      ({ rows: cats } = await db.query(catSql(false), [cid]));
    }

    const catView = (c) => ({
      id: c.id,
      name: c.name,
      modality: c.modality,
      group_label: c.group_label || null,
      division_name: c.division_name || null,
      area_order: c.area_order != null ? c.area_order : null,
      entry_count: c.entry_count,
      est_minutes: scheduleSvc.estimateCategoryMinutes({
        modality: c.modality, entry_count: c.entry_count, kata_mode: c.kata_mode,
      }),
    });

    // ── P2b: CONFLITO DE ATLETA ENTRE KOTOS ────────────────────
    // A dor real do dia: o mesmo atleta com provas alocadas em kotos
    // DIFERENTES pode ser chamado em duas áreas ao mesmo tempo. Aviso
    // para a mesa central sequenciar — NUNCA bloqueio (filosofia FPKT).
    // 42703/42P01 (297 pendente) → sem conflitos, board segue.
    let conflicts = [];
    try {
      const { rows: confRows } = await db.query(
        `-- p2b:koto-conflicts
         SELECT e.student_id, cu.name AS student_name,
                cat.id AS category_id, cat.name AS category_name,
                cat.area_id, a.name AS area_name
           FROM karate_competition_entries e
           JOIN karate_competition_categories cat ON cat.id = e.category_id
           LEFT JOIN customers cu ON cu.id = e.student_id
           LEFT JOIN karate_competition_areas a ON a.id = cat.area_id
          WHERE cat.competition_id = $1
            AND e.student_id IS NOT NULL
            AND e.status NOT IN ('withdrawn')
            AND cat.area_id IS NOT NULL`,
        [cid]
      );
      const byStudent = new Map();
      for (const r of confRows) {
        if (!byStudent.has(r.student_id)) {
          byStudent.set(r.student_id, { name: r.student_name, areas: new Set(), cats: [] });
        }
        const s = byStudent.get(r.student_id);
        s.areas.add(r.area_id);
        s.cats.push({ id: r.category_id, name: r.category_name, area_name: r.area_name || null });
      }
      conflicts = [...byStudent.entries()]
        .filter(([, s]) => s.areas.size >= 2)
        .map(([studentId, s]) => ({
          student_id: studentId,
          student_name: s.name || null,
          area_count: s.areas.size,
          categories: s.cats,
        }));
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }

    const board = areas.map((a) => {
      const own = cats.filter((c) => c.area_id === a.id);
      const summary = scheduleSvc.summarizeArea(own);
      return {
        id: a.id,
        name: a.name,
        sort_order: a.sort_order,
        notes: a.notes || null,
        entry_count: summary.entry_count,
        est_minutes: summary.est_minutes,
        est_label: summary.est_label,
        categories: own.map(catView),
      };
    });
    const unassigned = cats.filter((c) => !c.area_id).map(catView);

    return res.json({
      competition_id: cid,
      areas: board,
      unassigned,
      conflicts,
      totals: {
        categories: cats.length,
        assigned: cats.length - unassigned.length,
        entry_count: cats.reduce((s, c) => s + c.entry_count, 0),
        conflict_count: conflicts.length,
      },
    });
  } catch (e) {
    console.error('[karateCompetitionSetup] schedule-board error:', e.message);
    return res.status(500).json({ error: 'Erro ao montar o board do dia' });
  }
});

// ═════════════════════════════════════════════════════════════════
// P2 (modo mesário) — FILA DE PREMIAÇÃO AO VIVO
//
// O correio de papel do dia real (mesa do koto → mesa central → mesa de
// premiação) vira uma fila: quando o mesário finaliza a chave (POST
// .../bracket/finalize), a categoria aparece aqui COM o pódio pronto; a
// mesa de premiação marca "medalhas entregues" e ela sai da fila.
// ═════════════════════════════════════════════════════════════════

// GET /competitions/:cid/awards — categorias com pódio computado + status
// de entrega, ordenadas: pendentes primeiro, na ordem do board (koto/ordem).
router.get('/competitions/:cid/awards', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    let rows;
    try {
      ({ rows } = await db.query(
        `SELECT cat.id AS category_id, cat.name AS category_name, cat.modality,
                cat.group_label, cat.awards_delivered_at,
                d.name AS division_name,
                a.name AS area_name, a.sort_order AS area_sort, cat.area_order,
                e.id AS entry_id, e.placement, e.points_awarded,
                COALESCE(cu.name, t.name) AS athlete_name,
                COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
           FROM karate_competition_categories cat
           LEFT JOIN karate_competition_divisions d ON d.id = cat.division_id
           LEFT JOIN karate_competition_areas a ON a.id = cat.area_id
           JOIN karate_competition_entries e
             ON e.category_id = cat.id AND e.placement IS NOT NULL
           LEFT JOIN customers cu ON cu.id = e.student_id
           LEFT JOIN karate_competition_teams t ON t.id = e.team_id
           LEFT JOIN companies dj ON dj.id = e.dojo_id
          WHERE cat.competition_id = $1
          ORDER BY (cat.awards_delivered_at IS NOT NULL) ASC,
                   a.sort_order ASC NULLS LAST, cat.area_order ASC NULLS LAST,
                   cat.name ASC, e.placement ASC`,
        [cid]
      ));
    } catch (e) {
      // 42703: migration 301 (awards_delivered_at) ou 294 (team/divisões)
      // pendente — fila indisponível, nunca 500.
      if (e.code === '42703' || e.code === '42P01') {
        return res.json({ data: [], count: 0, schema_pending: true });
      }
      throw e;
    }

    // Agrupa por categoria (pódio ordenado por placement).
    const byCat = new Map();
    for (const r of rows) {
      if (!byCat.has(r.category_id)) {
        byCat.set(r.category_id, {
          category_id: r.category_id,
          category_name: r.category_name,
          modality: r.modality,
          group_label: r.group_label || null,
          division_name: r.division_name || null,
          area_name: r.area_name || null,
          awards_delivered: !!r.awards_delivered_at,
          awards_delivered_at: r.awards_delivered_at || null,
          podium: [],
        });
      }
      byCat.get(r.category_id).podium.push({
        placement: r.placement,
        entry_id: r.entry_id,
        name: r.athlete_name || null,
        dojo: r.dojo_name || null,
        points_awarded: r.points_awarded != null ? Number(r.points_awarded) : 0,
      });
    }
    const data = Array.from(byCat.values());
    return res.json({ data, count: data.length, pending: data.filter((c) => !c.awards_delivered).length });
  } catch (err) {
    console.error('[karateCompetitionSetup] awards queue error:', err.message);
    return res.status(500).json({ error: 'Erro ao montar a fila de premiação' });
  }
});

// POST /competitions/:cid/categories/:catId/awards-delivered
// Body: { delivered: true|false } (default true). Marca/desmarca a entrega.
router.post('/competitions/:cid/categories/:catId/awards-delivered', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, catId } = req.params;
  const delivered = req.body && req.body.delivered === false ? false : true;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    let rows;
    try {
      ({ rows } = await db.query(
        `UPDATE karate_competition_categories
            SET awards_delivered_at = ${delivered ? 'NOW()' : 'NULL'}, updated_at = NOW()
          WHERE id = $1 AND competition_id = $2
          RETURNING id, awards_delivered_at`,
        [catId, cid]
      ));
    } catch (e) {
      if (e.code === '42703') {
        return res.status(503).json({ error: 'Fila de premiação ainda não disponível (migration 301 pendente)', code: 'SCHEMA_PENDING' });
      }
      throw e;
    }
    if (!rows.length) return res.status(404).json({ error: 'Categoria não encontrada', code: 'NOT_FOUND' });
    return res.json({ category_id: rows[0].id, awards_delivered: !!rows[0].awards_delivered_at, awards_delivered_at: rows[0].awards_delivered_at || null });
  } catch (err) {
    console.error('[karateCompetitionSetup] awards-delivered error:', err.message);
    return res.status(500).json({ error: 'Erro ao marcar a entrega da premiação' });
  }
});

module.exports = router;
