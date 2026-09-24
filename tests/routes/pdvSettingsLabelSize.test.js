// ============================================================
// AURA. -- Testes: modelo de etiqueta salvo por loja (24/09/2026)
//
// pdv_settings.label_size guarda o modelo escolhido em Estoque > Etiquetas
// (aura-app LABEL_SIZE_PRESETS), pra valer em qualquer aparelho da loja.
//
// O que estes testes travam:
//   1. default null (loja que nunca escolheu segue no fallback do app —
//      um default '99x21' tiraria a Eryca do 30x25 no primeiro GET)
//   2. os 3 modelos passam pela whitelist e sao gravados
//   3. modelo desconhecido => 400
//   4. save de outra chave nao apaga o modelo salvo (merge)
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '00000000-0000-0000-0000-000000000001';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'essencial' }, SECRET, { expiresIn: '1h' })}` };
const url = `/api/v1/companies/${cid}/pdv-settings`;

function mockSql(saved) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM company_members/i.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: saved }] });
    return Promise.resolve({ rows: [] });
  });
}
const gravado = () => JSON.parse(db.query.mock.calls.filter((c) => /UPDATE companies SET pdv_settings/i.test(String(c[0] || '')))[0][1][0]);

describe('pdv_settings -- label_size', () => {
  test('GET: null para quem nunca escolheu', async () => {
    mockSql({ caixa_enabled: true });
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.label_size).toBeNull();
  });

  test.each(['99x21', '30x25', '58mm'])('PUT: %s e gravado', async (size) => {
    mockSql({ label_offset_mm: -1.5 });
    const res = await request(app).put(url).set(auth).send({ settings: { label_size: size } });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ label_size: size, label_offset_mm: -1.5 });
    expect(gravado()).toMatchObject({ label_size: size });
  });

  test('PUT: modelo desconhecido => 400', async () => {
    mockSql({});
    const res = await request(app).put(url).set(auth).send({ settings: { label_size: '100x50' } });
    expect(res.status).toBe(400);
  });

  test('PUT: salvar outra chave mantem o modelo', async () => {
    mockSql({ label_size: '58mm' });
    const res = await request(app).put(url).set(auth).send({ settings: { label_offset_mm: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.settings.label_size).toBe('58mm');
  });
});
