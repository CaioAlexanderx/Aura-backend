// ============================================================
// AURA KARATÊ — Certificados: fluxo de pedido (Track J)
//
// DECISÃO TRACK J (substitui Track C): certificado é um PEDIDO
// com estados (Solicitado→Em produção→Impresso→Enviado|Recusado).
// Sem geração de PDF/imagem — produto físico impresso pela federação.
//
// Rotas:
//   POST   /federation/:id/certificate-orders            — dojô cria pedido
//   GET    /federation/:id/certificate-orders/mine       — dojô lista próprios
//   GET    /federation/:id/certificate-orders            — fed lista todos
//   GET    /federation/:id/certificate-orders/:orderId   — detalhe (+ timeline)
//   PATCH  /federation/:id/certificate-orders/:orderId/status — fed avança estado
//   POST   /federation/:id/certificate-orders/batch-status   — fed processa em lote
//   POST   /federation/:id/certificate-orders/:orderId/refuse — fed recusa
//
// Guards:
//   Criação (POST /)   → dojoScope (sensei / dojo_owner, ou staff da fed)
//   Avanço / lote / recusa → staffWrite (federation_admin / federation_staff)
//   Leitura (GET)     → dojoScope  (cada um vê o que lhe compete)
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { guards } = require('../config/karateRoles');
const {
  createOrder,
  getOrder,
  getOrdersByDojo,
  getOrdersByFederation,
  advanceStatus,
  batchAdvanceStatus,
  refuseOrder,
} = require('../services/karateCertificateService');

// Helper: extrai dojo_id do usuário logado
// O campo vem de company_members (via resolveKarateContext) como dojo_id
// Para staff da federação, dojo_id pode ser nulo (eles não têm dojô próprio).
function reqDojoId(req) {
  return (req.user && req.user.dojo_id) || (req.companyContext && req.companyContext.dojo_id) || null;
}

// Papéis escopados a um dojô (não à federação). Definidos por company_members.
const DOJO_SCOPED_ROLES = ['sensei', 'dojo_owner'];

// Resolve o dojo_id efetivo RESPEITANDO o escopo do chamador — o handler nunca
// confia cegamente em dojo_id do corpo/query (era o IDOR: um dojô lia/gravava
// pedidos de outro dojô via ?dojo_id= ou body):
//  - papel de dojô (sensei/dojo_owner): TRAVADO no próprio dojo_id; um dojo_id
//    diferente no corpo/query é 403.
//  - staff/owner da federação: pode mirar um dojô específico (corpo/query); a
//    posse à federação é validada no service (createOrder/getOrdersByDojo).
function resolveScopedDojoId(req, requested) {
  const own = reqDojoId(req);
  if (DOJO_SCOPED_ROLES.includes(req.companyRole)) {
    if (!own) return { error: 'NO_DOJO', message: 'Conta de dojô sem dojo_id no contexto.' };
    if (requested && String(requested) !== String(own)) {
      return { error: 'FORBIDDEN', message: 'Você só pode operar certificados do seu próprio dojô.' };
    }
    return { dojoId: own };
  }
  const target = requested || own;
  if (!target) return { error: 'MISSING', message: 'dojo_id é obrigatório.' };
  return { dojoId: target };
}

function whoOpts(req, orgName) {
  return {
    whoId:   req.user?.id   || null,
    whoName: req.user?.name || null,
    orgName: orgName || null,
  };
}

// ── POST /federation/:id/certificate-orders ──────────────────
// Dojô solicita certificado para um praticante aprovado.
router.post('/certificate-orders', ...guards.dojoScope(), async (req, res) => {
  const federationId = req.params.id;
  const {
    dojo_id, practitioner_id, belt_level, belt_name,
    exam_date, exam_ref, nome_impresso, delivery_type,
    addr_cep, addr_logradouro, addr_numero, addr_complemento, addr_cidade,
    observacao,
  } = req.body;

  if (!practitioner_id || !belt_level || !belt_name || !nome_impresso) {
    return res.status(400).json({ error: 'practitioner_id, belt_level, belt_name e nome_impresso são obrigatórios.' });
  }
  if (delivery_type === 'mail' && !addr_logradouro) {
    return res.status(400).json({ error: 'Para envio por correio, addr_logradouro é obrigatório.' });
  }

  const scoped = resolveScopedDojoId(req, dojo_id);
  if (scoped.error) {
    const code = scoped.error === 'FORBIDDEN' ? 403 : 400;
    return res.status(code).json({ error: scoped.message, code: scoped.error });
  }
  const resolvedDojoId = scoped.dojoId;

  try {
    const order = await createOrder({
      federationId,
      dojoId:          resolvedDojoId,
      practitionerId:  practitioner_id,
      beltLevel:       belt_level,
      beltName:        belt_name,
      examDate:        exam_date  || null,
      examRef:         exam_ref   || null,
      nomeImpresso:    nome_impresso,
      deliveryType:    delivery_type || 'pickup',
      addrCep:         addr_cep          || null,
      addrLogradouro:  addr_logradouro   || null,
      addrNumero:      addr_numero       || null,
      addrComplemento: addr_complemento  || null,
      addrCidade:      addr_cidade       || null,
      observacao:      observacao        || null,
      createdBy:       req.user?.id   || null,
      createdByName:   req.user?.name || null,
    });
    return res.status(201).json(order);
  } catch (err) {
    if (err.code === 'DUPLICATE_ORDER') return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'FORBIDDEN_SCOPE') return res.status(403).json({ error: err.message, code: err.code });
    if (err.code === 'TABLE_MISSING')   return res.status(503).json({ error: err.message, code: err.code });
    console.error('[karateCertificates] createOrder error:', err.message);
    return res.status(500).json({ error: 'Erro ao criar pedido de certificado.' });
  }
});

