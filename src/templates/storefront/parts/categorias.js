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
// [{nome, total}] — vem do banco, nao dos produtos carregados.
var CATEGORIAS = (__S.categorias_barra || []).filter(function(c){
  return c && c.nome && c.total > 0;
});

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

  function chipHtml(c){
    return '<button type="button" class="cat-chip' + (currentCat === c.nome ? ' active' : '') + '" data-cat="' + esc(c.nome) + '">'
      + esc(c.nome) + '<span class="cat-num">' + c.total + '</span></button>';
  }
  function botaoTodas(){
    return '<button type="button" class="cat-todas" id="catTodas" aria-expanded="false">'
      + 'Todas as categorias<span class="cat-num">' + CATEGORIAS.length + '</span></button>';
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

  w.querySelectorAll('.cat-chip').forEach(function(chip){
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

function abrirPainelCats(){
  var painel = document.getElementById('catsPainel');
  if(!painel) return;

  painel.innerHTML =
      '<div class="cats-painel-inner">'
    + '<div class="cats-painel-topo">'
    + '<span class="cats-painel-tit">Todas as categorias</span>'
    + '<button type="button" class="cats-painel-x" id="catsFechar" aria-label="Fechar">&#215;</button>'
    + '</div>'
    + '<div class="cats-painel-grade">'
    + CATEGORIAS.map(function(c){
        return '<button type="button" class="cats-item' + (currentCat === c.nome ? ' sel' : '') + '" data-cat="' + esc(c.nome) + '">'
          + '<span class="cats-item-nome">' + esc(c.nome) + '</span>'
          + '<span class="cats-item-num">' + c.total + '</span></button>';
      }).join('')
    + '</div></div>';

  painel.hidden = false;
  painelCatsAberto = true;
  var btn = document.getElementById('catTodas');
  if(btn){ btn.classList.add('aberto'); btn.setAttribute('aria-expanded','true'); }

  painel.querySelectorAll('.cats-item').forEach(function(item){
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
