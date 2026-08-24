// ============================================================
// AURA KARATÊ — P2.1: MESA PÚBLICA do mesário (fora do shell)
// Montado em /public/karate/mesa (SEM auth Aura — token opaco por
// convocação; ver karateMesaTokenService).
//
// O mesário abre o link que a federação enviou e opera o SEU koto:
// chamada, vencedor/decisão, notas de kata, finalizar resultado, súmula.
// O servidor deriva TUDO do token (federação, competição, koto) — o
// cliente nunca escolhe o escopo. O area_id é relido A CADA request:
// a federação troca o mesário de koto e o acesso acompanha na hora.
//
// Endpoints:
//   GET  /me                                    — bootstrap: evento, oficial,
//        koto atual e a FILA de categorias do koto (status de cada chave)
//   GET  /categories/:catId/bracket             — chave completa
//   POST /categories/:catId/bracket/advance     — vencedor + decisão
//   POST /categories/:catId/bracket/finalize    — fecha resultado (pódio)
//   GET  /categories/:catId/kata-scores         — notas
//   PUT  /categories/:catId/kata-scores         — salva nota
//   POST /categories/:catId/kata-scores/advance — eliminatória → final
//   GET  /categories/:catId/scoresheet          — súmula
//
// Delegação: os handlers vêm de karateBrackets.sharedHandlers (uma única
// fonte de verdade). O middleware injeta req.params.id/cid resolvidos do
// token; :catId só passa se a categoria pertencer ao koto ATUAL do
// mesário (403 CATEGORIA_FORA_DO_KOTO). Montagem de chave (generate/lock/
// unlock/reset/matches/phase-plan) NÃO existe aqui — é ato da federação.
//
// Segurança: 401 SEMPRE genérico (não vaza se o token existe/foi revogado/
// schema pendente). Rate limit por token+IP (mesmo padrão do portal do
// dojô por link fixo).
// ============================================================
'use strict';

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const mesaTokenService = require('../services/karateMesaTokenService');
const { sharedHandlers } = require('./karateBrackets');

const GENERIC_401 = Object.freeze({
  error: 'Link de mesa inválido ou revogado',
  code: 'MESA_LINK_INVALID',
});

const isTestEnv = () => process.env.NODE_ENV === 'test';

// Chave de rate limit = sufixo do token + IP (não retém o token inteiro).
function keyByTokenAndIp(req) {
  const auth = req.headers['authorization'] || 'no-token';
  return `${auth.slice(-24)}:${req.ip || 'no-ip'}`;
}

const readLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 600, // dia de campeonato: polling da fila + chaves — teto folgado
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByTokenAndIp,
  skip: () => isTestEnv(),
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.', code: 'RATE_LIMITED' },
});

router.use(readLimiter);

// ── auth: Authorization: Bearer <token> → contexto da mesa ──────────
// Injeta req.mesa + req.params.id/cid (os handlers compartilhados leem
// req.params — funciona porque o middleware roda NA MESMA cadeia da rota,
// então o objeto params já foi montado pelo Express e persiste).
async function requireMesaToken(req, res, next) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    const mesa = await mesaTokenService.resolveToken(token);
    if (!mesa) return res.status(401).json(GENERIC_401);
    req.mesa = mesa;
    req.params.id = mesa.federation_id;
    req.params.cid = mesa.competition_id;
    return next();
  } catch (e) {
    console.error('[karateMesaPublic] resolveToken error:', e.message);
    return res.status(401).json(GENERIC_401);
  }
}

// ── escopo: :catId precisa ser do koto ATUAL do mesário ─────────────
// Mesário sem koto alocado não opera nenhuma categoria (409 explícito,
// para o front mostrar "aguarde a alocação" em vez de erro mudo).
async function requireCategoryInArea(req, res, next) {
  try {
    if (!req.mesa.area_id) {
      return res.status(409).json({
        error: 'Você ainda não está alocado a um koto. Peça à mesa central para te alocar.',
        code: 'MESARIO_SEM_KOTO',
      });
    }
    let cat = null;
    try {
      const { rows } = await db.query(
        `-- mesa:cat-scope
         SELECT id, area_id FROM karate_competition_categories
          WHERE id = $1 AND competition_id = $2
          LIMIT 1`,
        [req.params.catId, req.mesa.competition_id]
      );
      cat = rows[0] || null;
    } catch (e) {
      if (e.code !== '42703') throw e; // area_id ausente (297 pendente) → cat = null
    }
    if (!cat) {
      return res.status(404).json({ error: 'Categoria não encontrada', code: 'NOT_FOUND' });
    }
    if (String(cat.area_id) !== String(req.mesa.area_id)) {
      return res.status(403).json({
        error: 'Esta categoria não está no seu koto. Se ela acabou de ser movida, atualize a fila.',
        code: 'CATEGORIA_FORA_DO_KOTO',
      });
    }
    return next();
  } catch (e) {
    console.error('[karateMesaPublic] cat-scope error:', e.message);
    return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
  }
}

