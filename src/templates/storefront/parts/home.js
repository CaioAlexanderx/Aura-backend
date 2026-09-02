// AURA. -- storefront/parts/home.js
//
// A home que nasce do estoque (fase 3 do redesign, 02/09/2026).
//
// Tres blocos, desenhados a partir de __S.home — que o servidor ja
// resolveu em services/homeDaLoja.js (janela, minimo, limite). Aqui nao
// ha regra de negocio: lista vazia = bloco nao aparece, e pronto.
//
// Tambem moram aqui o cabecalho novo (categorias de topo com mega-menu,
// gaveta no celular, links do rodape) e o MODO HOME: os blocos so
// aparecem quando nao ha categoria, busca nem filtro. Escolher qualquer
// coisa esconde os blocos e mostra a grade, que e a pagina de categoria.
'use strict';

module.exports = `
// ── Dados da home ────────────────────────────────────────
var HOME = __S.home || { mais_vendidos:[], ultimas_unidades:[], novidades:[] };
// As pecas dos blocos entram no PROD_MAP: o clique abre a pagina do
// produto pelo id, e a peca pode nao estar na pagina 1 da grade.
[].concat(HOME.mais_vendidos||[], HOME.ultimas_unidades||[], HOME.novidades||[]).forEach(function(p){ if(p&&p.id) PROD_MAP[p.id]=p; });

/** Cabecalho de secao: titulo, legenda e (opcional) link a direita. */
function cabecalhoDeSecao(titulo, legenda, linkTxt, linkFn){
  return '<div class="home-sec-head">'
    + '<div><h2 class="home-sec-tit">'+esc(titulo)+'</h2>'
    + (legenda?'<div class="sf-caption">'+esc(legenda)+'</div>':'')+'</div>'
    + (linkTxt?'<a href="#" class="home-sec-link" onclick="'+linkFn+';return false;">'+esc(linkTxt)+' →</a>':'')
    + '</div>';
}

/**
 * "Tamanhos M e G" — a frase da linha de ultimas unidades. Le as
 * variantes com saldo; sem tamanho cadastrado, nao escreve nada.
 */
function fraseDeTamanhos(p){
  var t=(typeof tamanhosDoCartao==='function')?tamanhosDoCartao(p):[];
  if(!t.length) return '';
  if(t.length===1) return 'Tamanho '+t[0];
  return 'Tamanhos '+t.slice(0,-1).join(', ')+' e '+t[t.length-1];
}

function linhaUltimaHtml(p){
  var comFoto=(p.variants||[]).filter(function(v){return v.thumb_url||v.image_url;})[0]||{};
  var img=p.thumb_url||p.image_url||comFoto.thumb_url||comFoto.image_url;
  var thumb=img?'<img src="'+esc(img)+'" alt="" loading="lazy">'
    :'<div class="product-ph-initials home-linha-ini">'+esc(INICIAIS(p.name))+'</div>';
  var fundo=img?'':' style="background:'+FUNDO_CAPA(p.name)+'"';
  var restam=Number(p.restam)||0;
  var badge=restam===1?'RESTA 1':'RESTAM '+restam;
  var tam=fraseDeTamanhos(p);
  return '<a href="#" class="home-linha" onclick="showDetail(\\''+p.id+'\\');return false;">'
    +'<div class="home-linha-thumb"'+fundo+'>'+thumb+'</div>'
    +'<div class="home-linha-info"><span class="home-linha-nome">'+esc(p.name)+'</span>'
    +(tam?'<span class="home-linha-tam">'+esc(tam)+'</span>':'')
    +(SETTINGS.show_prices!==false&&p.price!=null?'<span class="home-linha-preco mono">'+fmt(p.price)+'</span>':'')
    +'</div>'
    +'<span class="badge-urgencia">'+badge+'</span></a>';
}

function renderHome(){
  var mv=document.getElementById('homeMaisVendidos');
  var uu=document.getElementById('homeUltimas');
  var nv=document.getElementById('homeNovidades');
  if(mv){
    var lista=HOME.mais_vendidos||[];
    mv.hidden=!lista.length;
    mv.innerHTML=lista.length?'<div class="home-sec-inner">'
      +cabecalhoDeSecao('Mais vendidos','As peças que mais saem daqui.','Ver tudo',"verTudo('mais_vendidos')")
      +'<div class="home-grid">'+lista.map(function(p){return cardHtml(p);}).join('')+'</div></div>':'';
  }
  if(uu){
    var ult=HOME.ultimas_unidades||[];
    uu.hidden=!ult.length;
    uu.innerHTML=ult.length?'<div class="home-sec-inner">'
      +cabecalhoDeSecao('Últimas unidades','Restam poucas de cada uma.')
      +'<div class="home-linhas">'+ult.map(linhaUltimaHtml).join('')+'</div></div>':'';
  }
  if(nv){
    var nov=HOME.novidades||[];
    nv.hidden=!nov.length;
    nv.innerHTML=nov.length?'<div class="home-sec-inner">'
      +cabecalhoDeSecao('Acabaram de chegar','O que entrou por último na loja.','Ver novidades',"verTudo('novidades')")
      +'<div class="home-grid">'+nov.map(function(p){return cardHtml(p);}).join('')+'</div></div>':'';
  }
}

/**
 * "Novidades" e "Mais vendidos" sao VISTAS: a grade inteira ordenada pelo
 * criterio, com titulo e migalhas proprios, fora do modo home. Antes
 * "Novidades" no menu so trocava a ordem e a pagina continuava dizendo
 * "Todos os produtos" (Caio, 02/09).
 */
var VISTAS={ novidades:'Novidades', mais_vendidos:'Mais vendidos' };
var vistaEspecial=null;
function verTudo(criterio){
  vistaEspecial=VISTAS[criterio]?criterio:null;
  ordem=criterio;
  var sel=document.getElementById('sortSelect'); if(sel) sel.value=criterio;
  if(currentCat!=='Todos'){ currentCat='Todos'; if(typeof renderCategorias==='function') renderCategorias(); }
  // "Ver tudo" e um pedido explicito de ver a grade: aqui a rolagem vale.
  irParaPagina(1,{rolar:true});
}

// ── Modo home ────────────────────────────────────────────
//
// Sem categoria, busca nem filtro, a pagina e a HOME e mostra os blocos.
// Com qualquer um deles, os blocos somem e a grade vira a pagina de
// categoria (fase 4). O <body> nasce com a classe, e cada render da
// grade reavalia.
function modoHome(){
  if(vistaEspecial) return false;
  if(currentCat&&currentCat!=='Todos') return false;
  if(String(searchTerm||'').trim()) return false;
  if(typeof paramsDeFiltro==='function'&&paramsDeFiltro().length) return false;
  return true;
}
function atualizarModoHome(){
  var home=modoHome();
  document.body.classList.toggle('home',home);
  renderCabecalhoDaGrade(home);
  // O menu marca a vista aberta ("Novidades") como marca a categoria.
  if(typeof renderTopNav==='function') renderTopNav();
}

/**
 * Migalhas e titulo da pagina de categoria (fase 4).
 *
 * "Início / Vestidos / Festa" vem do caminho: cada prefixo do path e um
 * no da arvore. Busca vira "Resultados para “x”"; na home, "Todos os
 * produtos" sem migalhas.
 */
function noDoCaminho(caminho){
  for(var i=0;i<ARVORE.length;i++){ if(ARVORE[i].caminho===caminho) return ARVORE[i]; }
  return null;
}
function renderCabecalhoDaGrade(home){
  var t=document.getElementById('catTitle');
  var nav=document.getElementById('crumbs');
  var busca=String(searchTerm||'').trim();
  var itens=[];
  if(!home){
    itens.push('<a href="#" onclick="return irParaHome()">Início</a>');
    if(currentCat&&currentCat!=='Todos'){
      var partes=String(currentCat).split('/').filter(Boolean);
      var acum='';
      partes.forEach(function(seg,i){
        acum+='/'+seg;
        var no=noDoCaminho(acum);
        var nome=no?no.nome:seg;
        if(i===partes.length-1) itens.push('<span aria-current="page">'+esc(nome)+'</span>');
        else itens.push('<a href="#" onclick="irParaCategoria(\\''+escJsAttr(acum)+'\\');return false;">'+esc(nome)+'</a>');
      });
    }
    if(!busca&&vistaEspecial) itens.push('<span aria-current="page">'+esc(VISTAS[vistaEspecial])+'</span>');
    if(busca) itens.push('<span aria-current="page">Busca</span>');
  }
  if(nav){
    nav.hidden=!itens.length;
    nav.innerHTML=itens.join('<span class="crumbs-sep">/</span>');
  }
  if(t){
    if(busca) t.textContent='Resultados para “'+busca+'”';
    else if(currentCat&&currentCat!=='Todos') t.textContent=(typeof nomeDoCaminho==='function'?nomeDoCaminho(currentCat):currentCat)||currentCat;
    else if(vistaEspecial) t.textContent=VISTAS[vistaEspecial];
    else t.textContent='Todos os produtos';
  }
}

/** Volta pra home: sem categoria, busca, filtro nem ordem. */
function irParaHome(){
  vistaEspecial=null;
  searchTerm='';
  var inp=document.getElementById('searchInput'); if(inp) inp.value='';
  ordem='destaque';
  var sel=document.getElementById('sortSelect'); if(sel) sel.value='destaque';
  if(typeof limparFiltros==='function') limparFiltros({semRecarregar:true});
  filterCat('Todos',null);
  window.scrollTo({top:0,behavior:comportamentoDeRolagem()});
  return false;
}

/** O X da busca: limpa e volta ao que estava. */
function limparBusca(){
  var inp=document.getElementById('searchInput');
  if(inp) inp.value='';
  searchTerm='';
  atualizarBotaoDaBusca();
  recarregarDoInicio();
}
function atualizarBotaoDaBusca(){
  var inp=document.getElementById('searchInput');
  var x=document.querySelector('#topbarSearchInline .topbar-search-close');
  if(x) x.hidden=!(inp&&inp.value);
}
document.addEventListener('input',function(e){ if(e.target&&e.target.id==='searchInput') atualizarBotaoDaBusca(); });

/**
 * CTA do banner com destino interno: "#cat=/vestidos" abre a categoria
 * AQUI, sem sair da pagina (a sacola vive na memoria). Aqui a rolagem ate
 * a grade vale: "Ver a colecao" e um pedido explicito de ver a colecao.
 */
function irPeloCta(a){
  var h=String(a&&a.getAttribute('href')||'');
  var m=/^#cat=(\\/.+)$/.exec(h);
  if(!m) return true;
  if(typeof irParaCategoria==='function') irParaCategoria(m[1]);
  irParaPagina(1,{rolar:true});
  return false;
}
// Link colado com #cat=/... abre direto na categoria.
(function(){
  var m=/^#cat=(\\/.+)$/.exec(window.location.hash||'');
  if(m&&typeof filterCat==='function') setTimeout(function(){ filterCat(decodeURIComponent(m[1]),null); },0);
})();

// ── Cabecalho: categorias de topo e mega-menu ────────────
//
// Nivel 1 na barra (e nas colunas do mega-menu), nivel 2 listado com a
// contagem; nivel 3 so na pagina de categoria. Abre no mouse E no clique
// — toque nao tem hover. Fecha ao sair do cabecalho, no Esc ou clicando
// fora. Tudo vem de ARVORE/CATEGORIAS (parts/categorias.js): categoria
// sem peca nem chega aqui.
var megaAberto=false;

function renderTopNav(){
  var nav=document.getElementById('topNav'); if(!nav) return;
  var itens='<button type="button" class="topnav-item'+(vistaEspecial==='novidades'?' active':'')+'" onclick="verTudo(\\'novidades\\')">Novidades</button>';
  itens+=CATEGORIAS.map(function(c){
    var temFilhas=filhasDe(c.slug).length>0;
    return '<button type="button" class="topnav-item'+(dentroDe(c.caminho)?' active':'')+'" data-cat="'+esc(c.caminho)+'"'
      +(temFilhas?' data-mega="1" aria-haspopup="true" aria-expanded="false"':'')+'>'
      +esc(c.nome)+(temFilhas?'<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>':'')
      +'</button>';
  }).join('');
  nav.innerHTML=itens;
  nav.querySelectorAll('.topnav-item[data-cat]').forEach(function(b){
    b.addEventListener('click',function(){ fecharMega(); irParaCategoria(b.dataset.cat); });
    if(b.dataset.mega){
      b.addEventListener('mouseenter',function(){ abrirMega(); });
    } else {
      b.addEventListener('mouseenter',function(){ fecharMega(); });
    }
  });
}

function megaHtml(){
  return '<div class="mega-inner"><div class="mega-cols">'
    +CATEGORIAS.map(function(topo){
      var filhas=filhasDe(topo.slug);
      return '<div class="mega-col">'
        +'<button type="button" class="mega-topo" data-cat="'+esc(topo.caminho)+'">'+esc(topo.nome)+'<span class="mono mega-num">'+topo.total+'</span></button>'
        +filhas.map(function(f){
          return '<button type="button" class="mega-item" data-cat="'+esc(f.caminho)+'">'+esc(f.nome)+'<span class="mono mega-num">'+f.total+'</span></button>';
        }).join('')
        +'</div>';
    }).join('')
    +'</div></div>';
}
function abrirMega(){
  var m=document.getElementById('megaMenu'); if(!m||!TEM_ARVORE) return;
  if(!megaAberto){ m.innerHTML=megaHtml(); m.hidden=false; megaAberto=true;
    m.querySelectorAll('[data-cat]').forEach(function(b){ b.addEventListener('click',function(){ fecharMega(); irParaCategoria(b.dataset.cat); }); });
  }
  document.querySelectorAll('.topnav-item[data-mega]').forEach(function(b){ b.setAttribute('aria-expanded','true'); });
}
function fecharMega(){
  var m=document.getElementById('megaMenu'); if(!m) return;
  m.hidden=true; m.innerHTML=''; megaAberto=false;
  document.querySelectorAll('.topnav-item[data-mega]').forEach(function(b){ b.setAttribute('aria-expanded','false'); });
}
(function(){
  var tb=document.getElementById('topbar'); if(!tb) return;
  tb.addEventListener('mouseleave',fecharMega);
  document.addEventListener('keydown',function(e){ if(e.key==='Escape'){ fecharMega(); fecharDrawer(); } });
  document.addEventListener('click',function(e){ if(megaAberto&&!tb.contains(e.target)) fecharMega(); });
})();

// ── Gaveta (celular) ─────────────────────────────────────
function drawerHtml(){
  var itens='<button type="button" class="drawer-item drawer-novidades" onclick="fecharDrawer();verTudo(\\'novidades\\')">Novidades</button><div class="drawer-sep"></div>';
  itens+=CATEGORIAS.map(function(topo){
    return '<button type="button" class="drawer-topo" data-cat="'+esc(topo.caminho)+'">'+esc(topo.nome)+'<span class="mono mega-num">'+topo.total+'</span></button>'
      +filhasDe(topo.slug).map(function(f){
        return '<button type="button" class="drawer-item" data-cat="'+esc(f.caminho)+'">'+esc(f.nome)+'<span class="mono mega-num">'+f.total+'</span></button>';
      }).join('');
  }).join('');
  return '<div class="drawer-head"><span class="serif drawer-tit">Categorias</span>'
    +'<button type="button" class="drawer-x" onclick="fecharDrawer()" aria-label="Fechar">&#215;</button></div>'
    +'<nav class="drawer-nav">'+itens+'</nav>';
}
function abrirDrawer(){
  var d=document.getElementById('drawerMenu'), o=document.getElementById('drawerOverlay');
  if(!d) return;
  d.innerHTML=drawerHtml(); d.hidden=false; if(o) o.hidden=false;
  document.body.style.overflow='hidden';
  d.querySelectorAll('[data-cat]').forEach(function(b){ b.addEventListener('click',function(){ fecharDrawer(); irParaCategoria(b.dataset.cat); }); });
}
function fecharDrawer(){
  var d=document.getElementById('drawerMenu'), o=document.getElementById('drawerOverlay');
  if(d&&!d.hidden){ d.hidden=true; d.innerHTML=''; document.body.style.overflow=''; }
  if(o) o.hidden=true;
}

// ── Rodape: Navegue ──────────────────────────────────────
function renderFooterNav(){
  var ul=document.getElementById('footerNav'); if(!ul) return;
  var li='<li><a href="#" onclick="verTudo(\\'novidades\\');return false;">Novidades</a></li>';
  li+=CATEGORIAS.slice(0,5).map(function(c){
    return '<li><a href="#" onclick="irParaCategoria(\\''+escJsAttr(c.caminho)+'\\');return false;">'+esc(c.nome)+'</a></li>';
  }).join('');
  li+='<li><a href="#" onclick="openCart();return false;">Minha sacola</a></li>';
  ul.innerHTML=li;
}
`;
