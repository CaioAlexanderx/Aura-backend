// ============================================================
// Vitrine: texto do botao preto ou branco pela cor da loja (tq-56, 26/10/2026)
//
// O CSS da vitrine escrevia color:#fff fixo sobre a cor principal. Com
// cor clara (Felic Adega, #C7A956) o botao de comprar ficava com 2,3:1 de
// contraste. Agora: branco enquanto o branco alcanca 3:1 (decisao do
// Caio, 26/10), senao preto. So cor clara troca; cor escura e cor media
// saem byte a byte iguais a antes.
// ============================================================
'use strict';

const { textoSobre, contraste, luminanciaRelativa, MINIMO_WCAG } = require('../src/templates/storefrontContraste');
const buildStyles = require('../src/templates/storefrontStyles');
const buildStorefrontPage = require('../src/templates/storefrontPage');

const FELIC = '#C7A956';
const ESCURAS = ['#7c3aed', '#1f2937', '#5b2a86', '#0e8345', '#b91c1c', '#000000'];
// Medias e saturadas: entre 3:1 e 4,5:1 com o branco. Continuam brancas.
const MEDIAS = ['#EF4444', '#3B82F6', '#16A34A', '#EA580C', '#8B5CF6', '#e91e63'];
// Claras: o branco nao chega a 3:1.
const CLARAS = ['#C7A956', '#F97316', '#22C55E', '#10B981', '#F59E0B', '#f5f5f5'];

/** O CSS como era antes: a mesma montagem com o texto sobre a marca sempre #fff. */
function cssComBrancoFixo(primary, accent, dark, font) {
  let css;
  jest.isolateModules(() => {
    jest.doMock('../src/templates/storefrontContraste', () => ({
      ...jest.requireActual('../src/templates/storefrontContraste'),
      textoSobre: () => '#fff',
    }));
    css = require('../src/templates/storefrontStyles')(primary, accent, dark, font);
  });
  jest.dontMock('../src/templates/storefrontContraste');
  return css;
}

function pagina(primary, extra) {
  const site = { name: 'Felic Adega', primary_color: primary, logo_url: null, ...(extra || {}) };
  return buildStorefrontPage({ site, products: [], categories: [], settings: {} }, 'felic');
}

