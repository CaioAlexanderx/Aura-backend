// ============================================================
// AURA KARATÊ — Admin: atalho p/ habilitar a vertical karatê
// PATCH /admin/clients/:cid/karate
//
// Liga (ou desliga) o módulo vertical karatê numa empresa existente:
//   mode='federation' → vira a federação (ex: FPKT)
//   mode='dojo'       → vira um dojô/academia filiado a uma federação
//   mode=null|''      → desativa a vertical karatê
//
// Por que um atalho dedicado (e não o adminVertical):
//   - o karatê é identificado por companies.vertical (migration 147),
//     coluna SEPARADA de vertical_active (odonto/barber/food/studio/...).
//   - habilitar não é só setar uma flag: federação precisa semear os 12
//     critérios FPKT; dojô precisa de federation_id + fpkt_affiliation_id.
//
// Seta companies.vertical E vertical_active com o MESMO valor karatê
// (belt-and-suspenders: o app gateia por `vertical ?? vertical_active`
// em vários paths). Idempotente. adminOnly. Audit log best-effort.
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const { nextDojoAffiliationId } = require('../services/karateService');

const adminOnly = [requireAuth, requireRole('admin')];

const VERTICAL_BY_MODE = {
  federation: 'karate_federation',
  dojo: 'karate_dojo',
};

const VALID_AFFILIATION_MODELS = ['annual', 'biannual', 'quarterly'];

