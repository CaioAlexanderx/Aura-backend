// AURA. -- storefront/parts/bootstrap.js
// Linhas finais: chama updateCartUI() + renderProducts() pra primeira renderizacao, fecha </script>.
// Fase 2 (21/05/2026): detecta retorno do CheckoutPro (cartão MP) via query params.
// Migration 121 (21/05/2026): poll do status real do pedido por até 30s antes
// de mostrar o toast. Resolve race condition webhook vs back_url — sem polling,
// cliente vê "Pagamento aprovado!" mas o pedido ainda fica pending_payment.
'use strict';

module.exports = `
updateCartUI();
renderCategorias();
renderProducts();

// Fase 2 + Migration 121: detecta retorno do CheckoutPro (cartão MP) via back_url
// e faz polling do status real do pedido antes de mostrar o toast.
(function(){
  var params=new URLSearchParams(window.location.search);
  var payStatus=params.get('payment'),orderId=params.get('order_id');
  if(!payStatus||!orderId) return;

  // Limpa a URL imediatamente pra não duplicar toast em F5
  if(window.history&&window.history.replaceState) window.history.replaceState({},document.title,window.location.pathname);

  // Limpa pedido em andamento do localStorage (cartão concluído ou cancelado)
  try { window.localStorage&&window.localStorage.removeItem('aura_pending_order_'+SLUG); } catch(_) {}

  // approved: faz polling. failed/pending: toast imediato.
  if(payStatus!=='approved'){
    var msgs={
      pending:'⏳ Pagamento em análise. Em breve você receberá a confirmação.',
      failed:'❌ Pagamento não aprovado. Tente novamente.'
    };
    setTimeout(function(){ showToast(msgs[payStatus]||'Pagamento processado.'); },300);
    return;
  }

  // Polling: tenta até 15 vezes com intervalo 2s (~30s total)
  var attempts=0;
  var maxAttempts=15;
  var poll=function(){
    attempts++;
    fetch(API_BASE + '/api/v1/storefront/'+SLUG+'/order/'+orderId)
      .then(function(r){return r.json();})
      .then(function(o){
        var st=o&&o.status;
        if(st==='confirmed'||o.payment_status==='paid'){
          showToast('✅ Pagamento confirmado! Seu pedido foi recebido.');
          return;
        }
        if(st==='cancelled'){
          showToast('❌ Pedido cancelado.');
          return;
        }
        if(attempts>=maxAttempts){
          // Timeout: webhook ainda não chegou. Otimista pela back_url.
          showToast('⏳ Estamos confirmando seu pagamento. Você receberá um WhatsApp em alguns minutos.');
          return;
        }
        setTimeout(poll, 2000);
      })
      .catch(function(){
        if(attempts>=maxAttempts){
          showToast('⏳ Estamos confirmando seu pagamento. Você receberá um WhatsApp em alguns minutos.');
          return;
        }
        setTimeout(poll, 2000);
      });
  };
  setTimeout(poll, 800); // delay inicial pra dar tempo do webhook bater
})();
<\/script>`;
