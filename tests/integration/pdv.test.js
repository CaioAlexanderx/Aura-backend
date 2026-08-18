// ============================================================
// QA-02 — Testes de Integração: PDV (Ponto de Venda)
// PDV usa db.connect() (transação atômica) — mock precisa de connect
//
// 07/05/2026: /summary virou Promise.all com 2 queries (vendas + trocas)
// via pdv-summary-patch.js. Teste atualizado pra mockar ambas.
//
// 11/05/2026: PR #56 introduziu assertCaixaOpenOrAllowed que faz query
// SELECT pdv_settings logo apos BEGIN. Mocks de POST /sale precisavam
// incluir CAIXA_DISABLED_MOCK pra nao desalinhar a sequencia.
//
// 18/08/2026: mock convertido pra DESPACHO POR SQL. As duas notas acima sao
// justamente correcoes de desalinhamento de fila -- manutencao pura, sem
// nenhum bug encontrado. Com despacho por conteudo, query nova no fluxo de
// venda deixa de quebrar o teste, e o helper ja resolve o caixa sozinho.
// Convencao do CLAUDE.md: mock por SQL, nunca por posicao.
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio' }, SECRET, { expiresIn:'1h' })}` };

const mockProduct = { id:'p1', name:'Produto Teste', price:25.00, stock_qty:10, cost_price:10 };
const mockSale    = { id:'sale1', total_amount:25.00, payment_method:'pix', status:'confirmed', created_at: new Date().toISOString() };

// PR #56: assertCaixaOpenOrAllowed faz query SELECT pdv_settings logo
// apos BEGIN. Caixa_enabled=false faz o helper retornar ok sem consumir
// o segundo slot (SELECT caixa_sessoes).
const CAIXA_DISABLED_MOCK = { rows: [{ pdv_settings: { caixa_enabled: false } }] };

// Helper: cliente transacional mockado, despachando por CONTEUDO DO SQL.
//
// 18/08/2026: era posicional (uma fila de mockResolvedValueOnce espelhando a
// ordem exata das queries do handleSale). Toda query nova no fluxo de venda
// deslocava a fila; os dois avisos no cabecalho deste arquivo (07/05 e 11/05)
// sao correcoes desse tipo -- manutencao pura, sem bug encontrado.
//
// Agora cada teste declara SO o que importa pra ele, por regex de SQL. Query
// nova no meio do fluxo nao quebra nada, e o que nao foi declarado cai num
// default seguro.
function mockClient(porSql = {}) {
  const client = { query: jest.fn(), release: jest.fn() };
  client.query.mockImplementation((sql) => {
    const t = String(sql || '');
    for (const [padrao, valor] of Object.entries(porSql)) {
      if (new RegExp(padrao, 'i').test(t)) return Promise.resolve(valor);
    }
    // assertCaixaOpenOrAllowed: caixa_enabled=false aprova sem checar sessoes
    if (/SELECT pdv_settings FROM companies/i.test(t)) return Promise.resolve(CAIXA_DISABLED_MOCK);
    return Promise.resolve({ rows: [] });
  });
  return client;
}

describe('POST /companies/:id/pdv/sale — validações de entrada', () => {
  test('400 — items vazio', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({ payment_method: 'pix', items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/items/i);
  });

  test('400 — items ausente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({ payment_method: 'pix' });
    expect(res.status).toBe(400);
  });

  test('401 — sem token', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .send({ payment_method:'pix', items:[{ product_id:'p1', quantity:1, unit_price:25 }] });
    expect(res.status).toBe(401);
  });
});

describe('POST /companies/:id/pdv/sale — venda atômica', () => {
  test('201 — venda criada (produto sem rastrear estoque)', async () => {
    // Produto sem product_id — não faz query de produto, só BEGIN + caixa_check + INSERT sale + INSERT item + COMMIT
    const client = mockClient({
      'INSERT INTO sales':      { rows: [mockSale] },
      'INSERT INTO sale_items': { rows: [{ id: 'si1' }] },
    });
    db.connect.mockResolvedValueOnce(client);
    // db.query extra após COMMIT (busca itens)
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'pix',
        items: [{
          product_name_snapshot: 'Produto Avulso',
          quantity: 1,
          unit_price: 25,
        }],
      });
    expect([200, 201]).toContain(res.status);
  });

  test('409 — estoque insuficiente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const client = mockClient({
      // o que este teste realmente diz: o produto existe, mas com estoque 0
      'FROM products p JOIN companies': { rows: [{ name: 'Produto', cost_price: 10, stock_qty: '0' }] },
    });
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'pix',
        items: [{ product_id:'p1', quantity:5, unit_price:25 }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/estoque/i);
  });
});

