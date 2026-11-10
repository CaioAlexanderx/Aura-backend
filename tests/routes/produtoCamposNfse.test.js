// ============================================================
// AURA. — Testes: campos de NFS-e no cadastro do serviço (migration 437)
//
// O que estes testes travam (banco simulado):
//   1. POST e PATCH aceitam os campos em snake_case e camelCase, tiram a
//      pontuação dos códigos e gravam só dígitos.
//   2. Código com letra ou tamanho errado, alíquota fora de 0–5 e
//      descrição acima de 2000 caracteres levam 400 com mensagem em
//      português — e nada é gravado. Nunca viram NULL em silêncio.
//   3. Vazio/null limpa no PATCH (volta ao padrão da empresa).
//   4. Gravados para qualquer unidade (não só 'srv').
//   5. Base atrás da 437 não derruba nada: o POST segue sem os campos e o
//      PATCH repete o UPDATE sem eles; a listagem cai um degrau.
//   6. A listagem devolve as colunas novas (alíquota como número).
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const productsRouter = require('../../src/routes/products');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

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

const NFSE_COLS = ['nfse_ctribnac', 'nfse_cnbs', 'nfse_ctribmun', 'nfse_aliquota_iss', 'nfse_descricao', 'ibscbs_cst', 'ibscbs_cclasstrib', 'ibscbs_cindop'];

/** @param {{ semColunas?: boolean, linha?: object }} o */
function mockDb({ semColunas = false, linha = {} } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/AS in_group/i.test(s)) return Promise.resolve({ rows: [{ total: '3', in_group: false }] });
    if (semColunas && /\bnfse_ctribnac\b|\bnfse_descricao\b|\bibscbs_cst\b|\bnfse_cnbs\b/.test(s)) {
      const e = new Error('column "nfse_ctribnac" of relation "products" does not exist');
      e.code = '42703';
      return Promise.reject(e);
    }
    if (/INSERT INTO products/i.test(s) || /UPDATE products SET/i.test(s)) {
      return Promise.resolve({ rows: [{ id: pid, name: 'Instalação', unit: 'srv', ...linha }] });
    }
    if (/COUNT\(\*\) AS total FROM products/i.test(s)) return Promise.resolve({ rows: [{ total: '1' }] });
    if (/FROM products/i.test(s)) return Promise.resolve({ rows: [{ id: pid, name: 'Instalação', unit: 'srv', price: '10', ...linha }] });
    return Promise.resolve({ rows: [] });
  });
}

const criar = (body) => request(app)
  .post(`/api/v1/companies/${cid}/products`).set(auth).send({ name: 'Instalação', unit: 'srv', ...body });
const editar = (body) => request(app)
  .patch(`/api/v1/companies/${cid}/products/${pid}`).set(auth).send(body);

const chamadas = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0] || '')));
const updatesNfse = () => chamadas(/UPDATE products SET/i).filter((c) => /nfse_|ibscbs_/.test(String(c[0])));

/** { coluna: valor } a partir de "UPDATE products SET a = $2, b = $3 WHERE id = $1" (POST). */
function setDoPost([sql, params]) {
  const out = {};
  const re = /(\w+) = \$(\d+)/g;
  let m;
  const set = String(sql).split(' WHERE ')[0];
  while ((m = re.exec(set))) out[m[1]] = params[Number(m[2]) - 1];
  return out;
}

