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

  test('modern e SEM SERIFA — era Fraunces, que lia igual as outras serifadas', () => {
    // Antes `modern` era Fraunces — serifada, igual a classic e a
    // editorial. Tres serifadas em quatro opcoes e o motivo de ninguem
    // conseguir diferenciar os pares no painel.
    expect(TIPOGRAFIAS.modern.display).toContain('Space Grotesk');
    expect(TIPOGRAFIAS.modern.body).toContain('Inter');
  });

  test('editorial e de PESO ALTO — antes era Playfair, serifada como o classic', () => {
    expect(TIPOGRAFIAS.editorial.display).toContain('Archivo Black');
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
    expect(link).toContain('Archivo+Black');
    expect(link).toContain('DM+Mono');
    // O ponto do modulo: antes vinham as tres familias em toda loja.
    expect(link).not.toContain('Instrument');
    expect(link).not.toContain('Space+Grotesk');
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

describe('os quatro pares sao mesmo diferentes', () => {
  test('nenhum display se repete', () => {
    // O feedback foi "nao consigo diferenciá-las". A causa era estrutural:
    // tres serifadas em quatro opcoes, e o quarto display era DM Sans —
    // que ja era o CORPO do classic.
    const displays = Object.values(TIPOGRAFIAS).map((p) => p.display.split(',')[0]);
    expect(new Set(displays).size).toBe(displays.length);
  });

  test('nenhum display repete o corpo de outro par', () => {
    const corpos = new Set(Object.values(TIPOGRAFIAS).map((p) => p.body.split(',')[0]));
    for (const par of Object.values(TIPOGRAFIAS)) {
      // Excecao: o par pode usar a propria familia nos dois papeis.
      const display = par.display.split(',')[0];
      if (display === par.body.split(',')[0]) continue;
      expect(corpos.has(display)).toBe(false);
    }
  });

  test('ha serifada E sem serifa entre as opcoes', () => {
    const juntos = Object.values(TIPOGRAFIAS).map((p) => p.display).join(' ');
    expect(juntos).toMatch(/serif/);
    expect(juntos).toMatch(/sans-serif/);
  });
});
