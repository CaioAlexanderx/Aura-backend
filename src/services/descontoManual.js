// ============================================================
// AURA. — services/descontoManual.js
// Desconto manual do Caixa (contrato do seletor R$ / % do PDV):
//   { discount_type: 'fixed' | 'percent', discount_value: number }
// Os campos legados discount_amount e discount_pct continuam aceitos para que
// versoes anteriores do app possam finalizar vendas durante a atualizacao.
//
// 29/10/2026: extraido de routes/pdv.js (POST /sale) para a troca usar a
// MESMA regra (services/trocaV2.js). Comportamento identico ao de antes.
// ============================================================

function resolveManualDiscount(body, subtotal) {
  const hasType = body.discount_type !== undefined;
  const hasValue = body.discount_value !== undefined;
  if (hasType || hasValue) {
    if (!hasType || !hasValue || !['fixed', 'percent'].includes(body.discount_type)) {
      return { error: 'Informe o tipo (R$ ou %) e o valor do desconto.' };
    }

    const value = Number(body.discount_value);
    if (!Number.isFinite(value) || value < 0) {
      return { error: 'O valor do desconto deve ser um numero maior ou igual a zero.' };
    }
    if (body.discount_type === 'percent' && value > 100) {
      return { error: 'O desconto percentual nao pode ser maior que 100%.' };
    }

    const amount = body.discount_type === 'percent'
      ? Math.round(subtotal * value) / 100
      : value;
    return { amount: Math.round(amount * 100) / 100 };
  }

  // Compatibilidade com o contrato anterior. O valor em reais prevalece se
  // os dois campos forem enviados, preservando o comportamento ja publicado.
  const amount = Number(body.discount_amount || 0);
  const pct = Number(body.discount_pct || 0);
  if (!Number.isFinite(amount) || !Number.isFinite(pct) || amount < 0 || pct < 0) {
    return { error: 'O valor do desconto deve ser um numero maior ou igual a zero.' };
  }
  if (pct > 100) return { error: 'O desconto percentual nao pode ser maior que 100%.' };
  return { amount: amount > 0 ? amount : Math.round(subtotal * pct) / 100 };
}

module.exports = { resolveManualDiscount };
