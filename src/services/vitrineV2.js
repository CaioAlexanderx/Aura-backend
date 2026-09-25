// ============================================================
// AURA. — A chave da vitrine Studio nova, por loja
//
// ── O PROBLEMA ─────────────────────────────────────────────────────────
// A normalização da vitrine Studio (aura-app docs/studio/
// FASEAMENTO_VITRINE_STUDIO.md) troca o checkout, a página do produto e
// o pós-compra de uma loja que vende todo dia. Ligar tudo de uma vez em
// todas as lojas faria da primeira cliente o ambiente de teste.
//
// ── A DECISÃO (25/09/2026) ─────────────────────────────────────────────
// Uma chave por loja em `companies.studio_settings.vitrine_v2`. Ligada
// primeiro na loja de teste (aura-qa), depois na loja real. A chave só
// escolhe qual TELA o app desenha: preço, pedido e validação no servidor
// são os mesmos nos dois lados. Por isso não precisa de segredo — o app
// aceita também `?v2=1` na URL para o QA ver a tela nova numa loja real
// sem mudar nada para os clientes dela.
//
// A chave sai do código no fim da Fase 5, quando todas as lojas
// estiverem na vitrine nova.
// ============================================================
'use strict';

/**
 * A loja está na vitrine nova?
 *
 * Aceita `true` e `'true'` porque `studio_settings` é jsonb gravado por
 * telas diferentes, e o painel já gravou booleano como texto antes.
 * Qualquer outra coisa (ausente, null, "sim", 1) é desligado: na dúvida,
 * a loja fica na tela que já conhece.
 */
function vitrineV2Ligada(studioSettings) {
  if (!studioSettings || typeof studioSettings !== 'object') return false;
  const v = studioSettings.vitrine_v2;
  return v === true || v === 'true';
}

module.exports = { vitrineV2Ligada };
