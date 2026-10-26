// ============================================================
// Vitrine: nome da loja ao lado do logo emblema (tq-59, 26/10/2026)
//
// QA da Felic Adega (20/10): com logo, o topo escondia o nome da loja. O
// logo dela e um emblema quadrado, sem o nome escrito, entao a loja ficava
// sem nome no topo. Agora o script da vitrine (parts/init.js) mede o logo:
// ate 1,5:1 (emblema) marca .topbar-brand com .com-emblema e o CSS mostra o
// site_name ao lado, no desktop e no celular. Logo largo (com o nome
// escrito) nao ganha a classe e fica como sempre foi.
// ============================================================
'use strict';

const buildStyles = require('../src/templates/storefrontStyles');
const buildStorefrontPage = require('../src/templates/storefrontPage');
const init = require('../src/templates/storefront/parts/init');

const LOGO = 'https://r2.getaura.com.br/loja/canal/logo.png';

function pagina(site) {
  return buildStorefrontPage({ site: { name: 'Felic Adega', primary_color: '#C7A956', ...site }, products: [], categories: [], settings: {} }, 'felic');
}

/** O trecho do init.js que mede o logo, rodado contra um DOM falso. */
const MEDIDA = init.match(/\(function\(\)\{\s*var img=document\.querySelector\('\.topbar-logo img'\)[\s\S]*?\n\}\)\(\);/)[0];
function medir({ largura, altura, carregada = true, semLogo = false }) {
  const classes = new Set();
  const ouvintes = {};
  const brand = { classList: { add: (c) => classes.add(c) } };
  const img = {
    naturalWidth: carregada ? largura : 0, naturalHeight: carregada ? altura : 0, complete: carregada,
    closest: (sel) => (sel === '.topbar-brand' ? brand : null),
    addEventListener: (ev, fn) => { ouvintes[ev] = fn; },
  };
  const document = { querySelector: (sel) => (sel === '.topbar-logo img' && !semLogo ? img : null) };
  new Function('document', MEDIDA)(document);
  return {
    classes,
    carregar() { img.naturalWidth = largura; img.naturalHeight = altura; img.complete = true; ouvintes.load(); },
  };
}

/** Corpo da regra CSS que comeca exatamente com `seletor{`. */
function regra(css, seletor) {
  const i = css.indexOf(seletor + '{');
  if (i < 0) return null;
  return css.slice(i + seletor.length + 1, css.indexOf('}', i));
}

describe('a medida do logo do topo', () => {
  test('emblema quadrado (512x512, o da Felic Adega) marca .com-emblema', () => {
    expect([...medir({ largura: 512, altura: 512 }).classes]).toEqual(['com-emblema']);
  });

  test('ate 1,5:1 ainda e emblema; acima disso e logo largo', () => {
    expect(medir({ largura: 150, altura: 100 }).classes.has('com-emblema')).toBe(true);
    expect(medir({ largura: 151, altura: 100 }).classes.has('com-emblema')).toBe(false);
    expect(medir({ largura: 400, altura: 100 }).classes.has('com-emblema')).toBe(false);
  });

  test('imagem que ainda nao carregou: mede no load', () => {
    const m = medir({ largura: 512, altura: 512, carregada: false });
    expect(m.classes.size).toBe(0);
    m.carregar();
    expect(m.classes.has('com-emblema')).toBe(true);
  });

  test('imagem sem medida (0x0) e loja sem logo nao marcam nada', () => {
    expect(medir({ largura: 0, altura: 0 }).classes.size).toBe(0);
    expect(medir({ largura: 512, altura: 512, semLogo: true }).classes.size).toBe(0);
  });

  test('o script da pagina leva a medida, depois do topo', () => {
    const html = pagina({ logo_url: LOGO });
    expect(html).toContain(MEDIDA);
    expect(html.indexOf(MEDIDA)).toBeGreaterThan(html.indexOf('class="topbar-logo"'));
  });

  test('o nome no topo e o site_name da loja (escapado), com e sem logo', () => {
    expect(pagina({ logo_url: LOGO, name: 'Adega & Cia' })).toContain('<span class="topbar-name">Adega &amp; Cia</span>');
    expect(pagina({ logo_url: null })).toContain('<span class="topbar-name">Felic Adega</span>');
  });
});

describe('CSS do topo', () => {
  const css = buildStyles('#C7A956', null, true, 'classic');

  test('logo largo continua escondendo o nome (regra de antes intacta)', () => {
    expect(regra(css, '.topbar-logo:has(img)+.topbar-brand-text .topbar-name')).toBe('display:none;');
  });

  test('emblema mostra o nome ao lado no desktop', () => {
    expect(regra(css, '.topbar-brand.com-emblema .topbar-logo:has(img)+.topbar-brand-text .topbar-name')).toBe('display:block;');
  });

  test('no celular (ate 600 px) o emblema mostra o nome, sem o selo de horario', () => {
    const i = css.lastIndexOf('@media(max-width:600px){');
    const celular = css.slice(i);
    expect(celular).toContain('.topbar-brand-text{display:none;}');
    expect(regra(celular, '.topbar-brand.com-emblema .topbar-brand-text')).toBe('display:flex;');
    expect(regra(celular, '.topbar-brand.com-emblema .open-badge')).toBe('display:none;');
    expect(regra(celular, '.topbar-brand.com-emblema .topbar-name')).toBe('font-size:16px;');
  });

  test('o nome corta com reticencias em vez de empurrar o topo', () => {
    const nome = regra(css, '.topbar-name');
    expect(nome).toContain('text-overflow:ellipsis');
    expect(nome).toContain('white-space:nowrap');
  });
});
