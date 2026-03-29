const fs = require('fs');
const path = require('path');

const FILES = [
  'tests/integration/barbershop.test.js',
  'tests/integration/barcode.test.js',
  'tests/integration/barcode.integration.test.js',
  'tests/integration/categorize.test.js',
  'tests/integration/companyAccess.test.js',
  'tests/integration/dental.test.js',
  'tests/integration/dentalSign.test.js',
  'tests/integration/dre.test.js',
  'tests/integration/exportReports.test.js',
  'tests/integration/fiscalObligations.test.js',
  'tests/integration/members.test.js',
  'tests/integration/obligations.test.js',
  'tests/integration/onboarding.test.js',
  'tests/integration/payroll.test.js',
  'tests/integration/pdv.test.js',
  'tests/integration/print.test.js',
];

const MOCK_LINE = `  db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess`;

let totalFixed = 0;

for (const file of FILES) {
  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) {
    console.log(`SKIP (not found): ${file}`);
    continue;
  }

  let content = fs.readFileSync(fullPath, 'utf8');
  let count = 0;

  // Pattern: find every "db.query.mockResolvedValueOnce" that is NOT already
  // preceded by the companyAccess mock on the previous line
  content = content.replace(
    /^(\s*)(db\.query\s*\.mockResolvedValueOnce\s*\()/gm,
    (match, indent, call, offset) => {
      // Check if the line before already has companyAccess mock
      const before = content.substring(0, offset);
      const lastNewline = before.lastIndexOf('\n');
      const prevLine = before.substring(before.lastIndexOf('\n', lastNewline - 1) + 1, lastNewline);
      if (prevLine.includes('companyAccess') || prevLine.includes("role: 'owner'")) {
        return match; // already fixed
      }
      count++;
      return `${indent}db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess\n${indent}${call}`;
    }
  );

  // Also handle: db.query\n  .mockResolvedValueOnce (multi-line)
  content = content.replace(
    /^(\s*)(db\.query\s*\n\s*\.mockResolvedValueOnce\s*\()/gm,
    (match, indent, call, offset) => {
      const before = content.substring(0, offset);
      const lastNewline = before.lastIndexOf('\n');
      const prevLine = before.substring(before.lastIndexOf('\n', lastNewline - 1) + 1, lastNewline);
      if (prevLine.includes('companyAccess') || prevLine.includes("role: 'owner'")) {
        return match;
      }
      count++;
      return `${indent}db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess\n${indent}${call}`;
    }
  );

  if (count > 0) {
    fs.writeFileSync(fullPath, content, 'utf8');
    totalFixed += count;
    console.log(`FIXED: ${file} (${count} mocks added)`);
  } else {
    console.log(`OK (no changes needed): ${file}`);
  }
}

console.log(`\nDone! ${totalFixed} mocks added total.`);
