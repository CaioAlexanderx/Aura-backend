// ============================================================
// QA — Testes de Integração: POST /companies/:id/coupons/validate
//
// E a consulta que o PDV faz ANTES de fechar a venda. Nao grava nada, mas
// e o que decide o que aparece na tela do lojista — e, no caso do cupom
// nominal, o que impede o cupom de aniversario de outro cliente de ser
// oferecido no balcao.
//
// Middleware: requireAuth + requireCompanyAccess consomem UMA db.query
// (via db.queryRetry, que o jest.setup.js delega pro mesmo jest.fn).
// Depois disso o handler faz UMA db.query pra buscar o cupom.
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio' }, SECRET, { expiresIn:'1h' })}` };

const ONTEM   = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const AMANHA  = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

// Cupom base: generico, ativo, sem limite, sem validade, sem minimo.
const cupom = (extra = {}) => ({
  id: 'coup1', code: 'CUPOM10', description: 'Teste',
  discount_type: 'percent', discount_value: 10,
  min_order_value: 0, max_uses: null, current_uses: 0,
  expires_at: null, customer_id: null, owner_name: null,
  source: 'manual', is_active: true, ...extra,
});

// companyAccess + SELECT do cupom, nessa ordem.
function arrange(rows) {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess
  db.query.mockResolvedValueOnce({ rows });                       // SELECT coupons
}

const validate = (body) => request(app)
  .post(`/api/v1/companies/${cid}/coupons/validate`)
  .set(auth).send(body);

