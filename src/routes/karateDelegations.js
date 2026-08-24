// ============================================================
// AURA KARATÊ — P0 Hub de Campeonatos: DELEGAÇÃO DO DOJÔ (rotas)
// Montado em /federation/:id (requireDojoAccess — token do DOJÔ).
//
//   GET  /dojo/competitions                          (A+B) vitrine de
//        campeonatos 'open' da federação (divisões + preço "a partir de")
//   GET  /dojo/competitions/:cid/categories          (A+B) categorias p/
//        o seletor (divisão, grupo, faixa etária, sexo, vagas)
//   POST /dojo/competitions/:cid/delegation/quote    (A) cotação DRY-RUN:
//        valida tudo, calcula o carrinho, NÃO grava nada
//   POST /dojo/competitions/:cid/delegation          (A) submete: cria o
//        pedido + inscrições + equipes numa transação; PIX (pix_direct)
//        best-effort após COMMIT
//   GET  /dojo/delegations                           (A+B) meus pedidos
//   GET  /dojo/delegations/:orderId                  (A+B) detalhe
//
// GATE DE CONEXÃO: inscrever delegação em campeonato é ato FEDERATIVO —
// mesmo padrão de karateDojoFederativo (dojô não conectado não inscreve).
// A vitrine segue o padrão de karateDojo./dojo/events: 200 + not_linked
// (nunca 403 mudo).
//
// dojo_id/federation_id SEMPRE do token (req.dojoId/req.federationId).
// Canal B (portal) é somente leitura (403 PORTAL_READ_ONLY nas escritas).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const { isDojoLinked } = require('../services/karateDojoLinkStatus');
const svc = require('../services/karateDelegationService');

let paymentProvider = null;
try { paymentProvider = require('../services/karatePaymentProvider'); } catch (_) { /* ambiente sem provider */ }

function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal do dojô é somente leitura. Entre com a conta do dojô para inscrever a delegação.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

function actor(req) {
  return {
    createdBy: (req.user && req.user.id) || null,
    createdByName: (req.user && (req.user.name || req.user.email)) || null,
  };
}

function handleWriteError(res, e, ctx) {
  if (e && e.status) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    if (e.errors) body.errors = e.errors;
    if (e.quota_violations) body.quota_violations = e.quota_violations;
    if (e.skipped) body.skipped = e.skipped;
    return res.status(e.status).json(body);
  }
  if (e && (e.code === '42P01' || e.code === 'TABLE_MISSING')) {
    console.error(`[karateDelegations] ${ctx}: SCHEMA_PENDING:`, e.message);
    return res.status(503).json({
      error: 'Delegações indisponíveis no momento (migração 294 pendente)',
      code: 'SCHEMA_PENDING',
    });
  }
  console.error(`[karateDelegations] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR', pg_code: (e && e.code) || null });
}

function handleReadError(res, e, ctx, extra) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
  }
  if (e && (e.code === '42P01' || e.code === '42703' || e.code === 'TABLE_MISSING')) {
    console.warn(`[karateDelegations] ${ctx}: schema pendente (${e.code})`);
    return res.json(Object.assign({ data: [], schema_pending: true }, extra || {}));
  }
  console.error(`[karateDelegations] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
}

// Gate federativo para escritas — mesmo 409 do karateDojoFederativo.
async function requireLinked(req, res, next) {
  try {
    const linked = await isDojoLinked(req.dojoId);
    if (!linked) {
      return res.status(409).json({
        error: 'Conecte seu dojô à federação para inscrever a delegação em campeonatos.',
        code: 'DOJO_NAO_CONECTADO',
      });
    }
    return next();
  } catch (e) {
    // Falha na checagem não pode virar bloqueio silencioso — segue como
    // conectado (mesma postura de karateDojoBeltExamService.requestCertificates).
    console.warn('[karateDelegations] isDojoLinked falhou (segue):', e && e.message);
    return next();
  }
}

// ── GET /dojo/competitions — vitrine ────────────────────────
router.get('/dojo/competitions', requireDojoAccess, async (req, res) => {
  try {
    const linked = await isDojoLinked(req.dojoId).catch(() => true);
    if (!linked) return res.json({ data: [], not_linked: true });
    const data = await svc.listOpenCompetitions(req.federationId);
    return res.json({ data });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/competitions');
  }
});

// ── GET /dojo/competitions/:cid/categories ──────────────────
router.get('/dojo/competitions/:cid/categories', requireDojoAccess, async (req, res) => {
  try {
    const comp = await require('../services/karateDelegationService')
      .listCategoriesForEnrollment(req.params.cid);
    return res.json({ data: comp });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/competitions/:cid/categories');
  }
});

