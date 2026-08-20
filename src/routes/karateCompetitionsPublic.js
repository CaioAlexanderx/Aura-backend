// ============================================================
// AURA KARATÊ — P0 Hub de Campeonatos: PÁGINAS PÚBLICAS
// Montado em /public/karate (SEM auth) — mesmo padrão de slug do
// karatePublicRanking.js (router separado, karatePublic.js intacto).
//
//   GET /:slug/competitions/:cid                      — cabeçalho público
//   GET /:slug/competitions/:cid/conference           — CONFERÊNCIA de
//       inscrições (só quando conference_published_at) — substitui o PDF
//       "INSCRIÇÕES PARA CONFERÊNCIA" que circulava por e-mail: inscritos
//       agrupados por divisão/categoria com nome, dojô e faixa.
//   GET /:slug/competitions/:cid/brackets             — índice de chaves
//       (só quando brackets_published_at)
//   GET /:slug/competitions/:cid/categories/:catId/bracket
//       — a CHAVE pública (kumite: árvore; kata: notas) — substitui o
//       PDF de chaves no WhatsApp ("cada associação imprime as suas").
//
// Gate de publicação: cada superfície só existe depois que a federação
// publica (karateCompetitionSetup POST /publish-*). Antes disso → 404
// PUBLICATION_PENDING (não vaza rascunho).
//
// Dados mínimos (LGPD): nome, dojô e faixa — nada de CPF/nascimento/
// contato. É exatamente o que a planilha pública real já expunha.
// ============================================================
'use strict';

const router = require('express').Router();
const db = require('../config/database');
const { rowsToState } = require('../services/karateBracket');

async function resolveFederation(slugOrId) {
  let fedId = null;
  const r = await db.query(
    `SELECT company_id FROM digital_channel_config WHERE slug = $1 LIMIT 1`,
    [slugOrId]
  );
  if (r.rows.length) fedId = r.rows[0].company_id;
  if (!fedId && /^[0-9a-fA-F-]{36}$/.test(slugOrId)) fedId = slugOrId;
  if (!fedId) return null;
  const c = await db.query(
    `SELECT id, COALESCE(trade_name, legal_name) AS name,
            COALESCE(karate_logo_url, logo_url) AS logo
     FROM companies WHERE id = $1 LIMIT 1`,
    [fedId]
  );
  return c.rows[0] || null;
}

