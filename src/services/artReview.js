// ============================================================
// AURA Studio — Triagem da arte enviada pelo cliente (S5, migration 289)
//
// O fluxo de aprovacao que existe hoje vai de LOJISTA -> CLIENTE: a
// lojista manda o render e o cliente aprova. O inverso — a lojista olhar
// a arte que o cliente mandou — nao existia.
//
// E nao e um portao de qualidade (DEC-11): ajustar a arte do cliente para
// caber no produto e para as cores de impressao e rotina. A pergunta nao
// e "aprovo ou rejeito", e "ajusto por conta ou cobro por isso". Por isso
// a triagem nao bloqueia o pedido — e metadado do item.
// ============================================================
'use strict';

const STATUS = Object.freeze({
  PENDENTE:  'pendente',
  ACEITA:    'aceita',
  AJUSTANDO: 'ajustando',
  DEVOLVIDA: 'devolvida',
});

const STATUS_VALIDOS = Object.freeze(Object.values(STATUS));

// Os mesmos tipos que o S0 trata como origem da arte: image e template
// preenchem o mesmo slot.
const ART_SOURCE_TYPES = new Set(['image', 'template']);

function preenchido(v) {
  return !(v == null || (typeof v === 'string' && !v.trim()));
}

/**
 * Status inicial de triagem de um item recem-criado.
 *
 * Devolve 'pendente' quando ha arte DE CLIENTE para olhar, e null quando
 * nao ha nada a revisar — produto sem personalizacao, ou cliente que
 * contratou a criacao da arte (nesse caminho quem produz e a lojista, e
 * o que existe hoje ja cobre: ela manda o render e o cliente aprova).
 *
 * Um upload feito junto com 'designer' tambem nao entra na fila: ali o
 * arquivo e referencia de briefing, nao a arte a ser impressa.
 */
function initialArtStatus(config, customization) {
  if (!config || !Array.isArray(config.fields)) return null;
  if (!customization || typeof customization !== 'object') return null;

  const contratouCriacao = config.fields.some(
    (f) => f && f.config && f.config.is_art_service === true
        && customization[f.id] === 'designer'
  );
  if (contratouCriacao) return null;

  const temArte = config.fields.some(
    (f) => f && ART_SOURCE_TYPES.has(f.type) && preenchido(customization[f.id])
  );
  return temArte ? STATUS.PENDENTE : null;
}

/** Transicoes aceitas a partir de um status. */
function transicaoValida(de, para) {
  if (!STATUS_VALIDOS.includes(para)) return false;
  // De qualquer estado a lojista pode corrigir a propria decisao: a
  // triagem e uma anotacao de trabalho, nao uma maquina de estados de
  // pedido. Travar isso so criaria pedido preso por engano de clique.
  return de == null ? false : true;
}

module.exports = { STATUS, STATUS_VALIDOS, initialArtStatus, transicaoValida };