describe('a regra (WCAG 2.x)', () => {
  test('luminancia e contraste conferem com os valores de referencia', () => {
    expect(luminanciaRelativa('#ffffff')).toBeCloseTo(1, 5);
    expect(luminanciaRelativa('#000')).toBeCloseTo(0, 5);
    expect(contraste('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contraste('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  test('Felic Adega (#C7A956): branco da 2,3:1, entao o texto vira preto (9,2:1)', () => {
    expect(contraste(FELIC, '#fff')).toBeLessThan(2.5);
    expect(contraste(FELIC, '#000')).toBeGreaterThan(9);
    expect(textoSobre(FELIC)).toBe('#000');
  });

  test('cores escuras seguem com texto branco', () => {
    for (const cor of ESCURAS) expect(textoSobre(cor)).toBe('#fff');
  });

  test('cores medias (entre 3:1 e 4,5:1 com o branco) continuam brancas', () => {
    for (const cor of MEDIAS) {
      expect(contraste(cor, '#fff')).toBeGreaterThanOrEqual(3);
      expect(textoSobre(cor)).toBe('#fff');
    }
  });

  test('cores claras (branco abaixo de 3:1) viram preto', () => {
    for (const cor of CLARAS) expect(textoSobre(cor)).toBe('#000');
  });

  test('o corte e 3:1 com o branco', () => {
    expect(MINIMO_WCAG).toBe(3);
    expect(textoSobre('#949494')).toBe('#fff'); // 3,03:1
    expect(textoSobre('#959595')).toBe('#000'); // 2,99:1
  });

  test('hex curto, maiusculo e com espaco tambem', () => {
    expect(textoSobre('#FFF')).toBe('#000');
    expect(textoSobre(' #c7a956 ')).toBe('#000');
  });

  test('cor que nao e hex fica no branco de sempre', () => {
    for (const cor of [null, undefined, '', 'rgb(250,250,250)', 'gold', '#12345', '#ggg']) {
      expect(textoSobre(cor)).toBe('#fff');
    }
  });
});

describe('CSS da vitrine', () => {
  test('cor escura e cor media: o CSS sai identico ao de antes (claro e escuro, com e sem accent)', () => {
    for (const cor of [...ESCURAS, ...MEDIAS]) {
      for (const dark of [false, true]) {
        expect(buildStyles(cor, null, dark, 'classic')).toBe(cssComBrancoFixo(cor, null, dark, 'classic'));
        expect(buildStyles(cor, '#1f2937', dark, 'modern')).toBe(cssComBrancoFixo(cor, '#1f2937', dark, 'modern'));
      }
    }
    // assinatura legada buildStyles(primary)
    expect(buildStyles('#7c3aed')).toBe(cssComBrancoFixo('#7c3aed'));
  });

  test('Felic Adega: botoes de comprar, finalizar e avancar com texto preto', () => {
    const css = buildStyles(FELIC, null, false, 'classic');
    expect(css).toContain('.pd-comprar{background:var(--sf-brand);color:#000;}');
    expect(css).toMatch(/\.checkout-btn\{[^}]*background:var\(--sf-brand\);color:#000;/);
    expect(css).toMatch(/\.next-btn\{[^}]*background:var\(--sf-brand\);color:#000;/);
    expect(css).toMatch(/\.filtro-aplicar\{[^}]*background:var\(--sf-brand\);color:#000;/);
    expect(css).toMatch(/\.hero-text \.banner-cta\{[^}]*background:var\(--sf-brand\);color:#000;/);
    expect(css).toContain('.op-chip.sel{background:var(--sf-brand);border-color:var(--sf-brand);color:#000;}');
    expect(css).toMatch(/\.filtro-linha\.on \.filtro-caixa::after\{[^}]*border:solid #000;/);
  });

  test('Felic Adega: nenhum texto branco sobra em cima da cor da loja', () => {
    const css = buildStyles(FELIC, null, false, 'classic');
    expect(css).not.toMatch(/background:var\(--sf-brand\);[^}]*color:#fff/);
    expect(css).not.toMatch(/background:var\(--sf-brand\);border-color:var\(--sf-brand\);color:#fff/);
  });

  test('tema escuro da loja: mesma regra (a cor da marca nao muda no escuro)', () => {
    const css = buildStyles(FELIC, null, true, 'classic');
    expect(css).toContain('.pd-comprar{background:var(--sf-brand);color:#000;}');
  });

  test('o contador da sacola sobre a cor de destaque segue a cor de destaque', () => {
    const css = buildStyles('#1f2937', FELIC, false, 'classic');
    expect(css).toMatch(/\.cart-badge\{[^}]*background:var\(--sf-accent\);color:#000;/);
    expect(css).toContain('.pd-comprar{background:var(--sf-brand);color:#fff;}');
  });

  test('o que nao fica sobre a cor da loja continua branco (WhatsApp, foto do banner)', () => {
    const css = buildStyles(FELIC, null, false, 'classic');
    expect(css).toMatch(/\.whatsapp-cta\{[^}]*color:#fff;/);
    expect(css).toContain('.hero-slide.com-foto .hero-text{color:#fff;}');
  });
});

describe('pagina da vitrine', () => {
  test('a inicial da loja no topo (sem logo) segue a mesma regra', () => {
    expect(pagina(FELIC)).toMatch(/id="logoInitial" style="[^"]*color:#000;/);
    expect(pagina('#7c3aed')).toMatch(/id="logoInitial" style="[^"]*color:#fff;/);
  });
});
