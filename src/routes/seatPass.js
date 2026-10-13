// ============================================================
// AURA. — Assento de temporada (13/10/2026)
//
// Montada em /companies/:id/billing/seat-pass (routes/private.js; mergeParams).
//
//   GET    /                estado: passes, validade, valor, se ainda da pra
//                           contratar. ?qty=N devolve tambem a `previa` do
//                           que seria cobrado para N assentos.
//   POST   /   { qty }      contrata (so o dono da empresa; admin tambem).
//   DELETE /:id             cancela (dono/admin). Assento sai na hora; o valor
//                           da assinatura volta nas proximas mensalidades.
//
// A regra, o SQL e a cobranca na Asaas vivem em services/seatPass.js; as
// datas, em services/temporada.js. A concessao pela Gestao Aura (cortesia) e'
// POST /admin/clients/:cid/seat-pass (routes/adminClients360.js).
// ============================================================
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireAuth } = require('../middleware/auth');
const seatPass = require('../services/seatPass');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Staff da Aura (usuario admin da plataforma). Nao confundir com um membro
// da empresa cujo role_label seja "admin": requireCompanyAccess tambem poe
// 'admin' em req.companyRole nesse caso.
function ehStaff(req) {
  return !!(req.user && req.user.role === 'admin');
}

// Contratar e cancelar mexem em cobranca: so o dono da empresa (ou a Aura).
function soDono(req, res, next) {
  if (req.companyRole === 'owner' || ehStaff(req)) {
    return next();
  }
  return res.status(403).json({
    error: 'Só o dono da empresa pode contratar ou cancelar o assento de temporada.',
    code: 'SOMENTE_DONO',
  });
}

function falhou(res, err, rotulo) {
  if (seatPass.enviarErro(res, err)) return;
  console.error('[seatPass] ' + rotulo + ':', err && err.message);
  res.status(500).json({ error: 'Erro ao processar o assento de temporada' });
}

router.get('/', requireAuth, async (req, res) => {
  try {
    res.json(await seatPass.estado(req.params.id, { previaQty: req.query.qty }));
  } catch (err) { falhou(res, err, 'GET'); }
});

router.post('/', requireAuth, soDono, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await seatPass.contratar({
      companyId: req.params.id,
      qty: body.qty,
      source: 'loja',
      userId: req.user && req.user.id,
    });
    res.status(201).json(out);
  } catch (err) { falhou(res, err, 'POST'); }
});

router.delete('/:passId', requireAuth, soDono, async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.passId))) {
      return res.status(404).json({ error: 'Assento de temporada não encontrado', code: 'PASSE_NAO_ENCONTRADO' });
    }
    res.json(await seatPass.cancelar({
      companyId: req.params.id,
      passId: req.params.passId,
      userId: req.user && req.user.id,
      source: ehStaff(req) ? 'admin' : 'loja',
    }));
  } catch (err) { falhou(res, err, 'DELETE'); }
});

module.exports = router;
