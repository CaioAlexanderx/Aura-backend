// AURA. -- storefront/parts/filtros.js
//
// Filtrar por tamanho, cor e preco — a lateral da pagina de categoria.
//
// REESCRITO em 02/09/2026 (fase 4 do redesign). Antes era um botao
// "Filtrar" acima da grade que abria um painel; agora e a coluna da
// esquerda do design (230px, fixa ao rolar), com tres grupos: Tamanho em
// chips, Cor em lista com amostra e contagem, Preco em faixas. No celular
// a coluna vira uma folha que sobe do rodape, aberta pelo botao "Filtrar".
//
// TUDO E SERVIDOR. Com paginacao de 24, filtrar o que esta carregado
// esconderia resultado — mesma razao da busca e da ordenacao. As faixas de
// preco nascem de facetas.preco (menor e maior preco da loja), pela regra
// de services/faixasDePreco.js, que chega serializada.
'use strict';

module.exports = `
// {cor:[{familia,rotulo,hex,total}], tamanho:[{rotulo,total}], preco:{min,max}|null}
var FACETAS = __S.facetas || {};
var tamSel = [], corSel = [], precoSel = null;
var folhaDeFiltrosAberta = false;

var FAIXAS = (FACETAS.preco && typeof faixasDePreco==='function')
  ? faixasDePreco(FACETAS.preco.min, FACETAS.preco.max) : [];

/**
 * As opcoes do filtro passam a ser as da CATEGORIA aberta.
 *
 * Antes vinham da loja inteira e nunca mudavam: numa loja de calcado isso
 * punha 40 chips de numeracao (17 ao 44, mais 95/100/110 que sao de
 * cinto) dentro de "Infantil > Botas", onde so existe do 17 ao 36.
 *
 * Devolve true quando alguma selecao caiu fora da categoria nova — quem
 * chamou refaz a busca, senao a grade continuaria filtrada por um chip
 * que nao existe mais na lateral.
 */
function atualizarFacetas(novas){
  if(!novas) return false;  // consulta falhou: fica com as opcoes que tinha
  FACETAS = novas;
  FAIXAS = (FACETAS.preco && typeof faixasDePreco==='function')
    ? faixasDePreco(FACETAS.preco.min, FACETAS.preco.max) : [];
  var antes = tamSel.length + corSel.length + (precoSel!=null?1:0);
  var tams = (FACETAS.tamanho||[]).map(function(t){ return t.rotulo; });
  var fams = (FACETAS.cor||[]).map(function(c){ return c.familia; });
  tamSel = tamSel.filter(function(r){ return tams.indexOf(r) >= 0; });
  corSel = corSel.filter(function(f){ return fams.indexOf(f) >= 0; });
  if(precoSel!=null && !FAIXAS[precoSel]) precoSel = null;
  renderFiltros();
  return (tamSel.length + corSel.length + (precoSel!=null?1:0)) < antes;
}

function temFacetas(){
  return (FACETAS.tamanho && FACETAS.tamanho.length > 1)
      || (FACETAS.cor && FACETAS.cor.length > 1)
      || FAIXAS.length > 1;
}

/** Os parametros que a rota espera — rotulos, nao valores gravados. */
function paramsDeFiltro(){
  var q = [];
  if(tamSel.length) q.push('tam=' + encodeURIComponent(tamSel.join(',')));
  if(corSel.length) q.push('cor=' + encodeURIComponent(corSel.join(',')));
  if(precoSel){
    var f = FAIXAS[precoSel - 1];
    if(f){
      if(f.min != null) q.push('preco_min=' + f.min);
      if(f.max != null) q.push('preco_max=' + f.max);
    }
  }
  return q;
}

function alternar(lista, valor){
  var i = lista.indexOf(valor);
  if(i >= 0) lista.splice(i, 1); else lista.push(valor);
}

/** @param opts.semRecarregar quem chama vai recarregar por conta propria. */
function limparFiltros(opts){
  tamSel = []; corSel = []; precoSel = null;
  renderFiltros();
  if(!(opts && opts.semRecarregar)) recarregarDoInicio();
}

/** Quantos filtros estao ligados — vira o numero no botao do celular. */
function contarFiltros(){ return tamSel.length + corSel.length + (precoSel ? 1 : 0); }

function abrirFolhaDeFiltros(){ folhaDeFiltrosAberta = true; renderFiltros(); document.body.style.overflow='hidden'; }
function fecharFolhaDeFiltros(){ folhaDeFiltrosAberta = false; renderFiltros(); document.body.style.overflow=''; }

function renderFiltros(){
  var caixa = document.getElementById('filtrosWrap');
  if(!caixa) return;
  if(!temFacetas()){ caixa.hidden = true; caixa.classList.remove('aberto'); return; }
  caixa.hidden = false;
  caixa.classList.toggle('aberto', folhaDeFiltrosAberta);

  var n = contarFiltros();
  var blocos = '';

  if(FACETAS.tamanho && FACETAS.tamanho.length > 1){
    blocos += '<div class="filtro-grupo"><div class="sf-label">Tamanho</div><div class="filtro-ops">'
      + FACETAS.tamanho.map(function(t){
          var on = tamSel.indexOf(t.rotulo) >= 0;
          return '<button type="button" class="filtro-op' + (on ? ' on' : '') + '"'
            + ' data-op="tam" data-val="' + esc(t.rotulo) + '" aria-pressed="' + (on?'true':'false') + '">'
            + esc(t.rotulo) + '</button>';
        }).join('')
      + '</div></div>';
  }

  if(FACETAS.cor && FACETAS.cor.length > 1){
    blocos += '<div class="filtro-grupo"><div class="sf-label">Cor</div><div class="filtro-lista">'
      + FACETAS.cor.map(function(c){
          var on = corSel.indexOf(c.familia) >= 0;
          // Bolinha COM o nome ao lado: a bolinha sozinha exclui quem nao
          // distingue tons proximos, e "Vinho" e "Bordô" viram a mesma
          // mancha escura numa fila de amostras.
          return '<button type="button" class="filtro-linha' + (on ? ' on' : '') + '"'
            + ' data-op="cor" data-val="' + esc(c.familia) + '" aria-pressed="' + (on?'true':'false') + '">'
            + '<span class="filtro-bola" style="background:' + esc(c.hex) + '"></span>'
            + '<span class="filtro-linha-nome">' + esc(c.rotulo) + '</span>'
            + '<span class="mono filtro-linha-n">' + c.total + '</span></button>';
        }).join('')
      + '</div></div>';
  }

  if(FAIXAS.length > 1){
    blocos += '<div class="filtro-grupo"><div class="sf-label">Preço</div><div class="filtro-lista">'
      + FAIXAS.map(function(f, i){
          var on = precoSel === (i + 1);
          return '<button type="button" class="filtro-linha' + (on ? ' on' : '') + '"'
            + ' data-op="preco" data-val="' + (i + 1) + '" aria-pressed="' + (on?'true':'false') + '">'
            + '<span class="filtro-caixa" aria-hidden="true"></span>'
            + '<span class="filtro-linha-nome">' + esc(f.rotulo) + '</span></button>';
        }).join('')
      + '</div></div>';
  }

  var limpar = n ? '<button type="button" class="filtro-limpar" id="filtroLimpar">Limpar filtros</button>' : '';

  caixa.innerHTML =
      '<div class="filtro-topo"><span class="filtro-topo-tit">Filtrar' + (n ? ' <span class="mono filtro-n">' + n + '</span>' : '') + '</span>'
    + '<button type="button" class="filtro-fechar" onclick="fecharFolhaDeFiltros()" aria-label="Fechar filtros">&#215;</button></div>'
    + blocos + limpar
    + '<button type="button" class="filtro-aplicar" onclick="fecharFolhaDeFiltros()">Ver resultados</button>';

  var l = document.getElementById('filtroLimpar');
  if(l) l.addEventListener('click', function(){ limparFiltros(); });

  caixa.querySelectorAll('[data-op]').forEach(function(op){
    op.addEventListener('click', function(){
      if(op.dataset.op === 'preco'){
        var v = Number(op.dataset.val);
        precoSel = (precoSel === v) ? null : v;
      } else {
        alternar(op.dataset.op === 'tam' ? tamSel : corSel, op.dataset.val);
      }
      renderFiltros(); recarregarDoInicio();
    });
  });

  // O botao "Filtrar" do celular fica na barra da grade, nao na coluna.
  var btn = document.getElementById('filtroBtnMobile');
  if(btn){
    btn.hidden = false;
    btn.innerHTML = 'Filtrar' + (n ? '<span class="mono filtro-n">' + n + '</span>' : '');
  }
}
`;
