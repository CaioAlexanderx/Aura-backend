// ============================================================
// Vitrine: cabecalho em uma linha no desktop e busca com margem no celular
// (26/10/2026)
//
// QA da Felic Adega (https://loja.getaura.com.br/felic-adega):
//  1. Desktop 1440-1680: com o selo "Fechada · Abre amanha as 11:00", a
//     sacola caia sozinha pra segunda linha. O .topnav tinha flex-basis
//     auto; no .topbar (flex-wrap) o nav era medido pelo texto de TODAS as
//     categorias, e a soma marca + nav + busca + sacola estourava a linha.
//     Com basis 0 o nav so ocupa o que sobra e a linha nao quebra.
//  2. Celular 375: a busca tinha flex-basis 100% + margin 0 8px, ou seja,
//     16px a mais que o cabecalho, e era cortada na borda direita.
//
// O comportamento e de layout (precisa de navegador); aqui trava as duas
// regras que o corrigem, sem testar o resto do CSS.
// ============================================================
'use strict';

const buildStyles = require('../src/templates/storefrontStyles');
const homeStyles = require('../src/templates/storefrontHomeStyles');

/** Corpo da regra CSS que comeca exatamente com `seletor{` (a primeira ocorrencia). */
function regra(css, seletor) {
  const i = css.indexOf(seletor + '{');
  if (i < 0) return null;
  return css.slice(i + seletor.length + 1, css.indexOf('}', i));
}

describe('CSS do cabecalho da vitrine', () => {
  const css = buildStyles('#C7A956', null, true, 'classic');
  // O desenho do cabecalho (redesign 09/2026) vive em storefrontHomeStyles e
  // entra no CSS final depois do antigo, entao e ele que vence a cascata.
  const home = homeStyles({ fontSerif: 'serif', fontSans: 'sans-serif', fontMono: 'monospace' });
  test('a regra do nav chega ao CSS final da pagina', () => {
    expect(css).toContain('.topnav{' + regra(home, '.topnav') + '}');
  });

  test('o nav de categorias nao entra na quebra de linha pelo texto inteiro (flex-basis 0)', () => {
    const nav = regra(home, '.topnav');
    expect(nav).toContain('flex:1 1 0;');
    expect(nav).toContain('min-width:0');
    expect(nav).toContain('overflow:hidden');
    expect(nav).not.toMatch(/flex:1 1 auto/);
  });

  test('a marca nao encolhe nem quebra: o selo de horario continua inteiro', () => {
    expect(regra(home, '.topbar-brand')).toContain('flex:0 0 auto');
  });

  test('o cabecalho continua com flex-wrap (o celular depende dele para a busca descer)', () => {
    expect(regra(home, '.topbar')).toContain('flex-wrap:wrap');
  });

  test('no celular a busca ocupa a linha MENOS as margens laterais, nunca 100% + margem', () => {
    const celular = css.slice(css.lastIndexOf('@media(max-width:600px){'));
    const busca = regra(celular, '.search-pill');
    expect(busca).toContain('flex:1 0 calc(100% - 16px)');
    expect(busca).toContain('margin:0 8px 12px');
    expect(busca).not.toMatch(/flex:1 0 100%/);
  });
});
