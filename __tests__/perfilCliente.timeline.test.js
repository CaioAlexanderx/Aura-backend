// ============================================================
// AURA CLIENTES — Fase 1: linha do tempo, resumo e visão /me
//
// Banco mockado, roteado pela etiqueta `-- tl:*` de cada SQL. O que se
// trava aqui:
//   - montagem e ordenação (instante DESC, chave DESC) entre fontes
//   - cursor: próxima página com o mesmo formato da history do crediário e
//     cada fonte recebendo `(at, key) < cursor`
//   - gate por tipo: mensagem/crediário só para empresa Negócio+, lido do
//     banco; Essencial recebe 200 com locked_types, nunca 403
//   - visão consolidada: só as empresas do dono que o usuário acessa, com
//     company_name em cada evento
//   - deploy parcial (42P01/42703) não derruba a ficha
// A validade do SQL contra o schema real está em perfilCliente.banco.test.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { companyRouter, meRouter } = require('../src/routes/customerProfile');
const timeline = require('../src/services/customerTimeline');
const saleNumber = require('../src/utils/saleNumber');
const { encodeCursor } = require('../src/utils/timelineCursor');

let db;
beforeAll(() => { db = require('../src/config/database'); });

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const CID = '33333333-3333-4333-8333-333333333333';
const SALE_1 = '44444444-4444-4444-8444-444444444441';
const SALE_2 = '44444444-4444-4444-8444-444444444442';
const NOTE_1 = '55555555-5555-4555-8555-555555555551';
const USER = '66666666-6666-4666-8666-666666666666';

const SECRET = 'aura-test-secret-2026';
const auth = { Authorization: `Bearer ${jwt.sign({ id: USER, plan: 'expansao' }, SECRET, { expiresIn: '1h' })}` };

const app = express();
app.use(express.json());
app.use('/companies/:id/customers', (req, res, next) => { req.user = { id: USER, plan: 'expansao' }; next(); }, companyRouter);
app.use('/me', meRouter);

const customerRow = { id: CID, company_id: CO_A, name: 'Ana Souza', phone: '(11) 98765-4321', phone_secondary: null };

function tagOf(sql) {
  const m = /--\s*(tl:[\w-]+|perfil:[\w-]+)/.exec(sql);
  if (m) return m[1];
  if (/information_schema\.columns/.test(sql)) return 'sale-number-probe';
  if (/owner_id = \(SELECT owner_id FROM companies WHERE id = \$1\)/.test(sql)) return 'owner-scope';
  return 'desconhecida';
}

/**
 * Instala o roteador de queries. `handlers[tag]` pode ser array de linhas,
 * função (sql, params) => linhas, ou um Error (rejeita).
 */
function banco(handlers) {
  const calls = [];
  db.query.mockImplementation(async (sql, params) => {
    const tag = tagOf(sql);
    calls.push({ tag, sql, params });
    let h = handlers[tag];
    if (h === undefined) {
      if (tag === 'sale-number-probe') return { rows: [{ n: 1 }] };
      if (tag === 'owner-scope') return { rows: [{ id: CO_A }, { id: CO_B }] };
      if (tag === 'perfil:cliente') return { rows: [customerRow] };
      if (tag.startsWith('tl:')) return { rows: [] };
      throw new Error(`query inesperada: ${tag}\n${sql}`);
    }
    if (typeof h === 'function') h = h(sql, params);
    if (h instanceof Error) throw h;
    return { rows: h };
  });
  return calls;
}

function pgError(code) {
  const e = new Error(`pg ${code}`);
  e.code = code;
  return e;
}

const companiesA = (plan) => [{ id: CO_A, name: 'Loja A', plan }];

function saleRow(over) {
  return {
    ev_key: 'aaaaaaaa-0000-4000-8000-000000000000',
    ev_at: new Date('2026-09-10T15:00:00.000Z'),
    sale_id: SALE_1, company_id: CO_A, created_at: new Date('2026-09-10T15:00:00.000Z'),
    cancelled_at: null, total_amount: 250, discount_amount: 10, payment_method: 'pix',
    status: 'completed', sale_type: 'sale', exchange_of_sale_id: null, coupon_id: null,
    coupon_code: null, seller_name: 'Bia', sale_number: 42,
    is_installment: false, total_installments: null, source_type: 'pdv',
    ...over,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  timeline._resetCaches();
  saleNumber._resetCache();
});

