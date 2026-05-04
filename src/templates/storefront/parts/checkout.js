// AURA. -- storefront/parts/checkout.js
// Checkout 3 steps: open/close/back/next, renderCheckoutStep, selectDelivery, submitOrder.
// Coleta: nome, fone, email, [opcional CPF/CNPJ pra NFCe], endereco estruturado (delivery).
'use strict';

module.exports = `
function openCheckout(){closeCart();checkoutStep=1;selectedDelivery=SETTINGS.pickup_enabled!==false?'pickup':'delivery';renderCheckoutStep();document.getElementById('checkoutOverlay').classList.add('open');document.body.style.overflow='hidden';}
function closeCheckout(){clearInterval(pollInterval);clearInterval(timerInterval);document.getElementById('checkoutOverlay').classList.remove('open');document.body.style.overflow='';}
function checkoutBack(){if(checkoutStep>1&&checkoutStep<3){checkoutStep--;renderCheckoutStep();}else closeCheckout();}

// Validador CPF/CNPJ mod 11 (mesmo algoritmo do backend)
function validateCpfCnpjFront(raw){
  var d=String(raw||'').replace(/\\D/g,'');
  if(d.length===11){
    if(/^(\\d)\\1{10}$/.test(d)) return false;
    var s=0;for(var i=0;i<9;i++) s+=parseInt(d[i])*(10-i);
    var r=(s*10)%11;if(r===10)r=0;if(r!==parseInt(d[9])) return false;
    s=0;for(var i=0;i<10;i++) s+=parseInt(d[i])*(11-i);
    r=(s*10)%11;if(r===10)r=0;return r===parseInt(d[10]);
  }
  if(d.length===14){
    if(/^(\\d)\\1{13}$/.test(d)) return false;
    var w1=[5,4,3,2,9,8,7,6,5,4,3,2],w2=[6,5,4,3,2,9,8,7,6,5,4,3,2];
    var s=0;for(var i=0;i<12;i++) s+=parseInt(d[i])*w1[i];
    var r=s%11;r=r<2?0:11-r;if(r!==parseInt(d[12])) return false;
    s=0;for(var i=0;i<13;i++) s+=parseInt(d[i])*w2[i];
    r=s%11;r=r<2?0:11-r;return r===parseInt(d[13]);
  }
  return false;
}

// ViaCEP autocomplete: chamado quando CEP completa 8 digitos
function fetchCep(){
  var inp=document.getElementById('inp_cep');if(!inp) return;
  var cep=String(inp.value||'').replace(/\\D/g,'');
  if(cep.length!==8) return;
  var label=document.getElementById('cepStatus');
  if(label) label.textContent='Buscando...';
  fetch('https://viacep.com.br/ws/'+cep+'/json/')
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.erro){
        if(label) label.textContent='CEP nao encontrado';
        return;
      }
      var fill=function(id,v){var el=document.getElementById(id);if(el && !el.value) el.value=v||'';};
      fill('inp_street',d.logradouro);
      fill('inp_neighborhood',d.bairro);
      var city=document.getElementById('inp_city');if(city) city.value=d.localidade||'';
      var uf=document.getElementById('inp_state');if(uf) uf.value=(d.uf||'').toUpperCase();
      if(label) label.textContent='✓ Endereco preenchido';
      var num=document.getElementById('inp_number');if(num) num.focus();
    })
    .catch(function(){if(label) label.textContent='Erro ao buscar CEP';});
}

function checkoutNext(){
  if(checkoutStep===1){
    var name=document.getElementById('inp_name')?document.getElementById('inp_name').value.trim():'';
    var phone=document.getElementById('inp_phone')?document.getElementById('inp_phone').value.trim():'';
    var email=document.getElementById('inp_email')?document.getElementById('inp_email').value.trim():'';
    if(!name||!phone){showToast('Preencha nome e telefone');return;}
    var nfceCheck=document.getElementById('inp_nfce_check');
    var requestNfce=nfceCheck && nfceCheck.checked;
    var cpfCnpj=document.getElementById('inp_cpf')?document.getElementById('inp_cpf').value.trim():'';
    if(requestNfce){
      if(!cpfCnpj){showToast('Informe seu CPF/CNPJ pra NFCe');return;}
      if(!validateCpfCnpjFront(cpfCnpj)){showToast('CPF/CNPJ invalido');return;}
    }
    customerData={name:name,phone:phone,email:email||null,request_nfce:!!requestNfce,customer_cpf_cnpj:cpfCnpj?cpfCnpj.replace(/\\D/g,''):null};
    checkoutStep=2;renderCheckoutStep();
  }else if(checkoutStep===2){
    if(selectedDelivery==='delivery'){
      var cep=document.getElementById('inp_cep')?document.getElementById('inp_cep').value.trim():'';
      var street=document.getElementById('inp_street')?document.getElementById('inp_street').value.trim():'';
      var num=document.getElementById('inp_number')?document.getElementById('inp_number').value.trim():'';
      var compl=document.getElementById('inp_complement')?document.getElementById('inp_complement').value.trim():'';
      var bairro=document.getElementById('inp_neighborhood')?document.getElementById('inp_neighborhood').value.trim():'';
      var city=document.getElementById('inp_city')?document.getElementById('inp_city').value.trim():'';
      var uf=document.getElementById('inp_state')?document.getElementById('inp_state').value.trim():'';
      if(!cep||!street||!num||!bairro||!city||!uf){
        showToast('Preencha endereco completo (CEP, rua, numero, bairro, cidade, UF)');return;
      }
      if(String(cep).replace(/\\D/g,'').length!==8){showToast('CEP invalido');return;}
      if(uf.length!==2){showToast('UF invalida (2 letras)');return;}
      customerData.address_zip=cep.replace(/\\D/g,'');
      customerData.address_street=street;
      customerData.address_number=num;
      customerData.address_complement=compl||null;
      customerData.address_neighborhood=bairro;
      customerData.address_city=city;
      customerData.address_state=uf.toUpperCase();
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

function toggleNfceCheckbox(){
  var ch=document.getElementById('inp_nfce_check');
  var box=document.getElementById('cpfBox');
  if(box) box.style.display=(ch && ch.checked)?'block':'none';
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
    var nfceChecked=customerData.request_nfce?'checked':'';
    var cpfDisplay=nfceChecked?'block':'none';
    body.innerHTML='<div class="order-summary">'
      +Object.values(cart).map(function(i){return '<div class="summary-row"><span>'+esc(i.name)+' ×'+i.qty+'</span><span>'+fmt(i.price*i.qty)+'</span></div>';}).join('')
      +'<div class="summary-row total"><span>Total estimado</span><span>'+fmt(sub)+'</span></div></div>'
      +'<div class="field-group"><label class="field-label">Nome completo *</label><input class="field-input" type="text" id="inp_name" placeholder="Maria da Silva" value="'+(customerData.name||'')+'"></div>'
      +'<div class="field-row"><div class="field-group"><label class="field-label">WhatsApp *</label><input class="field-input" type="tel" id="inp_phone" placeholder="(12) 99999-0000" value="'+(customerData.phone||'')+'"></div>'
      +'<div class="field-group"><label class="field-label">E-mail</label><input class="field-input" type="email" id="inp_email" placeholder="opcional" value="'+(customerData.email||'')+'"></div></div>'
      +'<div style="margin-top:14px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;">'
      +'<label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;font-weight:600;color:var(--text-2);">'
      +'<input type="checkbox" id="inp_nfce_check" '+nfceChecked+' style="width:18px;height:18px;accent-color:var(--primary);cursor:pointer;">'
      +'<span>📄 Quero CPF/CNPJ na nota fiscal</span>'
      +'</label>'
      +'<div id="cpfBox" style="display:'+cpfDisplay+';margin-top:10px;">'
      +'<input class="field-input" type="text" id="inp_cpf" inputmode="numeric" placeholder="CPF (000.000.000-00) ou CNPJ (00.000.000/0000-00)" value="'+(customerData.customer_cpf_cnpj||'')+'">'
      +'<p style="margin-top:6px;font-size:11px;color:var(--text-3);line-height:1.4;">Sera emitida NFC-e nominal apos confirmacao do pedido.</p>'
      +'</div>'
      +'</div>';
    var ch=document.getElementById('inp_nfce_check');
    if(ch) ch.addEventListener('change',toggleNfceCheckbox);
  }else if(s===2){
    var pickupOk=SETTINGS.pickup_enabled!==false,deliveryOk=SETTINGS.delivery_enabled===true,fee2=parseFloat(SETTINGS.delivery_fee)||0;
    var addrHtml=selectedDelivery==='delivery'?renderAddressForm():'';
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
    bindAddressFormEvents();
  }else if(s===3){
    var hasPix=!!SETTINGS.has_pix, hasOd=!!SETTINGS.pay_on_delivery_enabled;
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

    if(customerData.payment_method==='pix' && currentOrder){
      var pix=currentOrder.pix||{};
      var payload=pix.payload||'';
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

// Renderiza form estruturado de endereco (CEP+ViaCEP, rua, num, bairro, cidade, UF)
function renderAddressForm(){
  var d=customerData;
  return '<div class="address-form" style="background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:12px;margin-top:12px;">'
    +'<div class="field-row">'
    +'<div class="field-group" style="flex:0 0 130px;"><label class="field-label">CEP *</label>'
    +'<input class="field-input" type="text" id="inp_cep" inputmode="numeric" maxlength="9" placeholder="00000-000" value="'+(d.address_zip||'')+'">'
    +'<small id="cepStatus" style="font-size:10px;color:var(--text-3);"></small></div>'
    +'<div class="field-group" style="flex:1;"><label class="field-label">Rua *</label>'
    +'<input class="field-input" type="text" id="inp_street" placeholder="Rua/Avenida" value="'+(d.address_street||'')+'"></div>'
    +'</div>'
    +'<div class="field-row">'
    +'<div class="field-group" style="flex:0 0 100px;"><label class="field-label">Nº *</label>'
    +'<input class="field-input" type="text" id="inp_number" placeholder="123" value="'+(d.address_number||'')+'"></div>'
    +'<div class="field-group" style="flex:1;"><label class="field-label">Complemento</label>'
    +'<input class="field-input" type="text" id="inp_complement" placeholder="apto, sala (opcional)" value="'+(d.address_complement||'')+'"></div>'
    +'</div>'
    +'<div class="field-group"><label class="field-label">Bairro *</label>'
    +'<input class="field-input" type="text" id="inp_neighborhood" placeholder="Bairro" value="'+(d.address_neighborhood||'')+'"></div>'
    +'<div class="field-row">'
    +'<div class="field-group" style="flex:1;"><label class="field-label">Cidade *</label>'
    +'<input class="field-input" type="text" id="inp_city" placeholder="Cidade" value="'+(d.address_city||'')+'"></div>'
    +'<div class="field-group" style="flex:0 0 80px;"><label class="field-label">UF *</label>'
    +'<input class="field-input" type="text" id="inp_state" maxlength="2" placeholder="SP" value="'+(d.address_state||'')+'" style="text-transform:uppercase;"></div>'
    +'</div>'
    +'</div>';
}

function bindAddressFormEvents(){
  var cep=document.getElementById('inp_cep');
  if(cep){
    cep.addEventListener('blur',fetchCep);
    cep.addEventListener('input',function(){
      var v=this.value.replace(/\\D/g,'').slice(0,8);
      this.value=v.length>5?v.slice(0,5)+'-'+v.slice(5):v;
      if(v.length===8) fetchCep();
    });
  }
  var st=document.getElementById('inp_state');
  if(st) st.addEventListener('input',function(){this.value=this.value.toUpperCase().replace(/[^A-Z]/g,'').slice(0,2);});
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
  var hasForm=!!document.querySelector('.address-form');
  if(type==='delivery'&&!hasForm){
    var opts=document.querySelector('.delivery-opts');
    if(opts) opts.insertAdjacentHTML('afterend',renderAddressForm());
    bindAddressFormEvents();
  }else if(type==='pickup'&&hasForm){
    var f=document.querySelector('.address-form');if(f) f.remove();
  }
}

function submitOrder(){
  var btn=document.getElementById('nextBtn');
  btn.disabled=true;btn.textContent='Criando pedido...';
  var items=Object.values(cart).map(function(i){return{product_id:i.product_id,variant_id:i.variant_id||null,quantity:i.qty};});
  var body={
    customer_name:customerData.name,
    customer_phone:customerData.phone,
    customer_email:customerData.email||null,
    delivery_type:selectedDelivery,
    payment_method:customerData.payment_method||null,
    items:items,
    request_nfce:!!customerData.request_nfce,
    customer_cpf_cnpj:customerData.customer_cpf_cnpj||null,
    address_zip:customerData.address_zip||null,
    address_street:customerData.address_street||null,
    address_number:customerData.address_number||null,
    address_complement:customerData.address_complement||null,
    address_neighborhood:customerData.address_neighborhood||null,
    address_city:customerData.address_city||null,
    address_state:customerData.address_state||null,
  };
  fetch(API_BASE + '/api/v1/storefront/'+SLUG+'/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
  .then(function(res){
    if(!res.ok){showToast(res.data.error||'Erro ao criar pedido');btn.disabled=false;btn.textContent='Ir para pagamento';return;}
    currentOrder=res.data; paymentMarked=false; checkoutStep=3; renderCheckoutStep();
  })
  .catch(function(){showToast('Erro de conexão. Tente novamente.');btn.disabled=false;btn.textContent='Ir para pagamento';});
}
`;
