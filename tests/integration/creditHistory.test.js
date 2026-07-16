// ============================================================
// B1 — Testes: GET /companies/:id/credit/customers/:cid/history
// Timeline de historico do cliente de crediario
// Sequencia de queries mockadas:
//   1. companyAccess  2. crediario_enabled  3. customer
//   4. transactions   5. sale_items (so se houver purchase na pagina)
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET     = 'aura-test-secret-2026';
const companyId  = '00000000-0000-0000-0000-000000000001';
const customerId = '00000000-0000-0000-0000-000000000002';
const saleId     = '00000000-0000-0000-0000-00000000aa01';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

const base = `/api/v1/companies/${companyId}/credit/customers/${customerId}/history`;

const TX = (over = {}) => ({
  id: '00000000-0000-0000-0000-0000000000f1',
  sale_id: null,
  type: 'payment',
  amount: '50.00',
  payment_method: 'pix',
  notes: null,
  created_at: new Date('2026-06-10T15:00:00.000Z'),
  account_id: null,
  source: 'manual',
  ...over,
});

function mockPrelude() {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });   // companyAccess
  db.query.mockResolvedValueOnce({ rows: [{ enabled: 'true' }] }); // crediario_enabled
  db.query.mockResolvedValueOnce({ rows: [{ id: customerId }] });  // customer existe
}

describe('GET /companies/:id/credit/customers/:cid/history', () => {
  test('200 — mapeia purchase (com itens), payment negativo, exchange_credit e manual_debit', async () => {
    mockPrelude();
    db.query.mockResolvedValueOnce({ rows: [ // transactions (created_at DESC)
      TX({ id: '00000000-0000-0000-0000-0000000000e4', type: 'debit', sale_id: saleId, amount: '150.00', payment_method: null, source: 'sale', created_at: new Date('2026-06-10T15:00:00.000Z') }),
      TX({ id: '00000000-0000-0000-0000-0000000000e3', type: 'payment', amount: '50.00', payment_method: 'pix', created_at: new Date('2026-06-09T15:00:00.000Z') }),
      TX({ id: '00000000-0000-0000-0000-0000000000e2', type: 'payment', amount: '30.00', payment_method: 'crediario_credito', source: 'sale', created_at: new Date('2026-06-08T15:00:00.000Z') }),
      TX({ id: '00000000-0000-0000-0000-0000000000e1', type: 'debit', amount: '80.00', payment_method: null, notes: 'Lancamento manual', created_at: new Date('2026-06-07T15:00:00.000Z') }),
    ]});
    db.query.mockResolvedValueOnce({ rows: [ // sale_items do purchase
      { sale_id: saleId, product_name: 'Tenis Runner', quantity: '1', unit_price: '150.00', total_price: '150.00' },
    ]});

    const res = await request(app).get(base).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(4);
    expect(res.body.next_cursor).toBeNull();

    const [purchase, payment, exchange, manual] = res.body.events;

    expect(purchase.type).toBe('purchase');
    expect(purchase.amount).toBe(150);
    expect(purchase.sale_id).toBe(saleId);
    expect(purchase.items).toEqual([
      { product_name: 'Tenis Runner', quantity: 1, unit_price: 150, total: 150 },
    ]);
    expect(purchase.payment).toBeNull();
    expect(purchase.meta.source).toBe('sale');

    expect(payment.type).toBe('payment');
    expect(payment.amount).toBe(-50);
    expect(payment.payment).toEqual({ method: 'pix' });
    expect(payment.items).toBeNull();

    expect(exchange.type).toBe('exchange_credit');
    expect(exchange.amount).toBe(-30);
    expect(exchange.payment).toBeNull();

    expect(manual.type).toBe('manual_debit');
    expect(manual.amount).toBe(80);
    expect(manual.items).toBeNull();
    expect(manual.meta.notes).toBe('Lancamento manual');
  });

  test('200 — paginacao: limit cheio gera next_cursor decodificavel (created_at|id)', async () => {
    mockPrelude();
    // limit=2 -> rota pede 3; devolvendo 3, ha proxima pagina
    db.query.mockResolvedValueOnce({ rows: [
      TX({ id: '00000000-0000-0000-0000-0000000000c3', created_at: new Date('2026-06-10T12:00:00.000Z') }),
      TX({ id: '00000000-0000-0000-0000-0000000000c2', created_at: new Date('2026-06-09T12:00:00.000Z') }),
      TX({ id: '00000000-0000-0000-0000-0000000000c1', created_at: new Date('2026-06-08T12:00:00.000Z') }),
    ]});
    // sem purchase na pagina -> sem query de sale_items

    const res = await request(app).get(`${base}?limit=2`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.next_cursor).not.toBeNull();
    const decoded = Buffer.from(res.body.next_cursor, 'base64').toString('utf8');
    expect(decoded).toBe('2026-06-09T12:00:00.000Z|00000000-0000-0000-0000-0000000000c2');
  });

  test('400 — cursor invalido', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });   // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ enabled: 'true' }] }); // crediario_enabled
    const res = await request(app).get(`${base}?cursor=nao-e-base64-valido`).set(auth);
    expect(res.status).toBe(400);
  });

  test('400 — types com valor desconhecido', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ enabled: 'true' }] });
    const res = await request(app).get(`${base}?types=purchase,banana`).set(auth);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/banana/);
  });

  test('403 — crediario desabilitado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ enabled: 'false' }] });
    const res = await request(app).get(base).set(auth);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CREDIARIO_DISABLED');
  });

  test('404 — cliente de outra empresa', async () => {
    mockPrelude(); // sobrescreve o 3o mock abaixo
    db.query.mockReset();
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ enabled: 'true' }] });
    db.query.mockResolvedValueOnce({ rows: [] }); // customer nao encontrado
    const res = await request(app).get(base).set(auth);
    expect(res.status).toBe(404);
  });

  test('401 — sem token', async () => {
    const res = await request(app).get(base);
    expect(res.status).toBe(401);
  });
});