// Competição pública com flags de publicação. 42703 (294 pendente) →
// trata como não publicado (superfícies fechadas), nunca 500.
async function loadPublicCompetition(fedId, cid) {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(cid))) return null;
  try {
    const { rows } = await db.query(
      `SELECT id, name, season, event_date, location, status,
              conference_published_at, brackets_published_at, rectification_deadline
         FROM karate_competitions
        WHERE id = $1 AND federation_id = $2
        LIMIT 1`,
      [cid, fedId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code !== '42703') throw e;
    const { rows } = await db.query(
      `SELECT id, name, season, event_date, location, status
         FROM karate_competitions WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [cid, fedId]
    );
    return rows[0]
      ? Object.assign({}, rows[0], { conference_published_at: null, brackets_published_at: null, rectification_deadline: null })
      : null;
  }
}

// ── GET /:slug/competitions/:cid — cabeçalho ────────────────
router.get('/:slug/competitions/:cid', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const comp = await loadPublicCompetition(fed.id, req.params.cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada' });
    return res.json({
      federation: { name: fed.name, logo: fed.logo },
      competition: {
        id: comp.id, name: comp.name, season: comp.season,
        event_date: comp.event_date, location: comp.location || null,
        status: comp.status,
        conference_published: !!comp.conference_published_at,
        brackets_published: !!comp.brackets_published_at,
        rectification_deadline: comp.rectification_deadline || null,
      },
    });
  } catch (err) {
    console.error('[karateCompetitionsPublic] header error:', err.message);
    return res.status(500).json({ error: 'Erro ao carregar competição' });
  }
});

// ── GET /:slug/competitions/:cid/conference ─────────────────
router.get('/:slug/competitions/:cid/conference', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const comp = await loadPublicCompetition(fed.id, req.params.cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada' });
    if (!comp.conference_published_at) {
      return res.status(404).json({
        error: 'A conferência de inscrições ainda não foi publicada pela federação.',
        code: 'PUBLICATION_PENDING',
      });
    }

    // Inscritos ativos com nome/dojô/faixa (+ equipe com membros), agrupados
    // por divisão → categoria. Colunas da 294 (team_id/division/group) podem
    // faltar num deploy parcial → forma reduzida.
    let rows;
    try {
      ({ rows } = await db.query(
        `SELECT e.id, e.category_id, e.student_id, e.team_id,
                cat.name AS category_name, cat.modality, cat.sex AS category_sex,
                cat.group_label, cat.division_id,
                d.name AS division_name,
                COALESCE(cu.name, t.name) AS display_name,
                COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
                cb.belt_name AS belt_name
           FROM karate_competition_entries e
           JOIN karate_competition_categories cat ON cat.id = e.category_id
           LEFT JOIN karate_competition_divisions d ON d.id = cat.division_id
           LEFT JOIN customers cu ON cu.id = e.student_id
           LEFT JOIN karate_competition_teams t ON t.id = e.team_id
           LEFT JOIN companies dj ON dj.id = e.dojo_id
           LEFT JOIN karate_current_belt cb
                  ON cb.student_id = e.student_id AND cb.federation_id = $2
          WHERE e.competition_id = $1 AND e.status NOT IN ('withdrawn')
          ORDER BY d.sort_order ASC NULLS LAST, cat.name ASC, COALESCE(cu.name, t.name) ASC`,
        [comp.id, fed.id]
      ));
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
      ({ rows } = await db.query(
        `SELECT e.id, e.category_id, e.student_id,
                cat.name AS category_name, cat.modality, cat.sex AS category_sex,
                cu.name AS display_name,
                COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
                cb.belt_name AS belt_name
           FROM karate_competition_entries e
           JOIN karate_competition_categories cat ON cat.id = e.category_id
           JOIN customers cu ON cu.id = e.student_id
           LEFT JOIN companies dj ON dj.id = e.dojo_id
           LEFT JOIN karate_current_belt cb
                  ON cb.student_id = e.student_id AND cb.federation_id = $2
          WHERE e.competition_id = $1 AND e.status NOT IN ('withdrawn')
          ORDER BY cat.name ASC, cu.name ASC`,
        [comp.id, fed.id]
      ));
      rows = rows.map((r) => Object.assign({}, r, {
        team_id: null, group_label: null, division_id: null, division_name: null,
      }));
    }

    // Membros das equipes listadas (nome público, sem PII extra).
    const teamIds = [...new Set(rows.filter((r) => r.team_id).map((r) => r.team_id))];
    const membersByTeam = {};
    if (teamIds.length) {
      try {
        const m = await db.query(
          `SELECT tm.team_id, tm.role, cu.name
             FROM karate_competition_team_members tm
             JOIN customers cu ON cu.id = tm.student_id
            WHERE tm.team_id = ANY($1::uuid[])
            ORDER BY tm.sort_order ASC`,
          [teamIds]
        );
        for (const r of m.rows) {
          (membersByTeam[r.team_id] = membersByTeam[r.team_id] || []).push({ name: r.name, role: r.role });
        }
      } catch (e) {
        if (e.code !== '42P01') throw e;
      }
    }

    // Agrupa divisão → categoria → inscritos.
    const byCategory = new Map();
    for (const r of rows) {
      if (!byCategory.has(r.category_id)) {
        byCategory.set(r.category_id, {
          category_id: r.category_id,
          category_name: r.category_name,
          modality: r.modality,
          sex: r.category_sex,
          group_label: r.group_label || null,
          division_name: r.division_name || null,
          entries: [],
        });
      }
      byCategory.get(r.category_id).entries.push({
        name: r.display_name,
        dojo_name: r.dojo_name || null,
        belt_name: r.belt_name || null,
        is_team: !!r.team_id,
        team_members: r.team_id ? (membersByTeam[r.team_id] || []) : undefined,
      });
    }

    return res.json({
      federation: { name: fed.name, logo: fed.logo },
      competition: { id: comp.id, name: comp.name, event_date: comp.event_date },
      published_at: comp.conference_published_at,
      rectification_deadline: comp.rectification_deadline || null,
      categories: [...byCategory.values()],
      total_entries: rows.length,
    });
  } catch (err) {
    console.error('[karateCompetitionsPublic] conference error:', err.message);
    return res.status(500).json({ error: 'Erro ao carregar conferência de inscrições' });
  }
});

// ── GET /:slug/competitions/:cid/brackets — índice ──────────
router.get('/:slug/competitions/:cid/brackets', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const comp = await loadPublicCompetition(fed.id, req.params.cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada' });
    if (!comp.brackets_published_at) {
      return res.status(404).json({
        error: 'As chaves ainda não foram publicadas pela federação.',
        code: 'PUBLICATION_PENDING',
      });
    }

    let rows = [];
    try {
      ({ rows } = await db.query(
        `SELECT cat.id AS category_id, cat.name AS category_name, cat.modality,
                cat.group_label, d.name AS division_name,
                b.id AS bracket_id, b.status AS bracket_status,
                COUNT(e.id)::int AS entry_count
           FROM karate_competition_categories cat
           LEFT JOIN karate_competition_divisions d ON d.id = cat.division_id
           LEFT JOIN karate_brackets b ON b.category_id = cat.id
           LEFT JOIN karate_competition_entries e
                  ON e.category_id = cat.id AND e.status NOT IN ('withdrawn')
          WHERE cat.competition_id = $1
          GROUP BY cat.id, d.name, d.sort_order, b.id, b.status
          ORDER BY d.sort_order ASC NULLS LAST, cat.name ASC`,
        [comp.id]
      ));
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
      ({ rows } = await db.query(
        `SELECT cat.id AS category_id, cat.name AS category_name, cat.modality,
                COUNT(e.id)::int AS entry_count
           FROM karate_competition_categories cat
           LEFT JOIN karate_competition_entries e
                  ON e.category_id = cat.id AND e.status NOT IN ('withdrawn')
          WHERE cat.competition_id = $1
          GROUP BY cat.id
          ORDER BY cat.name ASC`,
        [comp.id]
      ));
    }

    return res.json({
      federation: { name: fed.name, logo: fed.logo },
      competition: { id: comp.id, name: comp.name, event_date: comp.event_date },
      published_at: comp.brackets_published_at,
      categories: rows.map((r) => ({
        category_id: r.category_id,
        category_name: r.category_name,
        modality: r.modality,
        group_label: r.group_label || null,
        division_name: r.division_name || null,
        entry_count: r.entry_count,
        bracket_status: r.bracket_status || 'not_generated',
      })),
    });
  } catch (err) {
    console.error('[karateCompetitionsPublic] brackets index error:', err.message);
    return res.status(500).json({ error: 'Erro ao carregar chaves' });
  }
});

// ── GET /:slug/competitions/:cid/categories/:catId/bracket ──
// A chave pública. Kumite: árvore serializada (rounds → partidas com nomes,
// placar e vencedor) via rowsToState (serviço puro). Kata: notas por fase.
router.get('/:slug/competitions/:cid/categories/:catId/bracket', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const comp = await loadPublicCompetition(fed.id, req.params.cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada' });
    if (!comp.brackets_published_at) {
      return res.status(404).json({
        error: 'As chaves ainda não foram publicadas pela federação.',
        code: 'PUBLICATION_PENDING',
      });
    }
    const { catId } = req.params;
    if (!/^[0-9a-fA-F-]{36}$/.test(String(catId))) {
      return res.status(404).json({ error: 'Categoria não encontrada' });
    }
    const catRes = await db.query(
      `SELECT id, name, modality FROM karate_competition_categories
        WHERE id = $1 AND competition_id = $2 LIMIT 1`,
      [catId, comp.id]
    );
    if (!catRes.rows.length) return res.status(404).json({ error: 'Categoria não encontrada' });
    const category = catRes.rows[0];

    let bracketRow = null;
    let matchRows = [];
    try {
      const br = await db.query(`SELECT * FROM karate_brackets WHERE category_id = $1 LIMIT 1`, [catId]);
      if (br.rows.length) {
        bracketRow = br.rows[0];
        const mr = await db.query(
          `SELECT * FROM karate_bracket_matches WHERE bracket_id = $1 ORDER BY round ASC, slot ASC`,
          [bracketRow.id]
        );
        matchRows = mr.rows;
      }
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }
    if (!bracketRow) {
      return res.json({
        category: { id: category.id, name: category.name, modality: category.modality },
        status: 'not_generated',
      });
    }

    const isKata = ['kata', 'team_kata'].includes(bracketRow.modality);
    if (isKata) {
      let scores = [];
      try {
        const sc = await db.query(
          `SELECT ks.entry_id, ks.phase, ks.nota, ks.presentation_order, ks.advances,
                  COALESCE(cu.name, t.name) AS display_name,
                  COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
             FROM karate_kata_scores ks
             JOIN karate_competition_entries e ON e.id = ks.entry_id
             LEFT JOIN customers cu ON cu.id = e.student_id
             LEFT JOIN karate_competition_teams t ON t.id = e.team_id
             LEFT JOIN companies dj ON dj.id = e.dojo_id
            WHERE ks.bracket_id = $1
            ORDER BY ks.phase ASC, ks.presentation_order ASC NULLS LAST, ks.nota DESC NULLS LAST`,
          [bracketRow.id]
        );
        scores = sc.rows;
      } catch (e) {
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
      return res.json({
        category: { id: category.id, name: category.name, modality: category.modality },
        status: bracketRow.status,
        kata_scores: scores.map((s) => ({
          name: s.display_name,
          dojo_name: s.dojo_name || null,
          phase: s.phase,
          nota: s.nota !== null ? parseFloat(s.nota) : null,
          presentation_order: s.presentation_order,
          advances: s.advances,
        })),
      });
    }

    // Kumite: nomes dos participantes (atleta OU equipe) + árvore.
    let athletes = [];
    try {
      const ar = await db.query(
        `SELECT e.id, COALESCE(cu.name, t.name) AS name,
                COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
           FROM karate_competition_entries e
           LEFT JOIN customers cu ON cu.id = e.student_id
           LEFT JOIN karate_competition_teams t ON t.id = e.team_id
           LEFT JOIN companies dj ON dj.id = e.dojo_id
          WHERE e.category_id = $1 AND e.status NOT IN ('withdrawn')`,
        [catId]
      );
      athletes = ar.rows;
    } catch (e) {
      if (e.code !== '42703') throw e;
      const ar = await db.query(
        `SELECT e.id, cu.name, COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
           FROM karate_competition_entries e
           JOIN customers cu ON cu.id = e.student_id
           LEFT JOIN companies dj ON dj.id = e.dojo_id
          WHERE e.category_id = $1 AND e.status NOT IN ('withdrawn')`,
        [catId]
      );
      athletes = ar.rows;
    }
    const nameById = new Map(athletes.map((a) => [a.id, a]));
    const state = rowsToState(matchRows, bracketRow, athletes.map((a) => ({ id: a.id })));
    const scoreByKey = {};
    for (const m of matchRows) {
      const key = m.bracket_kind === 'third' ? 'third' : `r${m.round}-${m.slot}`;
      scoreByKey[key] = { aka: m.aka_score != null ? m.aka_score : null, shiro: m.shiro_score != null ? m.shiro_score : null };
    }
    const side = (id) => {
      if (id === 'bye') return 'bye';
      if (!id) return null;
      const a = nameById.get(id);
      return { entry_id: id, name: a ? a.name : null, dojo_name: a ? (a.dojo_name || null) : null };
    };
    const serialize = (m, key) => ({
      id: key,
      aka: side(m.akaId),
      shiro: side(m.shiroId),
      winner_entry_id: m.winnerId || null,
      aka_score: (scoreByKey[key] || {}).aka != null ? scoreByKey[key].aka : null,
      shiro_score: (scoreByKey[key] || {}).shiro != null ? scoreByKey[key].shiro : null,
    });
    const rounds = state.rounds.map((r) => r.map((m) => serialize(m, m.id)));
    const champion = state.rounds.length
      ? state.rounds[state.rounds.length - 1][0] && state.rounds[state.rounds.length - 1][0].winnerId
      : null;

    return res.json({
      category: { id: category.id, name: category.name, modality: category.modality },
      status: bracketRow.status,
      rounds,
      third_place_match: state.thirdPlaceMatch
        ? serialize(state.thirdPlaceMatch, 'third')
        : null,
      champion: champion ? side(champion) : null,
    });
  } catch (err) {
    console.error('[karateCompetitionsPublic] bracket error:', err.message);
    return res.status(500).json({ error: 'Erro ao carregar chave' });
  }
});

module.exports = router;
