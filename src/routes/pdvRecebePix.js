// ============================================================
// AURA. — Caixa: Pix pelo Recebe na Aura, com confirmação (RA-10, 25/11/2026)
//
// Montado em routes/private.js sob /companies/:id/pdv (requireAuth +
// requireCompanyAccess já rodaram; a empresa é sempre a da URL — multi-CNPJ:
// cada loja cobra na sua subconta).
//
//   GET    /pdv/recebe-pix/disponivel        { disponivel, motivo }
//          O Caixa só oferece "Pix pelo Recebe" com disponivel = true. Flag
//          desligada: { disponivel:false, motivo:'indisponivel' }, sem banco.
//   GET    /pdv/recebe-pix?situacao=aguardando|atencao   lista da loja
//   POST   /pdv/sale/:saleId/recebe-pix      cria (ou devolve) a cobrança Pix
//          da parte Pix da venda. body opcional: { customer: { name, cpf_cnpj } }
//          201 criada · 200 já existia (reused)
//   GET    /pdv/sale/:saleId/recebe-pix      situação (polling curto; só banco)
//   DELETE /pdv/sale/:saleId/recebe-pix      a lojista desistiu: cancela na
//          Asaas; a venda não é confirmada nem cancelada
//
// Fora as de disponibilidade, flag desligada → 404 RECEBE_INDISPONIVEL. A
// lógica mora em services/recebeVendaPix.js.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const svc = require('../services/recebeVendaPix');

function sendError(res, e, ctx) {
  if (e && e.status && e.code) {
    return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) });
  }
  console.error(`[pdvRecebePix] ${ctx}:`, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
}

router.get('/recebe-pix/disponivel', async (req, res) => {
  try {
    return res.json(await svc.disponibilidade(req.params.id));
  } catch (e) {
    return sendError(res, e, 'disponivel');
  }
});

router.get('/recebe-pix', async (req, res) => {
  try {
    return res.json(await svc.listar(req.params.id, req.query.situacao));
  } catch (e) {
    return sendError(res, e, 'listar');
  }
});

router.post('/sale/:saleId/recebe-pix', async (req, res) => {
  try {
    const out = await svc.criar(req.params.id, req.params.saleId, req.body || {}, req.user && req.user.id);
    return res.status(out.reused ? 200 : 201).json(out);
  } catch (e) {
    return sendError(res, e, 'criar');
  }
});

router.get('/sale/:saleId/recebe-pix', async (req, res) => {
  try {
    return res.json(await svc.consultar(req.params.id, req.params.saleId));
  } catch (e) {
    return sendError(res, e, 'consultar');
  }
});

router.delete('/sale/:saleId/recebe-pix', async (req, res) => {
  try {
    return res.json(await svc.cancelar(req.params.id, req.params.saleId, req.user && req.user.id));
  } catch (e) {
    return sendError(res, e, 'cancelar');
  }
});

module.exports = router;
