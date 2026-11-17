// ============================================================
// AURA. -- Grade na importacao de produtos (b-import-grade, 17/11/2026)
//
// Achado de 12/11 (Look das Patroas): a planilha-modelo da propria Aura
// traz uma linha por cor/tamanho, com o mesmo nome e o mesmo SKU. O
// POST /products/import gravava cada linha como um produto e tratava as
// iguais como duplicata -- so a primeira entrava. A equipe contornava por
// script (memoria import-produtos-leibert).
//
// Agora: linhas com a mesma chave e cor/tamanho diferentes viram UM
// produto com variantes, no formato do PUT /variations
// (routes/productsVariations.js):
//   - chave = SKU (sem caixa/espacos); sem SKU, nome + unidade + marca
//     (chaveProdutoImport, a mesma do dedup);
//   - grade = 2 ou mais combinacoes (cor, tamanho) diferentes na chave.
//     Uma combinacao so (linha repetida) segue o caminho de sempre e vira
//     duplicata -- planilha sem grade grava exatamente como antes;
//   - matriz completa cores x tamanhos, como o PUT (celula que a planilha
//     nao trouxe nasce com estoque 0);
//   - Cor gravada como hex (#RRGGBB) em product_variant_values; o nome que
//     a lojista escreveu vai para product_variants.color_name (414). Nome
//     sem amostra conhecida ganha um hex fixo tirado do nome, e vira aviso;
//   - sku_suffix pelo mesmo skuSuffixFromAttrs do PUT;
//   - combinacao repetida soma o estoque (decisao do Caio, 13/11);
//   - preco diferente na mesma chave: o modelo fica com o preco da primeira
//     linha e a variante de preco diferente ganha price_override (nada se
//     perde), com aviso. Custo, categoria e nome diferentes: fica o da
//     primeira linha, com aviso.
//
// Funcoes puras, sem banco. A rota grava (routes/importData.js).
// ============================================================
'use strict';

const crypto = require('crypto');
const { chaveProdutoImport, chaveSku, chaveTexto } = require('./productDedupKey');

const MAX_EIXO = 30; // mesmo limite do PUT /variations (30 cores, 30 tamanhos)
const HEX = /^#?[0-9A-Fa-f]{6}$/;

