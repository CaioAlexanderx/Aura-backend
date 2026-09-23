// ============================================================
// AURA. — Matcon M3: Profissionais Parceiros
//   rotas  src/routes/matconProfessionals.js
//   pontos src/services/matconProfessionals.js (credit / reverse)
//   lista  src/routes/customers.js (campo `professional`)
//
// Banco mockado no padrao do repo (__tests__/fornecedores.crud.test.js):
// db.query.mockImplementation inspecionando o SQL por regex. Transacoes
// (resgate, credito, estorno) usam um client fake que registra cada SQL.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const router = require('../src/routes/matconProfessionals');
const customersRouter = require('../src/routes/customers');
const svc = require('../src/services/matconProfessionals');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/matcon/professionals', router);
  app.use('/companies/:id/customers', customersRouter);
  return app;
}

const CID  = 'c1111111-1111-4111-8111-111111111111';
const PID  = 'a2222222-2222-4222-8222-222222222222';
const CUST = 'b3333333-3333-4333-8333-333333333333';
const SALE = 'd4444444-4444-4444-8444-444444444444';

const MATCON_ON  = { matcon_enabled: true, matcon_club_enabled: true, matcon_points_per_100: 10, matcon_points_to_coupon: 100, matcon_coupon_value: 10 };
const MATCON_OFF = { matcon_enabled: false };

function proRow(extra = {}) {
  return {
    id: PID, customer_id: CUST, customer_name: 'João Pedreiro', customer_phone: '(11) 98765-4321',
    trade: 'pedreiro', points_balance: 240, points_earned_total: 340, referrals_count: 5,
    referred_sales_total: '3400.00', last_referral_at: '2026-09-20T12:00:00Z', active: true,
    created_at: '2026-08-01T12:00:00Z', ...extra,
  };
}

// Responde as leituras de configuracao que as rotas fazem.
function settingsResponder(settings) {
  return (sql) => {
    if (/SELECT pdv_settings->>'matcon_enabled' AS enabled FROM companies/.test(sql)) {
      return { rows: [{ enabled: settings.matcon_enabled === true ? 'true' : (settings.matcon_enabled === false ? 'false' : null) }] };
    }
    if (/SELECT pdv_settings FROM companies WHERE id = \$1/.test(sql)) {
      return { rows: [{ pdv_settings: settings }] };
    }
    return null;
  };
}

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      const r = await handler(sql, params);
      return r || { rows: [] };
    }),
    release: jest.fn(),
  };
}

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
});

