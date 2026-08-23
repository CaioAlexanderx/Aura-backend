// AURA. -- storefront/parts/product_detail.js
//
// PAGINA de produto, nao mais uma folha de 420px.
//
// Reescrito em 23/08/2026. O detalhe era um modal estreito com foto,
// preco, chips de variante e um botao. Faltava o que todo e-commerce tem
// e o que o cliente procura antes de decidir: fotos grandes, descricao,
// escolha de cor e tamanho legivel de relance, frete, e para onde ir
// depois se este produto nao serviu.
//
// O que mudou:
//  - duas colunas no desktop: galeria a esquerda, decisao a direita
//  - DUAS acoes: "Adicionar ao carrinho" e "Comprar agora"
//  - cor vira circulo colorido mesmo quando a lojista escreveu "Preto"
//    em vez de "#000000" — que e o que ela escreve de verdade
//  - "Produtos relacionados" embaixo, pra navegar em vez de sair
//  - a seta volta pra ONDE a pessoa estava (busca, categoria ou inicio),
//    usando o historico do navegador
'use strict';

module.exports = `
// ── Cor por NOME ─────────────────────────────────────────
//
// O swatch antigo so aparecia se o valor fosse hex. Lojista nao digita
// "#000000": ela digita "Preto", "Azul marinho", "Off white". Sem este
// mapa, cor virava chip de texto e a pessoa tinha que ler cada opcao em
// vez de bater o olho.
var CORES_PT = {
  'preto':'#111111','branco':'#FFFFFF','off white':'#F3EFE7','offwhite':'#F3EFE7',
  'cru':'#EFE7D8','bege':'#E4D5BE','nude':'#E3C4AE','marrom':'#6B4A2F',
  'caramelo':'#A9682F','camel':'#B8895A','cinza':'#9AA0A6','chumbo':'#4A4F55',
  'prata':'#C9CCD1','dourado':'#C8A24A','vermelho':'#D32F2F','vinho':'#6E1F2B',
  'marsala':'#8A3A44','bordo':'#5C1A26','bordô':'#5C1A26','rosa':'#E8879B',
  'rosa claro':'#F3C0CB','pink':'#E0398B','magenta':'#C2185B','coral':'#F0765B',
  'laranja':'#EF6C1A','amarelo':'#F2C230','mostarda':'#C9A227','verde':'#2E7D4F',
  'verde militar':'#4B5320','verde agua':'#7FD1C1','oliva':'#6B7A3A','menta':'#A8DEC8',
  'azul':'#1F5FBF','azul marinho':'#1B2A4A','marinho':'#1B2A4A','azul claro':'#8FC1E3',
  'jeans':'#4A6D8C','turquesa':'#22A6A6','roxo':'#6D28D9','lilas':'#B79CE0',
  'lilás':'#B79CE0','violeta':'#7C3AED','transparente':'#EDEDED'
};

function corDoValor(val){
  var s=String(val==null?'':val).trim();
  if(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(s)) return s;
  var chave=s.toLowerCase()
    .normalize('NFD')
    .split('').filter(function(c){var k=c.charCodeAt(0);return k<0x300||k>0x36f;}).join('');
  return CORES_PT[chave] || null;
}

/** O atributo e de cor? (decide entre circulo e chip de texto) */
function atributoDeCor(nome){
  var n=String(nome||'').toLowerCase();
  return n.indexOf('cor')===0 || n.indexOf('color')===0;
}

/** Tinta legivel sobre a cor — o check some se for branco no branco. */
function tintaSobreCor(hex){
  var h=hex.length===4?('#'+hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3]):hex;
  var r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);
  return (0.299*r+0.587*g+0.114*b)>160?'#111':'#fff';
}

// ── Estado da pagina ─────────────────────────────────────
var paginaProduto=null;

/** De onde a pessoa veio — vira o rotulo da seta de voltar. */
function origemAtual(){
  if(String(searchTerm||'').trim()) return 'Voltar para a busca';
  if(currentCat && currentCat!=='Todos') return 'Voltar para ' + currentCat;
  return 'Voltar para a loja';
}

function fecharProduto(){
  if(!paginaProduto) return;
  if(paginaProduto.parar) paginaProduto.parar();
  paginaProduto.el.remove();
  paginaProduto=null;
  document.body.style.overflow='';
}

/** A seta e o botao Voltar do navegador fazem a MESMA coisa. */
window.addEventListener('popstate',function(){ if(paginaProduto) fecharProduto(); });

function voltarDaPagina(){
  // history.back dispara o popstate, que fecha. Assim a seta da tela e o
  // gesto de voltar do celular concordam.
  if(paginaProduto && paginaProduto.empilhou) history.back();
  else fecharProduto();
}

function showDetail(id){
  var p=PROD_MAP[id]; if(!p) return;
  fecharProduto();

  var hasVar=!!(p.variants && p.variants.length);

  // Galeria: foto do pai + de cada variante, sem repetir.
  var fotos=[];
  function juntar(u){ if(u && fotos.indexOf(u)===-1) fotos.push(u); }
  juntar(p.image_url);
  (p.gallery_urls||[]).forEach(juntar);
  if(hasVar) p.variants.forEach(function(v){ juntar(v.image_url); });

  var fotoAtual=0;

  // ── Selecao de variante ────────────────────────────────
  var attrs={}, attrOrder=[];
  if(hasVar){
    p.variants.forEach(function(v){
      (v.values||[]).forEach(function(av){
        if(!attrs[av.attribute]){ attrs[av.attribute]=[]; attrOrder.push(av.attribute); }
        if(attrs[av.attribute].indexOf(av.value)===-1) attrs[av.attribute].push(av.value);
      });
    });
  }
  var selecionado={}, variante=null;

  function acharVariante(){
    if(!hasVar || attrOrder.length===0) return null;
    for(var i=0;i<p.variants.length;i++){
      var v=p.variants[i], vals=v.values||[];
      if(vals.length!==attrOrder.length) continue;
      var bate=true;
      for(var j=0;j<vals.length;j++){
        if(selecionado[vals[j].attribute]!==vals[j].value){ bate=false; break; }
      }
      if(bate) return v;
    }
    return null;
  }

  function possivel(a,val){
    return p.variants.some(function(v){
      var m={}; (v.values||[]).forEach(function(av){ m[av.attribute]=av.value; });
      if(m[a]!==val) return false;
      for(var k in selecionado){ if(k!==a && selecionado[k] && m[k]!==selecionado[k]) return false; }
      return v.stock_qty>0;
    });
  }

  function opcoesHtml(){
    if(!hasVar) return '';
    return attrOrder.map(function(a){
      var cor=atributoDeCor(a);
      var escolhido=selecionado[a];
      var opcoes=attrs[a].map(function(val){
        var ok=possivel(a,val), sel=escolhido===val;
        var hex=cor?corDoValor(val):null;
        var attrs2=' data-attr="'+esc(a)+'" data-val="'+esc(val)+'" data-ok="'+(ok?'1':'0')+'"';

        if(hex){
          // Circulo com o NOME embaixo: a cor se ve de relance e o nome
          // resolve quem nao distingue os tons proximos.
          return '<button type="button" class="op-cor'+(sel?' sel':'')+(ok?'':' off')+'"'+attrs2+' title="'+esc(val)+'">'
            +'<span class="op-cor-bola" style="background:'+hex+';">'
            +(sel?'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="'+tintaSobreCor(hex)+'" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':'')
            +'</span><span class="op-cor-nome">'+esc(val)+'</span></button>';
        }
        return '<button type="button" class="op-chip'+(sel?' sel':'')+(ok?'':' off')+'"'+attrs2+'>'+esc(val)+'</button>';
      }).join('');

      return '<div class="op-grupo">'
        +'<div class="op-label">'+esc(a)
        +(escolhido?'<span class="op-escolhido">'+esc(escolhido)+'</span>':'<span class="op-pede">escolha</span>')
        +'</div>'
        +'<div class="op-lista'+(cor?' op-lista-cor':'')+'">'+opcoes+'</div>'
        +'</div>';
    }).join('');
  }

  function precoAtual(){
    if(p.price==null||SETTINGS.show_prices===false) return null;
    return (variante&&variante.price_override!=null)?variante.price_override:p.price;
  }

  function precoHtml(){
    var v=precoAtual();
    if(v==null) return '';
    var parc=PARCELAS_TXT(v);
    return '<div class="pd-preco">'+fmt(v)+'</div>'
      +(parc?'<div class="pd-parcela">'+esc(parc)+'</div>':'');
  }

  function faltaEscolher(){
    if(!hasVar) return false;
    for(var i=0;i<attrOrder.length;i++){ if(!selecionado[attrOrder[i]]) return true; }
    return false;
  }

  function avisoHtml(){
    if(!hasVar) return '';
    if(faltaEscolher()) return '<div class="pd-aviso">Escolha '+attrOrder.map(function(a){return a.toLowerCase();}).join(' e ')+' para continuar.</div>';
    if(variante&&variante.stock_qty<=0) return '<div class="pd-aviso pd-aviso-ruim">Esta combinação está sem estoque.</div>';
    if(variante&&SETTINGS.show_stock) return '<div class="pd-aviso">'+variante.stock_qty+' em estoque.</div>';
    return '';
  }

  function bloqueado(){
    if(!hasVar) return false;
    return faltaEscolher() || !variante || variante.stock_qty<=0;
  }

  function fotosHtml(){
    if(!fotos.length){
      return '<div class="pd-foto" style="background:'+FUNDO_CAPA(p.name)+'">'
        +'<div class="product-ph-initials" style="font-size:64px;">'+esc(INICIAIS(p.name))+'</div></div>';
    }
    var mini = fotos.length>1
      ? '<div class="pd-minis">'+fotos.map(function(u,i){
          return '<button type="button" class="pd-mini'+(i===fotoAtual?' sel':'')+'" data-foto="'+i+'">'
            +'<img src="'+esc(u)+'" alt="">'+'</button>';
        }).join('')+'</div>'
      : '';
    return '<div class="pd-foto"><img id="pdFoto" src="'+esc(fotos[fotoAtual])+'" alt="'+esc(p.name)+'"></div>'+mini;
  }

  // ── Monta a pagina ─────────────────────────────────────
  var el=document.createElement('div');
  el.className='pd-overlay';
  el.innerHTML=
     '<div class="pd-topo">'
    +'<button type="button" class="pd-voltar" id="pdVoltar">'
    +'<span class="pd-voltar-seta">&#8592;</span>'+esc(origemAtual())+'</button>'
    +'</div>'
    +'<div class="pd-corpo">'
    +'<div class="pd-col-foto" id="pdGaleria">'+fotosHtml()+'</div>'
    +'<div class="pd-col-info">'
    +(p.category?'<div class="pd-cat">'+esc(p.category)+'</div>':'')
    +'<h1 class="pd-nome">'+esc(p.name)+'</h1>'
    +'<div id="pdPreco">'+precoHtml()+'</div>'
    +'<div id="pdOpcoes">'+opcoesHtml()+'</div>'
    +'<div id="pdAviso">'+avisoHtml()+'</div>'
    +'<div class="pd-acoes">'
    +'<button type="button" class="pd-comprar" id="pdComprar">Comprar agora</button>'
    +'<button type="button" class="pd-add" id="pdAdd">Adicionar ao carrinho</button>'
    +'</div>'
    +(p.description?'<div class="pd-desc"><div class="pd-desc-tit">Sobre este produto</div><p>'+esc(p.description)+'</p></div>':'')
    +'</div>'
    +'</div>'
    +'<section class="pd-relacionados" id="pdRelacionados" hidden>'
    +'<h2 class="pd-rel-tit">Produtos relacionados</h2>'
    +'<div class="pd-rel-grade" id="pdRelGrade"></div>'
    +'</section>';

  document.body.appendChild(el);
  document.body.style.overflow='hidden';
  el.scrollTop=0;

  // Empilha no historico pra seta da tela e "voltar" do celular
  // concordarem. Se pushState falhar (navegador antigo), a seta ainda
  // fecha direto.
  var empilhou=false;
  try{ history.pushState({produto:p.id},'',location.pathname+location.search); empilhou=true; }catch(e){}
  paginaProduto={el:el,empilhou:empilhou,parar:null};

  function repintar(){
    el.querySelector('#pdOpcoes').innerHTML=opcoesHtml();
    el.querySelector('#pdPreco').innerHTML=precoHtml();
    el.querySelector('#pdAviso').innerHTML=avisoHtml();
    var trava=bloqueado();
    ['#pdAdd','#pdComprar'].forEach(function(s){
      var b=el.querySelector(s);
      b.disabled=trava;
      b.classList.toggle('off',trava);
    });
    ligarOpcoes();
  }

  function ligarOpcoes(){
    el.querySelectorAll('#pdOpcoes [data-attr]').forEach(function(b){
      b.addEventListener('click',function(){
        if(b.dataset.ok!=='1') return;
        var a=b.dataset.attr,val=b.dataset.val;
        if(selecionado[a]===val) delete selecionado[a]; else selecionado[a]=val;
        variante=acharVariante();
        // Trocar de cor troca a foto, se aquela variante tiver uma.
        if(variante&&variante.image_url){
          var i=fotos.indexOf(variante.image_url);
          if(i>=0){ fotoAtual=i; pintarFoto(); }
        }
        repintar();
      });
    });
  }

  function pintarFoto(){
    var img=el.querySelector('#pdFoto');
    if(img&&fotos[fotoAtual]) img.src=fotos[fotoAtual];
    el.querySelectorAll('.pd-mini').forEach(function(m,i){
      m.classList.toggle('sel',i===fotoAtual);
    });
  }

  function ligarMinis(){
    el.querySelectorAll('.pd-mini').forEach(function(m){
      m.addEventListener('click',function(){ fotoAtual=parseInt(m.dataset.foto,10)||0; pintarFoto(); });
    });
  }

  el.querySelector('#pdVoltar').addEventListener('click',voltarDaPagina);

  el.querySelector('#pdAdd').addEventListener('click',function(){
    if(bloqueado()) return;
    addToCart(p.id, variante?variante.id:null);
    var b=this; var antes=b.textContent;
    b.textContent='Adicionado';
    setTimeout(function(){ b.textContent=antes; },1200);
  });

  el.querySelector('#pdComprar').addEventListener('click',function(){
    if(bloqueado()) return;
    addToCart(p.id, variante?variante.id:null);
    // "Comprar" pula o carrinho: quem clicou aqui ja decidiu.
    fecharProduto();
    openCheckout();
  });

  ligarOpcoes();
  ligarMinis();
  repintar();
  carregarRelacionados(p);
}

/**
 * Produtos relacionados: mesma categoria, sem repetir o que esta aberto.
 *
 * Usa a MESMA rota da grade — nao ha um segundo conceito de "relacionado"
 * pra manter em sincronia. Se a loja nao tem categoria no produto, a
 * secao simplesmente nao aparece.
 */
function carregarRelacionados(p){
  if(!p.category) return;
  fetch(API_BASE+'/api/v1/storefront/'+encodeURIComponent(SLUG)+'/catalogo?limit=12&cat='+encodeURIComponent(p.category))
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(!paginaProduto) return;
      var lista=(j&&j.products||[]).filter(function(x){ return x.id!==p.id; }).slice(0,6);
      if(!lista.length) return;
      lista.forEach(function(x){ PROD_MAP[x.id]=x; });

      var sec=paginaProduto.el.querySelector('#pdRelacionados');
      var grade=paginaProduto.el.querySelector('#pdRelGrade');
      grade.innerHTML=lista.map(function(x){
        var img=x.image_url;
        if(!img && x.variants && x.variants.length){
          for(var i=0;i<x.variants.length;i++){ if(x.variants[i].image_url){ img=x.variants[i].image_url; break; } }
        }
        var capa=img
          ? '<img src="'+esc(img)+'" alt="">'
          : '<div class="product-ph-initials">'+esc(INICIAIS(x.name))+'</div>';
        var fundo=img?'':' style="background:'+FUNDO_CAPA(x.name)+'"';
        var preco=(SETTINGS.show_prices!==false&&x.price!=null)?'<div class="pd-rel-preco">'+fmt(x.price)+'</div>':'';
        return '<button type="button" class="pd-rel-card" onclick="showDetail(\\''+x.id+'\\')">'
          +'<div class="pd-rel-foto"'+fundo+'>'+capa+'</div>'
          +'<div class="pd-rel-nome">'+esc(x.name)+'</div>'+preco+'</button>';
      }).join('');
      sec.hidden=false;
    })
    .catch(function(){});
}
`;
