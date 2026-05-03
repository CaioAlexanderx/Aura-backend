// AURA. -- storefront/parts/products.js
// renderProducts() — grid de produtos com filtro por categoria/busca.
'use strict';

module.exports = `
function renderProducts(){
  var grid=document.getElementById('productsGrid'); if(!grid) return;
  var filtered=PRODUCTS.filter(function(p){
    var mc=currentCat==='Todos'||p.category===currentCat;
    var ms=!searchTerm||(p.name||'').toLowerCase().indexOf(searchTerm.toLowerCase())>=0||(p.description||'').toLowerCase().indexOf(searchTerm.toLowerCase())>=0;
    return mc&&ms&&p.in_stock;
  });
  document.getElementById('prodCount').textContent=filtered.length+' produto'+(filtered.length!==1?'s':'');
  if(!filtered.length){
    grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:60px 0;color:var(--text-3);"><div style="font-size:40px;margin-bottom:12px;">🔍</div><div style="font-size:15px;font-weight:700;">Nenhum produto encontrado</div></div>';
    return;
  }
  grid.innerHTML=filtered.map(function(p){
    var qty=getProductCartQty(p.id);
    var hasVar=productHasVariants(p);
    var imgH=p.image_url?'<img src="'+esc(p.image_url)+'" alt="" style="width:100%;height:100%;object-fit:cover;">'
      :'<div style="font-size:32px;font-weight:800;color:var(--primary);">'+esc((p.name||'?')[0].toUpperCase())+'</div>';
    var priceH=(SETTINGS.show_prices!==false&&p.price!=null)?'<div class="product-price">'+fmt(p.price)+'</div>':'';
    var actionH;
    if(hasVar){
      // Produto com variantes: botão sempre abre o detalhe pra escolher
      actionH=qty>0
        ?'<button class="add-btn" onclick="event.stopPropagation();showDetail(\\''+p.id+'\\')" title="Adicionar mais"><span style="font-size:11px;font-weight:700;">'+qty+'</span></button>'
        :'<button class="add-btn" onclick="event.stopPropagation();showDetail(\\''+p.id+'\\')" title="Escolher variante">→</button>';
    }else{
      // Produto simples: + e qty-ctrl direto no card
      var k=cartKey(p.id,null);
      actionH=qty>0
        ?'<div class="qty-ctrl"><button class="qty-btn" onclick="event.stopPropagation();changeQty(\\''+k+'\\',-1)">−</button><span class="qty-num">'+qty+'</span><button class="qty-btn" onclick="event.stopPropagation();changeQty(\\''+k+'\\',1)">+</button></div>'
        :'<button class="add-btn" onclick="event.stopPropagation();addToCart(\\''+p.id+'\\')" >+</button>';
    }
    return '<div class="product-card" onclick="showDetail(\\''+p.id+'\\')" ><div class="product-img">'+imgH+'</div><div class="product-body">'
      +(p.category?'<div class="product-cat">'+esc(p.category)+'</div>':'')
      +'<div class="product-name">'+esc(p.name)+'</div>'
      +(p.description?'<div class="product-desc">'+esc((p.description||'').substring(0,80))+((p.description||'').length>80?'...':'')+'</div>':'')
      +'<div class="product-footer"><div>'+priceH+'</div>'+actionH+'</div></div></div>';
  }).join('');
}
`;
