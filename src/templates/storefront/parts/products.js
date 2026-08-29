module.exports = `
// ── Paginacao ────────────────────────────────────────────
//
// A loja mandava 500 produtos de uma vez e escrevia no rodape "Mais 802
// no catalogo — use a busca". Pra quem esta comprando, essa frase diz
// "nao vamos te atender, procure em outra loja".
//
// Agora: 24 por pagina, numeros embaixo da grade, catalogo inteiro
// alcancavel. A pagina 1 ja vem no HTML (primeira tela sem espera); as
// outras chegam pela rota /storefront/:slug/catalogo.
//
// Filtro, busca e ordem sao do SERVIDOR: com paginacao real, filtrar so o
// que esta carregado esconderia resultado.
var paginaAtual=1, ordem='destaque', totalFiltrado=CATALOGO_TOTAL||PRODUCTS.length;
var carregandoPagina=false, buscaTimer=null;

function totalDePaginas(){ return Math.max(1, Math.ceil(totalFiltrado/POR_PAGINA)); }

/**
 * Numeros da barra: as vizinhas, a primeira, a ultima, reticencias no meio.
 *
 * Espelho de janelaDePaginas em services/catalogoPaginado.js. Com 55
 * paginas nao da pra desenhar 55 botoes.
 */
function janelaDePaginas(atual,total){
  if(total<=1) return [1];
  var p=Math.min(Math.max(1,atual),total);
  var vistos={}; var lista=[1,total];
  lista.push(p-1,p,p+1);
  var ok=[];
  for(var i=0;i<lista.length;i++){
    var n=lista[i];
    if(n>=1&&n<=total&&!vistos[n]){ vistos[n]=1; ok.push(n); }
  }
  ok.sort(function(a,b){return a-b;});
  var saida=[], ant=0;
  for(var j=0;j<ok.length;j++){
    if(ant && ok[j]-ant>1) saida.push('...');
    saida.push(ok[j]); ant=ok[j];
  }
  return saida;
}

/** Busca uma pagina no servidor e redesenha. */
/**
 * Uma requisicao de cada vez — mas nenhuma perdida.
 *
 * Antes era um return seco quando havia carga em curso, e o clique sumia. Peguei no
 * QA: clicar num filtro enquanto a pagina 1 ainda carregava nao fazia
 * NADA, e a pessoa ficava com a ficha "Preto" na barra e a grade
 * inteira na tela. Sem erro, sem sinal — so a impressao de que o filtro
 * nao funciona.
 *
 * Agora a ultima intencao fica pendente e roda quando a atual termina.
 * A ULTIMA, nao uma fila: quem clicou em tres filtros seguidos quer o
 * resultado dos tres juntos, nao tres recargas em sequencia.
 */
var pedidoPendente=null;

function irParaPagina(n){
  var total=totalDePaginas();
  n=Math.min(Math.max(1,n),total);
  if(carregandoPagina){ pedidoPendente=n; return; }
  carregandoPagina=true;
  paginaAtual=n;
  marcarCarregando(true);

  var q=[
    'offset='+((n-1)*POR_PAGINA),
    'limit='+POR_PAGINA,
    'ordem='+encodeURIComponent(ordem)
  ];
  if(currentCat&&currentCat!=='Todos') q.push('cat='+encodeURIComponent(currentCat));
  if(String(searchTerm||'').trim()) q.push('q='+encodeURIComponent(searchTerm.trim()));
  // Tamanho e cor vao na MESMA requisicao: filtrar no cliente esconderia
  // resultado que esta nas outras paginas.
  if(typeof paramsDeFiltro==='function') q=q.concat(paramsDeFiltro());

  fetch(API_BASE+'/api/v1/storefront/'+encodeURIComponent(SLUG)+'/catalogo?'+q.join('&'))
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(!j||!Array.isArray(j.products)) throw new Error('resposta invalida');
      PRODUCTS=j.products;
      totalFiltrado=(typeof j.total==='number')?j.total:PRODUCTS.length;
      // PROD_MAP ACUMULA: o carrinho procura por id, e um item posto na
      // pagina 1 tem que continuar existindo quando a cliente esta na 5.
      PRODUCTS.forEach(function(p){ PROD_MAP[p.id]=p; });
      renderProducts();
      var alvo=document.getElementById('productsAnchor');
      if(alvo) window.scrollTo({top:alvo.offsetTop-alturaDasBarras()-8,behavior:'smooth'});
    })
    .catch(function(){
      var grid=document.getElementById('productsGrid');
      if(grid) grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:48px 0;color:var(--sf-ink-3);">Nao consegui carregar esta pagina. Tente de novo.</div>';
    })
    .then(function(){
      carregandoPagina=false; marcarCarregando(false);
      // O que o usuario pediu enquanto esta rodava. filtro, busca e ordem
      // ja estao no estado do modulo, entao a recarga pega o valor atual.
      if(pedidoPendente!=null){ var p=pedidoPendente; pedidoPendente=null; irParaPagina(p); }
    });
}

// Quando a resposta volta rapido demais, apagar e reacender a grade em
// 40ms nao le como "carregou" — le como a tela piscando. Este e o tempo
// minimo que o estado de carregando fica na tela.
var MINIMO_CARREGANDO=220;
var comecouACarregar=0;

function marcarCarregando(estado){
  var grid=document.getElementById('productsGrid');
  if(!grid) return;
  if(estado){
    comecouACarregar=Date.now();
    grid.style.opacity='0.45';
    return;
  }
  // A transicao de volta espera o que faltar pro minimo.
  var falta=Math.max(0, MINIMO_CARREGANDO-(Date.now()-comecouACarregar));
  setTimeout(function(){ grid.style.opacity='1'; }, falta);
}

/** Altura somada das barras fixas — o titulo nao pode ficar embaixo delas. */
function alturaDasBarras(){
  var h=0;
  var tb=document.querySelector('.topbar'); if(tb) h+=tb.offsetHeight;
  var cw=document.querySelector('.cats-wrap'); if(cw) h+=cw.offsetHeight;
  return h;
}

/** Qualquer mudanca de filtro volta pra pagina 1. */
function recarregarDoInicio(){ irParaPagina(1); }

function setOrdem(v){ ordem=v; recarregarDoInicio(); }

function renderProducts(){
  var grid=document.getElementById('productsGrid'); if(!grid) return;
  // O servidor ja filtrou (inclusive esgotado), ordenou e paginou: aqui
  // so desenha. Filtrar de novo aqui era o que fazia a loja dizer "29
  // produtos" e mostrar 19.
  var visiveis=PRODUCTS;

  var txt=totalFiltrado+' produto'+(totalFiltrado!==1?'s':'');
  document.getElementById('prodCount').textContent=txt;

  var sw=document.getElementById('sortWrap');
  if(sw) sw.hidden=(totalFiltrado<20);

  if(!visiveis.length){
    grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:60px 0;color:var(--sf-ink-3);"><div style="font-size:15px;font-weight:700;">Nenhum produto encontrado</div><div style="font-size:13px;margin-top:6px;">Tente outra palavra ou veja todas as categorias.</div></div>';
    renderPaginacao();
    return;
  }
  renderPaginacao();
  if(typeof renderFiltros==='function') renderFiltros();
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
    // "ou R$ 208,99 no Pix" — a conta que a cliente faria, feita antes de
    // ela decidir. Diferente do parcelamento, que responde a pergunta de
    // quem NAO tem o valor a vista. So sai quando a lojista declarou o
    // desconto (migration 309); 0 nao mostra nada.
    var pixH='';
    var pixPct=Number(__S.pix_discount_pct)||0;
    if(pixPct>0 && p.price!=null){
      pixH='<div class="product-pix">ou '+fmt(p.price*(1-pixPct/100))+' no Pix</div>';
    }
    var priceH=(SETTINGS.show_prices!==false&&p.price!=null)
      ?'<div class="product-price">'+fmt(p.price)+'</div>'+pixH+(parcH?'<div class="product-parcela">'+esc(parcH)+'</div>':'')
      :'';
    // SEM botao no cartao. O cartao inteiro leva pra pagina do produto,
    // que e onde a decisao acontece — la tem foto grande, cor, tamanho,
    // descricao e frete. Comprar direto da grade pulava tudo isso e, em
    // produto com variante, nem era possivel.
    //
    // O que o cartao mostra e QUANTO ja esta no carrinho, se houver.
    var noCarrinho=qty>0?'<div class="card-tag">'+qty+' no carrinho</div>':'';
    // Sem foto, cada capa ganha seu proprio degrau do gradiente da loja.
    // Com o gradiente fixo, a Finesse renderizava 373 ladrilhos iguais.
    var tileStyle=displayImg?'':' style="background:'+FUNDO_CAPA(p.name)+'"';
    return '<div class="product-card" onclick="showDetail(\\''+p.id+'\\')" ><div class="product-img"'+tileStyle+'>'+imgH+'</div><div class="product-body">'
      +(p.category?'<div class="product-cat">'+esc(p.category)+'</div>':'')
      +'<div class="product-name">'+esc(p.name)+'</div>'
      +(p.description?'<div class="product-desc">'+esc((p.description||'').substring(0,80))+((p.description||'').length>80?'...':'')+'</div>':'')
      +'<div class="product-footer">'+priceH+'</div>'+noCarrinho+'</div></div>';
  }).join('');
}

/**
 * Barra de paginas embaixo da grade.
 *
 * Substitui "Mais 802 produtos no catalogo — use a busca", que dizia pra
 * cliente "nao vamos te atender, procure em outra loja". Agora o catalogo
 * inteiro esta a um clique, no padrao que todo e-commerce usa.
 */
function renderPaginacao(){
  var el=document.getElementById('gridMore'); if(!el) return;
  var total=totalDePaginas();
  if(total<=1){ el.hidden=true; el.innerHTML=''; return; }
  el.hidden=false;

  var botoes=janelaDePaginas(paginaAtual,total).map(function(n){
    if(n==='...') return '<span class="pg-gap">&#8230;</span>';
    var atual=(n===paginaAtual);
    return '<button class="pg-num'+(atual?' pg-atual':'')+'"'
      +(atual?' aria-current="page"':'')
      +' onclick="irParaPagina('+n+')">'+n+'</button>';
  }).join('');

  el.innerHTML=
     '<nav class="pg-bar" aria-label="Paginas de produtos">'
    +'<button class="pg-seta" onclick="irParaPagina('+(paginaAtual-1)+')"'+(paginaAtual<=1?' disabled':'')+'>Anterior</button>'
    +botoes
    +'<button class="pg-seta" onclick="irParaPagina('+(paginaAtual+1)+')"'+(paginaAtual>=total?' disabled':'')+'>Próxima</button>'
    +'</nav>'
    +'<div class="pg-info">Página '+paginaAtual+' de '+total+'</div>';
}
`;