// ── GET /federation/:id/certificate-orders/mine ──────────────
// Dojô lista seus próprios pedidos.
router.get('/certificate-orders/mine', ...guards.dojoScope(), async (req, res) => {
  const federationId = req.params.id;
  const scoped = resolveScopedDojoId(req, req.query.dojo_id);
  if (scoped.error) {
    const code = scoped.error === 'FORBIDDEN' ? 403 : 400;
    return res.status(code).json({ error: scoped.message, code: scoped.error });
  }
  const dojoId = scoped.dojoId;

  try {
    const orders = await getOrdersByDojo(dojoId, federationId, {
      status:   req.query.status   || undefined,
      page:     parseInt(req.query.page)     || 1,
      pageSize: parseInt(req.query.pageSize) || 50,
    });
    return res.json({ data: orders, total: orders.length });
  } catch (err) {
    if (err.code === 'TABLE_MISSING') return res.status(503).json({ error: err.message, code: err.code });
    console.error('[karateCertificates] getOrdersByDojo error:', err.message);
    return res.status(500).json({ error: 'Erro ao listar pedidos.' });
  }
});

// ── GET /federation/:id/certificate-orders ───────────────────
// Federação lista todos os pedidos (com filtros).
router.get('/certificate-orders', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  try {
    const orders = await getOrdersByFederation(federationId, {
      status:   req.query.status   || undefined,
      q:        req.query.q        || undefined,
      page:     parseInt(req.query.page)     || 1,
      pageSize: parseInt(req.query.pageSize) || 100,
    });
    return res.json({ data: orders, total: orders.length });
  } catch (err) {
    if (err.code === 'TABLE_MISSING') return res.status(503).json({ error: err.message, code: err.code });
    console.error('[karateCertificates] getOrdersByFederation error:', err.message);
    return res.status(500).json({ error: 'Erro ao listar pedidos.' });
  }
});

// ── POST /federation/:id/certificate-orders/batch-status ──────
// Federação avança vários pedidos de uma vez.
router.post('/certificate-orders/batch-status', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const { order_ids, status } = req.body;

  if (!Array.isArray(order_ids) || !order_ids.length) {
    return res.status(400).json({ error: 'order_ids deve ser um array não-vazio.' });
  }
  if (!status) {
    return res.status(400).json({ error: 'status é obrigatório.' });
  }

  try {
    const result = await batchAdvanceStatus(order_ids, federationId, status, whoOpts(req, 'Federação'));
    return res.json(result);
  } catch (err) {
    if (err.code === 'TABLE_MISSING')   return res.status(503).json({ error: err.message });
    if (err.code === 'INVALID_STATUS') return res.status(400).json({ error: err.message });
    console.error('[karateCertificates] batchAdvanceStatus error:', err.message);
    return res.status(500).json({ error: 'Erro ao processar lote.' });
  }
});

// ── GET /federation/:id/certificate-orders/:orderId ──────────
// Detalhe de um pedido + linha do tempo.
router.get('/certificate-orders/:orderId', ...guards.dojoScope(), async (req, res) => {
  const federationId = req.params.id;
  const { orderId }  = req.params;
  try {
    const order = await getOrder(orderId, federationId);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
    return res.json(order);
  } catch (err) {
    if (err.code === 'TABLE_MISSING') return res.status(503).json({ error: err.message });
    console.error('[karateCertificates] getOrder error:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar pedido.' });
  }
});

// ── PATCH /federation/:id/certificate-orders/:orderId/status ──
// Federação avança estado de um pedido individual.
router.patch('/certificate-orders/:orderId/status', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const { orderId }  = req.params;
  const { status }   = req.body;

  if (!status) return res.status(400).json({ error: 'status é obrigatório.' });
  if (status === 'refused') {
    return res.status(400).json({ error: 'Para recusar use POST /refuse.' });
  }

  try {
    const order = await advanceStatus(orderId, federationId, status, whoOpts(req, 'Federação'));
    return res.json(order);
  } catch (err) {
    if (err.code === 'NOT_FOUND_OR_CLOSED') return res.status(409).json({ error: err.message });
    if (err.code === 'INVALID_STATUS')      return res.status(400).json({ error: err.message });
    if (err.code === 'TABLE_MISSING')       return res.status(503).json({ error: err.message });
    console.error('[karateCertificates] advanceStatus error:', err.message);
    return res.status(500).json({ error: 'Erro ao avançar estado.' });
  }
});

// ── POST /federation/:id/certificate-orders/:orderId/refuse ───
// Federação recusa um pedido (com motivo obrigatório).
router.post('/certificate-orders/:orderId/refuse', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const { orderId }  = req.params;
  const { reason }   = req.body;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'reason (motivo) é obrigatório.' });
  }

  try {
    const order = await refuseOrder(orderId, federationId, reason, whoOpts(req, 'Federação'));
    return res.json(order);
  } catch (err) {
    if (err.code === 'NOT_FOUND_OR_CLOSED') return res.status(409).json({ error: err.message });
    if (err.code === 'MISSING_REASON')      return res.status(400).json({ error: err.message });
    if (err.code === 'TABLE_MISSING')       return res.status(503).json({ error: err.message });
    console.error('[karateCertificates] refuseOrder error:', err.message);
    return res.status(500).json({ error: 'Erro ao recusar pedido.' });
  }
});

module.exports = router;
