// AURA. -- storefront/parts/campanha.js
// A faixa de Black Friday na loja online (p-119b, 14/11/2026). Desenho
// aprovado pelo Caio no mockup "Black Friday na loja online".
//
// SO ENTRA NA LOJA COM A CAMPANHA NO AR: o payload traz `campanha`
// (p-118, services/campanhaDaLoja.js) so com a campanha ligada E promocao
// no ar. Nas outras lojas a pagina sai byte a byte igual, como no pagar na
// entrega e no "De" riscado: este arquivo nao edita home.js, products.js
// nem product_detail.js. Troca trechos EXATOS (cada um com a contagem
// esperada; se sumir, aplicar() quebra no teste) e acrescenta o resto.
//
// Na tela, com a campanha no ar:
//   - faixa fina preta no topo de toda pagina (home, categoria e a pagina
//     do produto): "BLACK FRIDAY · ATE 40% OFF · ATE 30/11";
//   - faixa grande na home, com "Ver ofertas";
//   - "Ofertas" no menu (barra de cima, gaveta do celular e rodape), uma
//     vista como "Novidades": a grade inteira so com as pecas em promocao
//     no ar (rota /catalogo?promo=1).
// Dourado #f5c542 sobre preto #0a0a0a em toda loja, clara ou escura
// (contraste acima de 7:1). Sem contagem regressiva. O "ate N%" e a data
// vem prontos do servidor; aqui so se formata DD/MM.
'use strict';

const DOURADO = '#f5c542';
const PRETO = '#0a0a0a';

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 'AAAA-MM-DD' -> 'DD/MM'; outro formato, ''. */
function diaMes(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}` : '';
}

/**
 * A campanha do payload, pronta para desenhar, ou null. So vale com
 * ativa === true e um desconto de verdade (o servidor ja garante; aqui e
 * a ultima trava para nunca desenhar "ate 0% OFF").
 */
function campanhaNoAr(data) {
  const c = data && data.campanha;
  if (!c || c.ativa !== true) return null;
  const pct = Math.floor(Number(c.ate_pct));
  if (!(pct > 0 && pct < 100)) return null;
  // p-122: `frase` so existe quando a loja escreveu a dela; sem ela, o
  // texto padrao (a pagina sai igual a de antes).
  const frase = typeof c.frase === 'string' ? c.frase.replace(/\s+/g, ' ').trim() : '';
  const titulo = String(c.titulo || 'Black Friday').trim() || 'Black Friday';
  return {
    titulo,
    ate_pct: pct,
    ate: diaMes(c.ate_data),
    ...(frase ? { frase } : {}),
    // p-122: titulo escrito com uma palavra longa (o pior caso e 28 "W"
    // juntos) nao cabe numa linha a 375 px e nao tem espaco para quebrar.
    ...(PALAVRA_LONGA.test(titulo) ? { quebrar: true } : {}),
  };
}

/** Texto da faixa fina, ja escapado. */
function textoDaFaixa(c) {
  // <wbr> depois do ponto: no celular a faixa quebra entre os trechos
  // (cada trecho e nowrap), nunca no meio de "ate 30/11".
  const sep = '<span class="bf-sep" aria-hidden="true">·</span><wbr>';
  return `<span>${escHtml(c.titulo)}</span>${sep}<span>até ${c.ate_pct}% OFF</span>`
    + (c.ate ? `${sep}<span>até ${c.ate}</span>` : '');
}

function htmlDaFaixaFina(c) {
  return `<div class="bf-faixa" role="note">${textoDaFaixa(c)}</div>\n`;
}

function htmlDaFaixaGrande(c) {
  const ate = c.ate ? ` até ${c.ate}` : '';
  const frase = c.frase
    ? escHtml(c.frase)
    : `Preços já com desconto${ate}. Os melhores achados, só enquanto durar a promoção.`;
  return `
<section class="bf-hero" aria-label="${escHtml(c.titulo)}">
  <div class="bf-hero-txt">
    <div class="bf-hero-k">${escHtml(c.titulo)}</div>
    <h2 class="bf-hero-h">Até <em>${c.ate_pct}% OFF</em></h2>
    <p class="bf-hero-p">${frase}</p>
  </div>
  <button type="button" class="bf-hero-cta" onclick="verTudo('ofertas')">Ver ofertas <span aria-hidden="true">→</span></button>
