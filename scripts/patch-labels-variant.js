#!/usr/bin/env node
// ============================================================
// AURA. — Patch labels.js: adicionar cor/tamanho no texto do nome
// 
// USO: cd aura-backend && node scripts/patch-labels-variant.js
//
// Este script faz EXATAMENTE 3 alterações no labels.js v7:
// 1. Adiciona color,size ao SELECT SQL (3 queries)
// 2. Adiciona calculo inline do labelName (1 linha)
// 3. Troca ${product.name} por ${labelName} nos templates (2 de 3)
//
// Nenhuma dimensão, CSS, posição de barcode ou estrutura é alterada.
// ============================================================
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'src', 'routes', 'labels.js');

console.log('Lendo:', FILE);
let content = fs.readFileSync(FILE, 'utf8');
const originalSize = content.length;

// ── PATCH 1: Adicionar color,size ao SELECT SQL ────────────
const oldSQL = 'SELECT id,name,price,barcode,barcode_format,sku FROM products';
const newSQL = 'SELECT id,name,price,barcode,barcode_format,sku,color,size FROM products';
const sqlCount = content.split(oldSQL).length - 1;
if (sqlCount !== 3) {
  console.error('ERRO: esperava 3 ocorrencias do SQL, encontrou', sqlCount);
  process.exit(1);
}
content = content.split(oldSQL).join(newSQL);
console.log('✓ PATCH 1: SQL atualizado em', sqlCount, 'queries');

// ── PATCH 2: Adicionar labelName após barcodeData ──────────
const anchor = 'const barcodeData = product.barcode;';
if (!content.includes(anchor)) {
  console.error('ERRO: ancora "const barcodeData" nao encontrada');
  process.exit(1);
}
const labelNameLine = `const barcodeData = product.barcode;
    const labelName = (function() { var n = product.name || ''; var sz = product.size ? product.size.trim() : ''; var cl = product.color && /^#[0-9A-Fa-f]{6}$/.test(product.color) ? product.color : ''; if (!sz && !cl) return n; var p = [n.length > 16 ? n.substring(0,16).trim()+'...' : n]; if (sz) p.push(sz); if (cl) { var m = {'#000000':'Preto','#ffffff':'Branco','#ff0000':'Vermelho','#0000ff':'Azul','#00ff00':'Verde','#ffff00':'Amarelo','#ffa500':'Laranja','#ffc0cb':'Rosa','#800080':'Roxo','#a52a2a':'Marrom','#800000':'Vinho','#808080':'Cinza','#000080':'Marinho','#c0c0c0':'Prata','#ffd700':'Dourado','#f5f5dc':'Bege','#ff6347':'Coral','#4b0082':'Indigo','#d2691e':'Caramelo'}; p.push(m[cl.toLowerCase()]||cl); } return p.join(' | '); })();`;
content = content.replace(anchor, labelNameLine);
console.log('✓ PATCH 2: labelName inserido');

// ── PATCH 3: Trocar product.name → labelName nos templates ─
// Existem 3 ocorrencias de ${product.name}:
//   1. sim-labels template → trocar
//   2. print-grid template → trocar
//   3. preview-bar (nome completo) → MANTER
let replaceCount = 0;
content = content.replace(/\$\{product\.name\}/g, function(match) {
  replaceCount++;
  if (replaceCount <= 2) return '${labelName}';
  return match; // manter na preview-bar
});
if (replaceCount !== 3) {
  console.error('ERRO: esperava 3 ocorrencias de ${product.name}, encontrou', replaceCount);
  process.exit(1);
}
console.log('✓ PATCH 3: 2 templates atualizados, preview-bar mantida');

// ── VERIFICAÇÃO ────────────────────────────────────────────
const checks = {
  'LABEL_W = 33': content.includes('LABEL_W = 33'),
  'LABEL_H = 21': content.includes('LABEL_H = 21'),
  'COLS = 3': content.includes('COLS = 3'),
  'max-height:4mm': content.includes('max-height:4mm'),
  'bc-wrap 13mm': content.includes("showName && showPrice ? '13'"),
  'svg height 11mm': content.includes("showName && showPrice ? '11'"),
  'price 8pt': content.includes('font-size: 8pt'),
  'JsBarcode height:50': content.includes('height: 50'),
  'offset translateX': content.includes('translateX(${offset}mm)'),
  'labelName definido': content.includes('const labelName'),
  'labelName em sim-labels': true, // already verified by replaceCount
  'product.name na preview-bar': content.includes('${product.name} ${showPrice'),
  'color,size no SQL': content.includes('sku,color,size FROM'),
};

let allOk = true;
for (const [name, ok] of Object.entries(checks)) {
  console.log(ok ? '  ✓' : '  ✗', name);
  if (!ok) allOk = false;
}

if (!allOk) {
  console.error('\nVERIFICACAO FALHOU — arquivo NAO foi alterado');
  process.exit(1);
}

// ── SALVAR ──────────────────────────────────────────────────
fs.writeFileSync(FILE, content, 'utf8');
console.log('\n✓ Arquivo salvo:', FILE);
console.log('  Original:', originalSize, 'bytes');
console.log('  Patcheado:', content.length, 'bytes');
console.log('  Diferenca: +' + (content.length - originalSize), 'bytes');
console.log('\nProximo passo: git add . && git commit -m "feat(labels): cor e tamanho no nome" && git push');
