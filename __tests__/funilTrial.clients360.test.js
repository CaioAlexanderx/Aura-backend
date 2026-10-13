// ============================================================
// AURA — Funil do trial no GET /admin/clients-360 (12/10/2026)
//
// O Caio precisa ver, por conta em trial, em que degrau ela parou:
// importou estoque -> abriu o Caixa -> vendeu -> viu o checkout. A rota
// devolve first_sale_at, caixa_sessions, last_caixa_at, imported_rows,
// checkout_viewed_at, checkout_views e ativacao {importou, abriu_caixa,
// vendeu, viu_checkout}. caixa_sessoes/import_logs ausentes (42P01) zeram o
// degrau em vez de derrubar a Gestão Aura.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const router = require('../src/routes/adminClients360');

const token = jwt.sign({ id: 'staff-1', role: 'admin' }, 'aura-test-secret-2026', { expiresIn: '1h' });
const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}

const base = {
  plan: 'negocio', is_active: true, billing_status: 'trial', is_sandbox: false, owner_is_staff: false,
  created_at: iso(-10), tx_count: '0', cust_count: '0', total_revenue: '0', login_days: '3',
  last_login_at: iso(-1), health_score: null,
};

const ROWS = [
  // Importou planilha, abriu o Caixa, não vendeu, não viu o checkout.
  { ...base, id: 'c-parcial', trade_name: 'Loja Parcial', trial_ends_at: iso(4),
    prod_count: '3', sale_count: '0', first_sale_at: null, checkout_viewed_at: null, checkout_views: '0' },
  // Cadastrou 12 produtos à mão, vendeu e viu o checkout depois de vencer.
  { ...base, id: 'c-completo', trade_name: 'Loja Completa', trial_ends_at: iso(-2),
    prod_count: '12', sale_count: '7', first_sale_at: iso(-8), checkout_viewed_at: iso(-1), checkout_views: '2' },
  // Nada feito.
  { ...base, id: 'c-zero', trade_name: 'Loja Zero', trial_ends_at: iso(6),
    prod_count: '0', sale_count: '0', first_sale_at: null, checkout_viewed_at: null, checkout_views: '0' },
];

function arrangeDb({ caixaError = null, importError = null } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('FROM companies c') && s.includes('ck ON true')) return { rows: ROWS.map((r) => ({ ...r })) };
    if (s.includes('FROM caixa_sessoes')) {
      if (caixaError) throw caixaError;
      return { rows: [{ company_id: 'c-parcial', caixa_sessions: '2', last_caixa_at: iso(-3) }] };
    }
    if (s.includes('FROM import_logs')) {
      if (importError) throw importError;
      return { rows: [{ company_id: 'c-parcial', imported_rows: '180' }] };
    }
    if (s.includes('extra_seats_granted')) return { rows: [] };
    throw new Error('SQL inesperado: ' + s);
  });
}

const get = () => request(makeApp()).get('/admin/clients-360').set('Authorization', 'Bearer ' + token);
const byId = (body, id) => body.clients.find((c) => c.id === id);

afterEach(() => db.query.mockReset());

describe('GET /admin/clients-360 — funil do trial', () => {
  test('devolve os campos do funil e a ativação por cliente', async () => {
    arrangeDb();
    const res = await get();
    expect(res.status).toBe(200);

    const parcial = byId(res.body, 'c-parcial');
    expect(parcial).toMatchObject({
      stage: 'trial', imported_rows: 180, caixa_sessions: 2, sale_count: 0,
      first_sale_at: null, checkout_viewed_at: null, checkout_views: 0,
    });
    expect(parcial.last_caixa_at).toBeTruthy();
    expect(parcial.ativacao).toEqual({ importou: true, abriu_caixa: true, vendeu: false, viu_checkout: false });

    const completo = byId(res.body, 'c-completo');
    expect(completo).toMatchObject({ stage: 'vencido', imported_rows: 0, caixa_sessions: 0, last_caixa_at: null, checkout_views: 2 });
    expect(completo.first_sale_at).toBeTruthy();
    expect(completo.checkout_viewed_at).toBeTruthy();
    // 12 produtos cadastrados à mão contam como estoque carregado.
    expect(completo.ativacao).toEqual({ importou: true, abriu_caixa: false, vendeu: true, viu_checkout: true });

    expect(byId(res.body, 'c-zero').ativacao).toEqual({ importou: false, abriu_caixa: false, vendeu: false, viu_checkout: false });
  });

  test('SQL: checkout.viewed e primeira venda no SELECT principal; importação só de produtos', async () => {
    arrangeDb();
    await get();
    const sqls = db.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' '));
    const main = sqls.find((s) => s.includes('FROM companies c'));
    expect(main).toMatch(/MIN\(created_at\) FROM sales WHERE company_id=c\.id\) AS first_sale_at/);
    expect(main).toMatch(/a\.action = 'checkout\.viewed'/);
    expect(sqls.find((s) => s.includes('FROM import_logs'))).toMatch(/module = 'products'/);
  });

  test('caixa_sessoes e import_logs ausentes (42P01) zeram o degrau sem derrubar a lista', async () => {
    const missing = (t) => Object.assign(new Error('relation "' + t + '" does not exist'), { code: '42P01' });
    arrangeDb({ caixaError: missing('caixa_sessoes'), importError: missing('import_logs') });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const parcial = byId(res.body, 'c-parcial');
    expect(parcial).toMatchObject({ caixa_sessions: 0, last_caixa_at: null, imported_rows: 0 });
    expect(parcial.ativacao).toEqual({ importou: false, abriu_caixa: false, vendeu: false, viu_checkout: false });
  });

  test('outro erro na query do funil sobe (não é engolido)', async () => {
    arrangeDb({ caixaError: Object.assign(new Error('timeout'), { code: '57014' }) });
    const res = await get();
    expect(res.status).toBe(500);
  });
});
