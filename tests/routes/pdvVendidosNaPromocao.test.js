// ============================================================
// AURA. -- Testes: vendidos na promocao (p-92, migration 428)
//
// O que estes testes travam (sem banco; o Postgres real fica no
// __tests__/vendidosNaPromocao.banco.test.js):
//   1. a conta do item (services/vendaNaPromocao.marcacaoDoItem) segue a
//      regra do preco efetivo: produto, variante propria, variante que
//      herda, override que isola, agendada, vencida, "Por" >= "De"
//   2. a leitura das colunas e guardada: presente = para sempre; ausente =
//      5 minutos sem perguntar de novo
//   3. POST /pdv/sale grava preco_lista/em_promocao quando a base tem as
//      colunas, sem mudar unit_price nem total
//   4. base sem as colunas (428 pendente): o INSERT e o de sempre
//   5. venda com data retroativa: sem marcacao
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const pdvRouter = require('../../src/routes/pdv');
const vendaNaPromocao = require('../../src/services/vendaNaPromocao');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => {
  jest.resetAllMocks();
  vendaNaPromocao._resetarParaTeste();
});

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const prod = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const prod2 = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
const vari = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

const AGORA = new Date('2026-11-20T15:00:00Z');
const ONTEM = '2026-11-19T15:00:00Z';
const AMANHA = '2026-11-21T15:00:00Z';
const ATIVA = { promo_price: '80.00', promo_starts_at: ONTEM, promo_ends_at: AMANHA };

describe('marcacaoDoItem -- a regra do preco efetivo', () => {
  const { marcacaoDoItem } = vendaNaPromocao;

  test('produto em promocao: De = price, em_promocao true', () => {
    expect(marcacaoDoItem({ price: '100.00', ...ATIVA }, null, AGORA)).toEqual({ preco_lista: 100, em_promocao: true });
  });

  test('produto sem promocao, agendada, vencida ou com Por >= De: false, sem De', () => {
    const sem = { preco_lista: null, em_promocao: false };
    expect(marcacaoDoItem({ price: '100.00' }, null, AGORA)).toEqual(sem);
    expect(marcacaoDoItem({ price: '100.00', ...ATIVA, promo_starts_at: AMANHA, promo_ends_at: '2026-11-30T00:00:00Z' }, null, AGORA)).toEqual(sem);
    expect(marcacaoDoItem({ price: '100.00', ...ATIVA, promo_starts_at: '2026-11-01T00:00:00Z', promo_ends_at: ONTEM }, null, AGORA)).toEqual(sem);
    expect(marcacaoDoItem({ price: '70.00', ...ATIVA }, null, AGORA)).toEqual(sem);
  });

  test('variante com promocao propria: De = price_override', () => {
    const v = { price_override: '120.00', promo_price: '90.00', promo_starts_at: ONTEM, promo_ends_at: AMANHA };
    expect(marcacaoDoItem({ price: '100.00' }, v, AGORA)).toEqual({ preco_lista: 120, em_promocao: true });
  });

  test('variante sem price_override herda a promocao do produto: De = price do produto', () => {
    expect(marcacaoDoItem({ price: '100.00', ...ATIVA }, { price_override: null }, AGORA)).toEqual({ preco_lista: 100, em_promocao: true });
  });

  test('variante com price_override nao herda a promocao do produto', () => {
    expect(marcacaoDoItem({ price: '100.00', ...ATIVA }, { price_override: '110.00' }, AGORA)).toEqual({ preco_lista: null, em_promocao: false });
  });

  test('sem produto: nao sabemos (NULL)', () => {
    expect(marcacaoDoItem(null, null, AGORA)).toEqual({ preco_lista: null, em_promocao: null });
  });
});

describe('colunasPresentes -- guardada no processo', () => {
  test('presente: pergunta uma vez so', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ n: 4 }] });
    expect(await vendaNaPromocao.colunasPresentes(q)).toBe(true);
    expect(await vendaNaPromocao.colunasPresentes(q)).toBe(true);
    expect(q).toHaveBeenCalledTimes(1);
  });

  test('ausente: false e nao pergunta de novo dentro de 5 minutos', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ n: 2 }] });
    expect(await vendaNaPromocao.colunasPresentes(q)).toBe(false);
    expect(await vendaNaPromocao.colunasPresentes(q)).toBe(false);
    expect(q).toHaveBeenCalledTimes(1);
  });

  test('erro na leitura conta como ausente (INSERT de sempre)', async () => {
    const q = jest.fn().mockRejectedValue(new Error('boom'));
    expect(await vendaNaPromocao.colunasPresentes(q)).toBe(false);
  });
});

// ─── Rota ─────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/pdv', pdvRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();

