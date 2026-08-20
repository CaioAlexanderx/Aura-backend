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
} = require('../services/karateBracket');

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
  let scoresSupported = true;
  for (const m of matchRowsData) {
    const key = m.bracket_kind === 'third' ? 'third' : `r${m.round}-${m.slot}`;
    const scores = (scoreMap && scoreMap[key]) || { aka_score: null, shiro_score: null };

    if (scoresSupported) {
      try {
        await client.query(
          `INSERT INTO karate_bracket_matches
             (bracket_id, round, slot, bracket_kind, aka_entry_id, shiro_entry_id, winner_entry_id, is_bye, aka_score, shiro_score)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [m.bracket_id, m.round, m.slot, m.bracket_kind,
           m.aka_entry_id || null, m.shiro_entry_id || null, m.winner_entry_id || null, m.is_bye,
           scores.aka_score, scores.shiro_score]
        );
        continue;
      } catch (e) {
        if (e.code === '42703') {
          scoresSupported = false; // migration 210 ainda não aplicada — cai no fallback abaixo
        } else {
          throw e;
        }
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
    };
  }
  return map;
}

// ── helper: monta o BracketState serializado (shape retornado por GET,
// PUT /matches, POST /reset, e reaproveitado no /advance) para kumite. ──
function buildKumiteBracketState(bracketRow, matchRows, athletes, pendingPaymentCount) {
  const state = rowsToState(matchRows, bracketRow, athletes);
  const scoreMap = buildScoreMap(matchRows);

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
    seed: bracketRow.draw_seed,
    options: bracketRow.options,
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

  const hasScoreFields = Object.prototype.hasOwnProperty.call(patch, 'aka_score') ||
    Object.prototype.hasOwnProperty.call(patch, 'shiro_score');

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

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const comp = await findComp(client, federationId, cid);
      if (!comp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' }); }

      const cat = await findCat(client, cid, catId);
      if (!cat) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoria não encontrada', code: 'NOT_FOUND' }); }

      // Kata: handle separately — generate presentation order only
      const isKata = ['kata', 'team_kata'].includes(cat.modality);

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
// GET /competitions/:cid/categories/:catId/bracket
// Retorna o bracket completo (draft ou locked).
// ═══════════════════════════════════════════════════════════════
router.get(
  '/competitions/:cid/categories/:catId/bracket',
  ...guards.read(),
  async (req, res) => {
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

      // For kata: return scores instead
      const isKata = ['kata', 'team_kata'].includes(bracketRow.modality);
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
  }
);

// ═══════════════════════════════════════════════════════════════
// POST /competitions/:cid/categories/:catId/bracket/advance
// Lança vencedor de uma partida e propaga pelo bracket.
// Body: { match_id, winner_entry_id, aka_score?, shiro_score? }
// aka_score/shiro_score são opcionais e retrocompatíveis: quando ausentes,
// comportamento idêntico ao anterior. Defensivo p/ coluna ausente (42703).
// Requires: bracket status = 'locked'
// ═══════════════════════════════════════════════════════════════
router.post(
  '/competitions/:cid/categories/:catId/bracket/advance',
  ...guards.staffWrite(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const { match_id: matchId, winner_entry_id: winnerId, aka_score: akaScore, shiro_score: shiroScore } = req.body;

    if (!matchId || !winnerId) {
      return res.status(422).json({ error: 'match_id e winner_entry_id são obrigatórios', code: 'VALIDATION_ERROR' });
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
      if (akaScore !== undefined || shiroScore !== undefined) {
        const existing = scoreMap[matchId] || { aka_score: null, shiro_score: null };
        scoreMap[matchId] = {
          aka_score: akaScore !== undefined ? akaScore : existing.aka_score,
          shiro_score: shiroScore !== undefined ? shiroScore : existing.shiro_score,
        };
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
  }
);

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

      try {
        await client.query(
          `UPDATE karate_bracket_matches
              SET winner_entry_id = NULL, aka_score = NULL, shiro_score = NULL, updated_at = NOW()
            WHERE bracket_id = $1`,
          [bracketRow.id]
        );
      } catch (e) {
        if (e.code === '42703') {
          // Migration 210 não aplicada — reseta só o vencedor
          await client.query(
            `UPDATE karate_bracket_matches SET winner_entry_id = NULL, updated_at = NOW() WHERE bracket_id = $1`,
            [bracketRow.id]
          );
        } else {
          throw e;
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
// GET /competitions/:cid/categories/:catId/kata-scores
// Lê notas da kata (ambas as fases).
// ═══════════════════════════════════════════════════════════════
router.get(
  '/competitions/:cid/categories/:catId/kata-scores',
  ...guards.read(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const client = await db.connect();
    try {
      const comp = await findComp(client, federationId, cid);
      if (!comp) return res.status(404).json({ error: 'Competição não encontrada' });

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
           WHERE kb.category_id = $1
           ORDER BY ks.phase ASC, ks.presentation_order ASC NULLS LAST, ks.nota DESC NULLS LAST`,
          [catId]
        );
        rows = r.rows;
      } catch (e) {
        if (e.code !== '42P01') throw e;
      }

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
      console.error('[karateBrackets] kata-scores get error:', err.message);
      res.status(500).json({ error: 'Erro ao carregar notas' });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// PUT /competitions/:cid/categories/:catId/kata-scores
// Salva nota de um atleta numa fase.
// Body: { entry_id, phase, nota }
// ═══════════════════════════════════════════════════════════════
router.put(
  '/competitions/:cid/categories/:catId/kata-scores',
  ...guards.staffWrite(),
  async (req, res) => {
    const { id: federationId, cid, catId } = req.params;
    const { entry_id: entryId, phase, nota } = req.body;

    if (!entryId || !phase || nota === undefined || nota === null) {
      return res.status(422).json({ error: 'entry_id, phase e nota são obrigatórios', code: 'VALIDATION_ERROR' });
    }
    if (!['eliminatoria', 'final'].includes(phase)) {
      return res.status(422).json({ error: 'phase deve ser eliminatoria ou final', code: 'VALIDATION_ERROR' });
    }
    const notaNum = parseFloat(nota);
    if (isNaN(notaNum) || notaNum < 0 || notaNum > 30) {
      return res.status(422).json({ error: 'nota deve ser número entre 0 e 30', code: 'VALIDATION_ERROR' });
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
      try {
        const r = await client.query(
          `UPDATE karate_kata_scores SET nota=$1, updated_at=NOW()
           WHERE bracket_id=$2 AND entry_id=$3 AND phase=$4
           RETURNING entry_id, phase, nota, presentation_order, advances`,
          [notaNum, bracketRow.id, entryId, phase]
        );
        if (!r.rows.length) {
          // Insert if missing (can happen for 'final' phase created on advance)
          const ins = await client.query(
            `INSERT INTO karate_kata_scores (bracket_id, entry_id, phase, nota)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (bracket_id, entry_id, phase) DO UPDATE SET nota=$4, updated_at=NOW()
             RETURNING entry_id, phase, nota, presentation_order, advances`,
            [bracketRow.id, entryId, phase, notaNum]
          );
          updated = ins.rows[0];
        } else {
          updated = r.rows[0];
        }
      } catch (e) {
        if (e.code === '42P01') { await client.query('ROLLBACK'); return res.status(503).json({ error: 'Migration 183 não aplicada' }); }
        throw e;
      }

      await client.query('COMMIT');
      res.json({ entry_id: updated.entry_id, phase: updated.phase, nota: parseFloat(updated.nota), updated_at: new Date().toISOString() });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] kata-score put error:', err.message);
      res.status(500).json({ error: 'Erro ao salvar nota' });
    } finally {
      client.release();
    }
  }
);

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
router.post(
  '/competitions/:cid/categories/:catId/kata-scores/advance',
  ...guards.staffWrite(),
  async (req, res) => {
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

      // Get eliminatória scores sorted by nota DESC
      let elimRows;
      try {
        const r = await client.query(
          `SELECT entry_id, nota FROM karate_kata_scores
           WHERE bracket_id=$1 AND phase='eliminatoria'
           ORDER BY nota DESC NULLS LAST`,
          [bracketRow.id]
        );
        elimRows = r.rows;
      } catch (e) {
        if (e.code === '42P01') { await client.query('ROLLBACK'); return res.status(503).json({ error: 'Migration 183 não aplicada' }); }
        throw e;
      }

      if (elimRows.some(r => r.nota === null)) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'Todos os atletas devem ter nota da eliminatória antes de avançar', code: 'VALIDATION_ERROR' });
      }

      const n = Math.min(advanceCount, elimRows.length);
      const advancing = elimRows.slice(0, n);
      const eliminated = elimRows.slice(n);

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
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateBrackets] kata advance error:', err.message);
      res.status(500).json({ error: 'Erro ao avançar atletas' });
    } finally {
      client.release();
    }
  }
);

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

module.exports = router;
