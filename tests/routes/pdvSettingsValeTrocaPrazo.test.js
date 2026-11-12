// ============================================================
// AURA. -- Testes: prazo do vale-troca em pdv_settings (12/11/2026)
//
// O vale-troca no cupom deixa de ser campanha de fim de ano e vira funcao
// permanente: o lojista escolhe o prazo para troca em dias e o cupom imprime
// "Troca ate" = dia da venda + N.
//   - vale_troca_prazo_dias: inteiro 1-365, padrao 30 quando ausente
//
// O que estes testes travam:
//   1. GET traz 30 para a loja que nunca escolheu; devolve o que foi salvo
//   2. PUT grava 1, 365 e texto numerico ("45" => 45)
//   3. fora da faixa, fracao, boolean, null, vazio e lixo => 400 com o nome
//      da chave, e NADA e gravado
//   4. PUT de outra chave mantem o prazo salvo (merge sobre o salvo)
//   5. GET /pdv/sales-for-troca devolve o prazo da loja DA VENDA (filial do
//      grupo inclusive), com 30 quando a loja nunca escolheu
//   6. leitura tolerante do jsonb cru (utils/valeTrocaPrazo)
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { prazoDoValeEmDias, lerPrazoDoVale, PRAZO_PADRAO_DIAS } = require('../../src/utils/valeTrocaPrazo');

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

describe('pdv_settings -- vale_troca_prazo_dias', () => {
  test('GET: 30 para a loja que nunca escolheu', async () => {
    mockSql({ vale_troca_enabled: true });
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.vale_troca_prazo_dias).toBe(30);
  });

  test('GET: 30 tambem para loja sem pdv_settings nenhum', async () => {
    mockSql(null);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.vale_troca_prazo_dias).toBe(30);
  });

  test('GET: devolve o prazo salvo', async () => {
    mockSql({ vale_troca_enabled: true, vale_troca_prazo_dias: 90 });
    const res = await request(app).get(url).set(auth);
    expect(res.body.settings.vale_troca_prazo_dias).toBe(90);
  });

  test.each([1, 7, 30, 365])('PUT: %s e gravado', async (dias) => {
    mockSql({});
    const res = await request(app).put(url).set(auth).send({ settings: { vale_troca_prazo_dias: dias } });
    expect(res.status).toBe(200);
    expect(res.body.settings.vale_troca_prazo_dias).toBe(dias);
    expect(gravado().vale_troca_prazo_dias).toBe(dias);
  });

  test('PUT: texto numerico vira inteiro', async () => {
    mockSql({});
    const res = await request(app).put(url).set(auth).send({ settings: { vale_troca_prazo_dias: '45' } });
    expect(res.status).toBe(200);
    expect(gravado().vale_troca_prazo_dias).toBe(45);
  });

  test.each([0, -5, 366, 1000, 7.5, '7,5', true, false, null, '', 'trinta', [30], { dias: 30 }])(
    'PUT: %p => 400 com o nome da chave e nada gravado',
    async (valor) => {
      mockSql({ vale_troca_prazo_dias: 30 });
      const res = await request(app).put(url).set(auth).send({ settings: { vale_troca_prazo_dias: valor } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/vale_troca_prazo_dias/);
      expect(updates()).toHaveLength(0);
    },
  );

  test('PUT de outra chave mantem o prazo salvo', async () => {
    mockSql({ vale_troca_enabled: true, vale_troca_prazo_dias: 15 });
    const res = await request(app).put(url).set(auth).send({ settings: { require_customer: true } });
    expect(res.status).toBe(200);
    expect(gravado()).toMatchObject({ require_customer: true, vale_troca_enabled: true, vale_troca_prazo_dias: 15 });
  });

  test('PUT do toggle e do prazo juntos (o que o app manda)', async () => {
    mockSql({ caixa_enabled: true, card_fee_credit_pct: 3.5 });
    const res = await request(app).put(url).set(auth)
      .send({ settings: { vale_troca_enabled: true, vale_troca_prazo_dias: 60 } });
    expect(res.status).toBe(200);
    expect(gravado()).toMatchObject({
      caixa_enabled: true, card_fee_credit_pct: 3.5, vale_troca_enabled: true, vale_troca_prazo_dias: 60,
    });
  });
});

describe('utils/valeTrocaPrazo -- leitura tolerante do jsonb cru', () => {
  test('padrao e 30', () => expect(PRAZO_PADRAO_DIAS).toBe(30));
  test.each([
    [undefined, 30], [null, 30], ['', 30], ['abc', 30], [true, 30], [0, 30], [366, 30], [7.5, 30], ['7.5', 30],
    [1, 1], [365, 365], ['90', 90], [' 15 ', 15], [60, 60],
  ])('prazoDoValeEmDias(%p) = %p', (raw, esperado) => {
    expect(prazoDoValeEmDias(raw)).toBe(esperado);
  });
  test('lerPrazoDoVale aceita objeto ausente', () => {
    expect(lerPrazoDoVale(null)).toBe(30);
    expect(lerPrazoDoVale({})).toBe(30);
    expect(lerPrazoDoVale({ vale_troca_prazo_dias: 7 })).toBe(7);
  });
});

describe('GET /pdv/sales-for-troca -- prazo do vale da loja da venda', () => {
  const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
  const pdvRouter = require('../../src/routes/pdv');
  const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };
  const pdvApp = express();
  pdvApp.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/pdv', pdvRouter);
  pdvApp.use('/api/v1/companies/:id', scoped);

  function venda(id, companyId, prazoRaw) {
    return {
      id, total_amount: '100.00', payment_method: 'pix', status: 'completed',
      created_at: '2026-11-10T15:00:00.000Z', company_id: companyId, company_name: 'Loja',
      customer_id: null, customer_name: null, cpf_cnpj: null, seller_id: null, seller_name: null,
      is_cross_filial: companyId !== cid, origin_type: 'sale', is_troca_origin: false, has_nfce: false,
      vale_troca_prazo_raw: prazoRaw, item_count: '1', items: [],
    };
  }

  test('cada venda leva o prazo da propria loja; sem escolha = 30; campo cru nao vaza', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql || '');
      if (/FROM sales s/i.test(s) && /vale_troca_prazo_dias/.test(s)) {
        return Promise.resolve({ rows: [venda('v-1', cid, '90'), venda('v-2', 'filial-2', null)] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(pdvApp)
      .get(`/api/v1/companies/${cid}/pdv/sales-for-troca?order_number=v-&days=365`).set(adminAuth);
    expect(res.status).toBe(200);
    const porId = Object.fromEntries(res.body.map((r) => [r.id, r]));
    expect(porId['v-1'].vale_troca_prazo_dias).toBe(90);
    expect(porId['v-2'].vale_troca_prazo_dias).toBe(30);
    expect(porId['v-1']).not.toHaveProperty('vale_troca_prazo_raw');
    // O prazo vem do pdv_settings da empresa DA VENDA (join comp), nao da loja ativa.
    const sqlVendas = db.query.mock.calls.map((c) => String(c[0] || '')).find((s) => /FROM sales s/i.test(s));
    expect(sqlVendas).toMatch(/comp\.pdv_settings->>'vale_troca_prazo_dias'/);
    expect(sqlVendas).toMatch(/LEFT JOIN companies comp ON comp\.id=s\.company_id/);
  });
});
