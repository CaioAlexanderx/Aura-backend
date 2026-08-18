// ============================================================
// AURA. -- K1 (Quadro Vivo): a cara do card
//
// O card do Kanban mostrava a IDADE do pedido e nenhuma imagem. Num
// negocio visual isso e uma planilha em pe, e "3d atras" nao diz se o
// prazo esta apertado.
//
// O que estes testes travam:
//   1. imagem em cascata, SEM configuracao: mockup -> render -> foto do
//      produto; nada encontrado => null (o app cai no monograma)
//   2. promised_date exposto, com guarda de deploy parcial -- sem a coluna
//      a query RICA continua de pe (perde-la derrubaria tambem a imagem)
//   3. a aba "A receber" passa a enxergar venda com saldo SEM producao
//   4. o KANBAN continua NAO enxergando essas vendas -- sem personalizacao
//      nao ha fabricacao, entao nao e fila de producao (premissa de produto,
//      nao detalhe de implementacao)
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

let db;
let app;

function buildApp() {
  jest.resetModules();
  process.env.JWT_SECRET = SECRET;
  db = require('../../src/config/database');
  const studioRouter = require('../../src/routes/studioKdsApproval');
  const a = express();
  a.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/studio', studioRouter);
  a.use('/api/v1/companies/:id', scoped);
  return a;
}

// hasTable: credit_installments. hasPromised: coluna sales.promised_date.
// semProducao: linhas devolvidas pela consulta suplementar da aba "A receber".
function mockDb({ hasTable = true, hasPromised = true, rows = [], semProducao = [] } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/to_regclass/i.test(s)) {
      return Promise.resolve({ rows: [{ t: hasTable ? 'credit_installments' : null }] });
    }
    if (/information_schema\.columns/i.test(s) && /promised_date/i.test(s)) {
      return Promise.resolve({ rows: hasPromised ? [{ '?column?': 1 }] : [] });
    }
    // consulta suplementar: le sales direto, nao a view
    if (/FROM sales s/i.test(s) && /studio_production_status IS NULL/i.test(s)) {
      return Promise.resolve({ rows: semProducao });
    }
    if (/FROM studio_orders/i.test(s)) return Promise.resolve({ rows });
    if (/FROM digital_orders/i.test(s)) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
}

const get = (qs = '') => request(app).get(`/api/v1/companies/${cid}/studio/orders${qs}`).set(adminAuth);
const richSql = () => db.query.mock.calls.map((c) => String(c[0] || '')).find((s) => /approval_count/i.test(s)) || '';
const extraSql = () => db.query.mock.calls.map((c) => String(c[0] || '')).find((s) => /studio_production_status IS NULL/i.test(s)) || '';

beforeEach(() => {
  jest.resetAllMocks();
  app = buildApp();
});

describe('imagem do card — cascata sem configuração', () => {
  test('a ordem é mockup → render → foto do produto', async () => {
    mockDb({ rows: [] });
    await get();

    const sql = richSql();
    expect(sql).toMatch(/card_image_url/);
    // dentro do COALESCE, o mockup vem antes do render, que vem antes do produto
    const bloco = sql.slice(sql.indexOf('COALESCE('), sql.indexOf('AS card_image_url'));
    const posMockup  = bloco.indexOf('mockup_url');
    const posRender  = bloco.indexOf('studio_visual_renders');
    const posProduto = bloco.indexOf('p.image_url');
    expect(posMockup).toBeGreaterThan(-1);
    expect(posMockup).toBeLessThan(posRender);
    expect(posRender).toBeLessThan(posProduto);
  });

  test('render HD tem prioridade sobre preview', async () => {
    mockDb({ rows: [] });
    await get();
    expect(richSql()).toMatch(/ORDER BY \(r\.kind = 'hd_2d'\) DESC/);
  });

  test('string vazia não conta como imagem', async () => {
    mockDb({ rows: [] });
    await get();
    // toda perna da cascata descarta '' — senão o card mostraria um vão
    expect(richSql()).toMatch(/NULLIF\(TRIM\(a\.mockup_url\), ''\)/);
    expect(richSql()).toMatch(/NULLIF\(TRIM\(p\.image_url\), ''\)/);
  });

  test('entrega a imagem encontrada; sem nenhuma, devolve null', async () => {
    mockDb({ rows: [
      { id: 'o1', source: 'pdv', card_image_url: 'https://cdn/mockup.png' },
      { id: 'o2', source: 'pdv', card_image_url: null },
    ] });

    const res = await get();
    expect(res.body.orders[0].card_image_url).toBe('https://cdn/mockup.png');
    expect(res.body.orders[1].card_image_url).toBeNull();
  });
});

