// AURA. -- storefront/parts/init.js
// IIFEs de inicializacao: tema/cores CSS, hero pills, lista de categorias.
'use strict';

module.exports = `
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

// tq-59 (26/10/2026): logo que e EMBLEMA (ate 1,5 de largura por 1 de
// altura) nao traz o nome escrito, e o topo escondia o nome sempre que
// havia logo. Medida a imagem, o emblema marca .topbar-brand com
// .com-emblema e o CSS mostra o nome da loja ao lado, como na loja sem
// logo. Logo largo (com o nome escrito) fica como sempre foi.
(function(){
  var img=document.querySelector('.topbar-logo img'); if(!img) return;
  function medir(){
    if(img.naturalHeight&&img.naturalWidth<=img.naturalHeight*1.5){
      var b=img.closest('.topbar-brand'); if(b) b.classList.add('com-emblema');
    }
  }
  if(img.complete) medir(); else img.addEventListener('load',medir);
})();

(function(){
  var pills=[];
  if(CONTACT.address) pills.push('📍 '+CONTACT.address.split(',')[0]);
  if(SETTINGS.delivery_enabled) pills.push('🚚 Entrega disponível');
  if(SETTINGS.pickup_enabled!==false) pills.push('🏪 Retirada no local');
  var w=document.getElementById('heroPills');
  if(w) w.innerHTML=pills.map(function(p){return '<span class="hero-pill">'+p+'</span>';}).join('');
})();

// A barra de categorias mudou de lugar: parts/categorias.js. Ela era
// derivada de PRODUCTS, o que quebrou quando a grade passou a carregar
// 24 produtos por vez em vez de 500.

`;
