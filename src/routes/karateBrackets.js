// ============================================================
// AURA KARATÊ — Track M: Rotas de Chaves / Brackets
// Montado em /federation/:id (igual aos demais tracks do Karatê).
//
// Kumite (bracket eliminatório):
//   POST   /competitions/:cid/categories/:catId/bracket/generate  — gera/regenera (draft)
//   POST   /competitions/:cid/categories/:catId/bracket/lock      — trava (official)
//   POST   /competitions/:cid/categories/:catId/bracket/unlock    — destrava (locked→draft)
//   GET    /competitions/:cid/categories/:catId/bracket           — lê bracket
//   POST   /competitions/:cid/categories/:catId/bracket/advance   — avança vencedor (+ placar opcional)
//   PUT    /competitions/:cid/categories/:catId/bracket/matches   — edição total em lote (Fase 1)
//   POST   /competitions/:cid/categories/:catId/bracket/reset     — limpa vencedores/placares (mantém seeding)
//   PATCH  /competitions/:cid/categories/:catId/bracket/phase-plan — plano de fases (P1, migration 296)
//   GET    /competitions/:cid/categories/:catId/scoresheet       — SÚMULA (P1: chave + fases + regras + koto)
//
// P1 (migration 296): formato por FASE da chave + registro de DECISÃO
// (hantei/kettei-sen/...) por luta + kata em CHAVE 1×1 (kata_mode=
// 'hantei_tree' no generate — reusa todo o motor de matches).
//
// Kata (por bateria):
//   GET    /competitions/:cid/categories/:catId/kata-scores       — lê notas
//   PUT    /competitions/:cid/categories/:catId/kata-scores       — salva nota
//   POST   /competitions/:cid/categories/:catId/kata-scores/generate-order — sorteia ordem
//   POST   /competitions/:cid/categories/:catId/kata-scores/advance — avança eliminatória→final
//   PUT    /competitions/:cid/categories/:catId/kata-scores/order — reordena manualmente (drag-and-drop)
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const {
  generateKumiteBracket,
  advanceWinner,
  generateKataOrder,
  stateToMatchRows,
  rowsToState,
  computePlacements,
} = require('../services/karateBracket');
const phasePlanSvc = require('../services/karatePhasePlanService');
const kataScoring = require('../services/karateKataScoring');

// ── helper: find competition (scoped to federation) ──────────────
async function findComp(client, federationId, cid) {
  const r = await client.query(
    `SELECT id, status FROM karate_competitions WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [cid, federationId]
  );
  return r.rows[0] || null;
}

// ── helper: find category (scoped to competition) ────────────────
async function findCat(client, cid, catId) {
  const r = await client.query(
    `SELECT id, modality FROM karate_competition_categories WHERE id = $1 AND competition_id = $2 LIMIT 1`,
    [catId, cid]
  );
  return r.rows[0] || null;
}

// ── helper: load entries for a category ─────────────────────────
// P0 equipes (migration 294): a entry pode apontar para um ATLETA
// (student_id) ou para uma EQUIPE (team_id) — o nome exibido na chave vem
// de quem existir. Cache module-level otimista: se team_id ainda não
// existe (294 pendente), degrada para a forma antiga (só atletas) sem
// repetir o 42703 a cada request.
let HAS_TEAM_ENTRIES = true;
async function loadEntries(client, catId, federationId) {
  if (HAS_TEAM_ENTRIES) {
    try {
      const r = await client.query(
        `SELECT e.id, e.student_id, e.dojo_id, e.team_id,
                COALESCE(cu.name, t.name) AS student_name,
                COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
         FROM karate_competition_entries e
         LEFT JOIN customers cu ON cu.id = e.student_id
         LEFT JOIN karate_competition_teams t ON t.id = e.team_id
         LEFT JOIN companies dj ON dj.id = e.dojo_id
         WHERE e.category_id = $1
           AND e.status NOT IN ('withdrawn')
         ORDER BY e.created_at ASC`,
        [catId]
      );
      return r.rows.map(r => ({
        id: r.id,
        student_id: r.student_id,
        team_id: r.team_id || null,
        dojo_id: r.dojo_id,
        dojo: r.dojo_name,
        student_name: r.student_name,
      }));
    } catch (e) {
      if (e.code === '42703' || e.code === '42P01') {
        HAS_TEAM_ENTRIES = false;
        console.warn('[karateBrackets] team_id/karate_competition_teams ausente (migração 294 pendente) — chave só com atletas');
      } else throw e;
    }
  }
  const r = await client.query(
    `SELECT e.id, e.student_id, e.dojo_id,
            cu.name AS student_name,
            COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
     FROM karate_competition_entries e
     JOIN customers cu ON cu.id = e.student_id
     LEFT JOIN companies dj ON dj.id = e.dojo_id
     WHERE e.category_id = $1
       AND e.status NOT IN ('withdrawn')
     ORDER BY e.created_at ASC`,
    [catId]
  );
  return r.rows.map(r => ({
    id: r.id,
    student_id: r.student_id,
    dojo_id: r.dojo_id,
    dojo: r.dojo_name,
    student_name: r.student_name,
  }));
}

// ── helper: inscritos aguardando confirmação de pagamento ───────
// Conta entries (não-withdrawn) com fee_paid=false SOMENTE quando a
// categoria é paga (taxa da categoria, senão a taxa do evento > 0). Em
// categoria gratuita, fee_paid=false não significa "aguardando pagamento",
// então retorna 0. Defensivo p/ coluna/tabela ausente (42P01/42703 → 0).
async function countPendingPayment(client, cid, catId) {
  try {
    const feeRes = await client.query(
      `SELECT COALESCE(cat.fee_amount, comp.fee_amount, 0) AS effective_fee
         FROM karate_competition_categories cat
         JOIN karate_competitions comp ON comp.id = cat.competition_id
        WHERE cat.id = $1 AND cat.competition_id = $2
        LIMIT 1`,
      [catId, cid]
    );
    const effectiveFee = Number(feeRes.rows[0]?.effective_fee) || 0;
    if (effectiveFee <= 0) return 0;
    const r = await client.query(
      `SELECT COUNT(*)::int AS pending
         FROM karate_competition_entries
        WHERE category_id = $1
          AND status NOT IN ('withdrawn')
          AND fee_paid = false`,
      [catId]
    );
    return r.rows[0]?.pending || 0;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return 0;
    throw e;
  }
}

// ── helper: load bracket + matches ──────────────────────────────
async function loadBracket(client, catId) {
  let bracketRow = null;
  let matchRows = [];
  try {
    const br = await client.query(
      `SELECT * FROM karate_brackets WHERE category_id = $1 LIMIT 1`,
      [catId]
    );
    if (br.rows.length) {
      bracketRow = br.rows[0];
      const mr = await client.query(
        `SELECT * FROM karate_bracket_matches WHERE bracket_id = $1 ORDER BY round ASC, slot ASC`,
        [bracketRow.id]
      );
      matchRows = mr.rows;
    }
  } catch (e) {
    if (e.code === '42P01') return { bracketRow: null, matchRows: [] }; // table not yet created
    throw e;
  }
  return { bracketRow, matchRows };
}

// ── helper: upsert bracket matches ──────────────────────────────
// scoreMap opcional: { "r{round}-{slot}"|"third" -> { aka_score, shiro_score } }
// usado para preservar placares já lançados quando advance() reconstrói o
// bracket inteiro via delete+insert (stateToMatchRows não conhece scores).
// Defensivo: coluna aka_score/shiro_score pode não existir ainda (42703).
async function upsertMatches(client, bracketId, matchRowsData, scoreMap) {
  // Delete old matches and re-insert (simpler than diff)
  await client.query(`DELETE FROM karate_bracket_matches WHERE bracket_id = $1`, [bracketId]);
  // Três degraus de compatibilidade de schema:
  //   full   → migration 296 (placar + match_format + decision)
  //   scores → migration 210 (só placar)
  //   base   → schema original (183)
  let tier = 'full';
  for (const m of matchRowsData) {
    const key = m.bracket_kind === 'third' ? 'third' : `r${m.round}-${m.slot}`;
    const meta = (scoreMap && scoreMap[key]) || {};
    const akaScore = meta.aka_score !== undefined ? meta.aka_score : null;
    const shiroScore = meta.shiro_score !== undefined ? meta.shiro_score : null;
    const matchFormat = meta.match_format !== undefined ? meta.match_format : null;
    const decision = meta.decision !== undefined ? meta.decision : null;

    if (tier === 'full') {
      try {
        await client.query(
          `INSERT INTO karate_bracket_matches
             (bracket_id, round, slot, bracket_kind, aka_entry_id, shiro_entry_id, winner_entry_id, is_bye,
              aka_score, shiro_score, match_format, decision)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
          [m.bracket_id, m.round, m.slot, m.bracket_kind,
           m.aka_entry_id || null, m.shiro_entry_id || null, m.winner_entry_id || null, m.is_bye,
           akaScore, shiroScore, matchFormat, decision != null ? JSON.stringify(decision) : null]
        );
        continue;
      } catch (e) {
        if (e.code === '42703') tier = 'scores'; // 296 pendente
        else throw e;
      }
    }
    if (tier === 'scores') {
      try {
        await client.query(
          `INSERT INTO karate_bracket_matches
             (bracket_id, round, slot, bracket_kind, aka_entry_id, shiro_entry_id, winner_entry_id, is_bye, aka_score, shiro_score)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [m.bracket_id, m.round, m.slot, m.bracket_kind,
           m.aka_entry_id || null, m.shiro_entry_id || null, m.winner_entry_id || null, m.is_bye,
           akaScore, shiroScore]
        );
        continue;
      } catch (e) {
        if (e.code === '42703') tier = 'base'; // 210 pendente
        else throw e;
      }
    }
    await client.query(
      `INSERT INTO karate_bracket_matches
         (bracket_id, round, slot, bracket_kind, aka_entry_id, shiro_entry_id, winner_entry_id, is_bye)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [m.bracket_id, m.round, m.slot, m.bracket_kind,
       m.aka_entry_id || null, m.shiro_entry_id || null, m.winner_entry_id || null, m.is_bye]
    );
  }
}