function mockClient({ colunas = 4, promoProduto = {}, variante = null } = {}) {
  const query = jest.fn().mockImplementation((sql) => {
    const s = String(sql || '');
    if (/information_schema\.columns/i.test(s) && /preco_lista/.test(s)) return Promise.resolve({ rows: [{ n: colunas }] });
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM products p JOIN companies c/i.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Camiseta', cost_price: '30.00', stock_qty: '50', stock_company_id: cid }] });
    }
    if (/SELECT stock_qty, sku_suffix FROM product_variants/i.test(s)) {
      return Promise.resolve({ rows: [{ stock_qty: '50', sku_suffix: 'P' }] });
    }
    if (/SELECT id, price, promo_price, promo_starts_at, promo_ends_at\s+FROM products WHERE id = ANY/i.test(s)) {
      return Promise.resolve({ rows: [
        { id: prod, price: '100.00', ...promoProduto },
        { id: prod2, price: '50.00', promo_price: null, promo_starts_at: null, promo_ends_at: null },
      ] });
    }
    if (/FROM product_variants WHERE id = ANY/i.test(s)) {
      return Promise.resolve({ rows: variante ? [variante] : [] });
    }
    if (/INSERT INTO sales/i.test(s)) return Promise.resolve({ rows: [{ id: 'sale-1', total_amount: '210.00' }] });
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
}

function usar(client) {
  db.connect.mockResolvedValue(client);
  db.query.mockResolvedValue({ rows: [] });
  return client;
}

const itensInseridos = (client) => client.query.mock.calls.filter((c) => /INSERT INTO sale_items/i.test(String(c[0] || '')));
const vendaInserida = (client) => client.query.mock.calls.find((c) => /INSERT INTO sales/i.test(String(c[0] || '')));

const sell = (items, extra = {}) => request(app)
  .post(`/api/v1/companies/${cid}/pdv/sale`).set(adminAuth)
  .send({ items, payment_method: 'dinheiro', ...extra });

const ITENS = [
  { product_id: prod, quantity: 2, unit_price: 80 },
  { product_id: prod2, quantity: 1, unit_price: 50 },
];

const promoValendo = () => ({
  promo_price: '80.00',
  promo_starts_at: new Date(Date.now() - 864e5).toISOString(),
  promo_ends_at: new Date(Date.now() + 864e5).toISOString(),
});

describe('POST /pdv/sale -- grava a promocao no item', () => {
  test('item em promocao: preco_lista = De e em_promocao true; o outro false; valores intactos', async () => {
    const client = usar(mockClient({ promoProduto: promoValendo() }));
    const res = await sell(ITENS);
    expect(res.status).toBe(201);

    const [a, b] = itensInseridos(client);
    expect(a[0]).toMatch(/preco_lista,em_promocao/);
    // unit_price, desconto e total da linha: os que o app mandou.
    expect(a[1].slice(3, 8)).toEqual([2, 80, 30, 0, 160]);
    expect(a[1].slice(9)).toEqual([100, true]);
    expect(b[1].slice(3, 8)).toEqual([1, 50, 30, 0, 50]);
    expect(b[1].slice(9)).toEqual([null, false]);
    // Total da venda: 160 + 50, igual a sem a marcacao.
    expect(vendaInserida(client)[1][5]).toBe(210);
  });

  test('variante que herda a promocao do produto: De = price do produto', async () => {
    const client = usar(mockClient({
      promoProduto: promoValendo(),
      variante: { id: vari, product_id: prod, price_override: null, promo_price: null, promo_starts_at: null, promo_ends_at: null },
    }));
    const res = await sell([{ product_id: prod, variant_id: vari, quantity: 1, unit_price: 80 }]);
    expect(res.status).toBe(201);
    const [a] = itensInseridos(client);
    expect(a[1].slice(9)).toEqual([100, true]);
  });

  test('base sem as colunas (428 pendente): INSERT de sempre, sem ler promocao', async () => {
    const client = usar(mockClient({ colunas: 2, promoProduto: promoValendo() }));
    const res = await sell(ITENS);
    expect(res.status).toBe(201);
    const [a] = itensInseridos(client);
    expect(a[0]).not.toMatch(/preco_lista/);
    expect(a[1]).toHaveLength(9);
    expect(client.query.mock.calls.some((c) => /FROM products WHERE id = ANY/i.test(String(c[0])))).toBe(false);
  });

  test('venda com data retroativa: sem marcacao', async () => {
    const client = usar(mockClient({ promoProduto: promoValendo() }));
    const res = await sell(ITENS, { sale_date: '2026-11-01' });
    expect(res.status).toBe(201);
    const [a] = itensInseridos(client);
    expect(a[0]).not.toMatch(/preco_lista/);
    expect(client.query.mock.calls.some((c) => /information_schema\.columns/i.test(String(c[0])) && /preco_lista/.test(String(c[0])))).toBe(false);
  });

  test('duas leituras de promocao por venda, nao uma por item', async () => {
    const client = usar(mockClient({ promoProduto: promoValendo() }));
    await sell([...ITENS, { product_id: prod, quantity: 1, unit_price: 80 }]);
    const leituras = client.query.mock.calls.filter((c) => /promo_price/.test(String(c[0])) && /ANY\(\$1::uuid\[\]\)/.test(String(c[0])));
    expect(leituras).toHaveLength(1); // sem variante na venda: so a de produtos
  });
});
