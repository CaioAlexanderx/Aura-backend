// ============================================================
// AURA. — Pagar na entrega com forma escolhida e troco (tq-44, 29/10/2026)
//
// Desenho aprovado pela Nina em 19/10 (piloto: uma adega). A loja escolhe
// quais formas aceita na porta: dinheiro (com troco), cartao na maquina e
// Pix na hora. A cliente escolhe UMA no checkout.
//
// QUEM ENTRA NO FLUXO NOVO: so a loja com "pagar na entrega" ligado E pelo
// menos uma forma marcada (digital_channel_config.pay_on_delivery_methods,
// migration 417). Loja com a lista vazia ou nula continua no fluxo de hoje
// (um botao "Pagar na entrega", pedido nasce confirmado) — inclusive as que
// ja tinham "pagar na entrega" ligado antes deste card. Elas so mudam se a
// lojista marcar as formas no painel.
//
// NO FLUXO NOVO o pedido nasce 'aguardando_aceite': sem baixa de estoque e
// sem lancamento. Quem baixa e lanca e o ACEITE (services/aceiteDoPedido.js),
// e o lancamento nasce "a receber" na forma escolhida, quitado quando a
// lojista marca entregue.
//
// Aqui so regra pura (sem banco): a rota e o teste usam as mesmas funcoes.
// ============================================================
'use strict';

/** As formas, na ordem em que aparecem na vitrine e no painel. */
const FORMAS = ['cash', 'card', 'pix'];

/** O status do pedido que espera a lojista aceitar. */
const AGUARDANDO_ACEITE = 'aguardando_aceite';

/** Como cada forma aparece para a lojista e para a cliente. */
const ROTULOS = {
  cash: 'Dinheiro',
  card: 'Cartão na máquina',
  pix: 'Pix na hora',
};

/** payment_method do lancamento no Financeiro (o mesmo texto do Caixa). */
const FORMA_NO_FINANCEIRO = {
  cash: 'dinheiro',
  card: 'cartao',
  pix: 'pix',
};

/**
 * Lista crua (text[], JSON em texto, array) -> formas validas, sem
 * repeticao, na ordem de FORMAS. Qualquer outra coisa vira [].
 */
function normalizarFormas(bruto) {
  let lista = bruto;
  if (typeof lista === 'string') {
    const t = lista.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      // text[] lido como texto ("{cash,card}")
      lista = t.slice(1, -1).split(',').map((s) => s.replace(/"/g, '').trim());
    } else {
      try { lista = JSON.parse(t); } catch (_) { lista = t.split(','); }
    }
  }
  if (!Array.isArray(lista)) return [];
  const marcadas = new Set(lista.map((f) => String(f || '').trim().toLowerCase()));
  return FORMAS.filter((f) => marcadas.has(f));
}

/**
 * As formas de pagar na entrega que a loja oferece no fluxo novo.
 * [] = a loja nao esta no fluxo novo (desligada, ou ligada sem formas).
 */
function formasDaLoja(config) {
  if (!config || !config.pay_on_delivery_enabled) return [];
  return normalizarFormas(config.pay_on_delivery_methods);
}

/** A loja usa o fluxo novo (pedido espera o aceite)? */
function usaFluxoComAceite(config) {
  return formasDaLoja(config).length > 0;
}

/**
 * O que o painel manda no PUT -> o que se grava. Lista vazia grava NULL,
 * que e o "fluxo de hoje". undefined = o corpo nao falou do campo.
 */
function formasParaGravar(bruto) {
  if (bruto === undefined) return undefined;
  if (bruto === null) return null;
  const formas = normalizarFormas(bruto);
  return formas.length ? formas : null;
}

function reais(n) {
  return 'R$ ' + Number(n).toFixed(2).replace('.', ',');
}

/**
 * Confere a forma e o troco que a cliente mandou no checkout.
 *
 * @param {{ formas: string[], forma: any, trocoPara: any, total: number }} p
 * @returns {{ erro: string } | { forma: string, trocoPara: number|null }}
 */
function conferirPagamentoNaEntrega({ formas, forma, trocoPara, total }) {
  const f = String(forma || '').trim().toLowerCase();
  if (!f) {
    return { erro: 'Escolha como você vai pagar na entrega: ' + formas.map((x) => ROTULOS[x].toLowerCase()).join(', ') + '.' };
  }
  if (!formas.includes(f)) {
    return { erro: 'Esta loja não recebe ' + (ROTULOS[f] ? ROTULOS[f].toLowerCase() : 'essa forma') + ' na entrega. Escolha outra forma.' };
  }
  const vazio = trocoPara === undefined || trocoPara === null || trocoPara === '' || trocoPara === 0 || trocoPara === '0';
  if (vazio) return { forma: f, trocoPara: null };
  if (f !== 'cash') {
    // Troco so existe no dinheiro. Cartao e Pix com valor de troco e
    // pagina velha ou corpo montado a mao: ignora, sem barrar o pedido.
    return { forma: f, trocoPara: null };
  }
  const valor = Number(String(trocoPara).replace(',', '.'));
  if (!Number.isFinite(valor) || valor < 0) {
    return { erro: 'Não entendemos o valor do troco. Confira e tente de novo.' };
  }
  const t = Math.round(Number(total) * 100) / 100;
  if (valor + 0.001 < t) {
    return { erro: 'O valor para troco precisa ser maior que o total do pedido (' + reais(t) + ').' };
  }
  // Exatamente o total: nao ha troco a levar.
  if (Math.abs(valor - t) < 0.005) return { forma: f, trocoPara: null };
  if (valor > 100000) {
    return { erro: 'Não entendemos o valor do troco. Confira e tente de novo.' };
  }
  return { forma: f, trocoPara: Math.round(valor * 100) / 100 };
}

/** Quanto o entregador leva de troco (null = nao leva). */
function trocoALevar(order) {
  if (!order || order.pay_on_delivery_method !== 'cash' || order.change_for == null) return null;
  const troco = Math.round((Number(order.change_for) - Number(order.total)) * 100) / 100;
  return troco > 0 ? troco : null;
}

/**
 * A frase do pagamento para a lojista: "Dinheiro. A cliente paga com
 * R$ 100,00: levar R$ 22,00 de troco." Sem forma escolhida = null.
 */
function fraseDoPagamento(order) {
  if (!order || !order.pay_on_delivery_method) return null;
  const rotulo = ROTULOS[order.pay_on_delivery_method];
  if (!rotulo) return null;
  if (order.pay_on_delivery_method !== 'cash') return rotulo + ' na entrega.';
  const troco = trocoALevar(order);
  if (troco == null) return 'Dinheiro, sem troco.';
  return 'Dinheiro. Paga com ' + reais(order.change_for) + ': levar ' + reais(troco) + ' de troco.';
}

/** O pedido e do fluxo novo (pagar na entrega com forma escolhida)? */
function pedidoComAceite(order) {
  return !!(order && order.payment_method === 'on_delivery' && order.pay_on_delivery_method);
}

module.exports = {
  FORMAS, ROTULOS, FORMA_NO_FINANCEIRO, AGUARDANDO_ACEITE,
  normalizarFormas, formasDaLoja, usaFluxoComAceite, formasParaGravar,
  conferirPagamentoNaEntrega, trocoALevar, fraseDoPagamento, pedidoComAceite,
};
