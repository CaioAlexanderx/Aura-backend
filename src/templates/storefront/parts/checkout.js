// AURA. -- storefront/parts/checkout.js
// Checkout 3 steps: open/close/back/next, renderCheckoutStep, selectDelivery, submitOrder.
'use strict';

module.exports = `
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
`;
