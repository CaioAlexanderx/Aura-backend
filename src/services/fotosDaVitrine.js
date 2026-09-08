// ============================================================
// AURA — QUAIS fotos a vitrine mostra (migration 323)
//
// A migration 323 deu ao produto ate 4 fotos por cor (`product_images`,
// `color_hex` null = galeria principal). Quem GRAVA essas fotos e
// services/productImageGallery.js. Quem decide o que a CLIENTE ve na
// pagina do produto e este arquivo — e so isso: nao consulta banco, nao
// desenha HTML, nao sabe o que e um <img>.
//
// ── A CADEIA DE FALLBACK ────────────────────────────────────
//
//   1. cor escolhida e essa cor TEM foto  -> as fotos daquela cor
//   2. cor escolhida e essa cor NAO tem   -> a galeria principal
//   3. nenhuma cor escolhida               -> a galeria principal
//   4. a peca nao tem NENHUMA linha de galeria -> o que a loja mostrava
//      antes da 323: products.image_url + gallery_urls + a foto de cada
//      variante, sem repetir.
//
// O passo 4 nao e cortesia: o catalogo inteiro que existe hoje esta nele.
// A 323 e dual-write (a capa espelha products.image_url), entao uma peca
// so entra nos passos 1-3 depois que a lojista abre o editor de fotos.
// Ate la a pagina tem que continuar exatamente como estava.
//
// ── POR QUE A FONTE E UMA STRING ────────────────────────────
//
// A regra roda nos DOIS lados: no navegador, dentro do <script> da loja
// (templates/storefront/parts/product_detail.js), e no Node, nos testes.
// Serializar com Function.prototype.toString() nao serve — sob cobertura
// o istanbul reescreve a funcao com contadores que so existem no escopo
// do modulo e o navegador quebra com `ReferenceError: cov_1abc is not
// defined`. Mesmo desenho de templates/storefrontCapa.js e de
// services/coresDaLoja.js, pela mesma razao.
//
// TAMANHO: a lista devolvida traz `url` (a foto grande) e `thumb_url` (a
// miniatura da migration 317). Quem desenha usa thumb na miniatura e url
// na foto grande — sem isso a pagina baixa quatro originais de 1600px
// para desenhar quatro quadradinhos de 64px.
// ============================================================
'use strict';

/** O codigo que roda nos DOIS lados. */
const FONTE = `
/** '#abc' e 'abcdef' viram '#aabbcc'; o que nao for hex vira null. */
function hexDaGaleria(v){
  var h = String(v == null ? '' : v).trim();
  if(h.length === 4 && h.charAt(0) === '#') h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if(h.length === 6 && /^[0-9A-Fa-f]{6}$/.test(h)) h = '#' + h;
  return /^#[0-9A-Fa-f]{6}$/.test(h) ? h.toLowerCase() : null;
}

/**
 * A lista de UM par (produto, cor) na ordem de exibicao: a CAPA (position
 * 0) primeiro, depois o resto por position.
 *
 * O servidor ja manda ordenado, mas a ordenacao se repete aqui de
 * proposito: a mesma lista chega por tres caminhos (payload da peca,
 * fetch da galeria, cache do navegador) e um deles perder a ordem
 * significa capa errada — o rosto da peca na tela.
 */
function ordenarFotos(lista){
  var arr = [];
  for(var i = 0; i < (lista ? lista.length : 0); i++){
    var f = lista[i];
    if(f && f.url) arr.push(f);
  }
  arr.sort(function(a, b){
    var pa = Number(a.position), pb = Number(b.position);
    if(!isFinite(pa)) pa = 99;
    if(!isFinite(pb)) pb = 99;
    if(pa !== pb) return pa - pb;
    return String(a.id == null ? '' : a.id).localeCompare(String(b.id == null ? '' : b.id));
  });
  return arr.map(function(f){
    return { url: f.url, thumb_url: f.thumb_url || f.url };
  });
}

/**
 * O que a loja mostrava ANTES da 323: a foto da peca, a galeria antiga
 * (migration 290) e a foto de cada variante, sem repetir URL.
 *
 * A ordem e a mesma de antes de proposito — quem ja vendia com essa lista
 * nao pode ver a peca mudar de capa por causa de um deploy.
 */
function fotosLegado(p){
  var prod = p || {};
  var vistas = {}, fotos = [];
  function juntar(u, t){
    if(!u || vistas[u]) return;
    vistas[u] = 1;
    fotos.push({ url: u, thumb_url: t || u });
  }
  juntar(prod.image_url, prod.thumb_url);
  var antiga = prod.gallery_urls || [];
  for(var i = 0; i < antiga.length; i++) juntar(antiga[i], null);
  var vars = prod.variants || [];
  for(var j = 0; j < vars.length; j++) juntar(vars[j].image_url, vars[j].thumb_url);
  return fotos;
}

/**
 * As fotos que a pagina do produto deve desenhar AGORA.
 *
 * @param p        a peca no formato do payload publico
 * @param corHex   a cor escolhida ('#rrggbb', ou null quando nenhuma)
 * @param galeria  { main: [], by_color: {} } — quando null, usa p.images
 * @returns {{fotos: Array, origem: 'cor'|'principal'|'legado', cor: string|null}}
 */
function fotosDaPeca(p, corHex, galeria){
  var prod = p || {};
  var g = galeria || prod.images || prod.gallery || null;
  var hex = hexDaGaleria(corHex);

  if(g){
    // O indice minusculo e defensivo: a rota normaliza a chave, mas a
    // galeria tambem chega de cache do navegador e de base antiga, onde
    // '#FF0000' e '#ff0000' ja conviveram.
    var porCor = g.by_color || {};
    if(hex){
      var achadas = null;
      for(var k in porCor){
        if(String(k).toLowerCase() === hex){ achadas = porCor[k]; break; }
      }
      var daCor = ordenarFotos(achadas);
      if(daCor.length) return { fotos: daCor, origem: 'cor', cor: hex };
    }
    var principal = ordenarFotos(g.main);
    if(principal.length) return { fotos: principal, origem: 'principal', cor: null };
  }

  return { fotos: fotosLegado(prod), origem: 'legado', cor: hex };
}

/** A galeria tem alguma foto? (decide entre usar o cache e ir buscar) */
function galeriaTemFoto(g){
  if(!g) return false;
  if((g.main || []).length) return true;
  var porCor = g.by_color || {};
  for(var k in porCor){ if((porCor[k] || []).length) return true; }
  return false;
}
`;

// O Node executa a MESMA fonte. Sem isto haveria duas implementacoes e a
// divergencia voltaria pela porta dos fundos.
const api = new Function(
  FONTE + '\nreturn { hexDaGaleria: hexDaGaleria, ordenarFotos: ordenarFotos, '
        + 'fotosLegado: fotosLegado, fotosDaPeca: fotosDaPeca, galeriaTemFoto: galeriaTemFoto };'
)();

module.exports = {
  FONTE,
  hexDaGaleria: api.hexDaGaleria,
  ordenarFotos: api.ordenarFotos,
  fotosLegado: api.fotosLegado,
  fotosDaPeca: api.fotosDaPeca,
  galeriaTemFoto: api.galeriaTemFoto,
};
