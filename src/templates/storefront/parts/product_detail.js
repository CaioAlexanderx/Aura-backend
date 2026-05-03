// AURA. -- storefront/parts/product_detail.js
// showDetail() — modal do produto com selecao de variantes.
'use strict';

module.exports = `
// ============================================================
// showDetail — modal do produto. Se tiver variantes, mostra
// selects por atributo, atualiza preço dinamicamente, e só
// libera "Adicionar" quando todas as variantes forem escolhidas.
// ============================================================
function showDetail(id){
  var p=PROD_MAP[id];if(!p)return;
  var hasVar=productHasVariants(p);
  var imgH=p.image_url?'<img src="'+esc(p.image_url)+'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:var(--r);">'
    :'<div style="font-size:64px;font-weight:800;color:var(--primary);">'+esc((p.name||'?')[0].toUpperCase())+'</div>';

  // Estado local da seleção de variante
  var attrs={}; // attribute -> [valores únicos]
  var attrOrder=[];
  if(hasVar){
    p.variants.forEach(function(v){
      (v.values||[]).forEach(function(av){
        if(!attrs[av.attribute]){attrs[av.attribute]=[];attrOrder.push(av.attribute);}
        if(attrs[av.attribute].indexOf(av.value)===-1) attrs[av.attribute].push(av.value);
      });
    });
  }
  var selected={}; // attribute -> value
  var selectedVariant=null;

  function findVariant(){
    if(!hasVar) return null;
    if(attrOrder.length===0) return null;
    for(var i=0;i<p.variants.length;i++){
      var v=p.variants[i];
      var vals=v.values||[];
      if(vals.length!==attrOrder.length) continue;
      var match=true;
      for(var j=0;j<vals.length;j++){
        if(selected[vals[j].attribute]!==vals[j].value){match=false;break;}
      }
      if(match) return v;
    }
    return null;
  }

  function variantsBox(){
    if(!hasVar) return '';
    var html='<div class="variant-box" style="margin-bottom:16px;">';
    attrOrder.forEach(function(a){
      html+='<div class="field-group" style="margin-bottom:10px;">'
        +'<label class="field-label" style="display:block;margin-bottom:6px;font-weight:600;">'+esc(a)+'</label>'
        +'<div class="variant-chips" data-attr="'+esc(a)+'" style="display:flex;flex-wrap:wrap;gap:6px;">'
        +attrs[a].map(function(val){
          // Verifica se essa combinação ainda é possível dada a seleção atual
          var possible=p.variants.some(function(v){
            var vmap={}; (v.values||[]).forEach(function(av){vmap[av.attribute]=av.value;});
            if(vmap[a]!==val) return false;
            for(var k in selected){ if(k!==a && selected[k] && vmap[k]!==selected[k]) return false; }
            return v.stock_qty>0;
          });
          var isSel=selected[a]===val;
          var cls='variant-chip'+(isSel?' active':'')+(possible?'':' disabled');
          // Swatch de cor: se o valor parece hex (#RRGGBB ou #RGB), renderiza circulo colorido
          var isHex=/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(val);
          if(isHex){
            var ringColor=isSel?'var(--primary)':(possible?'rgba(0,0,0,.15)':'#e5e7eb');
            var swStyle='display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:999px;background:'+val+';border:2px solid '+ringColor+';box-shadow:'+(isSel?'0 0 0 2px #fff inset':'0 0 0 2px #fff inset')+';cursor:'+(possible?'pointer':'not-allowed')+';opacity:'+(possible?'1':'.4')+';transition:all .15s;'+(isSel?'transform:scale(1.05);':'');
            // Checkmark visivel quando selecionado — cor do check ajusta conforme luminosidade
            var r=parseInt(val.length===4?val[1]+val[1]:val.slice(1,3),16);
            var g=parseInt(val.length===4?val[2]+val[2]:val.slice(3,5),16);
            var b=parseInt(val.length===4?val[3]+val[3]:val.slice(5,7),16);
            var luma=(0.299*r+0.587*g+0.114*b);
            var checkColor=luma>160?'#000':'#fff';
            var checkH=isSel?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="'+checkColor+'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':'';
            return '<span class="'+cls+'" data-attr="'+esc(a)+'" data-val="'+esc(val)+'" data-possible="'+(possible?'1':'0')+'" title="'+esc(val)+'" style="'+swStyle+'">'+checkH+'</span>';
          }
          var style='display:inline-flex;align-items:center;justify-content:center;padding:6px 14px;border-radius:999px;border:1.5px solid '+(isSel?'var(--primary)':(possible?'var(--border)':'#e5e7eb'))+';background:'+(isSel?'var(--primary)':'#fff')+';color:'+(isSel?'#fff':(possible?'var(--text)':'#cbd5e1'))+';font-size:13px;font-weight:600;cursor:'+(possible?'pointer':'not-allowed')+';transition:all .15s;';
          return '<span class="'+cls+'" data-attr="'+esc(a)+'" data-val="'+esc(val)+'" data-possible="'+(possible?'1':'0')+'" style="'+style+'">'+esc(val)+'</span>';
        }).join('')
        +'</div></div>';
    });
    html+='</div>';
    return html;
  }

  function priceHtml(){
    if(p.price==null||SETTINGS.show_prices===false) return '';
    var price=(selectedVariant&&selectedVariant.price_override!=null)?selectedVariant.price_override:p.price;
    return '<div style="font-size:24px;font-weight:800;color:var(--primary);margin-bottom:8px;" id="dPrice">'+fmt(price)+'</div>';
  }

  function btnLabel(){
    if(!hasVar){
      var qty=getProductCartQty(p.id);
      return qty>0?'✓ No carrinho ('+qty+')':'+ Adicionar ao carrinho';
    }
    if(!selectedVariant) return 'Escolha as opções';
    var key=cartKey(p.id,selectedVariant.id);
    var qty=cart[key]?cart[key].qty:0;
    return qty>0?'+ Adicionar mais ('+qty+' no carrinho)':'+ Adicionar ao carrinho';
  }

  function btnDisabled(){ return hasVar && !selectedVariant; }

  function stockMsg(){
    if(!hasVar) return '';
    if(!selectedVariant) return '';
    if(selectedVariant.stock_qty<=0) return '<div style="font-size:12px;color:#dc2626;margin:8px 0;">Sem estoque para essa combinação</div>';
    if(SETTINGS.show_stock) return '<div style="font-size:12px;color:var(--text-3);margin:8px 0;">'+selectedVariant.stock_qty+' em estoque</div>';
    return '';
  }

  var ov=document.createElement('div');ov.className='checkout-overlay open';
  ov.innerHTML='<div class="checkout-sheet" style="max-width:420px;"><div class="checkout-head"><div class="checkout-back" id="dClose">←</div><div class="checkout-head-info"><div class="checkout-title">'+esc(p.name)+'</div><div class="checkout-subtitle">'+(p.category||'Produto')+'</div></div><div class="cart-close" id="dCloseX">×</div></div>'
    +'<div class="checkout-body" id="dBody">'
    +'<div style="width:100%;aspect-ratio:1;background:var(--primary-light);border-radius:var(--r);display:flex;align-items:center;justify-content:center;overflow:hidden;margin-bottom:20px;">'+imgH+'</div>'
    +'<div id="dPriceWrap">'+priceHtml()+'</div>'
    +(p.description?'<p style="font-size:13px;color:var(--text-2);line-height:1.6;margin-bottom:16px;">'+esc(p.description)+'</p>':'')
    +'<div id="dVariants">'+variantsBox()+'</div>'
    +'<div id="dStock">'+stockMsg()+'</div>'
    +'</div>'
    +'<div class="checkout-foot"><button class="next-btn'+(btnDisabled()?'':' green')+'" id="dAddBtn"'+(btnDisabled()?' disabled style="opacity:.5;cursor:not-allowed;"':'')+'>'+btnLabel()+'</button></div></div>';
  document.body.appendChild(ov);document.body.style.overflow='hidden';

  function close(){ov.remove();document.body.style.overflow='';}
  ov.querySelector('#dClose').addEventListener('click',close);
  ov.querySelector('#dCloseX').addEventListener('click',close);

  function rerenderVariants(){
    ov.querySelector('#dVariants').innerHTML=variantsBox();
    ov.querySelector('#dPriceWrap').innerHTML=priceHtml();
    ov.querySelector('#dStock').innerHTML=stockMsg();
    var btn=ov.querySelector('#dAddBtn');
    btn.textContent=btnLabel();
    var disabled=btnDisabled()||(selectedVariant&&selectedVariant.stock_qty<=0);
    btn.disabled=!!disabled;
    btn.className='next-btn'+(disabled?'':' green');
    btn.style.opacity=disabled?'.5':'';
    btn.style.cursor=disabled?'not-allowed':'';
    bindChips();
  }

  function bindChips(){
    ov.querySelectorAll('.variant-chip').forEach(function(chip){
      chip.addEventListener('click',function(){
        if(chip.dataset.possible!=='1') return;
        var a=chip.dataset.attr,val=chip.dataset.val;
        if(selected[a]===val) delete selected[a]; else selected[a]=val;
        selectedVariant=findVariant();
        rerenderVariants();
      });
    });
  }
  bindChips();

  ov.querySelector('#dAddBtn').addEventListener('click',function(){
    if(btnDisabled()) return;
    if(hasVar && (!selectedVariant || selectedVariant.stock_qty<=0)) return;
    addToCart(p.id, selectedVariant?selectedVariant.id:null);
    var btn=this;
    btn.textContent='✓ Adicionado';
    btn.className='next-btn green';
    setTimeout(close,700);
  });
}
`;
