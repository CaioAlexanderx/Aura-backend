// ============================================================
// QA — Teste de isolamento multi-tenant (B-01)
// Garante que usuário de uma empresa não acessa outra.
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET   = 'aura-test-secret-2026';
const companyA = '00000000-0000-0000-0000-000000000001';
const companyB = '00000000-0000-0000-0000-000000000002';
const userA    = 'user-aaaa-0000-0000-000000000001';
const userB    = 'user-bbbb-0000-0000-000000000002';

const tokenA = jwt.sign(
  { id: userA, role: 'client', plan: 'negocio' },
  SECRET, { expiresIn: '1h' }
);
const tokenB = jwt.sign(
  { id: userB, role: 'client', plan: 'negocio' },
  SECRET, { expiresIn: '1h' }
);

describe('requireCompanyAccess — isolamento multi-tenant', () => {
  test('200 — owner acessa própria empresa', async () => {
    // Mock: usuário A é owner da empresa A
    db.query
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }) // requireCompanyAccess
      .mockResolvedValueOnce({                              // listMembers
        rows: [
          { id: '1', status: 'active', is_active: true, role: 'owner' }
        ]
      });

    const res = await request(app)
      .get(`/api/v1/companies/${companyA}/members`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.members).toBeDefined();
  });

  test('403 — usuário B não acessa empresa A (IDOR bloqueado)', async () => {
    // Mock: usuário B não é owner nem member da empresa A
    db.query.mockResolvedValueOnce({ rows: [] }); // requireCompanyAccess retorna vazio

    const res = await request(app)
      .get(`/api/v1/companies/${companyA}/members`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Acesso negado/);
  });

  test('403 — membro sem role adequada não pode convidar', async () => {
    // Mock: usuário A é membro simples (role: 'member'), não owner/admin
    db.query.mockResolvedValueOnce({ rows: [{ role: 'member' }] });

    const res = await request(app)
      .post(`/api/v1/companies/${companyA}/members/invite`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'novo@empresa.com', role: 'member' });

    expect(res.status).toBe(403);
    expect(res.body.required_roles).toContain('owner');
  });

  test('200 — admin do sistema acessa qualquer empresa', async () => {
    const adminToken = jwt.sign(
      { id: 'admin-001', role: 'admin', plan: 'expansao' },
      SECRET, { expiresIn: '1h' }
    );
    // Admin não precisa de lookup de empresa
    db.query.mockResolvedValueOnce({
      rows: [{ id: '1', status: 'active', is_active: true, role: 'owner' }]
    });

    const res = await request(app)
      .get(`/api/v1/companies/${companyB}/members`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
  });

  test('401 — sem token retorna 401', async () => {
    const res = await request(app)
      .get(`/api/v1/companies/${companyA}/members`);
    expect(res.status).toBe(401);
  });
});

describe('barcode lookup — schema correto (B-02)', () => {
  test('200 — retorna stock_qty e is_active (não stock_quantity/active)', async () => {
    // Mock: requireCompanyAccess passa, depois lookup do produto
    db.query
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }) // requireCompanyAccess
      .mockResolvedValueOnce({                              // barcode lookup
        rows: [{
          id: 'prod-001',
          name: 'Produto Teste',
          price: 45.90,
          stock_qty: 10,    // ← nome correto do schema
          is_active: true,  // ← nome correto do schema
          barcode: '7891234567890',
          barcode_format: 'EAN-13',
        }]
      });

    const res = await request(app)
      .get(`/api/v1/companies/${companyA}/products/barcode/7891234567890`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.product.stock_qty).toBeDefined();
    expect(res.body.product.is_active).toBeDefined();
    // Garantir que os nomes errados não estão presentes
    expect(res.body.product.stock_quantity).toBeUndefined();
    expect(res.body.product.active).toBeUndefined();
  });

  test('404 — produto não encontrado retorna 404', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }) // requireCompanyAccess
      .mockResolvedValueOnce({ rows: [] });                  // produto não encontrado

    const res = await request(app)
      .get(`/api/v1/companies/${companyA}/products/barcode/9999999999999`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});
