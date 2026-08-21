// ============================================================
// AURA KARATÊ — P1 Hub: ARBITRAGEM e TERMO DE RESPONSABILIDADE
// Montado em /federation/:id (guards de karateRoles). Migration 298.
//
// Arbitragem (o que a "DISTRIBUIÇÃO DE ÁRBITROS & MESÁRIOS" faz em papel):
//   GET    /officials                                  (read)   cadastro da federação
//   POST   /officials                                  (staffWrite)
//   PATCH  /officials/:officialId                      (staffWrite)
//   DELETE /officials/:officialId                      (staffWrite) — desativa (soft)
//   GET    /competitions/:cid/officials                (read)   escala do evento
//   POST   /competitions/:cid/officials                (staffWrite) convoca (lote)
//   PATCH  /competitions/:cid/officials/:rowId         (staffWrite) confirma/escala/presença/multa
//   DELETE /competitions/:cid/officials/:rowId         (staffWrite) remove da convocação
//
// Termo de responsabilidade (Dossiê Shiai §2 — "sem termo, não participa"):
//   PATCH  /competitions/:cid/waiver-terms             (staffWrite) texto do termo
//   GET    /competitions/:cid/waivers                  (read)   status por atleta
//   POST   /competitions/:cid/waivers                  (staffWrite) registra aceite
//
// Defensivo 42P01/42703: seguro mergear antes da 298 (GET vazio; escrita
// 503 SCHEMA_PENDING).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

const ROLES = ['arbitro', 'mesario', 'staff'];
const CREDENTIALS = ['A', 'B', 'C', 'D'];
const OFFICIAL_STATUSES = ['summoned', 'confirmed', 'declined', 'present', 'absent'];

async function findCompetition(federationId, cid) {
  const r = await db.query(
    `SELECT id, status FROM karate_competitions WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [cid, federationId]
  );
  return r.rows[0] || null;
}

function schemaPending(res, what) {
  return res.status(503).json({
    error: `${what} indisponível (migração 298 pendente)`,
    code: 'SCHEMA_PENDING',
  });
}

const trimOrNull = (v, max = 200) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
};

// ════════════════════════════════════════════════════════════
// CADASTRO DE OFICIAIS (federação)
// ════════════════════════════════════════════════════════════

// ── GET /officials?role=&active= ────────────────────────────
router.get('/officials', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const role = ROLES.includes(String(req.query.role)) ? String(req.query.role) : null;
  const activeOnly = String(req.query.active) !== 'false';
  try {
    const conds = ['o.federation_id = $1'];
    const params = [federationId];
    let n = 2;
    if (role) { conds.push(`o.role = $${n}`); params.push(role); n++; }
    if (activeOnly) conds.push('o.active = true');
    const { rows } = await db.query(
      `SELECT o.id, o.practitioner_id, o.name, o.dojo_id,
              COALESCE(o.dojo_name, dj.trade_name, dj.legal_name) AS dojo_name,
              o.role, o.credential, o.credential_note, o.email, o.phone, o.active
         FROM karate_officials o
         LEFT JOIN companies dj ON dj.id = o.dojo_id
        WHERE ${conds.join(' AND ')}
        ORDER BY o.role ASC, o.credential ASC NULLS LAST, o.name ASC`,
      params
    );
    return res.json(rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    console.error('[karateOfficials] list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar oficiais' });
  }
});

// ── POST /officials ─────────────────────────────────────────
router.post('/officials', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const b = req.body || {};
  const name = trimOrNull(b.name);
  if (!name) return res.status(422).json({ error: 'name é obrigatório', code: 'VALIDATION_ERROR' });
  const role = ROLES.includes(b.role) ? b.role : 'arbitro';
  const credential = b.credential != null && b.credential !== ''
    ? String(b.credential).toUpperCase() : null;
  if (credential && !CREDENTIALS.includes(credential)) {
    return res.status(422).json({ error: `credential deve ser: ${CREDENTIALS.join(', ')}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const ins = await db.query(
      `INSERT INTO karate_officials
         (federation_id, practitioner_id, name, dojo_id, dojo_name, role,
          credential, credential_note, email, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, practitioner_id, name, dojo_id, dojo_name, role,
                 credential, credential_note, email, phone, active`,
      [
        federationId, b.practitioner_id || null, name, b.dojo_id || null,
        trimOrNull(b.dojo_name), role, credential, trimOrNull(b.credential_note, 300),
        trimOrNull(b.email), trimOrNull(b.phone, 40),
      ]
    );
    return res.status(201).json(ins.rows[0]);
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res, 'Cadastro de arbitragem');
    if (e.code === '22P02') return res.status(422).json({ error: 'id inválido em practitioner_id/dojo_id', code: 'VALIDATION_ERROR' });
    console.error('[karateOfficials] create error:', e.message);
    return res.status(500).json({ error: 'Erro ao cadastrar oficial' });
  }
});