// ── GET /me — bootstrap da mesa ─────────────────────────────────────
// Evento + oficial + koto atual + FILA de categorias do koto (na ordem
// do board), cada uma com status da chave (not_generated/draft/locked/
// done) e kata_mode — o suficiente para a tela do mesário abrir direto
// na próxima categoria pendente.
router.get('/me', requireMesaToken, async (req, res) => {
  const m = req.mesa;
  try {
    let cats = [];
    if (m.area_id) {
      const catSql = (withArea) => `
        SELECT cat.id, cat.name, cat.modality, cat.group_label,
               ${withArea ? 'cat.area_order,' : 'NULL AS area_order,'}
               d.name AS division_name,
               b.status AS bracket_status, b.kata_mode,
               COUNT(e.id) FILTER (WHERE e.status NOT IN ('withdrawn'))::int AS entry_count
          FROM karate_competition_categories cat
          LEFT JOIN karate_competition_divisions d ON d.id = cat.division_id
          LEFT JOIN karate_brackets b ON b.category_id = cat.id
          LEFT JOIN karate_competition_entries e ON e.category_id = cat.id
         WHERE cat.competition_id = $1 AND cat.area_id = $2
         GROUP BY cat.id, d.name, b.status, b.kata_mode
         ORDER BY ${withArea ? 'cat.area_order ASC NULLS LAST,' : ''} cat.created_at ASC`;
      try {
        ({ rows: cats } = await db.query(catSql(true), [m.competition_id, m.area_id]));
      } catch (e) {
        if (e.code !== '42703') throw e;
        cats = []; // area_id/area_order ausentes → sem fila (schema pendente)
      }
    }
    return res.json({
      competition: {
        id: m.competition_id,
        name: m.competition_name,
        status: m.competition_status,
        event_date: m.event_date || null,
        location: m.location || null,
      },
      official: {
        name: m.official_name,
        role: m.official_role,
        is_chief: !!m.is_chief,
        status: m.status,
      },
      area: m.area_id
        ? { id: m.area_id, name: m.area_name, sort_order: m.area_sort_order }
        : null,
      categories: cats.map((c) => ({
        id: c.id,
        name: c.name,
        modality: c.modality,
        group_label: c.group_label || null,
        division_name: c.division_name || null,
        area_order: c.area_order != null ? c.area_order : null,
        entry_count: c.entry_count,
        bracket_status: c.bracket_status || 'not_generated',
        kata_mode: c.kata_mode || null,
      })),
    });
  } catch (e) {
    console.error('[karateMesaPublic] /me error:', e.message);
    return res.status(500).json({ error: 'Erro ao carregar a mesa', code: 'INTERNAL_ERROR' });
  }
});

// ── operações da mesa — delegadas aos handlers compartilhados ───────
router.get('/categories/:catId/bracket',
  requireMesaToken, requireCategoryInArea, sharedHandlers.getBracketHandler);
router.post('/categories/:catId/bracket/advance',
  requireMesaToken, requireCategoryInArea, sharedHandlers.advanceHandler);
router.post('/categories/:catId/bracket/finalize',
  requireMesaToken, requireCategoryInArea, sharedHandlers.finalizeHandler);
router.get('/categories/:catId/kata-scores',
  requireMesaToken, requireCategoryInArea, sharedHandlers.kataScoresGetHandler);
router.put('/categories/:catId/kata-scores',
  requireMesaToken, requireCategoryInArea, sharedHandlers.kataScorePutHandler);
router.post('/categories/:catId/kata-scores/advance',
  requireMesaToken, requireCategoryInArea, sharedHandlers.kataAdvanceHandler);
router.get('/categories/:catId/scoresheet',
  requireMesaToken, requireCategoryInArea, sharedHandlers.scoresheetHandler);
// Súmula gravável (304): o mesário preenche shuchin/mesário/duração —
// os campos que na folha real eram manuscritos.
router.patch('/categories/:catId/scoresheet',
  requireMesaToken, requireCategoryInArea, sharedHandlers.scoresheetPatchHandler);

module.exports = router;
