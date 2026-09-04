// ============================================================
// AURA. — Quais pecas ficaram no prejuizo
//
// ── O QUE JA EXISTIA ───────────────────────────────────────────────────
// A composicao (peca → insumos, com quantidade) e a view
// `studio_compositions_summary`, que ja calcula custo total e margem por
// produto. A conta estava pronta.
//
// ── O QUE FALTAVA ──────────────────────────────────────────────────────
// O AVISO. A lojista sobe o preco da louca de R$ 8 para R$ 11 — porque o
// fornecedor subiu — salva, e nada acontece. Duas semanas depois ela
// descobre no fim do mes que vendeu no prejuizo, produto por produto,
// procurando na mao.
//
// Ela e boa de producao e ruim de preco: e exatamente aqui que a
// ferramenta paga o proprio custo.
//
// ── A REGRA ────────────────────────────────────────────────────────────
// O piso e DELA (`studio_settings.margem_minima_pct`), nao nosso: uma
// caneca de R$ 39,90 e um kit de R$ 180 nao vivem com a mesma margem, e
// quem sabe o numero e quem paga a conta. Sem piso definido, 30% — que e
// baixo o suficiente para nao gritar em loja saudavel e alto o
// suficiente para pegar o prejuizo de verdade.
// ============================================================
'use strict';

/** O piso quando a lojista ainda nao escolheu o dela. */
const MARGEM_MINIMA_PADRAO = 30;

function numero(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * O piso de margem da loja, em pontos percentuais.
 *
 * Fora de 0–95 cai no padrao: um piso de 99% reprovaria a loja inteira e
 * um de -10 nao reprovaria nada — nos dois casos o alerta viraria ruido
 * que ela aprende a ignorar.
 */
function margemMinima(studioSettings) {
  const n = numero((studioSettings || {}).margem_minima_pct);
  if (n == null || n < 0 || n > 95) return MARGEM_MINIMA_PADRAO;
  return n;
}

/**
 * Como esta a margem desta peca.
 *
 *   'prejuizo' — custa mais do que vende. Nao e margem baixa, e perda.
 *   'abaixo'   — vende com lucro, mas abaixo do piso dela.
 *   'ok'       — no piso ou acima.
 *   'sem_dado' — sem composicao ou sem preco: nao da para julgar, e
 *                inventar um veredito seria pior do que calar.
 */
function situacao(margemPct, piso) {
  const m = numero(margemPct);
  if (m == null) return 'sem_dado';
  if (m < 0) return 'prejuizo';
  return m < piso ? 'abaixo' : 'ok';
}

/**
 * As pecas que precisam de atencao, da pior para a menos ruim.
 *
 * `linhas` vem de `studio_compositions_summary`. Peca sem composicao nao
 * entra: ela nao "ficou" ruim, ela nunca foi medida — misturar as duas
 * faria a lojista perseguir cadastro em vez de preco.
 */
function pecasEmRisco(linhas, piso) {
  const lista = Array.isArray(linhas) ? linhas : [];
  return lista
    .map((l) => ({
      product_id: l.product_id,
      nome: l.product_name,
      preco: numero(l.product_price),
      custo: numero(l.total_cost),
      margem_pct: numero(l.margin_pct),
      situacao: situacao(l.margin_pct, piso),
    }))
    .filter((p) => p.situacao === 'prejuizo' || p.situacao === 'abaixo')
    .sort((a, b) => (a.margem_pct ?? 0) - (b.margem_pct ?? 0));
}

/**
 * O preco que devolveria a peca ao piso.
 *
 * A lojista nao quer saber que "a margem caiu para 12%"; quer saber por
 * quanto passar a vender. Arredonda para cima em centavos — para baixo
 * deixaria a peca um centavo abaixo do piso que ela mesma pediu.
 */
function precoParaOPiso(custo, piso) {
  const c = numero(custo);
  const p = numero(piso);
  if (c == null || c <= 0 || p == null || p >= 100) return null;

  // O ruido do ponto flutuante entra ANTES do arredondamento: 21/0.7 da
  // 30.000000000000004, e arredondar isso para cima sugeriria R$ 30,01
  // para uma peca que fecha exatamente em R$ 30,00. Um centavo a mais
  // parece descuido justo na tela que existe para ela confiar na conta.
  const centavos = (c / (1 - p / 100)) * 100;
  return Math.ceil(Number(centavos.toFixed(6))) / 100;
}

/**
 * A frase do aviso.
 *
 * Uma peca no prejuizo e uma frase diferente de cinco pecas apertadas —
 * e a diferenca importa, porque a primeira exige acao hoje.
 */
function recadoDoRisco(pecas, piso) {
  const lista = Array.isArray(pecas) ? pecas : [];
  if (!lista.length) return null;

  const perdendo = lista.filter((p) => p.situacao === 'prejuizo');
  if (perdendo.length === 1 && lista.length === 1) {
    return `"${perdendo[0].nome}" passou a custar mais do que vende.`;
  }
  if (perdendo.length > 0) {
    const resto = lista.length - perdendo.length;
    const base = perdendo.length === 1
      ? `1 peca passou a custar mais do que vende`
      : `${perdendo.length} pecas passaram a custar mais do que vendem`;
    return resto > 0
      ? `${base}, e outras ${resto} ficaram abaixo de ${piso}% de margem.`
      : `${base}.`;
  }
  return lista.length === 1
    ? `"${lista[0].nome}" ficou abaixo de ${piso}% de margem.`
    : `${lista.length} pecas ficaram abaixo de ${piso}% de margem.`;
}

module.exports = {
  MARGEM_MINIMA_PADRAO,
  margemMinima,
  situacao,
  pecasEmRisco,
  precoParaOPiso,
  recadoDoRisco,
};
