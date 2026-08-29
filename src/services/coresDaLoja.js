// ============================================================
// AURA — nomear cor, e agrupar cor em família.
//
// POR QUE ISTO EXISTE. A lojista grava cor como HEX: a Finesse tem 151
// valores distintos, todos `#RRGGBB`. Isso funciona no seletor da página
// do produto, onde a bolinha mostra a cor. Não funciona num FILTRO: 151
// amostras não é filtro, é outra grade de produtos.
//
// Agrupando por família — o tom nomeado mais próximo — os 151 viram cerca
// de vinte entradas que a pessoa reconhece: Preto, Vinho, Rosa, Bege.
//
// A LÓGICA MORA AQUI E NÃO NO TEMPLATE porque agora ela roda nos dois
// lados: o servidor monta as facetas, o cliente desenha o seletor de cor
// da página do produto. Duas cópias divergiriam — e cor com nome errado
// de um lado só é o tipo de bug que ninguém nota até a cliente reclamar.
//
// A FONTE É UMA STRING LITERAL, não uma função serializada com
// toString(). Sob cobertura, o istanbul instrumenta a função com
// contadores de módulo (`cov_1abc`) e o código serializado quebra no
// navegador com ReferenceError. Isso já derrubou um PR — ver
// __tests__/coresDaLoja.test.js.
// ============================================================
'use strict';

/**
 * O código que vai para o navegador, como texto.
 *
 * Também é o que este módulo executa no servidor (via `new Function`
 * abaixo), então não há como as duas pontas divergirem.
 */
const FONTE = `
var CORES_PT = {
  'preto':'#111111','branco':'#FFFFFF','off white':'#F3EFE7','cru':'#EFE7D8',
  'bege':'#E4D5BE','nude':'#E3C4AE','marrom':'#6B4A2F','caramelo':'#A9682F',
  'camel':'#B8895A','cinza':'#9AA0A6','chumbo':'#4A4F55','prata':'#C9CCD1',
  'dourado':'#C8A24A','vermelho':'#D32F2F','vinho':'#6E1F2B','marsala':'#8A3A44',
  'bordo':'#5C1A26','rosa':'#E8879B','rosa claro':'#F3C0CB','pink':'#E0398B',
  'magenta':'#C2185B','coral':'#F0765B','laranja':'#EF6C1A','amarelo':'#F2C230',
  'mostarda':'#C9A227','verde':'#2E7D4F','verde militar':'#4B5320',
  'verde agua':'#7FD1C1','oliva':'#6B7A3A','menta':'#A8DEC8','azul':'#1F5FBF',
  'azul marinho':'#1B2A4A','azul claro':'#8FC1E3','jeans':'#4A6D8C',
  'turquesa':'#22A6A6','roxo':'#6D28D9','lilas':'#B79CE0','violeta':'#7C3AED',
  'ciano':'#06B6D4','salmao':'#FA8072','terracota':'#B5533C','grafite':'#3A3F44',
  'creme':'#F5EBDC','tabaco':'#6F4E37','petroleo':'#0F4C5C','uva':'#5B2C6F',
  'ferrugem':'#B7410E'
};

/** '#abc' -> '#aabbcc'; devolve null se nao for hex. */
function normalizarHex(v){
  var h = String(v == null ? '' : v).trim();
  if(h.length === 4 && h.charAt(0) === '#'){
    h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  }
  return /^#[0-9A-Fa-f]{6}$/.test(h) ? h.toUpperCase() : null;
}

/**
 * O nome do tom mais proximo, ou null se nenhum chegar perto.
 *
 * A distancia tem peso perceptual: o olho enxerga mais verde que azul, e
 * uma distancia euclidiana crua batizaria de "azul" coisa que ninguem
 * chamaria assim. O teto de 110 existe pra que um tom exotico fique sem
 * nome em vez de ganhar o nome errado.
 */
function nomeDaCor(hex){
  var h = normalizarHex(hex);
  if(!h) return null;
  var r = parseInt(h.slice(1,3),16), g = parseInt(h.slice(3,5),16), b = parseInt(h.slice(5,7),16);
  var melhor = null, menor = Infinity;
  for(var nome in CORES_PT){
    var c = CORES_PT[nome];
    var cr = parseInt(c.slice(1,3),16), cg = parseInt(c.slice(3,5),16), cb = parseInt(c.slice(5,7),16);
    var d = Math.sqrt(2*(r-cr)*(r-cr) + 4*(g-cg)*(g-cg) + 3*(b-cb)*(b-cb));
    if(d < menor){ menor = d; melhor = nome; }
  }
  if(menor > 110) return null;
  return melhor;
}

/** Nome com inicial maiuscula, pra mostrar. */
function rotuloDaCor(hex){
  var n = nomeDaCor(hex);
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : null;
}

/** O valor que a lojista escreveu vira hex: aceita '#hex' ou 'Preto'. */
function corDoValor(val){
  var h = normalizarHex(val);
  if(h) return h;
  var chave = String(val == null ? '' : val).trim().toLowerCase()
    .normalize('NFD')
    .split('').filter(function(c){ var k = c.charCodeAt(0); return k < 0x300 || k > 0x36f; }).join('');
  return CORES_PT[chave] || null;
}
`;

// O servidor executa a MESMA fonte. Sem `new Function` haveria duas
// implementações e a divergência voltaria pela porta dos fundos.
const api = new Function(
  FONTE + '\nreturn { CORES_PT: CORES_PT, nomeDaCor: nomeDaCor, rotuloDaCor: rotuloDaCor, corDoValor: corDoValor, normalizarHex: normalizarHex };',
)();

/**
 * Agrupa valores de cor em famílias, somando o que cada uma tem.
 *
 * @param linhas [{ value, total }] como vêm do banco
 * @returns [{ familia, rotulo, hex, total }] — `hex` é o tom mais comum
 *          da família, para desenhar a amostra com uma cor real da loja
 *          em vez do tom teórico da tabela.
 */
function agruparPorFamilia(linhas) {
  const mapa = new Map();
  for (const l of linhas || []) {
    const hex = api.normalizarHex(l.value);
    if (!hex) continue;
    const familia = api.nomeDaCor(hex);
    // Sem nome, a cor vira família dela mesma: some do agrupamento mas
    // não some da loja. Esconder produto por causa de um tom exótico
    // seria pior que uma entrada a mais no filtro.
    const chave = familia || hex;
    const total = Number(l.total) || 0;
    const atual = mapa.get(chave);
    if (atual) {
      atual.total += total;
      // O hex representativo é o do tom com mais peças.
      if (total > atual.pico) { atual.pico = total; atual.hex = hex; }
      atual.valores.push(hex);
    } else {
      mapa.set(chave, {
        familia: chave,
        rotulo: familia ? api.rotuloDaCor(hex) : hex,
        hex,
        total,
        pico: total,
        valores: [hex],
      });
    }
  }
  return [...mapa.values()]
    .sort((a, b) => b.total - a.total || a.rotulo.localeCompare(b.rotulo))
    .map(({ familia, rotulo, hex, total, valores }) => ({ familia, rotulo, hex, total, valores }));
}

module.exports = {
  FONTE,
  ...api,
  agruparPorFamilia,
};
