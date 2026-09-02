// AURA. -- storefront/parts/product_detail.js
//
// A pagina do produto.
//
// REESCRITA em 02/09/2026 (fase 5 do redesign, Claude Design, loja-modelo
// Finesse). O que ela tem:
//
//   - migalhas (Inicio / categoria / peca) e a seta de voltar
//   - galeria: miniaturas em coluna a esquerda, foto grande num canvas 3:4
//     em contain, com zoom no mouse (desktop) e troca por toque
//   - cartao de preco: valor em DM Mono, parcela ao lado, Pix em verde
//   - escolha de cor e tamanho — o rotulo diz o que ja foi escolhido,
//     tamanho esgotado fica riscado, e "Ultimas N unidades no M" quando
//     a variante escolhida esta acabando
//   - "Adicionar a sacola" (acao principal) e "Tirar duvida no WhatsApp"
//   - frete por CEP (quando a loja entrega) e retirada na loja
//   - descricao, ficha tecnica (migration 305) e a politica de troca
//   - "Da mesma categoria": os cartoes da grade, pela MESMA rota
//
// Toda regra de dado continua do servidor: variantes, estoque, ficha,
// politica (rodape_institucional). Aqui so se desenha.
'use strict';

module.exports = `
/** O atributo e de cor? (decide entre circulo e chip de texto) */
function atributoDeCor(nome){
  var n=String(nome||'').toLowerCase();
  return n.indexOf('cor')===0 || n.indexOf('color')===0;
}
/** O atributo e de tamanho? (ganha o link do guia e o aviso de "ultimas") */
function atributoDeTamanho(nome){
  var n=String(nome||'').toLowerCase();
  return n==='tamanho' || n==='tamanhos' || n==='tam' || n==='size';
}
/** Tinta legivel sobre a cor — o check some se for branco no branco. */
function tintaSobreCor(hex){
  var h=hex.length===4?('#'+hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3]):hex;
  var r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);
  return (0.299*r+0.587*g+0.114*b)>160?'#111':'#fff';
}

var paginaProduto=null;

/** De onde a pessoa veio — vira o rotulo da seta de voltar. */
function origemAtual(){
  if(String(searchTerm||'').trim()) return 'Voltar para a busca';
  if(currentCat && currentCat!=='Todos'){
    var nome=(typeof nomeDoCaminho==='function')?(nomeDoCaminho(currentCat)||currentCat):currentCat;
    return 'Voltar para ' + nome;
  }
  return 'Voltar para a loja';
}

/** Abaixo disto a pagina avisa "Ultimas N unidades" na variante escolhida. */
var LIMITE_DE_ULTIMAS=3;

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
  if(paginaProduto && paginaProduto.empilhou) history.back();
  else fecharProduto();
}

/** Migalhas da pagina do produto: Inicio / categoria (pelo caminho) / peca. */
function migalhasDoProduto(p){
  var itens=['<a href="#" onclick="fecharProduto();return irParaHome();">Início</a>'];
  var caminho=p.category_path||'';
  if(caminho&&typeof noDoCaminho==='function'){
    var partes=String(caminho).split('/').filter(Boolean), acum='';
    partes.forEach(function(seg){
      acum+='/'+seg;
      var no=noDoCaminho(acum);
      if(no) itens.push('<a href="#" data-cat="'+esc(acum)+'" class="pd-crumb-cat">'+esc(no.nome)+'</a>');
    });
  } else if(p.category){
    itens.push('<span>'+esc(p.category)+'</span>');
  }
  itens.push('<span aria-current="page">'+esc(p.name)+'</span>');
  return itens.join('<span class="crumbs-sep">/</span>');
}

function showDetail(id){
  var p=PROD_MAP[id]; if(!p) return;
  fecharProduto();

  var hasVar=!!(p.variants && p.variants.length);

  // Galeria: foto do pai + galeria + de cada variante, sem repetir.
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
      // O rotulo mostra o NOME da cor, nao o hex cadastrado ("Cor — #92400E"
      // nao diz nada a cliente; a bolinha ja tem o nome embaixo).
      var escolhidoRotulo=escolhido;
      if(escolhido&&cor&&/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(String(escolhido).trim())) escolhidoRotulo=nomeDaCor(escolhido)||escolhido;
      var opcoes=attrs[a].map(function(val){
        var ok=possivel(a,val), sel=escolhido===val;
        var hex=cor?corDoValor(val):null;
        var attrs2=' data-attr="'+esc(a)+'" data-val="'+esc(val)+'" data-ok="'+(ok?'1':'0')+'"';
        if(hex){
          var ehHex=/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(String(val).trim());
          var rotulo=ehHex?(nomeDaCor(val)||'Cor'):val;
          return '<button type="button" class="op-cor'+(sel?' sel':'')+(ok?'':' off')+'"'+attrs2+' title="'+esc(rotulo)+'" aria-label="'+esc(a+': '+rotulo)+'">'
            +'<span class="op-cor-bola" style="background:'+hex+';">'
            +(sel?'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="'+tintaSobreCor(hex)+'" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':'')
            +'</span><span class="op-cor-nome">'+esc(rotulo)+'</span></button>';
        }
        return '<button type="button" class="op-chip'+(sel?' sel':'')+(ok?'':' off')+'"'+attrs2+(ok?'':' disabled')+'>'+esc(val)+'</button>';
      }).join('');
      return '<div class="op-grupo">'
        +'<div class="op-label"><span class="sf-label">'+esc(a)
        +(escolhido?' — <span class="op-escolhido">'+esc(escolhidoRotulo)+'</span>':'')+'</span>'
        +(escolhido?'':'<span class="op-pede">escolha</span>')
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
    var pixPct=Number(__S.pix_discount_pct)||0;
    var pix=pixPct>0?'<div class="pd-pix"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 9-9 9-9-9 9-9z"/></svg>'+fmt(v*(1-pixPct/100))+' no Pix — '+pixPct+'% de desconto</div>':'';
    return '<div class="pd-preco-card">'
      +'<div class="pd-preco-linha"><span class="pd-preco mono">'+fmt(v)+'</span>'
      +(parc?'<span class="pd-parcela">em até '+esc(parc)+' sem juros</span>':'')+'</div>'
      +pix+'</div>';
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
    if(variante&&variante.stock_qty>0&&variante.stock_qty<=LIMITE_DE_ULTIMAS){
      var tam='';
      for(var k in selecionado){ if(atributoDeTamanho(k)) tam=selecionado[k]; }
      var n=Math.round(variante.stock_qty);
      return '<div class="pd-aviso pd-ultimas"><span class="pd-ultimas-dot"></span>'
        +(n===1?'Última unidade':'Últimas '+n+' unidades')+(tam?' no tamanho '+esc(tam):'')+'</div>';
    }
    if(variante&&SETTINGS.show_stock) return '<div class="pd-aviso">'+variante.stock_qty+' em estoque.</div>';
    return '';
  }
  function bloqueado(){
    if(!hasVar) return false;
    return faltaEscolher() || !variante || variante.stock_qty<=0;
  }

  function fotosHtml(){
    if(!fotos.length){
      return '<div class="pd-foto pd-foto-vazia" style="background:'+FUNDO_CAPA(p.name)+'">'
        +'<div class="product-ph-initials">'+esc(INICIAIS(p.name))+'</div></div>';
    }
    var mini = fotos.length>1
      ? '<div class="pd-minis">'+fotos.map(function(u,i){
          return '<button type="button" class="pd-mini'+(i===fotoAtual?' sel':'')+'" data-foto="'+i+'" aria-label="Foto '+(i+1)+'">'
            +'<img src="'+esc(u)+'" alt="">'+'</button>';
        }).join('')+'</div>'
      : '';
    return mini
      +'<div class="pd-foto"><img id="pdFoto" src="'+esc(fotos[fotoAtual])+'" alt="'+esc(p.name)+'">'
      +'<span class="pd-zoom-dica"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35M11 8v6M8 11h6"/></svg>Passe o mouse para ampliar</span></div>';
  }

  /** Ficha tecnica: so as linhas que a lojista preencheu (migration 305). */
  function fichaHtml(){
    var linhas=[
      ['Material', p.material],
      ['Medidas', p.medidas],
      ['Cuidados', p.cuidados]
    ].filter(function(l){ return l[1] && String(l[1]).trim(); });
    if(!linhas.length) return '';
    return '<div class="pd-ficha">'
      + linhas.map(function(l){
          return '<div class="pd-ficha-linha">'
            + '<span class="pd-ficha-rot">'+esc(l[0])+'</span>'
            + '<span class="pd-ficha-val">'+esc(String(l[1]).trim())+'</span></div>';
        }).join('')
      + '</div>';
  }

  /** A politica de troca, JA resolvida pelo servidor (rodape_institucional). */
  function politicaHtml(){
    var r=__S.rodape_institucional||{};
    if(!r.politica) return '';
    return '<div class="pd-politica"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v10l9 4 9-4V7l-9-4-9 4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg><span>'+esc(r.politica)+'</span></div>';
  }

  /**
   * Frete por CEP e retirada. So aparece o que a loja LIGOU: entrega
   * (delivery_enabled) cota pela mesma rota do checkout; retirada mostra o
   * endereco e o prazo cadastrados.
   */
  function entregaHtml(){
    var blocos='';
    if(SETTINGS.delivery_enabled){
      blocos+='<div class="pd-frete"><div class="sf-label">Calcular frete e prazo</div>'
        +'<div class="pd-frete-linha"><input id="pdCep" class="mono" inputmode="numeric" maxlength="9" placeholder="Seu CEP" aria-label="CEP">'
        +'<button type="button" class="pd-frete-btn" id="pdCalcular">Calcular</button></div>'
        +'<div class="pd-frete-res" id="pdFreteRes" aria-live="polite"></div></div>';
    }
    if(SETTINGS.pickup_enabled!==false&&(CONTACT.pickup_address||CONTACT.address)){
      blocos+='<div class="pd-retirada"><span class="pd-retirada-tit">Retire na loja</span>'
        +'<span class="sf-caption">'+esc(CONTACT.pickup_address||CONTACT.address)+(SETTINGS.pickup_eta_text?' · '+esc(SETTINGS.pickup_eta_text):'')+'</span></div>';
    }
    return blocos;
  }

  var whatsNum=String(CONTACT.whatsapp||'').replace(/\\D/g,'');
  var whatsHtml=whatsNum
    ? '<a class="pd-whats" href="https://wa.me/'+whatsNum+'?text='+encodeURIComponent('Oi! Tenho uma dúvida sobre "'+p.name+'"')+'" target="_blank" rel="noopener">'
      +'<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413"/></svg>Tirar dúvida no WhatsApp</a>'
    : '';

  var catNome=(p.category_path&&typeof nomeDoCaminho==='function')?(nomeDoCaminho(p.category_path)||p.category):p.category;

  var el=document.createElement('div');
  el.className='pd-overlay';
  el.innerHTML=
     '<div class="pd-topo"><div class="pd-topo-inner">'
    +'<button type="button" class="pd-voltar" id="pdVoltar"><span class="pd-voltar-seta">&#8592;</span>'+esc(origemAtual())+'</button>'
    +'<nav class="crumbs pd-crumbs" aria-label="Você está em">'+migalhasDoProduto(p)+'</nav>'
    +'</div></div>'
    +'<div class="pd-corpo">'
    +'<div class="pd-col-foto" id="pdGaleria">'+fotosHtml()+'</div>'
    +'<div class="pd-col-info">'
    +(catNome?'<div class="pd-cat sf-label">'+esc(catNome)+'</div>':'')
    +'<h1 class="pd-nome">'+esc(p.name)+'</h1>'
    +'<div id="pdPreco">'+precoHtml()+'</div>'
    +'<div id="pdOpcoes">'+opcoesHtml()+'</div>'
    +'<div id="pdAviso">'+avisoHtml()+'</div>'
    +'<div class="pd-acoes">'
    +'<button type="button" class="pd-comprar" id="pdComprar">Adicionar à sacola</button>'
    +whatsHtml
    +'</div>'
    +entregaHtml()
    +(p.description?'<div class="pd-desc"><div class="sf-label">Sobre esta peça</div><p>'+esc(p.description)+'</p></div>':'')
    +fichaHtml()
    +politicaHtml()
    +'</div>'
    +'</div>'
    +'<section class="pd-relacionados" id="pdRelacionados" hidden>'
    +'<h2 class="pd-rel-tit">Da mesma categoria</h2>'
    +'<div class="pd-rel-grade home-grid" id="pdRelGrade"></div>'
    +'</section>';
  document.body.appendChild(el);
  document.body.style.overflow='hidden';
  el.scrollTop=0;

  var empilhou=false;
  try{ history.pushState({produto:p.id},'',location.pathname+location.search); empilhou=true; }catch(e){}
  paginaProduto={el:el,empilhou:empilhou,parar:null};

  function repintar(){
    el.querySelector('#pdOpcoes').innerHTML=opcoesHtml();
    el.querySelector('#pdPreco').innerHTML=precoHtml();
    el.querySelector('#pdAviso').innerHTML=avisoHtml();
    var trava=bloqueado();
    var b=el.querySelector('#pdComprar');
    b.disabled=trava; b.classList.toggle('off',trava);
    ligarOpcoes();
  }
  function ligarOpcoes(){
    el.querySelectorAll('#pdOpcoes [data-attr]').forEach(function(b){
      b.addEventListener('click',function(){
        if(b.dataset.ok!=='1') return;
        var a=b.dataset.attr,val=b.dataset.val;
        if(selecionado[a]===val) delete selecionado[a]; else selecionado[a]=val;
        variante=acharVariante();
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
    // Zoom que segue o mouse: a foto cresce DENTRO da moldura, no ponto
    // em que o cursor esta. No toque, nada acontece (o toque abre a mini).
    var foto=el.querySelector('.pd-foto img');
    if(foto){
      foto.addEventListener('mousemove',function(e){
        var r=foto.getBoundingClientRect();
        foto.style.transformOrigin=((e.clientX-r.left)/r.width*100)+'% '+((e.clientY-r.top)/r.height*100)+'%';
      });
    }
  }
  function ligarFrete(){
    var btn=el.querySelector('#pdCalcular'), inp=el.querySelector('#pdCep'), res=el.querySelector('#pdFreteRes');
    if(!btn||!inp||!res) return;
    inp.addEventListener('input',function(){
      var d=inp.value.replace(/\\D/g,'').slice(0,8);
      inp.value=d.length>5?d.slice(0,5)+'-'+d.slice(5):d;
    });
    function cotar(){
      var cep=inp.value.replace(/\\D/g,'');
      if(cep.length!==8){ res.textContent='Digite os 8 dígitos do CEP.'; res.className='pd-frete-res erro'; return; }
      res.textContent='Calculando…'; res.className='pd-frete-res';
      var sub=precoAtual()||0;
      fetch(API_BASE+'/api/v1/storefront/'+encodeURIComponent(SLUG)+'/shipping-quote?cep='+cep+'&subtotal='+encodeURIComponent(sub))
        .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); })
        .then(function(x){
          if(!x.ok||x.d.error){ res.textContent=x.d.error||'Não consegui calcular o frete.'; res.className='pd-frete-res erro'; return; }
          var q=x.d;
          var valor=(q.fee===0||q.free_shipping)?'<span class="pd-frete-gratis">Grátis</span>':(q.fee!=null?'<span class="mono">'+fmt(q.fee)+'</span>':'—');
          res.innerHTML='<div class="pd-frete-op"><span>Entrega'+(q.eta?' — '+esc(q.eta):'')+'</span>'+valor+'</div>'
            +(q.alert?'<div class="sf-caption">'+esc(q.alert)+'</div>':'');
          res.className='pd-frete-res';
        })
        .catch(function(){ res.textContent='Não consegui calcular o frete. Tente de novo.'; res.className='pd-frete-res erro'; });
    }
    btn.addEventListener('click',cotar);
    inp.addEventListener('keydown',function(e){ if(e.key==='Enter') cotar(); });
  }

  el.querySelector('#pdVoltar').addEventListener('click',voltarDaPagina);
  el.querySelectorAll('.pd-crumb-cat').forEach(function(a){
    a.addEventListener('click',function(e){ e.preventDefault(); fecharProduto(); irParaCategoria(a.dataset.cat); });
  });
  var voltarRotulo;
  el.querySelector('#pdComprar').addEventListener('click',function(){
    if(bloqueado()) return;
    var b=this;
    if(!b.dataset.rotulo) b.dataset.rotulo=b.textContent;
    addToCart(p.id, variante?variante.id:null, { semToast:true });
    b.textContent='Adicionado à sacola';
    b.classList.add('feito');
    clearTimeout(voltarRotulo);
    voltarRotulo=setTimeout(function(){
      b.textContent=b.dataset.rotulo;
      b.classList.remove('feito');
    },1400);
  });
  ligarOpcoes();
  ligarMinis();
  ligarFrete();
  repintar();
  carregarRelacionados(p);
}

/**
 * "Da mesma categoria": a MESMA rota da grade, os MESMOS cartoes
 * (cardHtml). Nao ha um segundo conceito de "relacionado" pra manter em
 * sincronia — e o titulo diz a verdade (nao temos dado de "quem viu
 * tambem levou"; decisao 15, 02/09/2026).
 */
function carregarRelacionados(p){
  var cat=p.category_path||p.category;
  if(!cat) return;
  fetch(API_BASE+'/api/v1/storefront/'+encodeURIComponent(SLUG)+'/catalogo?limit=12&cat='+encodeURIComponent(cat))
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(!paginaProduto) return;
      var lista=(j&&j.products||[]).filter(function(x){ return x.id!==p.id; }).slice(0,4);
      if(!lista.length) return;
      lista.forEach(function(x){ PROD_MAP[x.id]=x; });
      var sec=paginaProduto.el.querySelector('#pdRelacionados');
      var grade=paginaProduto.el.querySelector('#pdRelGrade');
      grade.innerHTML=lista.map(function(x){ return cardHtml(x); }).join('');
      sec.hidden=false;
    })
    .catch(function(){});
}
`;
