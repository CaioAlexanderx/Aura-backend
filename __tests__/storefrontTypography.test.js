// ============================================================
// Pares tipograficos da loja comum
//
// Este arquivo e ESPELHO do `constants/fonts.ts` do app. Os testes travam
// o contrato que os dois lados precisam cumprir — nao conseguem comparar
// com o outro repo, entao travam pelo menos o que da.
// ============================================================
const { TIPOGRAFIAS, parTipografico, linkDeFontes } = require('../src/templates/storefrontTypography');

describe('pares tipograficos', () => {
  const CHAVES = ['classic', 'modern', 'editorial', 'humanist'];

  test('as quatro chaves que o painel oferece existem aqui', () => {
    // Se o app ganhar uma quinta opcao e este arquivo nao acompanhar, a
    // lojista escolhe e a loja comum ignora em silencio — foi exatamente
    // o que aconteceu com `editorial`.
    expect(Object.keys(TIPOGRAFIAS).sort()).toEqual([...CHAVES].sort());
  });

  test.each(CHAVES)('%s define display, body e familias', (chave) => {
    const par = TIPOGRAFIAS[chave];
    expect(par.display).toBeTruthy();
    expect(par.body).toBeTruthy();
    expect(Array.isArray(par.familias)).toBe(true);
    expect(par.familias.length).toBeGreaterThan(0);
  });

  test('modern usa Manrope no corpo, nao DM Sans', () => {
    // A divergencia que motivou este modulo: o template usava DM Sans no
    // corpo de TODOS os pares, entao `modern` era Fraunces+DM Sans aqui e
    // Fraunces+Manrope na vitrine Studio.
    expect(TIPOGRAFIAS.modern.body).toContain('Manrope');
    expect(TIPOGRAFIAS.modern.display).toContain('Fraunces');
  });

  test('editorial e Playfair — antes caia no ramo do classic', () => {
    expect(TIPOGRAFIAS.editorial.display).toContain('Playfair');
  });

  test('chave desconhecida cai no classico em vez de quebrar', () => {
    expect(parTipografico('inexistente')).toBe(TIPOGRAFIAS.classic);
    expect(parTipografico(null)).toBe(TIPOGRAFIAS.classic);
    expect(parTipografico(undefined)).toBe(TIPOGRAFIAS.classic);
    expect(parTipografico('')).toBe(TIPOGRAFIAS.classic);
  });
});

describe('linkDeFontes', () => {
  test('carrega SO o par escolhido, mais a mono', () => {
    const link = linkDeFontes('editorial');
    expect(link).toContain('Playfair+Display');
    expect(link).toContain('Manrope');
    expect(link).toContain('DM+Mono');
    // O ponto do modulo: antes vinham as tres familias em toda loja.
    expect(link).not.toContain('Fraunces');
  });

  test('classic nao arrasta Playfair nem Fraunces', () => {
    const link = linkDeFontes('classic');
    expect(link).toContain('Instrument+Serif');
    expect(link).not.toContain('Playfair');
    expect(link).not.toContain('Fraunces');
  });

  test('sempre devolve URL valida do Google Fonts', () => {
    for (const chave of ['classic', 'modern', 'editorial', 'humanist', 'lixo']) {
      expect(linkDeFontes(chave)).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=/);
      expect(linkDeFontes(chave)).toContain('display=swap');
    }
  });
});
