// ============================================================
// Venda cancelada sai da lista (10/11/2026, migration 439)
//
// Pedido do Caio: "Linha de venda cancelada pode ser excluída, para não
// poluir a UI." A exclusão é LÓGICA: grava hidden_at/hidden_by e a venda
// some só da LISTA. Nada de DELETE, nada de mexer em venda que vale.
//
//   1. venda cancelada: grava hidden_at + hidden_by, guarda no WHERE
//   2. venda que vale: 409 SALE_NOT_CANCELLED, nenhuma linha muda
//   3. venda de outra empresa: 404 (escopo da rota no WHERE)
//   4. já excluída: 200 idempotente
//   5. coluna ainda não existe: 503, sem UPDATE
//   6. membro sem acesso à empresa: 403 antes de qualquer UPDATE
//   7. lista e contagem filtram hidden_at IS NULL; stats não
//   8. os totais não mudam: o SQL dos stats é o mesmo com e sem a coluna
//   9. /me/sales (consolidado): mesma regra
//  10. migration só aditiva
// ============================================================
jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const saleHidden = require('../src/utils/saleHidden');
const saleNumber = require('../src/utils/saleNumber');
const { requireCompanyAccess } = require('../src/middleware/auth');

const CID = 'comp-1';
const OUTRA = 'comp-2';
const SALE = 'sale-cancelada';
const VALE = 'sale-que-vale';

// Banco de mentira: duas vendas na comp-1 (uma cancelada, outra valendo).
let vendas;
let colunaExiste;
let membros;
const sqls = () => db.query.mock.calls.map(([s]) => String(s));

function instalarBanco() {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/column_name = 'hidden_at'/.test(s)) return Promise.resolve({ rows: [{ n: colunaExiste ? '1' : '0' }] });
    if (/column_name = 'sale_number'/.test(s)) return Promise.resolve({ rows: [{ n: '1' }] });
    if (/to_regclass\('public\.matcon_deliveries'\)/.test(s)) return Promise.resolve({ rows: [{ ok: false }] });
    if (/FROM companies WHERE id = \$1 AND owner_id = \$2/.test(s)) {
      const [companyId, userId] = params;
      return Promise.resolve({ rows: membros[userId] && membros[userId].includes(companyId) ? [{ role: 'owner' }] : [] });
    }
    if (/^UPDATE sales SET hidden_at = NOW\(\), hidden_by = \$1/.test(s)) {
      const [userId, saleId, companyId] = params;
      const v = vendas.find((x) => x.id === saleId && x.company_id === companyId && x.status === 'cancelled' && !x.hidden_at);
      if (!v) return Promise.resolve({ rows: [], rowCount: 0 });
      v.hidden_at = '2026-11-10T12:00:00.000Z';
      v.hidden_by = userId;
      return Promise.resolve({ rows: [{ id: v.id, hidden_at: v.hidden_at }], rowCount: 1 });
    }
    if (/^SELECT id, status, hidden_at FROM sales WHERE id = \$1 AND company_id = \$2/.test(s)) {
      const [saleId, companyId] = params;
      const v = vendas.find((x) => x.id === saleId && x.company_id === companyId);
      return Promise.resolve({ rows: v ? [{ id: v.id, status: v.status, hidden_at: v.hidden_at || null }] : [] });
    }
    // Lista / contagem / stats: avalia a condicao de visibilidade sobre o
    // banco de mentira para provar o efeito, nao so o texto.
    const visiveis = vendas.filter((x) => !/hidden_at IS NULL/.test(s) || !x.hidden_at);
    if (/SELECT COUNT\(\*\)::int AS total FROM sales s|SELECT COUNT\(\*\)::int AS total\s+FROM sales s/.test(s)) {
      return Promise.resolve({ rows: [{ total: visiveis.length }] });
    }
    if (/AS active_sales/.test(s)) {
      const ativas = visiveis.filter((x) => x.status !== 'cancelled');
      const rows = [{
        total_sales: visiveis.length,
        active_sales: ativas.length,
        cancelled_sales: visiveis.length - ativas.length,
        revenue: String(ativas.reduce((a, x) => a + x.total_amount, 0)),
        avg_ticket: '0',
      }];
      if (/GROUP BY s\.company_id/.test(s)) rows[0].company_id = CID;
      return Promise.resolve({ rows });
    }
    if (/ORDER BY s\.created_at DESC/.test(s)) {
      return Promise.resolve({ rows: visiveis.map((x) => ({ ...x, type: 'sale', items_count: 1, returned_value: 0 })) });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

function appDaEmpresa() {
  const router = require('../src/routes/sales');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || 'u1' }; next(); });
  // Igual ao private.js: requireCompanyAccess antes do router de vendas.
  app.use('/companies/:id', requireCompanyAccess());
  app.use('/companies/:id/sales', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  saleHidden._resetCache();
  saleNumber._resetCache();
  colunaExiste = true;
  membros = { u1: [CID], intruso: [OUTRA] };
  vendas = [
    { id: SALE, company_id: CID, status: 'cancelled', total_amount: 80, hidden_at: null, created_at: '2026-11-10T10:00:00Z' },
    { id: VALE, company_id: CID, status: 'completed', total_amount: 120, hidden_at: null, created_at: '2026-11-10T11:00:00Z' },
  ];
  instalarBanco();
});

