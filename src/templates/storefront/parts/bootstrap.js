// AURA. -- storefront/parts/bootstrap.js
// Linhas finais: chama updateCartUI() + renderProducts() pra primeira renderizacao, fecha </script>.
// Fase 2 (21/05/2026): detecta retorno do CheckoutPro (cartão MP) via query params.
'use strict';

module.exports = `
updateCartUI();
renderProducts();

// Fase 2: detecta retorno do CheckoutPro (cartão MP) — parâmetros injetados nas back_urls
(function(){
  var params=new URLSearchParams(window.location.search);
  var payStatus=params.get('payment'),orderId=params.get('order_id');
  if(!payStatus||!orderId) return;
  var msgs={
    approved:'✅ Pagamento confirmado! Seu pedido foi recebido.',
    pending:'⏳ Pagamento em análise. Em breve você receberá a confirmação.',
    failed:'❌ Pagamento não aprovado. Tente novamente.'
  };
  setTimeout(function(){ showToast(msgs[payStatus]||'Pagamento processado.'); },300);
  if(window.history&&window.history.replaceState) window.history.replaceState({},document.title,window.location.pathname);
})();
<\/script>`;
