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
// Defensivo 42P01: seguro mergear antes da migração 294 (GET devolve
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

module.exports = router;
