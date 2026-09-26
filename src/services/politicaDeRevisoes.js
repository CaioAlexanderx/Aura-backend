// ============================================================
// AURA Studio · Política de revisões da arte — uma leitura só
//
// A lojista configura em Loja Digital → Revisões (studio_settings):
//   max_revisions_included  quantas revisões grátis o pedido tem
//   extra_revision_price    o preço da revisão a partir da seguinte
//   revision_policy_text    o texto livre da política
//
// ── 0 É ILIMITADO (decisão do Tech Lead, 26/09/2026, achado A3) ─────────
// O painel sempre disse "Digite 0 pra liberar revisões ilimitadas (sem
// cobrança extra)", e é assim que as lojas configuraram (a Sheid e a
// aura-qa estão com 0). A página de aprovação lia o mesmo 0 como "nenhuma
// inclusa" e avisava a cliente de uma cobrança que a loja nunca quis
// fazer. Vale o sentido do painel: 0, vazio, negativo ou lixo = ilimitadas,
// e revisão ilimitada nunca tem preço de extra.
//
// Cada payload que fala de revisões lê daqui, para os dois sentidos não
// voltarem a conviver.
// ============================================================
'use strict';

/**
 * Quantas revisões o pedido inclui, ou `null` quando são ilimitadas.
 * Só um inteiro positivo limita.
 */
function revisoesInclusas(studioSettings) {
  const ss = studioSettings || {};
  const n = parseInt(ss.max_revisions_included, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** true quando a loja não limita as revisões (0, vazio ou ausente). */
function revisoesIlimitadas(studioSettings) {
  return revisoesInclusas(studioSettings) == null;
}

/**
 * O preço da revisão extra. Zero quando ilimitadas: o painel diz "este
 * preço não será cobrado", e o preço que ficou salvo de antes não pode
 * vazar para a cliente.
 */
function precoDaRevisaoExtra(studioSettings) {
  if (revisoesIlimitadas(studioSettings)) return 0;
  const v = parseFloat((studioSettings || {}).extra_revision_price);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * A política no formato que a vitrine já lê (`revisions` da loja e do
 * pedido, `revisoes` da confirmação). `max_included` continua 0 quando
 * ilimitadas — é o contrato que o app entende desde a primeira versão —
 * e `ilimitadas` diz com todas as letras.
 */
function politicaDeRevisoes(studioSettings) {
  const ss = studioSettings || {};
  const inclusas = revisoesInclusas(ss);
  return {
    max_included: inclusas || 0,
    extra_price: precoDaRevisaoExtra(ss),
    policy_text: ss.revision_policy_text || null,
    ilimitadas: inclusas == null,
  };
}

module.exports = {
  revisoesInclusas,
  revisoesIlimitadas,
  precoDaRevisaoExtra,
  politicaDeRevisoes,
};
