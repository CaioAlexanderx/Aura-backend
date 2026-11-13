// ============================================================
// AURA. — services/descontoManual.js
// Desconto manual do Caixa (contrato do seletor R$ / % do PDV):
//   { discount_type: 'fixed' | 'percent', discount_value: number }
// Os campos legados discount_amount e discount_pct continuam aceitos para que
// versoes anteriores do app possam finalizar vendas durante a atualizacao.
//
// 29/10/2026: extraido de routes/pdv.js (POST /sale) para a troca usar a
// MESMA regra (services/trocaV2.js). Comportamento identico ao de antes.
//
// 12/11/2026 (desconto manual ate 100%): o app cortava o desconto em 50% sem
// avisar (R$ 80 numa peca de R$ 139,90 virava R$ 69,95). O teto agora e o
// total (100%), com confirmacao no app acima de 50%. Aqui:
//   - % de 0 a 100 (acima de 100 continua 400; o app nunca manda);
//   - R$ maior que o subtotal vira o subtotal (antes so o teto da soma
//     cupom + manual, la no POST /sale, segurava);
//   - arredondamento ao centavo UNICO, o mesmo do app (utils/descontoManual.ts):
//     conta em centavos inteiros, meio centavo para CIMA, sem erro de ponto
//     flutuante. Antes o % era Math.round(subtotal * pct) / 100 em ponto
//     flutuante (1,15 x 10% dava 0,11, porque 1.15 * 10 = 11.4999...) e o
//     app arredondava os meios centavos para baixo — tela e gravado
//     divergiam em 1 centavo. R$ 10,05 - 10% = desconto 1,01, total 9,04.
// ============================================================

/**
 * Valor em reais -> centavos inteiros, meio centavo para cima.
 * toPrecision(15) desfaz o erro de representacao (1.005 * 100 =
 * 100.49999999999999 -> 100.5 -> 101) sem mexer em valores ja exatos.
 */
function paraCentavos(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return 0;
  const c = Number((Math.abs(n) * 100).toPrecision(15));
  const inteiro = Math.floor(c + 0.5);
  return n < 0 ? -inteiro : inteiro;
}

/** Arredonda ao centavo (meio centavo para cima). */
function aoCentavo(valor) {
  return paraCentavos(valor) / 100;
}

/**
 * Desconto em % sobre o subtotal, em reais, arredondado ao centavo.
 * Conta inteira: centavos x (pct com 4 casas) / 1.000.000, meio para cima.
 * Exata enquanto centavos x pct x 10.000 < 2^53 (subtotal ate R$ 9 bi a 100%).
 */
function descontoPercentual(subtotal, pct) {
  const centavos = paraCentavos(subtotal);
  const p = Number(pct);
  if (!(centavos > 0) || !Number.isFinite(p) || p <= 0) return 0;
  const pctE4 = Math.round(Number((Math.min(p, 100) * 10000).toPrecision(15)));
  const produto = centavos * pctE4;
  const resto = produto % 1000000;
  const desconto = (produto - resto) / 1000000 + (resto >= 500000 ? 1 : 0);
  return desconto / 100;
}

/** Desconto em R$: ao centavo e nunca acima do subtotal (100%). */
function descontoEmReais(subtotal, valor) {
  const v = aoCentavo(valor);
  const teto = aoCentavo(Math.max(0, Number(subtotal) || 0));
  return Math.min(v, teto);
}

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

    return {
      amount: body.discount_type === 'percent'
        ? descontoPercentual(subtotal, value)
        : descontoEmReais(subtotal, value),
    };
  }

  // Compatibilidade com o contrato anterior. O valor em reais prevalece se
  // os dois campos forem enviados, preservando o comportamento ja publicado.
  const amount = Number(body.discount_amount || 0);
  const pct = Number(body.discount_pct || 0);
  if (!Number.isFinite(amount) || !Number.isFinite(pct) || amount < 0 || pct < 0) {
    return { error: 'O valor do desconto deve ser um numero maior ou igual a zero.' };
  }
  if (pct > 100) return { error: 'O desconto percentual nao pode ser maior que 100%.' };
  return { amount: amount > 0 ? descontoEmReais(subtotal, amount) : descontoPercentual(subtotal, pct) };
}

module.exports = { resolveManualDiscount, paraCentavos, aoCentavo, descontoPercentual, descontoEmReais };
