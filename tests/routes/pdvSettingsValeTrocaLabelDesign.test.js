// ============================================================
// AURA. -- Testes: vale_troca_enabled e label_design em pdv_settings
// (13/10/2026)
//
// Duas preferencias que o app guardava so no navegador (ou ainda nao
// guardava) passam a viver na loja, valendo em qualquer aparelho:
//   - vale_troca_enabled: boolean, default true (vale-troca por QR no cupom)
//   - label_design: 'classico' | 'editorial', default 'classico'
//
// O que estes testes travam:
//   1. GET traz os defaults pra loja que nunca gravou as chaves
//   2. GET devolve o que foi salvo (inclusive vale_troca_enabled=false)
//   3. PUT grava as duas chaves
//   4. valor fora do contrato => 400 (label_design desconhecido, boolean
//      que nao e boolean) e nada e gravado
//   5. PUT de uma chave nao apaga as outras (merge sobre o salvo)
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
    if (/SELECT pdv_settings(, vertical_active)? FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: saved }] });
    return Promise.resolve({ rows: [] });
  });
}
const updates = () => db.query.mock.calls.filter((c) => /UPDATE companies SET pdv_settings/i.test(String(c[0] || '')));
const gravado = () => JSON.parse(updates()[0][1][0]);

describe('pdv_settings -- vale_troca_enabled', () => {
  test('GET: true para a loja que nunca gravou a chave', async () => {
    mockSql({ caixa_enabled: true });
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.vale_troca_enabled).toBe(true);
  });

  test('GET: devolve false quando a loja desligou', async () => {
    mockSql({ vale_troca_enabled: false });
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.vale_troca_enabled).toBe(false);
  });

  test.each([true, false])('PUT: %s e gravado', async (valor) => {
    mockSql({});
    const res = await request(app).put(url).set(auth).send({ settings: { vale_troca_enabled: valor } });
    expect(res.status).toBe(200);
    expect(res.body.settings.vale_troca_enabled).toBe(valor);
    expect(gravado().vale_troca_enabled).toBe(valor);
  });

  test('PUT: valor que nao e boolean => 400 e nada gravado', async () => {
    mockSql({});
    const res = await request(app).put(url).set(auth).send({ settings: { vale_troca_enabled: 'nao' } });
    expect(res.status).toBe(400);
    expect(updates()).toHaveLength(0);
  });
});

describe('pdv_settings -- label_design', () => {
  test('GET: classico para a loja que nunca escolheu', async () => {
    mockSql({ caixa_enabled: true });
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.label_design).toBe('classico');
  });

  test.each(['classico', 'editorial'])('PUT: %s e gravado', async (desenho) => {
    mockSql({});
    const res = await request(app).put(url).set(auth).send({ settings: { label_design: desenho } });
    expect(res.status).toBe(200);
    expect(res.body.settings.label_design).toBe(desenho);
    expect(gravado().label_design).toBe(desenho);
  });

  test('PUT: desenho desconhecido => 400 com mensagem e nada gravado', async () => {
    mockSql({});
    const res = await request(app).put(url).set(auth).send({ settings: { label_design: 'moderno' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/label_design/);
    expect(updates()).toHaveLength(0);
  });

  test('PUT: label_design nao e confundido com label_size', async () => {
    mockSql({});
    const res = await request(app).put(url).set(auth).send({ settings: { label_size: 'editorial' } });
    expect(res.status).toBe(400);
  });
});

describe('pdv_settings -- as chaves novas convivem com as demais', () => {
  test('PUT das duas chaves nao apaga o restante', async () => {
    mockSql({ caixa_enabled: true, label_size: '58mm', label_offset_mm: -1.5, card_fee_credit_pct: 3.5 });
    const res = await request(app).put(url).set(auth)
      .send({ settings: { vale_troca_enabled: false, label_design: 'editorial' } });
    expect(res.status).toBe(200);
    const esperado = {
      caixa_enabled: true,
      label_size: '58mm',
      label_offset_mm: -1.5,
      card_fee_credit_pct: 3.5,
      vale_troca_enabled: false,
      label_design: 'editorial',
    };
    expect(res.body.settings).toMatchObject(esperado);
    expect(gravado()).toMatchObject(esperado);
  });

  test('PUT de outra chave mantem as duas novas ja salvas', async () => {
    mockSql({ vale_troca_enabled: false, label_design: 'editorial' });
    const res = await request(app).put(url).set(auth).send({ settings: { require_customer: true } });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({
      require_customer: true,
      vale_troca_enabled: false,
      label_design: 'editorial',
    });
    expect(gravado()).toMatchObject({ vale_troca_enabled: false, label_design: 'editorial' });
  });
});
