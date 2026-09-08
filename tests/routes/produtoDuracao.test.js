// ============================================================
// AURA. — Testes: duracao do servico como coluna (migration 323)
//
// O app escrevia "Duracao: 45 min" no FIM DA DESCRICAO. Descricao e texto
// livre que vai pra vitrine, pro marketplace e pro WhatsApp — a duracao
// ficava presa la dentro, impossivel de somar numa agenda ou de ordenar.
//
// O que estes testes travam:
//   1. duration_minutes chega no INSERT e no UPDATE como INTEIRO.
//   2. "45 min", "1h30" e negativo levam 400 com mensagem — nunca viram
//      NULL em silencio, que e exatamente o bug que a coluna veio matar.
//   3. null apaga o valor (servico que deixou de ter duracao fixa).
//   4. Base atras da migration nao derruba o cadastro: o INSERT cai pro
//      degrau sem a coluna e o PATCH repete o UPDATE sem ela.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const productsRouter = require('../../src/routes/products');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const pid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/products', productsRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();

/** @param {string[]} colunasAusentes colunas que a base ainda nao tem (42703) */
function mockDb(colunasAusentes = []) {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/AS in_group/i.test(s)) {
      return Promise.resolve({ rows: [{ total: '3', in_group: false }] });
    }
    if (/INSERT INTO products/i.test(s) || /UPDATE products SET/i.test(s)) {
      const faltando = colunasAusentes.find((c) => new RegExp(`\\b${c}\\b`).test(s));
      if (faltando) {
        const e = new Error(`column "${faltando}" of relation "products" does not exist`);
        e.code = '42703';
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: [{ id: pid, name: 'Corte', duration_minutes: 45 }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const criar = (body) => request(app)
  .post(`/api/v1/companies/${cid}/products`).set(auth).send({ name: 'Corte', ...body });
const editar = (body) => request(app)
  .patch(`/api/v1/companies/${cid}/products/${pid}`).set(auth).send(body);

const insertCall = () => db.query.mock.calls.find((c) => /INSERT INTO products/i.test(String(c[0] || '')));
const updateCall = () => db.query.mock.calls.find((c) => /UPDATE products SET/i.test(String(c[0] || '')));

describe('POST /products — duration_minutes', () => {
  test('o inteiro chega na coluna, nao na descricao', async () => {
    mockDb();
    const r = await criar({ duration_minutes: 45 });
    expect(r.status).toBe(201);
    const [sql, params] = insertCall();
    expect(sql).toMatch(/duration_minutes/);
    expect(params).toContain(45);
  });

  test('numero em string e aceito — o form manda texto', async () => {
    mockDb();
    await criar({ duration_minutes: '90' });
    expect(insertCall()[1]).toContain(90);
  });

  // A conversao de "1h30" e da TELA. Aceitar aqui seria um segundo parser
  // de duracao, e dois parsers de duracao sempre divergem.
  test.each(['1h30', '45 min', 'meia hora', -10, 12.5, true])(
    'recusa %p com 400 em vez de gravar NULL em silencio', async (valor) => {
      mockDb();
      const r = await criar({ duration_minutes: valor });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/duration_minutes/);
      expect(insertCall()).toBeUndefined();
    });

  test('zero e uma duracao valida', async () => {
    mockDb();
    await criar({ duration_minutes: 0 });
    expect(insertCall()[1]).toContain(0);
  });

  test('sem o campo, o produto nasce com NULL — produto de prateleira nao tem duracao', async () => {
    mockDb();
    const r = await criar({});
    expect(r.status).toBe(201);
    expect(insertCall()[1]).toContain(null);
  });

  // O backend nao roda migration no boot (CLAUDE.md, armadilha 1): existe
  // um intervalo em que o codigo subiu e a coluna nao.
  test('base sem a coluna ainda cadastra o produto', async () => {
    mockDb(['duration_minutes']);
    const r = await criar({ duration_minutes: 45 });
    expect(r.status).toBe(201);
  });
});

describe('PATCH /products/:pid — duration_minutes', () => {
  test('o inteiro entra no SET', async () => {
    mockDb();
    const r = await editar({ duration_minutes: 30 });
    expect(r.status).toBe(200);
    const [sql, params] = updateCall();
    expect(sql).toMatch(/duration_minutes = \$/);
    expect(params).toContain(30);
  });

  test('null apaga a duracao — servico que deixou de ter tempo fixo', async () => {
    mockDb();
    const r = await editar({ duration_minutes: null });
    expect(r.status).toBe(200);
    expect(updateCall()[1][0]).toBeNull();
  });

  test('valor invalido leva 400 e nao chega ao UPDATE', async () => {
    mockDb();
    const r = await editar({ duration_minutes: '1h30' });
    expect(r.status).toBe(400);
    expect(updateCall()).toBeUndefined();
  });

  test('base sem a coluna repete o UPDATE sem ela em vez de dar 500', async () => {
    mockDb(['duration_minutes']);
    const r = await editar({ name: 'Corte masculino', duration_minutes: 30 });
    expect(r.status).toBe(200);
    const tentativas = db.query.mock.calls.filter((c) => /UPDATE products SET/i.test(String(c[0] || '')));
    expect(tentativas).toHaveLength(2);
    expect(tentativas[1][0]).not.toMatch(/duration_minutes/);
  });
});
