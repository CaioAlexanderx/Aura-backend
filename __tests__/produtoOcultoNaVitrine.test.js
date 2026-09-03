// ============================================================
// O botão "visível na loja" vale em TODA a vitrine (02/09/2026)
//
// Relatado pela Fernanda (FK Store): ela desliga um produto e ele
// continua aparecendo. Não era o botão — era o alcance da regra.
//
// `featured_product_ids` é lista de INCLUSÃO: vazia, mostra tudo; cheia,
// mostra só o que está nela. Essa regra morava DENTRO da consulta da
// grade. O redesign de 09/2026 trouxe blocos de home, árvore de
// categorias e facetas — todos nasceram sem ela.
//
// Na loja dela, medido em produção: 18 peças curadas, grade com 18, e o
// bloco "Acabaram de chegar" mostrando 8, das quais 5 estavam
// DESLIGADAS. O menu contava as 25. Do lado de quem usa, "o botão não
// funciona".
//
// A correção é a mesma lição de EM_ESTOQUE e COM_FOTO: regra que vale
// para a vitrine inteira vira FRAGMENTO, não linha solta numa consulta.
// É isso que este teste guarda — não o texto do SQL, mas o alcance.
// ============================================================
const fs = require('fs');
const path = require('path');
const { NA_VITRINE } = require('../src/services/catalogoPaginado');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('NA_VITRINE, o fragmento', () => {
  test('lista vazia deixa tudo passar; cheia, só o que está nela', () => {
    // Sem curadoria: NOT EXISTS(...lista não vazia...) é verdadeiro.
    expect(NA_VITRINE).toContain('NOT EXISTS');
    expect(NA_VITRINE).toContain("jsonb_typeof(dcv.featured_product_ids) = 'array'");
    expect(NA_VITRINE).toContain('jsonb_array_length(dcv.featured_product_ids) > 0');
    // Com curadoria: contenção jsonb do id do produto.
    expect(NA_VITRINE).toContain('dcv.featured_product_ids @> to_jsonb(products.id::text)');
  });

  test('lê a config por $1, como visibilityWhere', () => {
    // $1 é o company da loja e já é o primeiro parâmetro de todas essas
    // consultas — é o que permite ao fragmento viajar sem assinatura nova.
    expect((NA_VITRINE.match(/\$1/g) || []).length).toBe(2);
  });

  test('diz products-ponto, como EM_ESTOQUE e COM_FOTO', () => {
    // Fragmento sem prefixo quebra assim que a consulta ganha um JOIN.
    expect(NA_VITRINE).toContain('products.id');
  });
});

describe('o alcance: toda consulta que desenha a vitrine', () => {
  const paginado = fonte('src/services/catalogoPaginado.js');
  const home = fonte('src/services/homeDaLoja.js');
  const builder = fonte('src/services/storefrontBuilder.js');

  test('a grade (página 1 embutida e as seguintes)', () => {
    expect(paginado).toContain("filtroDeFoto(exigeFoto), NA_VITRINE]");
    expect((builder.match(/\$\{NA_VITRINE\}/g) || []).length).toBe(2);
  });

  test('os quatro blocos da home, por filtrosBase', () => {
    // filtrosBase alimenta mais vendidos, últimas unidades, novidades e as
    // capas das categorias — os quatro de uma vez.
    const i = home.indexOf('function filtrosBase');
    expect(home.slice(i, i + 400)).toContain('NA_VITRINE');
    // Só as interpolações — a linha da definição casaria também.
    expect((home.match(/\$\{filtrosBase\(visibilityWhere, exigeFoto\)\}/g) || []).length).toBe(4);
  });

  test('a árvore de categorias e a contagem legada', () => {
    const arv = paginado.slice(paginado.indexOf('async function arvoreDeCategorias'));
    expect(arv.slice(0, arv.indexOf('SELECT c.id'))).toContain('${NA_VITRINE}');
    const cont = paginado.slice(paginado.indexOf('async function contarPorCategoria'));
    expect(cont.slice(0, 600)).toContain('${NA_VITRINE}');
  });

  test('as facetas e a faixa de preço', () => {
    const fac = paginado.slice(paginado.indexOf('async function facetasDoCatalogo'));
    expect(fac.slice(0, fac.indexOf('try {'))).toContain('${NA_VITRINE}');
    const fx = paginado.slice(paginado.indexOf('async function faixaDePreco'));
    expect(fx.slice(0, fx.indexOf('try {'))).toContain('${NA_VITRINE}');
  });
});

describe('a curadoria não é aplicada duas vezes', () => {
  test('featuredIds passa a servir só para ORDENAR', () => {
    const paginado = fonte('src/services/catalogoPaginado.js');
    const i = paginado.indexOf('const curados = Array.isArray(featuredIds)');
    const bloco = paginado.slice(i, i + 400);
    expect(bloco).toContain('array_position($');
    // O filtro saiu: quem decide quem aparece é o fragmento.
    expect(bloco).not.toContain("filtros.push(`id::text = ANY(");
  });

  test('o payload embutido também ordena pela curadoria e filtra pelo fragmento', () => {
    const builder = fonte('src/services/storefrontBuilder.js');
    const i = builder.indexOf('if (featuredIds && featuredIds.length > 0)');
    const bloco = builder.slice(i, i + 900);
    expect(bloco).toContain('${NA_VITRINE}');
    expect(bloco).toContain('ORDER BY array_position($2, id::text)');
    expect(bloco).not.toContain('AND id::text = ANY($2)');
  });
});
