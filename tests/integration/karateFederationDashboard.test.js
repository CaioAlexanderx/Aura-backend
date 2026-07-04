// ============================================================
// AURA KARATÊ — Testes Integração: Dashboard da Federação
// Cobre GET /federation/:id/dashboard com dados reais de anuidade
// (tabela karate_dojo_annuity_history, migration 152).
//
// Ordem dos mocks db.query DEVE espelhar a ordem real do handler:
//   1. Promise.all: [dojo_count, practitioner_count, revenue_ytd]
//   2. annuityRes  (agregação LEFT JOIN karate_dojo_annuity_history)
//   3. beltRes     (karate_current_belt)
//
// REGRA CRÍTICA: usar db.query.mockReset() em afterEach —
// jest.clearAllMocks NÃO drena filas mockResolvedValueOnce.
// ============================================================
'use strict';

const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const fedId  = 'fed00000-0000-0000-0000-000000000001';
const authHeader = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', role: 'client', plan: 'negocio' },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

afterEach(() => {
  // Drena filas mockResolvedValueOnce entre testes.
  // jest.clearAllMocks() NÃO é suficiente para isso.
  db.query.mockReset();
});

// Helpers para montar mocks na ordem exata do handler
function mockCompanyAccess() {
  // requireCompanyAccess faz 1 db.query para verificar o role do usuário
  db.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
}

function mockKpis({ dojoCount = 2, practCount = 10, revenue = '5000.00' } = {}) {
  // Promise.all dispara 3 queries em paralelo; mockResolvedValueOnce
  // respeita a ordem de chamada mesmo em Promise.all
  db.query
    .mockResolvedValueOnce({ rows: [{ dojo_count: String(dojoCount) }] })
    .mockResolvedValueOnce({ rows: [{ practitioner_count: String(practCount) }] })
    .mockResolvedValueOnce({ rows: [{ revenue_ytd: revenue }] });
}

function mockAnnuity(rows) {
  db.query.mockResolvedValueOnce({ rows });
}

function mockBelt(rows = []) {
  db.query.mockResolvedValueOnce({ rows });
}

