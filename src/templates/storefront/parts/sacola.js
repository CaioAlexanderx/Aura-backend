// AURA. -- storefront/parts/sacola.js
//
// A sacola que sobrevive (fase 6 do redesign, 02/09/2026).
//
// Ate aqui a sacola vivia na memoria: fechar a aba, abrir uma categoria
// pelo link do banner ou voltar pelo historico jogava tudo fora — e por
// isso o CTA do banner abria em nova aba. Agora ela e gravada no
// localStorage por loja e volta no proximo acesso (ate 7 dias).
//
// Tambem mora aqui o resumo lateral do checkout (a coluna fixa da
// direita no design): itens com foto, subtotal, entrega, desconto do
// Pix e total. E o desconto do Pix como a CLIENTE ve — o servidor
// calcula o dele ao criar o pedido, e os dois usam o mesmo percentual
// (pix_discount_pct), entao batem.
'use strict';

module.exports = `
var CHAVE_DA_SACOLA='aura_sacola_'+SLUG;
var VALIDADE_DA_SACOLA=7*24*60*60*1000;

function salvarSacola(){
  try{
    if(!window.localStorage) return;
    var itens=Object.values(cart);
    if(!itens.length){ window.localStorage.removeItem(CHAVE_DA_SACOLA); return; }
    window.localStorage.setItem(CHAVE_DA_SACOLA, JSON.stringify({ ts:Date.now(), itens:itens }));
  }catch(_){}
}

/** Volta a sacola do ultimo acesso. Item sem preco ou sem id nao entra. */
function carregarSacola(){
  try{
    if(!window.localStorage) return;
    var raw=window.localStorage.getItem(CHAVE_DA_SACOLA);
    if(!raw) return;
    var d=JSON.parse(raw);
    if(!d||!d.ts||(Date.now()-d.ts)>VALIDADE_DA_SACOLA){ window.localStorage.removeItem(CHAVE_DA_SACOLA); return; }
    (d.itens||[]).forEach(function(i){
      if(!i||!i.key||!i.product_id||!(i.qty>0)||i.price==null) return;
      cart[i.key]={ key:i.key, product_id:i.product_id, variant_id:i.variant_id||null, name:i.name||'', price:Number(i.price), image_url:i.image_url||null, qty:Math.round(i.qty) };
    });
  }catch(_){}
}

/** Percentual do Pix da loja (migration 309). 0 = nao ha desconto. */
function pctDoPix(){ return Number(__S.pix_discount_pct)||0; }
/** O desconto sobre o SUBTOTAL — frete nao tem desconto. */
function descontoPix(sub){ var p=pctDoPix(); return p>0?Math.round(sub*p)/100:0; }

/**
 * O resumo da direita no checkout. Redesenha a cada passo e a cada
 * mudanca de entrega/pagamento — e uma funcao so, entao subtotal, frete,
 * desconto e total nunca discordam entre o passo 1 e o passo 3.
 */
function renderResumoDoCheckout(){
  var el=document.getElementById('checkoutResumo'); if(!el) return;
  var itens=Object.values(cart);
  var sub=getSubtotal(), fee=getFee();
  var pm=customerData&&customerData.payment_method;
  var desc=(pm==='pix')?descontoPix(sub):0;
  var pct=pctDoPix();
  var n=itens.reduce(function(s,i){return s+i.qty;},0);
  var linhas=itens.map(function(i){
    var img=i.image_url?'<img src="'+esc(i.image_url)+'" alt="">':'<span class="product-ph-initials" style="font-size:22px;">'+esc(INICIAIS(i.name))+'</span>';
    return '<div class="resumo-item"><div class="resumo-thumb">'+img+'</div>'
      +'<div class="resumo-info"><span class="resumo-nome">'+esc(i.name)+'</span>'
      +'<span class="sf-caption">'+i.qty+' un.</span>'
      +'<span class="mono resumo-preco">'+fmt(i.price*i.qty)+'</span></div>'
      +'<button type="button" class="resumo-x" aria-label="Tirar da sacola" onclick="changeQty(\\''+escJsAttr(i.key)+'\\',-'+i.qty+')">&#215;</button></div>';
  }).join('');
  el.innerHTML='<div class="sf-label">Sua sacola · '+n+(n===1?' item':' itens')+'</div>'
    +linhas
    +'<div class="resumo-totais">'
    +'<div class="resumo-linha"><span>Subtotal</span><span class="mono">'+fmt(sub)+'</span></div>'
    +'<div class="resumo-linha"><span>'+(selectedDelivery==='delivery'?'Entrega':'Retirada')+'</span><span class="mono'+(fee?'':' resumo-gratis')+'">'+(fee?fmt(fee):'Grátis')+'</span></div>'
    +(desc>0?'<div class="resumo-linha resumo-pix"><span>Desconto Pix ('+pct+'%)</span><span class="mono">&minus; '+fmt(desc)+'</span></div>':'')
    +'<div class="resumo-linha resumo-total"><span>'+(desc>0?'Total no Pix':'Total')+'</span><span class="mono">'+fmt(sub-desc+fee)+'</span></div>'
    +'</div>'
    +((__S.rodape_institucional&&__S.rodape_institucional.politica)?'<div class="resumo-nota sf-caption">Troca em até 7 dias após receber.</div>':'');
}
`;
