// ============================================================
// QA-03 — Testes de Integração: CORE-05 Exportação PDF/CSV
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET  = 'aura-test-secret-2026';
const cid     = '00000000-0000-0000-0000-000000000001';
const authNeg = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio' },   SECRET, { expiresIn:'1h' })}` };
const authExp = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'expansao' },  SECRET, { expiresIn:'1h' })}` };
const authEss = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'essencial' }, SECRET, { expiresIn:'1h' })}` };

const mockCompany = { legal_name:'Empresa Teste Ltda', trade_name:'Empresa Teste', cnpj:'12.345.678/0001-90' };

// ─── DRE ─────────────────────────────────────────────────────
describe('GET /companies/:id/export/dre', () => {
  test('200 HTML — DRE padrão', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })   // getCompany
      .mockResolvedValueOnce({ rows: [              // transactions
        { type:'income',  category:'venda',   amount:'5000.00', description:'Venda' },
        { type:'expense', category:'aluguel', amount:'1500.00', description:'Aluguel' },
      ]});
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/export/dre`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('DRE Gerencial');
    expect(res.text).toContain('aura.');
    expect(res.text).toContain('window.print()');
  });

  test('200 CSV — DRE em formato CSV com BOM UTF-8', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: [
        { type:'income', category:'venda', amount:'3000.00', description:'Venda' },
      ]});
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/export/dre?format=csv`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/DRE.*\.csv/);
    // CSV deve começar com BOM UTF-8
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);
  });

  test('200 CSV — cabeçalhos corretos', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/export/dre?format=csv`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Tipo');
    expect(res.text).toContain('Categoria');
    expect(res.text).toContain('Total');
  });

  test('401 — sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/export/dre`);
    expect(res.status).toBe(401);
  });
});

// ─── Vendas ──────────────────────────────────────────────────
describe('GET /companies/:id/export/sales', () => {
  const mockSales = [
    { id:'s1', created_at: new Date().toISOString(), total_amount:'150.00',
      discount_amount:'0', payment_method:'pix', customer_name:'João', seller_name:'Ana', item_count:'3' },
  ];

  test('200 HTML — relatório de vendas', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: mockSales });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/export/sales`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Relatório de Vendas');
    expect(res.text).toContain('João');
    expect(res.text).toContain('150');
  });

  test('200 CSV — relatório de vendas', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: mockSales });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/export/sales?format=csv`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('Data');
    expect(res.text).toContain('Cliente');
  });

  test('401 — sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/export/sales`);
    expect(res.status).toBe(401);
  });
});

// ─── Folha ───────────────────────────────────────────────────
describe('GET /companies/:id/export/payroll', () => {
  const mockPayroll = [
    { employee_name:'Maria Silva', role:'Caixa', gross_salary:'2000.00',
      inss_employee:'157.23', irrf:'0', fgts:'160.00', net_salary:'1842.77',
      other_deductions:'0', other_additions:'0' },
  ];

  test('200 HTML — folha de pagamento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: mockPayroll });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/export/payroll?period=2026-03`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Folha de Pagamento');
    expect(res.text).toContain('Maria Silva');
    expect(res.text).toContain('FGTS');
  });

  test('200 CSV — folha de pagamento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: mockPayroll });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/export/payroll?period=2026-03&format=csv`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Funcionário');
    expect(res.text).toContain('INSS');
    expect(res.text).toContain('Salário Líquido');
  });

  test('401 — sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/export/payroll`);
    expect(res.status).toBe(401);
  });
});

// ─── Pró-labore (plano Negócio+) ─────────────────────────────
describe('GET /companies/:id/export/prolabore', () => {
  const mockProlabore = [
    { reference_month:'2026-03-01', amount:'3000.00', inss_amount:'330.00',
      net_amount:'2670.00', fator_r_result:'28.5', gross_revenue:'10526.00' },
  ];

  test('200 CSV — pró-labore (plano negocio)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: mockProlabore });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/export/prolabore?format=csv&months=6`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Pró-labore');
    expect(res.text).toContain('Fator R');
  });

  test('200 HTML — pró-labore', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: mockProlabore });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/export/prolabore?format=pdf`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Pró-labore');
    expect(res.text).toContain('Fator R');
  });

  test('403 — plano essencial não tem acesso', async () => {
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/export/prolabore`)
      .set(authEss);
    expect(res.status).toBe(403);
  });

  test('401 — sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/export/prolabore`);
    expect(res.status).toBe(401);
  });
});
