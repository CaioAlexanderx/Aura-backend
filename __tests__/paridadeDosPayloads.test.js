// ============================================================
// As duas lojas descrevem o MESMO produto — e divergiram 4 vezes.
//
// A loja comum monta o produto em services/storefrontBuilder.js
// (montarProdutoPublico); a vitrine Studio monta em
// routes/studioStorefront.js, num mapeamento proprio. Nao ha como fundir
// os dois hoje: a vitrine carrega customization_config, templates e
// qty_tiers que a loja comum nao tem, e a loja comum carrega variants que
// a vitrine nao usa.
//
// O que NAO pode acontecer e um campo de PRODUTO existir num e nao no
// outro sem ninguem perceber. Ja aconteceu com:
//   - font_family / card_style (a lojista escolhia e so uma loja obedecia)
//   - editorial (existia no painel e nao no template)
//   - material / medidas / cuidados (nasceram so na loja comum, 23/08)
//
// Este teste le os DOIS arquivos e exige que os campos compartilhados
// apareçam nos dois mapeamentos. Nao e elegante ler fonte, mas e o unico
// jeito de pegar isso sem subir dois servidores.
// ============================================================
const fs = require('fs');
const path = require('path');

const builder = fs.readFileSync(
  path.join(__dirname, '../src/services/storefrontBuilder.js'), 'utf8',
);
const studio = fs.readFileSync(
  path.join(__dirname, '../src/routes/studioStorefront.js'), 'utf8',
);

/** O bloco que monta o produto, em cada lado. */
function mapeamentoDaLojaComum() {
  const i = builder.indexOf('function montarProdutoPublico');
  expect(i).toBeGreaterThan(0);
  return builder.slice(i, i + 2000);
}

function mapeamentoDaVitrine() {
  const i = studio.indexOf('gallery_urls: Array.isArray');
  expect(i).toBeGreaterThan(0);
  // O bloco do produto vai um pouco pra tras e um pouco pra frente.
  return studio.slice(Math.max(0, i - 900), i + 1500);
}

// Campos que descrevem o PRODUTO em si — o que o cliente le antes de
// decidir. Ficam de fora os que sao proprios de cada loja (variants,
// customization_config, templates, qty_tiers).
const CAMPOS_COMPARTILHADOS = [
  'name',
  'description',
  'price',
  'image_url',
  // Migration 317 — miniatura. Nasceu nos dois no mesmo PR (02/09).
  'thumb_url',
  'gallery_urls',
  'category',
  'material',
  'medidas',
  'cuidados',
  // Redesign 09/2026 — selo NOVO. Nasceu na loja comum e na vitrine no
  // mesmo PR, e este teste e o que impede um dos lados de perder o selo.
  'is_new',
];

describe('paridade entre a loja comum e a vitrine Studio', () => {
  const comum = mapeamentoDaLojaComum();
  const vitrine = mapeamentoDaVitrine();

  test.each(CAMPOS_COMPARTILHADOS)('"%s" sai nos DOIS payloads', (campo) => {
    expect(comum).toContain(campo + ':');
    expect(vitrine).toContain(campo + ':');
  });

  test('a ficha tecnica chega nas duas', () => {
    // O caso concreto de 23/08: as colunas nasceram na migration 305, a
    // loja comum passou a mostrar no mesmo dia, e a vitrine ficou sem —
    // porque cada rota tem o proprio SELECT.
    for (const campo of ['material', 'medidas', 'cuidados']) {
      expect(builder).toContain(campo);
      expect(studio).toContain(campo);
    }
  });

  test('as duas leem a ficha de forma defensiva', () => {
    // O backend nao roda migration no boot. Se uma das rotas fizer SELECT
    // direto das colunas novas, ela quebra no intervalo entre o deploy do
    // codigo e o da migration — e quebra a loja inteira, nao so a ficha.
    expect(studio).toContain('42703');
    expect(builder).toContain('material, medidas, cuidados');
  });
});
