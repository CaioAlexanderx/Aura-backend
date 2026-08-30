// ============================================================
// AURA. — Rodape institucional, uma fonte para as DUAS lojas
//
// Como pagar e o que acontece se a peca nao servir. As duas coisas que
// todo e-commerce grande tem no rodape e a nossa loja nao tinha.
//
// POR QUE MODULO E NAO TEMPLATE: existem duas lojas — a comum (HTML
// gerado no backend) e a vitrine Studio (React Native Web). Toda opcao
// nova tem quatro lugares pra chegar, e ja perdemos esse espelho antes.
// Se as formas de pagamento forem calculadas em dois lugares, um dia a
// loja comum vai dizer "Pix · Cartao" e a vitrine so "Pix".
//
// Aqui se decide O QUE dizer. COMO desenhar e de cada loja.
// ============================================================

/**
 * Politica de troca padrao.
 *
 * Espelha o prazo de 7 dias do Codigo de Defesa do Consumidor para compra
 * fora do estabelecimento (art. 49). NAO promete mais que a lei: lojista
 * que quiser ser mais generosa reescreve no painel, e a que nao escrever
 * nada fica com algo correto no lugar de nada.
 */
const POLITICA_PADRAO =
  'Você tem até 7 dias corridos após receber o pedido para desistir da compra, '
  + 'conforme o Código de Defesa do Consumidor. Para trocar por outro tamanho ou '
  + 'cor, fale com a loja pelo WhatsApp.';

/**
 * As formas saem da CONFIGURACAO da lojista, nao de uma lista fixa.
 *
 * Loja sem Pix nem cartao nao mostra nada — anunciar forma de pagamento
 * que a loja nao aceita e pior que nao anunciar: a cliente monta o
 * carrinho contando com o cartao e descobre no fim que so tem Pix.
 *
 * Sem selo de bandeira: nao temos as marcas, e inventar um retangulo
 * escrito "VISA" seria falsificar.
 */
function formasDePagamento(settings) {
  const s = settings || {};
  const formas = [];
  if (s.has_pix === true) formas.push('Pix');
  if (s.has_card === true) formas.push('Cartão de crédito e débito');
  if (s.pay_on_delivery_enabled === true) formas.push('Pagamento na entrega');
  return formas;
}

/** O texto que a cliente le: o da lojista, ou o padrao. Nunca vazio. */
function textoDaPolitica(politicaTroca) {
  const dela = politicaTroca == null ? '' : String(politicaTroca).trim();
  return dela || POLITICA_PADRAO;
}

/**
 * O rodape inteiro, pronto pra desenhar.
 *
 * `formas` pode vir vazia (loja sem pagamento configurado) e a loja
 * omite o bloco. `politica` nunca vem vazia.
 */
function montarRodape(settings, politicaTroca) {
  return {
    formas: formasDePagamento(settings),
    politica_titulo: 'Trocas e devoluções',
    politica: textoDaPolitica(politicaTroca),
  };
}

module.exports = {
  POLITICA_PADRAO,
  formasDePagamento,
  textoDaPolitica,
  montarRodape,
};