// ── PATCH /officials/:officialId ────────────────────────────
router.patch('/officials/:officialId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, officialId } = req.params;
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;

  if (b.name !== undefined) {
    const name = trimOrNull(b.name);
    if (!name) return res.status(422).json({ error: 'name não pode ser vazio', code: 'VALIDATION_ERROR' });
    sets.push(`name = $${i++}`); vals.push(name);
  }
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return res.status(422).json({ error: `role deve ser: ${ROLES.join(', ')}`, code: 'VALIDATION_ERROR' });
    sets.push(`role = $${i++}`); vals.push(b.role);
  }
  if (b.credential !== undefined) {
    const cred = b.credential != null && b.credential !== '' ? String(b.credential).toUpperCase() : null;
    if (cred && !CREDENTIALS.includes(cred)) {
      return res.status(422).json({ error: `credential deve ser: ${CREDENTIALS.join(', ')}`, code: 'VALIDATION_ERROR' });
    }
    sets.push(`credential = $${i++}`); vals.push(cred);
  }
  for (const [field, max] of [['credential_note', 300], ['dojo_name', 200], ['email', 200], ['phone', 40]]) {
    if (b[field] !== undefined) { sets.push(`${field} = $${i++}`); vals.push(trimOrNull(b[field], max)); }
  }
  if (b.dojo_id !== undefined) { sets.push(`dojo_id = $${i++}`); vals.push(b.dojo_id || null); }
  if (b.practitioner_id !== undefined) { sets.push(`practitioner_id = $${i++}`); vals.push(b.practitioner_id || null); }
  if (b.active !== undefined) { sets.push(`active = $${i++}`); vals.push(b.active !== false); }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  try {
    vals.push(officialId, federationId);
    const upd = await db.query(
      `UPDATE karate_officials SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} AND federation_id = $${i + 1}
      RETURNING id, practitioner_id, name, dojo_id, dojo_name, role,
                credential, credential_note, email, phone, active`,
      vals
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Oficial não encontrado', code: 'NOT_FOUND' });
    return res.json(upd.rows[0]);
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res, 'Cadastro de arbitragem');
    console.error('[karateOfficials] patch error:', e.message);
    return res.status(500).json({ error: 'Erro ao atualizar oficial' });
  }
});

// ── DELETE /officials/:officialId — desativa (soft) ─────────
// Nunca apaga: o oficial aparece em escalas de eventos passados.
router.delete('/officials/:officialId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, officialId } = req.params;
  try {
    const upd = await db.query(
      `UPDATE karate_officials SET active = false, updated_at = NOW()
        WHERE id = $1 AND federation_id = $2 RETURNING id`,
      [officialId, federationId]
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Oficial não encontrado', code: 'NOT_FOUND' });
    return res.json({ deactivated: true, id: officialId });
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res, 'Cadastro de arbitragem');
    console.error('[karateOfficials] delete error:', e.message);
    return res.status(500).json({ error: 'Erro ao desativar oficial' });
  }
});

// ════════════════════════════════════════════════════════════
// ESCALA DO EVENTO
// ════════════════════════════════════════════════════════════

// ── GET /competitions/:cid/officials ────────────────────────
// Devolve a escala com o oficial resolvido + área. É o dado da planilha
// "DISTRIBUIÇÃO DE ARBITRAGEM" (por área, com o chefe destacado).
router.get('/competitions/:cid/officials', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const { rows } = await db.query(
      `SELECT co.id, co.official_id, co.area_id, co.status, co.is_chief, co.sort_order,
              co.penalty_amount, co.penalty_note, co.notes, co.confirmed_at,
              o.name, o.role, o.credential,
              COALESCE(o.dojo_name, dj.trade_name, dj.legal_name) AS dojo_name,
              a.name AS area_name
         FROM karate_competition_officials co
         JOIN karate_officials o ON o.id = co.official_id
         LEFT JOIN companies dj ON dj.id = o.dojo_id
         LEFT JOIN karate_competition_areas a ON a.id = co.area_id
        WHERE co.competition_id = $1 AND o.federation_id = $2
        ORDER BY a.sort_order ASC NULLS LAST, co.is_chief DESC, co.sort_order ASC, o.name ASC`,
      [cid, federationId]
    );
    return res.json(rows.map((r) => ({
      ...r,
      penalty_amount: r.penalty_amount != null ? Number(r.penalty_amount) : null,
    })));
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    console.error('[karateOfficials] event list error:', e.message);
    return res.status(500).json({ error: 'Erro ao carregar a escala' });
  }
});