// ── POST /dojo/competitions/:cid/delegation/quote — dry-run ──
// Body: { athletes: [{ student_id, category_ids: [] }],
//         teams: [{ name, sex, category_ids: [], titular_ids: [], reserve_ids: [] }],
//         officials_count }
// NÃO grava nada. Devolve quote + skipped + warnings + quota_violations —
// a tela usa para o dojô ajustar ANTES de submeter.
router.post('/dojo/competitions/:cid/delegation/quote', requireDojoAccess, requireChannelA, requireLinked, async (req, res) => {
  try {
    const plan = await svc.planDelegation({
      federationId: req.federationId,
      dojoId: req.dojoId,
      competitionId: req.params.cid,
      body: req.body,
    });
    return res.json({
      quote: plan.quote,
      skipped: plan.skipped,
      warnings: plan.warnings,
      quota_violations: plan.quotaViolations,
      athletes_count: plan.athletes.length,
      teams_count: plan.teams.length,
    });
  } catch (e) {
    return handleWriteError(res, e, 'POST delegation/quote');
  }
});

// ── POST /dojo/competitions/:cid/delegation/triage — P2.2 ───
// Triagem automática: o sensei manda ATLETA + MODALIDADES e o sistema
// resolve a categoria pelos requisitos da federação (idade na data do
// evento, faixa, sexo, divisão/G1-G2). Body:
//   { athletes: [{ student_id, modalities: ['kata','kumite',...] }] }
// Por atleta/modalidade: resolved (1 match — zero escolha manual) |
// ambiguous (sensei só desempata) | no_fit (critérios que falharam —
// o "vermelho manual" da conferência vira aviso NA ORIGEM). Dry-run:
// nada é gravado; o front usa o resultado para montar os category_ids
// do quote/submit, que seguem inalterados.
router.post('/dojo/competitions/:cid/delegation/triage', requireDojoAccess, requireChannelA, requireLinked, async (req, res) => {
  try {
    const out = await svc.triageDelegation({
      federationId: req.federationId,
      dojoId: req.dojoId,
      competitionId: req.params.cid,
      body: req.body,
    });
    return res.json(out);
  } catch (e) {
    return handleWriteError(res, e, 'POST delegation/triage');
  }
});

// ── POST /dojo/competitions/:cid/delegation — submete ───────
// Mesmo body do quote + { payment_mode: 'pix_direct'|'manual' }.
// pix_direct: gera o PIX (provider da federação) best-effort após o COMMIT
// — falha do PIX NÃO desfaz a delegação (mesma postura do funil público);
// o pedido fica awaiting_payment e o PIX pode ser re-gerado depois.
router.post('/dojo/competitions/:cid/delegation', requireDojoAccess, requireChannelA, requireLinked, async (req, res) => {
  try {
    const out = await svc.submitDelegation({
      federationId: req.federationId,
      dojoId: req.dojoId,
      competitionId: req.params.cid,
      body: req.body,
      ...actor(req),
    });

    // ── PIX best-effort (pix_direct, total > 0) ──
    let payment = null;
    if (out.order.payment_mode === 'pix_direct' && out.order.total_amount > 0
        && paymentProvider && paymentProvider.createPixCharge) {
      try {
        const txid = `deleg-${String(out.order.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 18)}`;
        const descr = `Delegação — ${out.enrolled.athletes.length + out.enrolled.teams.length} inscrições`;
        const charge = await paymentProvider.createPixCharge({
          federationId: req.federationId,
          amount: out.order.total_amount,
          txid,
          description: descr,
        });
        try {
          await db.query(
            `-- p0d:insert-intent
             INSERT INTO karate_payment_intents
               (federation_id, provider, payment_intent_id, payload, qr_image, status, expires_at,
                amount, source_type, source_id, txid, description, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'pending',$6, $7,'delegation_order',$8,$9,$10, NOW(), NOW())`,
            [req.federationId, charge.provider, charge.payment_intent_id, charge.payload,
             charge.qr_image || null, charge.expires_at, out.order.total_amount,
             out.order.id, txid, descr]
          );
        } catch (e2) {
          if (e2.code !== '42703') throw e2; // colunas da 213 ausentes → intent sem ledger, PIX segue
        }
        payment = {
          payment_intent_id: charge.payment_intent_id,
          payload: charge.payload,
          qr_image: charge.qr_image || null,
          expires_at: charge.expires_at,
          provider: charge.provider,
          amount: out.order.total_amount,
        };
      } catch (e) {
        console.error('[karateDelegations] PIX da delegação falhou (best-effort):', e.message);
        payment = { error: 'Não foi possível gerar o PIX agora. O pedido está registrado — gere novamente mais tarde ou envie o comprovante.' };
      }
    }

    return res.status(201).json(Object.assign({}, out, { payment }));
  } catch (e) {
    return handleWriteError(res, e, 'POST delegation');
  }
});

