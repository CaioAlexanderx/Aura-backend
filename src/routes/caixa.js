// ============================================================
// AURA. — Módulo de Caixa
//
// GET  /companies/:id/caixa/status          — status ao vivo
// POST /companies/:id/caixa/abrir           — abrir sessão
// POST /companies/:id/caixa/fechar          — fechar sessão
// GET  /companies/:id/caixa/historico       — sessões fechadas
// GET  /companies/:id/caixa/sessao/:sessaoId — detalhe de uma sessão
//
// Pré-requisito: caixa habilitado em pdv_settings.caixa_enabled = true
// ============================================================

const router = require('express').Router({ mergeParams: true });
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const caixaService = require('../services/caixaService');

// ── GET /caixa/status ─────────────────────────────────────────────────────
// Retorna a sessão aberta atual com totais ao vivo, ou { sessao_ativa: null }.
router.get('/status', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const result = await caixaService.getStatus(companyId);
  res.json(result);
}));

// ── POST /caixa/abrir ─────────────────────────────────────────────────────
// Body: { troco_inicial?: number }
// Abre nova sessão. Rejeita com 409 se já há uma sessão aberta.
router.post('/abrir', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const userId    = req.user.id;
  const { troco_inicial = 0 } = req.body || {};

  if (typeof troco_inicial !== 'number' || troco_inicial < 0) {
    throw new AppError('troco_inicial deve ser um número >= 0', 400);
  }

  const sessao = await caixaService.abrir(companyId, userId, troco_inicial);
  res.status(201).json({ sessao });
}));

// ── POST /caixa/fechar ────────────────────────────────────────────────────
// Body: { dinheiro_contado: number, observacao?: string }
// Fecha a sessão aberta. Cria o snapshot em caixa_fechamentos.
router.post('/fechar', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const userId    = req.user.id;
  const { dinheiro_contado, observacao } = req.body || {};

  if (dinheiro_contado === undefined || dinheiro_contado === null) {
    throw new AppError('dinheiro_contado é obrigatório', 400);
  }
  if (typeof dinheiro_contado !== 'number' || dinheiro_contado < 0) {
    throw new AppError('dinheiro_contado deve ser um número >= 0', 400);
  }
  if (observacao !== undefined && typeof observacao !== 'string') {
    throw new AppError('observacao deve ser uma string', 400);
  }

  const fechamento = await caixaService.fechar(
    companyId,
    userId,
    dinheiro_contado,
    observacao || null
  );

  res.json({ fechamento });
}));

// ── GET /caixa/historico ──────────────────────────────────────────────────
// Query params: limit, offset, de (ISO date), ate (ISO date)
router.get('/historico', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 100);
  const offset = parseInt(req.query.offset || '0', 10);
  const de  = req.query.de  || null;
  const ate = req.query.ate || null;

  const result = await caixaService.getHistorico(companyId, { limit, offset, de, ate });
  res.json(result);
}));

// ── GET /caixa/sessao/:sessaoId ───────────────────────────────────────────
// Detalhe de uma sessão específica (aberta ou fechada).
router.get('/sessao/:sessaoId', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const sessaoId  = req.params.sessaoId;

  const sessao = await caixaService.getSessao(companyId, sessaoId);
  res.json({ sessao });
}));

module.exports = router;