function texto(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function chaveDaGrade(p) {
  const sku = chaveSku(p.sku);
  return sku ? 's:' + sku : 'n:' + chaveProdutoImport(p.name, p.unit, p.brand);
}

function temAtributo(p) {
  return !!(texto(p.color) || texto(p.size));
}

// Hex fixo para um nome de cor que a paleta nao conhece ("Passion",
// "Moskavo"): duas cores diferentes nao podem cair na mesma amostra, senao
// as variantes colidem. A lojista ajusta a amostra no editor (aviso).
function hexDoNome(nome) {
  return '#' + crypto.createHash('md5').update(chaveTexto(nome)).digest('hex').slice(0, 6).toUpperCase();
}

/**
 * Le a cor de uma linha. { hex, nome, conhecida }.
 * hex vindo da planilha: nome null. Nome conhecido: hex da paleta e o
 * nome como ela escreveu. Nome desconhecido: hexDoNome e conhecida=false.
 */
function lerCor(raw, coerceColorHex) {
  const t = texto(raw);
  if (!t) return null;
  const hex = coerceColorHex(t);
  if (hex && HEX.test(t)) return { hex: hex.toUpperCase(), nome: null, conhecida: true };
  if (hex) return { hex: hex.toUpperCase(), nome: t, conhecida: true };
  return { hex: hexDoNome(t), nome: t, conhecida: false };
}

function iguais(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

/**
 * Separa as linhas validas em grades e simples.
 *
 * @param {Array}  valid    itens ja lidos pela rota (name, price, sku, color, size...)
 * @param {Array}  linhaDe  indice na planilha de cada item de `valid`
 * @param {object} deps     { coerceColorHex, skuSuffixFromAttrs } do PUT /variations
 * @returns {{ modelos: Array, naGrade: Set<number>, erros: Array, avisos: Array }}
 *   naGrade = posicoes de `valid` que sairam do caminho simples.
 */
function montarGrades(valid, linhaDe, deps) {
  const { coerceColorHex, skuSuffixFromAttrs } = deps;
  const porChave = new Map(); // chave -> [k]
  valid.forEach((p, k) => {
    if (!temAtributo(p)) return;
    const chave = chaveDaGrade(p);
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(k);
  });

  const modelos = [];
  const naGrade = new Set();
  const erros = [];
  const avisos = [];

  for (const [chave, ks] of porChave) {
    if (ks.length < 2) continue;
    const linhas = ks.map((k) => {
      const p = valid[k];
      return { k, index: linhaDe[k], p, cor: lerCor(p.color, coerceColorHex), tam: texto(p.size) || null };
    });
    const combos = new Set(linhas.map((l) => (l.cor ? l.cor.hex : '') + '|' + (l.tam || '')));
    if (combos.size < 2) continue; // linha repetida: segue como duplicata, como antes

    const comCor = linhas.some((l) => l.cor);
    const comTam = linhas.some((l) => l.tam);

    // Grade de cor E tamanho: linha sem um dos dois nao tem casa na matriz.
    const usadas = [];
    for (const l of linhas) {
      if ((comCor && !l.cor) || (comTam && !l.tam)) {
        erros.push({
          index: l.index,
          error: comCor && !l.cor
            ? 'Linha sem cor numa grade de cor e tamanho (mesmo SKU/nome das outras)'
            : 'Linha sem tamanho numa grade de cor e tamanho (mesmo SKU/nome das outras)',
          row: null,
        });
        naGrade.add(l.k);
        continue;
      }
      usadas.push(l);
    }

    // Cores (por hex, na ordem da planilha) e tamanhos.
    const cores = new Map(); // hex -> { hex, nome, conhecida }
    const tamanhos = [];
    for (const l of usadas) {
      if (l.cor && !cores.has(l.cor.hex)) cores.set(l.cor.hex, l.cor);
      if (l.tam && !tamanhos.includes(l.tam)) tamanhos.push(l.tam);
    }
    if (cores.size > MAX_EIXO || tamanhos.length > MAX_EIXO) {
      for (const l of usadas) {
        erros.push({ index: l.index, error: `Grade com mais de ${MAX_EIXO} cores ou ${MAX_EIXO} tamanhos`, row: null });
        naGrade.add(l.k);
      }
      continue;
    }
    if (!usadas.length) continue;
    const base = usadas[0].p;

    // Celulas da planilha: estoque somado, primeiro codigo de barras,
    // preco da primeira linha da celula.
    const celulas = new Map(); // "hex|tam" -> { estoque, barcode, preco, linhas: [] }
    for (const l of usadas) {
      const ck = (l.cor ? l.cor.hex : '') + '|' + (l.tam || '');
      if (!celulas.has(ck)) celulas.set(ck, { estoque: 0, barcode: null, preco: l.p.price, linhas: [] });
      const c = celulas.get(ck);
      c.estoque += Number(l.p.stock_qty) || 0;
      if (!c.barcode && l.p.barcode) c.barcode = l.p.barcode;
      c.linhas.push(l.index);
    }

    const modelo = {
      chave,
      linhas: usadas.map((l) => l.index),
      posicoes: usadas.map((l) => l.k),
      p: {
        name: base.name,
        price: base.price,
        card_price: base.card_price,
        cost_price: base.cost_price,
        stock_qty: 0,
        stock_min: base.stock_min,
        barcode: null,
        sku: base.sku,
        category: base.category,
        color: null,
        size: null,
        unit: base.unit,
        brand: base.brand,
        description: base.description,
        ncm: base.ncm,
      },
      variantes: [],
    };

    // Matriz completa, como o PUT /variations.
    const eixoCor = comCor ? [...cores.values()] : [null];
    const eixoTam = comTam ? tamanhos : [null];
    for (const cor of eixoCor) {
      for (const tam of eixoTam) {
        const ck = (cor ? cor.hex : '') + '|' + (tam || '');
        const cel = celulas.get(ck);
        const preco = cel ? cel.preco : modelo.p.price;
        modelo.variantes.push({
          color_hex: cor ? cor.hex : null,
          color_name: cor ? cor.nome : null,
          size: tam,
          sku_suffix: skuSuffixFromAttrs(cor ? cor.hex : null, cor ? cor.nome : null, tam) || null,
          stock_qty: cel ? cel.estoque : 0,
          barcode: cel ? cel.barcode : null,
          price_override: preco !== modelo.p.price ? preco : null,
          linhas: cel ? cel.linhas : [],
        });
      }
    }
    modelo.p.stock_qty = modelo.variantes.reduce((a, v) => a + v.stock_qty, 0);
    for (const l of usadas) naGrade.add(l.k);
    modelos.push(modelo);

    // Avisos: o que a primeira linha decidiu pelas outras.
    const rotulo = { modelo: base.name, sku: base.sku || null, linhas: modelo.linhas };
    const diferentes = (campo, igual = iguais) => {
      const vals = [];
      for (const l of usadas) if (!vals.some((v) => igual(v, l.p[campo]))) vals.push(l.p[campo]);
      return vals.length > 1 ? vals : null;
    };
    const precos = diferentes('price');
    if (precos) {
      avisos.push({ tipo: 'preco_diferente', ...rotulo, valores: precos,
        mensagem: `${base.name}: linhas com preços diferentes. O produto fica com ${fmt(base.price)} e as variações de outro preço ficam com preço próprio.` });
    }
    const custos = diferentes('cost_price');
    if (custos) {
      avisos.push({ tipo: 'custo_diferente', ...rotulo, valores: custos,
        mensagem: `${base.name}: linhas com custos diferentes. Fica o custo da primeira linha${base.cost_price === null ? ' (vazio)' : ` (${fmt(base.cost_price)})`}.` });
    }
    const categorias = diferentes('category', (a, b) => chaveTexto(a) === chaveTexto(b));
    if (categorias) {
      avisos.push({ tipo: 'categoria_diferente', ...rotulo, valores: categorias,
        mensagem: `${base.name}: linhas com categorias diferentes. Fica "${base.category || 'sem categoria'}".` });
    }
    const nomes = diferentes('name', (a, b) => chaveTexto(a) === chaveTexto(b));
    if (nomes) {
      avisos.push({ tipo: 'nome_diferente', ...rotulo, valores: nomes,
        mensagem: `Código ${base.sku}: linhas com nomes diferentes. O produto fica com o nome "${base.name}".` });
    }
    const repetidas = [...celulas.values()].filter((c) => c.linhas.length > 1);
    if (repetidas.length) {
      avisos.push({ tipo: 'combinacao_repetida', ...rotulo, valores: repetidas.map((c) => c.linhas),
        mensagem: `${base.name}: a mesma cor e tamanho aparece em mais de uma linha. O estoque foi somado.` });
    }
    const semAmostra = [...cores.values()].filter((c) => !c.conhecida).map((c) => c.nome);
    if (semAmostra.length) {
      avisos.push({ tipo: 'cor_sem_amostra', ...rotulo, valores: semAmostra,
        mensagem: `${base.name}: ${semAmostra.join(', ')} sem amostra conhecida. O nome fica gravado; confira a amostra no produto.` });
    }
  }

  return { modelos, naGrade, erros, avisos };
}

function fmt(v) {
  if (v === null || v === undefined) return '';
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}

module.exports = { montarGrades, chaveDaGrade, lerCor, hexDoNome, MAX_EIXO };
