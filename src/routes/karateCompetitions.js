// ============================================================
// AURA KARATÊ — Rotas de Competições + Ranking (Track E)
// Montado em /federation/:id (igual aos Tracks B/C).
//
// Competições:
//   GET   /competitions                          — lista (filtros season/status)
//   POST  /competitions                          — cria torneio (staffWrite)
//   GET   /competitions/:cid                      — detalhe + categorias + contadores
//   PATCH /competitions/:cid                      — edita (staffWrite)
//   POST  /competitions/:cid/close                — fecha (status→done) (staffWrite)
//
// Categorias:
//   GET   /competitions/:cid/categories
//   POST  /competitions/:cid/categories           — (staffWrite)
//   PATCH /competitions/:cid/categories/:catId    — (staffWrite)
//
// Inscrições / Resultados:
//   GET   /competitions/:cid/entries              — lista (filtro category_id)
//   POST  /competitions/:cid/entries              — inscreve atleta (staffWrite)
//                                                   SEMPRE 201 + category_fit (aviso)
//   PATCH /competitions/:cid/entries/:eid         — lança resultado (staffWrite)
//   GET   /competitions/:cid/ranking              — ranking do torneio (por categoria)
//
// Ranking de temporada:
//   GET   /rankings                               — acumulado da temporada (view)
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { checkCategoryFit } = require('../services/karateCompetitionService');

const MODALITIES = ['kata', 'kumite', 'kihon_ippon', 'team_kata', 'team_kumite'];

// ── GET /competitions ──
router.get('/competitions', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { status, season } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;

  try {
    const conditions = ['c.federation_id = $1'];
    const params = [federationId];
    let n = 2;
    if (status) { conditions.push(`c.status = $${n}`); params.push(status); n++; }
    if (season) { conditions.push(`c.season = $${n}`); params.push(parseInt(season, 10)); n++; }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM karate_competitions c ${where}`, params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    const dataRes = await db.query(
      `SELECT c.id, c.federation_id, c.name, c.season, c.event_date, c.location,
              c.circuit_round, c.fee_amount, c.status, c.created_at,
              COUNT(DISTINCT cat.id) AS category_count,
              COUNT(DISTINCT e.id)   AS entry_count
       FROM karate_competitions c
       LEFT JOIN karate_competition_categories cat ON cat.competition_id = c.id
       LEFT JOIN karate_competition_entries e ON e.competition_id = c.id
       ${where}
       GROUP BY c.id
       ORDER BY c.season DESC, c.event_date DESC NULLS LAST
       LIMIT $${n} OFFSET $${n + 1}`,
      [...params, pageSize, offset]
    );

    res.json({
      page, page_size: pageSize, total,
      data: dataRes.rows.map(r => ({
        id: r.id,
        federation_id: r.federation_id,
        name: r.name,
        season: r.season,
        event_date: r.event_date,
        location: r.location || null,
        circuit_round: r.circuit_round != null ? r.circuit_round : null,
        fee_amount: r.fee_amount,
        status: r.status,
        category_count: parseInt(r.category_count, 10),
        entry_count: parseInt(r.entry_count, 10),
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[karateCompetitions] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar competições' });
  }
});

// ── POST /competitions ──
router.post('/competitions', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const { name, season, event_date, location, circuit_round, fee_amount } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(422).json({ error: 'name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  const seasonVal = season ? parseInt(season, 10)
    : (event_date ? new Date(event_date).getFullYear() : new Date().getFullYear());
  if (!seasonVal || isNaN(seasonVal)) {
    return res.status(422).json({ error: 'season inválida', code: 'VALIDATION_ERROR' });
  }

  try {
    const ins = await db.query(
      `INSERT INTO karate_competitions
         (federation_id, name, season, event_date, location, circuit_round, fee_amount,
          status, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8, NOW(), NOW())
       RETURNING id, federation_id, name, season, event_date, location,
                 circuit_round, fee_amount, status, created_at`,
      [
        federationId, String(name).trim(), seasonVal,
        event_date || null, location || null,
        circuit_round != null ? parseInt(circuit_round, 10) : null,
        fee_amount != null ? parseFloat(fee_amount) : 0,
        req.user && req.user.id ? req.user.id : null,
      ]
    );
    const c = ins.rows[0];
    res.status(201).json({
      id: c.id, federation_id: c.federation_id, name: c.name, season: c.season,
      event_date: c.event_date, location: c.location || null,
      circuit_round: c.circuit_round != null ? c.circuit_round : null, fee_amount: c.fee_amount,
      status: c.status, category_count: 0, entry_count: 0, created_at: c.created_at,
    });
  } catch (err) {
    console.error('[karateCompetitions] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar competição', detail: err.message });
  }
});

// helper: garante que a competição pertence à federação
async function findCompetition(federationId, cid) {
  const r = await db.query(
    `SELECT * FROM karate_competitions WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [cid, federationId]
  );
  return r.rows[0] || null;
}