// ── POST /competitions/:cid/officials — convoca em lote ─────
// Body: { official_ids: [uuid] } → convocados (status 'summoned').
// Reconvocar quem já está na escala é no-op (ON CONFLICT DO NOTHING).
router.post('/competitions/:cid/officials', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const ids = Array.isArray(req.body && req.body.official_ids) ? req.body.official_ids : [];
  if (!ids.length) return res.status(422).json({ error: 'official_ids é obrigatório', code: 'VALIDATION_ERROR' });
  if (ids.length > 200) return res.status(422).json({ error: 'Máximo de 200 oficiais por convocação', code: 'VALIDATION_ERROR' });

  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    // Só oficiais DESTA federação entram (escopo — nunca confia no corpo).
    const valid = await db.query(
      `SELECT id FROM karate_officials WHERE federation_id = $1 AND id = ANY($2::uuid[])`,
      [federationId, ids]
    );
    const validIds = valid.rows.map((r) => r.id);
    const skipped = ids.filter((x) => !validIds.includes(x))
      .map((x) => ({ official_id: x, reason: 'NAO_ENCONTRADO', message: 'Oficial não pertence a esta federação' }));

    let summoned = 0;
    for (const officialId of validIds) {
      const ins = await db.query(
        `INSERT INTO karate_competition_officials (competition_id, official_id, status)
         VALUES ($1,$2,'summoned')
         ON CONFLICT (competition_id, official_id) DO NOTHING
         RETURNING id`,
        [cid, officialId]
      );
      if (ins.rows.length) summoned++;
    }
    return res.status(201).json({ summoned, already: validIds.length - summoned, skipped });
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res, 'Escala de arbitragem');
    if (e.code === '22P02') return res.status(422).json({ error: 'official_ids contém id inválido', code: 'VALIDATION_ERROR' });
    console.error('[karateOfficials] summon error:', e.message);
    return res.status(500).json({ error: 'Erro ao convocar oficiais' });
  }
});

// ── PATCH /competitions/:cid/officials/:rowId ───────────────
// Confirma, escala no koto, marca presença/ausência e registra multa.
// confirmed_at é carimbado quando o status vira 'confirmed'.
router.patch('/competitions/:cid/officials/:rowId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, rowId } = req.params;
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;

  if (b.status !== undefined) {
    if (!OFFICIAL_STATUSES.includes(b.status)) {
      return res.status(422).json({ error: `status deve ser: ${OFFICIAL_STATUSES.join(', ')}`, code: 'VALIDATION_ERROR' });
    }
    sets.push(`status = $${i++}`); vals.push(b.status);
    sets.push(`confirmed_at = ${b.status === 'confirmed' ? 'COALESCE(confirmed_at, NOW())' : 'confirmed_at'}`);
  }
  if (b.area_id !== undefined) { sets.push(`area_id = $${i++}`); vals.push(b.area_id || null); }
  if (b.is_chief !== undefined) { sets.push(`is_chief = $${i++}`); vals.push(b.is_chief === true); }
  if (b.sort_order !== undefined) { sets.push(`sort_order = $${i++}`); vals.push(parseInt(b.sort_order, 10) || 0); }
  if (b.penalty_amount !== undefined) {
    const amount = b.penalty_amount == null || b.penalty_amount === '' ? null : Number(b.penalty_amount);
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
      return res.status(422).json({ error: 'penalty_amount inválido', code: 'VALIDATION_ERROR' });
    }
    sets.push(`penalty_amount = $${i++}`); vals.push(amount);
  }
  if (b.penalty_note !== undefined) { sets.push(`penalty_note = $${i++}`); vals.push(trimOrNull(b.penalty_note, 500)); }
  if (b.notes !== undefined) { sets.push(`notes = $${i++}`); vals.push(trimOrNull(b.notes, 500)); }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    if (b.area_id) {
      const a = await db.query(
        `SELECT id FROM karate_competition_areas WHERE id = $1 AND competition_id = $2 LIMIT 1`,
        [b.area_id, cid]
      );
      if (!a.rows.length) return res.status(404).json({ error: 'Área não encontrada nesta competição', code: 'NOT_FOUND' });
    }

    vals.push(rowId, cid);
    const upd = await db.query(
      `UPDATE karate_competition_officials SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} AND competition_id = $${i + 1}
      RETURNING id, official_id, area_id, status, is_chief, sort_order,
                penalty_amount, penalty_note, notes, confirmed_at`,
      vals
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Convocação não encontrada', code: 'NOT_FOUND' });
    const row = upd.rows[0];
    return res.json({ ...row, penalty_amount: row.penalty_amount != null ? Number(row.penalty_amount) : null });
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res, 'Escala de arbitragem');
    console.error('[karateOfficials] event patch error:', e.message);
    return res.status(500).json({ error: 'Erro ao atualizar a escala' });
  }
});

