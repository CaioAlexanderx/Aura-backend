// ============================================================
// AURA. — Nome do item e origem na lista da Fila (p-177)
//
// GET /studio/orders ganha item_name, item_quantity, origin e origin_label.
// O que trava:
//   1. a regra da origem (Caixa, Orçamento, Loja online, lote, marketplace);
//   2. só SOMA campos: tudo o que a lista devolvia continua igual;
//   3. a query rica do quadro do Studio não muda (as consultas novas são à
//      parte) e a falha delas não derruba a lista;
//   4. escopo por empresa nas consultas novas;
//   5. fallbacks slim/raw com os quatro campos null (shape estável).
// Mock por conteúdo do SQL.
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { comItemEOrigem, origemDoPedido, NULL_ITEM_E_ORIGEM } = require('../src/services/itemEOrigemDoPedido');
const studioRouter = require('../src/routes/studioKdsApproval');

const app = express();
app.use(express.json());
app.use('/companies/:id/studio', studioRouter);

const CID = '11111111-1111-1111-1111-111111111111';
const VENDA = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORC = 'bbbbbbbb-0000-0000-0000-000000000002';
const LOJA = 'cccccccc-0000-0000-0000-000000000003';
const LOTE = 'dddddddd-0000-0000-0000-000000000004';
const MKT = 'eeeeeeee-0000-0000-0000-000000000005';

const LISTA = [
  { id: VENDA, source: 'pdv', pdv_sale_id: VENDA, digital_order_id: null, marketplace_platform: null, item_count: '2', total_amount: '80.00' },
  { id: ORC, source: 'digital', pdv_sale_id: null, digital_order_id: ORC, marketplace_platform: null, item_count: '2' },
  { id: LOJA, source: 'digital', pdv_sale_id: null, digital_order_id: LOJA, marketplace_platform: null, item_count: '1' },
  { id: LOTE, source: 'digital', pdv_sale_id: null, digital_order_id: LOTE, marketplace_platform: null, item_count: '30' },
  { id: MKT, source: 'marketplace', pdv_sale_id: null, digital_order_id: null, marketplace_platform: 'shopee', item_count: '1' },
];

function mockDb({ lista = LISTA, falha = null } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql || '');
    if (/to_regclass/i.test(s)) return { rows: [{ t: 'credit_installments' }] };
    if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
    if (/DISTINCT ON \(si\.sale_id\)/.test(s)) {
      if (falha === 'caixa') throw new Error('boom caixa');
      return { rows: [{ pedido: VENDA, item_name: 'Caneca com nome', item_quantity: '1' }] };
    }
    if (/FROM studio_quotes q/.test(s)) {
      if (falha === 'orcamento') throw new Error('boom orcamento');
      return { rows: [{ pedido: ORC }] };
    }
    if (/FROM digital_orders d\s+LEFT JOIN LATERAL/.test(s)) {
      if (falha === 'loja') throw new Error('boom loja');
      return { rows: [
        { pedido: ORC, do_lote: false, item_name: 'Camiseta 10K', item_quantity: 20 },
        { pedido: LOJA, do_lote: false, item_name: 'Caneca', item_quantity: 1 },
        { pedido: LOTE, do_lote: true, item_name: 'Caneca do evento', item_quantity: 30 },
      ] };
    }
    if (/FROM studio_orders o/.test(s) && /approval_count/.test(s)) return { rows: lista.map((r) => ({ ...r })) };
    return { rows: [] };
  });
}

const novasConsultas = () => db.query.mock.calls.filter(([s]) =>
  /DISTINCT ON \(si\.sale_id\)|FROM studio_quotes q|FROM digital_orders d\s+LEFT JOIN LATERAL/.test(String(s)));

beforeEach(() => jest.resetAllMocks());

describe('origemDoPedido', () => {
  test.each([
    [{ source: 'pdv' }, {}, 'caixa', 'Caixa'],
    [{ source: 'digital' }, { doOrcamento: true }, 'orcamento', 'Orçamento'],
    [{ source: 'digital' }, { doLote: true }, 'lote', 'Pedido em lote'],
    [{ source: 'digital' }, { doOrcamento: true, doLote: true }, 'orcamento', 'Orçamento'],
    [{ source: 'digital' }, {}, 'loja_online', 'Loja online'],
    [{ source: 'marketplace', marketplace_platform: 'mercado_livre' }, {}, 'marketplace', 'Mercado Livre'],
    [{ source: 'marketplace', marketplace_platform: 'shopee' }, {}, 'marketplace', 'Shopee'],
    [{ source: 'marketplace', marketplace_platform: 'outra' }, {}, 'marketplace', 'Marketplace'],
    [{ source: 'x' }, {}, null, null],
  ])('%j %j -> %s', (o, achados, origin, label) => {
    expect(origemDoPedido(o, achados)).toEqual({ origin, origin_label: label });
  });
});

