// ============================================================
// AURA KARATÊ — F0 Canal B: portal PÚBLICO do dojô por LINK FIXO
// Montado em /public/karate/dojo (ANTES dos routers /public/karate/:slug —
// ver index.js).
//
// O dojô SEM login Aura entra pelo link fixo revogável que a federação
// envia (?t=<token>); o front (aura-app services/karateDojoPortalApi.ts)
// manda o token em Authorization: Bearer. O servidor deriva dojo_id +
// federation_id do token — o cliente NUNCA escolhe o dojô.
//
// Token: opaco, persistido só como hash SHA-256+segredo em
// karate_dojo_portal_links (migration 239) — ver
// src/services/karateDojoPortalLinkService.js.
//
// NÃO substitui o fluxo OTP de karateDojoPublic.js (request-otp/verify-otp,
// migrations 185/186) — aquele segue montado; a decisão de produto do
// Canal B (ESCOPO 19/06) é LINK FIXO.
//
// Endpoints (shape EXATO esperado pelo front — karateDojoPortalApi.ts):
//   GET  /me            — DojoMe FLAT (não embrulhado em {dojo})
//   GET  /practitioners — { practitioners, count } (lista nominal read-only)
//   GET  /annuity       — { pending, history, pix } (mesmo shape de
//                          GET /federation/:id/dojo/annuity — karateDojo.js)
//   POST /annuity/pix   — { intent_id, payment_intent_id, payload, qr_image,
//                          status, expires_at, provider } (BR Code real via
//                          karatePaymentProvider; 409 sem parcela pendente)
//   GET  /certificates  — { orders, count } (karateCertificateService)
//
// Segurança: 401 SEMPRE genérico (não vaza se o token existe/foi revogado/
// schema pendente). Rate limit por token+IP (mesmo padrão de
// karateRosterPortalPublic.js).
// ============================================================
'use strict';

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const portalLinkService = require('../services/karateDojoPortalLinkService');
const { createPixCharge } = require('../services/karatePaymentProvider');
const certificateService = require('../services/karateCertificateService');
const { computeDojoStatus } = require('../services/karateService');

const GENERIC_401 = Object.freeze({
  error: 'Link inválido ou revogado',
  code: 'PORTAL_LINK_INVALID',
});

const isTestEnv = () => process.env.NODE_ENV === 'test';

// Chave de rate limit = sufixo do token + IP. Aqui o token vem no header
// Authorization (não em req.params como no roster) — usamos só o sufixo
// para não reter o token inteiro na memória do limiter.
function keyByTokenAndIp(req) {
  const auth = req.headers['authorization'] || 'no-token';
  return `${auth.slice(-24)}:${req.ip || 'no-ip'}`;
}

const readLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByTokenAndIp,
  skip: () => isTestEnv(),
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.', code: 'RATE_LIMITED' },
});

// Gerar PIX pode bater no provider — teto bem menor que leitura.
const pixLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByTokenAndIp,
  skip: () => isTestEnv(),
  message: { error: 'Muitas tentativas de gerar PIX. Aguarde alguns minutos.', code: 'RATE_LIMITED' },
});

router.use(readLimiter);

// ── Middleware: resolve o link fixo → req.dojoId + req.federationId ──
// 401 genérico em TODA falha (sem token, malformado, revogado, inexistente,
// tabela ausente) — não vaza existência nem estado.
async function requireDojoPortalLink(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return res.status(401).json(GENERIC_401);

  try {
    const link = await portalLinkService.resolveToken(token);
    if (!link) return res.status(401).json(GENERIC_401);
    req.dojoId = link.dojo_id;
    req.federationId = link.federation_id;
    req.dojoAuthChannel = 'B'; // compat com handlers que olham o canal
    next();
  } catch (err) {
    console.error('[karateDojoPortalPublic] resolve error:', err.message);
    return res.status(401).json(GENERIC_401);
  }
}

