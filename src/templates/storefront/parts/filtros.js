// AURA. -- storefront/parts/filtros.js
//
// Filtrar por tamanho e cor.
//
// A loja só filtrava por categoria. Quem entrava procurando "vestido
// preto tamanho M" precisava abrir peça por peça — e o dado já estava lá:
// na Finesse, Cor em 81 das 112 peças visíveis e Tamanho em 64.
//
// COMO ISTO DIFERE DA BARRA DE CATEGORIAS. Categoria é uma escolha só e
// mora no topo, porque é por onde a pessoa entra. Tamanho e cor são
// muitas escolhas ao mesmo tempo e moram acima da grade, porque são o
// refino de quem já está olhando. Misturar os dois numa barra só faria a
// pessoa procurar a categoria dentro de uma parede de bolinhas.
//
// TUDO É SERVIDOR. Com paginação de 24, filtrar o que está carregado
// esconderia resultado — mesma razão da busca e da ordenação.
'use strict';

module.exports = `
// {cor:[{familia,rotulo,hex,total}], tamanho:[{rotulo,total}]}
var FACETAS = __S.facetas || {};
var tamSel = [], corSel = [];
var filtrosAbertos = false;

function temFacetas(){
  return (FACETAS.tamanho && FACETAS.tamanho.length > 1)
      || (FACETAS.cor && FACETAS.cor.length > 1);
}

/** Os parametros que a rota espera — rotulos, nao valores gravados. */
function paramsDeFiltro(){
  var q = [];
  if(tamSel.length) q.push('tam=' + encodeURIComponent(tamSel.join(',')));
  if(corSel.length) q.push('cor=' + encodeURIComponent(corSel.join(',')));
  return q;
}

function alternar(lista, valor){
  var i = lista.indexOf(valor);
  if(i >= 0) lista.splice(i, 1); else lista.push(valor);
}

function limparFiltros(){
  tamSel = []; corSel = [];
  renderFiltros(); recarregarDoInicio();
}

/**
 * Quantos filtros estao ligados. Vira o numero no botao — sem ele, a
 * pessoa que rolou a pagina nao sabe que a grade esta filtrada e acha
 * que a loja tem menos peca do que tem.
 */
function contarFiltros(){ return tamSel.length + corSel.length; }

function renderFiltros(){
  var caixa = document.getElementById('filtrosWrap');
  if(!caixa) return;
  if(!temFacetas()){ caixa.hidden = true; return; }
  caixa.hidden = false;

  var n = contarFiltros();
  var botao = '<button type="button" class="filtro-btn' + (filtrosAbertos ? ' aberto' : '') + '"'
    + ' id="filtroBtn" aria-expanded="' + (filtrosAbertos ? 'true' : 'false') + '">'
    + 'Filtrar'
    + (n ? '<span class="filtro-n">' + n + '</span>' : '')
    + '</button>';

  // As selecionadas viram fichas ao lado do botao, cada uma removivel.
  // Sem isso, fechar o painel esconde o que esta filtrando.
  var fichas = tamSel.map(function(t){
    return '<button type="button" class="filtro-ficha" data-tipo="tam" data-val="' + esc(t) + '">'
      + esc(t) + '<span class="filtro-x">&#215;</span></button>';
  }).concat(corSel.map(function(c){
    var f = (FACETAS.cor || []).filter(function(x){ return x.familia === c; })[0];
    return '<button type="button" class="filtro-ficha" data-tipo="cor" data-val="' + esc(c) + '">'
      + (f ? '<span class="filtro-bola" style="background:' + esc(f.hex) + '"></span>' : '')
      + esc(f ? f.rotulo : c) + '<span class="filtro-x">&#215;</span></button>';
  })).join('');

  var limpar = n ? '<button type="button" class="filtro-limpar" id="filtroLimpar">Limpar</button>' : '';

  caixa.innerHTML = botao + fichas + limpar + painelDeFiltros();

  var b = document.getElementById('filtroBtn');
  if(b) b.addEventListener('click', function(){ filtrosAbertos = !filtrosAbertos; renderFiltros(); });

  var l = document.getElementById('filtroLimpar');
  if(l) l.addEventListener('click', limparFiltros);

  caixa.querySelectorAll('.filtro-ficha').forEach(function(f){
    f.addEventListener('click', function(){
      alternar(f.dataset.tipo === 'tam' ? tamSel : corSel, f.dataset.val);
      renderFiltros(); recarregarDoInicio();
    });
  });

  caixa.querySelectorAll('[data-op]').forEach(function(op){
    op.addEventListener('click', function(){
      alternar(op.dataset.op === 'tam' ? tamSel : corSel, op.dataset.val);
      renderFiltros(); recarregarDoInicio();
    });
  });
}

function painelDeFiltros(){
  if(!filtrosAbertos) return '';

  var blocos = '';

  if(FACETAS.tamanho && FACETAS.tamanho.length > 1){
    blocos += '<div class="filtro-grupo"><div class="filtro-tit">Tamanho</div><div class="filtro-ops">'
      + FACETAS.tamanho.map(function(t){
          var on = tamSel.indexOf(t.rotulo) >= 0;
          return '<button type="button" class="filtro-op' + (on ? ' on' : '') + '"'
            + ' data-op="tam" data-val="' + esc(t.rotulo) + '">'
            + esc(t.rotulo) + '<span class="filtro-op-n">' + t.total + '</span></button>';
        }).join('')
      + '</div></div>';
  }

  if(FACETAS.cor && FACETAS.cor.length > 1){
    blocos += '<div class="filtro-grupo"><div class="filtro-tit">Cor</div><div class="filtro-ops">'
      + FACETAS.cor.map(function(c){
          var on = corSel.indexOf(c.familia) >= 0;
          // Bolinha COM o nome ao lado: a bolinha sozinha exclui quem nao
          // distingue tons proximos, e "Vinho" e "Bordô" viram a mesma
          // mancha escura numa fila de amostras.
          return '<button type="button" class="filtro-op filtro-op-cor' + (on ? ' on' : '') + '"'
            + ' data-op="cor" data-val="' + esc(c.familia) + '">'
            + '<span class="filtro-bola" style="background:' + esc(c.hex) + '"></span>'
            + esc(c.rotulo) + '<span class="filtro-op-n">' + c.total + '</span></button>';
        }).join('')
      + '</div></div>';
  }

  return '<div class="filtro-painel">' + blocos + '</div>';
}
`;
