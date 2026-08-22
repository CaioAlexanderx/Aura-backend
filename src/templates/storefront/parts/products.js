// AURA. -- storefront/parts/products.js
// renderProducts() — grid de produtos com filtro por categoria/busca.
//
// 23/05/2026: layout do card preservado (mesmo aspect/posicionamento)
// mas a foto exibida cai pra primeira variante com image_url quando
// o produto pai nao tem image_url. Isso evita placeholders 'A' em
// catalogos onde o lojista so subiu foto por cor/tamanho.
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
    // 23/05/2026: fallback foto. Se produto pai nao tem image_url,
    // procura a primeira variante com image_url (Array.find).
    // Mantem placeholder (letter) so quando nem pai nem variante tem foto.
    var displayImg=p.image_url;
    if(!displayImg && p.variants && p.variants.length){
      for(var vi=0;vi<p.variants.length;vi++){
        if(p.variants[vi].image_url){displayImg=p.variants[vi].image_url;break;}
      }
    }
    // "contain", nao "cover": cover CORTA a peca — um vestido fotografado
    // inteiro virava um pedaco de tecido. Mesma regra da vitrine Studio.
    // Sem foto, duas iniciais compostas no lugar da primeira letra crua:
    // "KIT 3 PARES MEIA" mostrava "K".
    var imgH=displayImg?'<img src="'+esc(displayImg)+'" alt="" style="width:100%;height:100%;object-fit:contain;padding:6%;">'
      :'<div class="product-ph-initials">'+esc(INICIAIS(p.name))+'</div>';
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
    // Sem foto, cada capa ganha seu proprio degrau do gradiente da loja.
    // Com o gradiente fixo, a Finesse renderizava 373 ladrilhos iguais.
    var tileStyle=displayImg?'':' style="background:'+FUNDO_CAPA(p.name)+'"';
    return '<div class="product-card" onclick="showDetail(\\''+p.id+'\\')" ><div class="product-img"'+tileStyle+'>'+imgH+'</div><div class="product-body">'
      +(p.category?'<div class="product-cat">'+esc(p.category)+'</div>':'')
      +'<div class="product-name">'+esc(p.name)+'</div>'
      +(p.description?'<div class="product-desc">'+esc((p.description||'').substring(0,80))+((p.description||'').length>80?'...':'')+'</div>':'')
      +'<div class="product-footer"><div>'+priceH+'</div>'+actionH+'</div></div></div>';
  }).join('');
}
`;
