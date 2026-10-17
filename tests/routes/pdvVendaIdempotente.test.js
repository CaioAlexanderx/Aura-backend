// ============================================================
// AURA. -- Testes: venda idempotente no Caixa (card tq-15, migration 390)
//
// O app manda `Idempotency-Key` no POST /pdv/sale. O que estes testes travam:
//   1. mesma chave duas vezes: a segunda devolve a MESMA venda (201, mesmo
//      corpo) e grava 1 linha so; estoque, receita e trial uma vez so
//   2. duas requisicoes SIMULTANEAS com a mesma chave: 1 venda
//   3. chave diferente: 2 vendas
//   4. sem chave: o SQL e o de sempre (nenhuma trava, nenhuma sondagem)
//   5. com comanda_id: a comanda fecha uma vez so; a repeticao nao toca nela
//   6. colisao no indice unico (23505) devolve a venda que ganhou
//   7. mesma chave com outros itens: 409 IDEMPOTENCY_KEY_REUSED, nada gravado
//   8. migration 390 ausente: segue sem idempotencia; chave fora do formato
//      e ignorada
//   9. venda com sinal (/sale-com-sinal) usa a mesma chave
//
// Banco de mentira com transacao de verdade: cada db.connect() e um client
// que acumula as escritas e so as aplica no COMMIT; a trava (advisory lock)
// e uma fila por chave liberada no COMMIT/ROLLBACK. Mock por CONTEUDO do
// SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const pdvRouter = require('../../src/routes/pdv');
const vendaIdempotente = require('../../src/services/vendaIdempotente');
const comandaSaleHooks = require('../../src/services/comandaSaleHooks');

let db;
beforeAll(() => { db = require('../../src/config/database'); });

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const prod = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const comandaId = 'cccccccc-1111-4222-8333-444444444444';
const KEY = '5f0c1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
const KEY2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

const app = express();
app.use(express.json());
const scoped = express.Router({ mergeParams: true });
scoped.use(requireAuth);
scoped.use(requireCompanyAccess());
scoped.use('/pdv', pdvRouter);
app.use('/api/v1/companies/:id', scoped);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));

const tick = () => new Promise((r) => setImmediate(r));

