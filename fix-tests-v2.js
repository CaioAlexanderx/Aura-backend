const fs = require('fs');

const OWNER_MOCK = "    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess";

// Simple find-and-replace fixes
const fixes = [

  // ══════════════════════════════════════════════════════════
  // barbershop.test.js — 7 testes sem mock
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/barbershop.test.js',
    find: "  test('retorna 400 sem name', async () => {\n    const res = await request(app).post",
    replace: "  test('retorna 400 sem name', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app).post"
  },
  {
    file: 'tests/integration/barbershop.test.js',
    find: "  test('retorna 400 sem price', async () => {\n    const res = await request(app).post",
    replace: "  test('retorna 400 sem price', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app).post"
  },
  {
    file: 'tests/integration/barbershop.test.js',
    find: "  test('retorna 400 sem professional_id', async () => {\n    const res = await request(app).post",
    replace: "  test('retorna 400 sem professional_id', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app).post"
  },
  {
    file: 'tests/integration/barbershop.test.js',
    find: "  test('retorna 400 sem customer_id nem customer_name', async () => {\n    const res = await request(app).post",
    replace: "  test('retorna 400 sem customer_id nem customer_name', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app).post"
  },
  {
    file: 'tests/integration/barbershop.test.js',
    find: "  test('cria agendamento com sucesso', async () => {",
    replace: "  test('cria agendamento com sucesso', async () => {\n" + OWNER_MOCK
  },
  {
    file: 'tests/integration/barbershop.test.js',
    find: "  test('retorna 400 sem customer_name', async () => {\n    const res = await request(app).post",
    replace: "  test('retorna 400 sem customer_name', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app).post"
  },
  {
    file: 'tests/integration/barbershop.test.js',
    find: "  test('retorna 400 sem customer_id', async () => {\n    const res = await request(app).post",
    replace: "  test('retorna 400 sem customer_id', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app).post"
  },

  // ══════════════════════════════════════════════════════════
  // dental.test.js — 2 testes sem mock
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/dental.test.js',
    find: "  test('retorna 400 sem full_name', async () => {\n    const res = await request(app).post",
    replace: "  test('retorna 400 sem full_name', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app).post"
  },
  {
    file: 'tests/integration/dental.test.js',
    find: "  test('retorna 400 sem consentimento LGPD', async () => {\n    const res = await request(app).post",
    replace: "  test('retorna 400 sem consentimento LGPD', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app).post"
  },

  // ══════════════════════════════════════════════════════════
  // pdv.test.js — 3 testes sem mock
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/pdv.test.js',
    find: "  test('400 \u2014 items vazio', async () => {\n    const res = await request(app)",
    replace: "  test('400 \u2014 items vazio', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app)"
  },
  {
    file: 'tests/integration/pdv.test.js',
    find: "  test('400 \u2014 items ausente', async () => {\n    const res = await request(app)",
    replace: "  test('400 \u2014 items ausente', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app)"
  },
  {
    file: 'tests/integration/pdv.test.js',
    find: "  test('409 \u2014 estoque insuficiente', async () => {",
    replace: "  test('409 \u2014 estoque insuficiente', async () => {\n" + OWNER_MOCK
  },

  // ══════════════════════════════════════════════════════════
  // categorize.test.js — 5 testes sem mock
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/categorize.test.js',
    find: "  test('400 \u2014 descriptions ausente', async () => {\n    const res = await request(app)",
    replace: "  test('400 \u2014 descriptions ausente', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app)"
  },
  {
    file: 'tests/integration/categorize.test.js',
    find: "  test('400 \u2014 array vazio', async () => {\n    const res = await request(app)",
    replace: "  test('400 \u2014 array vazio', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app)"
  },
  {
    file: 'tests/integration/categorize.test.js',
    find: "  test('400 \u2014 mais de 50 descri\u00e7\u00f5es', async () => {",
    replace: "  test('400 \u2014 mais de 50 descri\u00e7\u00f5es', async () => {\n" + OWNER_MOCK
  },
  {
    file: 'tests/integration/categorize.test.js',
    find: "  test('200 \u2014 fallback gracioso sem ANTHROPIC_API_KEY', async () => {",
    replace: "  test('200 \u2014 fallback gracioso sem ANTHROPIC_API_KEY', async () => {\n" + OWNER_MOCK
  },
  {
    file: 'tests/integration/categorize.test.js',
    find: "  test('200 \u2014 note de revis\u00e3o presente na resposta', async () => {",
    replace: "  test('200 \u2014 note de revis\u00e3o presente na resposta', async () => {\n" + OWNER_MOCK
  },

  // ══════════════════════════════════════════════════════════
  // onboarding.test.js — 3 testes sem mock
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/onboarding.test.js',
    find: "  test('400 \u2014 tax_regime inv\u00e1lido', async () => {",
    replace: "  test('400 \u2014 tax_regime inv\u00e1lido', async () => {\n" + OWNER_MOCK
  },
  {
    file: 'tests/integration/onboarding.test.js',
    find: "  test('400 \u2014 tax_regime ausente', async () => {",
    replace: "  test('400 \u2014 tax_regime ausente', async () => {\n" + OWNER_MOCK
  },
  {
    file: 'tests/integration/onboarding.test.js',
    find: "  test('400 \u2014 vertical inv\u00e1lido', async () => {",
    replace: "  test('400 \u2014 vertical inv\u00e1lido', async () => {\n" + OWNER_MOCK
  },

  // ══════════════════════════════════════════════════════════
  // fiscalObligations.test.js — 2 testes sem mock
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/fiscalObligations.test.js',
    find: "  test('400 \u2014 filtro inv\u00e1lido', async () => {\n    const res = await request(app)",
    replace: "  test('400 \u2014 filtro inv\u00e1lido', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app)"
  },
  {
    file: 'tests/integration/fiscalObligations.test.js',
    find: "  test('400 \u2014 sem checkpoint_done', async () => {",
    replace: "  test('400 \u2014 sem checkpoint_done', async () => {\n" + OWNER_MOCK
  },

  // ══════════════════════════════════════════════════════════
  // obligations.test.js — 2 testes sem mock
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/obligations.test.js',
    find: "  test('filter inv\u00e1lido retorna 400', async () => {\n    const res = await request(app)",
    replace: "  test('filter inv\u00e1lido retorna 400', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app)"
  },
  {
    file: 'tests/integration/obligations.test.js',
    find: "  test('retorna 400 sem reference_month', async () => {\n    const res = await request(app)",
    replace: "  test('retorna 400 sem reference_month', async () => {\n" + OWNER_MOCK + "\n    const res = await request(app)"
  },

  // ══════════════════════════════════════════════════════════
  // print.test.js — mockSaleQueries precisa de mock ANTES (ALL occurrences)
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/print.test.js',
    find: "    mockSaleQueries(db);\n    const res = await request(app).get",
    replace: OWNER_MOCK + "\n    mockSaleQueries(db);\n    const res = await request(app).get",
    all: true
  },
  {
    file: 'tests/integration/print.test.js',
    find: "  test('retorna 404 se venda n\u00e3o encontrada', async () => {",
    replace: "  test('retorna 404 se venda n\u00e3o encontrada', async () => {\n" + OWNER_MOCK
  },

  // ══════════════════════════════════════════════════════════
  // exportReports.test.js — plano essencial
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/exportReports.test.js',
    find: "  test('403 \u2014 plano essencial n\u00e3o tem acesso', async () => {",
    replace: "  test('403 \u2014 plano essencial n\u00e3o tem acesso', async () => {\n" + OWNER_MOCK
  },

  // ══════════════════════════════════════════════════════════
  // dre.test.js — plano essencial
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/dre.test.js',
    find: "  test('403 \u2014 plano essencial n\u00e3o tem acesso ao DRE', async () => {",
    replace: "  test('403 \u2014 plano essencial n\u00e3o tem acesso ao DRE', async () => {\n" + OWNER_MOCK
  },

  // ══════════════════════════════════════════════════════════
  // TIPO 2: toHaveBeenCalledTimes(N) → N+1
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/onboarding.test.js',
    find: "    // 4 queries: select, update, session, audit\n    expect(db.query).toHaveBeenCalledTimes(4);",
    replace: "    // 5 queries: companyAccess + select, update, session, audit\n    expect(db.query).toHaveBeenCalledTimes(5);"
  },
  {
    file: 'tests/integration/categorize.test.js',
    find: "    // Deve ter chamado UPDATE (segunda query)\n    expect(db.query).toHaveBeenCalledTimes(2);",
    replace: "    // Deve ter chamado UPDATE (companyAccess + select + update)\n    expect(db.query).toHaveBeenCalledTimes(3);"
  },

  // ══════════════════════════════════════════════════════════
  // TIPO 3: dentalSign.test.js — rotas públicas com mock ordering
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/dentalSign.test.js',
    find: "  test('retorna status signed ap\u00f3s assinatura registrada', async () => {",
    replace: "  test('retorna status signed ap\u00f3s assinatura registrada', async () => {\n    db.query.mockReset();"
  },
  {
    file: 'tests/integration/dentalSign.test.js',
    find: "  test('retorna 404 com token inexistente', async () => {",
    replace: "  test('retorna 404 com token inexistente', async () => {\n    db.query.mockReset();"
  },

  // ══════════════════════════════════════════════════════════
  // companyAccess.test.js — barcode lookup mock ordering
  // ══════════════════════════════════════════════════════════
  {
    file: 'tests/integration/companyAccess.test.js',
    find: "  test('200 \u2014 retorna stock_qty e is_active (n\u00e3o stock_quantity/active)', async () => {",
    replace: "  test('200 \u2014 retorna stock_qty e is_active (n\u00e3o stock_quantity/active)', async () => {\n    db.query.mockReset();"
  },
  {
    file: 'tests/integration/companyAccess.test.js',
    find: "  test('404 \u2014 produto n\u00e3o encontrado retorna 404', async () => {",
    replace: "  test('404 \u2014 produto n\u00e3o encontrado retorna 404', async () => {\n    db.query.mockReset();"
  },

];

let totalFixes = 0;

for (const fix of fixes) {
  let content;
  try {
    content = fs.readFileSync(fix.file, 'utf8');
  } catch (e) {
    console.log('SKIP (file not found): ' + fix.file);
    continue;
  }

  if (!content.includes(fix.find)) {
    console.log('SKIP (pattern not found): ' + fix.file + ' -- "' + fix.find.slice(0, 60).replace(/\n/g, '\\n') + '..."');
    continue;
  }

  let updated;
  if (fix.all) {
    const count = content.split(fix.find).length - 1;
    updated = content.split(fix.find).join(fix.replace);
    totalFixes += count;
    console.log('FIXED (' + count + 'x): ' + fix.file);
  } else {
    updated = content.replace(fix.find, fix.replace);
    totalFixes++;
    console.log('FIXED: ' + fix.file);
  }

  fs.writeFileSync(fix.file, updated, 'utf8');
}

console.log('\nDone! ' + totalFixes + ' fixes applied.');
