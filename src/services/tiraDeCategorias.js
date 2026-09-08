// ============================================================
// AURA. — A tira de categorias da home
//
// Quatro cartoes grandes, com foto, antes da grade de produtos. E o que
// a loja tinha de menos "visual": a navegacao por categoria era uma
// barra de texto, correta e silenciosa.
//
// SO O PRIMEIRO NIVEL. Decisao de Caio (30/08): a Finesse tem 38
// categorias visiveis, mas so 4 raizes aparecem de fato na loja. Tira com
// 38 cartoes nao e navegacao, e um segundo catalogo.
//
// POR QUE SERVICO: a regra de QUEM entra e a mesma nas duas lojas (comum
// e vitrine Studio). Cada loja decide COMO desenhar. Mesmo arranjo do
// rodape institucional — e pelo mesmo motivo: calcular nos dois lugares
// e como as duas lojas divergem sem ninguem perceber.
// ============================================================

/**
 * Abaixo disto a tira nao aparece.
 *
 * Uma ou duas categorias em fila nao leem como navegacao — leem como
 * defeito, ou como se faltasse carregar. Mesmo raciocinio do limiar de 20
 * itens para os controles de grade: um controle so vale a partir do
 * volume em que ele resolve alguma coisa.
 */
const MINIMO_PARA_APARECER = 3;

/**
 * Abaixo disto a categoria nao ganha cartao na tira (segue na barra e
 * no menu). Um cartao grande com foto pra UMA peca ("Blusas 1", Finesse,
 * QA 08/09/2026) promete uma prateleira e entrega um produto.
 */
const MINIMO_DE_PECAS_NO_CARTAO = 2;

/**
 * Monta a tira a partir da arvore que a barra ja usa.
 *
 * @param arvore linhas de arvoreDeCategorias — ja filtradas por
 *   `total > 0`, ou seja, so categoria com peca visivel.
 * @returns [] quando nao ha o que mostrar. A loja desenha o que vier e
 *   nao precisa saber do limiar.
 */
function montarTira(arvore) {
  const linhas = Array.isArray(arvore) ? arvore : [];

  const raizes = linhas
    .filter((c) => Number(c.depth) === 0 && Number(c.total) >= MINIMO_DE_PECAS_NO_CARTAO)
    .map((c) => ({
      nome: c.nome,
      caminho: c.path,
      slug: c.slug,
      total: Number(c.total) || 0,
      // null quando a lojista ainda nao subiu: a loja cai no ladrilho de
      // cor. Decisao de Caio (30/08) — a alternativa era sumir com o
      // cartao, e sumir deixaria a tira mudando de tamanho conforme ela
      // sobe as imagens.
      banner_url: texto(c.banner_url),
    }));

  return raizes.length >= MINIMO_PARA_APARECER ? raizes : [];
}

function texto(v) {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

module.exports = { MINIMO_PARA_APARECER, MINIMO_DE_PECAS_NO_CARTAO, montarTira };