// ── GET /competitions/:cid ──
router.get('/competitions/:cid', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    const cats = await db.query(
      `SELECT cat.id, cat.name, cat.modality, cat.min_age, cat.max_age,
              cat.belt_min, cat.belt_max, cat.sex, cat.weight_class,
              cat.max_entries, cat.fee_amount,
              COUNT(e.id)::int AS entry_count
       FROM karate_competition_categories cat
       LEFT JOIN karate_competition_entries e ON e.category_id = cat.id
       WHERE cat.competition_id = $1
       GROUP BY cat.id
       ORDER BY cat.created_at ASC`,
      [cid]
    );

    // B3 — o header do admin mostrava "0 inscritos": a resposta do detalhe
    // nunca trouxe um total no nível raiz, só por categoria (categories[].
    // entry_count). category_count/entry_count agora somam as categorias
    // desta competição (mesma fonte que a lista de categorias usa), igual ao
    // que GET /competitions (lista) já calcula via JOIN direto.
    const category_count = cats.rows.length;
    const entry_count = cats.rows.reduce((sum, c) => sum + c.entry_count, 0);

    res.json({
      id: comp.id, federation_id: comp.federation_id, name: comp.name, season: comp.season,
      event_date: comp.event_date, location: comp.location || null,
      circuit_round: comp.circuit_round != null ? comp.circuit_round : null, fee_amount: comp.fee_amount,
      status: comp.status, created_at: comp.created_at, updated_at: comp.updated_at,
      category_count,
      entry_count,
      categories: cats.rows.map(c => ({
        id: c.id, name: c.name, modality: c.modality,
        min_age: c.min_age != null ? c.min_age : null, max_age: c.max_age != null ? c.max_age : null,
        belt_min: c.belt_min || null, belt_max: c.belt_max || null,
        sex: c.sex, weight_class: c.weight_class || null,
        max_entries: c.max_entries != null ? c.max_entries : null,
        fee_amount: c.fee_amount != null ? c.fee_amount : null,
        entry_count: c.entry_count,
      })),
    });
  } catch (err) {
    console.error('[karateCompetitions] detail error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar competição' });
  }
});

