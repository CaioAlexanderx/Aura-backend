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

`;
