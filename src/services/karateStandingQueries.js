// ============================================================
// AURA KARATÊ — Fragmento SQL canônico para agregados de faixa-preta
// (mata a classe de bug "COUNT(*) FILTER (WHERE is_black_belt)" sem
// gate de is_active).
//
// Contexto (12/07/2026): a regra "só faixa-preta ATIVA entra no universo
// cobrável de anuidade" estava sendo reimplementada, à mão, em cada rota
// que precisava contar faixas-pretas — e errou 2 vezes já detectadas:
//   1) karateStandingSummary.js — 'total' de pretas era COUNT(*) cru sobre
//      is_black_belt (665 em vez de 549 na FPKT). Corrigido em 11/07/2026.
//   2) karateDojoRoster.js:133 (summary.black_belt_total) — MESMO erro,
//      não replicado do fix acima. Dojô bb5e5cd9-...: 139 em vez de 82.
//      Corrigido em 12/07/2026 usando este módulo (varredura completa no
//      PR — nenhuma 3ª instância viva encontrada além destas duas).
//
// Causa raiz: `karate_member_standing.is_black_belt` NÃO é gateado por
// is_active (nem deveria ser — é só "essa pessoa tem faixa-preta?").
// Só `financeiro`/`valor_em_aberto` são gateados (inativo → 'nao_aplicavel'
// / 0). Então qualquer agregado que misture is_black_belt com financeiro
// SEM também filtrar is_active conta inativas no total mas não em nenhum
// dos buckets de financeiro — total nunca fecha com a soma dos buckets.
//
// Regra única, daqui pra frente: NENHUMA rota escreve
// `FILTER (WHERE is_black_belt ...)` à mão. Toda contagem/agregado de
// faixa-preta usa blackBeltAggregatesSql() abaixo. Os fragmentos gerados
// são AUTOCONTIDOS (repetem `is_black_belt AND is_active` em CADA FILTER,
// mesmo que a query já tenha um WHERE externo) de propósito — depender de
// um WHERE externo foi exatamente o tipo de acoplamento implícito que
// permitiu o bug se repetir sem que ninguém notasse ao copiar/colar só um
// pedaço da query.
//
// Guarda-corpo automatizado: __tests__/karate.blackBeltAggregatesGuard.test.js
// varre TODO src/**/*.js atrás de `FILTER (WHERE ...)` contendo
// is_black_belt sem is_active no mesmo bloco — quebra o build se alguém
// reintroduzir a classe do bug em QUALQUER arquivo, não só nestes dois.
//
// Buckets (espelham `financeiro` da view):
//   black_belt_total          → is_black_belt AND is_active (universo cobrável)
//   black_belt_inactive       → is_black_belt AND NOT is_active (nunca gera
//                                cobrança; exposto para a UI mostrar o resto
//                                explicitamente em vez de escondê-lo no total)
//   black_belt_paid           → ativo + financeiro = 'em_dia'
//   black_belt_overdue        → ativo + financeiro = 'atrasado'
//   black_belt_sem_cobranca   → ativo + financeiro = 'sem_cobranca'
//     (faixa-preta ativa sem anuidade lançada na temporada ainda — não é
//     inadimplência; CLAUDE.md do backend: "ausência de cobrança nunca é
//     inadimplência")
//
// Invariante que TODO consumidor destas colunas pode confiar:
//   black_belt_total === black_belt_paid + black_belt_overdue + black_belt_sem_cobranca
// ============================================================
'use strict';

/**
 * Gera o bloco de colunas agregadas de faixa-preta para embutir num SELECT
 * sobre `karate_member_standing` (ou qualquer FROM/JOIN que exponha as
 * mesmas colunas `is_black_belt`, `is_active`, `financeiro`).
 *
 * @param {Object} [opts]
 * @param {string} [opts.alias] — prefixo de tabela/alias (ex.: 'kms'), sem o
 *   ponto. Quando omitido, usa as colunas sem qualificação.
 * @returns {string} trecho SQL (sem vírgula à esquerda, sem vírgula à
 *   direita) pronto para entrar na lista de colunas de um SELECT.
 */
function blackBeltAggregatesSql(opts) {
  const alias = (opts && opts.alias) || '';
  const c = (col) => (alias ? `${alias}.${col}` : col);

  const isBB = c('is_black_belt');
  const isActive = c('is_active');
  const fin = c('financeiro');

  return [
    `COUNT(*) FILTER (WHERE ${isBB} AND ${isActive})::int AS black_belt_total`,
    `COUNT(*) FILTER (WHERE ${isBB} AND NOT ${isActive})::int AS black_belt_inactive`,
    `COUNT(*) FILTER (WHERE ${isBB} AND ${isActive} AND ${fin} = 'em_dia')::int AS black_belt_paid`,
    `COUNT(*) FILTER (WHERE ${isBB} AND ${isActive} AND ${fin} = 'atrasado')::int AS black_belt_overdue`,
    `COUNT(*) FILTER (WHERE ${isBB} AND ${isActive} AND ${fin} = 'sem_cobranca')::int AS black_belt_sem_cobranca`,
  ].join(',\n       ');
}

// Shape "zerado" das colunas acima — usado pelos fallbacks defensivos
// (42P01/42703, CLAUDE.md armadilha #1) das rotas que consomem este módulo.
const EMPTY_BLACK_BELT_AGGREGATES = Object.freeze({
  black_belt_total: 0,
  black_belt_inactive: 0,
  black_belt_paid: 0,
  black_belt_overdue: 0,
  black_belt_sem_cobranca: 0,
});

module.exports = {
  blackBeltAggregatesSql,
  EMPTY_BLACK_BELT_AGGREGATES,
};
