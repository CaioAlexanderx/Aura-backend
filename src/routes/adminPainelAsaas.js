// ============================================================
// AURA. — Gestão Aura: conferência com a Asaas (13/10/2026)
//
// Montado em /admin/painel/asaas (staff).
//
// GET  /admin/painel/asaas/orfaos                  — pagamentos sem loja, com palpite de empresa
// POST /admin/painel/asaas/orfaos/:logId/vincular  — body: { company_id }
// POST /admin/painel/asaas/corrigir-vencimentos    — body: { aplicar: true } para gravar;
//                                                    sem isso é dry-run (tabela antes/depois)
//
// Nada aqui adivinha: o palpite é mostrado, vincular é decisão de quem clica.
// ============================================================
'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { listarOrfaos, vincularOrfao } = require('../services/asaasOrfaos');
const { corrigirVencimentos } = require('../services/asaasVencimentos');

const adminOnly = [requireAuth, requireRole('admin')];

router.get('/orfaos', ...adminOnly, asyncHandler(async (req, res) => {
  res.json(await listarOrfaos());
}));

router.post('/orfaos/:logId/vincular', ...adminOnly, asyncHandler(async (req, res) => {
  const r = await vincularOrfao({
    logId: req.params.logId,
    companyId: req.body && req.body.company_id,
    userId: req.user.id,
  });
  res.json({ ok: true, ...r });
}));

router.post('/corrigir-vencimentos', ...adminOnly, asyncHandler(async (req, res) => {
  const aplicar = !!(req.body && req.body.aplicar === true);
  res.json(await corrigirVencimentos({ aplicar, userId: req.user.id }));
}));

module.exports = router;