// ── helper: mapa "r{round}-{slot}"|"third" → { aka_score, shiro_score } ──
// (usado para enriquecer o BracketState serializado no GET/PUT/reset/advance
// sem precisar ensinar o serviço puro karateBracket.js sobre placares.)
function buildScoreMap(matchRows) {
  const map = {};
  for (const m of matchRows) {
    const key = m.bracket_kind === 'third' ? 'third' : `r${m.round}-${m.slot}`;
    map[key] = {
      aka_score: m.aka_score !== undefined ? m.aka_score : null,
      shiro_score: m.shiro_score !== undefined ? m.shiro_score : null,
      // P1 (296): snapshot do formato + registro de decisão da luta.
      match_format: m.match_format !== undefined ? m.match_format : null,
      decision: m.decision !== undefined ? m.decision : null,
    };
  }
  return map;
}

// ── helper: monta o BracketState serializado (shape retornado por GET,
// PUT /matches, POST /reset, e reaproveitado no /advance) para kumite. ──
function buildKumiteBracketState(bracketRow, matchRows, athletes, pendingPaymentCount) {
  const state = rowsToState(matchRows, bracketRow, athletes);
  const scoreMap = buildScoreMap(matchRows);
  // P1: plano de fases (296) → formato por rodada para a UI/súmula.
  const phasePlan = bracketRow.phase_plan || {};
  const phaseInfo = state.rounds.length ? phasePlanSvc.phaseByRound(phasePlan, state.rounds.length) : [];
  const phaseFinal = state.rounds.length
    ? phasePlanSvc.resolvePhaseForRound(phasePlan, state.rounds.length - 1, state.rounds.length, true)
    : null;

  const athleteMap = {};
  for (const a of athletes) athleteMap[a.id] = a;

  const serializeMatch = (m) => {
    const scoreKey = m.id === 'third' ? 'third' : m.id;
    const scores = scoreMap[scoreKey] || { aka_score: null, shiro_score: null };
    return {
      id: m.id,
      round: m.round,
      slot: m.slot,
      aka: m.akaId && m.akaId !== 'bye' && m.akaId !== null ? {
        entry_id: m.akaId,
        student_name: athleteMap[m.akaId]?.student_name || null,
        dojo_name: athleteMap[m.akaId]?.dojo || null,
      } : (m.akaId === 'bye' ? 'bye' : null),
      shiro: m.shiroId && m.shiroId !== 'bye' && m.shiroId !== null ? {
        entry_id: m.shiroId,
        student_name: athleteMap[m.shiroId]?.student_name || null,
        dojo_name: athleteMap[m.shiroId]?.dojo || null,
      } : (m.shiroId === 'bye' ? 'bye' : null),
      winner_entry_id: m.winnerId,
      is_bye: m.isBye,
      aka_score: scores.aka_score,
      shiro_score: scores.shiro_score,
      // P1: formato efetivo (snapshot do lançamento OU resolvido do plano)
      // e o registro de como a luta foi decidida.
      match_format: scores.match_format
        || (phaseInfo && m.id !== 'third' && phaseInfo[m.round] ? phaseInfo[m.round].format : null)
        || (m.id === 'third' && phaseFinal ? phaseFinal.format : null),
      decision: scores.decision || null,
    };
  };

  const rounds = state.rounds.map(r => r.map(serializeMatch));
  const third = state.thirdPlaceMatch ? serializeMatch({
    ...state.thirdPlaceMatch, round: state.rounds.length, slot: 0, isBye: false,
  }) : null;

  const lastRound = state.rounds[state.rounds.length - 1];
  const champion = lastRound?.[0]?.winnerId
    ? { entry_id: lastRound[0].winnerId, student_name: athleteMap[lastRound[0].winnerId]?.student_name || null }
    : null;

  return {
    bracket_id: bracketRow.id,
    status: bracketRow.status,
    modality: bracketRow.modality,
    kata_mode: bracketRow.kata_mode || null,
    seed: bracketRow.draw_seed,
    options: bracketRow.options,
    phase_plan: phasePlan,
    phases_by_round: phaseInfo,
    athletes_count: athletes.length,
    pending_payment_count: pendingPaymentCount,
    bye_count: state.byeCount,
    rounds,
    third_place_match: third,
    champion,
  };
}

// ── helper: aplica update parcial de placar/vencedor/slots em 1 match ────
// Defensivo: se aka_score/shiro_score ainda não existirem na tabela (42703,
// migration 210 não aplicada), ignora esses 2 campos silenciosamente.
async function applyMatchUpdate(client, matchRow, patch) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (Object.prototype.hasOwnProperty.call(patch, 'aka_entry_id')) {
    fields.push(`aka_entry_id = $${idx++}`); values.push(patch.aka_entry_id);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'shiro_entry_id')) {
    fields.push(`shiro_entry_id = $${idx++}`); values.push(patch.shiro_entry_id);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'winner_entry_id')) {
    fields.push(`winner_entry_id = $${idx++}`); values.push(patch.winner_entry_id);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'is_bye')) {
    fields.push(`is_bye = $${idx++}`); values.push(!!patch.is_bye);
  }
  // P1 (296): registro de decisão editável na edição total. 42703 (coluna
  // ausente) é tolerado pelo mesmo caminho dos placares abaixo.
  const hasDecisionField = Object.prototype.hasOwnProperty.call(patch, 'decision');

  const hasScoreFields = Object.prototype.hasOwnProperty.call(patch, 'aka_score') ||
    Object.prototype.hasOwnProperty.call(patch, 'shiro_score') ||
    Object.prototype.hasOwnProperty.call(patch, 'decision');

  async function runUpdate(withScores) {
    const f = [...fields];
    const v = [...values];
    let i = idx;
    if (withScores) {
      if (Object.prototype.hasOwnProperty.call(patch, 'aka_score')) {
        f.push(`aka_score = $${i++}`); v.push(patch.aka_score);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'shiro_score')) {
        f.push(`shiro_score = $${i++}`); v.push(patch.shiro_score);
      }
      if (hasDecisionField) {
        f.push(`decision = $${i++}::jsonb`);
        v.push(patch.decision != null ? JSON.stringify(phasePlanSvc.normalizeDecision(patch.decision)) : null);
      }
    }
    if (!f.length) return;
    f.push(`updated_at = NOW()`);
    v.push(matchRow.id);
    await client.query(
      `UPDATE karate_bracket_matches SET ${f.join(', ')} WHERE id = $${i}`,
      v
    );
  }

  if (hasScoreFields) {
    try {
      await runUpdate(true);
    } catch (e) {
      if (e.code === '42703') {
        // Coluna aka_score/shiro_score ainda não existe — fallback: aplica
        // só os demais campos, ignora os placares silenciosamente.
        await runUpdate(false);
      } else {
        throw e;
      }
    }
  } else {
    await runUpdate(false);
  }
}