describe('GET /companies/:id/pdv/summary — resumo do dia', () => {
  test('200 — retorna resumo', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    // pdv-summary-patch.js faz Promise.all com 2 queries:
    //   (1) vendas regulares (type IS NULL ou 'sale')
    //   (2) trocas do dia (type='troca' + transactions netAmount)
    db.query.mockResolvedValueOnce({
      rows: [{ total_sales:'5', gross_revenue:'250.00', total_discounts:'0', avg_ticket:'50.00', by_payment_method:null }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ trocas_count: 0, trocas_net_received: 0 }],
    });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/pdv/summary`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_sales');
    expect(res.body).toHaveProperty('gross_revenue');
    expect(res.body).toHaveProperty('trocas_count');
    expect(res.body).toHaveProperty('trocas_net_received');
  });

  test('401 — sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/pdv/summary`);
    expect(res.status).toBe(401);
  });
});

// ============================================================
// 03/08/2026 — cupom + desconto manual SOMAM (regressao)
//
// O PDV mostra `subtotal - manual - cupom` na tela e manda os DOIS campos
// no mesmo body (aura-app/hooks/useCart.ts: dois `if` independentes).
// Enquanto o backend era um if/else-if, o cupom vencia e o desconto manual
// sumia em silencio -- a venda era gravada com total MAIOR que o combinado
// (sobra no fechamento de caixa a vista, debito a maior no crediario).
//
// POR QUE O MOCK DESTE BLOCO E DIFERENTE DO `mockClient` ACIMA:
// o mockClient encadeia `mockResolvedValueOnce` e depende da ORDEM exata
// das queries. Esse acoplamento ja quebrou este arquivo duas vezes (ver o
// cabecalho: 07/05/2026 e 11/05/2026 -- as duas vezes porque alguem inseriu
// uma query nova no meio do handler). O helper abaixo despacha por TRECHO
// DE SQL (`client.query.mockImplementation`), com default `{ rows: [] }`:
// quem adicionar uma query nova no POST /sale nao desalinha nada, e as
// assercoes leem os parametros do `INSERT INTO sales` pelo SQL, nao pelo
// indice da chamada.
//
// Todos os itens vao SEM product_id de proposito -- assim o handler nao
// dispara a query de produto/estoque e o teste fica focado no calculo.
// ============================================================
describe('POST /companies/:id/pdv/sale — cupom + desconto', () => {
  // Default seguro pro mock global de db (jest.setup.js cria um jest.fn()
  // sem valor de retorno): o handler faz `const { rows } = await db.query(...)`
  // depois do COMMIT e um `undefined` estouraria no destructuring.
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
  });

  // Cliente transacional que responde por conteudo do SQL, nao por ordem.
  function mockSaleClient({ coupon = null, sale = { id: 'sale1' } } = {}) {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query.mockImplementation((sql) => {
      const q = typeof sql === 'string' ? sql : String((sql && sql.text) || '');
      if (/^\s*BEGIN/i.test(q))    return Promise.resolve({ rows: [] });
      if (/^\s*COMMIT/i.test(q))   return Promise.resolve({ rows: [] });
      if (/^\s*ROLLBACK/i.test(q)) return Promise.resolve({ rows: [] });
      if (/pdv_settings/.test(q))  return Promise.resolve({ rows: [{ pdv_settings: { caixa_enabled: false } }] });
      if (/caixa_sessoes/.test(q)) return Promise.resolve({ rows: [] });
      if (/FROM coupons/.test(q))  return Promise.resolve({ rows: coupon ? [coupon] : [] });
      if (/UPDATE coupons/.test(q))            return Promise.resolve({ rows: [] });
      if (/INSERT INTO sales/.test(q))         return Promise.resolve({ rows: [sale] });
      if (/INSERT INTO sale_items/.test(q))    return Promise.resolve({ rows: [] });
      if (/INSERT INTO sale_payments/.test(q)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO transactions/.test(q))  return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] }); // default: nunca desalinha
    });
    return client;
  }

  function findQuery(client, re) {
    return client.query.mock.calls.find(([sql]) => re.test(String(sql)));
  }
  // params do INSERT INTO sales: [5]=total_amount, [6]=discount_amount
  function saleParams(client) {
    const call = findQuery(client, /INSERT INTO sales/);
    return call ? call[1] : null;
  }

  const ITEM = (price) => ({ product_name_snapshot: 'Item Avulso', quantity: 1, unit_price: price });

  const coupon = (type, value, extra = {}) => ({
    id: 'coup1', code: 'CUPOM10', discount_type: type, discount_value: value,
    min_order_value: 0, max_uses: null, current_uses: 0, expires_at: null,
    customer_id: null, owner_name: null, ...extra,
  });

  function arrange(opts) {
    const client = mockSaleClient(opts);
    db.connect.mockResolvedValueOnce(client);
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    return client;
  }

  test('cupom + desconto manual em R$ SOMAM (subtotal 100, cupom 10, manual 5)', async () => {
    const client = arrange({ coupon: coupon('fixed', 10) });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'dinheiro',
        items: [ITEM(100)],
        coupon_code: 'CUPOM10',
        discount_amount: 5,
      });

    expect(res.status).toBe(201);
    const p = saleParams(client);
    expect(p[6]).toBe(15); // discount_amount = 10 (cupom) + 5 (manual)
    expect(p[5]).toBe(85); // total_amount    = 100 - 15
  });

  test('cupom + desconto manual em % SOMAM (subtotal 200, cupom 10%, manual 10%)', async () => {
    const client = arrange({ coupon: coupon('percent', 10) });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'dinheiro',
        items: [ITEM(200)],
        coupon_code: 'CUPOM10',
        discount_pct: 10,
      });

    expect(res.status).toBe(201);
    const p = saleParams(client);
    expect(p[6]).toBe(40);  // 20 (cupom) + 20 (manual)
    expect(p[5]).toBe(160);
  });

  test('soma nao passa do subtotal — total nunca negativo', async () => {
    const client = arrange({ coupon: coupon('fixed', 40) });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'dinheiro',
        items: [ITEM(50)],
        coupon_code: 'CUPOM10',
        discount_amount: 30,
      });

    expect(res.status).toBe(201);
    const p = saleParams(client);
    expect(p[6]).toBe(50); // 40 + 30 = 70, com teto no subtotal
    expect(p[5]).toBe(0);
  });

  test('so cupom, sem desconto manual — comportamento antigo preservado', async () => {
    const client = arrange({ coupon: coupon('fixed', 10) });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'dinheiro', items: [ITEM(100)], coupon_code: 'CUPOM10',
      });

    expect(res.status).toBe(201);
    const p = saleParams(client);
    expect(p[6]).toBe(10);
    expect(p[5]).toBe(90);
  });

  test('so desconto manual, sem cupom — comportamento antigo preservado', async () => {
    const client = arrange({});

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'dinheiro', items: [ITEM(100)], discount_amount: 25,
      });

    expect(res.status).toBe(201);
    const p = saleParams(client);
    expect(p[6]).toBe(25);
    expect(p[5]).toBe(75);
  });

  test('cupom nominal de outro cliente — 400 COUPON_CUSTOMER_MISMATCH, sem gravar venda', async () => {
    const client = arrange({ coupon: coupon('fixed', 10, { customer_id: 'cust-A', owner_name: 'Maria' }) });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'dinheiro', items: [ITEM(100)],
        coupon_code: 'CUPOM10', customer_id: 'cust-B', discount_amount: 5,
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('COUPON_CUSTOMER_MISMATCH');
    expect(findQuery(client, /^\s*ROLLBACK/i)).toBeTruthy();
    expect(findQuery(client, /INSERT INTO sales/)).toBeFalsy();
  });

  test('cupom nominal sem cliente na venda — 400 COUPON_REQUIRES_CUSTOMER, sem gravar venda', async () => {
    const client = arrange({ coupon: coupon('fixed', 10, { customer_id: 'cust-A', owner_name: 'Maria' }) });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'dinheiro', items: [ITEM(100)], coupon_code: 'CUPOM10',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('COUPON_REQUIRES_CUSTOMER');
    expect(findQuery(client, /^\s*ROLLBACK/i)).toBeTruthy();
    expect(findQuery(client, /INSERT INTO sales/)).toBeFalsy();
  });

  test('cupom nominal para o proprio dono — passa e soma com o manual', async () => {
    const client = arrange({ coupon: coupon('fixed', 10, { customer_id: 'cust-A', owner_name: 'Maria Silva' }) });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'dinheiro', items: [ITEM(100)],
        coupon_code: 'CUPOM10', customer_id: 'cust-A', discount_amount: 5,
      });

    expect(res.status).toBe(201);
    const p = saleParams(client);
    expect(p[6]).toBe(15);
    expect(p[5]).toBe(85);
  });

  test('cupom generico (customer_id null) sem cliente na venda — passa', async () => {
    const client = arrange({ coupon: coupon('fixed', 10, { customer_id: null }) });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'dinheiro', items: [ITEM(100)], coupon_code: 'CUPOM10',
      });

    expect(res.status).toBe(201);
    const p = saleParams(client);
    expect(p[6]).toBe(10);
    expect(p[5]).toBe(90);
  });
});
