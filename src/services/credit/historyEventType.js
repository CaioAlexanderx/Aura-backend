// ============================================================
// AURA. — Tipo de evento de um lançamento do crediário
//
// Extraído de GET /credit/customers/:cid/history (credit.js, B1) para a
// linha do tempo da ficha do cliente (Fase 1) usar a MESMA classificação:
//   debit   + sale_id              -> purchase
//   debit   sem sale_id            -> manual_debit
//   refund                         -> refund
//   payment + crediario_credito    -> exchange_credit (crédito vindo de troca)
//   payment (demais)               -> payment
//   debit   + credito_cliente      -> credit_use (credito usado numa venda
//                                     do Caixa, INC-2026-11-17-03)
// Valor com sinal: débito positivo, pagamento/crédito/estorno negativo.
// ============================================================
'use strict';

function creditHistoryEventType(row) {
  if (row.type === 'debit') {
    if (row.payment_method === 'credito_cliente') return 'credit_use';
    return row.sale_id ? 'purchase' : 'manual_debit';
  }
  if (row.type === 'refund') return 'refund';
  return row.payment_method === 'crediario_credito' ? 'exchange_credit' : 'payment';
}

function creditHistorySignedAmount(row) {
  const amount = parseFloat(row.amount) || 0;
  return row.type === 'debit' ? amount : parseFloat((-amount).toFixed(2));
}

module.exports = { creditHistoryEventType, creditHistorySignedAmount };