// ── GET /me — DojoMe FLAT (shape de karateDojoPortalApi.DojoMe) ──
router.get('/me', requireDojoPortalLink, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id,
              COALESCE(c.name, c.trade_name, c.legal_name) AS name,
              c.cnpj, c.sensei_cpf, c.region, c.fpkt_affiliation_id,
              c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
              c.phone, c.email, c.karate_logo_url, c.is_active,
              (SELECT COUNT(*) FROM customers cu WHERE cu.dojo_id = c.id) AS practitioner_count
         FROM companies c
        WHERE c.id = $1 AND c.federation_id = $2 AND c.vertical = 'karate_dojo'
        LIMIT 1`,
      [req.dojoId, req.federationId]
    );
    if (!rows.length) {
      // Dojô sumiu/trocou de federação: para o portador do link é o mesmo
      // que link morto — 401 genérico, sem vazar o motivo.
      return res.status(401).json(GENERIC_401);
    }
    const d = rows[0];

    let status;
    try {
      status = computeDojoStatus(d.affiliation_model, d.affiliation_since, d.is_active);
    } catch (_) {
      status = d.is_active === false ? 'inactive' : 'active';
    }

    res.json({
      id: d.id,
      name: d.name,
      cnpj: d.cnpj || null,
      sensei_cpf: d.sensei_cpf || null,
      region: d.region || null,
      fpkt_affiliation_id: d.fpkt_affiliation_id || null,
      affiliation_model: d.affiliation_model || null,
      affiliation_since: d.affiliation_since || null,
      dojo_founded_year: d.dojo_founded_year != null ? Number(d.dojo_founded_year) : null,
      phone: d.phone || null,
      email: d.email || null,
      karate_logo_url: d.karate_logo_url || null,
      status,
      practitioner_count: parseInt(d.practitioner_count, 10) || 0,
    });
  } catch (err) {
    console.error('[karateDojoPortalPublic] /me error:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── GET /practitioners — lista nominal read-only ─────────────
// Mesma query de GET /federation/:id/dojo/practitioners (karateDojo.js) —
// dojo_id SEMPRE do token, nunca de query/body.
router.get('/practitioners', requireDojoPortalLink, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cu.id AS practitioner_id, cu.name, cu.is_active,
              cb.belt_level, cb.belt_name
         FROM customers cu
         LEFT JOIN karate_current_belt cb
                ON cb.student_id = cu.id AND cb.federation_id = $1
        WHERE cu.dojo_id = $2
        ORDER BY cu.name ASC`,
      [req.federationId, req.dojoId]
    );
    res.json({
      practitioners: rows.map(r => ({
        practitioner_id: r.practitioner_id,
        name: r.name,
        is_active: r.is_active !== false,
        belt_level: r.belt_level || null,
        belt_name: r.belt_name || null,
      })),
      count: rows.length,
    });
  } catch (err) {
    console.error('[karateDojoPortalPublic] /practitioners error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar praticantes' });
  }
});

// ── GET /annuity — pendência + histórico + chave PIX ─────────
// Mesmo shape de GET /federation/:id/dojo/annuity (karateDojo.js):
// { pending, history, pix }. "Pago" = paid_at não-nulo. Degradação graceful
// se a tabela ainda não existir.
router.get('/annuity', requireDojoPortalLink, async (req, res) => {
  try {
    let history = [];
    try {
      const { rows } = await db.query(
        `SELECT id, reference_period, amount, status, paid_at, due_date
           FROM karate_dojo_annuity_history
          WHERE dojo_id = $1 AND federation_id = $2
          ORDER BY reference_period DESC
          LIMIT 24`,
        [req.dojoId, req.federationId]
      );
      history = rows;
    } catch (_) { /* tabela ausente — degradação graceful */ }

    const pending = history.find(h => !h.paid_at) || null;

    let pix = null;
    try {
      const { rows: dcc } = await db.query(
        `SELECT pix_key, pix_key_type, pix_holder_name
           FROM digital_channel_config WHERE company_id = $1 LIMIT 1`,
        [req.federationId]
      );
      if (dcc.length && dcc[0].pix_key) {
        pix = {
          key: dcc[0].pix_key,
          key_type: dcc[0].pix_key_type || null,
          holder_name: dcc[0].pix_holder_name || null,
        };
      }
    } catch (_) { /* pix opcional */ }

    res.json({
      pending: pending ? {
        annuity_history_id: pending.id,
        reference_period: pending.reference_period,
        amount: pending.amount != null ? Number(pending.amount) : null,
        status: pending.status,
        due_date: pending.due_date || null,
      } : null,
      history: history.map(h => ({
        annuity_history_id: h.id,
        reference_period: h.reference_period,
        amount: h.amount != null ? Number(h.amount) : null,
        status: h.status,
        paid_at: h.paid_at || null,
        due_date: h.due_date || null,
      })),
      pix,
    });
  } catch (err) {
    console.error('[karateDojoPortalPublic] /annuity error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar anuidade' });
  }
});