// slugify simples: minúsculas, sem acento, espaços→hífen.
function slugify(input) {
  return String(input || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// PATCH /admin/clients/:cid/karate
router.patch('/clients/:cid/karate', ...adminOnly, asyncHandler(async (req, res) => {
  const { cid } = req.params;
  const body = req.body || {};
  const rawMode = body.mode;
  const mode = rawMode === null || rawMode === '' || rawMode === undefined
    ? null
    : String(rawMode).toLowerCase().trim();

  if (mode !== null && !VERTICAL_BY_MODE[mode]) {
    throw new AppError("mode inválido. Use 'federation', 'dojo' ou null para desativar.", 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `SELECT id, legal_name, trade_name, name, slug, vertical, vertical_active, federation_id, fpkt_affiliation_id, affiliation_model
         FROM companies WHERE id = $1 FOR UPDATE`,
      [cid]
    );
    if (!existing.length) {
      await client.query('ROLLBACK');
      throw new AppError('Empresa não encontrada', 404);
    }
    const company = existing[0];
    const oldVertical = company.vertical;
    const newVertical = mode === null ? null : VERTICAL_BY_MODE[mode];

    // ── Desativar ────────────────────────────────────────────
    if (mode === null) {
      const { rows } = await client.query(
        `UPDATE companies
            SET vertical = NULL,
                vertical_active = CASE WHEN vertical_active IN ('karate_federation','karate_dojo')
                                       THEN NULL ELSE vertical_active END,
                federation_id = NULL,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, name, slug, vertical, vertical_active, federation_id`,
        [cid]
      );
      await logAudit(client, req, cid, oldVertical, null);
      await client.query('COMMIT');
      return res.json({
        message: 'Vertical karatê desativada (antes: ' + (oldVertical || 'nenhuma') + ')',
        company: rows[0],
        changed: oldVertical !== null,
      });
    }

    // garante name p/ as listagens karatê (c.name é usado nas rotas)
    const ensuredName = company.name || company.trade_name || company.legal_name || 'Sem nome';

    // ── Federação ────────────────────────────────────────────
    if (mode === 'federation') {
      const slug = body.slug ? slugify(body.slug) : (company.slug || slugify(ensuredName));
      if (!slug) throw new AppError('Não foi possível derivar um slug — informe body.slug', 400);

      // dedupe de slug entre federações (o índice único também protege)
      const { rows: clash } = await client.query(
        `SELECT id FROM companies
          WHERE slug = $1 AND vertical = 'karate_federation' AND id <> $2 LIMIT 1`,
        [slug, cid]
      );
      if (clash.length) {
        await client.query('ROLLBACK');
        throw new AppError('Já existe uma federação com o slug "' + slug + '"', 409);
      }

      const { rows } = await client.query(
        `UPDATE companies
            SET vertical = 'karate_federation',
                vertical_active = 'karate_federation',
                name = $2,
                slug = $3,
                federation_id = NULL,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, name, slug, vertical, vertical_active, federation_id`,
        [cid, ensuredName, slug]
      );

      // semeia os 12 critérios FPKT só se ainda não houver (idempotente)
      const { rows: reqCount } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM karate_belt_requirements WHERE federation_id = $1`,
        [cid]
      );
      let requirementsSeeded = reqCount[0].cnt;
      if (requirementsSeeded === 0) {
        await client.query(`SELECT karate_seed_fpkt_requirements($1)`, [cid]);
        const { rows: after } = await client.query(
          `SELECT COUNT(*)::int AS cnt FROM karate_belt_requirements WHERE federation_id = $1`,
          [cid]
        );
        requirementsSeeded = after[0].cnt;
      }

      await logAudit(client, req, cid, oldVertical, 'karate_federation');
      await client.query('COMMIT');
      return res.json({
        message: 'Federação karatê habilitada' + (oldVertical === 'karate_federation' ? ' (já estava)' : ''),
        company: rows[0],
        requirements_seeded: requirementsSeeded,
        changed: oldVertical !== 'karate_federation',
      });
    }

    // ── Dojô ─────────────────────────────────────────────────
    // mode === 'dojo'
    const federationId = body.federation_id;
    if (!federationId) {
      await client.query('ROLLBACK');
      throw new AppError('mode=dojo exige body.federation_id (id da federação-mãe)', 400);
    }
    const { rows: fed } = await client.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [federationId]
    );
    if (!fed.length) {
      await client.query('ROLLBACK');
      throw new AppError('federation_id não aponta para uma federação karatê válida', 422);
    }

    const affiliationModel = body.affiliation_model
      ? String(body.affiliation_model).toLowerCase().trim()
      : (company.affiliation_model || 'annual');
    if (!VALID_AFFILIATION_MODELS.includes(affiliationModel)) {
      await client.query('ROLLBACK');
      throw new AppError('affiliation_model deve ser annual, biannual ou quarterly', 400);
    }

    // gera FPKT-NNN só se ainda não tiver
    const fpktId = company.fpkt_affiliation_id || await nextDojoAffiliationId(client, federationId);

    const { rows } = await client.query(
      `UPDATE companies
          SET vertical = 'karate_dojo',
              vertical_active = 'karate_dojo',
              name = $2,
              federation_id = $3,
              fpkt_affiliation_id = $4,
              affiliation_model = $5,
              -- Migration 247: admin habilita o dojô AGINDO PELA federação, então
              -- o dojô nasce conectado/visível. COALESCE preserva um vínculo
              -- anterior (idempotente). O fluxo F6 setará no aceite da conexão.
              karate_dojo_linked_at = COALESCE(karate_dojo_linked_at, NOW()),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, vertical, vertical_active, federation_id, fpkt_affiliation_id, affiliation_model`,
      [cid, ensuredName, federationId, fpktId, affiliationModel]
    );

    await logAudit(client, req, cid, oldVertical, 'karate_dojo');
    await client.query('COMMIT');
    return res.json({
      message: 'Dojô karatê habilitado' + (oldVertical === 'karate_dojo' ? ' (já estava)' : ''),
      company: rows[0],
      changed: oldVertical !== 'karate_dojo',
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* já feito */ }
    throw err;
  } finally {
    client.release();
  }
}));

// Audit log best-effort (mesmo padrão do adminVertical).
async function logAudit(client, req, cid, from, to) {
  try {
    await client.query(
      `INSERT INTO admin_audit_log (actor_user_id, action, target_company_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [req.user?.id || null, 'karate_vertical_change', cid, JSON.stringify({ from, to })]
    );
  } catch (err) {
    console.warn('[admin/karate] audit log falhou:', err.message);
  }
}

module.exports = router;