const app = appDaEmpresa();

describe('POST /companies/:id/sales/:sale_id/hide', () => {
  test('1. venda cancelada: grava hidden_at e hidden_by, nada mais', async () => {
    const res = await request(app).post(`/companies/${CID}/sales/${SALE}/hide`).send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.hidden_at).toBeTruthy();
    expect(vendas[0].hidden_by).toBe('u1');
    expect(vendas[0].status).toBe('cancelled');

    const upd = sqls().find((s) => /^UPDATE sales SET hidden_at/.test(s));
    // A guarda fica no WHERE: só cancelada, só desta empresa, só se ainda aparece.
    expect(upd).toMatch(/status = 'cancelled'/);
    expect(upd).toMatch(/company_id = \$3/);
    expect(upd).toMatch(/hidden_at IS NULL/);
    // Exclusão lógica: nenhum DELETE, nenhum status, estoque ou lançamento.
    expect(sqls().some((s) => /\bDELETE\b/i.test(s))).toBe(false);
    expect(sqls().some((s) => /SET status|stock_qty|transactions/i.test(s))).toBe(false);
  });

  test('2. venda que vale: 409 com mensagem gentil, nenhuma linha muda', async () => {
    const res = await request(app).post(`/companies/${CID}/sales/${VALE}/hide`).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SALE_NOT_CANCELLED');
    expect(res.body.error).toMatch(/cancelada/);
    expect(vendas[1].hidden_at).toBeNull();
    expect(vendas[1].status).toBe('completed');
  });

  test('3. venda de outra empresa: 404, sem tocar na venda', async () => {
    membros.u1 = [CID, OUTRA];
    const res = await request(app).post(`/companies/${OUTRA}/sales/${SALE}/hide`).send({});

    expect(res.status).toBe(404);
    expect(vendas[0].hidden_at).toBeNull();
  });

  test('4. já excluída: 200 idempotente, sem regravar quem excluiu', async () => {
    await request(app).post(`/companies/${CID}/sales/${SALE}/hide`).send({});
    membros.u2 = [CID];
    const res = await request(app).post(`/companies/${CID}/sales/${SALE}/hide`).set('x-user', 'u2').send({});

    expect(res.status).toBe(200);
    expect(res.body.already_hidden).toBe(true);
    expect(vendas[0].hidden_by).toBe('u1');
  });

  test('5. backend antes da migration: 503, sem UPDATE', async () => {
    colunaExiste = false;
    const res = await request(app).post(`/companies/${CID}/sales/${SALE}/hide`).send({});

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SALE_HIDE_UNAVAILABLE');
    expect(sqls().some((s) => /^UPDATE sales/.test(s))).toBe(false);
  });

  test('6. quem não tem acesso à empresa: 403 antes de qualquer UPDATE', async () => {
    const res = await request(app).post(`/companies/${CID}/sales/${SALE}/hide`).set('x-user', 'intruso').send({});

    expect(res.status).toBe(403);
    expect(sqls().some((s) => /^UPDATE sales/.test(s))).toBe(false);
    expect(vendas[0].hidden_at).toBeNull();
  });
});