// ── PATCH /competitions/:cid ──
router.patch('/competitions/:cid', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const ALLOWED = ['name', 'season', 'event_date', 'location', 'circuit_round', 'fee_amount'];
  const updates = [];
  const values = [];
  let idx = 1;
  for (const field of ALLOWED) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${idx}`);
      values.push(req.body[field]);
      idx++;
    }
  }
  if (req.body.status !== undefined) {
    const VALID = ['draft', 'open', 'closed', 'cancelled'];
    if (!VALID.includes(req.body.status)) {
      return res.status(422).json({
        error: `status inválido. Use: ${VALID.join(', ')}. Para concluir use POST /close`,
        code: 'VALIDATION_ERROR',
      });
    }
    updates.push(`status = $${idx}`); values.push(req.body.status); idx++;
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }
  updates.push('updated_at = NOW()');
  values.push(cid, federationId);

  try {
    const result = await db.query(
      `UPDATE karate_competitions SET ${updates.join(', ')}
       WHERE id = $${idx} AND federation_id = $${idx + 1}
       RETURNING id, federation_id, name, season, event_date, location,
                 circuit_round, fee_amount, status, updated_at`,
      values
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[karateCompetitions] patch error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar competição' });
  }
});

// ── POST /competitions/:cid/close ──
router.post('/competitions/:cid/close', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    if (comp.status === 'done') {
      return res.status(409).json({ error: 'Competição já concluída', code: 'CONFLICT' });
    }
    if (comp.status === 'cancelled') {
      return res.status(409).json({ error: 'Competição cancelada não pode ser concluída', code: 'CONFLICT' });
    }
    const upd = await db.query(
      `UPDATE karate_competitions SET status = 'done', updated_at = NOW()
       WHERE id = $1 RETURNING id, status, updated_at`,
      [cid]
    );
    res.json({
      id: cid, status: upd.rows[0].status, updated_at: upd.rows[0].updated_at,
      _note: 'Competição concluída. Ranking de temporada reflete os pontos lançados.',
    });
  } catch (err) {
    console.error('[karateCompetitions] close error:', err.message);
    res.status(500).json({ error: 'Erro ao concluir competição' });
  }
});

// ── GET /competitions/:cid/categories ──
router.get('/competitions/:cid/categories', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const { rows } = await db.query(
      `SELECT cat.id, cat.name, cat.modality, cat.min_age, cat.max_age,
              cat.belt_min, cat.belt_max, cat.sex, cat.weight_class,
              cat.max_entries, cat.fee_amount,
              COUNT(e.id)::int AS entry_count
       FROM karate_competition_categories cat
       LEFT JOIN karate_competition_entries e ON e.category_id = cat.id
       WHERE cat.competition_id = $1
       GROUP BY cat.id
       ORDER BY cat.created_at ASC`,
      [cid]
    );
    res.json(rows);
  } catch (err) {
    console.error('[karateCompetitions] categories list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar categorias' });
  }
});

// ── POST /competitions/:cid/categories ──
router.post('/competitions/:cid/categories', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const { name, modality, min_age, max_age, belt_min, belt_max, sex, weight_class, max_entries, fee_amount } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(422).json({ error: 'name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!modality || !MODALITIES.includes(modality)) {
    return res.status(422).json({ error: `modality deve ser: ${MODALITIES.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  const sexVal = sex || 'mixed';
  if (!['M', 'F', 'mixed'].includes(sexVal)) {
    return res.status(422).json({ error: 'sex deve ser: M, F, mixed', code: 'VALIDATION_ERROR' });
  }

  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    const ins = await db.query(
      `INSERT INTO karate_competition_categories
         (competition_id, name, modality, min_age, max_age, belt_min, belt_max,
          sex, weight_class, max_entries, fee_amount, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW(), NOW())
       RETURNING id, competition_id, name, modality, min_age, max_age, belt_min,
                 belt_max, sex, weight_class, max_entries, fee_amount, created_at`,
      [
        cid, String(name).trim(), modality,
        min_age != null ? parseInt(min_age, 10) : null,
        max_age != null ? parseInt(max_age, 10) : null,
        belt_min || null, belt_max || null, sexVal,
        weight_class || null,
        max_entries != null ? parseInt(max_entries, 10) : null,
        fee_amount != null ? parseFloat(fee_amount) : null,
      ]
    );
    res.status(201).json(Object.assign({}, ins.rows[0], { entry_count: 0 }));
  } catch (err) {
    console.error('[karateCompetitions] create category error:', err.message);
    res.status(500).json({ error: 'Erro ao criar categoria', detail: err.message });
  }
});