// ── Testes ─────────────────────────────────────────────────
describe('GET /federation/:id/dashboard — overdue via anuidades', () => {

  test('retorna 401 sem token', async () => {
    const res = await request(app)
      .get(`/api/v1/federation/${fedId}/dashboard`);
    expect(res.status).toBe(401);
  });

  test('retorna dashboard com overdue_dojos reais quando há anuidade vencida', async () => {
    mockCompanyAccess();
    mockKpis({ dojoCount: 2, practCount: 15, revenue: '8000.00' });
    // Dojô 1: overdue (vencida há 30 dias, amount=1200)
    // Dojô 2: paid
    mockAnnuity([
      {
        dojo_id:        'dojo-0001',
        name:           'Dojô Fênix',
        amount:         '1200.00',
        due_date:       new Date(Date.now() - 30 * 86400000).toISOString(),
        days_since_due: '30',
        annuity_status: 'overdue',
      },
      {
        dojo_id:        'dojo-0002',
        name:           'Dojô Dragão',
        amount:         '1200.00',
        due_date:       new Date(Date.now() - 5 * 86400000).toISOString(),
        days_since_due: '0',
        annuity_status: 'paid',
      },
    ]);
    mockBelt([
      { belt_level: 'branca',  belt_name: 'Branca',  count: '8' },
      { belt_level: 'amarela', belt_name: 'Amarela', count: '7' },
    ]);

    const res = await request(app)
      .get(`/api/v1/federation/${fedId}/dashboard`)
      .set(authHeader());

    expect(res.status).toBe(200);

    // KPIs
    expect(res.body.kpis.dojo_count).toBe(2);
    expect(res.body.kpis.practitioner_count).toBe(15);
    expect(res.body.kpis.revenue_ytd).toBe(8000);
    // 1 de 2 dojôs overdue → 0.5
    expect(res.body.kpis.overdue_rate).toBe(0.5);

    // overdue_dojos com valores reais (não stubs)
    expect(res.body.overdue_dojos).toHaveLength(1);
    const od = res.body.overdue_dojos[0];
    expect(od.dojo_id).toBe('dojo-0001');
    expect(od.name).toBe('Dojô Fênix');
    expect(od.amount).toBe(1200);
    expect(od.days_overdue).toBe(30);

    // belt_distribution: scaffold sempre inclui as 8 faixas kyu canônicas
    // (Branca..Marrom), preenchendo com 0 as ausentes. As faixas com dados
    // (Branca=8, Amarela=7) são mescladas por belt_level; as demais vêm com 0.
    expect(res.body.belt_distribution).toHaveLength(8);
    expect(res.body.belt_distribution[0].belt_name).toBe('Branca');
    expect(res.body.belt_distribution[0].count).toBe(8);
    expect(res.body.belt_distribution[1].belt_name).toBe('Amarela');
    expect(res.body.belt_distribution[1].count).toBe(7);
    // faixa sem praticante aparece com count 0 (ex.: Laranja)
    const laranja = res.body.belt_distribution.find((b) => b.belt_name === 'Laranja');
    expect(laranja).toBeDefined();
    expect(laranja.count).toBe(0);

    // upcoming_events stub permanece
    expect(Array.isArray(res.body.upcoming_events)).toBe(true);
  });

  test('overdue_rate = 0 quando todos os dojôs estão em dia', async () => {
    mockCompanyAccess();
    mockKpis({ dojoCount: 1, practCount: 5, revenue: '1000.00' });
    mockAnnuity([
      {
        dojo_id:        'dojo-0003',
        name:           'Dojô Águia',
        amount:         '900.00',
        due_date:       new Date(Date.now() + 30 * 86400000).toISOString(),
        days_since_due: '0',
        annuity_status: 'paid',
      },
    ]);
    mockBelt([]);

    const res = await request(app)
      .get(`/api/v1/federation/${fedId}/dashboard`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.kpis.overdue_rate).toBe(0);
    expect(res.body.overdue_dojos).toHaveLength(0);
  });

  test('dojô sem registro de anuidade aparece como suspended em overdue_dojos', async () => {
    mockCompanyAccess();
    mockKpis({ dojoCount: 1, practCount: 3, revenue: '0.00' });
    // Sem registro na tabela de anuidades → LEFT JOIN retorna null → status suspended
    mockAnnuity([
      {
        dojo_id:        'dojo-0004',
        name:           'Dojô Sombra',
        amount:         null,
        due_date:       null,
        days_since_due: null,
        annuity_status: 'suspended',
      },
    ]);
    mockBelt([]);

    const res = await request(app)
      .get(`/api/v1/federation/${fedId}/dashboard`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.overdue_dojos).toHaveLength(1);
    expect(res.body.overdue_dojos[0].dojo_id).toBe('dojo-0004');
    expect(res.body.overdue_dojos[0].amount).toBe(0);
    expect(res.body.overdue_dojos[0].days_overdue).toBe(0);
    expect(res.body.kpis.overdue_rate).toBe(1);
  });

  test('defaulting e suspended também entram em overdue_dojos', async () => {
    mockCompanyAccess();
    mockKpis({ dojoCount: 3, practCount: 20, revenue: '3000.00' });
    mockAnnuity([
      {
        dojo_id: 'd1', name: 'D1', amount: '1500.00',
        due_date: new Date(Date.now() - 120 * 86400000).toISOString(),
        days_since_due: '120', annuity_status: 'defaulting',
      },
      {
        dojo_id: 'd2', name: 'D2', amount: '1500.00',
        due_date: new Date(Date.now() - 200 * 86400000).toISOString(),
        days_since_due: '200', annuity_status: 'suspended',
      },
      {
        dojo_id: 'd3', name: 'D3', amount: '1500.00',
        due_date: new Date(Date.now() + 10 * 86400000).toISOString(),
        days_since_due: '0', annuity_status: 'paid',
      },
    ]);
    mockBelt([]);

    const res = await request(app)
      .get(`/api/v1/federation/${fedId}/dashboard`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.overdue_dojos).toHaveLength(2);
    // overdue_rate = 2/3
    expect(res.body.kpis.overdue_rate).toBeCloseTo(0.6667, 3);
    const ids = res.body.overdue_dojos.map(d => d.dojo_id);
    expect(ids).toContain('d1');
    expect(ids).toContain('d2');
    expect(ids).not.toContain('d3');
  });

  test('federação sem dojôs retorna overdue_rate = 0 e listas vazias', async () => {
    mockCompanyAccess();
    mockKpis({ dojoCount: 0, practCount: 0, revenue: '0.00' });
    mockAnnuity([]);  // nenhum dojô
    mockBelt([]);

    const res = await request(app)
      .get(`/api/v1/federation/${fedId}/dashboard`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.kpis.overdue_rate).toBe(0);
    expect(res.body.overdue_dojos).toHaveLength(0);
  });
});
