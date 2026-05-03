// AURA. -- storefront/parts/cart.js
// Carrinho: addToCart, changeQty, getCount/Subtotal/Fee, updateCartUI, openCart, closeCart, filterCat, search.
'use strict';

module.exports = `
function addToCart(productId,variantId){
  variantId = variantId || null;
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
  var b=document.getElementById('cartBadge');b.classList.add('pulse');setTimeout(function(){b.classList.remove('pulse');},300);
  showToast(esc(name)+' adicionado!');
}

function changeQty(key,d){if(!cart[key])return;cart[key].qty+=d;if(cart[key].qty<=0)delete cart[key];updateCartUI();renderProducts();}
function getCount(){return Object.values(cart).reduce(function(s,i){return s+i.qty;},0);}
function getSubtotal(){return Object.values(cart).reduce(function(s,i){return s+i.price*i.qty;},0);}
function getFee(){return selectedDelivery==='delivery'?parseFloat(SETTINGS.delivery_fee)||0:0;}

function updateCartUI(){
  var count=getCount(),sub=getSubtotal(),fee=getFee();
  var badge=document.getElementById('cartBadge');
  badge.textContent=count;badge.classList.toggle('visible',count>0);
  var items=document.getElementById('cartItems'),footer=document.getElementById('cartFooter');
  if(!count){
    items.innerHTML='<div style="text-align:center;padding:60px 20px;"><div style="font-size:52px;margin-bottom:12px;">🛒</div><div style="font-size:15px;font-weight:700;color:var(--text-2);">Carrinho vazio</div></div>';
    footer.style.display='none';return;
  }
  items.innerHTML=Object.values(cart).map(function(i){
    var img=i.image_url?'<img src="'+esc(i.image_url)+'" alt="">':'<span style="font-size:22px;">🛍️</span>';
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
  document.getElementById('cartTotal').textContent=fmt(sub+fee);
  footer.style.display='block';
}

function openCart(){document.getElementById('cartOverlay').classList.add('open');document.getElementById('cartDrawer').classList.add('open');document.body.style.overflow='hidden';}
function closeCart(){document.getElementById('cartOverlay').classList.remove('open');document.getElementById('cartDrawer').classList.remove('open');document.body.style.overflow='';}
function filterCat(cat,el){currentCat=cat;document.querySelectorAll('.cat-chip').forEach(function(c){c.classList.remove('active');});el.classList.add('active');document.getElementById('catTitle').textContent=cat==='Todos'?'Todos os produtos':cat;renderProducts();}
var searchOpen=false;
function toggleSearch(){searchOpen=!searchOpen;var bar=document.getElementById('searchBar');bar.classList.toggle('open',searchOpen);if(searchOpen)document.getElementById('searchInput').focus();else{document.getElementById('searchInput').value='';searchTerm='';renderProducts();}}
function filterProducts(){searchTerm=document.getElementById('searchInput').value;renderProducts();}
`;
