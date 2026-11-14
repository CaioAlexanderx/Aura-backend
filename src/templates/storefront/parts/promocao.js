// AURA. -- storefront/parts/promocao.js
// O "De" riscado na loja online (p-119a, 14/11/2026). Desenho aprovado
// pelo Caio no mockup "Black Friday na loja online".
//
// SO ENTRA NA PAGINA DA LOJA QUE TEM PROMOCAO NO AR (algum produto ou
// variante do payload com em_promocao — o De/Por do Estoque, p-84/p-85).
// Nas outras lojas o <script> sai byte a byte igual ao de antes, como no
// pagar na entrega (na_entrega.js): este arquivo nao edita card.js nem
// product_detail.js. Ele troca trechos EXATOS (TROCAS_*) e acrescenta as
// funcoes novas (EXTRA). Cada trecho tem de existir uma vez so; se alguem
// mudar o cartao ou a pagina do produto e o trecho sumir, aplicar() quebra
// no teste em vez de a loja sair sem o preco riscado.
//
// Na tela, so em peca com promocao no ar:
//   - cartao: o "De" riscado antes do preco, e a etiqueta "-N%" no lugar
//     do selo NOVO;
//   - pagina do produto: o "De" riscado, a etiqueta "-N%" e "Promocao ate
//     DD/MM". Variante com promocao propria segue a regra dela; variante
//     com preco proprio e sem promocao nao mostra "De".
// Parcela e Pix ja eram calculados sobre `price`, que o servidor manda com
// o preco promocional (o mesmo que o pedido cobra). Nada muda no preco.
//
// O "-N%" arredonda PARA BAIXO: a etiqueta nunca promete mais do que a
// loja da (139,90 -> 97,90 e 30,02%: "-30%"). A faixa da campanha (p-118)
// usa a mesma regra no servidor.
'use strict';

const EXTRA = `
// ── O "De" riscado (p-119a) ──
function estiloDaPromocao(){
  if(document.getElementById('estiloDaPromocao')) return;
  var css='.product-de{font-size:12.5px;font-weight:400;color:var(--sf-ink-3);text-decoration:line-through}'
    +'body.card-style-image-heavy .product-de{color:rgba(255,255,255,.72)}'
    +'.card-off,.pd-off{background:#0a0a0a;color:#f5c542;border-radius:999px;font-weight:800;letter-spacing:.04em;pointer-events:none}'
    +'.card-off{position:absolute;top:10px;left:10px;padding:4px 9px;font-size:11px}'
    +'.pd-de{font-size:16px;color:var(--sf-ink-3);text-decoration:line-through}'
    +'.pd-off{display:inline-block;padding:3px 10px;font-size:12px;align-self:center}'
    +'.pd-ate{display:inline-block;align-self:flex-start;background:#0a0a0a;color:#f5c542;font-size:12px;font-weight:700;border-radius:999px;padding:3px 10px}'
    +'.pr-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}'
    +'@media (max-width:640px){.card-off{top:8px;left:8px;padding:3px 8px;font-size:10px}}';
  var st=document.createElement('style'); st.id='estiloDaPromocao'; st.textContent=css;
  document.head.appendChild(st);
}
/** Desconto em %, para baixo. 0 quando nao ha desconto de verdade. */
function pctDaPromocao(de,por){
  de=Number(de); por=Number(por);
  if(!(de>0)||!(por>=0)||por>=de) return 0;
  return Math.floor((1-por/de)*100+1e-9);
}
/** "30/11": o dia do fim em Brasilia (UTC-3, sem horario de verao). */
function dataDaPromocao(iso){
  var t=new Date(iso).getTime();
  if(!isFinite(t)) return '';
  var d=new Date(t-1-3*3600*1000);
  var dd=d.getUTCDate(), mm=d.getUTCMonth()+1;
  return (dd<10?'0':'')+dd+'/'+(mm<10?'0':'')+mm;
}
/** A promocao que vale para a escolha: a da variante, a do produto ou nenhuma. */
function promoDaEscolha(p,variante){
  if(variante&&variante.em_promocao&&variante.preco_de!=null) return {de:variante.preco_de,ate:variante.promo_ends_at};
  if(variante&&variante.price_override!=null) return null;
  if(p&&p.em_promocao&&p.preco_de!=null) return {de:p.preco_de,ate:p.promo_ends_at};
  return null;
}
function promoDoCartao(p){
  if(!p||!p.em_promocao||p.preco_de==null||p.price==null) return null;
  if(SETTINGS.show_prices===false) return null;
  var pct=pctDaPromocao(p.preco_de,p.price);
  return pct>0?{de:p.preco_de,pct:pct}:null;
}
function seloDePromocao(p){
  var pr=promoDoCartao(p);
  if(!pr) return '';
  estiloDaPromocao();
  return '<span class="card-off mono">-'+pr.pct+'%</span>';
}
function deRiscado(p){
  var pr=promoDoCartao(p);
  if(!pr) return '';
  estiloDaPromocao();
  return '<s class="product-de mono"><span class="pr-sr">de </span>'+fmt(pr.de)+'</s><span class="pr-sr"> por </span>';
}
function deDoDetalhe(p,variante,v){
  var pr=promoDaEscolha(p,variante);
  if(!pr||!(pctDaPromocao(pr.de,v)>0)) return '';
  estiloDaPromocao();
  return '<s class="pd-de mono"><span class="pr-sr">de </span>'+fmt(pr.de)+'</s><span class="pr-sr"> por </span>';
}
function offDoDetalhe(p,variante,v){
  var pr=promoDaEscolha(p,variante);
  var pct=pr?pctDaPromocao(pr.de,v):0;
  return pct>0?'<span class="pd-off mono">-'+pct+'%</span>':'';
}
function ateDoDetalhe(p,variante,v){
  var pr=promoDaEscolha(p,variante);
  if(!pr||!(pctDaPromocao(pr.de,v)>0)) return '';
  var d=dataDaPromocao(pr.ate);
  return d?'<span class="pd-ate">Promoção até '+d+'</span>':'';
}
`;

