// AURA. — Script SPA da vitrine pública
// buildScript(storeData, escapedSlug) → string <script>...</script>
function buildScript(storeData, escapedSlug) {
  return `<script>
var __S = ${storeData};
var SLUG = '${escapedSlug}';
var PRODUCTS = __S.products || [];
var SETTINGS = __S.settings || {};
var CONTACT  = __S.contact  || {};
var SITE     = __S.site     || {};
var PROD_MAP = {};
PRODUCTS.forEach(function(p){ PROD_MAP[p.id] = p; });

(function(){
  var p=SITE.primary_color||'#7c3aed';
  var r=parseInt(p.slice(1,3),16),g=parseInt(p.slice(3,5),16),b=parseInt(p.slice(5,7),16);
  function dim(x){return Math.max(0,Math.round(x*.82)).toString(16).padStart(2,'0');}
  var dk='#'+dim(r)+dim(g)+dim(b);
  var root=document.documentElement;
  root.style.setProperty('--primary',p);
  root.style.setProperty('--primary-dark',dk);
  root.style.setProperty('--primary-light','rgba('+r+','+g+','+b+',.1)');
  root.style.setProperty('--primary-mid','rgba('+r+','+g+','+b+',.07)');
  var li=document.getElementById('logoInitial'); if(li) li.textContent=(SITE.name||'L')[0].toUpperCase();
  var hi=document.getElementById('heroInitial'); if(hi) hi.textContent=(SITE.name||'L')[0].toUpperCase();
})();

(function(){
  var pills=[];
  if(CONTACT.address) pills.push('📍 '+CONTACT.address.split(',')[0]);
  if(SETTINGS.delivery_enabled) pills.push('🚚 Entrega disponível');
  if(SETTINGS.pickup_enabled!==false) pills.push('🏪 Retirada no local');
  var w=document.getElementById('heroPills');
  if(w) w.innerHTML=pills.map(function(p){return '<span class="hero-pill">'+p+'</span>';}).join('');
})();

var ALL_CATS=['Todos'];
PRODUCTS.forEach(function(p){if(p.category&&ALL_CATS.indexOf(p.category)===-1)ALL_CATS.push(p.category);});
(function(){
  var w=document.getElementById('catsWrap'); if(!w) return;
  w.innerHTML=ALL_CATS.map(function(c,i){return '<div class="cat-chip'+(i===0?' active':'')+'" data-ci="'+i+'">'+esc(c)+'</div>';}).join('');
  w.querySelectorAll('.cat-chip').forEach(function(chip){
    chip.addEventListener('click',function(){filterCat(ALL_CATS[parseInt(chip.dataset.ci)],chip);});
  });
})();

// cart é indexado por chave composta: productId OU productId:variantId
// Cada entrada: {key, product_id, variant_id|null, name, price, image_url, qty}
var cart={},currentCat='Todos',searchTerm='';
var checkoutStep=1,selectedDelivery=SETTINGS.pickup_enabled!==false?'pickup':'delivery';
var customerData={},currentOrder=null,pollInterval=null,timerInterval=null;
var paymentMarked=false;

function fmt(v){return 'R$ '+Number(v).toFixed(2).replace('.',',');}
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function cartKey(pid,vid){return pid+(vid?':'+vid:'');}
function getProductCartQty(pid){return Object.values(cart).filter(function(i){return i.product_id===pid;}).reduce(function(s,i){return s+i.qty;},0);}
function productHasVariants(p){return !!(p&&p.variants&&p.variants.length>0);}

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

function openCheckout(){closeCart();checkoutStep=1;selectedDelivery=SETTINGS.pickup_enabled!==false?'pickup':'delivery';renderCheckoutStep();document.getElementById('checkoutOverlay').classList.add('open');document.body.style.overflow='hidden';}
function closeCheckout(){clearInterval(pollInterval);clearInterval(timerInterval);document.getElementById('checkoutOverlay').classList.remove('open');document.body.style.overflow='';}
function checkoutBack(){if(checkoutStep>1&&checkoutStep<3){checkoutStep--;renderCheckoutStep();}else closeCheckout();}

function checkoutNext(){
  if(checkoutStep===1){
    var name=document.getElementById('inp_name')?document.getElementById('inp_name').value.trim():'';
    var phone=document.getElementById('inp_phone')?document.getElementById('inp_phone').value.trim():'';
    var email=document.getElementById('inp_email')?document.getElementById('inp_email').value.trim():'';
    if(!name||!phone){showToast('Preencha nome e telefone');return;}
    customerData={name:name,phone:phone,email:email||null};checkoutStep=2;renderCheckoutStep();
  }else if(checkoutStep===2){
    if(selectedDelivery==='delivery'){
      var addr=document.getElementById('inp_addr')?document.getElementById('inp_addr').value.trim():'';
      if(!addr){showToast('Informe o endereço de entrega');return;}
      var bairro=document.getElementById('inp_bairro')?document.getElementById('inp_bairro').value.trim():'';
      customerData.delivery_address=addr+(bairro?', '+bairro:'');
    }
    var hasPix=!!SETTINGS.has_pix, hasOd=!!SETTINGS.pay_on_delivery_enabled;
    if(hasPix && hasOd){
      customerData.payment_method=null;
      checkoutStep=3; renderCheckoutStep();
    } else if(hasPix){
      customerData.payment_method='pix'; submitOrder();
    } else if(hasOd){
      customerData.payment_method='on_delivery'; submitOrder();
    } else {
      showToast('Loja sem método de pagamento configurado');
    }
  }else if(checkoutStep===3){
    var pm=customerData.payment_method;
    if(pm==='on_delivery'){ closeCheckout(); cart={}; updateCartUI(); renderProducts(); return; }
    if(pm==='pix' && currentOrder){
      if(paymentMarked){ closeCheckout(); cart={}; updateCartUI(); renderProducts(); return; }
      markAsPaid();
    }
  }
}

function renderCheckoutStep(){
  var titles=['Seus dados','Entrega','Pagamento'],subs=['Etapa 1 de 3','Etapa 2 de 3','Etapa 3 de 3'],s=checkoutStep;
  document.getElementById('checkoutTitle').textContent=titles[s-1];
  document.getElementById('checkoutSub').textContent=subs[s-1];
  [1,2,3].forEach(function(i){
    var dot=document.getElementById('dot'+i),lbl=document.getElementById('lbl'+i);
    dot.className='step-dot';lbl.className='step-label';
    if(i<s){dot.classList.add('done');dot.textContent='✓';}
    else if(i===s){dot.classList.add('active');dot.textContent=i;lbl.classList.add('active');}
    else dot.textContent=i;
  });
  var btn=document.getElementById('nextBtn');
  btn.disabled=false;btn.className='next-btn'+(s===3?' green':'');
  btn.textContent=s===1?'Continuar':s===2?'Ir para pagamento':'Já paguei ✓';
  var sub=getSubtotal(),fee=getFee(),body=document.getElementById('checkoutBody');
  if(s===1){
    body.innerHTML='<div class="order-summary">'
      +Object.values(cart).map(function(i){return '<div class="summary-row"><span>'+esc(i.name)+' ×'+i.qty+'</span><span>'+fmt(i.price*i.qty)+'</span></div>';}).join('')
      +'<div class="summary-row total"><span>Total estimado</span><span>'+fmt(sub)+'</span></div></div>'
      +'<div class="field-group"><label class="field-label">Nome completo *</label><input class="field-input" type="text" id="inp_name" placeholder="Maria da Silva" value="'+(customerData.name||'')+'"></div>'
      +'<div class="field-row"><div class="field-group"><label class="field-label">WhatsApp *</label><input class="field-input" type="tel" id="inp_phone" placeholder="(12) 99999-0000" value="'+(customerData.phone||'')+'"></div>'
      +'<div class="field-group"><label class="field-label">E-mail</label><input class="field-input" type="email" id="inp_email" placeholder="opcional" value="'+(customerData.email||'')+'"></div></div>';
  }else if(s===2){
    var pickupOk=SETTINGS.pickup_enabled!==false,deliveryOk=SETTINGS.delivery_enabled===true,fee2=parseFloat(SETTINGS.delivery_fee)||0;
    var addrHtml=selectedDelivery==='delivery'
      ?'<div class="field-group"><label class="field-label">Endereço *</label><input class="field-input" type="text" id="inp_addr" placeholder="Rua, número, complemento"></div>'
       +'<div class="field-group"><label class="field-label">Bairro</label><input class="field-input" type="text" id="inp_bairro" placeholder="Bairro"></div>'
      :'';
    body.innerHTML='<p style="font-size:12px;color:var(--text-3);margin-bottom:16px;">Como deseja receber?</p>'
      +'<div class="delivery-opts">'
      +(pickupOk?'<div class="delivery-opt'+(selectedDelivery==="pickup"?" active":"")+'" id="opt_pickup"><div class="delivery-opt-radio"></div><div class="delivery-opt-icon">🏪</div><div class="delivery-opt-info"><div class="delivery-opt-name">Retirada no local</div><div class="delivery-opt-detail">'+(CONTACT.address||'Na loja')+'</div></div><div class="delivery-opt-price">Grátis</div></div>':'')
      +(deliveryOk?'<div class="delivery-opt'+(selectedDelivery==="delivery"?" active":"")+'" id="opt_delivery"><div class="delivery-opt-radio"></div><div class="delivery-opt-icon">🚚</div><div class="delivery-opt-info"><div class="delivery-opt-name">Entrega a domicílio</div><div class="delivery-opt-detail">Conforme disponibilidade</div></div><div class="delivery-opt-price">'+(fee2?fmt(fee2):'Grátis')+'</div></div>':'')
      +'</div>'+addrHtml
      +'<div class="order-summary"><div class="summary-row"><span>Subtotal</span><span>'+fmt(sub)+'</span></div>'
      +'<div class="summary-row"><span>Entrega</span><span>'+(fee?fmt(fee):'Grátis')+'</span></div>'
      +'<div class="summary-row total"><span>Total</span><span>'+fmt(sub+fee)+'</span></div></div>';
    var op=document.getElementById('opt_pickup'),od=document.getElementById('opt_delivery');
    if(op) op.addEventListener('click',function(){selectDelivery('pickup');});
    if(od) od.addEventListener('click',function(){selectDelivery('delivery');});
  }else if(s===3){
    var hasPix=!!SETTINGS.has_pix, hasOd=!!SETTINGS.pay_on_delivery_enabled;
    // Substate: escolha de metodo (loja oferece os 2 e cliente nao escolheu ainda)
    if(!customerData.payment_method && hasPix && hasOd){
      body.innerHTML='<p style="font-size:13px;color:var(--text-2);margin-bottom:16px;">Como você quer pagar?</p>'
        +'<div class="delivery-opts">'
        +'<div class="delivery-opt" id="opt_pix_method" style="cursor:pointer;"><div style="background:#32BCAD;border-radius:6px;padding:6px 10px;color:#fff;font-size:11px;font-weight:800;flex-shrink:0;">PIX</div><div class="delivery-opt-info"><div class="delivery-opt-name">Pagar com Pix agora</div><div class="delivery-opt-detail">Você paga, anexa o comprovante, a loja confirma.</div></div><span style="color:var(--primary);font-size:18px;">→</span></div>'
        +'<div class="delivery-opt" id="opt_od_method" style="cursor:pointer;"><div style="font-size:24px;flex-shrink:0;">💵</div><div class="delivery-opt-info"><div class="delivery-opt-name">Pagar na entrega</div><div class="delivery-opt-detail">Combine com a loja: dinheiro, cartão, etc.</div></div><span style="color:var(--primary);font-size:18px;">→</span></div>'
        +'</div>';
      var ep=document.getElementById('opt_pix_method'),eod=document.getElementById('opt_od_method');
      if(ep) ep.addEventListener('click',function(){chooseMethod('pix');});
      if(eod) eod.addEventListener('click',function(){chooseMethod('on_delivery');});
      btn.style.display='none';
      return;
    }
    btn.style.display='';

    // Substate: on_delivery confirmado
    if(customerData.payment_method==='on_delivery' && currentOrder){
      body.innerHTML='<div class="confirm-screen">'
        +'<div class="confirm-icon">✅</div>'
        +'<div class="confirm-title">Pedido confirmado!</div>'
        +'<div class="confirm-desc">Pedido <strong>#'+esc(currentOrder.order_number)+'</strong>. Você pagará '+fmt(currentOrder.total)+' na entrega.</div>'
        +(selectedDelivery==='delivery'
          ?'<p style="font-size:12px;color:var(--text-3);max-width:300px;margin:8px auto;">Aguarde nosso contato pra combinar a entrega.</p>'
          :'<p style="font-size:12px;color:var(--text-3);max-width:300px;margin:8px auto;">Vá retirar na loja: '+esc(CONTACT.address||'')+'</p>')
        +'</div>';
      btn.textContent='Concluir';
      btn.className='next-btn green';
      return;
    }

    // Substate: Pix
    if(customerData.payment_method==='pix' && currentOrder){
      var pix=currentOrder.pix||{};
      var payload=pix.payload||'';
      // Já marcou como pago — aguardando aprovação
      if(paymentMarked){
        body.innerHTML='<div class="confirm-screen">'
          +'<div class="confirm-icon" style="background:#fef3c7;">⏳</div>'
          +'<div class="confirm-title">Aguardando confirmação</div>'
          +'<div class="confirm-desc">Pedido <strong>#'+esc(currentOrder.order_number)+'</strong>. A loja vai confirmar seu pagamento em breve.</div>'
          +(currentOrder.payment_proof_url
            ?'<p style="font-size:12px;color:var(--green);margin-top:12px;">✓ Comprovante enviado</p>'
            :'<p style="font-size:12px;color:var(--text-3);margin-top:12px;">Sem comprovante anexado</p>')
          +'</div>';
        btn.textContent='Fechar';
        btn.className='next-btn green';
        startPolling();
        return;
      }
      // Mostrar QR + comprovante + botao Ja paguei
      var qrUrl=payload?('https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data='+encodeURIComponent(payload)):null;
      body.innerHTML='<div class="pix-box">'
        +'<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:14px;"><span style="background:#32BCAD;border-radius:8px;padding:4px 12px;color:#fff;font-size:12px;font-weight:800;letter-spacing:.5px;">PIX</span><span style="font-size:12px;color:var(--text-3);">Pedido #'+esc(currentOrder.order_number)+'</span></div>'
        +'<div class="pix-qr">'+(qrUrl?'<img src="'+qrUrl+'" alt="QR Pix" style="width:200px;height:200px;border-radius:8px;background:#fff;padding:8px;">':'<div style="font-size:12px;color:var(--text-3);padding:20px;">QR indisponível — use o código abaixo</div>')+'</div>'
        +'<div style="font-size:26px;font-weight:800;color:var(--text);margin:14px 0 4px;">'+fmt(currentOrder.total)+'</div>'
        +'<div style="font-size:11px;color:var(--text-3);margin-bottom:14px;">Copie o código e pague no app do banco</div>'
        +'<div class="pix-key-box"><span class="pix-key" id="pixPayload">'+esc(payload||'Indisponível')+'</span><span class="pix-copy" id="pixCopyBtn">Copiar código</span></div>'
        +'</div>'
        +'<div style="margin-top:14px;background:var(--bg);border:1.5px dashed var(--border);border-radius:var(--r);padding:14px;">'
        +'<label for="proofInput" style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--text-2);font-weight:600;"><span style="font-size:20px;">📎</span><span id="proofLabel">Anexar comprovante (opcional)</span></label>'
        +'<input type="file" id="proofInput" accept="image/*,application/pdf" style="display:none;">'
        +'<p style="margin-top:8px;font-size:11px;color:var(--text-3);line-height:1.5;">Anexar agiliza a confirmação do lojista.</p>'
        +'</div>';
      var pcb=document.getElementById('pixCopyBtn');
      if(pcb) pcb.addEventListener('click',copyPix);
      var pin=document.getElementById('proofInput');
      if(pin) pin.addEventListener('change',uploadProof);
      btn.textContent='Já paguei ✓';
      btn.className='next-btn green';
    }
  }
}

function selectDelivery(type){
  selectedDelivery=type;
  var op=document.getElementById('opt_pickup'),od=document.getElementById('opt_delivery');
  if(op) op.classList.toggle('active',type==='pickup');
  if(od) od.classList.toggle('active',type==='delivery');
  var fee=getFee(),sub=getSubtotal();
  updateCartUI();
  document.querySelectorAll('.summary-row').forEach(function(r){
    var spans=r.querySelectorAll('span');
    if(spans[0]&&spans[0].textContent==='Entrega') spans[1].textContent=fee?fmt(fee):'Grátis';
    if(r.classList.contains('total')&&spans[0]&&spans[0].textContent==='Total') spans[1].textContent=fmt(sub+fee);
  });
  var hasAddr=!!document.getElementById('inp_addr');
  if(type==='delivery'&&!hasAddr){
    var opts=document.querySelector('.delivery-opts');
    if(opts) opts.insertAdjacentHTML('afterend','<div class="field-group"><label class="field-label">Endereço *</label><input class="field-input" type="text" id="inp_addr" placeholder="Rua, número, complemento"></div><div class="field-group"><label class="field-label">Bairro</label><input class="field-input" type="text" id="inp_bairro" placeholder="Bairro"></div>');
  }else if(type==='pickup'&&hasAddr){
    ['inp_addr','inp_bairro'].forEach(function(id){var el=document.getElementById(id);if(el&&el.parentElement)el.parentElement.remove();});
  }
}

function submitOrder(){
  var btn=document.getElementById('nextBtn');
  btn.disabled=true;btn.textContent='Criando pedido...';
  var items=Object.values(cart).map(function(i){return{product_id:i.product_id,variant_id:i.variant_id||null,quantity:i.qty};});
  var body={customer_name:customerData.name,customer_phone:customerData.phone,customer_email:customerData.email||null,delivery_type:selectedDelivery,delivery_address:customerData.delivery_address||null,payment_method:customerData.payment_method||null,items:items};
  fetch('/api/v1/storefront/'+SLUG+'/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
  .then(function(res){
    if(!res.ok){showToast(res.data.error||'Erro ao criar pedido');btn.disabled=false;btn.textContent='Ir para pagamento';return;}
    currentOrder=res.data; paymentMarked=false; checkoutStep=3; renderCheckoutStep();
  })
  .catch(function(){showToast('Erro de conexão. Tente novamente.');btn.disabled=false;btn.textContent='Ir para pagamento';});
}

function copyPix(){
  var el=document.getElementById('pixPayload');if(!el)return;
  if(navigator.clipboard)navigator.clipboard.writeText(el.textContent).catch(function(){});
  var btn=document.getElementById('pixCopyBtn');
  if(btn){btn.textContent='✓ Copiado!';btn.style.color='var(--green)';setTimeout(function(){btn.textContent='Copiar código';btn.style.color='';},2000);}
  showToast('Código Pix copiado!');
}

function startTimer(expiresAt){
  clearInterval(timerInterval);
  var secs=expiresAt?Math.max(0,Math.round((new Date(expiresAt)-Date.now())/1000)):15*60;
  timerInterval=setInterval(function(){
    var m=Math.floor(secs/60),s=secs%60;
    var el=document.getElementById('timer');if(el)el.textContent=m+':'+String(s).padStart(2,'0');
    if(--secs<0)clearInterval(timerInterval);
  },1000);
}

function startPolling(){
  clearInterval(pollInterval);if(!currentOrder)return;
  pollInterval=setInterval(function(){
    fetch('/api/v1/storefront/'+SLUG+'/order/'+currentOrder.order_id)
    .then(function(r){return r.json();})
    .then(function(o){
      if(o.payment_status==='confirmed' || ['confirmed','preparing','ready','delivered'].indexOf(o.status)>=0){
        clearInterval(pollInterval);clearInterval(timerInterval);showConfirmation(o);
      } else if(o.status==='awaiting_approval' && !paymentMarked){
        paymentMarked=true;
        if(o.payment_proof_url) currentOrder.payment_proof_url=o.payment_proof_url;
        renderCheckoutStep();
      }
    }).catch(function(){});
  },4000);
}

function showConfirmation(order){
  clearInterval(pollInterval);clearInterval(timerInterval);
  closeCheckout();cart={};updateCartUI();renderProducts();
  var wnum=(CONTACT.whatsapp||'').replace(/\\D/g,'');
  var wBtn=wnum?'<a class="whats-btn" href="https://wa.me/'+wnum+'" target="_blank">💬 Acompanhar no WhatsApp</a>':'';
  var ov=document.createElement('div');
  ov.className='checkout-overlay open';
  ov.innerHTML='<div class="checkout-sheet"><div class="checkout-head"><div class="checkout-head-info" style="margin-left:46px;"><div class="checkout-title">Pedido confirmado!</div></div><div class="cart-close" onclick="this.closest(\\'checkout-overlay\\').remove();document.body.style.overflow=\\'\\';" > ×</div></div><div class="checkout-body"><div class="confirm-screen"><div class="confirm-icon">✅</div><div class="confirm-title">Pagamento recebido!</div><div class="confirm-desc">Pedido <strong>#'+esc(order.order_number||'')+'</strong> confirmado. Em breve você recebe atualizações.</div>'+wBtn+'</div></div></div>';
  document.body.appendChild(ov);
  document.body.style.overflow='hidden';
}

function chooseMethod(method){
  customerData.payment_method=method;
  submitOrder();
}

function markAsPaid(){
  if(!currentOrder) return;
  var btn=document.getElementById('nextBtn');
  btn.disabled=true; btn.textContent='Enviando...';
  fetch('/api/v1/storefront/'+SLUG+'/order/'+currentOrder.order_id+'/mark-as-paid',{
    method:'POST', headers:{'Content-Type':'application/json'}
  })
  .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
  .then(function(res){
    if(!res.ok){
      showToast(res.data.error||'Erro ao marcar como pago');
      btn.disabled=false; btn.textContent='Já paguei ✓';
      return;
    }
    paymentMarked=true;
    renderCheckoutStep();
  })
  .catch(function(){
    showToast('Erro de conexão. Tente novamente.');
    btn.disabled=false; btn.textContent='Já paguei ✓';
  });
}

function uploadProof(){
  var input=document.getElementById('proofInput');
  if(!input || !input.files || !input.files[0]) return;
  var file=input.files[0];
  if(file.size > 5*1024*1024){ showToast('Arquivo muito grande (max 5MB)'); return; }
  var label=document.getElementById('proofLabel');
  label.textContent='Enviando...';
  var reader=new FileReader();
  reader.onload=function(e){
    var dataUrl=e.target.result;
    var base64=(dataUrl||'').split(',')[1];
    if(!base64){ label.textContent='📎 Erro — tentar novamente'; return; }
    fetch('/api/v1/storefront/'+SLUG+'/order/'+currentOrder.order_id+'/upload-proof',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({content:base64, content_type:file.type})
    })
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
    .then(function(res){
      if(!res.ok){
        label.textContent='📎 Erro — tentar novamente';
        showToast(res.data.error||'Erro ao enviar');
      } else {
        label.textContent='✓ Comprovante enviado';
        currentOrder.payment_proof_url=res.data.payment_proof_url;
      }
    })
    .catch(function(){
      label.textContent='📎 Erro — tentar novamente';
      showToast('Erro de conexão');
    });
  };
  reader.readAsDataURL(file);
}

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

var toastT;
function showToast(msg){clearTimeout(toastT);var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');toastT=setTimeout(function(){t.classList.remove('show');},2400);}

updateCartUI();
renderProducts();<\/script>`;
}
module.exports = buildScript;
