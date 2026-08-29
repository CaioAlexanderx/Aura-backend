// AURA. -- storefront/parts/categorias.js
//
// A barra de categorias.
//
// Antes era uma fila de chips derivada de PRODUCTS, com rolagem
// horizontal. Dois problemas:
//
//  1. Com paginacao de 24 produtos, a lista passou a mostrar so as
//     categorias que caiam na pagina 1. A Finesse tem 28 categorias e
//     mostrava 11.
//  2. Mesmo completa, 28 chips em fila rolante e uma parede: quem entra
//     nao ve o que a loja tem, ve o comeco do alfabeto.
//
// Agora: as categorias que CABEM ficam na barra, ordenadas por tamanho
// (a maior primeiro — e a que mais gente procura), e um botao abre o
// painel com todas, em colunas e com a contagem de cada uma.
'use strict';

module.exports = `
// ── Arvore ou lista plana ────────────────────────────────
//
// A loja com arvore povoada manda categorias_arvore
// ([{nome, slug, path, depth, pai_slug, total}]); a que nao tem manda a
// lista plana de sempre. As duas viram a MESMA estrutura aqui, com um
// campo "caminho" que e o que o filtro usa.
//
// Na Finesse a diferenca e concreta: 12 folhas soltas ("Vestido Midi
// Festa", "Vestido longo de Festa", "Vestido Festa"...) viram 4 entradas
// de topo, e Vestidos abre em Festa e Casual.
var ARVORE = (__S.categorias_arvore || []).filter(function(c){
  return c && c.nome && c.total > 0;
}).map(function(c){
  return { nome:c.nome, total:c.total, caminho:c.path, slug:c.slug,
           nivel:c.depth, pai:c.pai_slug || null };
});

var TEM_ARVORE = ARVORE.length > 0;

// Sem arvore, a lista plana de sempre — o caminho vira o proprio nome,
// que e o que o filtro por texto ja esperava.
var CATEGORIAS = TEM_ARVORE
  ? ARVORE.filter(function(c){ return c.nivel === 0; })
  : (__S.categorias_barra || []).filter(function(c){
      return c && c.nome && c.total > 0;
    }).map(function(c){
      return { nome:c.nome, total:c.total, caminho:c.nome, slug:null, nivel:0, pai:null };
    });

/**
 * O nome legivel de um caminho.
 *
 * currentCat passou a guardar caminho ("/vestidos/festa"), e o titulo da
 * grade mostra nome ("Festa"). Sem isto o cabecalho viraria endereco.
 */
function nomeDoCaminho(caminho){
  if(!caminho || caminho === 'Todos') return caminho;
  for(var i=0;i<ARVORE.length;i++){ if(ARVORE[i].caminho === caminho) return ARVORE[i].nome; }
  // Loja sem arvore: o caminho JA e o nome.
  return caminho;
}

/**
 * O caminho atual esta DENTRO deste no?
 *
 * Sem isto, escolher "Festa" apagava o destaque de "Vestidos" na barra de
 * topo e a pessoa perdia a nocao de onde esta — a segunda linha dizia
 * "Festa" e a primeira nao dizia nada. Casar so o caminho exato marca o
 * no clicado; casar o prefixo marca o ramo inteiro, que e o que a pessoa
 * enxerga como "estou em Vestidos".
 */
function dentroDe(caminho){
  if(!caminho || !currentCat || currentCat === 'Todos') return false;
  return currentCat === caminho || currentCat.indexOf(caminho + '/') === 0;
}

/** Filhas diretas de um no, na ordem que o servidor mandou. */
function filhasDe(slug){
  if(!TEM_ARVORE || !slug) return [];
  return ARVORE.filter(function(c){ return c.pai === slug; });
}

/** O no da categoria aberta agora, se houver. */
function noAtual(){
  if(!TEM_ARVORE || !currentCat || currentCat === 'Todos') return null;
  for(var i=0;i<ARVORE.length;i++){ if(ARVORE[i].caminho === currentCat) return ARVORE[i]; }
  return null;
}

/**
 * A linha de subcategorias, quando ha o que mostrar.
 *
 * Aparece com a filha selecionada tambem — senao escolher "Festa" faria
 * as irmas sumirem, e trocar de subcategoria exigiria voltar ao topo.
 */
function ramoAberto(){
  var no = noAtual();
  if(!no) return null;
  var filhas = filhasDe(no.slug);
  if(filhas.length) return { pai:no, filhas:filhas };
  // Numa folha, mostra as IRMAS: e onde a pessoa esta comparando.
  if(no.pai){
    var irmas = filhasDe(no.pai);
    if(irmas.length > 1){
      for(var i=0;i<ARVORE.length;i++){
        if(ARVORE[i].slug === no.pai) return { pai:ARVORE[i], filhas:irmas };
      }
    }
  }
  return null;
}

var painelCatsAberto = false;

/**
 * Onde parar de mostrar categoria na barra.
 *
 * Era estimativa: 150px por chip. Estimativa so funciona enquanto o chip
 * tem tamanho previsivel — quando ele perdeu a caixa e virou texto puro,
 * 150px passou a sobrar muito, e "Todas as categorias" caiu pra uma
 * segunda linha com a barra meio vazia.
 *
 * Agora MEDE. Desenha tudo, pergunta ao layout se coube numa linha so, e
 * tira do fim ate caber. E o unico jeito que nao depende do tamanho da
 * fonte, do comprimento dos nomes nem do idioma. O custo e um reflow por
 * chip removido, num elemento com uma duzia de filhos — imperceptivel, e
 * so acontece no primeiro desenho e no resize.
 */
var MINIMO_NA_BARRA = 3;

function passouDeUmaLinha(w){
  var f = w.firstElementChild, l = w.lastElementChild;
  if(!f || f === l) return false;
  // Dois filhos com offsetTop diferente = o flex-wrap quebrou a linha.
  return l.offsetTop > f.offsetTop;
}

function renderCategorias(){
  var w = document.getElementById('catsWrap');
  if(!w) return;

  // O ramo aberto e desenhado numa SEGUNDA linha, nao dentro da primeira:
  // misturar pai e filha na mesma fila apaga a diferenca de nivel, que e
  // justamente o que a arvore veio mostrar.
  var ramo = ramoAberto();

  function chipHtml(c){
    // A comparacao e por CAMINHO, nao por nome: com arvore ha "Festa" sob
    // Vestidos e podera haver "Festa" sob Blusas — pelo nome, as duas
    // acenderiam juntas.
    return '<button type="button" class="cat-chip' + (dentroDe(c.caminho) ? ' active' : '') + '"'
      + ' data-cat="' + esc(c.caminho) + '">'
      + esc(c.nome) + '<span class="cat-num">' + c.total + '</span></button>';
  }
  function subChipHtml(c){
    return '<button type="button" class="cat-sub' + (currentCat === c.caminho ? ' active' : '') + '"'
      + ' data-cat="' + esc(c.caminho) + '">'
      + esc(c.nome) + '<span class="cat-num">' + c.total + '</span></button>';
  }
  function botaoTodas(){
    return '<button type="button" class="cat-todas" id="catTodas" aria-expanded="false">'
      + 'Todas as categorias<span class="cat-num">' + (TEM_ARVORE ? ARVORE.length : CATEGORIAS.length) + '</span></button>';
  }
  var todos = '<button type="button" class="cat-chip' + (currentCat === 'Todos' ? ' active' : '') + '" data-cat="Todos">Todos</button>';

  function desenhar(quantas){
    var sobra = CATEGORIAS.length - quantas;
    w.innerHTML = todos
      + CATEGORIAS.slice(0, quantas).map(chipHtml).join('')
      // O botao so aparece quando ha o que ele revelar.
      + (sobra > 0 ? botaoTodas() : '');
  }

  var quantas = CATEGORIAS.length;
  desenhar(quantas);
  // Tira uma por vez ate caber. O piso existe pra que uma janela muito
  // estreita mostre alguma categoria em vez de so o botao "Todas".
  while(quantas > MINIMO_NA_BARRA && passouDeUmaLinha(w)){
    quantas--;
    desenhar(quantas);
  }

  // A segunda linha entra DEPOIS da medicao: ela nao disputa espaco com a
  // primeira, e conta-la no laco faria a barra encolher sem motivo.
  var sub = document.getElementById('catsSub');
  if(sub){
    if(ramo){
      sub.hidden = false;
      sub.innerHTML = '<button type="button" class="cat-sub' + (currentCat === ramo.pai.caminho ? ' active' : '') + '"'
        + ' data-cat="' + esc(ramo.pai.caminho) + '">Tudo em ' + esc(ramo.pai.nome) + '</button>'
        + ramo.filhas.map(subChipHtml).join('');
    } else {
      sub.hidden = true;
      sub.innerHTML = '';
    }
  }

  var todosOsChips = [].concat(
    [].slice.call(w.querySelectorAll('.cat-chip')),
    sub ? [].slice.call(sub.querySelectorAll('.cat-sub')) : []
  );
  todosOsChips.forEach(function(chip){
    chip.addEventListener('click', function(){
      fecharPainelCats();
      filterCat(chip.dataset.cat, chip);
    });
  });

  var btn = w.querySelector('#catTodas');
  if(btn) btn.addEventListener('click', function(e){ e.stopPropagation(); alternarPainelCats(); });
}

function alternarPainelCats(){
  if(painelCatsAberto) fecharPainelCats(); else abrirPainelCats();
}

/**
 * O painel como MAPA: uma coluna por ramo de topo.
 *
 * Ramo sem filhas (Bolsa, Cinto, Cropped) vira uma coluna de um item so —
 * de proposito. Junta-los numa coluna "outros" esconderia justamente as
 * categorias que a lojista ainda nao organizou.
 */
function ramosHtml(){
  return CATEGORIAS.map(function(topo){
    var filhas = filhasDe(topo.slug);
    return '<div class="cats-ramo">'
      + '<button type="button" class="cats-ramo-topo' + (currentCat === topo.caminho ? ' sel' : '') + '"'
      + ' data-cat="' + esc(topo.caminho) + '">'
      + esc(topo.nome) + '<span class="cats-item-num">' + topo.total + '</span></button>'
      + filhas.map(function(f){
          return '<button type="button" class="cats-item' + (currentCat === f.caminho ? ' sel' : '') + '"'
            + ' data-cat="' + esc(f.caminho) + '">'
            + '<span class="cats-item-nome">' + esc(f.nome) + '</span>'
            + '<span class="cats-item-num">' + f.total + '</span></button>';
        }).join('')
      + '</div>';
  }).join('');
}

function abrirPainelCats(){
  var painel = document.getElementById('catsPainel');
  if(!painel) return;

  painel.innerHTML =
      '<div class="cats-painel-inner">'
    + '<div class="cats-painel-topo">'
    + '<span class="cats-painel-tit">Todas as categorias</span>'
    + '<button type="button" class="cats-painel-x" id="catsFechar" aria-label="Fechar">&#215;</button>'
    + '</div>'
    // Com arvore o painel vira o mapa da loja: cada coluna e um ramo, com
    // o topo em destaque e as filhas embaixo. E o padrao do varejo grande,
    // e e a unica tela onde a organizacao inteira aparece de uma vez.
    //
    // Sem arvore, a grade plana de sempre.
    + (TEM_ARVORE ? '<div class="cats-painel-ramos">' + ramosHtml() + '</div>'
      : '<div class="cats-painel-grade">'
        + CATEGORIAS.map(function(c){
            return '<button type="button" class="cats-item' + (currentCat === c.caminho ? ' sel' : '') + '" data-cat="' + esc(c.caminho) + '">'
              + '<span class="cats-item-nome">' + esc(c.nome) + '</span>'
              + '<span class="cats-item-num">' + c.total + '</span></button>';
          }).join('')
        + '</div>')
    + '</div>';

  painel.hidden = false;
  painelCatsAberto = true;
  var btn = document.getElementById('catTodas');
  if(btn){ btn.classList.add('aberto'); btn.setAttribute('aria-expanded','true'); }

  painel.querySelectorAll('.cats-item, .cats-ramo-topo').forEach(function(item){
    item.addEventListener('click', function(){
      fecharPainelCats();
      filterCat(item.dataset.cat, null);
    });
  });
  var x = painel.querySelector('#catsFechar');
  if(x) x.addEventListener('click', fecharPainelCats);
}

function fecharPainelCats(){
  var painel = document.getElementById('catsPainel');
  if(painel){ painel.hidden = true; painel.innerHTML = ''; }
  painelCatsAberto = false;
  var btn = document.getElementById('catTodas');
  if(btn){ btn.classList.remove('aberto'); btn.setAttribute('aria-expanded','false'); }
}

// Clicar fora e Esc fecham — o painel cobre a grade, e ficar preso nele
// e o tipo de coisa que faz a pessoa recarregar a pagina.
document.addEventListener('click', function(e){
  if(!painelCatsAberto) return;
  var painel = document.getElementById('catsPainel');
  if(painel && !painel.contains(e.target)) fecharPainelCats();
});
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape' && painelCatsAberto) fecharPainelCats();
});

// A quantidade que cabe muda com a largura da janela. Agrupado num frame
// porque agora cada render mede o layout: resize dispara dezenas de vezes
// por segundo e nao ha motivo pra remedir mais de uma vez por quadro.
var reagendado = false;
window.addEventListener('resize', function(){
  if(painelCatsAberto) fecharPainelCats();
  if(reagendado) return;
  reagendado = true;
  requestAnimationFrame(function(){ reagendado = false; renderCategorias(); });
});

// A medida so vale depois que a fonte da loja carregou. O primeiro desenho
// acontece na fonte de fallback; quando a real entra, os nomes mudam de
// largura e a barra pode passar a quebrar sem que ninguem tenha
// redimensionado nada. Este e o unico jeito de saber a hora certa.
if(document.fonts && document.fonts.ready && document.fonts.ready.then){
  document.fonts.ready.then(function(){ renderCategorias(); });
}
`;