describe('GET /customers/:cid/timeline — montagem e ordem', () => {
  it('junta as fontes em ordem decrescente, com itens e variante na compra', async () => {
    banco({
      'tl:companies': companiesA('essencial'),
      'tl:compra': [
        saleRow(),
        saleRow({
          ev_key: 'cccccccc-0000-4000-8000-000000000000', ev_at: new Date('2026-09-01T12:00:00.000Z'),
          sale_id: SALE_2, sale_number: 7, total_amount: 99.9, payment_method: 'crediario',
        }),
      ],
      'tl:nota': [{
        ev_key: 'bbbbbbbb-0000-4000-8000-000000000000', ev_at: new Date('2026-09-05T09:00:00.000Z'),
        id: NOTE_1, company_id: CO_A, body: 'Prefere contato à tarde', kind: 'manual',
        author_id: USER, author_name: 'Caio',
      }],
      'tl:cupom-gerado': [{
        ev_key: 'dddddddd-0000-4000-8000-000000000000', ev_at: new Date('2026-09-05T09:00:00.000Z'),
        id: 'c1', company_id: CO_A, code: 'VOLTA10', source: 'reactivation', discount_type: 'percent',
        discount_value: 10, expires_at: null, current_uses: 0, max_uses: 1, is_active: true,
      }],
      'tl:itens': [
        { sale_id: SALE_1, product_id: 'p1', variant_id: 'v1', product_name: 'Vestido Midi', variant_values: 'Azul / M', sku_suffix: 'AZ-M', quantity: 1, unit_price: 260, total_price: 260 },
        { sale_id: SALE_2, product_id: 'p2', variant_id: 'v2', product_name: 'Blusa', variant_values: null, sku_suffix: 'PT-P', quantity: 1, unit_price: 99.9, total_price: 99.9 },
      ],
    });

    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline`);

    expect(res.status).toBe(200);
    expect(res.body.events.map(e => [e.type, e.id[0]])).toEqual([
      ['compra', 'a'],
      ['cupom', 'd'], // mesmo instante da nota: desempata pela chave, decrescente
      ['nota', 'b'],
      ['compra', 'c'],
    ]);
    const compra = res.body.events[0];
    expect(compra).toMatchObject({
      type: 'compra', at: '2026-09-10T15:00:00.000Z', company_id: CO_A, company_name: 'Loja A',
      title: 'Compra #42', amount: 250,
    });
    expect(compra.meta).toMatchObject({
      sale_id: SALE_1, sale_number: 42, payment_method: 'pix', seller_name: 'Bia',
      discount_amount: 10, status: 'completed', is_installment: false, source_type: 'pdv',
    });
    expect(compra.meta.items).toEqual([{
      product_id: 'p1', variant_id: 'v1', product_name: 'Vestido Midi', variant: 'Azul / M',
      quantity: 1, unit_price: 260, total: 260,
    }]);
    expect(res.body.events[3].meta.items[0].variant).toBe('PT-P'); // sem atributos -> sku
    expect(res.body.events[2].meta).toMatchObject({ body: 'Prefere contato à tarde', author_name: 'Caio' });
    expect(res.body.next_cursor).toBeNull();
    expect(res.body.scope).toBe('company');
  });

  it('pagina pelo cursor: próxima página com o último evento e filtro em toda fonte', async () => {
    banco({
      'tl:companies': companiesA('essencial'),
      'tl:compra': [
        saleRow(),
        saleRow({ ev_key: 'cccccccc-0000-4000-8000-000000000000', ev_at: new Date('2026-09-01T12:00:00.000Z'), sale_id: SALE_2 }),
      ],
      'tl:itens': [],
    });

    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline?limit=1`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.next_cursor).toBe(
      encodeCursor('2026-09-10T15:00:00.000Z', 'aaaaaaaa-0000-4000-8000-000000000000')
    );

    const calls = banco({ 'tl:companies': companiesA('essencial') });
    const res2 = await request(app)
      .get(`/companies/${CO_A}/customers/${CID}/timeline`)
      .query({ limit: 1, cursor: res.body.next_cursor });
    expect(res2.status).toBe(200);
    expect(res2.body.events).toEqual([]);
    expect(res2.body.next_cursor).toBeNull();

    const fontes = calls.filter(c => /^tl:(compra|troca|cancelamento|cupom-|avaliacao|nota)/.test(c.tag));
    expect(fontes.map(c => c.tag).sort()).toEqual(
      ['tl:avaliacao', 'tl:cancelamento', 'tl:compra', 'tl:cupom-gerado', 'tl:cupom-usado', 'tl:nota', 'tl:troca']
    );
    for (const c of fontes) {
      expect(c.sql).toMatch(/\) < \(\$3::timestamptz, \$4::uuid\)/);
      expect(c.params.slice(2)).toEqual(['2026-09-10T15:00:00.000Z', 'aaaaaaaa-0000-4000-8000-000000000000']);
      expect(c.sql).toMatch(/ORDER BY ev_at DESC, ev_key DESC\s+LIMIT 2/);
      expect(c.params[0]).toEqual([CO_A]); // só a empresa da rota
    }
  });

  it('troca não soma receita: amount nulo, valor novo no meta e itens devolvidos', async () => {
    banco({
      'tl:companies': companiesA('essencial'),
      'tl:troca': [saleRow({ sale_type: 'troca', exchange_of_sale_id: SALE_2, total_amount: 180, sale_number: 50 })],
      'tl:itens': [],
      'tl:itens-devolvidos': [{
        troca_sale_id: SALE_1, product_id: 'p9', variant_id: null, product_name: 'Saia',
        variant_values: null, sku_suffix: null, quantity: 1, unit_price: 150,
      }],
    });
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline?types=troca`);
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ type: 'troca', title: 'Troca #50', amount: null });
    expect(res.body.events[0].meta).toMatchObject({ new_items_total: 180, exchange_of_sale_id: SALE_2 });
    expect(res.body.events[0].meta.returned_items).toEqual([{
      product_id: 'p9', variant_id: null, product_name: 'Saia', variant: null, quantity: 1, unit_price: 150,
    }]);
  });

  it('types filtra as fontes consultadas', async () => {
    const calls = banco({ 'tl:companies': companiesA('negocio') });
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline?types=nota,cupom`);
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual(['nota', 'cupom']);
    const fontes = calls.map(c => c.tag).filter(t => t.startsWith('tl:') && t !== 'tl:companies');
    expect(fontes.sort()).toEqual(['tl:cupom-gerado', 'tl:cupom-usado', 'tl:nota']);
  });

  it('types inválido é 400 antes de tocar o banco', async () => {
    const calls = banco({});
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline?types=compra,venda`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/types invalido/);
    expect(calls).toHaveLength(0);
  });

  it('cursor inválido é 400; id inválido é 400; cliente de outro dono é 404', async () => {
    banco({});
    expect((await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline?cursor=xyz`)).status).toBe(400);
    expect((await request(app).get(`/companies/${CO_A}/customers/nao-e-uuid/timeline`)).status).toBe(400);
    banco({ 'perfil:cliente': [] });
    expect((await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline`)).status).toBe(404);
  });
});

describe('gate por tipo (plano lido do banco)', () => {
  it('Essencial: 200, sem consultar mensagem/crediário, com locked_types', async () => {
    const calls = banco({ 'tl:companies': companiesA('essencial') });
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body.locked_types).toEqual(['crediario', 'mensagem']);
    expect(res.body.types).not.toContain('crediario');
    expect(calls.some(c => /^tl:(crediario|mensagem)/.test(c.tag))).toBe(false);
  });

  it('Essencial pedindo só crediário: 200 vazio, não 403', async () => {
    banco({ 'tl:companies': companiesA('essencial') });
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline?types=crediario`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ events: [], types: [], locked_types: ['crediario'] });
  });

  it('o JWT diz expansao, o banco diz essencial: vale o banco (armadilha 9)', async () => {
    const calls = banco({ 'tl:companies': companiesA('essencial') });
    await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline?types=mensagem`);
    expect(calls.some(c => c.tag.startsWith('tl:mensagem'))).toBe(false);
  });

  it('Negócio: crediário (sem débito de venda) e mensagens com status', async () => {
    const calls = banco({
      'tl:companies': companiesA('negocio'),
      'tl:crediario': [{
        ev_key: 'eeeeeeee-0000-4000-8000-000000000000', ev_at: new Date('2026-09-03T10:00:00.000Z'),
        id: 't1', company_id: CO_A, sale_id: null, type: 'payment', amount: 80,
        payment_method: 'pix', notes: null,
      }],
      'tl:mensagem-marketing': [{
        ev_key: 'ffffffff-0000-4000-8000-000000000000', ev_at: new Date('2026-09-04T10:00:00.000Z'),
        id: 'l1', company_id: CO_A, kind: 'reativacao', segment: 'at_risk', coupon_id: 'c1',
        wa_outbox_id: 'o1', status: 'delivered', template_name: 'volta', skip_reason: null,
      }],
      'tl:mensagem-aniversario': [],
      'tl:mensagem-outbox': [{
        ev_key: '99999999-0000-4000-8000-000000000000', ev_at: new Date('2026-09-02T10:00:00.000Z'),
        id: 'o2', company_id: CO_A, kind: 'template', template_name: 'cobranca',
        status: 'read', skip_reason: null, source_type: 'crediario',
      }],
    });
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline?types=crediario,mensagem`);
    expect(res.status).toBe(200);
    expect(res.body.locked_types).toEqual([]);
    expect(res.body.events.map(e => [e.type, e.title, e.amount])).toEqual([
      ['mensagem', 'Mensagem de reativação', null],
      ['crediario', 'Pagamento do crediário', -80],
      ['mensagem', 'Mensagem no WhatsApp', null],
    ]);
    expect(res.body.events[0].meta).toMatchObject({ status: 'delivered', segment: 'at_risk', template_name: 'volta' });
    expect(res.body.events[1].meta.kind).toBe('payment');

    const cred = calls.find(c => c.tag === 'tl:crediario');
    expect(cred.sql).toMatch(/NOT \(t\.type = 'debit' AND t\.sale_id IS NOT NULL\)/);
    const outbox = calls.find(c => c.tag === 'tl:mensagem-outbox');
    // telefone do cliente nas duas grafias (com e sem o nono dígito)
    expect(outbox.params[1]).toEqual(['5511987654321', '551187654321']);
    expect(outbox.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM wa_marketing_log/);
    const bday = calls.find(c => c.tag === 'tl:mensagem-aniversario');
    expect(bday.sql).toMatch(/method IS DISTINCT FROM 'wa_api'/);
  });
});

