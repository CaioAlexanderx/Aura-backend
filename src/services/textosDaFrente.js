// ============================================================
// AURA. — Textos fixos da vitrine pela frente da conta (tq-58, 29/10/2026)
//
// Dois textos da loja comum foram escritos para loja de roupa:
//   - "Sobre esta peça", o titulo da descricao na pagina do produto
//     (templates/storefront/parts/product_detail.js);
//   - "Dúvida sobre tamanho ou modelo?", o titulo do bloco do WhatsApp da
//     home (templates/storefrontHtml.js).
// Numa adega ou numa loja de material de construcao eles soam errados
// (pedido da Nina no QA da Felic Adega, 20/10/2026).
//
// A frente e companies.segment (services/segment.js). Roupa = frente
// vazia (quase todas as lojas publicadas hoje, de moda) ou 'varejo': para
// elas os textos de sempre, byte a byte — as fixtures em
// tests/fixtures/vitrine/ provam. Qualquer OUTRA frente (matcon, otica,
// assistencia, studio, outro e a futura "Adega e bar", tq-50) leva os
// textos gerais, sem precisar mexer aqui quando a frente nova nascer.
//
// O titulo do bloco do WhatsApp escrito pela lojista (migration 401)
// continua ganhando de tudo: isto so troca o PADRAO.
// ============================================================
'use strict';

const TEXTOS_DE_ROUPA = Object.freeze({
  sobreProduto: 'Sobre esta peça',
  duvidaTitulo: 'Dúvida sobre tamanho ou modelo?',
});

const TEXTOS_GERAIS = Object.freeze({
  sobreProduto: 'Sobre o produto',
  duvidaTitulo: 'Dúvida sobre o produto?',
});

// Frente vazia conta como roupa: e o que as lojas de moda tem hoje.
const FRENTES_DE_ROUPA = new Set(['', 'varejo']);

function ehFrenteDeRoupa(segment) {
  const s = segment == null ? '' : String(segment).trim().toLowerCase();
  return FRENTES_DE_ROUPA.has(s);
}

/** { sobreProduto, duvidaTitulo } da frente da conta. */
function textosDaFrente(segment) {
  return ehFrenteDeRoupa(segment) ? TEXTOS_DE_ROUPA : TEXTOS_GERAIS;
}

module.exports = { textosDaFrente, ehFrenteDeRoupa, TEXTOS_DE_ROUPA, TEXTOS_GERAIS };