</section>
`;
}

// Palavra sem espaco a partir deste tamanho pode passar da tela no celular
// (a 375 px a faixa grande cabe ~20 "W" com o espacamento das letras).
const PALAVRA_LONGA = /\S{16,}/;

// So com palavra longa no titulo: o titulo da faixa fina e o da faixa
// grande quebram no meio da palavra em vez de passar da tela. Fora disso a
// pagina sai byte a byte igual (os titulos prontos nunca chegam aqui).
const CSS_PALAVRA_LONGA = `
.bf-faixa>span:first-child{white-space:normal;overflow-wrap:anywhere}
.bf-hero-k{overflow-wrap:anywhere}
.bf-hero-txt{min-width:0;max-width:100%}
`;

/** O CSS da campanha para esta campanha (campanhaNoAr). */
function cssDe(c) {
  return CSS + (c && c.quebrar ? CSS_PALAVRA_LONGA : '');
}

const CSS = `
.bf-faixa{background:${PRETO};color:${DOURADO};text-align:center;padding:9px 14px;font-weight:800;font-size:12px;letter-spacing:.16em;text-transform:uppercase;line-height:1.4}
.bf-faixa span{white-space:nowrap}
.bf-faixa .bf-sep{color:#fff;font-weight:500;margin:0 10px}
.bf-hero{position:relative;overflow:hidden;background:${PRETO};color:#fff;font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;gap:24px;padding:40px max(20px,calc((100% - 1280px)/2 + 32px))}
.bf-hero::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 60% 120% at 90% 0%,rgba(245,197,66,.28),transparent 60%),repeating-linear-gradient(135deg,rgba(255,255,255,.035) 0 2px,transparent 2px 14px)}
.bf-hero>*{position:relative}
.bf-hero-k{color:${DOURADO};font-weight:800;font-size:13px;letter-spacing:.3em;text-transform:uppercase}
.bf-hero-h{margin:8px 0 6px;font-family:inherit;font-weight:800;font-size:clamp(34px,6vw,66px);line-height:.95;letter-spacing:-.04em;color:#fff}
.bf-hero-h em{font-style:normal;color:${DOURADO}}
.bf-hero-p{margin:0;color:#c9c9d6;font-size:14px;max-width:52ch}
.bf-hero-cta{margin-left:auto;flex:none;background:${DOURADO};color:${PRETO};border:0;border-radius:999px;padding:14px 26px;font:inherit;font-weight:800;font-size:14px;cursor:pointer;white-space:nowrap}
.bf-hero-cta:focus-visible{outline:2px solid #fff;outline-offset:3px}
body:not(.home) .bf-hero{display:none}
.topnav-item.bf-ofertas,.drawer-item.bf-ofertas{color:${DOURADO};background:${PRETO};border-radius:999px;padding-left:12px;padding-right:12px;font-weight:700}
.drawer-item.bf-ofertas{margin:4px 14px;padding-left:16px;padding-right:16px;width:calc(100% - 28px)}
@media(max-width:700px){
  .bf-faixa{font-size:10.5px;letter-spacing:.12em;padding:8px 10px}
  .bf-faixa .bf-sep{margin:0 6px}
  .bf-hero{flex-direction:column;align-items:flex-start;gap:16px;padding:28px 20px}
  .bf-hero-cta{margin-left:0}
}
`;

/** O JS da campanha: a faixa da pagina do produto e a vista "Ofertas". */
function extra(c) {
  // JSON com "<" escapado: o texto vai dentro de <script>.
  const faixa = JSON.stringify(htmlDaFaixaFina(c).trim()).replace(/</g, '\\u003c');
  return `
// ── Campanha de Black Friday (p-119b) ──
var FAIXA_DA_CAMPANHA=${faixa};
function ofertasNoMenu(){
  return '<button type="button" class="topnav-item bf-ofertas'+(vistaEspecial==='ofertas'?' active':'')+'" onclick="verTudo(&#39;ofertas&#39;)">Ofertas</button>';
}
function ofertasNaGaveta(){
  return '<button type="button" class="drawer-item bf-ofertas" onclick="fecharDrawer();verTudo(&#39;ofertas&#39;)">Ofertas</button>';
}
function ofertasNoRodape(){
  return '<li><a href="#" onclick="verTudo(&#39;ofertas&#39;);return false;">Ofertas</a></li>';
}
`;
}

// [trecho exato, o que entra no lugar, quantas vezes o trecho aparece]
const TROCAS_DA_HOME = [
  // "Ofertas" e uma vista, como "Novidades": titulo e migalhas proprios.
  [
    "var VISTAS={ novidades:'Novidades', mais_vendidos:'Mais vendidos', todos:'Todas as peças' };",
    "var VISTAS={ novidades:'Novidades', mais_vendidos:'Mais vendidos', todos:'Todas as peças', ofertas:'Ofertas' };",
    1,
  ],
  // Na vista de ofertas a ordem e a de destaque.
  [
    "ordem=(criterio==='todos')?'destaque':criterio;",
    "ordem=(criterio==='todos'||criterio==='ofertas')?'destaque':criterio;",
    1,
  ],
  // "#vista=ofertas" (link colado e CTA de banner) abre a vista.
  [
    '/^#vista=(todos|novidades|mais_vendidos)$/',
    '/^#vista=(todos|novidades|mais_vendidos|ofertas)$/',
    2,
  ],
  // O item no menu de cima, depois das categorias.
  [
    '  nav.innerHTML=itens;\n',
    '  itens+=ofertasNoMenu();\n  nav.innerHTML=itens;\n',
    1,
  ],
  // Na gaveta do celular, logo depois de "Novidades".
  [
    'Novidades</button><div class="drawer-sep"></div>\';',
    'Novidades</button>\'+ofertasNaGaveta()+\'<div class="drawer-sep"></div>\';',
    1,
  ],
  // No rodape, antes de "Minha sacola".
  [
    'li+=\'<li><a href="#" onclick="openCart();return false;">Minha sacola</a></li>\';',
    'li+=ofertasNoRodape();\n  li+=\'<li><a href="#" onclick="openCart();return false;">Minha sacola</a></li>\';',
    1,
  ],
];

const TROCAS_DOS_PRODUTOS = [
  // A vista "Ofertas" pede ao servidor so as pecas em promocao no ar.
  [
    "if(typeof paramsDeFiltro==='function') q=q.concat(paramsDeFiltro());",
    "if(typeof paramsDeFiltro==='function') q=q.concat(paramsDeFiltro());\n  if(typeof vistaEspecial!=='undefined'&&vistaEspecial==='ofertas') q.push('promo=1');",
    1,
  ],
];

const TROCAS_DO_DETALHE = [
  // A faixa fina tambem na pagina do produto, acima do "Voltar".
  [
    "'<div class=\"pd-topo\"><div class=\"pd-topo-inner\">'",
    "FAIXA_DA_CAMPANHA+'<div class=\"pd-topo\"><div class=\"pd-topo-inner\">'",
    1,
  ],
];

// No HTML do servidor: a faixa grande entra depois do cabecalho e da
// gaveta, antes do banner da loja.
const ANCORA_DA_FAIXA_GRANDE = '<aside class="drawer" id="drawerMenu" hidden aria-label="Categorias"></aside>\n';

function trocar(src, trocas, nome) {
  let out = src;
  for (const [de, para, vezes] of trocas) {
    const n = out.split(de).length - 1;
    if (n !== vezes) {
      throw new Error(`campanha: trecho do ${nome} encontrado ${n} vezes (esperado ${vezes}): ${de.slice(0, 80)}`);
    }
    out = out.split(de).join(para);
  }
  return out;
}

const aplicarNaHome = (src, c) => trocar(src, TROCAS_DA_HOME, 'home') + extra(c);
const aplicarNosProdutos = (src) => trocar(src, TROCAS_DOS_PRODUTOS, 'products');
const aplicarNoDetalhe = (src) => trocar(src, TROCAS_DO_DETALHE, 'detalhe');

/** O corpo da pagina com a faixa fina no topo e a grande na home. */
function aplicarNoCorpo(body, c) {
  const n = body.split(ANCORA_DA_FAIXA_GRANDE).length - 1;
  if (n !== 1) throw new Error(`campanha: ancora da faixa grande encontrada ${n} vezes (esperado 1)`);
  return htmlDaFaixaFina(c) + body.replace(ANCORA_DA_FAIXA_GRANDE, () => ANCORA_DA_FAIXA_GRANDE + htmlDaFaixaGrande(c));
}

module.exports = {
  campanhaNoAr, diaMes, htmlDaFaixaFina, htmlDaFaixaGrande, CSS, cssDe,
  aplicarNaHome, aplicarNosProdutos, aplicarNoDetalhe, aplicarNoCorpo,
  TROCAS_DA_HOME, TROCAS_DOS_PRODUTOS, TROCAS_DO_DETALHE, ANCORA_DA_FAIXA_GRANDE,
};