describe('prazo prometido', () => {
  test('expõe promised_date quando a coluna existe', async () => {
    mockDb({ rows: [{ id: 'o1', source: 'pdv', promised_date: '2026-08-22' }] });

    const res = await get();
    expect(richSql()).toMatch(/s2\.promised_date/);
    expect(res.body.orders[0].promised_date).toBe('2026-08-22');
  });

  // Sem a guarda, a coluna ausente derrubaria a query rica inteira pro slim —
  // levando junto item_count, aprovações e a imagem do card.
  test('sem a migration 285, a query rica continua de pé e o campo vem null', async () => {
    mockDb({ hasPromised: false, rows: [{ id: 'o1', source: 'pdv' }] });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBeUndefined();       // não caiu pro fallback
    expect(richSql()).toMatch(/card_image_url/);     // imagem preservada
    expect(richSql()).not.toMatch(/promised_date/);  // prazo omitido
    expect(res.body.orders[0].promised_date).toBeNull();
  });
});

describe('venda sem fabricação: cobrança sim, produção não', () => {
  const SEM_PRODUCAO = {
    id: 'sale-9', source: 'pdv', pdv_sale_id: 'sale-9',
    studio_production_status: null, customer_name: 'Maria',
    total_amount: '80.00', balance_installment_id: 'inst-9',
    balance_amount: '40.00', balance_due_date: '2026-08-30', balance_status: 'pending',
  };

  test('a aba "A receber" enxerga a venda com saldo mesmo sem produção', async () => {
    mockDb({ rows: [], semProducao: [SEM_PRODUCAO] });

    const res = await get('?with_balance=true');
    expect(res.status).toBe(200);
    expect(res.body.orders.map((o) => o.id)).toContain('sale-9');
    // a consulta suplementar só traz quem tem saldo de verdade
    expect(extraSql()).toMatch(/JOIN LATERAL/i);
    expect(extraSql()).toMatch(/NOT IN \('paid', 'cancelled'\)/i);
  });

  // Premissa de produto: sem personalização não há fabricação, então não é
  // fila de produção. O Kanban não pode herdar essas vendas.
  test('o Kanban NÃO enxerga essas vendas', async () => {
    mockDb({ rows: [], semProducao: [SEM_PRODUCAO] });

    const res = await get();
    expect(res.body.orders).toHaveLength(0);
    expect(extraSql()).toBe('');  // a consulta suplementar nem roda
  });

  test('sem a tabela de parcelas, a suplementar não roda', async () => {
    mockDb({ hasTable: false, rows: [], semProducao: [SEM_PRODUCAO] });

    const res = await get('?with_balance=true');
    expect(res.status).toBe(200);
    expect(extraSql()).toBe('');
  });

  test('o resultado sai ordenado por data, misturando as duas fontes', async () => {
    mockDb({
      rows: [{ id: 'antigo', source: 'pdv', created_at: '2026-08-01T10:00:00Z' }],
      semProducao: [{ ...SEM_PRODUCAO, created_at: '2026-08-15T10:00:00Z' }],
    });

    const res = await get('?with_balance=true');
    expect(res.body.orders.map((o) => o.id)).toEqual(['sale-9', 'antigo']);
  });
});

describe('shape estável nos fallbacks', () => {
  test('slim devolve os campos do card nulos, sem o app precisar checar', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql || '');
      if (/to_regclass/i.test(s)) return Promise.resolve({ rows: [{ t: 'credit_installments' }] });
      if (/information_schema\.columns/i.test(s)) return Promise.resolve({ rows: [{ x: 1 }] });
      if (/approval_count/i.test(s)) return Promise.reject(Object.assign(new Error('boom'), { code: '42703' }));
      if (/FROM studio_orders/i.test(s)) return Promise.resolve({ rows: [{ id: 'o1', customer_name: 'Maria' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await get();
    expect(res.body.degraded).toBe('slim');
    expect(res.body.orders[0]).toHaveProperty('card_image_url', null);
    expect(res.body.orders[0]).toHaveProperty('promised_date', null);
  });
});