// ═══════════════════════════════════════════════════════════
// ONDA B — "MINHAS CHAVES" no portal do dojô (A+B, leitura)
// O sensei vê e imprime as chaves das categorias onde TEM atleta —
// digitaliza o "procurar minha chave no PDF/parede" do dia real.
// Gate: chaves PUBLICADAS (brackets_published_at) — antes disso o
// endpoint responde 200 { published: false } (nunca 403 mudo).
// ═══════════════════════════════════════════════════════════

async function findCompPublished(federationId, cid) {
  const { rows } = await db.query(
    `-- p0d:comp-published
     SELECT id, name, brackets_published_at
       FROM karate_competitions
      WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [cid, federationId]
  );
  return rows[0] || null;
}

// ── GET /dojo/competitions/:cid/my-brackets ─────────────────
router.get('/dojo/competitions/:cid/my-brackets', requireDojoAccess, async (req, res) => {
  try {
    const comp = await findCompPublished(req.federationId, req.params.cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    if (!comp.brackets_published_at) {
      return res.json({ published: false, data: [] });
    }

    // area/division/group podem faltar (297/301 pendentes) → fallback.
    const sql = (full) => `
      -- p0d:my-brackets
      SELECT cat.id, cat.name, cat.modality,
             ${full ? `cat.group_label, d.name AS division_name,
             a.name AS area_name, cat.area_order,` : `NULL AS group_label, NULL AS division_name,
             NULL AS area_name, NULL AS area_order,`}
             b.status AS bracket_status, b.kata_mode,
             cu.name AS student_name
        FROM karate_competition_entries e
        JOIN karate_competition_categories cat ON cat.id = e.category_id
        ${full ? `LEFT JOIN karate_competition_divisions d ON d.id = cat.division_id
        LEFT JOIN karate_competition_areas a ON a.id = cat.area_id` : ''}
        LEFT JOIN karate_brackets b ON b.category_id = cat.id
        LEFT JOIN customers cu ON cu.id = e.student_id
       WHERE cat.competition_id = $1 AND e.dojo_id = $2
         AND e.status NOT IN ('withdrawn')
       ORDER BY ${full ? 'cat.area_order ASC NULLS LAST,' : ''} cat.name ASC, cu.name ASC`;
    let rows;
    try {
      ({ rows } = await db.query(sql(true), [req.params.cid, req.dojoId]));
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
      ({ rows } = await db.query(sql(false), [req.params.cid, req.dojoId]));
    }

    const byCat = new Map();
    for (const r of rows) {
      if (!byCat.has(r.id)) {
        byCat.set(r.id, {
          id: r.id, name: r.name, modality: r.modality,
          group_label: r.group_label || null, division_name: r.division_name || null,
          area_name: r.area_name || null, area_order: r.area_order != null ? r.area_order : null,
          bracket_status: r.bracket_status || 'not_generated',
          kata_mode: r.kata_mode || null,
          my_athletes: [],
        });
      }
      if (r.student_name) byCat.get(r.id).my_athletes.push(r.student_name);
    }
    return res.json({ published: true, competition_name: comp.name, data: [...byCat.values()] });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/competitions/:cid/my-brackets', { published: false });
  }
});

// ── GET /dojo/competitions/:cid/categories/:catId/scoresheet ─
// A folha completa da categoria (mesmo payload da federação/mesa),
// SOMENTE leitura e SOMENTE onde o dojô tem atleta + chaves publicadas.
// Delegado ao handler compartilhado de karateBrackets (fonte única).
async function requireMyPublishedCategory(req, res, next) {
  try {
    const comp = await findCompPublished(req.federationId, req.params.cid);
    if (!comp || !comp.brackets_published_at) {
      return res.status(404).json({ error: 'Chaves ainda não publicadas', code: 'NOT_PUBLISHED' });
    }
    const { rows } = await db.query(
      `-- p0d:my-cat-gate
       SELECT 1 FROM karate_competition_entries e
        WHERE e.category_id = $1 AND e.dojo_id = $2
          AND e.status NOT IN ('withdrawn')
        LIMIT 1`,
      [req.params.catId, req.dojoId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Categoria não encontrada entre as suas chaves', code: 'NOT_FOUND' });
    }
    return next();
  } catch (e) {
    return handleReadError(res, e, 'gate my-category scoresheet');
  }
}
router.get('/dojo/competitions/:cid/categories/:catId/scoresheet',
  requireDojoAccess, requireMyPublishedCategory,
  require('./karateBrackets').sharedHandlers.scoresheetHandler);

// ═══════════════════════════════════════════════════════════
// ONDA B — CHECK-IN LEVE do lado do DOJÔ (migration 305)
// O dojô responde pela presença dos SEUS atletas no dia (regra real do
// credenciamento). Leitura A+B; marcação só no Canal A. Mesmos SQL/
// rollup da federação (checkinShared), escopados por e.dojo_id.
// ═══════════════════════════════════════════════════════════
const checkinShared = require('./karateCompetitionSetup').checkinShared;

// ── GET /dojo/competitions/:cid/check-in ────────────────────
router.get('/dojo/competitions/:cid/check-in', requireDojoAccess, async (req, res) => {
  try {
    const comp = await findCompPublished(req.federationId, req.params.cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    let rows;
    try {
      ({ rows } = await db.query(`${checkinShared.CHECKIN_SELECT}
       AND e.dojo_id = $2
       ORDER BY student_name ASC`, [req.params.cid, req.dojoId]));
    } catch (e) {
      if (e.code !== '42703') throw e;
      return res.json({ schema_pending: true, data: [], totals: { atletas: 0, presentes: 0, ausentes: 0, pendentes: 0 } });
    }
    return res.json(checkinShared.rollupCheckin(rows));
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/competitions/:cid/check-in');
  }
});

// ── PATCH /dojo/competitions/:cid/check-in/:studentId ───────
// Body: { status: 'presente' | 'ausente' | 'limpar' } — só atletas DESTE dojô.
router.patch('/dojo/competitions/:cid/check-in/:studentId', requireDojoAccess, requireChannelA, async (req, res) => {
  const status = req.body && req.body.status;
  if (!checkinShared.CHECKIN_STATUSES.includes(status)) {
    return res.status(422).json({ error: `status deve ser: ${checkinShared.CHECKIN_STATUSES.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  try {
    const comp = await findCompPublished(req.federationId, req.params.cid);
    if (!comp) return res.status(404).json({ error: 'Competição não encontrada', code: 'NOT_FOUND' });
    let upd;
    try {
      upd = await db.query(`${checkinShared.CHECKIN_UPDATE('dojo')}
        AND e.dojo_id = $4 RETURNING e.id`, [req.params.cid, req.params.studentId, status, req.dojoId]);
    } catch (e) {
      if (e.code !== '42703') throw e;
      return res.status(503).json({ error: 'Check-in indisponível (migração 305 pendente)', code: 'SCHEMA_PENDING' });
    }
    if (!upd.rows.length) return res.status(404).json({ error: 'Atleta do seu dojô não encontrado nesta competição', code: 'NOT_FOUND' });
    return res.json({ student_id: req.params.studentId, status, entries_updated: upd.rows.length });
  } catch (e) {
    return handleWriteError(res, e, 'PATCH /dojo/check-in');
  }
});

// ── GET /dojo/delegations — meus pedidos ────────────────────
router.get('/dojo/delegations', requireDojoAccess, async (req, res) => {
  try {
    const data = await svc.listOrders(req.federationId, req.dojoId);
    return res.json({ data });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/delegations');
  }
});

// ── GET /dojo/delegations/:orderId — detalhe ────────────────
router.get('/dojo/delegations/:orderId', requireDojoAccess, async (req, res) => {
  try {
    const order = await svc.getOrder(req.federationId, req.dojoId, req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado', code: 'NOT_FOUND' });
    return res.json({ order });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/delegations/:orderId');
  }
});

// ── POST /dojo/delegations/:orderId/receipt — comprovante ───
// Body: { file_base64, content_type } (PDF/JPEG/PNG/WebP, ~5MB).
// Digitaliza o "planilha sem comprovante será desconsiderada" do fluxo
// real: pedido vai para awaiting_confirmation e entra na fila da
// federação. Reenvio permitido enquanto não confirmado.
router.post('/dojo/delegations/:orderId/receipt', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const { uploadToR2 } = require('../utils/r2Storage');
    const b = req.body || {};
    const out = await svc.uploadReceipt({
      federationId: req.federationId,
      dojoId: req.dojoId,
      orderId: req.params.orderId,
      fileBase64: b.file_base64,
      contentType: b.content_type,
      uploadToR2,
    });
    return res.json({ order: out });
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/delegations/:orderId/receipt');
  }
});

module.exports = router;
