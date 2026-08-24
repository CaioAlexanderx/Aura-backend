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
 * Quantas cabem na barra sem virar rolagem.
 *
 * Estimativa por largura media do chip — medir cada um exigiria desenhar
 * antes, e a barra apareceria montando. Erra pra menos de proposito: e
 * melhor sobrar espaco do que estourar.
 */
function cabemNaBarra(){
  var largura = Math.min(window.innerWidth || 1024, 1280) - 40;
  if(largura < 640) return 4;
  return Math.max(4, Math.floor(largura / 150) - 1);
}

function renderCategorias(){
  var w = document.getElementById('catsWrap');
  if(!w) return;

  var naBarra = CATEGORIAS.slice(0, cabemNaBarra());
  var sobra = CATEGORIAS.length - naBarra.length;

  var chips = '<button type="button" class="cat-chip' + (currentCat === 'Todos' ? ' active' : '') + '" data-cat="Todos">Todos</button>';
  chips += naBarra.map(function(c){
    return '<button type="button" class="cat-chip' + (currentCat === c.nome ? ' active' : '') + '" data-cat="' + esc(c.nome) + '">'
      + esc(c.nome) + '<span class="cat-num">' + c.total + '</span></button>';
  }).join('');

  // O botao so aparece quando ha o que ele revelar.
  if(sobra > 0){
    chips += '<button type="button" class="cat-todas" id="catTodas" aria-expanded="false">'
      + 'Todas as categorias<span class="cat-num">' + CATEGORIAS.length + '</span></button>';
  }

  w.innerHTML = chips;

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

// A quantidade que cabe muda com a largura da janela.
window.addEventListener('resize', function(){
  if(painelCatsAberto) fecharPainelCats();
  renderCategorias();
});
`;
