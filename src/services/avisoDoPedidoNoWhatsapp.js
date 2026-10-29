// ============================================================
// AURA. — Aviso a cliente pelo WhatsApp da lojista, em cada passo do
// pedido da loja online (tq-47, 29/10/2026 — desenho da Nina, 19/10)
//
// Ate o numero da Aura entrar na API do WhatsApp (f3-01), quem avisa a
// cliente e a propria lojista, com um toque: o painel abre o wa.me para o
// numero da cliente com o texto pronto. Aqui so o texto e o link — nada e
// enviado pelo servidor.
//
// Passos: aceito (com o tempo), recusado (com o motivo), saiu para
// entrega (com a forma de pagar e o troco), entregue. Texto em tom humano,
// na voz da loja, sem menu e sem cara de robo.
// ============================================================
'use strict';

const { numeroDoWhatsapp } = require('./whatsappDaLoja');
const { trocoALevar } = require('./pagarNaEntrega');

function reais(n) {
  return 'R$ ' + Number(n).toFixed(2).replace('.', ',');
}

/** "Maria Clara Souza" -> "Maria". Vazio -> ''. */
function primeiroNome(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0] || '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
}

function saudacao(order) {
  const nome = primeiroNome(order.customer_name);
  return nome ? `Oi, ${nome}!` : 'Oi!';
}

/** O pagamento como a cliente le no "saiu para entrega". '' = ja pago. */
function fraseDoPagamentoParaCliente(order) {
  if (order.payment_method !== 'on_delivery') return '';
  const total = reais(order.total);
  switch (order.pay_on_delivery_method) {
    case 'cash': {
      const troco = trocoALevar(order);
      return troco
        ? `O pagamento é em dinheiro: ${total}. O entregador leva troco para ${reais(order.change_for)}.`
        : `O pagamento é em dinheiro: ${total}.`;
    }
    case 'card': return `O entregador leva a maquininha. O total é ${total}.`;
    case 'pix': return `Você paga com Pix quando ele chegar. O total é ${total}.`;
    default: return `O pagamento é na entrega: ${total}.`;
  }
}

/** O passo que o status atual do pedido representa (null = nenhum). */
function passoDoPedido(order) {
  if (!order) return null;
  switch (order.status) {
    case 'preparing':
    case 'ready':
      return order.accepted_at ? 'aceito' : null;
    case 'out_for_delivery': return 'saiu';
    case 'delivered': return 'entregue';
    case 'cancelled': return order.cancel_kind === 'recusado_pela_loja' ? 'recusado' : null;
    default: return null;
  }
}

/**
 * O texto pronto de um passo.
 * @param {'aceito'|'recusado'|'saiu'|'entregue'} passo
 * @param {object} order linha de digital_orders
 * @param {{ loja?: string, reembolso?: boolean }} [opts]
 */
function mensagemDoPasso(passo, order, { loja = '', reembolso = false } = {}) {
  const n = order.order_number != null ? `#${order.order_number}` : '';
  const daLoja = loja ? ` Aqui é da ${loja}.` : '';
  const entrega = order.delivery_type === 'delivery';
  switch (passo) {
    case 'aceito': {
      const min = Number(order.prep_minutes) || 0;
      const prazo = min
        ? (entrega
          ? ` A previsão é de uns ${min} minutos para chegar aí.`
          : ` Fica pronto para retirar em uns ${min} minutos.`)
        : '';
      return `${saudacao(order)}${daLoja} Recebemos o seu pedido ${n} e já estamos preparando.${prazo} Obrigado pela preferência!`;
    }
    case 'recusado': {
      const motivo = order.cancel_reason ? ` (${String(order.cancel_reason).trim()})` : '';
      const devolve = reembolso ? ' Vamos devolver o valor que você pagou.' : '';
      return `${saudacao(order)}${daLoja} Infelizmente não vamos conseguir atender o seu pedido ${n} agora${motivo}.${devolve} Desculpe pelo transtorno, esperamos te atender numa próxima.`;
    }
    case 'saiu': {
      const pagar = fraseDoPagamentoParaCliente(order);
      return `${saudacao(order)} O seu pedido ${n}${loja ? ` da ${loja}` : ''} saiu para entrega e já está a caminho.${pagar ? ' ' + pagar : ''}`;
    }
    case 'entregue':
      return `${saudacao(order)} Obrigado pela compra${loja ? ` na ${loja}` : ''}. Qualquer coisa sobre o pedido ${n}, é só chamar aqui.`;
    default:
      return '';
  }
}

/** Pagou online (Pix/cartao confirmado) e o pedido foi recusado: devolver por fora. */
function precisaDevolver(order) {
  if (!order || order.status !== 'cancelled') return false;
  if (order.payment_method !== 'pix' && order.payment_method !== 'card') return false;
  return ['confirmed', 'paid', 'received'].includes(String(order.payment_status || '').toLowerCase());
}

/**
 * { passo, texto, link } do passo pedido (ou do status atual), ou null.
 * link = wa.me para o numero da CLIENTE com o texto; null sem telefone.
 */
function avisoDoPedido(order, { loja = '', passo } = {}) {
  const p = passo || passoDoPedido(order);
  if (!p) return null;
  const texto = mensagemDoPasso(p, order, { loja, reembolso: p === 'recusado' && precisaDevolver(order) });
  const numero = numeroDoWhatsapp(order.customer_phone);
  return {
    passo: p,
    texto,
    link: numero ? `https://wa.me/${numero}?text=${encodeURIComponent(texto)}` : null,
  };
}

module.exports = {
  avisoDoPedido, mensagemDoPasso, passoDoPedido, precisaDevolver, primeiroNome,
  fraseDoPagamentoParaCliente,
};