// ═══════════════════════════════════════════════════════════════
// POST /competitions/:cid/categories/:catId/bracket/generate
// Gera ou regenera a chave (draft). Pode ser chamado múltiplas vezes.
// Body: { method, separateSameDojo, thirdPlace, seed }
// ═══════════════════════════════════════════════════════════════
router.post(
  '/competitions/:cid/categories/:catId/bracket/generate',
  ...guards.staffWrite(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const { method = 'ranking', separateSameDojo = false, thirdPlace = false, seed } = req.body;
    // P1 (296): kata em CHAVE 1x1 por bandeiras - quando 'hantei_tree', a
    // categoria de kata gera a MESMA arvore do kumite (aka/shiro/hantei) em
    // vez de bateria de notas. So vale para modalidades de kata.
    const kataMode = req.body.kata_mode === 'hantei_tree' ? 'hantei_tree' : null;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' }); }

      const cat = await findCat(client, cid, catId);
      if (!cat) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoria não encontrada', code: 'NOT_FOUND' }); }

      // Kata: por padrao gera so a ordem de apresentacao (bateria de notas);
      // com kata_mode='hantei_tree' cai no caminho da ARVORE (P1/296).
      const isKata = ['kata', 'team_kata'].includes(cat.modality) && kataMode !== 'hantei_tree';

      const athletes = await loadEntries(client, catId, federationId);
      const pendingPaymentCount = await countPendingPayment(client, cid, catId);
      if (athletes.length < 2) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'Mínimo de 2 atletas inscritos para gerar chave', code: 'VALIDATION_ERROR' });
      }

      const drawSeed = seed !== undefined ? String(seed) : String(Date.now());
      const options = { method, separateSameDojo: !!separateSameDojo, thirdPlace: !!thirdPlace };

      // Upsert bracket row
      let bracketId;
      try {
        // P1: grava kata_mode junto (296); 42703 -> forma sem a coluna.
        try {
          const br = await client.query(
            `INSERT INTO karate_brackets (competition_id, category_id, modality, status, draw_seed, options, kata_mode, created_by)
             VALUES ($1,$2,$3,'draft',$4,$5,$6,$7)
             ON CONFLICT (competition_id, category_id)
             DO UPDATE SET status='draft', draw_seed=$4, options=$5, kata_mode=$6, updated_at=NOW()
             RETURNING id`,
            [cid, catId, cat.modality, drawSeed, JSON.stringify(options),
             kataMode, req.user?.id || null]
          );
          bracketId = br.rows[0].id;
        } catch (eCol) {
          if (eCol.code !== '42703') throw eCol;
          const br = await client.query(
            `INSERT INTO karate_brackets (competition_id, category_id, modality, status, draw_seed, options, created_by)
             VALUES ($1,$2,$3,'draft',$4,$5,$6)
             ON CONFLICT (competition_id, category_id)
             DO UPDATE SET status='draft', draw_seed=$4, options=$5, updated_at=NOW()
             RETURNING id`,
            [cid, catId, cat.modality, drawSeed, JSON.stringify(options),
             req.user?.id || null]
          );
          bracketId = br.rows[0].id;
        }
      } catch (e) {
        if (e.code === '42P01') {
          await client.query('ROLLBACK');
          return res.status(503).json({ error: 'Migration 183 não aplicada ainda', code: 'SCHEMA_PENDING' });
        }
        throw e;
      }

      if (isKata) {
        // For kata: generate presentation order + reset scores
        const ordered = generateKataOrder(athletes, drawSeed);
        try {
          await client.query(`DELETE FROM karate_kata_scores WHERE bracket_id = $1`, [bracketId]);
          for (let i = 0; i < ordered.length; i++) {
            await client.query(
              `INSERT INTO karate_kata_scores (bracket_id, entry_id, phase, presentation_order)
               VALUES ($1,$2,'eliminatoria',$3)`,
              [bracketId, ordered[i].id, i + 1]
            );
          }
        } catch (e) {
          if (e.code === '42P01') {
            await client.query('ROLLBACK');
            return res.status(503).json({ error: 'Migration 183 não aplicada ainda', code: 'SCHEMA_PENDING' });
          }
          throw e;
        }

        await client.query('COMMIT');
        return res.json({
          bracket_id: bracketId,
          modality: cat.modality,
          status: 'draft',
          seed: drawSeed,
          options,
          athletes_count: athletes.length,
          pending_payment_count: pendingPaymentCount,
          presentation_order: ordered.map((a, i) => ({ entry_id: a.id, student_name: a.student_name, order: i + 1 })),
        });
      }

      // Kumite: generate bracket
      let state;
      try {
        state = generateKumiteBracket(athletes, {
          method,
          separateSameDojo: !!separateSameDojo,
          thirdPlace: !!thirdPlace,
          seed: drawSeed,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: err.message, code: 'VALIDATION_ERROR' });
      }

      const matchRows = stateToMatchRows(bracketId, state);
      await upsertMatches(client, bracketId, matchRows);

      await client.query('COMMIT');

      // Count clashes
      let sameDojoClashes = 0;
      for (const m of state.rounds[0]) {
        if (m.akaId && m.shiroId && m.akaId !== 'bye' && m.shiroId !== 'bye') {
          const aA = athletes.find(a => a.id === m.akaId);
          const aB = athletes.find(a => a.id === m.shiroId);
          if (aA && aB && aA.dojo_id && aA.dojo_id === aB.dojo_id) sameDojoClashes++;
        }
      }

      res.json({
        bracket_id: bracketId,
        modality: cat.modality,
        kata_mode: kataMode,
        status: 'draft',
        seed: drawSeed,
        options,
        athletes_count: athletes.length,
        pending_payment_count: pendingPaymentCount,
        bye_count: state.byeCount,
        same_dojo_clashes: sameDojoClashes,
        third_place: !!thirdPlace,
        rounds_count: state.rounds.length,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] generate error:', err.message);
      res.status(500).json({ error: 'Erro ao gerar chave', detail: err.message });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// POST /competitions/:cid/categories/:catId/bracket/lock
// Trava a chave (status draft→locked). Libera lançamento de resultados.
// ═══════════════════════════════════════════════════════════════
router.post(
  '/competitions/:cid/categories/:catId/bracket/lock',
  ...guards.staffWrite(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada' }); }

      let row;
      try {
        const br = await client.query(
          `UPDATE karate_brackets SET status='locked', updated_at=NOW()
           WHERE category_id = $1 AND status='draft'
           RETURNING id, status, modality, options`,
          [catId]
        );
        row = br.rows[0];
      } catch (e) {
        if (e.code === '42P01') { await client.query('ROLLBACK'); return res.status(503).json({ error: 'Migration 183 não aplicada', code: 'SCHEMA_PENDING' }); }
        throw e;
      }

      if (!row) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Chave não encontrada ou já travada', code: 'CONFLICT' });
      }

      await client.query('COMMIT');
      res.json({ bracket_id: row.id, status: 'locked', modality: row.modality, message: 'Chave travada. Lançamento de resultados liberado.' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] lock error:', err.message);
      res.status(500).json({ error: 'Erro ao travar chave' });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// POST /competitions/:cid/categories/:catId/bracket/finalize
//
// P2 (modo mesário) — mata o "correio de papel" do dia de evento: quando a
// última decisão da chave é lançada, este endpoint deriva o PÓDIO
// (1º/2º/3º[/4º ou dois 3ºs]) e o grava DE VOLTA nas inscrições
// (placement + points_awarded), alimentando o ranking da temporada e a
// fila de premiação SEM planilha andando até a mesa central.
//
//  - Árvore (kumite / kata hantei_tree): computePlacements sobre o estado.
//  - Kata por notas (score_rounds): ranking da fase FINAL por nota desc
//    (empate de nota = mesmo placement, ranking de competição 1,2,2,4).
//  - Pontos por colocação vêm de karate_competitions.results_config
//    ({"points_by_placement":{"1":9,"2":6,"3":3}}); sem config, grava só o
//    placement (atleta aparece no ranking por medalha, sem pontos).
//  - Idempotente: re-finalizar recomputa e sobrescreve (zera placement dos
//    não-podiados da categoria antes de aplicar).
// ═══════════════════════════════════════════════════════════════
// Handler NOMEADO (P2.1): compartilhado com a MESA pública do mesário
// (karateMesaPublic.js), que autentica por token e injeta req.params.id.
const finalizeHandler = async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' }); }
      const cat = await findCat(client, cid, catId);
      if (!cat) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoria não encontrada', code: 'NOT_FOUND' }); }

      const { bracketRow, matchRows } = await loadBracket(client, catId);
      if (!bracketRow) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Chave não gerada para esta categoria', code: 'NO_BRACKET' }); }
      if (bracketRow.status !== 'locked') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A chave precisa estar travada (locked) para finalizar o resultado.', code: 'BRACKET_NOT_LOCKED' });
      }

      const athletes = await loadEntries(client, catId, federationId);
      const byId = new Map(athletes.map((a) => [a.id, a]));

      // ── deriva o pódio ──
      let placements = [];
      if (bracketRow.kata_mode === 'score_rounds') {
        // Ranking pela cascata real (total cortado → +menor → +maior);
        // `notas` é da 303 — fallback 42703 mantém o ranking por nota.
        let scRows;
        try {
          scRows = (await client.query(
            `SELECT entry_id, nota, notas FROM karate_kata_scores
              WHERE bracket_id = $1 AND phase = 'final' AND nota IS NOT NULL`,
            [bracketRow.id]
          )).rows;
        } catch (e303) {
          if (e303.code !== '42703') throw e303;
          scRows = (await client.query(
            `SELECT entry_id, nota, NULL AS notas FROM karate_kata_scores
              WHERE bracket_id = $1 AND phase = 'final' AND nota IS NOT NULL`,
            [bracketRow.id]
          )).rows;
        }
        if (!scRows.length) {
          await client.query('ROLLBACK');
          return res.status(422).json({ error: 'Nenhuma nota lançada na fase final ainda.', code: 'FINAL_PENDENTE' });
        }
        scRows = scRows.map((r) => ({ ...r, nota: Number(r.nota) })).sort(kataScoring.compareKata);
        // Ranking de competição: empate PERSISTENTE (após a cascata) =
        // mesmo lugar (1,2,2,4) — na prática o dia resolve com novo kata.
        let last = null; let lastPlace = 0;
        scRows.forEach((r, i) => {
          const tied = last !== null && kataScoring.compareKata(last, r) === 0;
          const place = tied ? lastPlace : i + 1;
          placements.push({ entryId: r.entry_id, placement: place });
          last = r; lastPlace = place;
        });
      } else {
        const state = rowsToState(matchRows, bracketRow, athletes);
        const result = computePlacements(state);
        if (!result.complete) {
          await client.query('ROLLBACK');
          const msg = result.reason === 'TERCEIRO_PENDENTE'
            ? 'A disputa de 3º lugar ainda não foi decidida.'
            : 'A final ainda não foi decidida.';
          return res.status(422).json({ error: msg, code: result.reason });
        }
        placements = result.placements;
      }

      // ── pontos por colocação (results_config; 42703 = migration 301 pendente) ──
      let pointsMap = null;
      try {
        const rc = await client.query(
          `SELECT results_config FROM karate_competitions WHERE id = $1 LIMIT 1`, [cid]
        );
        const cfg = rc.rows[0] && rc.rows[0].results_config;
        if (cfg && cfg.points_by_placement && typeof cfg.points_by_placement === 'object') {
          pointsMap = cfg.points_by_placement;
        }
      } catch (e) {
        if (e.code !== '42703') throw e;
      }

      // ── escreve de volta nas inscrições (idempotente) ──
      await client.query(
        `UPDATE karate_competition_entries
            SET placement = NULL, updated_at = NOW()
          WHERE category_id = $1 AND placement IS NOT NULL`,
        [catId]
      );
      const podium = [];
      for (const p of placements) {
        const pts = pointsMap ? (Number(pointsMap[String(p.placement)]) || 0) : 0;
        await client.query(
          `UPDATE karate_competition_entries
              SET placement = $1, points_awarded = $2, status = 'done', updated_at = NOW()
            WHERE id = $3 AND category_id = $4`,
          [p.placement, pts, p.entryId, catId]
        );
        const a = byId.get(p.entryId);
        podium.push({
          placement: p.placement,
          entry_id: p.entryId,
          name: (a && a.student_name) || null,
          dojo: (a && a.dojo) || null,
          points_awarded: pts,
        });
      }

      await client.query('COMMIT');
      res.json({
        finalized: true,
        category_id: catId,
        podium,
        points_applied: !!pointsMap,
        message: 'Resultado computado. A categoria já aparece na fila de premiação.',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] finalize error:', err.message);
      res.status(500).json({ error: 'Erro ao finalizar o resultado da chave' });
    } finally {
      client.release();
    }
  };
router.post('/competitions/:cid/categories/:catId/bracket/finalize', ...guards.staffWrite(), finalizeHandler);

// ═══════════════════════════════════════════════════════════════
// GET /competitions/:cid/categories/:catId/bracket
// Retorna o bracket completo (draft ou locked).
// ═══════════════════════════════════════════════════════════════
const getBracketHandler = async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const client = await db.connect();
    try {
      const comp = await findComp(client, federationId, cid);
      if (!comp) return res.status(404).json({ error: 'Competição não encontrada' });

      const athletes = await loadEntries(client, catId, federationId);
      const pendingPaymentCount = await countPendingPayment(client, cid, catId);
      const { bracketRow, matchRows } = await loadBracket(client, catId);

      if (!bracketRow) {
        return res.json({ status: 'not_generated', athletes_count: athletes.length, pending_payment_count: pendingPaymentCount, bracket: null });
      }

      // Kata: bateria de notas - EXCETO em kata_mode='hantei_tree' (P1),
      // que devolve a arvore como o kumite.
      const isKata = ['kata', 'team_kata'].includes(bracketRow.modality)
        && bracketRow.kata_mode !== 'hantei_tree';
      if (isKata) {
        let scores = [];
        try {
          const sc = await client.query(
            `SELECT ks.*, e.student_id,
                    cu.name AS student_name,
                    COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
             FROM karate_kata_scores ks
             JOIN karate_competition_entries e ON e.id = ks.entry_id
             JOIN customers cu ON cu.id = e.student_id
             LEFT JOIN companies dj ON dj.id = e.dojo_id
             WHERE ks.bracket_id = $1
             ORDER BY ks.phase ASC, ks.presentation_order ASC NULLS LAST, ks.nota DESC NULLS LAST`,
            [bracketRow.id]
          );
          scores = sc.rows;
        } catch (e) {
          if (e.code !== '42P01') throw e;
        }
        return res.json({
          bracket_id: bracketRow.id,
          status: bracketRow.status,
          modality: bracketRow.modality,
          seed: bracketRow.draw_seed,
          options: bracketRow.options,
          athletes_count: athletes.length,
          pending_payment_count: pendingPaymentCount,
          kata_scores: scores.map(s => ({
            entry_id: s.entry_id,
            student_name: s.student_name,
            dojo_name: s.dojo_name,
            phase: s.phase,
            nota: s.nota !== null ? parseFloat(s.nota) : null,
            presentation_order: s.presentation_order,
            advances: s.advances,
          })),
        });
      }

      // Kumite: reconstruct state (mesmo shape usado por PUT /matches, /reset, /advance)
      const bracketState = buildKumiteBracketState(bracketRow, matchRows, athletes, pendingPaymentCount);
      res.json(bracketState);
    } catch (err) {
      console.error('[karateBrackets] get error:', err.message);
      res.status(500).json({ error: 'Erro ao carregar chave' });
    } finally {
      client.release();
    }
  };