describe('GET /studio/orders com nome do item e origem', () => {
  test('cada cartão ganha o item e a origem', async () => {
    mockDb();
    const r = await request(app).get(`/companies/${CID}/studio/orders`);
    expect(r.status).toBe(200);
    const por = Object.fromEntries(r.body.orders.map((o) => [o.id, o]));
    expect(por[VENDA]).toMatchObject({ item_name: 'Caneca com nome', item_quantity: 1, origin: 'caixa', origin_label: 'Caixa' });
    expect(por[ORC]).toMatchObject({ item_name: 'Camiseta 10K', item_quantity: 20, origin: 'orcamento', origin_label: 'Orçamento' });
    expect(por[LOJA]).toMatchObject({ item_name: 'Caneca', item_quantity: 1, origin: 'loja_online', origin_label: 'Loja online' });
    expect(por[LOTE]).toMatchObject({ origin: 'lote', origin_label: 'Pedido em lote' });
    expect(por[MKT]).toMatchObject({ item_name: null, item_quantity: null, origin: 'marketplace', origin_label: 'Shopee' });
  });

  test('só soma: os campos de antes continuam com o mesmo valor', async () => {
    mockDb();
    const r = await request(app).get(`/companies/${CID}/studio/orders`);
    const venda = r.body.orders.find((o) => o.id === VENDA);
    expect(venda).toMatchObject({ source: 'pdv', pdv_sale_id: VENDA, item_count: '2', total_amount: '80.00' });
  });

  test('a query rica do quadro não ganha subselect novo', async () => {
    mockDb();
    await request(app).get(`/companies/${CID}/studio/orders`);
    const rica = db.query.mock.calls.map(([s]) => String(s)).find((s) => /approval_count/.test(s));
    expect(rica).not.toMatch(/studio_quotes|item_name|origin/);
  });

  test('consultas novas escopadas pela empresa, com os ids da lista', async () => {
    mockDb();
    await request(app).get(`/companies/${CID}/studio/orders`);
    const chamadas = novasConsultas();
    expect(chamadas).toHaveLength(3);
    for (const [sql, params] of chamadas) {
      expect(sql).toMatch(/company_id = \$1/);
      expect(params[0]).toBe(CID);
    }
    const caixa = chamadas.find(([s]) => /si\.sale_id/.test(s));
    expect(caixa[1][1]).toEqual([VENDA]);
    // no Caixa, a peça personalizável aparece primeiro no cartão
    expect(caixa[0]).toMatch(/ORDER BY si\.sale_id, \(p\.is_personalizable IS TRUE\) DESC, si\.id/);
    const loja = chamadas.find(([s]) => /LEFT JOIN LATERAL/.test(s));
    expect(loja[1][1].sort()).toEqual([LOJA, LOTE, ORC].sort());
  });

  test.each(['caixa', 'loja', 'orcamento'])('falha na consulta de %s: a lista sai, só aqueles campos ficam null', async (qual) => {
    mockDb({ falha: qual });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await request(app).get(`/companies/${CID}/studio/orders`);
    expect(r.status).toBe(200);
    expect(r.body.degraded).toBeUndefined();
    expect(r.body.orders).toHaveLength(LISTA.length);
    const por = Object.fromEntries(r.body.orders.map((o) => [o.id, o]));
    if (qual === 'caixa') expect(por[VENDA].item_name).toBeNull();
    if (qual === 'loja') expect(por[LOJA].item_name).toBeNull();
    if (qual === 'orcamento') expect(por[ORC].origin).toBe('loja_online');
    console.error.mockRestore();
  });

  test('lista vazia não faz consulta nova', async () => {
    mockDb({ lista: [] });
    const r = await request(app).get(`/companies/${CID}/studio/orders`);
    expect(r.body.orders).toEqual([]);
    expect(novasConsultas()).toHaveLength(0);
  });

  test('fallback slim mantém o shape com os quatro campos null', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql || '');
      if (/to_regclass/i.test(s)) return { rows: [{ t: null }] };
      if (/information_schema\.columns/i.test(s)) return { rows: [] };
      if (/approval_count/.test(s)) throw new Error('rica caiu');
      if (/FROM studio_orders o/.test(s)) return { rows: [{ id: VENDA, source: 'pdv', customer_name: 'Rafael' }] };
      return { rows: [] };
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await request(app).get(`/companies/${CID}/studio/orders`);
    expect(r.body.degraded).toBe('slim');
    expect(r.body.orders[0]).toMatchObject(NULL_ITEM_E_ORIGEM);
    console.error.mockRestore();
  });
});

describe('comItemEOrigem direto', () => {
  test('sem lista, devolve como veio', async () => {
    expect(await comItemEOrigem(db, CID, [])).toEqual([]);
    expect(await comItemEOrigem(db, CID, null)).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});
