// ============================================================
// AURA. — autoPrintScript: disparo de impressao a prova de race
//
// PORQUE (16/07/2026 — relato Davi Calcados): os HTMLs de impressao
// disparavam via `window.onload = () => window.print()` ou via listener
// de "load". Dois problemas, e o segundo so existe por causa do primeiro:
//
// 1. O printWindow.ts (app) escreve um PLACEHOLDER na janela antes de
//    injetar o HTML real via document.write. Quando o cupom chega, o
//    evento `load` da Window JA disparou (no placeholder) — um listener
//    registrado agora nunca roda.
// 2. Quem tentou se proteger com `if (document.readyState === "complete")`
//    caiu na armadilha oposta: readyState JA e "complete" (heranca do
//    placeholder), entao imprime imediatamente — com as imagens ainda
//    baixando. O Chrome recusa o job e devolve "Falha na impressao.
//    Verifique a impressora e tente novamente", que manda o lojista
//    depurar a impressora por um bug nosso.
//
// A licao: qualquer coisa apoiada no ciclo de vida do documento e fragil
// dentro de uma janela montada por document.write. Entao nao usamos nenhum.
//
// Este script roda no fim do body — nesse ponto todos os <img> ja foram
// parseados e estao em document.images, independente de readyState. Ele
// espera cada imagem PENDENTE resolver (load OU error — erro tambem conta,
// senao um 404 trava tudo) e so entao imprime. Bail de 3s garante que uma
// imagem pendurada (firewall que dropa em vez de recusar) nunca impeca a
// impressao: melhor cupom sem logo que loja sem cupom.
// ============================================================
'use strict';

/**
 * @param {{ delayMs?: number, bailMs?: number }} [opts]
 *   delayMs: respiro pro layout assentar depois das imagens (default 250)
 *   bailMs:  teto pra imagem pendurada (default 3000)
 * @returns {string} bloco <script> pronto pra concatenar no fim do body
 */
function autoPrintScript(opts = {}) {
  const delay = Number.isFinite(opts.delayMs) ? opts.delayMs : 250;
  const bail = Number.isFinite(opts.bailMs) ? opts.bailMs : 3000;

  return '<script>(function(){'
    + 'var fired=false;'
    + 'function go(){'
    +   'if(fired)return;fired=true;'
    +   'try{window.focus();}catch(e){}'
    +   'try{window.print();}catch(e){}'
    + '}'
    + 'function ready(){'
    +   'var imgs=[].slice.call(document.images||[]);'
    +   'var pend=imgs.filter(function(i){return !i.complete;});'
    +   'if(!pend.length){setTimeout(go,' + delay + ');return;}'
    +   'var n=0,t=setTimeout(go,' + bail + ');'
    +   'pend.forEach(function(i){'
    +     'function fin(){if(++n>=pend.length){clearTimeout(t);setTimeout(go,' + delay + ');}}'
    +     'i.addEventListener("load",fin);i.addEventListener("error",fin);'
    +   '});'
    + '}'
    // 50ms: deixa o document.close() do printWindow.ts assentar antes de
    // medir document.images. Nao e espera de rede — e so ceder o tick.
    + 'setTimeout(ready,50);'
    + '})();</script>';
}

module.exports = { autoPrintScript };