router.get('/competitions/:cid/categories/:catId/bracket', ...guards.read(), getBracketHandler);

// ═══════════════════════════════════════════════════════════════
// POST /competitions/:cid/categories/:catId/bracket/advance
// Lança vencedor de uma partida e propaga pelo bracket.
// Body: { match_id, winner_entry_id, aka_score?, shiro_score? }
// aka_score/shiro_score são opcionais e retrocompatíveis: quando ausentes,
// comportamento idêntico ao anterior. Defensivo p/ coluna ausente (42703).
// Requires: bracket status = 'locked'
// ═══════════════════════════════════════════════════════════════
const advanceHandler = async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const { match_id: matchId, winner_entry_id: winnerId, aka_score: akaScore, shiro_score: shiroScore, decision } = req.body;

    if (!matchId || !winnerId) {
      return res.status(422).json({ error: 'match_id e winner_entry_id são obrigatórios', code: 'VALIDATION_ERROR' });
    }
    // P1: registro de COMO a luta foi decidida (hantei/kettei-sen/...).
    const dv = phasePlanSvc.validateDecision(decision);
    if (!dv.ok) {
      return res.status(422).json({ error: dv.error, code: 'VALIDATION_ERROR' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada' }); }

      const athletes = await loadEntries(client, catId, federationId);
      const pendingPaymentCount = await countPendingPayment(client, cid, catId);
      const { bracketRow, matchRows } = await loadBracket(client, catId);

      if (!bracketRow) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Chave não gerada ainda', code: 'NOT_FOUND' });
      }
      if (bracketRow.status !== 'locked') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Chave deve estar travada para lançar resultados', code: 'CONFLICT' });
      }

      const state = rowsToState(matchRows, bracketRow, athletes);

      let newState;
      try {
        newState = advanceWinner(state, matchId, winnerId);
      } catch (err) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: err.message, code: 'VALIDATION_ERROR' });
      }

      // Preserva placares já lançados em outras partidas + aplica o novo
      // placar (se enviado) na partida que acabou de ser decidida.
      const scoreMap = buildScoreMap(matchRows);
      if (akaScore !== undefined || shiroScore !== undefined || decision != null) {
        const existing = scoreMap[matchId] || {};
        scoreMap[matchId] = {
          ...existing,
          aka_score: akaScore !== undefined ? akaScore : (existing.aka_score != null ? existing.aka_score : null),
          shiro_score: shiroScore !== undefined ? shiroScore : (existing.shiro_score != null ? existing.shiro_score : null),
          decision: decision != null ? phasePlanSvc.normalizeDecision(decision) : (existing.decision != null ? existing.decision : null),
        };
      }
      // Snapshot do formato efetivo da luta decidida (do plano de fases) -
      // e o que a sumula imprime, imune a mudancas futuras do plano.
      {
        const mm = /^r(\d+)-(\d+)$/.exec(String(matchId));
        const totalRounds = newState.rounds.length;
        const phase = phasePlanSvc.resolvePhaseForRound(
          bracketRow.phase_plan || {},
          mm ? parseInt(mm[1], 10) : totalRounds - 1,
          totalRounds,
          matchId === 'third'
        );
        if (phase && phase.format) {
          scoreMap[matchId] = Object.assign({}, scoreMap[matchId] || {}, { match_format: phase.format });
        }
      }

      const newMatchRows = stateToMatchRows(bracketRow.id, newState);
      await upsertMatches(client, bracketRow.id, newMatchRows, scoreMap);

      await client.query('COMMIT');

      const lastRound = newState.rounds[newState.rounds.length - 1];
      const champion = lastRound?.[0]?.winnerId || null;

      res.json({
        match_id: matchId,
        winner_entry_id: winnerId,
        champion_entry_id: champion,
        third_place_match: newState.thirdPlaceMatch ? {
          aka_entry_id: newState.thirdPlaceMatch.akaId,
          shiro_entry_id: newState.thirdPlaceMatch.shiroId,
          winner_entry_id: newState.thirdPlaceMatch.winnerId,
        } : null,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] advance error:', err.message);
      res.status(500).json({ error: 'Erro ao avançar vencedor' });
    } finally {
      client.release();
    }
  };
router.post('/competitions/:cid/categories/:catId/bracket/advance', ...guards.staffWrite(), advanceHandler);