// ─── Lista + resumo ──────────────────────────────────────────
describe('GET /matcon/professionals', () => {
  function mockList(capture) {
    const s = settingsResponder(MATCON_ON);
    db.query.mockImplementation((sql, params) => {
      const hit = s(sql);
      if (hit) return Promise.resolve(hit);
      if (/LEFT JOIN LATERAL/.test(sql)) {
        capture.list = { sql, params };
        return Promise.resolve({ rows: [proRow({ referred_total_month: '1200.00' })] });
      }
      if (/AS pending_redeems/.test(sql)) {
        capture.summary = { sql, params };
        return Promise.resolve({ rows: [{ referred_total_month: '4500.50', active_count: '7', pending_redeems: '2' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  test('devolve a lista no formato do front e o resumo do mes', async () => {
    const cap = {};
    mockList(cap);
    const res = await request(makeApp()).get(`/companies/${CID}/matcon/professionals`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ referred_total_month: 4500.5, active_count: 7, pending_redeems: 2 });
    const p = res.body.professionals[0];
    expect(p).toMatchObject({
      id: PID, customer_id: CUST, customer_name: 'João Pedreiro', trade: 'pedreiro',
      points_balance: 240, referrals_count: 5, referred_sales_total: 3400, active: true,
    });
    expect(typeof p.referred_sales_total).toBe('number');
    // pending_redeems = ativos com saldo >= matcon_points_to_coupon
    expect(cap.summary.params).toEqual([CID, 100]);
    expect(cap.summary.sql).toMatch(/points_balance >= \$2/);
  });

  test('pending_redeems usa o matcon_points_to_coupon da loja', async () => {
    const cap = {};
    const s = settingsResponder({ ...MATCON_ON, matcon_points_to_coupon: 250 });
    db.query.mockImplementation((sql, params) => {
      const hit = s(sql);
      if (hit) return Promise.resolve(hit);
      if (/AS pending_redeems/.test(sql)) { cap.params = params; return Promise.resolve({ rows: [{}] }); }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).get(`/companies/${CID}/matcon/professionals`);
    expect(res.status).toBe(200);
    expect(cap.params).toEqual([CID, 250]);
  });

  test.each([
    ['active', /p\.active = true/, null],
    ['inactive_60d', /COALESCE\(p\.last_referral_at, p\.created_at\) < NOW\(\) - INTERVAL '60 days'/, null],
    ['new', /p\.created_at >= NOW\(\) - INTERVAL '30 days'/, /p\.active = true/],
  ])('filter=%s filtra no banco', async (filter, deve, naoDeve) => {
    const cap = {};
    mockList(cap);
    const res = await request(makeApp()).get(`/companies/${CID}/matcon/professionals?filter=${filter}`);
    expect(res.status).toBe(200);
    expect(cap.list.sql).toMatch(deve);
    if (naoDeve) expect(cap.list.sql).not.toMatch(naoDeve);
  });

  test('filtro desconhecido vira "todos" (sem condicao extra)', async () => {
    const cap = {};
    mockList(cap);
    await request(makeApp()).get(`/companies/${CID}/matcon/professionals?filter=hack'--`);
    expect(cap.list.sql).not.toMatch(/INTERVAL/);
    expect(cap.list.sql).not.toMatch(/hack/);
  });

  test('q busca por nome e por digitos do telefone, parametrizado', async () => {
    const cap = {};
    mockList(cap);
    await request(makeApp()).get(`/companies/${CID}/matcon/professionals?q=${encodeURIComponent('98765')}`);
    expect(cap.list.sql).toMatch(/cu\.name ILIKE \$2/);
    expect(cap.list.sql).toMatch(/regexp_replace\(COALESCE\(cu\.phone, ''\)/);
    expect(cap.list.params).toEqual([CID, '%98765%', '%98765%']);
  });

  test('tabela ainda nao criada (42P01) devolve lista vazia, nao 500', async () => {
    const s = settingsResponder(MATCON_ON);
    db.query.mockImplementation((sql) => {
      const hit = s(sql);
      if (hit) return Promise.resolve(hit);
      const e = new Error('relation "matcon_professionals" does not exist'); e.code = '42P01';
      return Promise.reject(e);
    });
    const res = await request(makeApp()).get(`/companies/${CID}/matcon/professionals`);
    expect(res.status).toBe(200);
    expect(res.body.professionals).toEqual([]);
  });

  test('leitura funciona com o Matcon desligado (gate so na escrita)', async () => {
    const s = settingsResponder(MATCON_OFF);
    db.query.mockImplementation((sql) => Promise.resolve(s(sql) || { rows: [] }));
    const res = await request(makeApp()).get(`/companies/${CID}/matcon/professionals`);
    expect(res.status).toBe(200);
  });
});

// ─── Busca do Caixa ──────────────────────────────────────────
describe('GET /matcon/professionals/search', () => {
  test('busca so parceiros ativos da loja, por nome', async () => {
    let cap;
    db.query.mockImplementation((sql, params) => {
      if (/FROM matcon_professionals p/.test(sql)) { cap = { sql, params }; return Promise.resolve({ rows: [proRow()] }); }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).get(`/companies/${CID}/matcon/professionals/search?q=joao`);
    expect(res.status).toBe(200);
    expect(res.body.professionals).toHaveLength(1);
    expect(res.body.professionals[0].customer_name).toBe('João Pedreiro');
    expect(cap.sql).toMatch(/p\.company_id = \$1 AND p\.active = true/);
    expect(cap.sql).toMatch(/LIMIT 10/);
    // "joao" nao tem digitos: nao compara telefone
    expect(cap.params).toEqual([CID, '%joao%']);
  });

  test('termo vazio nao toca o banco', async () => {
    const res = await request(makeApp()).get(`/companies/${CID}/matcon/professionals/search?q=%20`);
    expect(res.status).toBe(200);
    expect(res.body.professionals).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ─── Criar ───────────────────────────────────────────────────
describe('POST /matcon/professionals', () => {
  function mockCreate({ insertRows, existing }) {
    const s = settingsResponder(MATCON_ON);
    const calls = [];
    db.query.mockImplementation((sql, params) => {
      calls.push(sql);
      const hit = s(sql);
      if (hit) return Promise.resolve(hit);
      if (/SELECT id FROM companies/.test(sql)) return Promise.resolve({ rows: [{ id: CID }] });
      if (/SELECT id FROM customers WHERE id = \$1 AND company_id = ANY/.test(sql)) return Promise.resolve({ rows: [{ id: CUST }] });
      if (/INSERT INTO matcon_professionals/.test(sql)) return Promise.resolve({ rows: insertRows });
      if (/SELECT id, active FROM matcon_professionals/.test(sql)) return Promise.resolve({ rows: existing ? [existing] : [] });
      if (/WHERE p\.id = \$1 AND p\.company_id = \$2/.test(sql)) return Promise.resolve({ rows: [proRow(existing ? { active: true } : { points_balance: 0 })] });
      return Promise.resolve({ rows: [] });
    });
    return calls;
  }

  test('marca o cliente como parceiro (201)', async () => {
    mockCreate({ insertRows: [{ id: PID }] });
    const res = await request(makeApp()).post(`/companies/${CID}/matcon/professionals`)
      .send({ customer_id: CUST, trade: 'pedreiro' });
    expect(res.status).toBe(201);
    expect(res.body.professional.id).toBe(PID);
    expect(res.body.professional.trade).toBe('pedreiro');
  });

  test('409 se o cliente ja e parceiro ativo', async () => {
    mockCreate({ insertRows: [], existing: { id: PID, active: true } });
    const res = await request(makeApp()).post(`/companies/${CID}/matcon/professionals`)
      .send({ customer_id: CUST, trade: 'pedreiro' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_PROFESSIONAL');
    expect(res.body.error).toMatch(/já é profissional parceiro/);
  });

  test('parceiro desativado marcado de novo e reativado (200)', async () => {
    const calls = mockCreate({ insertRows: [], existing: { id: PID, active: false } });
    const res = await request(makeApp()).post(`/companies/${CID}/matcon/professionals`)
      .send({ customer_id: CUST, trade: 'eletricista' });
    expect(res.status).toBe(200);
    expect(res.body.reactivated).toBe(true);
    expect(calls.some((s) => /SET active = true, trade = \$1/.test(s))).toBe(true);
  });

  test('profissao fora da lista -> 400 sem tocar o banco', async () => {
    const res = await request(makeApp()).post(`/companies/${CID}/matcon/professionals`)
      .send({ customer_id: CUST, trade: 'astronauta' });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('cliente de fora do grupo do dono -> 404', async () => {
    const s = settingsResponder(MATCON_ON);
    db.query.mockImplementation((sql) => Promise.resolve(s(sql) || { rows: [] }));
    const res = await request(makeApp()).post(`/companies/${CID}/matcon/professionals`)
      .send({ customer_id: CUST, trade: 'pintor' });
    expect(res.status).toBe(404);
  });
});

// ─── Gate na escrita ─────────────────────────────────────────
describe('gate: Matcon desligado bloqueia so a escrita', () => {
  beforeEach(() => {
    const s = settingsResponder(MATCON_OFF);
    db.query.mockImplementation((sql) => Promise.resolve(s(sql) || { rows: [] }));
  });

  test('POST -> 403 MATCON_DISABLED', async () => {
    const res = await request(makeApp()).post(`/companies/${CID}/matcon/professionals`)
      .send({ customer_id: CUST, trade: 'pedreiro' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCON_DISABLED');
  });

  test('PATCH -> 403 MATCON_DISABLED', async () => {
    const res = await request(makeApp()).patch(`/companies/${CID}/matcon/professionals/${PID}`)
      .send({ active: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCON_DISABLED');
  });

  test('redeem -> 403 MATCON_DISABLED, sem abrir transacao', async () => {
    const res = await request(makeApp()).post(`/companies/${CID}/matcon/professionals/${PID}/redeem`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCON_DISABLED');
    expect(db.connect).not.toHaveBeenCalled();
  });
});

// ─── Ficha ───────────────────────────────────────────────────
describe('GET /matcon/professionals/:pid', () => {
  test('ficha + extrato (sem linhas de 0 ponto) + ultimas indicacoes', async () => {
    let ledgerSql;
    db.query.mockImplementation((sql) => {
      if (/WHERE p\.id = \$1 AND p\.company_id = \$2/.test(sql)) return Promise.resolve({ rows: [proRow()] });
      if (/FROM matcon_professional_points_ledger/.test(sql)) {
        ledgerSql = sql;
        return Promise.resolve({ rows: [{ id: 'l1', sale_id: SALE, delta: 20, reason: 'sale', created_at: '2026-09-20T12:00:00Z' }] });
      }
      if (/FROM sales s/.test(sql)) {
        return Promise.resolve({ rows: [{ sale_id: SALE, customer_name: 'Dona Maria', total_amount: '215.40', created_at: '2026-09-20T12:00:00Z' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).get(`/companies/${CID}/matcon/professionals/${PID}`);
    expect(res.status).toBe(200);
    expect(res.body.professional.id).toBe(PID);
    expect(res.body.ledger).toEqual([{ id: 'l1', sale_id: SALE, delta: 20, reason: 'sale', created_at: '2026-09-20T12:00:00Z' }]);
    expect(ledgerSql).toMatch(/delta <> 0/);
    expect(ledgerSql).toMatch(/LIMIT 20/);
    expect(res.body.last_referrals).toEqual([{ sale_id: SALE, customer_name: 'Dona Maria', total: 215.4, created_at: '2026-09-20T12:00:00Z' }]);
  });

  test('parceiro de outra loja -> 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(makeApp()).get(`/companies/${CID}/matcon/professionals/${PID}`);
    expect(res.status).toBe(404);
  });
});

// ─── PATCH ───────────────────────────────────────────────────
describe('PATCH /matcon/professionals/:pid', () => {
  test('desativa e devolve o parceiro atualizado', async () => {
    const s = settingsResponder(MATCON_ON);
    let upd;
    db.query.mockImplementation((sql, params) => {
      const hit = s(sql);
      if (hit) return Promise.resolve(hit);
      if (/UPDATE matcon_professionals SET/.test(sql)) { upd = { sql, params }; return Promise.resolve({ rows: [{ id: PID }] }); }
      if (/WHERE p\.id = \$1 AND p\.company_id = \$2/.test(sql)) return Promise.resolve({ rows: [proRow({ active: false })] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).patch(`/companies/${CID}/matcon/professionals/${PID}`).send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.professional.active).toBe(false);
    expect(upd.sql).toMatch(/active = \$1/);
    expect(upd.params).toEqual([false, PID, CID]);
  });

  test('corpo vazio -> 400', async () => {
    const res = await request(makeApp()).patch(`/companies/${CID}/matcon/professionals/${PID}`).send({});
    expect(res.status).toBe(400);
  });
});

// ─── Resgate ─────────────────────────────────────────────────
describe('POST /matcon/professionals/:pid/redeem', () => {
  function setup(balance) {
    const s = settingsResponder(MATCON_ON);
    db.query.mockImplementation((sql) => Promise.resolve(s(sql) || { rows: [] }));
    const client = fakeClient((sql) => {
      if (/FOR UPDATE OF p/.test(sql)) return { rows: [{ id: PID, customer_id: CUST, points_balance: balance, customer_name: 'João Pedreiro' }] };
      if (/INSERT INTO coupons/.test(sql)) return { rows: [{ id: 'coupon-1', code: 'PARC-JOAO-ABCD', discount_value: '10.00' }] };
      if (/UPDATE matcon_professionals/.test(sql)) return { rows: [{ points_balance: balance - 100 }] };
      return null;
    });
    db.connect.mockResolvedValue(client);
    return client;
  }

  test('com saldo: debita os pontos e cria cupom fixo, uso unico, nominal', async () => {
    const client = setup(240);
    const res = await request(makeApp()).post(`/companies/${CID}/matcon/professionals/${PID}/redeem`);
    expect(res.status).toBe(200);
    expect(res.body.coupon_code).toBe('PARC-JOAO-ABCD');
    expect(res.body.points_balance).toBe(140);

    const sqls = client.calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');

    const coupon = client.calls.find((c) => /INSERT INTO coupons/.test(c.sql));
    expect(coupon.sql).toMatch(/'fixed'/);
    expect(coupon.sql).toMatch(/'matcon_professional'/);
    expect(coupon.sql).toMatch(/0, 1, NULL/); // min 0, max_uses 1, sem validade
    expect(coupon.params[0]).toBe(CID);
    expect(coupon.params[1]).toMatch(/^PARC-JOAO-[A-Z2-9]{4}$/);
    expect(coupon.params[3]).toBe(10);      // matcon_coupon_value
    expect(coupon.params[4]).toBe(CUST);    // nominal ao cliente do parceiro

    const ledger = client.calls.find((c) => /INSERT INTO matcon_professional_points_ledger/.test(c.sql));
    expect(ledger.sql).toMatch(/'redeem'/);
    expect(ledger.params).toEqual([CID, PID, 'coupon-1', -100, 'Cupom PARC-JOAO-ABCD de R$ 10,00']);

    const upd = client.calls.find((c) => /UPDATE matcon_professionals/.test(c.sql));
    expect(upd.params).toEqual([100, PID, CID]);
    expect(client.release).toHaveBeenCalled();
  });

  test('sem saldo: 400 com mensagem clara, sem cupom', async () => {
    const client = setup(60);
    const res = await request(makeApp()).post(`/companies/${CID}/matcon/professionals/${PID}/redeem`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_POINTS');
    expect(res.body.error).toBe('Ainda não dá: João Pedreiro tem 60 pontos e o cupom precisa de 100. Faltam 40.');
    expect(client.calls.some((c) => /INSERT INTO coupons/.test(c.sql))).toBe(false);
    expect(client.calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  test('codigo de cupom repetido tenta de novo com outro sufixo', async () => {
    const s = settingsResponder(MATCON_ON);
    db.query.mockImplementation((sql) => Promise.resolve(s(sql) || { rows: [] }));
    let tentativas = 0;
    const client = fakeClient((sql) => {
      if (/FOR UPDATE OF p/.test(sql)) return { rows: [{ id: PID, customer_id: CUST, points_balance: 100, customer_name: 'João' }] };
      if (/INSERT INTO coupons/.test(sql)) {
        tentativas++;
        if (tentativas === 1) { const e = new Error('dup'); e.code = '23505'; throw e; }
        return { rows: [{ id: 'coupon-2', code: 'PARC-JOAO-WXYZ', discount_value: 10 }] };
      }
      if (/UPDATE matcon_professionals/.test(sql)) return { rows: [{ points_balance: 0 }] };
      return null;
    });
    db.connect.mockResolvedValue(client);
    const res = await request(makeApp()).post(`/companies/${CID}/matcon/professionals/${PID}/redeem`);
    expect(res.status).toBe(200);
    expect(tentativas).toBe(2);
    expect(client.calls.map((c) => c.sql)).toContain('ROLLBACK TO SAVEPOINT matcon_coupon');
  });
});

// ─── Servico: credito e estorno da venda indicada ────────────
describe('creditReferredSale', () => {
  test('pontos = floor(total/100) × pontos por 100; soma tudo no parceiro', async () => {
    const client = fakeClient((sql) => {
      if (/SELECT pdv_settings FROM companies/.test(sql)) return { rows: [{ pdv_settings: { ...MATCON_ON, matcon_points_per_100: 10 } }] };
      if (/FROM matcon_professionals\s+WHERE id = \$1 AND company_id = \$2\s+FOR UPDATE/.test(sql)) return { rows: [{ id: PID, active: true }] };
      if (/UPDATE sales SET referred_by_professional_id/.test(sql)) return { rows: [{ created_at: '2026-09-23T10:00:00Z' }] };
      if (/INSERT INTO matcon_professional_points_ledger/.test(sql)) return { rows: [{ id: 'l1' }] };
      if (/UPDATE matcon_professionals/.test(sql)) return { rows: [{ points_balance: 270 }] };
      return null;
    });
    const out = await svc.creditReferredSale(client, { companyId: CID, saleId: SALE, professionalId: PID, total: 345.9 });
    expect(out).toEqual({ credited: true, points: 30, points_balance: 270, professional_id: PID });

    const sqls = client.calls.map((c) => c.sql);
    expect(sqls[0]).toBe('SAVEPOINT matcon_credit_sale');
    expect(sqls[sqls.length - 1]).toBe('RELEASE SAVEPOINT matcon_credit_sale');

    const led = client.calls.find((c) => /INSERT INTO matcon_professional_points_ledger/.test(c.sql));
    expect(led.sql).toMatch(/'sale'/);
    expect(led.sql).toMatch(/ON CONFLICT \(sale_id, reason\)/);
    expect(led.params).toEqual([CID, PID, SALE, 30, 345.9]);

    const upd = client.calls.find((c) => /UPDATE matcon_professionals/.test(c.sql));
    expect(upd.sql).toMatch(/referrals_count\s+= referrals_count \+ 1/);
    expect(upd.params).toEqual([30, 345.9, '2026-09-23T10:00:00Z', PID, CID]);
  });

  test('pointsForTotal: abaixo de R$ 100 nao da ponto', () => {
    expect(svc.pointsForTotal(99.99, 10)).toBe(0);
    expect(svc.pointsForTotal(100, 10)).toBe(10);
    expect(svc.pointsForTotal(1299, 15)).toBe(180);
    expect(svc.pointsForTotal(-50, 10)).toBe(0);
  });

  test('parceiro inativo: nao credita e nao derruba a venda', async () => {
    const client = fakeClient((sql) => {
      if (/SELECT pdv_settings FROM companies/.test(sql)) return { rows: [{ pdv_settings: MATCON_ON }] };
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: PID, active: false }] };
      return null;
    });
    const out = await svc.creditReferredSale(client, { companyId: CID, saleId: SALE, professionalId: PID, total: 500 });
    expect(out).toEqual({ credited: false, reason: 'PROFESSIONAL_INACTIVE' });
    expect(client.calls.some((c) => /INSERT INTO matcon_professional_points_ledger/.test(c.sql))).toBe(false);
  });

  test('parceiro de outra empresa: PROFESSIONAL_NOT_FOUND', async () => {
    const client = fakeClient((sql) => {
      if (/SELECT pdv_settings FROM companies/.test(sql)) return { rows: [{ pdv_settings: MATCON_ON }] };
      return null;
    });
    const out = await svc.creditReferredSale(client, { companyId: CID, saleId: SALE, professionalId: PID, total: 500 });
    expect(out.reason).toBe('PROFESSIONAL_NOT_FOUND');
  });

  test('clube desligado: nao credita', async () => {
    const client = fakeClient((sql) => {
      if (/SELECT pdv_settings FROM companies/.test(sql)) return { rows: [{ pdv_settings: { ...MATCON_ON, matcon_club_enabled: false } }] };
      return null;
    });
    const out = await svc.creditReferredSale(client, { companyId: CID, saleId: SALE, professionalId: PID, total: 500 });
    expect(out).toEqual({ credited: false, reason: 'CLUB_DISABLED' });
  });

  test('segunda chamada para a mesma venda nao credita de novo', async () => {
    const client = fakeClient((sql) => {
      if (/SELECT pdv_settings FROM companies/.test(sql)) return { rows: [{ pdv_settings: MATCON_ON }] };
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: PID, active: true }] };
      if (/UPDATE sales SET/.test(sql)) return { rows: [{ created_at: '2026-09-23T10:00:00Z' }] };
      if (/INSERT INTO matcon_professional_points_ledger/.test(sql)) return { rows: [] }; // ON CONFLICT DO NOTHING
      return null;
    });
    const out = await svc.creditReferredSale(client, { companyId: CID, saleId: SALE, professionalId: PID, total: 500 });
    expect(out).toEqual({ credited: false, reason: 'ALREADY_CREDITED' });
    expect(client.calls.some((c) => /UPDATE matcon_professionals/.test(c.sql))).toBe(false);
  });

  test('migration 353 ausente: volta ao savepoint e nao envenena a venda', async () => {
    const client = fakeClient((sql) => {
      if (/SELECT pdv_settings FROM companies/.test(sql)) return { rows: [{ pdv_settings: MATCON_ON }] };
      if (/FOR UPDATE/.test(sql)) { const e = new Error('no table'); e.code = '42P01'; throw e; }
      return null;
    });
    const out = await svc.creditReferredSale(client, { companyId: CID, saleId: SALE, professionalId: PID, total: 500 });
    expect(out).toEqual({ credited: false, reason: 'SCHEMA_MISSING' });
    expect(client.calls.map((c) => c.sql)).toContain('ROLLBACK TO SAVEPOINT matcon_credit_sale');
  });

  test('outro erro: volta ao savepoint e sobe', async () => {
    const client = fakeClient((sql) => {
      if (/SELECT pdv_settings FROM companies/.test(sql)) throw new Error('conexao caiu');
      return null;
    });
    await expect(svc.creditReferredSale(client, { companyId: CID, saleId: SALE, professionalId: PID, total: 500 }))
      .rejects.toThrow('conexao caiu');
    expect(client.calls.map((c) => c.sql)).toContain('ROLLBACK TO SAVEPOINT matcon_credit_sale');
  });
});

describe('reverseReferredSale', () => {
  test('estorna exatamente o que o credito somou', async () => {
    const client = fakeClient((sql) => {
      if (/reason = 'sale'/.test(sql) && /SELECT professional_id/.test(sql)) return { rows: [{ professional_id: PID, delta: 30, sale_total: '345.90' }] };
      if (/INSERT INTO matcon_professional_points_ledger/.test(sql)) return { rows: [{ id: 'l2' }] };
      if (/UPDATE matcon_professionals p/.test(sql)) return { rows: [{ points_balance: -10 }] };
      return null;
    });
    const out = await svc.reverseReferredSale(client, { companyId: CID, saleId: SALE });
    // saldo negativo e permitido: os pontos ja tinham virado cupom
    expect(out).toEqual({ reversed: true, points: 30, points_balance: -10, professional_id: PID });

    const led = client.calls.find((c) => /INSERT INTO matcon_professional_points_ledger/.test(c.sql));
    expect(led.sql).toMatch(/'adjust'/);
    expect(led.params).toEqual([CID, PID, SALE, -30, 345.9]);

    const upd = client.calls.find((c) => /UPDATE matcon_professionals p/.test(c.sql));
    expect(upd.sql).toMatch(/referrals_count\s+= GREATEST\(0, p\.referrals_count - 1\)/);
    expect(upd.sql).toMatch(/last_referral_at\s+= \(\s*SELECT MAX\(s\.created_at\) FROM sales s/);
    expect(upd.params).toEqual([30, 345.9, SALE, PID, CID]);
  });

  test('venda sem indicacao: nada a fazer', async () => {
    const client = fakeClient(() => null);
    const out = await svc.reverseReferredSale(client, { companyId: CID, saleId: SALE });
    expect(out).toEqual({ reversed: false, reason: 'NOT_CREDITED' });
    expect(client.calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });

  test('estorno repetido nao debita duas vezes', async () => {
    const client = fakeClient((sql) => {
      if (/SELECT professional_id/.test(sql)) return { rows: [{ professional_id: PID, delta: 30, sale_total: 345.9 }] };
      if (/INSERT INTO matcon_professional_points_ledger/.test(sql)) return { rows: [] };
      return null;
    });
    const out = await svc.reverseReferredSale(client, { companyId: CID, saleId: SALE });
    expect(out).toEqual({ reversed: false, reason: 'ALREADY_REVERSED' });
    expect(client.calls.some((c) => /UPDATE matcon_professionals p/.test(c.sql))).toBe(false);
  });
});

// ─── Lista de clientes: campo `professional` ─────────────────
describe('GET /customers — professional por cliente', () => {
  const OTHER = 'e5555555-5555-4555-8555-555555555555';

  function mockCustomers(matconRows) {
    db.query.mockImplementation((sql) => {
      if (/SELECT id FROM companies/.test(sql)) return Promise.resolve({ rows: [{ id: CID }] });
      if (/SELECT COUNT\(\*\) AS total FROM customers/.test(sql)) return Promise.resolve({ rows: [{ total: '2' }] });
      if (/FROM customers c/.test(sql)) {
        return Promise.resolve({ rows: [
          { id: CUST, name: 'João Pedreiro', company_id: CID, total_purchases: 3, total_spent: 900 },
          { id: OTHER, name: 'Dona Maria', company_id: CID, total_purchases: 1, total_spent: 100 },
        ] });
      }
      if (/LEFT JOIN matcon_professionals mp/.test(sql)) {
        if (matconRows instanceof Error) return Promise.reject(matconRows);
        return Promise.resolve({ rows: matconRows });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  test('clube ligado: parceiro ganha {id, trade, points_balance, referrals_count}, os outros null', async () => {
    mockCustomers([{ club_on: true, customer_id: CUST, id: PID, trade: 'pedreiro', points_balance: 1240, referrals_count: 12 }]);
    const res = await request(makeApp()).get(`/companies/${CID}/customers`);
    expect(res.status).toBe(200);
    const [joao, maria] = res.body.customers;
    expect(joao.professional).toEqual({ id: PID, trade: 'pedreiro', points_balance: 1240, referrals_count: 12 });
    expect(maria.professional).toBeNull();
  });

  test('loja sem o modulo: a resposta nao ganha a chave', async () => {
    mockCustomers([{ club_on: false, customer_id: null, id: null }]);
    const res = await request(makeApp()).get(`/companies/${CID}/customers`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(2);
    for (const c of res.body.customers) expect(c).not.toHaveProperty('professional');
  });

  test('tabela ausente (42P01): lista normal, sem a chave', async () => {
    const e = new Error('no table'); e.code = '42P01';
    mockCustomers(e);
    const res = await request(makeApp()).get(`/companies/${CID}/customers`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(2);
    expect(res.body.customers[0]).not.toHaveProperty('professional');
  });
});

// ─── Migration ───────────────────────────────────────────────
describe('migration 353', () => {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '353_matcon_m3_professionals.sql'), 'utf8');

  test('idempotente', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS matcon_professionals/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS matcon_professional_points_ledger/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS referred_by_professional_id/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS coupons_source_check/);
  });

  test('1:1 por loja e um credito/estorno por venda', () => {
    expect(sql).toMatch(/UNIQUE \(company_id, customer_id\)/);
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS uq_matcon_points_ledger_sale_reason[\s\S]*\(sale_id, reason\)[\s\S]*WHERE sale_id IS NOT NULL/);
  });

  test('coupons.source mantem as origens de hoje e ganha a do resgate', () => {
    expect(sql).toMatch(/'manual', 'birthday', 'campaign', 'reactivation', 'credit_lead', 'matcon_professional'/);
  });
});
