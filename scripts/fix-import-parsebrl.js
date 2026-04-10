#!/usr/bin/env node
// Fix parseBRL in importData.js to handle both dot-decimal (49.90) and comma-decimal (49,90)
// Also fix ambiguous field mapping (SKU mapped as barcode, etc)
// Run: node scripts/fix-import-parsebrl.js

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'routes', 'importData.js');
let content = fs.readFileSync(file, 'utf-8');

// 1. Fix parseBRL: handle both dot-decimal and comma-decimal
const oldParseBRL = `function parseBRL(value) {
  if (!value) return null;
  const clean = String(value)
    .replace(/[R$\\s]/g, '')
    .replace(/\\./g, '')
    .replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}`;

const newParseBRL = `function parseBRL(value) {
  if (!value) return null;
  let clean = String(value).replace(/[R$\\s]/g, '').trim();
  if (!clean) return null;
  // Both dot and comma present: Brazilian format (1.234,56)
  if (clean.includes(',') && clean.includes('.')) {
    clean = clean.replace(/\\./g, '').replace(',', '.');
  } else if (clean.includes(',')) {
    // Comma only: comma is decimal (49,90)
    clean = clean.replace(',', '.');
  }
  // Dot only: dot is decimal (49.90) - leave as-is
  const n = parseFloat(clean);
  return isNaN(n) || n < 0 ? null : n;
}`;

if (content.includes("replace(/\\./g, '')\n    .replace(',', '.')")) {
  content = content.replace(oldParseBRL, newParseBRL);
  console.log('Fixed parseBRL - now handles both 49.90 and 49,90');
} else {
  // Try a more flexible replacement
  const regex = /function parseBRL\(value\)[\s\S]*?return isNaN\(n\) \? null : n;\s*\}/;
  if (regex.test(content)) {
    content = content.replace(regex, newParseBRL);
    console.log('Fixed parseBRL (regex match)');
  } else {
    console.log('WARN: Could not find parseBRL to replace. Manual fix needed.');
  }
}

// 2. Fix PRODUCT_FIELDS to avoid ambiguous mapping
// Problem: 'codigo' matches both SKU and barcode columns
// Fix: reorder aliases to be more specific, add full header matches
const oldBarcode = "barcode:    ['codigo barras', 'c\u00f3digo barras', 'ean', 'barcode', 'gtin', 'codigo', 'c\u00f3digo'],";
const newBarcode = "barcode:    ['codigo de barras', 'codigo barras', 'c\u00f3digo barras', 'ean', 'barcode', 'gtin'],";

if (content.includes("'gtin', 'codigo', 'c")) {
  content = content.replace(
    /barcode:\s*\[.*?\],/,
    "barcode:    ['codigo de barras', 'codigo barras', 'c\u00f3digo barras', 'ean', 'barcode', 'gtin'],"
  );
  console.log('Fixed barcode aliases - removed ambiguous \'codigo\' alias');
} else {
  console.log('WARN: barcode aliases not found for fix');
}

// 3. Fix stock_qty aliases to not catch 'estoque minimo'
// Problem: 'estoque' matches both 'Estoque atual' and 'Estoque minimo'
// The suggestMapping checks includes() so 'estoque' matches both
// Fix: use more specific aliases
const oldStock = /stock_qty:\s*\[.*?\],/;
if (oldStock.test(content)) {
  content = content.replace(
    oldStock,
    "stock_qty:  ['estoque atual', 'estoque', 'quantidade', 'qty', 'stock', 'qtd', 'saldo'],"
  );
  console.log('Fixed stock_qty aliases - \'estoque atual\' first for priority');
}

// 4. Fix suggestMapping to prefer exact matches over partial includes
// Replace the matching logic to use startsWith for better precision
const oldSuggest = /if \(aliases\.some\(a => normalized\.includes\(a\) \|\| a\.includes\(normalized\)\)\)/;
if (oldSuggest.test(content)) {
  content = content.replace(
    oldSuggest,
    'if (aliases.some(a => normalized === a || normalized.startsWith(a + " ") || normalized.startsWith(a + "(") || normalized.endsWith(" " + a) || (a.length >= 4 && normalized.includes(a))))'
  );
  console.log('Fixed suggestMapping - uses smarter matching (exact > startsWith > includes for 4+ chars)');
}

fs.writeFileSync(file, content, 'utf-8');

// Verify
const final = fs.readFileSync(file, 'utf-8');
console.log('');
console.log('Verifications:');
console.log('  parseBRL handles dot-decimal:', final.includes('Dot only: dot is decimal') ? 'OK' : 'WARN');
console.log('  barcode no ambiguous codigo:', !final.includes("'gtin', 'codigo',") ? 'OK' : 'WARN');
console.log('');
console.log('Done! Now run:');
console.log('  git add . && git commit -m "bugfix: parseBRL + mapping ambiguity" && git push');
