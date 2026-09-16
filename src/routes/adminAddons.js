// ============================================================
// AURA — Gestão Aura: ADICIONAIS do cliente (company_addons, 328)
//
//   GET  /admin/clients/:cid/addons              — o que a empresa tem hoje
//   PUT  /admin/clients/:cid/addons/:key         — liga/desliga um adicional
//   POST /admin/clients/:cid/marketing-packs     — libera um pacote de marketing
//   PUT  /admin/clients/:cid/marketing-quota     — cota mensal fora do padrão
//
// Quem contrata o adicional hoje fala com a Aura (não há autosserviço),
// então a ativação é operação de staff — mesmo `adminOnly` do admin.js.
// Quando o Asaas passar a cobrar o adicional sozinho, o webhook chama o
// MESMO serviço com source='asaas'.
// ============================================================
'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const addons = require('../services/addons');
const quota = require('../services/marketing/marketingQuota');

const adminOnly = [requireAuth, requireRole('admin')];

router.get('/clients/:cid/addons', ...adminOnly, asyncHandler(async (req, res) => {
  const data = await addons.listAddons(req.params.cid);
  res.json({ data });
}));

router.put('/clients/:cid/addons/:key', ...adminOnly, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.active === undefined || b.active === null) {
    return res.status(422).json({ error: 'active (true/false) é obrigatório', code: 'VALIDATION_ERROR' });
  }
  const active = b.active === true || b.active === 'true';

  let priceCents = null;
  if (b.price_cents !== undefined && b.price_cents !== null && b.price_cents !== '') {
    priceCents = Number(b.price_cents);
    if (!Number.isInteger(priceCents) || priceCents < 0) {
      return res.status(422).json({ error: 'price_cents deve ser um inteiro em centavos', code: 'VALIDATION_ERROR' });
    }
  }

  const row = await addons.setAddon(req.params.cid, req.params.key, {
    active,
    priceCents,
    source: 'admin',
    notes: b.notes != null && String(b.notes).trim() !== '' ? String(b.notes).slice(0, 500) : null,
  });
  // 328 pendente: dizer "não deu" é melhor do que devolver 200 com um
  // adicional que não existe em lugar nenhum.
  if (!row) {
    return res.status(503).json({ error: 'Adicionais ainda não disponíveis (migration 328 pendente)', code: 'SCHEMA_PENDING' });
  }
  res.json(row);
}));

// ── FASE 8b: cota de marketing e pacotes pela Gestão Aura ───
// Os dois caminhos que existem quando o autosserviço não serve: o
// lojista pagou por fora (pix na mão, cortesia, troca por indicação) e
// o cliente que negociou uma cota maior do que a do plano. O que a Aura
// faz aqui é exatamente o que o webhook do Asaas faria — mesma tabela,
// mesmo serviço — só que com `source='admin'` gravado, para o relatório
// de receita não confundir pacote vendido com pacote cortesia.

// POST /admin/clients/:cid/marketing-packs  { qty, activate }
router.post('/clients/:cid/marketing-packs', ...adminOnly, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const qty = b.qty === undefined || b.qty === null || b.qty === '' ? quota.PACK_QTY : Number(b.qty);
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(422).json({ error: 'qty deve ser um inteiro positivo', code: 'VALIDATION_ERROR' });
  }
  let priceCents = quota.PACK_PRICE_CENTS;
  if (b.price_cents !== undefined && b.price_cents !== null && b.price_cents !== '') {
    priceCents = Number(b.price_cents);
    if (!Number.isInteger(priceCents) || priceCents < 0) {
      return res.status(422).json({ error: 'price_cents deve ser um inteiro em centavos', code: 'VALIDATION_ERROR' });
    }
  }
  // Default `true`: quem abre esta rota está resolvendo o caso de alguém
  // que JÁ pagou. Deixar pendente por omissão só criaria um segundo
  // clique para o mesmo atendimento.
  const activate = b.activate === undefined ? true : (b.activate === true || b.activate === 'true');

  const pack = await quota.createPack(req.params.cid, {
    qty,
    priceCents,
    status: activate ? 'active' : 'pending',
    source: 'admin',
    createdBy: (req.user && req.user.id) || null,
  });
  if (!pack) {
    return res.status(503).json({ error: 'Pacotes de mensagens ainda não disponíveis (migration 332 pendente)', code: 'SCHEMA_PENDING' });
  }
  res.json(pack);
}));

// PUT /admin/clients/:cid/marketing-quota  { quota }
// `quota: null` devolve a empresa ao padrão do plano — é o desfazer
// desta rota, e sem ele a exceção comercial seria permanente.
router.put('/clients/:cid/marketing-quota', ...adminOnly, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.quota === undefined) {
    return res.status(422).json({ error: 'quota (inteiro ou null) é obrigatório', code: 'VALIDATION_ERROR' });
  }
  let valor = null;
  if (b.quota !== null && b.quota !== '') {
    valor = Number(b.quota);
    if (!Number.isInteger(valor) || valor < 0) {
      return res.status(422).json({ error: 'quota deve ser um inteiro >= 0 ou null', code: 'VALIDATION_ERROR' });
    }
  }
  const ok = await quota.setCompanyQuota(req.params.cid, valor);
  if (!ok) {
    return res.status(503).json({ error: 'Cota de marketing ainda não disponível (migration 332 pendente)', code: 'SCHEMA_PENDING' });
  }
  const status = await quota.marketingStatus(req.params.cid);
  res.json({ quota: valor, usage: status });
}));

module.exports = router;
