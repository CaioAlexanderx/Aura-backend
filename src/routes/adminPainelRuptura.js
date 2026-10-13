// ============================================================
// AURA. — Gestão Aura: o que vai faltar, por loja (13/10/2026)
//
// Montado em /admin/painel/ruptura (staff), antes de /admin/painel.
//
// GET /admin/painel/ruptura?ate=YYYY-MM-DD&janela=14
//   Resumo por loja para o painel: quais lojas têm item que acaba antes da
//   data, quantos, quanto de venda está em risco e os 3 itens que mais pesam.
//
// Ao vivo, sem linha gravada pelo job diário: são duas consultas para todas
// as lojas de uma vez (services/ruptura.js explica a escolha). O universo é
// o mesmo dos blocos do painel — sem contas internas, só trial e ativa.
// ============================================================
'use strict';

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const { carregarEmpresas } = require('../services/painelBlocos/_base');
const { calcularRupturaPorLoja, normalizarParametros } = require('../services/ruptura');

const adminOnly = [requireAuth, requireRole('admin')];

router.get('/', ...adminOnly, asyncHandler(async (req, res) => {
  let parametros;
  try {
    parametros = normalizarParametros({ ate: req.query.ate, janela: req.query.janela });
  } catch (err) {
    throw new AppError(err.message, 400);
  }
  const { lista } = await carregarEmpresas(pool);
  const resultado = await calcularRupturaPorLoja({
    empresas: lista,
    ate: parametros.ate,
    janelaDias: parametros.janelaDias,
    hoje: parametros.hoje,
  });
  res.json(resultado);
}));

module.exports = router;