// [trecho exato do card.js, o que entra no lugar]
const TROCAS_DO_CARTAO = [
  // A etiqueta "-N%" no lugar do selo (NOVO) quando a peca esta em promocao.
  [
    "var badgeH=badge?'<span class=\"card-badge\">'+esc(badge)+'</span>':'';",
    "var badgeH=seloDePromocao(p)||(badge?'<span class=\"card-badge\">'+esc(badge)+'</span>':'');",
  ],
  // O "De" riscado antes do preco.
  [
    "'<div class=\"product-price-row\"><span class=\"product-price mono\">'+fmt(p.price)+'</span>'",
    "'<div class=\"product-price-row\">'+deRiscado(p)+'<span class=\"product-price mono\">'+fmt(p.price)+'</span>'",
  ],
];

// [trecho exato do product_detail.js, o que entra no lugar]
const TROCAS_DO_DETALHE = [
  // De riscado, Por, etiqueta e "Promocao ate DD/MM" no cartao de preco.
  [
    "      +'<div class=\"pd-preco-linha\"><span class=\"pd-preco mono\">'+fmt(v)+'</span>'\n"
    + "      +(parc?'<span class=\"pd-parcela\">em até '+esc(parc)+' sem juros</span>':'')+'</div>'\n"
    + "      +pix+'</div>';",
    "      +'<div class=\"pd-preco-linha\">'+deDoDetalhe(p,variante,v)+'<span class=\"pd-preco mono\">'+fmt(v)+'</span>'+offDoDetalhe(p,variante,v)\n"
    + "      +(parc?'<span class=\"pd-parcela\">em até '+esc(parc)+' sem juros</span>':'')+'</div>'\n"
    + "      +ateDoDetalhe(p,variante,v)+pix+'</div>';",
  ],
];

function trocar(src, trocas, nome) {
  let out = src;
  for (const [de, para] of trocas) {
    const n = out.split(de).length - 1;
    if (n !== 1) {
      throw new Error(`promocao: trecho do ${nome} encontrado ${n} vezes (esperado 1): ${de.slice(0, 80)}`);
    }
    out = out.replace(de, () => para);
  }
  return out;
}

/** card.js com o "De" riscado e a etiqueta, mais as funcoes novas. */
function aplicarNoCartao(cardSrc) {
  return trocar(cardSrc, TROCAS_DO_CARTAO, 'cartao') + EXTRA;
}

/** product_detail.js com o "De" riscado, a etiqueta e a data do fim. */
function aplicarNoDetalhe(detalheSrc) {
  return trocar(detalheSrc, TROCAS_DO_DETALHE, 'detalhe');
}

const comPromocao = (p) => !!(p && (p.em_promocao === true
  || (Array.isArray(p.variants) && p.variants.some((v) => v && v.em_promocao === true))));

/**
 * O payload tem alguma peca em promocao no ar? Grade, blocos da home e a
 * peca aberta pela URL propria. O servidor so manda em_promocao em peca
 * cuja promocao vale agora (precoEfetivo), entao loja sem promocao no ar
 * devolve false e a pagina sai como antes.
 */
function temPromocaoNoPayload(data) {
  if (!data) return false;
  const home = data.home || {};
  const listas = [data.products, home.mais_vendidos, home.ultimas_unidades, home.novidades];
  if (listas.some((l) => Array.isArray(l) && l.some(comPromocao))) return true;
  return comPromocao(data.produto_inicial);
}

module.exports = {
  aplicarNoCartao, aplicarNoDetalhe, temPromocaoNoPayload,
  EXTRA, TROCAS_DO_CARTAO, TROCAS_DO_DETALHE,
};