// ── DELETE /competitions/:cid/officials/:rowId ──────────────
router.delete('/competitions/:cid/officials/:rowId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid, rowId } = req.params;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    const del = await db.query(
      `DELETE FROM karate_competition_officials WHERE id = $1 AND competition_id = $2 RETURNING id`,
      [rowId, cid]
    );
    if (!del.rows.length) return res.status(404).json({ error: 'Convocação não encontrada', code: 'NOT_FOUND' });
    return res.json({ removed: true, id: rowId });
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res, 'Escala de arbitragem');
    console.error('[karateOfficials] event delete error:', e.message);
    return res.status(500).json({ error: 'Erro ao remover da escala' });
  }
});

// ════════════════════════════════════════════════════════════
// TERMO DE RESPONSABILIDADE
// ════════════════════════════════════════════════════════════

// ── PATCH /competitions/:cid/waiver-terms ───────────────────
// Body: { waiver_terms: { version, title, body }, waiver_required? }
router.patch('/competitions/:cid/waiver-terms', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;

  if (b.waiver_terms !== undefined) {
    const t = b.waiver_terms;
    if (t == null || typeof t !== 'object' || Array.isArray(t)) {
      return res.status(422).json({ error: 'waiver_terms deve ser um objeto', code: 'VALIDATION_ERROR' });
    }
    for (const k of ['version', 'title', 'body']) {
      if (t[k] !== undefined && t[k] !== null && typeof t[k] !== 'string') {
        return res.status(422).json({ error: `waiver_terms.${k} deve ser texto`, code: 'VALIDATION_ERROR' });
      }
    }
    if (t.body !== undefined && t.body !== null && String(t.body).length > 20000) {
      return res.status(422).json({ error: 'waiver_terms.body muito longo (máx. 20.000 caracteres)', code: 'VALIDATION_ERROR' });
    }
    sets.push(`waiver_terms = $${i++}::jsonb`); vals.push(JSON.stringify(t));
  }
  if (b.waiver_required !== undefined) {
    sets.push(`waiver_required = $${i++}`); vals.push(b.waiver_required === true);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  try {
    vals.push(cid, federationId);
    const upd = await db.query(
      `UPDATE karate_competitions SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} AND federation_id = $${i + 1}
      RETURNING id, waiver_terms, waiver_required`,
      vals
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    return res.json(upd.rows[0]);
  } catch (e) {
    if (e.code === '42703') return schemaPending(res, 'Termo de responsabilidade');
    console.error('[karateOfficials] waiver-terms error:', e.message);
    return res.status(500).json({ error: 'Erro ao salvar o termo' });
  }
});

// ── GET /competitions/:cid/waivers?dojo_id= ─────────────────
// Status POR ATLETA inscrito: quem já aceitou e quem falta — agrupável
// por dojô (é assim que o delegado cobra a delegação dele).
router.get('/competitions/:cid/waivers', ...guards.read(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const dojoFilter = req.query.dojo_id ? String(req.query.dojo_id) : null;
  try {
    const comp = await findCompetition(federationId, cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    const conds = ['e.competition_id = $1', "e.status NOT IN ('withdrawn')", 'e.student_id IS NOT NULL'];
    const params = [cid];
    let n = 2;
    if (dojoFilter) { conds.push(`e.dojo_id = $${n}`); params.push(dojoFilter); n++; }

    const { rows } = await db.query(
      `SELECT DISTINCT ON (e.student_id)
              e.student_id AS practitioner_id, cu.name AS practitioner_name,
              e.dojo_id, COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
              w.id AS waiver_id, w.accepted_at, w.accepted_by_role, w.accepted_by_name,
              w.modalities, w.image_consent
         FROM karate_competition_entries e
         JOIN customers cu ON cu.id = e.student_id
         LEFT JOIN companies dj ON dj.id = e.dojo_id
         LEFT JOIN karate_competition_waivers w
                ON w.competition_id = e.competition_id AND w.practitioner_id = e.student_id
        WHERE ${conds.join(' AND ')}
        ORDER BY e.student_id, cu.name ASC`,
      params
    );

    const items = rows.map((r) => ({
      practitioner_id: r.practitioner_id,
      practitioner_name: r.practitioner_name,
      dojo_id: r.dojo_id,
      dojo_name: r.dojo_name || null,
      accepted: !!r.waiver_id,
      accepted_at: r.accepted_at || null,
      accepted_by_role: r.accepted_by_role || null,
      accepted_by_name: r.accepted_by_name || null,
      modalities: r.modalities || null,
      image_consent: r.image_consent != null ? r.image_consent : null,
    }));
    const accepted = items.filter((i) => i.accepted).length;
    return res.json({
      required: comp.waiver_required === true,
      total: items.length,
      accepted,
      pending: items.length - accepted,
      items,
    });
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') {
      return res.json({ required: false, total: 0, accepted: 0, pending: 0, items: [], schema_pending: true });
    }
    console.error('[karateOfficials] waivers list error:', e.message);
    return res.status(500).json({ error: 'Erro ao carregar termos' });
  }
});

// ── POST /competitions/:cid/waivers — registra aceite ───────
// Body: { practitioner_id, accepted_by_role, accepted_by_name,
//         accepted_by_doc?, modalities?, image_consent? }
// Idempotente por (competição, praticante): reenviar ATUALIZA o aceite
// (corrigir nome do responsável é operação normal na mesa).
router.post('/competitions/:cid/waivers', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, cid } = req.params;
  const b = req.body || {};
  const practitionerId = b.practitioner_id;
  const acceptedByName = trimOrNull(b.accepted_by_name);
  const role = b.accepted_by_role === 'guardian' ? 'guardian' : 'athlete';

  if (!practitionerId) return res.status(422).json({ error: 'practitioner_id é obrigatório', code: 'VALIDATION_ERROR' });
  if (!acceptedByName) return res.status(422).json({ error: 'accepted_by_name é obrigatório', code: 'VALIDATION_ERROR' });
  const modalities = Array.isArray(b.modalities)
    ? b.modalities.map((m) => trimOrNull(m, 60)).filter(Boolean).slice(0, 12)
    : null;

  try {
    const compRes = await db.query(
      `SELECT id, waiver_terms FROM karate_competitions WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [cid, federationId]
    ).catch((e) => {
      if (e.code === '42703') return { rows: [{ id: cid, waiver_terms: {} }] };
      throw e;
    });
    if (!compRes.rows.length) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });

    // O atleta precisa estar inscrito nesta competição (escopo).
    const enrolled = await db.query(
      `SELECT 1 FROM karate_competition_entries
        WHERE competition_id = $1 AND student_id = $2 AND status NOT IN ('withdrawn') LIMIT 1`,
      [cid, practitionerId]
    );
    if (!enrolled.rows.length) {
      return res.status(404).json({ error: 'Praticante não está inscrito nesta competição', code: 'NOT_FOUND' });
    }

    const dojoRes = await db.query(
      `SELECT dojo_id FROM karate_competition_entries
        WHERE competition_id = $1 AND student_id = $2 LIMIT 1`,
      [cid, practitionerId]
    );

    const ins = await db.query(
      `INSERT INTO karate_competition_waivers
         (federation_id, competition_id, practitioner_id, dojo_id, accepted_by_role,
          accepted_by_name, accepted_by_doc, modalities, terms_snapshot, image_consent, accepted_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (competition_id, practitioner_id) DO UPDATE
          SET accepted_by_role = EXCLUDED.accepted_by_role,
              accepted_by_name = EXCLUDED.accepted_by_name,
              accepted_by_doc  = EXCLUDED.accepted_by_doc,
              modalities       = EXCLUDED.modalities,
              image_consent    = EXCLUDED.image_consent,
              accepted_at      = NOW()
       RETURNING id, practitioner_id, accepted_by_role, accepted_by_name,
                 modalities, image_consent, accepted_at`,
      [
        federationId, cid, practitionerId, dojoRes.rows[0]?.dojo_id || null, role,
        acceptedByName, trimOrNull(b.accepted_by_doc, 40), modalities,
        JSON.stringify(compRes.rows[0].waiver_terms || {}),
        b.image_consent !== false,
        trimOrNull(req.ip, 60),
      ]
    );
    return res.status(201).json(ins.rows[0]);
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res, 'Termo de responsabilidade');
    if (e.code === '22P02') return res.status(422).json({ error: 'practitioner_id inválido', code: 'VALIDATION_ERROR' });
    console.error('[karateOfficials] waiver create error:', e.message);
    return res.status(500).json({ error: 'Erro ao registrar o termo' });
  }
});

module.exports = router;