describe('GET /companies/:id/sales — a lista deixa de trazer a venda excluída', () => {
  test('7. some da lista e da paginação; continua guardada', async () => {
    const antes = await request(app).get(`/companies/${CID}/sales`);
    expect(antes.body.sales.map((x) => x.id)).toEqual([SALE, VALE]);
    expect(antes.body.total).toBe(2);

    await request(app).post(`/companies/${CID}/sales/${SALE}/hide`).send({});
    db.query.mockClear();
    const depois = await request(app).get(`/companies/${CID}/sales`);

    expect(depois.body.sales.map((x) => x.id)).toEqual([VALE]);
    expect(depois.body.total).toBe(1);
    // O registro continua no banco.
    expect(vendas.find((x) => x.id === SALE)).toBeTruthy();

    const lista = sqls().find((s) => /ORDER BY s\.created_at DESC/.test(s));
    const contagem = sqls().find((s) => /SELECT COUNT\(\*\)::int AS total FROM sales s/.test(s));
    const stats = sqls().find((s) => /AS active_sales/.test(s));
    expect(lista).toMatch(/s\.hidden_at IS NULL/);
    expect(contagem).toMatch(/s\.hidden_at IS NULL/);
    expect(stats).not.toMatch(/hidden_at/);
  });

  test('8. os totais não mudam ao excluir', async () => {
    const antes = await request(app).get(`/companies/${CID}/sales`);
    await request(app).post(`/companies/${CID}/sales/${SALE}/hide`).send({});
    const depois = await request(app).get(`/companies/${CID}/sales`);

    expect(depois.body.stats).toEqual(antes.body.stats);
    expect(depois.body.stats.revenue).toBe(120);
    expect(depois.body.stats.total_sales).toBe(2);
    expect(depois.body.stats.cancelled_sales).toBe(1);
  });

  test('8b. sem a coluna (antes da migration) a lista segue como sempre', async () => {
    colunaExiste = false;
    const res = await request(app).get(`/companies/${CID}/sales`);

    expect(res.status).toBe(200);
    expect(res.body.sales).toHaveLength(2);
    expect(sqls().some((s) => /hidden_at IS NULL/.test(s))).toBe(false);
  });
});

describe('GET /me/sales — consolidado multi-CNPJ', () => {
  const jwt = require('jsonwebtoken');
  const meApp = express();
  meApp.use(express.json());
  meApp.use('/me', require('../src/routes/meAggregates'));
  const token = jwt.sign({ id: 'u1', plan: 'negocio' }, process.env.JWT_SECRET);

  test('9. lista consolidada filtra hidden_at; stats e breakdown não', async () => {
    const original = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => {
      const s = String(sql || '');
      // getUserCompanies: as empresas do user (owner ou membro).
      if (/SELECT DISTINCT ON \(c\.id\)/.test(s)) {
        return Promise.resolve({ rows: [{ id: CID, trade_name: 'Loja', is_primary: true, created_at: '2026-01-01' }] });
      }
      return original(sql, params);
    });
    vendas[0].hidden_at = '2026-11-10T12:00:00.000Z';

    const res = await request(meApp).get('/me/sales').set('Authorization', 'Bearer ' + token);

    expect(res.status).toBe(200);
    expect(res.body.sales.map((x) => x.id)).toEqual([VALE]);
    expect(res.body.stats.total_sales).toBe(2);
    expect(res.body.stats.revenue).toBe(120);

    const lista = sqls().find((s) => /ORDER BY s\.created_at DESC/.test(s) && /company_id = ANY/.test(s));
    const stats = sqls().filter((s) => /AS active_sales/.test(s));
    expect(lista).toMatch(/s\.hidden_at IS NULL/);
    expect(stats.length).toBe(2);
    stats.forEach((s) => expect(s).not.toMatch(/hidden_at/));
  });
});

describe('migration 439', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '439_sales_hidden.sql'), 'utf8');
  const semComentario = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  test('10. só aditiva e idempotente', () => {
    expect(semComentario).toMatch(/ALTER TABLE sales ADD COLUMN IF NOT EXISTS hidden_at timestamptz/);
    expect(semComentario).toMatch(/ALTER TABLE sales ADD COLUMN IF NOT EXISTS hidden_by uuid/);
    expect(semComentario).not.toMatch(/\bDELETE\b|\bDROP\b|\bUPDATE\b|\bNOT NULL\b|\bDEFAULT\b/i);
  });
});
