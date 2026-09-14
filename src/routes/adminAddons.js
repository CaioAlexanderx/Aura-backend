// ============================================================
// AURA — Gestão Aura: ADICIONAIS do cliente (company_addons, 328)
//
//   GET /admin/clients/:cid/addons        — o que a empresa tem hoje
//   PUT /admin/clients/:cid/addons/:key   — liga/desliga um adicional
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

module.exports = router;