// ── PATCH /competitions/:cid/categories/:catId ──
router.patch('/competitions/:cid/categories/:catId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, catId } = req.params;
  const ALLOWED = ['name', 'modality', 'min_age', 'max_age', 'belt_min', 'belt_max', 'sex', 'weight_class', 'max_entries', 'fee_amount'];

  if (req.body.modality !== undefined && !MODALITIES.includes(req.body.modality)) {
    return res.status(422).json({ error: `modality deve ser: ${MODALITIES.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  if (req.body.sex !== undefined && !['M', 'F', 'mixed'].includes(req.body.sex)) {
    return res.status(422).json({ error: 'sex deve ser: M, F, mixed', code: 'VALIDATION_ERROR' });
  }

  const updates = [];
  const values = [];
  let idx = 1;
  for (const field of ALLOWED) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${idx}`);
      values.push(req.body[field]);
      idx++;
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()');
  values.push(catId, cid);

  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    const result = await db.query(
      `UPDATE karate_competition_categories SET ${updates.join(', ')}
       WHERE id = $${idx} AND competition_id = $${idx + 1}
       RETURNING id, competition_id, name, modality, min_age, max_age, belt_min,
                 belt_max, sex, weight_class, max_entries, fee_amount, updated_at`,
      values
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Categoria não encontrada', code: 'NOT_FOUND' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[karateCompetitions] patch category error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar categoria' });
  }
});

// ── GET /competitions/:cid/entries ──
router.get('/competitions/:cid/entries', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const { category_id } = req.query;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    const conditions = ['e.competition_id = $1'];
    const params = [cid];
    let n = 2;
    if (category_id) { conditions.push(`e.category_id = $${n}`); params.push(category_id); n++; }

    const { rows } = await db.query(
      `SELECT e.id, e.category_id, e.student_id, e.dojo_id, e.status, e.fee_paid,
              e.placement, e.points_awarded, e.result_notes, e.created_at,
              cat.name AS category_name, cat.modality,
              cu.name AS student_name, cu.karate_registration_number,
              COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
              cb.belt_level AS current_belt, cb.belt_name AS current_belt_name
       FROM karate_competition_entries e
       JOIN karate_competition_categories cat ON cat.id = e.category_id
       JOIN customers cu ON cu.id = e.student_id
       LEFT JOIN companies dj ON dj.id = e.dojo_id
       LEFT JOIN karate_current_belt cb ON cb.student_id = e.student_id AND cb.federation_id = $${n}
       WHERE ${conditions.join(' AND ')}
       ORDER BY cat.name ASC, e.placement ASC NULLS LAST, e.created_at ASC`,
      [...params, federationId]
    );
    res.json(rows.map(r => ({
      id: r.id, category_id: r.category_id, category_name: r.category_name, modality: r.modality,
      student_id: r.student_id, student_name: r.student_name,
      karate_registration_number: r.karate_registration_number || null,
      current_belt: r.current_belt || null, current_belt_name: r.current_belt_name || null,
      dojo_id: r.dojo_id, dojo_name: r.dojo_name || null,
      status: r.status, fee_paid: r.fee_paid,
      placement: r.placement != null ? r.placement : null, points_awarded: r.points_awarded,
      result_notes: r.result_notes || null, created_at: r.created_at,
    })));
  } catch (err) {
    console.error('[karateCompetitions] entries list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar inscritos' });
  }
});

