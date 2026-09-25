// Chave da vitrine Studio nova, por loja (25/09/2026).
const fs = require('fs');
const path = require('path');
const { vitrineV2Ligada } = require('../src/services/vitrineV2');

describe('vitrineV2Ligada', () => {
  test('liga com booleano e com texto "true"', () => {
    expect(vitrineV2Ligada({ vitrine_v2: true })).toBe(true);
    expect(vitrineV2Ligada({ vitrine_v2: 'true' })).toBe(true);
  });

  test('qualquer outra coisa deixa a loja na tela que ela já conhece', () => {
    for (const v of [undefined, null, false, 'false', 'sim', 1, {}, []]) {
      expect(vitrineV2Ligada({ vitrine_v2: v })).toBe(false);
    }
    expect(vitrineV2Ligada(null)).toBe(false);
    expect(vitrineV2Ligada(undefined)).toBe(false);
    expect(vitrineV2Ligada('true')).toBe(false);
  });

  test('o payload público da vitrine Studio expõe a chave dentro de site', () => {
    const studio = fs.readFileSync(path.join(__dirname, '..', 'src/routes/studioStorefront.js'), 'utf8');
    const i = studio.indexOf('function montarSite');
    const corpo = studio.slice(i, studio.indexOf('\n}\n', i));
    expect(corpo).toContain('vitrine_v2: vitrineV2Ligada(config.studio_settings)');
    // a consulta que alimenta montarSite traz studio_settings
    expect(studio).toMatch(/COALESCE\(c\.studio_settings, '\{\}'::jsonb\) AS studio_settings/);
  });
});
