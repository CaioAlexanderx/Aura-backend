// ============================================================
// AURA. — Gestão Aura: lançamento mensal de custos (18/10/2026, card f5-06)
//
// Montado em /admin/painel/custos. Só equipe Aura: user.role === 'admin'
// (requireRole). O papel do membro na empresa (companyRole 'admin') NÃO vale.
//
// GET  /admin/painel/custos?mes=YYYY-MM  — o mês para o formulário (padrão: o corrente)
// POST /admin/painel/custos              — lança ou corrige categorias de um mês
//      { mes: 'YYYY-MM',
//        categorias: { infraestrutura: { valor, origem, observacao? }, ... },
//        motivo? }
//      categorias: infraestrutura | anthropic | meta | outros | demais
//      origem:     empresa | socio | estimativa
//      valor >= 0, até 2 casas. Categoria que não veio fica como está.
//
// Grava em aura_revenue_snapshot (custos_detalhe, total_costs, gross_margin)
// e em admin_audit_log (action 'set_monthly_cost'). Regras e SQL em
// services/custosMensais.js. Depois de gravar, o bloco Custos do dia é
// recalculado para a tela não esperar o job das 06h.
// ============================================================
'use strict';

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const custos = require('../services/custosMensais');
const painel = require('../services/painelDiario');

const adminOnly = [requireAuth, requireRole('admin')];

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const PENDENTE = {
  error: 'Lançamento de custos indisponível (migration 382 pendente).',
  code: 'MIGRATION_PENDING',
};
const migrationPendente = (err) => !!err && (err.code === '42703' || err.code === '42P01');

// Regrava o bloco Custos de hoje, se o dia já foi calculado. Dia sem linha
// fica como está: gravar só este bloco faria /hoje mostrar só ele. Falha aqui
// não desfaz o lançamento (já gravado): a tela recebe painel_atualizado false
// e o job das 06h corrige.
async function atualizarBlocoDoDia() {
  try {
    const hoje = painel.hojeBRT();
    const { rows } = await pool.query(
      'SELECT 1 FROM painel_blocos_diarios WHERE dia = $1::date LIMIT 1',
      [hoje]
    );
    if (!rows.length) return false;
    const { resultados, erros } = await painel.calcularBlocos({ hoje, ids: ['custos'] });
    if (erros.length || !resultados.custos) return false;
    await painel.aplicarVariacao({ hoje, resultados });
    await painel.gravarBlocos({ hoje, resultados });
    return true;
  } catch (err) {
    console.error('[painel] bloco custos não regravado depois do lançamento:', err.message);
    return false;
  }
}

router.get('/', ...adminOnly, asyncHandler(async (req, res) => {
  const hoje = painel.hojeBRT();
  let mes = req.query.mes;
  if (mes === undefined || mes === '') mes = custos.mesDe(hoje);
  else if (typeof mes !== 'string' || !MES_RE.test(mes)) throw new AppError('mes deve ser YYYY-MM', 400);

  let linha;
  try {
    linha = await custos.lerMes({ db: pool, mes });
  } catch (err) {
    if (migrationPendente(err)) return res.status(503).json(PENDENTE);
    throw err;
  }
  res.json(custos.formularioDoMes(mes, linha));
}));

router.post('/', ...adminOnly, asyncHandler(async (req, res) => {
  const hoje = painel.hojeBRT();
  const { erro, valor } = custos.normalizarLancamento(req.body, { hoje });
  if (erro) return res.status(400).json({ error: erro, code: 'CUSTO_INVALIDO' });

  let r;
  try {
    r = await custos.lancarCustos({ db: pool, staffUserId: req.user.id, lancamento: valor });
  } catch (err) {
    if (migrationPendente(err)) return res.status(503).json(PENDENTE);
    throw err;
  }
  const painelAtualizado = await atualizarBlocoDoDia();
  res.status(r.criou_linha ? 201 : 200).json({
    ...custos.formularioDoMes(valor.mes, r.depois),
    criou_linha: r.criou_linha,
    painel_atualizado: painelAtualizado,
  });
}));

module.exports = router;
