// ============================================================
// AURA. — A loja aceita pedido agora?
//
// ── O PROBLEMA DO PICO ─────────────────────────────────────────────────
// Em dezembro e em maio a lojista vende o que nao consegue produzir. O
// pedido entra, ela nao da conta, e o pico vira reembolso e avaliacao
// ruim. A unica saida que ela tinha era DESPUBLICAR a loja — que joga
// fora tambem a vitrine, e com ela o orcamento que daria para produzir
// em janeiro.
//
// ── DUAS FORMAS DE FECHAR ──────────────────────────────────────────────
// `pedidos_pausados` e ela fechando na mao, agora. `pedidos_ate` e a
// data em que fecha sozinho — porque no dia 20 de dezembro, as 23h,
// ninguem vai abrir o painel para fechar a loja.
//
// ── O QUE FECHAR SIGNIFICA ─────────────────────────────────────────────
// A vitrine continua inteira: produtos, fotos, preco, mockup 3D. O que
// muda e o BOTAO — em vez de "Comprar agora", "Pedir orcamento". A
// cliente que chegou pelo Instagram continua vendo a loja e continua
// virando contato; ela e que decide quando produz.
//
// O motivo viaja junto porque a vitrine precisa DIZER: uma loja que
// simplesmente nao tem botao de comprar parece quebrada.
// ============================================================
'use strict';

/** Hoje em Sao Paulo, como AAAA-MM-DD. */
function hojeNoBrasil(agora = new Date()) {
  // O servidor roda em UTC. Sem o deslocamento, entre 21h e 24h de
  // Brasilia a data ja virou no servidor e a loja fecharia um dia antes.
  const brasilia = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  return brasilia.toISOString().slice(0, 10);
}

/** A data como AAAA-MM-DD, venha ela como Date ou como texto. */
function comoData(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * O modo da loja, pronto para o payload.
 *
 * `aceita: false` nunca vem sem `motivo`: a vitrine tem de explicar, e
 * uma loja sem botao de comprar e sem explicacao parece quebrada.
 */
function modoDaLoja(config, agora = new Date()) {
  const c = config || {};
  const ate = comoData(c.pedidos_ate);
  const hoje = hojeNoBrasil(agora);

  if (c.pedidos_pausados === true) {
    return {
      aceita: false,
      motivo: 'pausado',
      // Escrito aqui, e nao na vitrine, para as duas lojas dizerem o
      // mesmo — e para a lojista poder reescrever um dia num lugar so.
      recado: 'No momento a loja está fechada para pedidos novos. Você pode pedir um orçamento e a loja responde com prazo.',
      pedidos_ate: ate,
    };
  }

  if (ate && hoje > ate) {
    return {
      aceita: false,
      motivo: 'prazo',
      recado: 'Os pedidos desta temporada já fecharam. Você pode pedir um orçamento para a próxima leva.',
      pedidos_ate: ate,
    };
  }

  return { aceita: true, motivo: null, recado: null, pedidos_ate: ate };
}

module.exports = { modoDaLoja, hojeNoBrasil, comoData };