describe('deploy parcial', () => {
  it('tabela ausente (42P01) numa fonte não derruba a linha do tempo', async () => {
    banco({
      'tl:companies': companiesA('negocio'),
      'tl:nota': pgError('42P01'),
      'tl:mensagem-marketing': pgError('42P01'),
      'tl:compra': [saleRow()],
      'tl:itens': pgError('42P01'),
    });
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].meta.items).toEqual([]);
  });

  it('sem as colunas de parcelamento (42703) as vendas saem sem elas, e o cache lembra', async () => {
    const calls = banco({
      'tl:companies': companiesA('essencial'),
      'tl:compra': (sql) => (/is_installment/.test(sql) ? pgError('42703') : [saleRow({ is_installment: undefined })]),
      'tl:troca': (sql) => (/is_installment/.test(sql) ? pgError('42703') : []),
      'tl:cancelamento': (sql) => (/is_installment/.test(sql) ? pgError('42703') : []),
      'tl:itens': [],
    });
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline?types=compra`);
    expect(res.status).toBe(200);
    expect(res.body.events[0].meta).not.toHaveProperty('is_installment');
    const compraCalls = calls.filter(c => c.tag === 'tl:compra');
    expect(compraCalls).toHaveLength(2);

    const calls2 = banco({ 'tl:companies': companiesA('essencial'), 'tl:compra': [] });
    await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline?types=compra`);
    expect(calls2.filter(c => c.tag === 'tl:compra')).toHaveLength(1);
    expect(calls2.find(c => c.tag === 'tl:compra').sql).not.toMatch(/is_installment/);
  });

  it('erro que não é de schema vira 500', async () => {
    banco({ 'tl:companies': companiesA('essencial'), 'tl:nota': pgError('57014') });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/timeline`);
    spy.mockRestore();
    expect(res.status).toBe(500);
  });
});

describe('GET /customers/:cid/summary', () => {
  it('monta as métricas do topo da ficha', async () => {
    const calls = banco({
      'tl:companies': companiesA('negocio'),
      'tl:resumo-vendas': [{
        purchases: '4', total_spent: 1000, exchanges: '1',
        first_purchase_at: new Date('2026-01-10T12:00:00Z'), last_purchase_at: new Date('2026-07-10T12:00:00Z'),
        purchase_days: '3', span_days: 181, days_since_last: 68,
      }],
      'tl:resumo-crediario': [{ balance: 120.5 }],
      'tl:resumo-avaliacoes': [{ avg: 4.5, n: '2' }],
    });
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scope: 'company',
      customer_id: CID,
      company_ids: [CO_A],
      total_spent: 1000,
      purchases_count: 4,
      avg_ticket: 250,
      first_purchase_at: '2026-01-10T12:00:00.000Z',
      last_purchase_at: '2026-07-10T12:00:00.000Z',
      days_since_last_purchase: 68,
      avg_days_between_purchases: 90.5,
      exchanges_count: 1,
      credit_balance: 120.5,
      credit_locked: false,
      rating_avg: 4.5,
      ratings_count: 2,
    });
    const vendas = calls.find(c => c.tag === 'tl:resumo-vendas');
    expect(vendas.sql).toMatch(/COALESCE\(type, 'sale'\) <> 'troca'/);
    expect(vendas.sql).toMatch(/COALESCE\(status, 'completed'\) <> 'cancelled'/);
  });

  it('Essencial e cliente sem compra: saldo travado, sem divisão por zero', async () => {
    const calls = banco({
      'tl:companies': companiesA('essencial'),
      'tl:resumo-vendas': [{
        purchases: '0', total_spent: 0, exchanges: '0', first_purchase_at: null, last_purchase_at: null,
        purchase_days: '0', span_days: null, days_since_last: null,
      }],
      'tl:resumo-avaliacoes': pgError('42P01'),
    });
    const res = await request(app).get(`/companies/${CO_A}/customers/${CID}/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      purchases_count: 0, avg_ticket: 0, avg_days_between_purchases: null,
      days_since_last_purchase: null, credit_balance: null, credit_locked: true,
      rating_avg: null, ratings_count: 0,
    });
    expect(calls.some(c => c.tag === 'tl:resumo-crediario')).toBe(false);
  });
});