// ═══════════════════════════════════════════════════════════════
// PUT /competitions/:cid/categories/:catId/bracket/matches
// Edição total em lote (arrasto/seed manual + vencedor + placar).
// Body: { matches: [{ id, aka_entry_id?, shiro_entry_id?, winner_entry_id?,
//                      aka_score?, shiro_score?, is_bye? }] }
// - Update parcial por id: só altera os campos presentes em cada objeto.
// - aka_entry_id/shiro_entry_id/winner_entry_id (quando não-nulos) devem
//   pertencer a inscritos (entries) da categoria — senão 400.
// - 409 se bracket.status === 'locked' (nada é persistido).
// - Tudo em uma transação: qualquer falha de validação => ROLLBACK total.
// - Defensivo: aka_score/shiro_score são ignorados silenciosamente se as
//   colunas ainda não existirem (42703 — migration 210 não aplicada).
// - Retorna o BracketState completo (mesmo shape do GET).
// ═══════════════════════════════════════════════════════════════
router.put(
  '/competitions/:cid/categories/:catId/bracket/matches',
  ...guards.staffWrite(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const { matches } = req.body;

    if (!Array.isArray(matches) || matches.length === 0) {
      return res.status(422).json({ error: 'matches deve ser um array não-vazio', code: 'VALIDATION_ERROR' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada' }); }

      const cat = await findCat(client, cid, catId);
      if (!cat) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoria não encontrada' }); }

      const { bracketRow, matchRows } = await loadBracket(client, catId);
      if (!bracketRow) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Chave não gerada ainda', code: 'NOT_FOUND' });
      }
      if (bracketRow.status === 'locked') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Destrave a chave para editar.' });
      }

      const athletes = await loadEntries(client, catId, federationId);
      const pendingPaymentCount = await countPendingPayment(client, cid, catId);

      // Valida que todo entry_id referenciado pertence a um inscrito da categoria
      const validEntryIds = new Set(athletes.map(a => a.id));
      // matchById é indexado pelo id SINTÉTICO ("r{round}-{slot}" | "third") —
      // o mesmo formato que o GET .../bracket devolve no campo `id` de cada
      // partida (ver buildKumiteBracketState/rowsToState). O frontend só
      // conhece esse id, nunca o UUID real da linha em karate_bracket_matches.
      const matchById = new Map(matchRows.map(m => {
        const syntheticId = m.bracket_kind === 'third' ? 'third' : `r${m.round}-${m.slot}`;
        return [syntheticId, m];
      }));
      const errors = [];

      for (const patch of matches) {
        if (!patch || !patch.id) {
          errors.push('Todo item de matches precisa de id');
          continue;
        }
        if (!matchById.has(patch.id)) {
          errors.push(`Partida não encontrada: ${patch.id}`);
          continue;
        }
        for (const field of ['aka_entry_id', 'shiro_entry_id', 'winner_entry_id']) {
          if (Object.prototype.hasOwnProperty.call(patch, field) && patch[field] !== null && patch[field] !== undefined) {
            if (!validEntryIds.has(patch[field])) {
              errors.push(`${field} (${patch[field]}) na partida ${patch.id} não pertence a um inscrito desta categoria`);
            }
          }
        }
        // P1: decision, quando presente, precisa ser valida.
        if (Object.prototype.hasOwnProperty.call(patch, 'decision') && patch.decision !== null) {
          const dvp = phasePlanSvc.validateDecision(patch.decision);
          if (!dvp.ok) errors.push(`decision na partida ${patch.id}: ${dvp.error}`);
        }
        // winner_entry_id, quando presente, deve ser um dos dois lados resultantes do patch
        if (Object.prototype.hasOwnProperty.call(patch, 'winner_entry_id') && patch.winner_entry_id) {
          const row = matchById.get(patch.id);
          const finalAka = Object.prototype.hasOwnProperty.call(patch, 'aka_entry_id') ? patch.aka_entry_id : row.aka_entry_id;
          const finalShiro = Object.prototype.hasOwnProperty.call(patch, 'shiro_entry_id') ? patch.shiro_entry_id : row.shiro_entry_id;
          if (patch.winner_entry_id !== finalAka && patch.winner_entry_id !== finalShiro) {
            errors.push(`winner_entry_id (${patch.winner_entry_id}) na partida ${patch.id} não corresponde a aka nem shiro dessa partida`);
          }
        }
      }

      if (errors.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Validação falhou', details: errors, code: 'VALIDATION_ERROR' });
      }

      // Aplica updates parciais, um por um (por id — não sobrescreve campos ausentes)
      for (const patch of matches) {
        const row = matchById.get(patch.id);
        await applyMatchUpdate(client, row, patch);
      }

      // Recarrega estado atualizado para devolver o BracketState completo
      const { bracketRow: freshBracket, matchRows: freshMatchRows } = await loadBracket(client, catId);
      const bracketState = buildKumiteBracketState(freshBracket, freshMatchRows, athletes, pendingPaymentCount);

      await client.query('COMMIT');
      res.json(bracketState);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] matches put error:', err.message);
      res.status(500).json({ error: 'Erro ao salvar edição da chave' });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// POST /competitions/:cid/categories/:catId/bracket/reset
// Limpa winner_entry_id/aka_score/shiro_score de TODAS as partidas do
// bracket, mantendo posições/seeding (aka_entry_id/shiro_entry_id/slot/round
// intactos). 409 se status === 'locked'.
// ═══════════════════════════════════════════════════════════════
router.post(
  '/competitions/:cid/categories/:catId/bracket/reset',
  ...guards.staffWrite(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada' }); }

      const { bracketRow, matchRows } = await loadBracket(client, catId);
      if (!bracketRow) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Chave não gerada ainda', code: 'NOT_FOUND' });
      }
      if (bracketRow.status === 'locked') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Destrave a chave para editar.' });
      }

      // Posições em rodadas >= 1 (e na disputa de 3º) são DERIVADAS dos
      // resultados — "voltar ao estado pré-resultados" exige limpá-las
      // também. Sem isso, atletas ficavam plantados na semi/final após o
      // reset (achado do QA de 23/08, junto do fix do avanço em cascata).
      await client.query(
        `UPDATE karate_bracket_matches
            SET aka_entry_id = NULL, shiro_entry_id = NULL, updated_at = NOW()
          WHERE bracket_id = $1
            AND (round > 0 OR bracket_kind = 'third')`,
        [bracketRow.id]
      );

      try {
        // P1 (296): reset limpa tambem o registro de decisao e o snapshot
        // de formato — a chave volta ao estado pre-resultados.
        await client.query(
          `UPDATE karate_bracket_matches
              SET winner_entry_id = NULL, aka_score = NULL, shiro_score = NULL,
                  match_format = NULL, decision = NULL, updated_at = NOW()
            WHERE bracket_id = $1`,
          [bracketRow.id]
        );
      } catch (e296) {
        if (e296.code !== '42703') throw e296;
        try {
          await client.query(
            `UPDATE karate_bracket_matches
                SET winner_entry_id = NULL, aka_score = NULL, shiro_score = NULL, updated_at = NOW()
              WHERE bracket_id = $1`,
            [bracketRow.id]
          );
        } catch (e210) {
          if (e210.code !== '42703') throw e210;
          // Nem a 210 aplicada — reseta so o vencedor
          await client.query(
            `UPDATE karate_bracket_matches SET winner_entry_id = NULL, updated_at = NOW() WHERE bracket_id = $1`,
            [bracketRow.id]
          );
        }
      }

      const athletes = await loadEntries(client, catId, federationId);
      const pendingPaymentCount = await countPendingPayment(client, cid, catId);
      const { bracketRow: freshBracket, matchRows: freshMatchRows } = await loadBracket(client, catId);
      const bracketState = buildKumiteBracketState(freshBracket, freshMatchRows, athletes, pendingPaymentCount);

      await client.query('COMMIT');
      res.json(bracketState);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] reset error:', err.message);
      res.status(500).json({ error: 'Erro ao resetar chave' });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// POST /competitions/:cid/categories/:catId/bracket/unlock
// Transição de status: locked → draft.
// ═══════════════════════════════════════════════════════════════
router.post(
  '/competitions/:cid/categories/:catId/bracket/unlock',
  ...guards.staffWrite(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada' }); }

      let row;
      try {
        const br = await client.query(
          `UPDATE karate_brackets SET status='draft', updated_at=NOW()
           WHERE category_id = $1 AND status='locked'
           RETURNING id, status`,
          [catId]
        );
        row = br.rows[0];
      } catch (e) {
        if (e.code === '42P01') { await client.query('ROLLBACK'); return res.status(503).json({ error: 'Migration 183 não aplicada', code: 'SCHEMA_PENDING' }); }
        throw e;
      }

      if (!row) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Chave não encontrada ou já destravada', code: 'CONFLICT' });
      }

      await client.query('COMMIT');
      res.json({ status: 'draft' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] unlock error:', err.message);
      res.status(500).json({ error: 'Erro ao destravar chave' });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// PATCH /competitions/:cid/categories/:catId/bracket/phase-plan
// Plano de fases da categoria (P1, migration 296): formato/decisao por
// numero de participantes da rodada, regras de desempate, kata exigido,
// premiacao. Body: { phase_plan }. Valido em draft E locked (o plano e
// metadado da prova; muda-lo nao mexe em resultados ja lancados — o
// match_format de cada luta decidida e SNAPSHOT).
// Se a chave ainda nao foi gerada, cria a linha do bracket (plan-first:
// a federacao configura a regra ANTES do sorteio).
// ═══════════════════════════════════════════════════════════════
router.patch(
  '/competitions/:cid/categories/:catId/bracket/phase-plan',
  ...guards.staffWrite(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const plan = (req.body && req.body.phase_plan) || {};

    const pv = phasePlanSvc.validatePhasePlan(plan);
    if (!pv.ok) {
      return res.status(422).json({ error: pv.error, code: 'VALIDATION_ERROR' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' }); }
      const cat = await findCat(client, cid, catId);
      if (!cat) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoria não encontrada', code: 'NOT_FOUND' }); }

      let row;
      try {
        const up = await client.query(
          `INSERT INTO karate_brackets (competition_id, category_id, modality, status, phase_plan, created_by)
           VALUES ($1,$2,$3,'draft',$4::jsonb,$5)
           ON CONFLICT (competition_id, category_id)
           DO UPDATE SET phase_plan = $4::jsonb, updated_at = NOW()
           RETURNING id, status, phase_plan`,
          [cid, catId, cat.modality, JSON.stringify(plan), req.user?.id || null]
        );
        row = up.rows[0];
      } catch (e) {
        await client.query('ROLLBACK');
        if (e.code === '42P01') {
          return res.status(503).json({ error: 'Migration 183 não aplicada ainda', code: 'SCHEMA_PENDING' });
        }
        if (e.code === '42703') {
          return res.status(503).json({ error: 'Plano de fases indisponível (migração 296 pendente)', code: 'SCHEMA_PENDING' });
        }
        throw e;
      }

      await client.query('COMMIT');
      return res.json({ bracket_id: row.id, status: row.status, phase_plan: row.phase_plan });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      console.error('[karateBrackets] phase-plan error:', err.message);
      return res.status(500).json({ error: 'Erro ao salvar plano de fases' });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// GET /competitions/:cid/categories/:catId/kata-scores
// Lê notas da kata (ambas as fases).
// ═══════════════════════════════════════════════════════════════
const kataScoresGetHandler = async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const client = await db.connect();
    try {
      const comp = await findComp(client, federationId, cid);
      if (!comp) return res.status(404).json({ error: 'Competição não encontrada' });

      let rows = [];
      // `notas` (individuais dos árbitros) é da 303 — fallback 42703.
      const kataGetSql = (withNotas) =>
        `SELECT ks.entry_id, ks.phase, ks.nota, ${withNotas ? 'ks.notas,' : 'NULL AS notas,'}
                ks.presentation_order, ks.advances,
                cu.name AS student_name,
                COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
         FROM karate_kata_scores ks
         JOIN karate_brackets kb ON kb.id = ks.bracket_id
         JOIN karate_competition_entries e ON e.id = ks.entry_id
         JOIN customers cu ON cu.id = e.student_id
         LEFT JOIN companies dj ON dj.id = e.dojo_id
         WHERE kb.category_id = $1
         ORDER BY ks.phase ASC, ks.presentation_order ASC NULLS LAST, ks.nota DESC NULLS LAST`;
      try {
        try {
          rows = (await client.query(kataGetSql(true), [catId])).rows;
        } catch (e303) {
          if (e303.code !== '42703') throw e303;
          rows = (await client.query(kataGetSql(false), [catId])).rows;
        }
      } catch (e) {
        if (e.code !== '42P01') throw e;
      }

      res.json(rows.map(r => ({
        entry_id: r.entry_id,
        student_name: r.student_name,
        dojo_name: r.dojo_name,
        phase: r.phase,
        nota: r.nota !== null ? parseFloat(r.nota) : null,
        notas: r.notas || null,
        presentation_order: r.presentation_order,
        advances: r.advances,
      })));
    } catch (err) {
      console.error('[karateBrackets] kata-scores get error:', err.message);
      res.status(500).json({ error: 'Erro ao carregar notas' });
    } finally {
      client.release();
    }
  };
router.get('/competitions/:cid/categories/:catId/kata-scores', ...guards.read(), kataScoresGetHandler);

// ═══════════════════════════════════════════════════════════════
// PUT /competitions/:cid/categories/:catId/kata-scores
// Salva nota de um atleta numa fase.
// Body: { entry_id, phase, nota }
// ═══════════════════════════════════════════════════════════════
const kataScorePutHandler = async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const { entry_id: entryId, phase, nota, notas } = req.body;

    if (!entryId || !phase || (nota === undefined || nota === null) && !notas) {
      return res.status(422).json({ error: 'entry_id, phase e nota (ou notas[]) são obrigatórios', code: 'VALIDATION_ERROR' });
    }
    if (!['eliminatoria', 'final'].includes(phase)) {
      return res.status(422).json({ error: 'phase deve ser eliminatoria ou final', code: 'VALIDATION_ERROR' });
    }
    // Regra real (5 notas, uma por árbitro): total = soma cortando a maior
    // e a menor; as notas individuais ficam guardadas para o desempate.
    // `nota` sozinha segue aceita (legado / bandeirada convertida).
    let notaNum;
    let notasArr = null;
    if (notas !== undefined && notas !== null) {
      notasArr = kataScoring.normalizeNotas(notas);
      if (!notasArr) {
        return res.status(422).json({ error: 'notas deve ser um array de 3 a 7 números entre 0 e 10 (padrão: 5 árbitros)', code: 'VALIDATION_ERROR' });
      }
      notaNum = kataScoring.computeKataTotals(notasArr).total;
    } else {
      notaNum = parseFloat(nota);
      if (isNaN(notaNum) || notaNum < 0 || notaNum > 30) {
        return res.status(422).json({ error: 'nota deve ser número entre 0 e 30', code: 'VALIDATION_ERROR' });
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada' }); }

      const { bracketRow } = await loadBracket(client, catId);
      if (!bracketRow) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Chave não gerada ainda' }); }
      if (bracketRow.status !== 'locked') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Chave deve estar travada para lançar notas', code: 'CONFLICT' }); }

      let updated;
      const notasJson = notasArr ? JSON.stringify(notasArr) : null;
      const upsert = async (withNotas) => {
        const setNotas = withNotas ? ', notas=$5' : '';
        const params = [notaNum, bracketRow.id, entryId, phase];
        if (withNotas) params.push(notasJson);
        const r = await client.query(
          `UPDATE karate_kata_scores SET nota=$1, updated_at=NOW()${setNotas}
           WHERE bracket_id=$2 AND entry_id=$3 AND phase=$4
           RETURNING entry_id, phase, nota, presentation_order, advances`,
          params
        );
        if (r.rows.length) return r.rows[0];
        // Insert if missing (can happen for 'final' phase created on advance)
        const insCols = withNotas ? ', notas' : '';
        const insVals = withNotas ? ',$5' : '';
        const insSet = withNotas ? ', notas=$5' : '';
        const ins = await client.query(
          `INSERT INTO karate_kata_scores (bracket_id, entry_id, phase, nota${insCols})
           VALUES ($2,$3,$4,$1${insVals})
           ON CONFLICT (bracket_id, entry_id, phase) DO UPDATE SET nota=$1, updated_at=NOW()${insSet}
           RETURNING entry_id, phase, nota, presentation_order, advances`,
          params
        );
        return ins.rows[0];
      };
      try {
        try {
          updated = await upsert(true);
        } catch (e303) {
          if (e303.code !== '42703') throw e303;
          // Coluna notas ausente (303 pendente): grava só o total.
          updated = await upsert(false);
          notasArr = null;
        }
      } catch (e) {
        if (e.code === '42P01') { await client.query('ROLLBACK'); return res.status(503).json({ error: 'Migration 183 não aplicada' }); }
        throw e;
      }

      await client.query('COMMIT');
      res.json({
        entry_id: updated.entry_id, phase: updated.phase,
        nota: parseFloat(updated.nota), notas: notasArr,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] kata-score put error:', err.message);
      res.status(500).json({ error: 'Erro ao salvar nota' });
    } finally {
      client.release();
    }
  };
router.put('/competitions/:cid/categories/:catId/kata-scores', ...guards.staffWrite(), kataScorePutHandler);

// ═══════════════════════════════════════════════════════════════
// POST /competitions/:cid/categories/:catId/kata-scores/generate-order
// Sorteia ordem de apresentação da eliminatória.
// ═══════════════════════════════════════════════════════════════
router.post(
  '/competitions/:cid/categories/:catId/kata-scores/generate-order',
  ...guards.staffWrite(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const { seed } = req.body;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada' }); }

      const athletes = await loadEntries(client, catId, federationId);
      const pendingPaymentCount = await countPendingPayment(client, cid, catId);
      if (athletes.length < 2) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Mínimo de 2 atletas' }); }

      const drawSeed = seed !== undefined ? String(seed) : String(Date.now());
      const ordered = generateKataOrder(athletes, drawSeed);

      const { bracketRow } = await loadBracket(client, catId);
      if (!bracketRow) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Gere o bracket da categoria antes de sortear a ordem' }); }

      try {
        for (let i = 0; i < ordered.length; i++) {
          await client.query(
            `UPDATE karate_kata_scores SET presentation_order=$1, updated_at=NOW()
             WHERE bracket_id=$2 AND entry_id=$3 AND phase='eliminatoria'`,
            [i + 1, bracketRow.id, ordered[i].id]
          );
        }
      } catch (e) {
        if (e.code === '42P01') { await client.query('ROLLBACK'); return res.status(503).json({ error: 'Migration 183 não aplicada' }); }
        throw e;
      }

      await client.query('COMMIT');
      res.json({
        seed: drawSeed,
        presentation_order: ordered.map((a, i) => ({ entry_id: a.id, student_name: a.student_name, order: i + 1 })),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] generate-order error:', err.message);
      res.status(500).json({ error: 'Erro ao sortear ordem' });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// POST /competitions/:cid/categories/:catId/kata-scores/advance
// Avança os N melhores da eliminatória para a final.
// Body: { advance_count } — default 8
// ═══════════════════════════════════════════════════════════════
const kataAdvanceHandler = async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const advanceCount = parseInt(req.body.advance_count, 10) || 8;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada' }); }

      const { bracketRow } = await loadBracket(client, catId);
      if (!bracketRow) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Chave não gerada' }); }
      if (bracketRow.status !== 'locked') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Chave deve estar travada' }); }

      // Notas da eliminatória — a ORDEM vem da cascata real de desempate
      // (total cortado → +menor → +maior); `notas` é da 303 (42703-safe).
      let elimRows;
      try {
        try {
          elimRows = (await client.query(
            `SELECT entry_id, nota, notas FROM karate_kata_scores
             WHERE bracket_id=$1 AND phase='eliminatoria'`,
            [bracketRow.id]
          )).rows;
        } catch (e303) {
          if (e303.code !== '42703') throw e303;
          elimRows = (await client.query(
            `SELECT entry_id, nota, NULL AS notas FROM karate_kata_scores
             WHERE bracket_id=$1 AND phase='eliminatoria'`,
            [bracketRow.id]
          )).rows;
        }
      } catch (e) {
        if (e.code === '42P01') { await client.query('ROLLBACK'); return res.status(503).json({ error: 'Migration 183 não aplicada' }); }
        throw e;
      }

      if (elimRows.some(r => r.nota === null)) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'Todos os atletas devem ter nota da eliminatória antes de avançar', code: 'VALIDATION_ERROR' });
      }

      elimRows = elimRows
        .map((r) => ({ ...r, nota: parseFloat(r.nota) }))
        .sort(kataScoring.compareKata);

      const n = Math.min(advanceCount, elimRows.length);
      const advancing = elimRows.slice(0, n);
      const eliminated = elimRows.slice(n);

      // EMPATE PERSISTENTE cruzando a linha de corte → novo kata (decisão
      // humana). O avanço acontece mesmo assim (nunca bloqueia); a mesa
      // recebe os envolvidos para refazer a apresentação e re-lançar.
      let tieBreakNeeded = [];
      if (eliminated.length > 0 && n > 0
          && kataScoring.compareKata(advancing[n - 1], eliminated[0]) === 0) {
        const boundary = [advancing[n - 1], eliminated[0]];
        for (let i = n - 2; i >= 0 && kataScoring.compareKata(advancing[i], advancing[n - 1]) === 0; i--) boundary.unshift(advancing[i]);
        for (let i = 1; i < eliminated.length && kataScoring.compareKata(eliminated[0], eliminated[i]) === 0; i++) boundary.push(eliminated[i]);
        tieBreakNeeded = boundary.map((r) => r.entry_id);
      }

      // Mark advances
      for (const row of advancing) {
        await client.query(
          `UPDATE karate_kata_scores SET advances=true WHERE bracket_id=$1 AND entry_id=$2 AND phase='eliminatoria'`,
          [bracketRow.id, row.entry_id]
        );
        // Create final score row
        await client.query(
          `INSERT INTO karate_kata_scores (bracket_id, entry_id, phase)
           VALUES ($1,$2,'final')
           ON CONFLICT (bracket_id, entry_id, phase) DO NOTHING`,
          [bracketRow.id, row.entry_id]
        );
      }
      for (const row of eliminated) {
        await client.query(
          `UPDATE karate_kata_scores SET advances=false WHERE bracket_id=$1 AND entry_id=$2 AND phase='eliminatoria'`,
          [bracketRow.id, row.entry_id]
        );
      }

      await client.query('COMMIT');
      res.json({
        advanced: n,
        eliminated: elimRows.length - n,
        advancing_entry_ids: advancing.map(r => r.entry_id),
        tie_break_needed: tieBreakNeeded,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] kata advance error:', err.message);
      res.status(500).json({ error: 'Erro ao avançar atletas' });
    } finally {
      client.release();
    }
  };
router.post('/competitions/:cid/categories/:catId/kata-scores/advance', ...guards.staffWrite(), kataAdvanceHandler);

// ═══════════════════════════════════════════════════════════════
// PUT /competitions/:cid/categories/:catId/kata-scores/order
// Salva reordenação manual (drag-and-drop) da ordem de apresentação
// de uma fase inteira.
// Body: { phase: "eliminatoria" | "final", order: [{ entry_id, presentation_order }, ...] }
// ═══════════════════════════════════════════════════════════════
router.put(
  '/competitions/:cid/categories/:catId/kata-scores/order',
  ...guards.staffWrite(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const { phase, order } = req.body;

    if (!phase || !['eliminatoria', 'final'].includes(phase)) {
      return res.status(422).json({ error: 'phase deve ser eliminatoria ou final', code: 'VALIDATION_ERROR' });
    }
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(422).json({ error: 'order é obrigatório e deve ser uma lista', code: 'VALIDATION_ERROR' });
    }
    for (const item of order) {
      if (!item || !item.entry_id || item.presentation_order === undefined || item.presentation_order === null) {
        return res.status(422).json({ error: 'cada item de order precisa de entry_id e presentation_order', code: 'VALIDATION_ERROR' });
      }
      const posNum = parseInt(item.presentation_order, 10);
      if (isNaN(posNum) || posNum < 1) {
        return res.status(422).json({ error: 'presentation_order deve ser inteiro positivo', code: 'VALIDATION_ERROR' });
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada' }); }

      const { bracketRow } = await loadBracket(client, catId);
      if (!bracketRow) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Chave não gerada ainda' }); }
      if (bracketRow.status !== 'locked') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Chave deve estar travada para reordenar', code: 'CONFLICT' }); }

      try {
        // valida que cada entry_id pertence a esse bracket/categoria/fase antes de gravar
        const entryIds = order.map(o => o.entry_id);
        const belongCheck = await client.query(
          `SELECT entry_id FROM karate_kata_scores WHERE bracket_id=$1 AND phase=$2 AND entry_id = ANY($3::uuid[])`,
          [bracketRow.id, phase, entryIds]
        );
        const belongingIds = new Set(belongCheck.rows.map(r => r.entry_id));
        const invalid = entryIds.filter(id => !belongingIds.has(id));
        if (invalid.length) {
          await client.query('ROLLBACK');
          return res.status(422).json({ error: 'Um ou mais entry_id não pertencem a esta chave/fase', code: 'VALIDATION_ERROR', invalid_entry_ids: invalid });
        }

        for (const item of order) {
          const posNum = parseInt(item.presentation_order, 10);
          await client.query(
            `UPDATE karate_kata_scores SET presentation_order=$1, updated_at=NOW()
             WHERE bracket_id=$2 AND entry_id=$3 AND phase=$4`,
            [posNum, bracketRow.id, item.entry_id, phase]
          );
        }
      } catch (e) {
        if (e.code === '42703' || e.code === '42P01') {
          await client.query('ROLLBACK');
          return res.status(503).json({ error: 'Migration 183 não aplicada' });
        }
        throw e;
      }

      let rows = [];
      try {
        const r = await client.query(
          `SELECT ks.entry_id, ks.phase, ks.nota, ks.presentation_order, ks.advances,
                  cu.name AS student_name,
                  COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
           FROM karate_kata_scores ks
           JOIN karate_brackets kb ON kb.id = ks.bracket_id
           JOIN karate_competition_entries e ON e.id = ks.entry_id
           JOIN customers cu ON cu.id = e.student_id
           LEFT JOIN companies dj ON dj.id = e.dojo_id
           WHERE kb.category_id = $1 AND ks.phase = $2
           ORDER BY ks.presentation_order ASC NULLS LAST, ks.nota DESC NULLS LAST`,
          [catId, phase]
        );
        rows = r.rows;
      } catch (e) {
        if (e.code !== '42703' && e.code !== '42P01') throw e;
      }

      await client.query('COMMIT');
      res.json(rows.map(r => ({
        entry_id: r.entry_id,
        student_name: r.student_name,
        dojo_name: r.dojo_name,
        phase: r.phase,
        nota: r.nota !== null ? parseFloat(r.nota) : null,
        presentation_order: r.presentation_order,
        advances: r.advances,
      })));
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] kata-scores order put error:', err.message);
      res.status(500).json({ error: 'Erro ao salvar ordem' });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// GET /competitions/:cid/categories/:catId/scoresheet — SÚMULA (P1)
//
// Todos os dados da súmula real num payload só (a impressão é do FE):
//   cabeçalho (competição/categoria/divisão/grupo/KOTO), inscritos,
//   rodadas com FORMATO da fase (phase_plan) e decisão registrada,
//   rodapé de regras (desempate encadeado, kata exigido, premiação,
//   "não tem disputa de 3º lugar") e os campos preenchidos à mão no
//   ginásio (shuchin, mesário, duração) — ver as súmulas reais do
//   Dossiê Shiai (KATA MASC ATÉ 7 ANOS / Kata Master II).
// ═══════════════════════════════════════════════════════════════
function roundLabelFor(index, totalRounds) {
  const remaining = totalRounds - index;
  if (remaining === 1) return 'Final';
  if (remaining === 2) return 'Semifinal';
  if (remaining === 3) return 'Quartas de final';
  if (remaining === 4) return 'Oitavas de final';
  return `${index + 1}ª rodada`;
}

const scoresheetHandler = async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const client = await db.connect();
    try {
      const compRes = await client.query(
        `SELECT id, name, season, event_date, location
           FROM karate_competitions
          WHERE id = $1 AND federation_id = $2 LIMIT 1`,
        [cid, federationId]
      );
      if (!compRes.rows.length) {
        return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
      }
      const comp = compRes.rows[0];

      // Categoria + divisão/grupo + koto (colunas 294/297 podem faltar).
      let cat;
      try {
        const c = await client.query(
          `SELECT cat.id, cat.name, cat.modality, cat.group_label,
                  d.name AS division_name,
                  a.name AS area_name
             FROM karate_competition_categories cat
             LEFT JOIN karate_competition_divisions d ON d.id = cat.division_id
             LEFT JOIN karate_competition_areas a ON a.id = cat.area_id
            WHERE cat.id = $1 AND cat.competition_id = $2 LIMIT 1`,
          [catId, cid]
        );
        cat = c.rows[0];
      } catch (e) {
        if (e.code !== '42703' && e.code !== '42P01') throw e;
        const c = await client.query(
          `SELECT id, name, modality FROM karate_competition_categories
            WHERE id = $1 AND competition_id = $2 LIMIT 1`,
          [catId, cid]
        );
        cat = c.rows[0] ? Object.assign({}, c.rows[0], { group_label: null, division_name: null, area_name: null }) : undefined;
      }
      if (!cat) return res.status(404).json({ error: 'Categoria não encontrada', code: 'NOT_FOUND' });

      const athletes = await loadEntries(client, catId, federationId);
      const { bracketRow, matchRows } = await loadBracket(client, catId);

      const plan = (bracketRow && bracketRow.phase_plan) || {};
      const tiebreakLabels = Array.isArray(plan.tiebreak)
        ? plan.tiebreak.map((t) => phasePlanSvc.DECISION_LABEL[t] || t)
        : [];
      const prizePlaces = plan.prize_places != null ? plan.prize_places : 4;
      const thirdDispute = plan.third_place_dispute === true
        || !!(bracketRow && bracketRow.options && bracketRow.options.thirdPlace);
      const rulesFooter = {
        tiebreak: tiebreakLabels,
        required_kata: plan.required_kata || null,
        prize_places: prizePlaces,
        third_place_dispute: thirdDispute,
        // O aviso literal das súmulas reais quando não há disputa de 3º.
        third_place_note: thirdDispute ? null : 'NÃO TEM DISPUTA DE 3º LUGAR — dois 3ºs lugares',
        notes: plan.notes || null,
      };

      const base = {
        competition: { id: comp.id, name: comp.name, season: comp.season, event_date: comp.event_date, location: comp.location || null },
        category: {
          id: cat.id, name: cat.name, modality: cat.modality,
          division_name: cat.division_name || null, group_label: cat.group_label || null,
        },
        area: cat.area_name ? { name: cat.area_name } : null,
        athletes: athletes.map((a) => ({ entry_id: a.id, name: a.student_name, dojo_name: a.dojo || null, is_team: !!a.team_id })),
        rules_footer: rulesFooter,
        // Campos da folha real — GRAVÁVEIS desde a 304 (PATCH .../scoresheet,
        // inclusive pela mesa pública); sem valor, a UI imprime linha em branco.
        fields: {
          koto: cat.area_name || null,
          shuchin: (bracketRow && bracketRow.sumula && bracketRow.sumula.shuchin) || null,
          mesario: (bracketRow && bracketRow.sumula && bracketRow.sumula.mesario) || null,
          duracao: (bracketRow && bracketRow.sumula && bracketRow.sumula.duracao) || null,
        },
      };

      if (!bracketRow) {
        return res.json(Object.assign(base, { bracket: { status: 'not_generated' } }));
      }

      const isScoreKata = ['kata', 'team_kata'].includes(bracketRow.modality)
        && bracketRow.kata_mode !== 'hantei_tree';
      if (isScoreKata) {
        let scores = [];
        // `notas` (individuais dos árbitros, 303) entra na súmula impressa
        // com os extremos riscados — fallback 42703 mantém só o total.
        const scoresheetKataSql = (withNotas) =>
          `SELECT ks.entry_id, ks.phase, ks.nota, ${withNotas ? 'ks.notas,' : 'NULL AS notas,'}
                  ks.presentation_order, ks.advances
             FROM karate_kata_scores ks
            WHERE ks.bracket_id = $1
            ORDER BY ks.phase ASC, ks.presentation_order ASC NULLS LAST`;
        try {
          try {
            scores = (await client.query(scoresheetKataSql(true), [bracketRow.id])).rows;
          } catch (e303) {
            if (e303.code !== '42703') throw e303;
            scores = (await client.query(scoresheetKataSql(false), [bracketRow.id])).rows;
          }
        } catch (e) {
          if (e.code !== '42P01') throw e;
        }
        const nameById = new Map(athletes.map((a) => [a.id, a]));
        return res.json(Object.assign(base, {
          bracket: { status: bracketRow.status, kata_mode: 'score_rounds' },
          kata_scores: scores.map((k) => ({
            entry_id: k.entry_id,
            name: (nameById.get(k.entry_id) || {}).student_name || null,
            dojo_name: (nameById.get(k.entry_id) || {}).dojo || null,
            phase: k.phase,
            nota: k.nota !== null ? parseFloat(k.nota) : null,
            notas: k.notas || null,
            presentation_order: k.presentation_order,
            advances: k.advances,
          })),
        }));
      }

      // Árvore (kumite ou kata hantei_tree): rodadas com fase resolvida.
      const state = rowsToState(matchRows, bracketRow, athletes);
      const metaMap = buildScoreMap(matchRows);
      const totalRounds = state.rounds.length;
      const nameById = new Map(athletes.map((a) => [a.id, a]));
      const side = (id) => {
        if (id === 'bye') return 'bye';
        if (!id) return null;
        const a = nameById.get(id);
        return { entry_id: id, name: a ? a.student_name : null, dojo_name: a ? (a.dojo || null) : null };
      };
      const serialize = (m, key) => {
        const meta = metaMap[key] || {};
        return {
          id: key,
          aka: side(m.akaId),
          shiro: side(m.shiroId),
          winner_entry_id: m.winnerId || null,
          aka_score: meta.aka_score != null ? meta.aka_score : null,
          shiro_score: meta.shiro_score != null ? meta.shiro_score : null,
          decision: meta.decision || null,
          match_format: meta.match_format || null,
        };
      };
      const rounds = state.rounds.map((round, i) => {
        const phase = phasePlanSvc.resolvePhaseForRound(plan, i, totalRounds, false);
        return {
          round: i,
          label: roundLabelFor(i, totalRounds),
          format: phase ? phase.format : null,
          format_label: phase ? (phasePlanSvc.FORMAT_LABEL[phase.format] || phase.format) : null,
          duration_sec: phase && phase.duration_sec != null ? phase.duration_sec : null,
          time_mode: phase ? (phase.time_mode || null) : null,
          matches: round.map((m) => serialize(m, m.id)),
        };
      });
      const finalPhase = totalRounds
        ? phasePlanSvc.resolvePhaseForRound(plan, totalRounds - 1, totalRounds, true)
        : null;
      const champion = totalRounds && state.rounds[totalRounds - 1][0]
        ? state.rounds[totalRounds - 1][0].winnerId : null;

      return res.json(Object.assign(base, {
        bracket: {
          status: bracketRow.status,
          kata_mode: bracketRow.kata_mode || null,
          rounds_count: totalRounds,
        },
        rounds,
        third_place_match: state.thirdPlaceMatch
          ? Object.assign(serialize(state.thirdPlaceMatch, 'third'), {
              format: finalPhase ? finalPhase.format : null,
              format_label: finalPhase ? (phasePlanSvc.FORMAT_LABEL[finalPhase.format] || finalPhase.format) : null,
            })
          : null,
        champion: champion ? side(champion) : null,
      }));
    } catch (err) {
      console.error('[karateBrackets] scoresheet error:', err.message);
      return res.status(500).json({ error: 'Erro ao montar a súmula' });
    } finally {
      client.release();
    }
  };
router.get('/competitions/:cid/categories/:catId/scoresheet', ...guards.read(), scoresheetHandler);

// ═══════════════════════════════════════════════════════════════
// PATCH /competitions/:cid/categories/:catId/scoresheet — SÚMULA
// GRAVÁVEL (Onda B, migration 304). Body: { shuchin?, mesario?,
// duracao? } — merge parcial no JSONB da chave; string vazia limpa o
// campo. Compartilhado com a mesa pública (o mesário preenche os
// campos que na folha real eram manuscritos).
// ═══════════════════════════════════════════════════════════════
const scoresheetPatchHandler = async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const b = req.body || {};
    const patch = {};
    for (const k of ['shuchin', 'mesario', 'duracao']) {
      if (b[k] !== undefined) {
        if (b[k] !== null && typeof b[k] !== 'string') {
          return res.status(422).json({ error: `${k} deve ser texto`, code: 'VALIDATION_ERROR' });
        }
        const v = b[k] === null ? '' : String(b[k]).trim().slice(0, 120);
        patch[k] = v === '' ? null : v;
      }
    }
    if (!Object.keys(patch).length) {
      return res.status(422).json({ error: 'Informe shuchin, mesario e/ou duracao', code: 'VALIDATION_ERROR' });
    }

    const client = await db.connect();
    try {
      const comp = await findComp(client, federationId, cid);
      if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
      const { bracketRow } = await loadBracket(client, catId);
      if (!bracketRow) return res.status(409).json({ error: 'Chave não gerada para esta categoria', code: 'NO_BRACKET' });

      const merged = Object.assign({}, bracketRow.sumula || {}, patch);
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      try {
        await client.query(
          `UPDATE karate_brackets SET sumula = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(merged), bracketRow.id]
        );
      } catch (e) {
        if (e.code === '42703') {
          return res.status(503).json({ error: 'Súmula gravável indisponível (migração 304 pendente)', code: 'SCHEMA_PENDING' });
        }
        throw e;
      }
      return res.json({ sumula: merged });
    } catch (err) {
      console.error('[karateBrackets] scoresheet patch error:', err.message);
      return res.status(500).json({ error: 'Erro ao gravar a súmula' });
    } finally {
      client.release();
    }
  };
router.patch('/competitions/:cid/categories/:catId/scoresheet', ...guards.staffWrite(), scoresheetPatchHandler);

module.exports = router;

// P2.1 — handlers compartilhados com a MESA pública do mesário
// (src/routes/karateMesaPublic.js). O router da mesa autentica pelo token
// opaco (karateMesaTokenService), injeta req.params.id/cid resolvidos do
// token e delega para estes handlers — uma única fonte de verdade para a
// lógica de chave/nota; NUNCA exportar handlers de montagem (generate/
// lock/unlock/reset/matches/phase-plan): montagem é ato da federação.
module.exports.sharedHandlers = {
  getBracketHandler,
  advanceHandler,
  finalizeHandler,
  kataScoresGetHandler,
  kataScorePutHandler,
  kataAdvanceHandler,
  scoresheetHandler,
  scoresheetPatchHandler,
};
