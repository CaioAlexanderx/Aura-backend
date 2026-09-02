// AURA. -- storefront/parts/cart.js
// Carrinho: addToCart, changeQty, getCount/Subtotal/Fee, updateCartUI, openCart, closeCart, filterCat, search.
//
// v3.1 (18/05/2026 — Fase 3 PR A): toggleSearch agora opera sobre a classe
// .searching da topbar (search inline). searchBlur sai do modo busca quando
// o input perde foco E está vazio.
'use strict';

module.exports = `
/**
 * @param opcoes.semToast quando quem chamou ja confirma a acao sozinho.
 *   A pagina do produto troca o rotulo do proprio botao; o toast repetiria
 *   a mesma informacao um centimetro ao lado.
 */
function addToCart(productId,variantId,opcoes){
  variantId = variantId || null;
  opcoes = opcoes || {};
  var p=PROD_MAP[productId]; if(!p) return;
  // Se produto tem variantes e não veio variantId, abre o modal pra escolher
  if(productHasVariants(p) && !variantId){
    showDetail(productId);
    return;
  }
  var key=cartKey(productId,variantId);
  var price=p.price;
  var name=p.name;
  if(variantId){
    var v=null;
    for(var i=0;i<(p.variants||[]).length;i++){ if(p.variants[i].id===variantId){v=p.variants[i];break;} }
    if(v){
      if(v.price_override!=null) price=v.price_override;
      var vlabel=(v.values||[]).map(function(x){return x.value;}).join(' / ');
      if(vlabel) name=p.name+' ('+vlabel+')';
    }
  }
  if(!cart[key]) cart[key]={key:key,product_id:productId,variant_id:variantId,name:name,price:price,image_url:p.image_url,qty:0};
  cart[key].qty++;
  updateCartUI();renderProducts();
  // O badge pulsa SEMPRE, com ou sem toast: ele e o unico sinal de que o
  // carrinho cresceu, e fica no cabecalho, longe de onde a pessoa clicou.
  var b=document.getElementById('cartBadge');b.classList.add('pulse');setTimeout(function(){b.classList.remove('pulse');},300);
  if(!opcoes.semToast) showToast(esc(name)+' adicionado!');
}

function changeQty(key,d){if(!cart[key])return;cart[key].qty+=d;if(cart[key].qty<=0)delete cart[key];updateCartUI();renderProducts();}
function getCount(){return Object.values(cart).reduce(function(s,i){return s+i.qty;},0);}
function getSubtotal(){return Object.values(cart).reduce(function(s,i){return s+i.price*i.qty;},0);}
function getFee(){return selectedDelivery==='delivery'?parseFloat(SETTINGS.delivery_fee)||0:0;}

function updateCartUI(){
  var count=getCount(),sub=getSubtotal(),fee=getFee();
  var badge=document.getElementById('cartBadge');
  badge.textContent=count;badge.classList.toggle('visible',count>0);
  // A sacola sobrevive a aba (fase 6) e o resumo do checkout acompanha.
  if(typeof salvarSacola==='function') salvarSacola();
  if(typeof renderResumoDoCheckout==='function') renderResumoDoCheckout();
  var items=document.getElementById('cartItems'),footer=document.getElementById('cartFooter');
  if(!count){
    items.innerHTML='<div class="cart-vazio"><span class="cart-vazio-tit">Sua sacola está vazia</span><span>As peças que você escolher aparecem aqui.</span></div>';
    footer.style.display='none';return;
  }
  items.innerHTML=Object.values(cart).map(function(i){
    var img=i.image_url?'<img src="'+esc(i.image_url)+'" alt="">':'<span class="product-ph-initials" style="font-size:22px;">'+esc(INICIAIS(i.name))+'</span>';
    return '<div class="cart-item"><div class="cart-item-img">'+img+'</div>'
      +'<div class="cart-item-info"><div class="cart-item-name">'+esc(i.name)+'</div><div class="cart-item-price">'+fmt(i.price)+' × '+i.qty+'</div></div>'
      +'<div class="cart-item-right"><div class="cart-item-total">'+fmt(i.price*i.qty)+'</div>'
      +'<div class="qty-ctrl" style="background:var(--bg);"><button class="qty-btn" style="width:24px;height:24px;font-size:14px;" onclick="changeQty(\\''+i.key+'\\',-1)">−</button>'
      +'<span class="qty-num">'+i.qty+'</span>'
      +'<button class="qty-btn" style="width:24px;height:24px;font-size:14px;" onclick="changeQty(\\''+i.key+'\\',1)">+</button></div></div></div>';
  }).join('');
  document.getElementById('cartSubtotal').textContent=fmt(sub);
  document.getElementById('deliveryLabel').textContent=selectedDelivery==='delivery'?'Entrega':'Retirada';
  document.getElementById('deliveryVal').textContent=fee?fmt(fee):'Grátis';
  var desc=(typeof descontoPix==='function')?descontoPix(sub):0;
  var pixRow=document.getElementById('cartPixRow');
  if(pixRow){ pixRow.hidden=!(desc>0); var v=document.getElementById('cartPixVal'); if(v) v.textContent=fmt(sub-desc+fee)+' no Pix'; }
  document.getElementById('cartTotal').textContent=fmt(sub+fee);
  footer.style.display='block';
}

function openCart(){document.getElementById('cartOverlay').classList.add('open');document.getElementById('cartDrawer').classList.add('open');document.body.style.overflow='hidden';}
function closeCart(){document.getElementById('cartOverlay').classList.remove('open');document.getElementById('cartDrawer').classList.remove('open');document.body.style.overflow='';}
function filterCat(cat,el){
  currentCat=cat;
  document.querySelectorAll('.cat-chip').forEach(function(c){c.classList.remove('active');});
  // "el" e null quando o clique veio do painel "Todas as categorias" —
  // ali nao ha chip pra marcar, e renderCategorias() repinta em seguida.
  if(el) el.classList.add('active');
  // currentCat virou CAMINHO quando a loja tem arvore. O titulo mostra o
  // NOME — "/vestidos/festa" no cabecalho da grade seria endereco, nao
  // categoria.
  var rotulo=cat;
  if(typeof nomeDoCaminho==='function'){ rotulo=nomeDoCaminho(cat)||cat; }
  document.getElementById('catTitle').textContent=cat==='Todos'?'Todos os produtos':rotulo;
  // Trocar de categoria refaz a busca NO SERVIDOR e volta pra pagina 1.
  if(typeof renderCategorias==='function') renderCategorias();
  recarregarDoInicio();
}


// Search inline (Fase 3 PR A) — toggle adiciona/remove .searching na .topbar.
// Quando entra em busca foca o input; quando sai limpa input + searchTerm.
var searchOpen=false;
function toggleSearch(){
  searchOpen=!searchOpen;
  var bar=document.getElementById('topbar');
  if(!bar) return;
  bar.classList.toggle('searching',searchOpen);
  var input=document.getElementById('searchInput');
  if(searchOpen){
    if(input) setTimeout(function(){input.focus();},50);
  }else{
    if(input) input.value='';
    searchTerm='';
    recarregarDoInicio();
  }
}
function searchBlur(){
  // Sai do modo busca apenas quando o input estiver vazio — assim o usuário
  // pode clicar fora pra ver os resultados sem perder a query.
  var input=document.getElementById('searchInput');
  if(!input) return;
  if(!input.value){
    searchOpen=false;
    var bar=document.getElementById('topbar');
    if(bar) bar.classList.remove('searching');
  }
}
function filterProducts(){
  var input=document.getElementById('searchInput');
  searchTerm=input?input.value:'';
  // Espera a pessoa parar de digitar: sem isso cada tecla vira uma
  // requisicao, e a resposta da penultima pode chegar depois da ultima.
  if(buscaTimer) clearTimeout(buscaTimer);
  buscaTimer=setTimeout(recarregarDoInicio,320);
}
`;
