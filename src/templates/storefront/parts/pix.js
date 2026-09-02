// AURA. -- storefront/parts/pix.js
// Pix: copyPix, startTimer, startPolling, showConfirmation, chooseMethod, markAsPaid, uploadProof.
'use strict';

module.exports = `
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
    fetch(API_BASE + '/api/v1/storefront/'+SLUG+'/order/'+currentOrder.order_id)
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
  if(typeof renderResumoDoCheckout==='function') renderResumoDoCheckout();
  submitOrder();
}

function markAsPaid(){
  if(!currentOrder) return;
  var btn=document.getElementById('nextBtn');
  btn.disabled=true; btn.textContent='Enviando...';
  fetch(API_BASE + '/api/v1/storefront/'+SLUG+'/order/'+currentOrder.order_id+'/mark-as-paid',{
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
    fetch(API_BASE + '/api/v1/storefront/'+SLUG+'/order/'+currentOrder.order_id+'/upload-proof',{
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
`;