// ── Banco de mentira ─────────────────────────────────────────
function fakeDb({ colunas = 2, colisaoNoInsert = false } = {}) {
  const banco = {
    sales: [],
    saleItems: [],
    stock: { [prod]: 100 },
    transactions: [],
    comanda: { id: comandaId, number: 7, status: 'open' },
    comandaCloses: 0,
    creditDebits: 0,
    locks: new Map(), // chave -> Promise da fila
    seq: 0,
    inserts: 0,
  };

  function novoClient() {
    let pendente = [];
    let soltarTrava = null;
    const vistaDaComanda = () => ({ ...banco.comanda });

    function fim(aplicar) {
      if (aplicar) pendente.forEach((fn) => fn());
      pendente = [];
      if (soltarTrava) { soltarTrava(); soltarTrava = null; }
    }

    const query = jest.fn(async (sql, params = []) => {
      const s = String(sql || '').trim();
      if (s === 'BEGIN') return { rows: [] };
      if (s === 'COMMIT') { fim(true); return { rows: [] }; }
      if (s === 'ROLLBACK') { fim(false); return { rows: [] }; }

      if (/pg_advisory_xact_lock/.test(s)) {
        const k = params[0];
        const anterior = banco.locks.get(k) || Promise.resolve();
        let solta;
        const minha = new Promise((r) => { solta = r; });
        banco.locks.set(k, anterior.then(() => minha));
        await anterior;
        soltarTrava = solta;
        return { rows: [{}] };
      }
      if (/SELECT id FROM sales WHERE company_id = \$1 AND idempotency_key = \$2/.test(s)) {
        const v = banco.sales.find((x) => x.company_id === params[0] && x.idempotency_key === params[1]);
        return { rows: v ? [{ id: v.id }] : [] };
      }
      if (/SELECT pdv_settings FROM companies/i.test(s)) return { rows: [{ pdv_settings: {} }] };
      if (/INSERT INTO customers/i.test(s)) return { rows: [{ id: 'cust-1' }] };
      // crediario (saldo da venda com sinal)
      if (/INSERT INTO customer_credit_profiles/i.test(s)) return { rows: [{ id: 'prof-1', status: 'active', credit_score: 700 }] };
      if (/INSERT INTO credit_plan_configs/i.test(s)) return { rows: [{ id: 'conf-1', max_installments: 12, interest_rate: '0' }] };
      if (/INSERT INTO customer_credit_transactions/i.test(s)) {
        pendente.push(() => { banco.creditDebits += 1; });
        return { rows: [{ id: 'tx-1', type: 'debit', amount: '70.00' }] };
      }
      if (/INSERT INTO credit_installments/i.test(s)) return { rows: [{ id: 'inst-1' }] };
      if (/FROM caixa_sessoes/i.test(s)) return { rows: [] };
      if (/FROM products p JOIN companies c/i.test(s)) {
        return { rows: [{ name: 'Cimento', cost_price: '30', stock_qty: String(banco.stock[prod]), stock_company_id: cid }] };
      }
      if (/INSERT INTO sales/i.test(s)) {
        banco.inserts += 1;
        const temChave = /idempotency_key/.test(s);
        const chave = temChave ? params[params.length - 1] : null;
        if (colisaoNoInsert) {
          const e = new Error('duplicate key value violates unique constraint');
          e.code = '23505';
          e.constraint = 'uq_sales_company_idempotency_key';
          throw e;
        }
        if (chave && banco.sales.some((x) => x.company_id === params[0] && x.idempotency_key === chave)) {
          const e = new Error('duplicate key value violates unique constraint');
          e.code = '23505';
          e.constraint = 'uq_sales_company_idempotency_key';
          throw e;
        }
        banco.seq += 1;
        const row = {
          id: `sale-${banco.seq}`, sale_number: banco.seq, company_id: params[0],
          total_amount: String(params[5]), discount_amount: String(params[6]),
          coupon_code: params[10], status: 'completed', tracker_token: null,
          idempotency_key: chave, idempotency_response: null,
        };
        pendente.push(() => banco.sales.push(row));
        return { rows: [{ ...row }] };
      }
      if (/INSERT INTO sale_items/i.test(s)) {
        const [saleId, productId, variantId, quantity, unitPrice] = params;
        pendente.push(() => banco.saleItems.push({
          sale_id: saleId, product_id: productId, variant_id: variantId,
          quantity: String(quantity), unit_price: String(unitPrice), product_name_snapshot: params[8],
        }));
        return { rows: [] };
      }
      if (/UPDATE products SET stock_qty/i.test(s)) {
        const [qty, id] = params;
        pendente.push(() => { banco.stock[id] -= Number(qty); });
        return { rows: [] };
      }
      if (/INSERT INTO transactions/i.test(s)) {
        pendente.push(() => banco.transactions.push(params[4]));
        return { rows: [] };
      }
      if (/to_regclass\('public\.pdv_comandas'\)/.test(s)) return { rows: [{ ok: true }] };
      if (/FROM pdv_comandas\s+WHERE id = \$1 AND company_id = \$2\s+FOR UPDATE/i.test(s)) {
        return { rows: [vistaDaComanda()] };
      }
      if (/UPDATE pdv_comandas\s+SET status = 'closed'/i.test(s)) {
        pendente.push(() => { banco.comanda.status = 'closed'; banco.comandaCloses += 1; });
        return { rows: [] };
      }
      return { rows: [] };
    });
    return { query, release: jest.fn() };
  }

  db.connect.mockImplementation(async () => novoClient());
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql || '');
    if (/information_schema\.columns/.test(s) && /idempotency_key/.test(s)) return { rows: [{ n: colunas }] };
    if (/SELECT \* FROM sales WHERE company_id = \$1 AND idempotency_key = \$2/.test(s)) {
      const v = banco.sales.find((x) => x.company_id === params[0] && x.idempotency_key === params[1]);
      return { rows: v ? [{ ...v }] : [] };
    }
    if (/FROM sale_items si/i.test(s)) {
      return { rows: banco.saleItems.filter((i) => i.sale_id === params[0]).map((i) => ({ ...i })) };
    }
    if (/UPDATE sales SET idempotency_response/.test(s)) {
      const v = banco.sales.find((x) => x.id === params[1]);
      if (v) v.idempotency_response = JSON.parse(params[0]);
      return { rows: [] };
    }
    return { rows: [] };
  });
  return banco;
}

const BODY = {
  items: [{ product_id: prod, quantity: 2, unit_price: 38.9, product_name_snapshot: 'Cimento' }],
  payment_method: 'dinheiro',
};
const post = (body, key) => {
  const r = request(app).post(`/api/v1/companies/${cid}/pdv/sale`).set(adminAuth);
  if (key) r.set('Idempotency-Key', key);
  return r.send(body);
};

beforeEach(() => {
  jest.resetAllMocks();
  vendaIdempotente._resetCache();
  comandaSaleHooks._resetCache();
});

