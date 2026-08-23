// AURA. -- storefront/parts/products.js
// renderProducts() — grid de produtos com filtro por categoria/busca.
//
// 23/05/2026: layout do card preservado (mesmo aspect/posicionamento)
// mas a foto exibida cai pra primeira variante com image_url quando
// o produto pai nao tem image_url. Isso evita placeholders 'A' em
// catalogos onde o lojista so subiu foto por cor/tamanho.
'use strict';

module.exports = `
// Render incremental: a Finesse desenhava 410 cartoes de uma vez, cada um
// com foto. O lote entra conforme o cliente desce.
var LOTE=60, mostrando=LOTE;

// Ordem escolhida pela cliente. 'destaque' e a ordem que o servidor mandou
// — featured primeiro, depois mais recente — entao nao reordena nada.
var ordem='destaque';

function setOrdem(v){ ordem=v; mostrando=LOTE; renderProducts(); }

// Busca sem acento e com termos em qualquer ordem, igual a vitrine Studio.
// Antes era indexOf cru: "vestido" nao achava "Vestído" e "longo vestido"
// nao achava nada.
// Sem regex de proposito: este arquivo e um template literal, onde toda
// barra invertida precisa ser dobrada na fonte (CLAUDE.md, armadilha 8).
// Um \\s que vira s parte a busca em silencio — split(/s+/) quebra em cada
// letra "s". Comparar codepoint nao tem essa armadilha.
function normalizarBusca(s){
  var d=String(s==null?'':s).normalize('NFD'), out='';
  for(var i=0;i<d.length;i++){
    var k=d.charCodeAt(i);
    // 0x300-0x36F: bloco dos diacriticos combinantes que o NFD separou.
    if(k<0x300||k>0x36f) out+=d[i];
  }
  return out.toLowerCase();
}
function casaBusca(termo,texto){
  var t=normalizarBusca(termo).trim(); if(!t) return true;
  var alvo=normalizarBusca(texto);
  var partes=t.split(' ').filter(Boolean);
  for(var i=0;i<partes.length;i++){ if(alvo.indexOf(partes[i])<0) return false; }
  return true;
}

function ordenarProdutos(lista){
  var l=lista.slice();
  if(ordem==='preco_asc')  return l.sort(function(a,b){return (a.price||0)-(b.price||0);});
  if(ordem==='preco_desc') return l.sort(function(a,b){return (b.price||0)-(a.price||0);});
  if(ordem==='nome')       return l.sort(function(a,b){return String(a.name||'').localeCompare(String(b.name||''),'pt-BR');});
  if(ordem==='novidades')  return l.sort(function(a,b){return String(b.created_at||'').localeCompare(String(a.created_at||''));});
  return l;
}

function renderProducts(){
  var grid=document.getElementById('productsGrid'); if(!grid) return;
  var filtered=PRODUCTS.filter(function(p){
    var mc=currentCat==='Todos'||p.category===currentCat;
    var ms=casaBusca(searchTerm,(p.name||'')+' '+(p.description||''));
    return mc&&ms&&p.in_stock;
  });
  filtered=ordenarProdutos(filtered);

  // A contagem diz o que a loja TEM, nao o que coube no payload. A Finesse
  // afirmava "500 produtos" com 1302 no catalogo — 802 sumiam sem aviso.
  var faltam=Math.max(0,CATALOGO_TOTAL-CARREGADOS);
  var semFiltro=(currentCat==='Todos'&&!String(searchTerm||'').trim());
  var txt=filtered.length+' produto'+(filtered.length!==1?'s':'');
  if(semFiltro&&faltam>0) txt+=' de '+CATALOGO_TOTAL;
  document.getElementById('prodCount').textContent=txt;

  // Ordenacao so aparece quando ha produto suficiente pra ela servir.
  var sw=document.getElementById('sortWrap');
  if(sw) sw.hidden=(filtered.length<20);

  if(!filtered.length){
    grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:60px 0;color:var(--text-3);"><div style="font-size:40px;margin-bottom:12px;">🔍</div><div style="font-size:15px;font-weight:700;">Nenhum produto encontrado</div></div>';
    atualizarRodapeDaGrade(0,0,faltam);
    return;
  }
  var visiveis=filtered.slice(0,mostrando);
  atualizarRodapeDaGrade(visiveis.length,filtered.length,faltam);
  grid.innerHTML=visiveis.map(function(p){
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
    // "3x de R$ 53,30" e uma frase diferente de "R$ 159,90" pra quem
    // esta decidindo. So sai quando a lojista declarou o teto.
    var parcH=PARCELAS_TXT(p.price);
    var priceH=(SETTINGS.show_prices!==false&&p.price!=null)
      ?'<div class="product-price">'+fmt(p.price)+'</div>'+(parcH?'<div class="product-parcela">'+esc(parcH)+'</div>':'')
      :'';
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

/**
 * Rodape da grade: quantos ja apareceram e quantos a loja ainda tem.
 *
 * "Sem tetos silenciosos": se a loja tem 1302 produtos e a pagina carrega
 * 500, quem esta comprando precisa saber que existe mais — e a lojista
 * precisa saber que o catalogo dela nao cabe todo aqui.
 */
function atualizarRodapeDaGrade(visiveis,filtrados,faltam){
  var el=document.getElementById('gridMore'); if(!el) return;
  var partes=[];
  if(filtrados>visiveis) partes.push('Mostrando '+visiveis+' de '+filtrados);
  if(faltam>0&&visiveis>=filtrados) partes.push('Mais '+faltam+' produtos no catalogo — use a busca');
  el.hidden=partes.length===0;

  // BOTAO, nao so rolagem. Rolagem infinita sozinha deixa quem navega por
  // teclado sem acesso ao resto do catalogo: o foco nunca chega ao fim da
  // lista pra disparar a sentinela, e o rodape fica inalcancavel.
  var botao=filtrados>visiveis
    ? '<button type="button" class="grid-more-btn" onclick="verMais()">Ver mais produtos</button>'
    : '';
  el.innerHTML='<span>'+partes.join(' · ')+'</span>'+botao;
}

/** Proximo lote sob demanda — usado pelo botao e pela sentinela. */
function verMais(){
  var grid=document.getElementById('productsGrid');
  if(!grid||!grid.children.length) return;
  if(grid.children.length<mostrando) return; // ja mostrou tudo que ha
  mostrando+=LOTE;
  renderProducts();
}

/**
 * Proximo lote quando a sentinela entra na tela.
 *
 * IntersectionObserver com fallback pro scroll: navegador antigo continua
 * vendo a loja, so com o lote entrando um pouco mais tarde.
 */
function ligarRenderIncremental(){
  var alvo=document.getElementById('gridSentinel'); if(!alvo) return;
  // Mesma funcao do botao: um caminho so pra crescer a grade.
  var crescer=verMais;
  if(typeof IntersectionObserver==='function'){
    new IntersectionObserver(function(ents){
      for(var i=0;i<ents.length;i++){ if(ents[i].isIntersecting) crescer(); }
    },{rootMargin:'600px'}).observe(alvo);
    return;
  }
  window.addEventListener('scroll',function(){
    var r=alvo.getBoundingClientRect();
    if(r.top<window.innerHeight+600) crescer();
  },{passive:true});
}
`;
