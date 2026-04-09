#!/usr/bin/env node
// Fix: db.pool.connect() → db.connect() in importData.js
// Run: node scripts/fix-import-pool.js

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'routes', 'importData.js');
const content = fs.readFileSync(file, 'utf-8');

const count = (content.match(/db\.pool\.connect\(\)/g) || []).length;
console.log(`Found ${count} occurrences of db.pool.connect()`);

if (count === 0) {
  console.log('Nothing to fix — already correct.');
  process.exit(0);
}

const fixed = content.replace(/db\.pool\.connect\(\)/g, 'db.connect()');
fs.writeFileSync(file, fixed, 'utf-8');

const verify = (fixed.match(/db\.connect\(\)/g) || []).length;
console.log(`Replaced → ${verify} occurrences of db.connect() now present`);
console.log('Fixed! Now run: git add . && git commit -m "bugfix: db.pool.connect → db.connect" && git push');
