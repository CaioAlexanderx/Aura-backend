// ============================================================
// AURA KARATÊ — Ranking público embeddável (Track E)
// Montado em /public/karate (SEM auth). Lê a view karate_competition_ranking_season.
//   GET /:slug/ranking?season=YYYY&category=...   — dados para o widget/iframe
//   GET /:slug/ranking/:season/:category          — atalho REST (path params)
//   GET /:slug/seasons                            — temporadas/categorias disponíveis
//
// É um router separado (mantém karatePublic.js intacto). Reaproveita o mesmo
// padrão de resolução de federação por slug do digital_channel_config.
// ============================================================
'use strict';

const router = require('express').Router();
const db = require('../config/database');

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

async function querySeasonRanking(fedId, season, category) {
  const conditions = ['federation_id = $1', 'season = $2'];
  const params = [fedId, season];
  let n = 3;
  if (category) { conditions.push(`category = $${n}`); params.push(category); n++; }
  const { rows } = await db.query(
    `SELECT category, student_id, student_name, karate_registration_number,
            dojo_name, total_points, gold, silver, bronze, events_participated
     FROM karate_competition_ranking_season
     WHERE ${conditions.join(' AND ')}
     ORDER BY category ASC, total_points DESC, gold DESC, silver DESC, bronze DESC`,
    params
  );
  return rows;
}

// ── GET /:slug/seasons ──
router.get('/:slug/seasons', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const { rows } = await db.query(
      `SELECT DISTINCT season, category
       FROM karate_competition_ranking_season
       WHERE federation_id = $1
       ORDER BY season DESC, category ASC`,
      [fed.id]
    );
    const seasons = {};
    for (const r of rows) {
      (seasons[r.season] = seasons[r.season] || []).push(r.category);
    }
    res.json({
      federation: { name: fed.name, logo: fed.logo },
      seasons: Object.entries(seasons).map(([season, categories]) => ({
        season: parseInt(season, 10), categories,
      })),
    });
  } catch (err) {
    console.error('[karatePublicRanking] seasons error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar temporadas' });
  }
});

// ── GET /:slug/ranking?season=&category= ──
router.get('/:slug/ranking', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const season = req.query.season ? parseInt(req.query.season, 10) : new Date().getFullYear();
    const category = req.query.category || null;
    const rows = await querySeasonRanking(fed.id, season, category);
    res.json({
      federation: { name: fed.name, logo: fed.logo },
      season, category,
      ranking: rows,
    });
  } catch (err) {
    console.error('[karatePublicRanking] ranking error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar ranking' });
  }
});

// ── GET /:slug/ranking/:season/:category ──
router.get('/:slug/ranking/:season/:category', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const season = parseInt(req.params.season, 10);
    if (isNaN(season)) return res.status(400).json({ error: 'season inválida' });
    const category = decodeURIComponent(req.params.category);
    const rows = await querySeasonRanking(fed.id, season, category);
    res.json({
      federation: { name: fed.name, logo: fed.logo },
      season, category,
      ranking: rows,
    });
  } catch (err) {
    console.error('[karatePublicRanking] ranking (path) error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar ranking' });
  }
});

module.exports = router;
