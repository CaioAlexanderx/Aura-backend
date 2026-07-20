// ============================================================
// AURA DOJÔ — F3a: Rotas do motor de mensalidades (CHARGE-BASED)
//
// Montado sob /federation/:id (padrão karateDojoStudents.js). Guard:
// requireDojoAccess (Canal A = conta do dojô; Canal B = portal do
// responsável). REGRA DE CANAL: GET aceita A e B; POST/PATCH/PUT/DELETE
// exigem Canal A — o portal (B) é somente leitura (403 PORTAL_READ_ONLY).
//
// Escopo SEMPRE por req.dojoId do guard — nunca do body/query. Defensivo
// 42P01 (migration 243 pendente): GETs de lista devolvem vazio +
// schema_pending; writes devolvem 503 SCHEMA_PENDING.
//
//   GET    /federation/:id/dojo/billing/plans
//   POST   /federation/:id/dojo/billing/plans
//   PATCH  /federation/:id/dojo/billing/plans/:pid
//   POST   /federation/:id/dojo/billing/students/:sid/subscribe
//   DELETE /federation/:id/dojo/billing/students/:sid/subscribe
//   GET    /federation/:id/dojo/billing/subscriptions
//   POST   /federation/:id/dojo/billing/generate            ({competence:'YYYY-MM'})
//   GET    /federation/:id/dojo/billing/charges             (?competence=&status=&q=)
//   POST   /federation/:id/dojo/billing/charges/:cid/pix
//   POST   /federation/:id/dojo/billing/charges/:cid/confirm
//   POST   /federation/:id/dojo/billing/charges/:cid/cancel
//   GET    /federation/:id/dojo/billing/config
//   PUT    /federation/:id/dojo/billing/config
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const svc = require('../services/karateDojoBillingService');

// Canal B (portal do dojô) é SOMENTE LEITURA — alterar cobrança exige a
// conta do dojô (Canal A).
function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal do dojô é somente leitura. Entre com a conta do dojô para alterar dados.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

function handleWriteError(res, e, ctx) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
  }
  if (e && e.code === '42P01') {
    return res.status(503).json({ error: 'Mensalidades do dojô ainda não disponíveis (migration 243 pendente)', code: 'SCHEMA_PENDING' });
  }
  console.error(`[karateDojoBilling] ${ctx}:`, e.message);
  return res.status(500).json({ error: 'Erro interno' });
}

const EMPTY_SUMMARY = { total_amount: 0, paid_amount: 0, pending_count: 0, overdue_count: 0, paid_count: 0 };

// ── Planos ──
router.get('/dojo/billing/plans', requireDojoAccess, async (req, res) => {
  try {
    const data = await svc.listPlans(req.dojoId);
    return res.json({ data, count: data.length });
  } catch (e) {
    if (e && e.code === '42P01') return res.json({ data: [], count: 0, schema_pending: true });
    console.error('[karateDojoBilling] list plans:', e.message);
    return res.status(500).json({ error: 'Erro ao listar planos' });
  }
});

router.post('/dojo/billing/plans', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validatePlanPayload(req.body, { partial: false });
  if (errors.length) return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  try {
    const plan = await svc.createPlan(req.dojoId, data);
    return res.status(201).json(plan);
  } catch (e) {
    return handleWriteError(res, e, 'create plan');
  }
});

router.patch('/dojo/billing/plans/:pid', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validatePlanPayload(req.body, { partial: true });
  if (errors.length) return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  try {
    const plan = await svc.updatePlan(req.dojoId, req.params.pid, data);
    return res.json(plan);
  } catch (e) {
    return handleWriteError(res, e, 'update plan');
  }
});

// ── Assinaturas (subscribe/unsubscribe por aluno) ──
router.post('/dojo/billing/students/:sid/subscribe', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const sub = await svc.subscribeStudent(req.dojoId, req.params.sid, req.body || {});
    return res.status(201).json(sub);
  } catch (e) {
    return handleWriteError(res, e, 'subscribe');
  }
});

router.delete('/dojo/billing/students/:sid/subscribe', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.unsubscribeStudent(req.dojoId, req.params.sid);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'unsubscribe');
  }
});

router.get('/dojo/billing/subscriptions', requireDojoAccess, async (req, res) => {
  try {
    const data = await svc.listSubscriptions(req.dojoId);
    return res.json({ data, count: data.length });
  } catch (e) {
    if (e && e.code === '42P01') return res.json({ data: [], count: 0, schema_pending: true });
    console.error('[karateDojoBilling] list subscriptions:', e.message);
    return res.status(500).json({ error: 'Erro ao listar assinaturas' });
  }
});

// ── Geração de cobranças do mês ──
router.post('/dojo/billing/generate', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.generateCharges(req.dojoId, (req.body || {}).competence);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'generate');
  }
});

// ── Cobranças (list + summary) ──
router.get('/dojo/billing/charges', requireDojoAccess, async (req, res) => {
  try {
    const competence = req.query.competence != null && String(req.query.competence).trim() !== ''
      ? String(req.query.competence).trim() : null;
    const status = ['pending', 'paid', 'overdue', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    const q = req.query.q != null && String(req.query.q).trim() !== '' ? String(req.query.q).trim() : null;
    const result = await svc.listCharges(req.dojoId, { competence, status, q });
    return res.json(result);
  } catch (e) {
    if (e && e.code === '42P01') return res.json({ data: [], summary: EMPTY_SUMMARY, schema_pending: true });
    console.error('[karateDojoBilling] list charges:', e.message);
    return res.status(500).json({ error: 'Erro ao listar cobranças' });
  }
});

// ── PIX de uma cobrança (recebedor = chave do DOJÔ) ──
router.post('/dojo/billing/charges/:cid/pix', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.createChargePix(req.dojoId, req.params.cid);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'charge pix');
  }
});

// ── Baixa manual / cancelamento ──
router.post('/dojo/billing/charges/:cid/confirm', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.confirmCharge(req.dojoId, req.params.cid, (req.body || {}).method);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'confirm charge');
  }
});

router.post('/dojo/billing/charges/:cid/cancel', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.cancelCharge(req.dojoId, req.params.cid);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'cancel charge');
  }
});

// ── Config PIX do dojô ──
router.get('/dojo/billing/config', requireDojoAccess, async (req, res) => {
  try {
    const cfg = await svc.getConfig(req.dojoId);
    return res.json(cfg);
  } catch (e) {
    if (e && e.code === '42P01') return res.json({ pix_configured: false, pix_key_masked: null, pix_key_type: null });
    console.error('[karateDojoBilling] get config:', e.message);
    return res.status(500).json({ error: 'Erro ao obter configuração de PIX' });
  }
});

router.put('/dojo/billing/config', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const cfg = await svc.putConfig(req.dojoId, req.body || {});
    return res.json(cfg);
  } catch (e) {
    return handleWriteError(res, e, 'put config');
  }
});

module.exports = router;
