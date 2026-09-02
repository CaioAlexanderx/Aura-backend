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

/**
 * @param opcoes.rolar false quando o clique veio de um controle que a
 *   pessoa AINDA esta usando — menu de categorias, filtro de tamanho e
 *   cor, busca, ordenacao. Rolar ate a grade no meio dessa navegacao
 *   arranca a pagina da mao dela: clicava numa categoria e a tela
 *   descia, tirando o proprio menu da vista. Paginacao continua
 *   rolando: "pagina 2" e um pedido explicito de ver a pagina 2 do
 *   comeco.
 */
function irParaPagina(n,opcoes){
  var rolar=!(opcoes&&opcoes.rolar===false);
  var total=totalDePaginas();
  n=Math.min(Math.max(1,n),total);
  if(carregandoPagina){ pedidoPendente={n:n,rolar:rolar}; return; }
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
      // A lateral passa a mostrar as opcoes DESTA categoria. Se alguma
      // selecao nao existe mais aqui, ela cai e a busca se refaz — como
      // carregandoPagina ainda e true, isto vira pedidoPendente e roda
      // uma vez so, no fim.
      if(typeof atualizarFacetas==='function' && atualizarFacetas(j.facetas)){
        irParaPagina(1,{rolar:false});
      }
      var alvo=document.getElementById('productsAnchor');
      if(alvo){
        var topo=alvo.offsetTop-alturaDasBarras()-8;
        // Sem "rolar" a pagina NUNCA desce — mas sobe ate o topo da
        // grade se a pessoa ja tinha passado dele: trocar de categoria
        // no pe da pagina 5 e ficar olhando o MEIO da grade nova e
        // outra forma de se perder.
        if(rolar||window.scrollY>topo) window.scrollTo({top:topo,behavior:comportamentoDeRolagem()});
      }
    })
    .catch(function(){
      var grid=document.getElementById('productsGrid');
      if(grid) grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:48px 0;color:var(--sf-ink-3);">Nao consegui carregar esta pagina. Tente de novo.</div>';
    })
    .then(function(){
      carregandoPagina=false; marcarCarregando(false);
      // O que o usuario pediu enquanto esta rodava. filtro, busca e ordem
      // ja estao no estado do modulo, entao a recarga pega o valor atual.
      if(pedidoPendente!=null){ var p=pedidoPendente; pedidoPendente=null; irParaPagina(p.n,{rolar:p.rolar}); }
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

// Rolagem suave e MOVIMENTO. Quem ligou "reduzir movimento" no sistema
// recebe o salto seco — mesma regra do bloco reduced-motion do CSS, que
// nao alcanca o parametro do scrollTo.
function comportamentoDeRolagem(){
  return (window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)?'auto':'smooth';
}

/** Qualquer mudanca de filtro volta pra pagina 1 — sem rolar: quem
    chama aqui (categoria, filtro, busca, ordem) esta com a mao num
    controle que a rolagem tiraria da tela. Ver irParaPagina. */
function recarregarDoInicio(){ irParaPagina(1,{rolar:false}); }

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
  if(typeof atualizarModoHome==='function') atualizarModoHome();
  grid.innerHTML=visiveis.map(function(p){ return cardHtml(p); }).join('');
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
