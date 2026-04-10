#!/usr/bin/env node
// Fix: 'Preco de custo' overwrites 'Preco de venda' because both match 'preco'
// Solution: add specific aliases 'preco de venda' and 'preco de custo'
// Run: node scripts/fix-import-price-mapping.js

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'routes', 'importData.js');
let content = fs.readFileSync(file, 'utf-8');
let changes = 0;

// Fix price aliases: add 'preco de venda' as first alias (most specific)
if (content.includes("price:      ['preco',")) {
  content = content.replace(
    /price:\s*\[.*?\],/,
    "price:      ['preco de venda', 'preco venda', 'preco', 'pre\u00e7o', 'price', 'valor venda', 'valor'],"
  );
  changes++;
  console.log('Fixed price aliases: added preco de venda');
}

// Fix cost_price aliases: add 'preco de custo' as first alias
if (content.includes("cost_price: ['custo',")) {
  content = content.replace(
    /cost_price:\s*\[.*?\],/,
    "cost_price: ['preco de custo', 'preco custo', 'pre\u00e7o custo', 'custo', 'cost', 'cost_price', 'valor custo'],"
  );
  changes++;
  console.log('Fixed cost_price aliases: added preco de custo');
}

// CRITICAL FIX: change field iteration order so cost_price is checked BEFORE price
// This prevents 'preco' from catching 'preco de custo' columns
// Move cost_price above price in PRODUCT_FIELDS
const oldOrder = /const PRODUCT_FIELDS = \{[\s\S]*?name:.*?price:.*?cost_price:/;
if (oldOrder.test(content)) {
  // Swap price and cost_price lines
  const priceLineMatch = content.match(/(  price:\s*\[.*?\],\n)/);
  const costLineMatch = content.match(/(  cost_price:\s*\[.*?\],\n)/);
  if (priceLineMatch && costLineMatch) {
    const priceLine = priceLineMatch[1];
    const costLine = costLineMatch[1];
    // Put cost_price BEFORE price so it matches first
    content = content.replace(priceLine + costLine, costLine + priceLine);
    changes++;
    console.log('Fixed field order: cost_price now checked before price');
  }
}

if (changes === 0) {
  console.log('No changes needed or patterns not found. Check manually.');
} else {
  fs.writeFileSync(file, content, 'utf-8');
  console.log(`\n${changes} fixes applied. Now run:`);
  console.log('  git add . && git commit -m "bugfix: price/cost mapping overlap" && git push');
}
