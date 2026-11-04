// ============================================================
// AURA. — Aviso no celular de valor recebido no crediário (04/11/2026)
//
// Três rotas registram recebimento (PATCH /installments/:iid/pay,
// POST /customer/:cid/payment e POST /customers/:cid/payments) e todas
// passam por creditLedger.applyPayment. O aviso sai DEPOIS do COMMIT de
// cada uma, por aqui, para a regra ser uma só:
//   - replay idempotente (result.replayed) não avisa de novo;
//   - sem transação criada não há chave de dedupe, então não avisa;
//   - quem registrou o recebimento (userId) não recebe o aviso de si.
// Fire-and-forget: nunca segura nem derruba a resposta.
// ============================================================
'use strict';

const lojaEvents = require('../lojaEvents');

function avisarRecebimento({ companyId, customerId, result, amount, method, userId }) {
  try {
    if (!companyId || !result || result.replayed) return;
    const txId = result.transaction && result.transaction.id;
    if (!txId) return;
    lojaEvents.emit('loja_crediario_recebido', {
      id: txId,
      company_id: companyId,
      customer_id: customerId || null,
      amount: Number(amount) || 0,
      method: method || null,
      new_balance: result.new_balance,
    }, { exceto: userId || null });
  } catch (_) { /* avisar nunca derruba o recebimento */ }
}

module.exports = { avisarRecebimento };
