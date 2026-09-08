// ============================================================
// AURA — Galeria de fotos por cor (migration 323)
//
// As REGRAS da galeria moram aqui, sem banco no meio: quantas fotos
// cabem, como a cor e escrita, o que sobra depois de apagar uma foto e o
// que uma reordenacao pode ou nao mandar. A rota (routes/productImages.js)
// consulta, chama estas funcoes e grava — e os testes exercitam daqui, nao
// de uma copia dentro do handler. Mesmo desenho de productGallery.js.
//
// POSICAO SEM BURACO: dentro de um par (produto, cor) as posicoes sao
// 0..n-1, sempre. Quem apaga a foto do meio reempacota o resto. O motivo
// nao e estetica: a posicao 0 e a CAPA, e ela espelha products.image_url
// (galeria principal) ou a foto das variantes daquela cor. Um buraco no
// inicio deixaria a peca sem capa com fotos cadastradas.
// ============================================================
'use strict';

// Quatro. A UI sugere duas fotos por cor, mas isso e dica de tela — quem
// fotografou quatro angulos do mesmo tenis nao pode levar erro por isso.
const MAX_FOTOS = 4;

const ERRO_LIMITE_COR = `Máximo de ${MAX_FOTOS} fotos por cor`;
const ERRO_LIMITE_PRINCIPAL = `Máximo de ${MAX_FOTOS} fotos principais`;

/**
 * Normaliza a cor recebida do cliente.
 *
 * null/undefined/'' significam a galeria PRINCIPAL — e um valor legitimo,
 * nao um erro. Qualquer outra coisa tem que ser um hex de 6 digitos; sai
 * minusculo porque '#FF0000' e '#ff0000' sao a mesma cor e ja custaram
 * caro no catalogo (variantes duplicadas por diferenca de caixa).
 *
 * @returns {{color_hex: string|null} | {error: string}}
 */
function normalizarCorHex(raw) {
  if (raw === undefined || raw === null) return { color_hex: null };
  const t = String(raw).trim();
  if (t === '') return { color_hex: null };
  if (/^#[0-9A-Fa-f]{6}$/.test(t)) return { color_hex: t.toLowerCase() };
  if (/^[0-9A-Fa-f]{6}$/.test(t)) return { color_hex: ('#' + t).toLowerCase() };
  return { error: 'color_hex deve ser #rrggbb' };
}

/**
 * A mensagem de erro quando nao cabe mais foto, ou null quando cabe.
 * A mensagem muda com a galeria: "por cor" e "principais" sao coisas
 * diferentes pra quem esta cadastrando.
 *
 * @param {string|null} colorHex
 * @param {number} quantidadeAtual  fotos ja gravadas nesse par
 */
function erroDeLimite(colorHex, quantidadeAtual) {
  const n = Number(quantidadeAtual) || 0;
  if (n < MAX_FOTOS) return null;
  return colorHex ? ERRO_LIMITE_COR : ERRO_LIMITE_PRINCIPAL;
}

/** A posicao que a proxima foto ocupa. Nunca depende do maior `position` gravado: uma base com buraco receberia foto em cima da existente. */
function proximaPosicao(quantidadeAtual) {
  return Math.max(0, Number(quantidadeAtual) || 0);
}

/**
 * O que sobra depois de apagar `idRemovido`, ja reempacotado.
 *
 * Recebe as linhas do par (produto, cor) na ordem gravada e devolve a
 * lista final com as posicoes 0..n-1 e, separadamente, so as que MUDARAM
 * de posicao — o UPDATE do banco nao precisa tocar no que ja estava certo.
 *
 * @param {Array<{id:string, position:number}>} linhas
 * @param {string} idRemovido
 * @returns {{restantes: Array, mudancas: Array<{id:string, position:number}>, capa: object|null}}
 */
function reempacotarAposRemover(linhas, idRemovido) {
  const ordenadas = (Array.isArray(linhas) ? linhas.slice() : [])
    .sort((a, b) => (a.position - b.position) || String(a.id).localeCompare(String(b.id)));
  const restantes = [];
  const mudancas = [];
  for (const l of ordenadas) {
    if (String(l.id) === String(idRemovido)) continue;
    const nova = restantes.length;
    if (Number(l.position) !== nova) mudancas.push({ id: l.id, position: nova });
    restantes.push({ ...l, position: nova });
  }
  return { restantes, mudancas, capa: restantes.length ? restantes[0] : null };
}

/**
 * Valida um pedido de reordenacao e devolve as posicoes finais.
 *
 * Exige a lista COMPLETA do par (produto, cor): reordenar mandando metade
 * das fotos deixaria as outras com posicao repetida, e "qual e a capa"
 * viraria sorteio. Id de outra cor ou de outro produto e recusado —
 * chegou ali por bug ou por tentativa, e nos dois casos a resposta e a
 * mesma.
 *
 * @param {Array<{id:string}>} linhas  as fotos que existem nesse par
 * @param {string[]} ids               a ordem pedida
 * @returns {{ordem: Array<{id:string, position:number}>} | {error: string}}
 */
function ordenarPorIds(linhas, ids) {
  if (!Array.isArray(ids)) return { error: 'ids deve ser uma lista' };
  const existentes = (Array.isArray(linhas) ? linhas : []).map((l) => String(l.id));
  const pedidos = ids.map((v) => String(v == null ? '' : v).trim());

  if (pedidos.some((v) => v === '')) return { error: 'ids contem valor vazio' };
  if (new Set(pedidos).size !== pedidos.length) return { error: 'ids repetidos' };

  for (const id of pedidos) {
    if (!existentes.includes(id)) return { error: 'Foto nao pertence a este produto/cor' };
  }
  if (pedidos.length !== existentes.length) {
    return { error: 'Envie todas as fotos desta cor na nova ordem' };
  }

  return { ordem: pedidos.map((id, i) => ({ id, position: i })) };
}

/**
 * As linhas do banco no formato da API: a galeria principal separada e as
 * de cor agrupadas por hex. Uma cor sem foto simplesmente nao aparece em
 * `by_color` — chave com lista vazia so daria trabalho pro cliente.
 *
 * @param {Array} linhas
 * @returns {{main: Array, by_color: Object}}
 */
function agruparGaleria(linhas) {
  const main = [];
  const by_color = {};
  const ordenadas = (Array.isArray(linhas) ? linhas.slice() : [])
    .sort((a, b) => (a.position - b.position) || String(a.id).localeCompare(String(b.id)));
  for (const l of ordenadas) {
    const foto = {
      id: l.id,
      url: l.url,
      thumb_url: l.thumb_url || null,
      position: Number(l.position) || 0,
    };
    if (l.color_hex) {
      const hex = String(l.color_hex).toLowerCase();
      if (!by_color[hex]) by_color[hex] = [];
      by_color[hex].push(foto);
    } else {
      main.push(foto);
    }
  }
  return { main, by_color };
}

module.exports = {
  MAX_FOTOS,
  ERRO_LIMITE_COR,
  ERRO_LIMITE_PRINCIPAL,
  normalizarCorHex,
  erroDeLimite,
  proximaPosicao,
  reempacotarAposRemover,
  ordenarPorIds,
  agruparGaleria,
};