// ── POST /competitions/:cid/entries ──
// Inscreve atleta numa categoria. Compatibilidade de categoria é só AVISO
// (category_fit) — nunca bloqueia (filosofia FPKT, igual ao Track C).
router.post('/competitions/:cid/entries', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const { student_id, category_id } = req.body;

  if (!student_id) return res.status(422).json({ error: 'student_id é obrigatório', code: 'VALIDATION_ERROR' });
  if (!category_id) return res.status(422).json({ error: 'category_id é obrigatório', code: 'VALIDATION_ERROR' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const compRes = await client.query(
      `SELECT id, status, event_date FROM karate_competitions WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [cid, federationId]
    );
    if (!compRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    }
    if (['done', 'cancelled'].includes(compRes.rows[0].status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Competição ${compRes.rows[0].status} não aceita inscrições`, code: 'CONFLICT' });
    }

    const catRes = await client.query(
      `SELECT id, name, modality, min_age, max_age, belt_min, belt_max, sex, max_entries
       FROM karate_competition_categories WHERE id = $1 AND competition_id = $2 LIMIT 1`,
      [category_id, cid]
    );
    if (!catRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Categoria não encontrada nesta competição', code: 'NOT_FOUND' });
    }
    const category = catRes.rows[0];

    const stuRes = await client.query(
      `SELECT cu.id, cu.name, cu.birth_date, cu.gender, cu.dojo_id,
              cb.belt_level AS current_belt
       FROM customers cu
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $2
       WHERE cu.id = $1 AND cu.federation_id = $2 LIMIT 1`,
      [student_id, federationId]
    );
    if (!stuRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }
    const student = stuRes.rows[0];

    // advisory lock anti-dupla inscrição (mesma categoria)
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text || '-comp-entry-' || $2::text))`,
      [category_id, student_id]
    );

    const dup = await client.query(
      `SELECT id FROM karate_competition_entries WHERE category_id = $1 AND student_id = $2 LIMIT 1`,
      [category_id, student_id]
    );
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Atleta já inscrito nesta categoria', code: 'CONFLICT', entry_id: dup.rows[0].id });
    }

    const ins = await client.query(
      `INSERT INTO karate_competition_entries
         (competition_id, category_id, student_id, dojo_id, status, fee_paid, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'registered', false, NOW(), NOW())
       RETURNING id, competition_id, category_id, student_id, dojo_id, status, created_at`,
      [cid, category_id, student_id, student.dojo_id || null]
    );

    // capacidade (aviso, não bloqueia — lista de espera é decisão da federação)
    let capacity = null;
    if (category.max_entries != null) {
      const cnt = await client.query(
        `SELECT COUNT(*)::int AS filled FROM karate_competition_entries WHERE category_id = $1`,
        [category_id]
      );
      capacity = { max: category.max_entries, filled: cnt.rows[0].filled };
    }

    await client.query('COMMIT');

    // category_fit: avaliação informativa (idade/faixa/sexo)
    const fit = checkCategoryFit({
      student: { birth_date: student.birth_date, gender: student.gender, belt_level: student.current_belt },
      category,
      refDate: compRes.rows[0].event_date,
    });
    if (capacity && capacity.filled > capacity.max) {
      fit.warnings = [...(fit.warnings || []), 'Categoria acima da capacidade — atleta entra em lista de espera.'];
    }

    const e = ins.rows[0];
    res.status(201).json({
      id: e.id, competition_id: e.competition_id, category_id: e.category_id,
      student_id: e.student_id, student_name: student.name,
      dojo_id: e.dojo_id, status: e.status, created_at: e.created_at,
      capacity,
      category_fit: fit,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateCompetitions] enroll error:', err.message);
    res.status(500).json({ error: 'Erro ao inscrever atleta', detail: err.message });
  } finally {
    client.release();
  }
});

// ── PATCH /competitions/:cid/entries/:eid ──
// Lança resultado: placement, points_awarded e/ou status.
router.patch('/competitions/:cid/entries/:eid', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, eid } = req.params;
  const { placement, points_awarded, status, result_notes } = req.body;

  if (status !== undefined) {
    const VALID = ['registered', 'confirmed', 'checked_in', 'competing', 'done', 'withdrawn'];
    if (!VALID.includes(status)) {
      return res.status(422).json({ error: `status deve ser: ${VALID.join(', ')}`, code: 'VALIDATION_ERROR' });
    }
  }
  if (placement !== undefined && placement !== null && (isNaN(parseInt(placement, 10)) || parseInt(placement, 10) < 1)) {
    return res.status(422).json({ error: 'placement deve ser inteiro >= 1', code: 'VALIDATION_ERROR' });
  }

  const updates = [];
  const values = [];
  let idx = 1;
  if (placement !== undefined)      { updates.push(`placement = $${idx}`);      values.push(placement === null ? null : parseInt(placement, 10)); idx++; }
  if (points_awarded !== undefined) { updates.push(`points_awarded = $${idx}`); values.push(parseInt(points_awarded, 10) || 0); idx++; }
  if (status !== undefined)         { updates.push(`status = $${idx}`);         values.push(status); idx++; }
  if (result_notes !== undefined)   { updates.push(`result_notes = $${idx}`);   values.push(result_notes || null); idx++; }
  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()');
  values.push(eid, cid);

  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    const result = await db.query(
      `UPDATE karate_competition_entries SET ${updates.join(', ')}
       WHERE id = $${idx} AND competition_id = $${idx + 1}
       RETURNING id, competition_id, category_id, student_id, status,
                 placement, points_awarded, result_notes, updated_at`,
      values
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Inscrição não encontrada', code: 'NOT_FOUND' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[karateCompetitions] result error:', err.message);
    res.status(500).json({ error: 'Erro ao lançar resultado' });
  }
});

// ── GET /competitions/:cid/ranking ──
// Ranking do torneio: por categoria, ordenado por colocação/pontos.
router.get('/competitions/:cid/ranking', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    const { rows } = await db.query(
      `SELECT cat.id AS category_id, cat.name AS category_name, cat.modality,
              e.student_id, cu.name AS student_name,
              COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
              e.placement, e.points_awarded
       FROM karate_competition_entries e
       JOIN karate_competition_categories cat ON cat.id = e.category_id
       JOIN customers cu ON cu.id = e.student_id
       LEFT JOIN companies dj ON dj.id = e.dojo_id
       WHERE e.competition_id = $1 AND (e.placement IS NOT NULL OR e.points_awarded > 0)
       ORDER BY cat.name ASC, e.placement ASC NULLS LAST, e.points_awarded DESC`,
      [cid]
    );

    const byCat = {};
    for (const r of rows) {
      if (!byCat[r.category_id]) {
        byCat[r.category_id] = { category_id: r.category_id, category_name: r.category_name, modality: r.modality, results: [] };
      }
      byCat[r.category_id].results.push({
        student_id: r.student_id, student_name: r.student_name,
        dojo_name: r.dojo_name || null,
        placement: r.placement != null ? r.placement : null, points_awarded: r.points_awarded,
      });
    }
    res.json({ competition_id: cid, season: comp.season, categories: Object.values(byCat) });
  } catch (err) {
    console.error('[karateCompetitions] tournament ranking error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar ranking' });
  }
});

// ── GET /rankings ──
// Ranking acumulado da temporada por categoria (view karate_competition_ranking_season).
router.get('/rankings', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const season   = req.query.season ? parseInt(req.query.season, 10) : new Date().getFullYear();
  const category = req.query.category || null;
  try {
    const conditions = ['federation_id = $1', 'season = $2'];
    const params = [federationId, season];
    let n = 3;
    if (category) { conditions.push(`category = $${n}`); params.push(category); n++; }

    const { rows } = await db.query(
      `SELECT category, student_id, student_name, karate_registration_number,
              dojo_id, dojo_name, total_points, gold, silver, bronze, events_participated
       FROM karate_competition_ranking_season
       WHERE ${conditions.join(' AND ')}
       ORDER BY category ASC, total_points DESC, gold DESC, silver DESC, bronze DESC`,
      params
    );
    res.json({ season, category, ranking: rows });
  } catch (err) {
    console.error('[karateCompetitions] season ranking error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar ranking da temporada' });
  }
});

module.exports = router;
