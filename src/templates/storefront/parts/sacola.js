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
//
// p-124 (15/11/2026): o preco de agora. A sacola guarda o preco da hora em
// que o item entrou; promocao que encerrou (Black Friday que acabou no dia
// 30) ou preco que a lojista mudou faziam o resumo mostrar um total e o Pix
// cobrar outro. Ao abrir a sacola e o checkout, a vitrine pergunta ao
// servidor o preco de AGORA de cada item (POST /sacola/precos, o mesmo
// calculo do pedido, services/itensDoPedidoOnline.js). Subiu: o valor muda
// e a cliente le UM aviso gentil. Baixou: muda em silencio. Sem rede: fica
// como estava, o servidor cobra o preco de agora e, com o pedido criado, a
// sacola e o resumo passam a ser os do pedido (acertarPeloPedido).
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
      // O nome e recalculado do catalogo de hoje (nomeDoItem, cart.js): um
      // rotulo salvo antes de uma correcao ("(#000000)") nao sobrevive na
      // sacola por sete dias. Variante que sumiu do catalogo fica com o
      // nome salvo — e melhor que perder a cor.
      var p=PROD_MAP[i.product_id];
      var v=p?varianteDoProduto(p,i.variant_id||null):null;
      var nome=(p&&(v||!i.variant_id))?nomeDoItem(p,v):(i.name||'');
      cart[i.key]={ key:i.key, product_id:i.product_id, variant_id:i.variant_id||null, name:nome, price:Number(i.price), image_url:i.image_url||null, qty:Math.round(i.qty) };
    });
  }catch(_){}
}

// ── O preco de agora (p-124) ──
var avisoDePreco='';
var conferenciaDePreco=null;
var ultimaConferencia=null;
var pedidoDoResumo=null;
function centavosDe(v){ return Math.round(Number(v)*100); }
function assinaturaDaSacola(){ return Object.values(cart).map(function(i){ return i.key+'x'+i.qty; }).join('|'); }
/** "O preco de 1 item mudou desde que voce o adicionou: Blusa, de R$ 98,90 para R$ 139,90." */
function textoDoAvisoDePreco(subiram){
  var n=subiram.length;
  var lista=subiram.map(function(s){ return s.nome+', de '+fmt(s.de)+' para '+fmt(s.para); }).join('; ');
  return (n===1?'O preço de 1 item mudou desde que você o adicionou: ':'O preço de '+n+' itens mudou desde que você os adicionou: ')+lista+'.';
}
function htmlDoAvisoDePreco(){ return avisoDePreco?'<p class="aviso-fechada aviso-preco" role="status">'+esc(avisoDePreco)+'</p>':''; }
/** [{key, preco}] acerta a sacola. Devolve {mudou, subiram}. */
function aplicarPrecosDeAgora(lista){
  var subiram=[], mudou=false;
  (lista||[]).forEach(function(r){
    if(!r||r.preco==null) return;
    var i=cart[r.key]; if(!i) return;
    var novo=Number(r.preco);
    if(!isFinite(novo)||novo<0||centavosDe(novo)===centavosDe(i.price)) return;
    if(centavosDe(novo)>centavosDe(i.price)) subiram.push({ nome:i.name, de:i.price, para:novo });
    i.price=centavosDe(novo)/100; mudou=true;
  });
  if(subiram.length) avisoDePreco=textoDoAvisoDePreco(subiram);
  if(mudou) updateCartUI();
  return { mudou:mudou, subiram:subiram };
}
/** A resposta vem na ordem do que foi enviado: o indice aponta a chave. */
function precosPelasChaves(lista, chaves, campo){
  return (lista||[]).map(function(r,k){
    if(!r) return null;
    var key=chaves[(r.indice!=null)?r.indice:k];
    if(!key||!cart[key]||cart[key].product_id!==r.product_id) key=cartKey(r.product_id,r.variant_id||null);
    return { key:key, preco:r[campo] };
  });
}
/**
 * Pergunta ao servidor o preco de agora. Uma conferencia por vez; a mesma
 * sacola conferida ha menos de 30 s nao pergunta de novo (abrir a sacola e
 * logo o checkout). Falha de rede resolve null e a sacola fica como estava.
 */
function conferirPrecosDaSacola(){
  if(conferenciaDePreco) return conferenciaDePreco;
  var itens=Object.values(cart);
  if(!itens.length||typeof fetch!=='function') return Promise.resolve(null);
  var ass=assinaturaDaSacola();
  if(ultimaConferencia&&ultimaConferencia.ass===ass&&(Date.now()-ultimaConferencia.ts)<30000) return Promise.resolve({ mudou:false, subiram:[] });
  var chaves=itens.map(function(i){ return i.key; });
  var corpo={ items:itens.map(function(i){ return { product_id:i.product_id, variant_id:i.variant_id||null, quantity:i.qty }; }) };
  conferenciaDePreco=fetch(API_BASE+'/api/v1/storefront/'+SLUG+'/sacola/precos',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(corpo) })
    .then(function(r){ return r.ok?r.json():null; })
    .then(function(d){
      if(!d||!d.itens) return null;
      var res=aplicarPrecosDeAgora(precosPelasChaves(d.itens,chaves,'preco'));
      ultimaConferencia={ ass:assinaturaDaSacola(), ts:Date.now() };
      return res;
    })
    .catch(function(){ return null; })
    .then(function(x){ conferenciaDePreco=null; return x; });
  return conferenciaDePreco;
}
/** Pedido criado: a sacola e o resumo ficam com o que o servidor cobrou. */
function acertarPeloPedido(pedido, chaves){
  pedidoDoResumo=(pedido&&pedido.total!=null&&pedido.subtotal!=null)?pedido:null;
  if(!pedido||!pedido.itens) return { mudou:false, subiram:[] };
  return aplicarPrecosDeAgora(precosPelasChaves(pedido.itens,chaves||[],'unit_price'));
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
/** No celular os itens do resumo ficam recolhidos; este botao abre. */
function alternarResumo(){ var el=document.getElementById('checkoutResumo'); if(el){ el.classList.toggle('aberto'); renderResumoDoCheckout(); } }

function renderResumoDoCheckout(){
  var el=document.getElementById('checkoutResumo'); if(!el) return;
  var itens=Object.values(cart);
  var sub=getSubtotal(), fee=getFee();
  var pm=customerData&&customerData.payment_method;
  var desc=(pm==='pix')?descontoPix(sub):0;
  // p-124: com o pedido criado, os totais sao os do servidor (o do QR).
  var ped=pedidoDoResumo;
  if(ped){ sub=Number(ped.subtotal)||0; fee=Number(ped.delivery_fee)||0; desc=Math.max(0,centavosDe(sub+fee-Number(ped.total))/100); }
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
  el.innerHTML='<div class="resumo-cabeca"><span class="sf-label">Sua sacola · '+n+(n===1?' item':' itens')+'</span>'
    +'<button type="button" class="resumo-toggle" onclick="alternarResumo()" aria-controls="checkoutResumo">'+(el.classList.contains('aberto')?'Esconder itens':'Ver itens')+'</button></div>'
    +htmlDoAvisoDePreco()
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
