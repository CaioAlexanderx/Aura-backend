// ============================================================
// AURA. -- Testes: termos da venda por loja (p-207, 23/11/2026)
//
// O que estes testes travam:
//   1. GET /otica/settings devolve sale_terms ('' por padrao): e a chave
//      que diz ao app que o servidor ja guarda os termos.
//   2. PUT grava o texto da loja COM as quebras de linha (so normaliza
//      \r\n, pontas e linhas vazias em excesso).
//   3. PUT com texto longo demais -> 400 TERMOS_LONGOS, nada gravado.
//   4. PUT com tipo errado -> 400 field sale_terms.
//   5. Em branco apaga (a folha sai sem o quadro).
//   6. Gate da otica na escrita (403 OTICA_DISABLED).
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const oticaRouter = require('../../src/routes/otica');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => { jest.resetAllMocks(); });

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

const app = express();
app.use(express.json());
const scoped = express.Router({ mergeParams: true });
scoped.use(requireAuth);
scoped.use(requireCompanyAccess());
scoped.use('/otica', oticaRouter);
app.use('/api/v1/companies/:id', scoped);

function mockDb({ otica = 'true', saved = {} } = {}) {
  let atual = { ...saved };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/pdv_settings->>'otica_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled: otica }] });
    if (/SELECT otica_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ otica_settings: atual }] });
    if (/UPDATE companies[\s\S]*otica_settings/i.test(s)) {
      atual = { ...atual, ...JSON.parse(params[0]) };
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    return Promise.resolve({ rows: [] });
  });
}
const updates = () => db.query.mock.calls.filter((c) => /UPDATE companies[\s\S]*otica_settings/i.test(String(c[0])));
const put = (body) => request(app).put(`/api/v1/companies/${cid}/otica/settings`).set(adminAuth).send(body);

describe('termos da venda em /otica/settings', () => {
  it('GET devolve sale_terms vazio por padrao', async () => {
    mockDb();
    const r = await request(app).get(`/api/v1/companies/${cid}/otica/settings`).set(adminAuth);
    expect(r.status).toBe(200);
    expect(r.body.settings.sale_terms).toBe('');
  });

  it('PUT grava o texto com as quebras de linha', async () => {
    mockDb();
    const texto = '  Prazo de entrega: 7 dias uteis.\r\n\r\n\r\n\r\nLente sob encomenda nao tem troca.   \n';
    const r = await put({ settings: { sale_terms: texto } });
    expect(r.status).toBe(200);
    expect(r.body.settings.sale_terms).toBe('Prazo de entrega: 7 dias uteis.\n\nLente sob encomenda nao tem troca.');
    expect(JSON.parse(updates()[0][1][0])).toEqual({ sale_terms: 'Prazo de entrega: 7 dias uteis.\n\nLente sob encomenda nao tem troca.' });
  });

  it('PUT com texto longo demais -> 400 TERMOS_LONGOS e nada gravado', async () => {
    mockDb();
    const r = await put({ sale_terms: 'a'.repeat(4001) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('TERMOS_LONGOS');
    expect(r.body.field).toBe('sale_terms');
    expect(updates()).toHaveLength(0);
  });

  it('PUT com tipo errado -> 400', async () => {
    mockDb();
    const r = await put({ sale_terms: { texto: 'x' } });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe('sale_terms');
  });

  it('em branco (ou null) apaga', async () => {
    mockDb({ saved: { sale_terms: 'antigo' } });
    const r = await put({ sale_terms: null });
    expect(r.status).toBe(200);
    expect(r.body.settings.sale_terms).toBe('');
  });

  it('sem a chave nao mexe nos termos ja gravados', async () => {
    mockDb({ saved: { sale_terms: 'Texto da loja' } });
    const r = await put({ rt_name: 'Fulana' });
    expect(r.status).toBe(200);
    expect(r.body.settings.sale_terms).toBe('Texto da loja');
    expect(JSON.parse(updates()[0][1][0])).toEqual({ rt_name: 'Fulana' });
  });

  it('otica desligada -> 403 OTICA_DISABLED', async () => {
    mockDb({ otica: 'false' });
    const r = await put({ sale_terms: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('OTICA_DISABLED');
    expect(updates()).toHaveLength(0);
  });
});