describe('POST /pdv/sale com Idempotency-Key', () => {
  test('1. mesma chave duas vezes: mesma venda, mesmo corpo, 1 linha, estoque e receita uma vez', async () => {
    const banco = fakeDb();
    const a = await post(BODY, KEY);
    expect(a.status).toBe(201);
    await tick(); // guardarResposta roda sem esperar
    const b = await post(BODY, KEY);

    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.idempotent_replay).toBe(true);
    const { idempotent_replay, ...corpoB } = b.body;
    expect(corpoB).toEqual(a.body);
    expect(b.body.sale.id).toBe(a.body.sale.id);

    expect(banco.sales).toHaveLength(1);
    expect(banco.inserts).toBe(1);
    expect(banco.saleItems).toHaveLength(1);
    expect(banco.stock[prod]).toBe(98);
    expect(banco.transactions).toEqual([`pdv-sale-${a.body.sale.id}`]);
    expect(banco.sales[0].idempotency_key).toBe(KEY);
  });

  test('2. duas requisicoes simultaneas com a mesma chave: 1 venda, as duas recebem a mesma', async () => {
    const banco = fakeDb();
    const [a, b] = await Promise.all([post(BODY, KEY), post(BODY, KEY)]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.sale.id).toBe(b.body.sale.id);
    expect([a.body.idempotent_replay, b.body.idempotent_replay].filter(Boolean)).toHaveLength(1);
    expect(banco.sales).toHaveLength(1);
    expect(banco.inserts).toBe(1);
    expect(banco.stock[prod]).toBe(98);
  });

  test('2b. a repeticao vem antes da conferencia de estoque: ultimo saldo vendido nao vira 409 falso', async () => {
    const banco = fakeDb();
    banco.stock[prod] = 2;
    const a = await post(BODY, KEY);
    expect(a.status).toBe(201);
    expect(banco.stock[prod]).toBe(0);
    const b = await post(BODY, KEY);
    expect(b.status).toBe(201);
    expect(b.body.sale.id).toBe(a.body.sale.id);
    // sem chave, a mesma tentativa e 409 de estoque (comportamento de hoje)
    const c = await post(BODY);
    expect(c.status).toBe(409);
  });

  test('3. chave diferente: duas vendas', async () => {
    const banco = fakeDb();
    const a = await post(BODY, KEY);
    const b = await post(BODY, KEY2);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.idempotent_replay).toBeUndefined();
    expect(a.body.sale.id).not.toBe(b.body.sale.id);
    expect(banco.sales).toHaveLength(2);
    expect(banco.stock[prod]).toBe(96);
  });

  test('4. sem chave: SQL de sempre, sem trava, sem sondagem e sem guardar resposta', async () => {
    const banco = fakeDb();
    const a = await post(BODY);
    const b = await post(BODY);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(banco.sales).toHaveLength(2);
    expect(banco.sales.every((v) => v.idempotency_key === null)).toBe(true);

    const sqls = db.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /information_schema/.test(s))).toBe(false);
    expect(sqls.some((s) => /idempotency_response/.test(s))).toBe(false);
    const clients = db.connect.mock.results.map((r) => r.value);
    const clientSqls = (await Promise.all(clients)).flatMap((c) => c.query.mock.calls.map((x) => String(x[0])));
    expect(clientSqls.some((s) => /pg_advisory_xact_lock/.test(s))).toBe(false);
    expect(clientSqls.filter((s) => /INSERT INTO sales/.test(s)).some((s) => /idempotency_key/.test(s))).toBe(false);
    // INSERT de sempre: 11 parametros, sem coluna nova
    const ins = (await Promise.all(clients)).flatMap((c) => c.query.mock.calls).filter((x) => /INSERT INTO sales/.test(String(x[0])));
    expect(ins[0][1]).toHaveLength(11);
  });

  test('5. com comanda_id: a comanda fecha uma vez so; a repeticao nao toca nela', async () => {
    const banco = fakeDb();
    const body = { ...BODY, comanda_id: comandaId };
    const a = await post(body, KEY);
    expect(a.status).toBe(201);
    expect(a.body.sale.comanda_id).toBe(comandaId);
    await tick();
    const b = await post(body, KEY);
    // Sem a chave seria 409 COMANDA_NOT_OPEN; com ela e a mesma venda.
    expect(b.status).toBe(201);
    expect(b.body.sale.id).toBe(a.body.sale.id);
    expect(b.body.sale.comanda_id).toBe(comandaId);
    expect(banco.comandaCloses).toBe(1);
    expect(banco.sales).toHaveLength(1);
  });

  test('5b. comanda + duas abas ao mesmo tempo: 1 venda, comanda fechada 1 vez', async () => {
    const banco = fakeDb();
    const body = { ...BODY, comanda_id: comandaId };
    const [a, b] = await Promise.all([post(body, KEY), post(body, KEY)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.sale.id).toBe(b.body.sale.id);
    expect(banco.comandaCloses).toBe(1);
    expect(banco.stock[prod]).toBe(98);
  });

  test('6. colisao no indice unico (23505): devolve a venda que ja existe, sem 500', async () => {
    const banco = fakeDb({ colisaoNoInsert: true });
    // A venda que "ganhou" a corrida, ja gravada por outra requisicao.
    banco.sales.push({ id: 'sale-ganhou', sale_number: 41, company_id: cid, total_amount: '77.80', discount_amount: '0',
      coupon_code: null, status: 'completed', tracker_token: null, idempotency_key: KEY, idempotency_response: null });
    banco.saleItems.push({ sale_id: 'sale-ganhou', product_id: prod, variant_id: null, quantity: '2.000', unit_price: '38.90', product_name_snapshot: 'Cimento' });
    // A trava nao enxergou (simula a corrida que so o indice pega).
    const connectOriginal = db.connect.getMockImplementation();
    db.connect.mockImplementation(async () => {
      const c = await connectOriginal();
      const q = c.query.getMockImplementation();
      c.query.mockImplementation(async (sql, params) => {
        if (/SELECT id FROM sales WHERE company_id = \$1 AND idempotency_key/.test(String(sql))) return { rows: [] };
        return q(sql, params);
      });
      return c;
    });

    const res = await post(BODY, KEY);
    expect(res.status).toBe(201);
    expect(res.body.idempotent_replay).toBe(true);
    expect(res.body.sale.id).toBe('sale-ganhou');
    expect(res.body.sale.items).toHaveLength(1);
    expect(res.body.receipt_url).toBe(`/companies/${cid}/print/receipt/sale-ganhou`);
    expect(banco.stock[prod]).toBe(100); // a perdedora fez ROLLBACK
    expect(banco.sales).toHaveLength(1);
  });

  test('7. mesma chave com outros itens: 409 IDEMPOTENCY_KEY_REUSED, nada gravado', async () => {
    const banco = fakeDb();
    const a = await post(BODY, KEY);
    expect(a.status).toBe(201);
    const outro = { ...BODY, items: [{ ...BODY.items[0], quantity: 3 }] };
    const b = await post(outro, KEY);
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(b.body.sale_id).toBe(a.body.sale.id);
    expect(b.body.error).toMatch(/já foi registrada \(venda 1\)/);
    expect(banco.sales).toHaveLength(1);
    expect(banco.stock[prod]).toBe(98);
  });

  test('8. migration 390 ausente: segue sem idempotencia (2 vendas, SQL de sempre)', async () => {
    const banco = fakeDb({ colunas: 0 });
    const a = await post(BODY, KEY);
    const b = await post(BODY, KEY);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(banco.sales).toHaveLength(2);
    expect(banco.sales.every((v) => v.idempotency_key === null)).toBe(true);
  });

  test('8b. chave fora do formato e ignorada: a venda passa como antes', async () => {
    const banco = fakeDb();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(BODY, 'curta');
    expect(res.status).toBe(201);
    expect(banco.sales[0].idempotency_key).toBeNull();
    warn.mockRestore();
  });

  test('9. venda com sinal usa a mesma chave', async () => {
    const banco = fakeDb();
    const sinal = {
      items: [{ product_id: prod, quantity: 2, unit_price: 50, product_name_snapshot: 'Cimento' }],
      sinal: { method: 'pix', amount: 30 },
      saldo_due_date: '2026-11-10',
      customer: { name: 'Ana', phone: '11999990000' },
    };
    const url = `/api/v1/companies/${cid}/pdv/sale-com-sinal`;
    const a = await request(app).post(url).set(adminAuth).set('Idempotency-Key', KEY).send(sinal);
    const b = await request(app).post(url).set(adminAuth).set('Idempotency-Key', KEY).send(sinal);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.sale.id).toBe(a.body.sale.id);
    expect(b.body.signal).toEqual(a.body.signal);
    expect(banco.sales).toHaveLength(1);
    expect(banco.creditDebits).toBe(1); // o saldo entra no crediario uma vez so
  });
});

describe('mesmosItens', () => {
  test('ordem nao importa; quantidade, produto e variante sim', () => {
    const p = [{ product_id: 'a', quantity: 1 }, { product_id: 'b', variant_id: 'v', quantity: 2.5 }];
    expect(vendaIdempotente.mesmosItens(p, [
      { product_id: 'b', variant_id: 'v', quantity: '2.500' }, { product_id: 'a', variant_id: null, quantity: '1.000' },
    ])).toBe(true);
    expect(vendaIdempotente.mesmosItens(p, [{ product_id: 'a', quantity: '1' }])).toBe(false);
    expect(vendaIdempotente.mesmosItens(p, [
      { product_id: 'b', variant_id: 'outra', quantity: '2.5' }, { product_id: 'a', quantity: '1' },
    ])).toBe(false);
  });
  test('item avulso (sem produto) compara pelo nome', () => {
    expect(vendaIdempotente.mesmosItens(
      [{ product_id: null, product_name_snapshot: 'Frete', quantity: 1 }],
      [{ product_id: null, product_name_snapshot: 'Frete', quantity: '1.000' }],
    )).toBe(true);
  });
});
