// AURA. -- storefront/parts/card.js
//
// O cartao de produto (fase 3 do redesign, 02/09/2026).
//
// UMA funcao pra grade (parts/products.js) e pros blocos da home
// (parts/home.js): o cartao de "Mais vendidos" e o cartao da pagina 2 sao
// o mesmo cartao. Canvas 3:4 com a foto em contain, selo NOVO (is_new —
// regra de 14 dias do servidor), preco em DM Mono com a parcela ao lado,
// a linha do Pix em verde e a grade de tamanhos com saldo. Saiu o texto
// da categoria e o trecho da descricao: a decisao acontece na pagina do
// produto, e o cartao inteiro leva pra la.
//
// ATENCAO ao escape: este arquivo e um template literal que vira JS no
// navegador. Um `\\'` aqui chega ao navegador como `\'` — e e o que o
// onclick precisa dentro de aspas duplas.
'use strict';

module.exports = `
// ── Tamanhos do cartao ───────────────────────────────────
/** A escala, do menor pro maior; numeros vem antes, por valor. */
var ESCALA_TAM=['PP','P','M','G','GG','XG','XGG','U'];
function normTam(v){
  var t=String(v==null?'':v).trim().toUpperCase();
  if(!t) return '';
  if(/^(U|UN|UNI|UNICO|ÚNICO|TAMANHO UNICO|TAMANHO ÚNICO)$/.test(t)) return 'U';
  return t;
}
/** Os tamanhos COM SALDO de uma peca, sem repetir, na ordem da regua. */
function tamanhosDoCartao(p){
  var vistos={}, lista=[];
  (p&&p.variants||[]).forEach(function(v){
    if(!(v.stock_qty>0)) return;
    (v.values||[]).forEach(function(av){
      var a=String(av.attribute||'').toLowerCase();
      if(a!=='tamanho'&&a!=='tamanhos') return;
      var t=normTam(av.value);
      if(t&&!vistos[t]){ vistos[t]=1; lista.push(t); }
    });
  });
  lista.sort(function(a,b){
    var na=parseFloat(a), nb=parseFloat(b);
    var an=!isNaN(na), bn=!isNaN(nb);
    if(an&&bn) return na-nb;
    if(an) return -1; if(bn) return 1;
    var ia=ESCALA_TAM.indexOf(a), ib=ESCALA_TAM.indexOf(b);
    if(ia<0) ia=99; if(ib<0) ib=99;
    return ia-ib||a.localeCompare(b);
  });
  return lista.map(function(t){ return t==='U'?'Único':t; });
}

// ── O cartao ─────────────────────────────────────────────
function cardHtml(p,opts){
  opts=opts||{};
  var qty=getProductCartQty(p.id);
  // Fallback foto: sem image_url no pai, a primeira variante com foto.
  var displayImg=p.image_url;
  if(!displayImg && p.variants && p.variants.length){
    for(var vi=0;vi<p.variants.length;vi++){
      if(p.variants[vi].image_url){displayImg=p.variants[vi].image_url;break;}
    }
  }
  // "contain", nao "cover": cover CORTA a peca. Sem foto, duas iniciais.
  var imgH=displayImg?'<img src="'+esc(displayImg)+'" alt="" loading="lazy">'
    :'<div class="product-ph-initials">'+esc(INICIAIS(p.name))+'</div>';
  var badge=opts.badge||(p.is_new?'NOVO':'');
  var badgeH=badge?'<span class="card-badge">'+esc(badge)+'</span>':'';
  var parcH=PARCELAS_TXT(p.price);
  var pixPct=Number(__S.pix_discount_pct)||0;
  var pixH=(pixPct>0&&p.price!=null)?'<div class="product-pix">'+fmt(p.price*(1-pixPct/100))+' no Pix &middot; -'+pixPct+'%</div>':'';
  var priceH=(SETTINGS.show_prices!==false&&p.price!=null)
    ?'<div class="product-price-row"><span class="product-price mono">'+fmt(p.price)+'</span>'+(parcH?'<span class="product-parcela">'+esc(parcH)+'</span>':'')+'</div>'+pixH
    :'';
  var tams=tamanhosDoCartao(p);
  var tamH=tams.length?'<div class="card-tams">'+tams.map(function(t){return '<span>'+esc(t)+'</span>';}).join('')+'</div>':'';
  var noCarrinho=qty>0?'<div class="card-tag">'+qty+' no carrinho</div>':'';
  var tileStyle=displayImg?'':' style="background:'+FUNDO_CAPA(p.name)+'"';
  return '<div class="product-card" onclick="showDetail(\\''+p.id+'\\')" role="link" tabindex="0" onkeydown="if(event.key===\\'Enter\\')showDetail(\\''+p.id+'\\')">'
    +'<div class="product-img"'+tileStyle+'>'+imgH+badgeH+'</div>'
    +'<div class="product-body"><div class="product-name">'+esc(p.name)+'</div>'
    +priceH+tamH+noCarrinho+'</div></div>';
}
`;