// ── POST /annuity/pix — BR Code da parcela pendente ──────────
// Espelha POST /federation/:id/financial/annuities/dojos/:dojoId/pix
// (karateAnnuities.js), mas o dojo_id vem do TOKEN. Aceita
// { annuity_history_id } no body (é o que o front manda); sem body, cai na
// parcela pendente MAIS ANTIGA do dojô. 409 se nada pendente.
router.post('/annuity/pix', pixLimiter, requireDojoPortalLink, async (req, res) => {
  const dojoId = req.dojoId;
  const federationId = req.federationId;
  const requestedId = req.body && req.body.annuity_history_id
    ? String(req.body.annuity_history_id)
    : null;

  try {
    let annuity = null;

    if (requestedId) {
      const { rows } = await db.query(
        `SELECT h.*, COALESCE(c.name, c.trade_name, c.legal_name) AS dojo_name
           FROM karate_dojo_annuity_history h
           JOIN companies c ON c.id = h.dojo_id
          WHERE h.id = $1 AND h.dojo_id = $2 AND h.federation_id = $3
          LIMIT 1`,
        [requestedId, dojoId, federationId]
      );
      annuity = rows[0] || null;
      if (annuity && (annuity.status === 'paid' || annuity.paid_at)) {
        return res.status(409).json({ error: 'Anuidade já paga', code: 'CONFLICT' });
      }
    }

    if (!annuity) {
      const { rows } = await db.query(
        `SELECT h.*, COALESCE(c.name, c.trade_name, c.legal_name) AS dojo_name
           FROM karate_dojo_annuity_history h
           JOIN companies c ON c.id = h.dojo_id
          WHERE h.dojo_id = $1 AND h.federation_id = $2
            AND h.paid_at IS NULL AND h.status IS DISTINCT FROM 'paid'
          ORDER BY h.reference_period ASC
          LIMIT 1`,
        [dojoId, federationId]
      );
      annuity = rows[0] || null;
    }

    if (!annuity) {
      return res.status(409).json({
        error: 'Nenhuma parcela de anuidade pendente para este dojô',
        code: 'NO_PENDING_ANNUITY',
      });
    }

    // Idempotência: reusa intent pendente ainda válido (mesmo padrão do
    // fluxo admin em karateAnnuities.js). Best-effort — ledger ausente não
    // bloqueia.
    try {
      const { rows: existing } = await db.query(
        `SELECT id, payment_intent_id, payload, qr_image, status, expires_at, provider
           FROM karate_payment_intents
          WHERE annuity_history_id = $1 AND status = 'pending' AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1`,
        [annuity.id]
      );
      if (existing.length) {
        const intent = existing[0];
        return res.json({
          intent_id: intent.id,
          payment_intent_id: intent.payment_intent_id,
          payload: intent.payload,
          qr_image: intent.qr_image || null,
          status: intent.status,
          expires_at: intent.expires_at,
          provider: intent.provider,
        });
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }

    const txid = `dojo-${String(dojoId).slice(0, 8)}-${annuity.reference_period}`;
    const pixResult = await createPixCharge({
      federationId,
      amount: parseFloat(annuity.amount),
      txid,
      description: `Anuidade ${annuity.dojo_name} — ${annuity.reference_period}`,
    });

    // Salva no ledger (best-effort — mesmo INSERT do fluxo admin).
    let intentId = pixResult.payment_intent_id;
    try {
      const { rows: intentRows } = await db.query(
        `INSERT INTO karate_payment_intents
           (federation_id, annuity_history_id, transaction_id, provider,
            payment_intent_id, payload, qr_image, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, NOW())
         RETURNING id`,
        [
          federationId,
          annuity.id,
          annuity.transaction_id || null,
          pixResult.provider,
          pixResult.payment_intent_id,
          pixResult.payload,
          pixResult.qr_image || null,
          pixResult.expires_at,
        ]
      );
      intentId = intentRows[0].id;
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
      console.warn('[karateDojoPortalPublic] karate_payment_intents indisponível (best-effort):', e.message);
    }

    res.status(201).json({
      intent_id: intentId,
      payment_intent_id: pixResult.payment_intent_id,
      payload: pixResult.payload,
      qr_image: pixResult.qr_image || null,
      status: pixResult.status,
      expires_at: pixResult.expires_at,
      provider: pixResult.provider,
      _warn: pixResult._warn,
    });
  } catch (err) {
    console.error('[karateDojoPortalPublic] /annuity/pix error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar PIX da anuidade' });
  }
});

// ── GET /certificates — pedidos de certificado do dojô ───────
router.get('/certificates', requireDojoPortalLink, async (req, res) => {
  try {
    const orders = await certificateService.getOrdersByDojo(
      req.dojoId,
      req.federationId,
      { page: 1, pageSize: 100 }
    );
    res.json({
      orders: (orders || []).map(o => ({
        id: o.id,
        practitioner_id: o.practitioner_id,
        practitioner_name: o.nome_impresso || null,
        belt_level: o.belt_level,
        belt_name: o.belt_name,
        status: o.status,
        created_at: o.created_at,
      })),
      count: (orders || []).length,
    });
  } catch (err) {
    if (err.code === 'TABLE_MISSING') {
      return res.json({ orders: [], count: 0 }); // migration 182 pendente — degrada
    }
    console.error('[karateDojoPortalPublic] /certificates error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar certificados' });
  }
});

module.exports = router;
