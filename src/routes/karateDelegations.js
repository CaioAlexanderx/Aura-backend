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
