// =============================================================
// AURA. -- Servico unificado de credito (Ledger) -- BARREL
// Re-exporta a API publica. A implementacao foi decomposta em
// services/credit/{terms,lateCharges,score,ledger}.js
// (refactor 11/06/2026). API IDENTICA a anterior: nenhum chamador muda.
//
// REGRA DE NEGOCIO (imutavel): score baixo NUNCA bloqueia a venda.
// Score so gera AVISO. O UNICO impeditivo e o bloqueio MANUAL
// do cliente (profile.status === 'blocked').
// =============================================================

const terms       = require('./credit/terms');
const lateCharges = require('./credit/lateCharges');
const score       = require('./credit/score');
const ledger      = require('./credit/ledger');

module.exports = {
  createCreditSale:         ledger.createCreditSale,
  applyPayment:             ledger.applyPayment,
  cancelCreditSale:         ledger.cancelCreditSale,
  getCustomerCreditPreview: ledger.getCustomerCreditPreview,
  resolveTerms:             terms.resolveTerms,
  scoreLabel:               score.scoreLabel,
  scoreWarning:             score.scoreWarning,
  computeLateCharges:       lateCharges.computeLateCharges,
  round2:                   terms.round2,
  LATE_FEE_MAX:             terms.LATE_FEE_MAX,
  LATE_INTEREST_DAILY_MAX:  terms.LATE_INTEREST_DAILY_MAX,
  MAX_INSTALLMENTS_CEILING: terms.MAX_INSTALLMENTS_CEILING,
  _recalculateScore:        score._recalculateScore,
  _updateCreditUsed:        ledger._updateCreditUsed,
  _getOrCreateProfile:      ledger._getOrCreateProfile,
  _getOrCreatePlanConfig:   ledger._getOrCreatePlanConfig,
  resolvePeriod:            terms.resolvePeriod,
  dueDateForIndex:          terms.dueDateForIndex,
  // Item 3 (13/06/2026): unificacao de carne
  computeUnifyPlan:         require('./credit/unify').computeUnifyPlan,
  applyUnify:               ledger.applyUnify,
};
