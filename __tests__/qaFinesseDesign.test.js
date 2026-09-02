// ============================================================
// QA da Finesse no ar (02/09/2026), com a Oscar e a Vans como regua.
//
// Sete defeitos de design que so apareceram com a loja real aberta no
// desktop e no celular. Cada bloco aqui e um deles; a regra que corrige
// fica presa no teste pra nao voltar num refactor de CSS.
// ============================================================
const fs = require('fs');
const path = require('path');
const homeStyles = require('../src/templates/storefrontHomeStyles');

const parts = (f) => fs.readFileSync(path.join(__dirname, '../src/templates/storefront/parts', f), 'utf8');
const css = homeStyles({ fontSerif: 'SERIF', fontSans: 'SANS', fontMono: 'MONO' });
const mobile = css.slice(css.indexOf('@media(max-width:900px)'));

describe('lateral de filtros e folha do celular', () => {
  test('a lateral nao herda "linha centralizada" da regra antiga', () => {
    // Sem isto os grupos saiam centralizados no desktop e a folha do
    // celular quebrava em DUAS colunas ao passar de 82vh.
    expect(css).toContain('.filtros-wrap{position:sticky;top:102px;display:flex;flex-direction:column;flex-wrap:nowrap;align-items:stretch;');
  });
  test('"Ver resultados" fica preso no pe da folha', () => {
    expect(mobile).toMatch(/\.filtro-aplicar\{[^}]*position:sticky;bottom:0;/);
  });
});

describe('card de produto', () => {
  test('o nome e sans — a serifa fica pros titulos de secao', () => {
    expect(css).toContain('.product-name{font-family:SANS;');
  });
});

describe('pagina do produto', () => {
  test('foto e informacao dividem a largura em partes iguais, e a foto tem teto', () => {
    expect(css).toContain('grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:48px;');
    expect(css).toMatch(/\.pd-foto\{[^}]*max-height:min\(78vh,680px\);/);
  });
  test('a barra de cima nao tem altura fixa (a regra antiga tinha 60px)', () => {
    expect(css).toMatch(/\.pd-topo\{[^}]*height:auto;\}/);
  });
  test('no celular as migalhas rolam de lado e o nome da peca sai delas', () => {
    expect(mobile).toContain('.pd-topo-inner{padding:10px 16px;flex-wrap:nowrap;flex-direction:column;');
    expect(mobile).toContain('.pd-crumbs{flex-wrap:nowrap;white-space:nowrap;overflow-x:auto;');
    expect(mobile).toContain('.pd-crumbs [aria-current],.pd-crumbs .crumbs-sep:nth-last-child(2){display:none;}');
  });
});

describe('nome da cor com a primeira letra maiuscula', () => {
  // A lojista cadastra "azul marinho"; a loja mostra "Azul marinho".
  const utils = parts('state_utils.js');
  test('o helper existe e faz so a primeira letra', () => {
    const fn = new Function('SETTINGS', utils.replace(/^module\.exports = `/m, '').replace(/`;\s*$/, '') + ';return primeiraMaiuscula;')({});
    expect(fn('azul marinho')).toBe('Azul marinho');
    expect(fn('  jeans ')).toBe('Jeans');
    expect(fn('')).toBe('');
    expect(fn(null)).toBe('');
    expect(fn('Preto')).toBe('Preto');
  });
  test('a pagina do produto usa o helper na bolinha e no rotulo escolhido', () => {
    const src = parts('product_detail.js');
    expect(src).toContain("var rotulo=primeiraMaiuscula(ehHex?(nomeDaCor(val)||'Cor'):val);");
    expect(src).toContain('if(cor) escolhidoRotulo=primeiraMaiuscula(escolhidoRotulo);');
  });
});

describe('nome do item na sacola', () => {
  const src = parts('cart.js');
  const corpo = src.replace(/^module\.exports = `/m, '').replace(/`;\s*$/, '');
  // Avalia so as duas funcoes puras; o resto do part mexe no DOM.
  const ini = corpo.indexOf('function varianteDoProduto');
  const fim = corpo.indexOf('function addToCart');
  const fns = new Function('atributoDeCor', 'nomeDaCor', 'primeiraMaiuscula',
    corpo.slice(ini, fim) + ';return {varianteDoProduto:varianteDoProduto,nomeDoItem:nomeDoItem};')(
    (a) => /cor/i.test(a),
    (hex) => ({ '#000000': 'preto' })[hex] || null,
    (s) => { s = String(s == null ? '' : s).trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; },
  );
  const p = { name: 'Macacão', variants: [
    { id: 'v1', values: [{ attribute: 'Cor', value: '#000000' }, { attribute: 'Tamanho', value: 'm' }] },
    { id: 'v2', values: [{ attribute: 'Cor', value: 'azul marinho' }] },
  ] };

  test('hex vira o nome da cor, e tudo com maiuscula', () => {
    expect(fns.nomeDoItem(p, fns.varianteDoProduto(p, 'v1'))).toBe('Macacão (Preto / M)');
    expect(fns.nomeDoItem(p, fns.varianteDoProduto(p, 'v2'))).toBe('Macacão (Azul marinho)');
    expect(fns.nomeDoItem(p, null)).toBe('Macacão');
    expect(fns.varianteDoProduto(p, 'nao-existe')).toBeNull();
  });
  test('adicionar e carregar passam pela mesma funcao', () => {
    expect(src).toContain('var name=nomeDoItem(p,v);');
    const sacola = parts('sacola.js');
    expect(sacola).toContain('var nome=(p&&(v||!i.variant_id))?nomeDoItem(p,v):(i.name||\'\');');
  });
});