describe('POST /companies/:id/coupons/validate — entrada', () => {
  test('400 — sem code', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess
    const res = await validate({ order_total: 100 });
    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatch(/obrigatorio/i);
  });

  test('401 — sem token', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/coupons/validate`)
      .send({ code: 'CUPOM10', order_total: 100 });
    expect(res.status).toBe(401);
  });

  test('valid:false — cupom nao encontrado', async () => {
    arrange([]);
    const res = await validate({ code: 'NAOEXISTE', order_total: 100 });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatch(/nao encontrado/i);
  });
});

describe('POST /companies/:id/coupons/validate — cupom generico valido', () => {
  test('percent — desconto e total corretos', async () => {
    arrange([cupom({ discount_type: 'percent', discount_value: 10 })]);
    const res = await validate({ code: 'CUPOM10', order_total: 250 });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.discount_amount).toBe(25);
    expect(res.body.final_total).toBe(225);
    expect(res.body.coupon_id).toBe('coup1');
  });

  test('percent — arredonda em 2 casas', async () => {
    arrange([cupom({ discount_type: 'percent', discount_value: 15 })]);
    const res = await validate({ code: 'CUPOM10', order_total: 33.33 });
    expect(res.body.valid).toBe(true);
    expect(res.body.discount_amount).toBe(5);      // 4.9995 -> 5
    expect(res.body.final_total).toBe(28.33);
  });

  test('fixed — desconto e total corretos', async () => {
    arrange([cupom({ discount_type: 'fixed', discount_value: 30 })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100 });
    expect(res.body.valid).toBe(true);
    expect(res.body.discount_amount).toBe(30);
    expect(res.body.final_total).toBe(70);
  });

  test('fixed MAIOR que o total — limita ao total, final_total 0', async () => {
    arrange([cupom({ discount_type: 'fixed', discount_value: 200 })]);
    const res = await validate({ code: 'CUPOM10', order_total: 80 });
    expect(res.body.valid).toBe(true);
    expect(res.body.discount_amount).toBe(80);
    expect(res.body.final_total).toBe(0);
  });
});

describe('POST /companies/:id/coupons/validate — cupom invalido', () => {
  test('min_order_value nao atingido', async () => {
    arrange([cupom({ min_order_value: 100 })]);
    const res = await validate({ code: 'CUPOM10', order_total: 50 });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatch(/Valor minimo/i);
  });

  test('min_order_value exatamente atingido — passa', async () => {
    arrange([cupom({ min_order_value: 100, discount_type: 'fixed', discount_value: 10 })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100 });
    expect(res.body.valid).toBe(true);
    expect(res.body.discount_amount).toBe(10);
  });

  test('expirado', async () => {
    arrange([cupom({ expires_at: ONTEM })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100 });
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatch(/expirado/i);
  });

  test('validade no futuro — passa', async () => {
    arrange([cupom({ expires_at: AMANHA })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100 });
    expect(res.body.valid).toBe(true);
  });

  test('esgotado (current_uses >= max_uses)', async () => {
    arrange([cupom({ max_uses: 3, current_uses: 3 })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100 });
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatch(/esgotado/i);
  });

  test('ainda com uso disponivel — passa', async () => {
    arrange([cupom({ max_uses: 3, current_uses: 2 })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100 });
    expect(res.body.valid).toBe(true);
  });
});

describe('POST /companies/:id/coupons/validate — cupom nominal (titularidade)', () => {
  const nominal = (extra = {}) => cupom({
    customer_id: 'cust-A', owner_name: 'Cleide milene', source: 'birthday', ...extra,
  });

  test('customer_id certo — valid:true', async () => {
    arrange([nominal({ discount_type: 'fixed', discount_value: 20 })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100, customer_id: 'cust-A' });
    expect(res.body.valid).toBe(true);
    expect(res.body.customer_id).toBe('cust-A');
    expect(res.body.discount_amount).toBe(20);
  });

  test('customer_id errado — valid:false + COUPON_CUSTOMER_MISMATCH', async () => {
    arrange([nominal()]);
    const res = await validate({ code: 'CUPOM10', order_total: 100, customer_id: 'cust-B' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error_code).toBe('COUPON_CUSTOMER_MISMATCH');
    expect(res.body.error).toContain('Cleide');
  });

  test('sem customer_id no body — valid:false + COUPON_REQUIRES_CUSTOMER', async () => {
    arrange([nominal()]);
    const res = await validate({ code: 'CUPOM10', order_total: 100 });
    expect(res.body.valid).toBe(false);
    expect(res.body.error_code).toBe('COUPON_REQUIRES_CUSTOMER');
    expect(res.body.error).toContain('Cleide');
  });

  test('cupom generico sem customer_id no body — segue valendo (nao-regressao)', async () => {
    arrange([cupom({ customer_id: null, source: 'manual' })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100 });
    expect(res.body.valid).toBe(true);
  });

  // ORDEM IMPORTA: titularidade e checada ANTES de validade/uso justamente
  // pra resposta nao vazar o estado do cupom alheio (se ja expirou, se ja
  // foi usado). Se alguem reordenar o handler, estes dois quebram.
  test('nominal de OUTRO cliente + expirado -> COUPON_CUSTOMER_MISMATCH, nao "expirado"', async () => {
    arrange([nominal({ expires_at: ONTEM })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100, customer_id: 'cust-B' });
    expect(res.body.valid).toBe(false);
    expect(res.body.error_code).toBe('COUPON_CUSTOMER_MISMATCH');
    expect(res.body.error).not.toMatch(/expirado/i);
  });

  test('nominal SEM cliente na venda + expirado -> COUPON_REQUIRES_CUSTOMER, nao "expirado"', async () => {
    arrange([nominal({ expires_at: ONTEM })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100 });
    expect(res.body.valid).toBe(false);
    expect(res.body.error_code).toBe('COUPON_REQUIRES_CUSTOMER');
    expect(res.body.error).not.toMatch(/expirado/i);
  });

  test('nominal de OUTRO cliente + esgotado -> COUPON_CUSTOMER_MISMATCH, nao "esgotado"', async () => {
    arrange([nominal({ max_uses: 1, current_uses: 1 })]);
    const res = await validate({ code: 'CUPOM10', order_total: 100, customer_id: 'cust-B' });
    expect(res.body.valid).toBe(false);
    expect(res.body.error_code).toBe('COUPON_CUSTOMER_MISMATCH');
    expect(res.body.error).not.toMatch(/esgotado/i);
  });
});