describe('POST /products — campos de NFS-e', () => {
  test('snake_case e camelCase; pontuação sai, só dígitos gravados', async () => {
    mockDb();
    const r = await criar({
      nfse_ctribnac: '14.01.01', nfseCnbs: '1.2001.10.00', nfseCTribMun: '001',
      nfseAliquotaIss: '2,5', nfse_descricao: '  Instalação de split  ',
      ibscbs_cst: '000', ibscbsCClassTrib: '000001', ibscbsCIndOp: '03.01.01',
    });
    expect(r.status).toBe(201);
    const ups = updatesNfse();
    expect(ups).toHaveLength(1);
    expect(setDoPost(ups[0])).toEqual({
      nfse_ctribnac: '140101', nfse_cnbs: '120011000', nfse_ctribmun: '001',
      nfse_aliquota_iss: 2.5, nfse_descricao: 'Instalação de split',
      ibscbs_cst: '000', ibscbs_cclasstrib: '000001', ibscbs_cindop: '030101',
    });
    expect(ups[0][1][0]).toBe(pid);
  });

  test('snake_case vence camelCase quando vierem os dois', async () => {
    mockDb();
    await criar({ nfse_ctribnac: '140101', nfseCtribnac: '070201' });
    expect(setDoPost(updatesNfse()[0])).toEqual({ nfse_ctribnac: '140101' });
  });

  test('sem nenhum campo de NFS-e: nenhum UPDATE a mais (nada muda para quem não usa)', async () => {
    mockDb();
    const r = await criar({});
    expect(r.status).toBe(201);
    expect(updatesNfse()).toHaveLength(0);
    // campos vazios no POST também não geram UPDATE
    db.query.mockClear();
    await criar({ nfse_ctribnac: '', nfse_descricao: null });
    expect(updatesNfse()).toHaveLength(0);
  });

  test('gravados também em produto que não é serviço (unit != srv)', async () => {
    mockDb();
    const r = await criar({ unit: 'un', nfse_ctribnac: '140101' });
    expect(r.status).toBe(201);
    expect(setDoPost(updatesNfse()[0])).toEqual({ nfse_ctribnac: '140101' });
  });

  test.each([
    ['nfse_ctribnac', '1401', /6 dígitos/],
    ['nfse_ctribnac', '14A101', /6 dígitos/],
    ['nfse_cnbs', '12345', /9 dígitos/],
    ['nfse_ctribmun', '0001', /3 dígitos/],
    ['ibscbs_cst', 'abc', /3 dígitos/],
    ['ibscbs_cclasstrib', '1234567', /6 dígitos/],
    ['ibscbs_cindop', '12345', /6 dígitos/],
    ['nfse_aliquota_iss', '5,01', /entre 0 e 5/],
    ['nfse_aliquota_iss', -1, /entre 0 e 5/],
    ['nfse_aliquota_iss', 'dois', /entre 0 e 5/],
    ['nfse_ctribnac', true, /6 dígitos/],
  ])('%s = %j → 400 com mensagem, nada criado', async (campo, valor, msg) => {
    mockDb();
    const r = await criar({ [campo]: valor });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(msg);
    expect(chamadas(/INSERT INTO products/i)).toHaveLength(0);
  });

  test('descrição acima de 2000 caracteres → 400 dizendo o tamanho', async () => {
    mockDb();
    const r = await criar({ nfse_descricao: 'a'.repeat(2001) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/até 2\.000 caracteres.*2001/);
    expect(chamadas(/INSERT INTO products/i)).toHaveLength(0);
  });

  test('alíquota nos limites: 0 e 5 aceitas, 2 casas', async () => {
    mockDb();
    await criar({ nfse_aliquota_iss: 0 });
    expect(setDoPost(updatesNfse()[0])).toEqual({ nfse_aliquota_iss: 0 });
    db.query.mockClear();
    await criar({ nfse_aliquota_iss: '5' });
    expect(setDoPost(updatesNfse()[0])).toEqual({ nfse_aliquota_iss: 5 });
    db.query.mockClear();
    await criar({ nfse_aliquota_iss: 2.345 });
    expect(setDoPost(updatesNfse()[0])).toEqual({ nfse_aliquota_iss: 2.35 });
  });

  test('resposta devolve os campos normalizados (alíquota como número)', async () => {
    mockDb({ linha: { nfse_ctribnac: '140101', nfse_aliquota_iss: '3.50' } });
    const r = await criar({ nfse_ctribnac: '140101', nfse_aliquota_iss: 3.5 });
    expect(r.body).toMatchObject({ nfse_ctribnac: '140101', nfse_aliquota_iss: 3.5, nfse_cnbs: null });
  });

  test('base sem a 437: produto criado mesmo assim (201), sem os campos', async () => {
    mockDb({ semColunas: true });
    const r = await criar({ nfse_ctribnac: '140101' });
    expect(r.status).toBe(201);
    expect(chamadas(/INSERT INTO products/i)).toHaveLength(1);
  });
});

describe('PATCH /products/:pid — campos de NFS-e', () => {
  const setDoPatch = () => {
    const [sql, params] = chamadas(/UPDATE products SET/i).slice(-1)[0];
    const out = {};
    const re = /(\w+) = \$(\d+)/g;
    let m;
    const set = String(sql).split(' WHERE ')[0];
    while ((m = re.exec(set))) out[m[1]] = params[Number(m[2]) - 1];
    return out;
  };

  test('grava só o que veio, com dígitos', async () => {
    mockDb();
    const r = await editar({ nfseCTribNac: '01.07.01', nfse_aliquota_iss: '2.5' });
    expect(r.status).toBe(200);
    const set = setDoPatch();
    expect(set).toMatchObject({ nfse_ctribnac: '010701', nfse_aliquota_iss: 2.5 });
    expect(Object.keys(set).filter((k) => NFSE_COLS.includes(k)).sort()).toEqual(['nfse_aliquota_iss', 'nfse_ctribnac']);
  });

  test('vazio e null limpam (voltam ao padrão da empresa)', async () => {
    mockDb();
    await editar({ nfse_ctribnac: '', nfse_descricao: null, ibscbs_cst: '   ' });
    expect(setDoPatch()).toMatchObject({ nfse_ctribnac: null, nfse_descricao: null, ibscbs_cst: null });
  });

  test('código inválido → 400, nenhum UPDATE', async () => {
    mockDb();
    const r = await editar({ name: 'Novo nome', nfse_cnbs: '12' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/NBS precisa ter 9 dígitos/);
    expect(chamadas(/UPDATE products SET/i)).toHaveLength(0);
  });

  test('vários erros saem juntos em detalhes', async () => {
    mockDb();
    const r = await editar({ nfse_ctribnac: '1', nfse_aliquota_iss: 9 });
    expect(r.status).toBe(400);
    expect(r.body.detalhes).toHaveLength(2);
  });

  test('UPDATE usa a visibilidade do grupo, como o resto do PATCH', async () => {
    mockDb();
    await editar({ nfse_ctribnac: '140101' });
    const [sql] = chamadas(/UPDATE products SET/i).slice(-1)[0];
    expect(sql).toMatch(/is_group_shared = true/);
  });

  test('base sem a 437: repete o UPDATE sem os campos (outros campos salvos)', async () => {
    mockDb({ semColunas: true });
    const r = await editar({ name: 'Instalação split', nfse_ctribnac: '140101' });
    expect(r.status).toBe(200);
    const ups = chamadas(/UPDATE products SET/i);
    expect(ups).toHaveLength(2);
    expect(String(ups[1][0])).not.toMatch(/nfse_/);
    expect(String(ups[1][0])).toMatch(/name = \$1/);
  });

  test('42703 de outra coluna sem campos novos no body sobe como antes (500)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockImplementation((sql) => {
      if (/UPDATE products SET/i.test(String(sql))) {
        return Promise.reject(Object.assign(new Error('x'), { code: '42703' }));
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await editar({ name: 'X' });
    expect(r.status).toBe(500);
    expect(chamadas(/UPDATE products SET/i)).toHaveLength(1);
  });
});

describe('GET /products — devolve os campos de NFS-e', () => {
  test('colunas no SELECT e na resposta (alíquota como número, ausente = null)', async () => {
    mockDb({ linha: { nfse_ctribnac: '140101', nfse_aliquota_iss: '3.50', nfse_descricao: 'Instalação de split' } });
    const r = await request(app).get(`/api/v1/companies/${cid}/products`).set(auth);
    expect(r.status).toBe(200);
    const sqlLista = chamadas(/FROM products/i).map((c) => String(c[0])).find((s) => /ORDER BY name/.test(s));
    for (const c of NFSE_COLS) expect(sqlLista).toMatch(new RegExp(`\\b${c}\\b`));
    expect(r.body.products[0]).toMatchObject({
      nfse_ctribnac: '140101', nfse_aliquota_iss: 3.5, nfse_descricao: 'Instalação de split',
      nfse_cnbs: null, ibscbs_cst: null,
    });
  });

  test('base sem a 437: lista cai um degrau e devolve null nos campos', async () => {
    mockDb({ semColunas: true });
    const r = await request(app).get(`/api/v1/companies/${cid}/products`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body.products[0]).toMatchObject({ nfse_ctribnac: null, nfse_aliquota_iss: null });
    const listas = chamadas(/ORDER BY name/);
    expect(listas).toHaveLength(2);
    expect(String(listas[1][0])).not.toMatch(/nfse_/);
  });
});
