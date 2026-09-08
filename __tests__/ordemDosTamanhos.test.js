// ============================================================
// Tamanhos na regua, no cartao E na pagina do produto (QA 08/09/2026)
//
// O cartao ja ordenava (P M G); a pagina do produto mostrava os chips na
// ordem em que a lojista cadastrou as variantes — "G M P" na Finesse. A
// regua vive numa funcao so, compararTamanhos, e os dois usam ela.
// ============================================================
const buildPage = require('../src/templates/storefrontPage');

const html = buildPage({
  slug: 'loja',
  site: { name: 'Loja', primary_color: '#7a1f3a' },
  contact: {}, settings: {}, products: [], categories: [],
  categorias_arvore: [], tira_de_categorias: [], facetas: { preco: { min: 10, max: 300 } },
  home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
}, 'loja');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Executa so o trecho da regua, como o navegador executaria.
function regua() {
  const ini = js.indexOf('var ESCALA_TAM=');
  const fim = js.indexOf('function compararTamanhos');
  const corpoNorm = js.slice(ini, fim);
  const fimComparar = js.indexOf('\n}\n', fim) + 3;
  const src = corpoNorm + js.slice(fim, fimComparar) + '\nreturn compararTamanhos;';
  return new Function(src)();
}

describe('compararTamanhos', () => {
  const cmp = regua();

  test('letras na ordem da regua, nao do cadastro', () => {
    expect(['G', 'M', 'P'].sort(cmp)).toEqual(['P', 'M', 'G']);
    expect(['GG', 'PP', 'XG', 'M'].sort(cmp)).toEqual(['PP', 'M', 'GG', 'XG']);
  });

  test('numeros crescentes, meia numeracao logo depois do inteiro', () => {
    expect(['40', '33/34', '38', '33', '37/38'].sort(cmp)).toEqual(['33', '33/34', '37/38', '38', '40']);
  });

  test('numero vem antes de letra; Unico por ultimo entre as letras', () => {
    // "u" e "Único" sao o mesmo degrau da regua; entre eles, ordem por nome.
    expect(['M', '38', 'Único', 'u', 'P'].sort(cmp)).toEqual(['38', 'P', 'M', 'u', 'Único']);
  });

  test('valor fora da regua vai pro fim, por nome', () => {
    expect(['Longo', 'Curto', 'M'].sort(cmp)).toEqual(['M', 'Curto', 'Longo']);
  });

  test('caixa baixa entra na regua como se fosse alta', () => {
    expect(['g', 'm', 'p'].sort(cmp)).toEqual(['p', 'm', 'g']);
  });
});

describe('quem usa a regua', () => {
  test('o cartao', () => {
    expect(js).toContain('lista.sort(compararTamanhos);');
  });

  test('a pagina do produto, so no atributo de tamanho', () => {
    expect(js).toContain("attrOrder.forEach(function(a){ if(atributoDeTamanho(a)) attrs[a].sort(compararTamanhos); });");
  });

  test('a funcao existe uma vez so', () => {
    expect((js.match(/function compararTamanhos\(/g) || []).length).toBe(1);
  });

  test('o script continua sendo JS valido', () => {
    expect(() => new Function(js.replace(/<\\\/script>/g, '</script>'))).not.toThrow();
  });
});