describe('visão consolidada /me', () => {
  it('agrega só as empresas do dono que o usuário acessa, com company_name', async () => {
    const outro = '77777777-7777-4777-8777-777777777777';
    const calls = banco({
      'perfil:me-empresas': [{ id: CO_A }, { id: CO_B }, { id: outro }],
      'perfil:me-cliente': [customerRow],
      'owner-scope': [{ id: CO_A }, { id: CO_B }],
      'tl:companies': [
        { id: CO_A, name: 'Loja A', plan: 'essencial' },
        { id: CO_B, name: 'Loja B', plan: 'negocio' },
      ],
      'tl:compra': [
        saleRow({ company_id: CO_B }),
        saleRow({ ev_key: 'cccccccc-0000-4000-8000-000000000000', ev_at: new Date('2026-09-01T00:00:00Z'), sale_id: SALE_2 }),
      ],
      'tl:itens': [],
    });

    const res = await request(app).get(`/me/customers/${CID}/timeline`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('owner');
    expect(res.body.company_ids).toEqual([CO_A, CO_B]);
    expect(res.body.events.map(e => e.company_name)).toEqual(['Loja B', 'Loja A']);
    // Loja B é Negócio: mensagem e crediário liberados, só para ela
    expect(res.body.locked_types).toEqual([]);
    expect(calls.find(c => c.tag === 'tl:crediario').params[0]).toEqual([CO_B]);
    expect(calls.find(c => c.tag === 'tl:compra').params[0]).toEqual([CO_A, CO_B]);
  });

  it('cliente fora do alcance do usuário é 404; sem token é 401', async () => {
    banco({ 'perfil:me-empresas': [{ id: CO_A }], 'perfil:me-cliente': [] });
    expect((await request(app).get(`/me/customers/${CID}/timeline`).set(auth)).status).toBe(404);
    expect((await request(app).get(`/me/customers/${CID}/timeline`)).status).toBe(401);
  });

  it('resumo consolidado soma as empresas', async () => {
    const calls = banco({
      'perfil:me-empresas': [{ id: CO_A }, { id: CO_B }],
      'perfil:me-cliente': [customerRow],
      'owner-scope': [{ id: CO_A }, { id: CO_B }],
      'tl:companies': [{ id: CO_A, name: 'A', plan: 'expansao' }, { id: CO_B, name: 'B', plan: 'essencial' }],
      'tl:resumo-vendas': [{ purchases: '2', total_spent: 300, exchanges: '0', first_purchase_at: null, last_purchase_at: null, purchase_days: '1', span_days: 0, days_since_last: 3 }],
      'tl:resumo-crediario': [{ balance: 0 }],
      'tl:resumo-avaliacoes': [{ avg: null, n: '0' }],
    });
    const res = await request(app).get(`/me/customers/${CID}/summary`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scope: 'owner', total_spent: 300, avg_ticket: 150, credit_balance: 0 });
    expect(calls.find(c => c.tag === 'tl:resumo-vendas').params[0]).toEqual([CO_A, CO_B]);
    expect(calls.find(c => c.tag === 'tl:resumo-crediario').params[0]).toEqual([CO_A]);
  });
});
