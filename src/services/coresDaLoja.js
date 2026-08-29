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


// ── Famílias, para o FILTRO ──────────────────────────────
//
// São duas necessidades diferentes do mesmo dado, e tratá-las como uma só
// produziu um filtro ruim em produção: 30 entradas, seis delas mostrando
// hex cru porque nenhum tom da tabela chegou perto — inclusive vermelho
// puro (#FF0000) e verde (#22C55E). E catorze famílias com UMA peça.
//
//   Nomear um swatch na página do produto pede PRECISÃO: "Marsala" diz
//   mais que "Vermelho", e ali há espaço para um nome só.
//
//   Agrupar um filtro pede o CONTRÁRIO. Quem procura vestido não filtra
//   por marsala — filtra por vermelho, e espera achar o marsala dentro.
//
// Por isso o mapa do filtro é curto: treze baldes que uma pessoa usa para
// procurar roupa. E sem teto de distância — no filtro, um balde
// aproximado é sempre melhor que um código hexadecimal na tela.
const FAMILIAS = {
  'preto':    '#111111',
  'cinza':    '#9AA0A6',
  'branco':   '#FFFFFF',
  'bege':     '#E4D5BE',
  'marrom':   '#6B4A2F',
  'vermelho': '#D32F2F',
  'vinho':    '#6E1F2B',
  'rosa':     '#E8879B',
  'laranja':  '#EF6C1A',
  'amarelo':  '#F2C230',
  'verde':    '#2E7D4F',
  'azul':     '#1F5FBF',
  'roxo':     '#6D28D9',
};

/**
 * O balde de uma cor, por MATIZ e SATURAÇÃO — não por distância no RGB.
 *
 * A primeira versão usava distância euclidiana com pesos perceptuais, a
 * mesma de `nomeDaCor`. Ela funciona para achar o tom mais parecido; não
 * funciona para dizer a que cor uma pessoa chama isso. Medido nas cores
 * reais da Finesse: `#6B7280` — um cinza-azulado — caía em "verde",
 * porque o peso 4 no canal verde aproximava mais dele que do cinza.
 *
 * Matiz e saturação resolvem direto, e na ordem que o olho usa: primeiro
 * "isso tem cor?" (cinzas saem antes de qualquer coisa), depois "que cor
 * é?" (a faixa de matiz), e só então o quão clara ou escura.
 */
function familiaDaCor(hex) {
  const h = api.normalizarHex(hex);
  if (!h) return null;
  const r = parseInt(h.slice(1, 3), 16) / 255;
  const g = parseInt(h.slice(3, 5), 16) / 255;
  const b = parseInt(h.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const luz = (max + min) / 2;
  const delta = max - min;
  const sat = delta === 0 ? 0 : delta / (1 - Math.abs(2 * luz - 1));

  // ── Sem cor: preto, branco, cinza ────────────────────────
  // Vem PRIMEIRO. Um cinza levemente esverdeado é cinza para quem compra,
  // e classificá-lo por matiz é como o #6B7280 virou verde.
  if (luz <= 0.12) return 'preto';
  // Quase-preto COM um tingimento fraco tambem e preto pra quem compra:
  // #1F2937 (chumbo azulado) ia pra 'azul' pelo matiz. O corte de
  // saturacao preserva o azul-marinho de verdade (#082F6D, sat 0.86).
  if (luz < 0.22 && sat < 0.40) return 'preto';
  // Branco usa DELTA, nao saturacao: perto do branco a saturacao HSL
  // infla (off white #F3EFE7 da 0.33 com 4% de diferenca entre canais) e
  // qualquer teto razoavel deixaria off white de fora.
  if (luz >= 0.90 && delta <= 0.08) return 'branco';
  if (sat < 0.14) return luz < 0.35 ? 'preto' : 'cinza';

  let matiz = 0;
  if (delta !== 0) {
    if (max === r) matiz = ((g - b) / delta) % 6;
    else if (max === g) matiz = (b - r) / delta + 2;
    else matiz = (r - g) / delta + 4;
  }
  matiz = (matiz * 60 + 360) % 360;

  // ── Bege: claro, pouco saturado, na faixa quente ─────────
  // Nude, creme, cru e areia moram aqui. Sem esta regra eles cairiam em
  // "laranja" ou "amarelo", que é o que ninguém chamaria uma peça nude.
  if (matiz >= 15 && matiz <= 60 && luz >= 0.72 && sat <= 0.82) return 'bege';

  // ── Marrom: laranja escuro ───────────────────────────────
  // Caramelo, tabaco, ferrugem e chocolate são todos laranja com pouca
  // luz. Um balde "marrom" existe porque a pessoa procura marrom.
  if (matiz >= 12 && matiz <= 45 && luz < 0.48) return 'marrom';

  // ── Vinho: vermelho escuro ───────────────────────────────
  // Bordô e marsala entram aqui. Vinho é categoria própria em moda: quem
  // procura vestido vinho não aceita vermelho.
  if ((matiz >= 330 || matiz <= 12) && luz < 0.40) return 'vinho';

  if (matiz < 12 || matiz >= 345) return 'vermelho';
  // A fronteira em 40 e nao 45: dourado (#C8A24A, 42 graus) e amarelo
  // pra quem compra, e laranja puro (#FFA500) fica em 39.
  if (matiz < 40)  return 'laranja';
  // 65 e nao 70: verde militar (#4B5320) fica em 69 graus, e oliva e
  // verde pra quem compra. Amarelo puro esta em 60.
  if (matiz < 65)  return 'amarelo';
  // 175 e nao 165: verde agua (#7FD1C1) fica em 168 graus. Ciano puro
  // (#06B6D4, 189) continua azul.
  if (matiz < 175) return 'verde';
  if (matiz < 255) return 'azul';
  if (matiz < 290) return 'roxo';
  return 'rosa';
}

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
    const familia = familiaDaCor(hex);
    // familiaDaCor sempre acha um balde; o `|| hex` fica como rede para
    // um valor que nem é cor.
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
        rotulo: familia ? familia.charAt(0).toUpperCase() + familia.slice(1) : hex,
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
  FAMILIAS,
  familiaDaCor,
  ...api,
  agruparPorFamilia,
};
