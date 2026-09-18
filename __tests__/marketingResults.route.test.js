// ============================================================
// AURA — FASE 1 do CRM: contrato HTTP de "resultado das mensagens"
//
// Cobertura pedida pela spec: formato da resposta, período padrão (30
// dias) e o gate de plano (negocio/expansao).
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

const COMPANY = 'company-uuid-marketing';

const tokenNegocio = jwt.sign(
  { id: 'user-lojista', role: 'admin', plan: 'negocio' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);
const tokenEssencial = jwt.sign(
  { id: 'user-essencial', role: 'admin', plan: 'essencial' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  // Mesma ordem de private.js: requireAuth decodifica o JWT em req.user
  // ANTES do requirePlan (que só lê req.user.plan). requireCompanyAccess
  // não entra aqui de propósito — é aplicado pelo próprio private.js antes
  // do mount; o teste de rota isola marketingResults.js + o requirePlan
  // que private.js aplica no mount ('/marketing').
  const { requireAuth, requirePlan } = require('../src/middleware/auth');
  app.use('/companies/:id/marketing', requireAuth, requirePlan('negocio', 'expansao'), require('../src/routes/marketingResults'));
  return app;
}

function mockBanco({ envios = [], outboxById = {}, coupons = {}, vendas = [], puladas = [], customers = [] } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (s.includes('-- mkt-attr:envios')) {
      return Promise.resolve({
        rows: envios.map((e) => ({
          id: e.id,
          customer_id: e.customer_id,
          kind: e.kind || 'reativacao',
          coupon_id: e.coupon_id || null,
          sent_at: e.sent_at,
          outbox_status: e.outbox_status || null,
          outbox_updated_at: e.outbox_updated_at || null,
          coupon_code: e.coupon_id ? (coupons[e.coupon_id] && coupons[e.coupon_id].code) : null,
          coupon_expires_at: e.coupon_id ? (coupons[e.coupon_id] && coupons[e.coupon_id].expires_at) : null,
        })),
      });
    }
    if (s.includes('-- mkt-attr:vendas')) {
      return Promise.resolve({ rows: vendas });
    }
    if (s.includes('-- mkt-attr:puladas')) {
      return Promise.resolve({ rows: puladas });
    }
    if (s.includes('FROM customers WHERE company_id')) {
      return Promise.resolve({ rows: customers });
    }
    return Promise.resolve({ rows: [] });
  });
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
});

describe('GET /companies/:id/marketing/results', () => {
  it('formato da resposta: card "N mensagens -> M voltaram -> RS valor" completo', async () => {
    mockBanco({
      envios: [
        { id: 'e1', customer_id: 'c1', coupon_id: 'cup1', sent_at: '2026-09-01T10:00:00Z', outbox_status: 'read', outbox_updated_at: '2026-09-01T11:00:00Z' },
        { id: 'e2', customer_id: 'c2', sent_at: '2026-09-02T10:00:00Z', outbox_status: 'delivered' },
        { id: 'e3', customer_id: 'c3', sent_at: '2026-09-03T10:00:00Z', outbox_status: 'sent' },
      ],
      coupons: { cup1: { code: 'VOLTA-C1-26', expires_at: '2026-09-30T23:59:59Z' } },
      vendas: [
        { id: 'v1', customer_id: 'c1', coupon_id: 'cup1', total_amount: 120, status: 'completed', cancelled_at: null, type: 'sale', created_at: '2026-09-05T10:00:00Z' },
        { id: 'v2', customer_id: 'c2', coupon_id: null, total_amount: 80, status: 'completed', cancelled_at: null, type: 'sale', created_at: '2026-09-04T10:00:00Z' },
      ],
      puladas: [{ motivo: 'SEM_CONSENTIMENTO', n: 2 }],
    });

    const res = await request(buildApp())
      .get(`/companies/${COMPANY}/marketing/results?kind=all&from=2026-09-01&to=2026-09-10`)
      .set('Authorization', 'Bearer ' + tokenNegocio);

    expect(res.status).toBe(200);
    expect(res.body.enviadas).toBe(3);
    expect(res.body.entregues).toBe(2); // delivered + read
    expect(res.body.lidas).toBe(1);
    expect(res.body.puladas_por_motivo).toEqual({ SEM_CONSENTIMENTO: 2 });
    expect(res.body.clientes_que_voltaram).toBe(2); // c1 (direta) + c2 (estimada)
    expect(res.body.vendas.diretas).toEqual({ qtd: 1, valor: 120 });
    expect(res.body.vendas.estimadas).toEqual({ qtd: 1, valor: 80 });
    expect(res.body.receita_total).toBe(200);
    expect(res.body.custo_estimado).toEqual({ mensagens: 3, valor_brl: 1.47 }); // 3 * 0,49
    expect(res.body.janela_dias).toBe(5);
    expect(res.body.rotulo).toBe('estimativa');
    expect(res.body.periodo).toEqual({ from: '2026-09-01', to: '2026-09-10' });
    // campos internos de uso exclusivo do by-customer não vazam na resposta
    expect(res.body._diretas).toBeUndefined();
    expect(res.body._estimadas).toBeUndefined();
  });

  it('período padrão: sem from/to, usa os últimos 30 dias terminando hoje', async () => {
    mockBanco({});
    const res = await request(buildApp())
      .get(`/companies/${COMPANY}/marketing/results`)
      .set('Authorization', 'Bearer ' + tokenNegocio);

    expect(res.status).toBe(200);
    const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    expect(res.body.periodo.to).toBe(hoje);
    const dias = Math.round(
      (new Date(res.body.periodo.to) - new Date(res.body.periodo.from)) / 86400000
    );
    expect(dias).toBe(29); // 30 dias incluindo hoje
  });

  it('gate de plano: essencial toma 403 e nem chega no banco', async () => {
    mockBanco({});
    const res = await request(buildApp())
      .get(`/companies/${COMPANY}/marketing/results`)
      .set('Authorization', 'Bearer ' + tokenEssencial);
    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('sem token: 401', async () => {
    const res = await request(buildApp()).get(`/companies/${COMPANY}/marketing/results`);
    expect(res.status).toBe(401);
  });
});

describe('GET /companies/:id/marketing/results/by-customer', () => {
  it('top 20 por receita, com nome do cliente e enviada/lida/voltou', async () => {
    mockBanco({
      envios: [
        { id: 'e1', customer_id: 'c1', sent_at: '2026-09-01T10:00:00Z', outbox_status: 'read', outbox_updated_at: '2026-09-01T11:00:00Z' },
      ],
      vendas: [
        { id: 'v1', customer_id: 'c1', coupon_id: null, total_amount: 250, status: 'completed', cancelled_at: null, type: 'sale', created_at: '2026-09-03T10:00:00Z' },
      ],
      customers: [{ id: 'c1', name: 'Maria Cliente' }],
    });

    const res = await request(buildApp())
      .get(`/companies/${COMPANY}/marketing/results/by-customer?kind=reactivation&from=2026-09-01&to=2026-09-10`)
      .set('Authorization', 'Bearer ' + tokenNegocio);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      customer_id: 'c1', name: 'Maria Cliente',
      enviada_em: '2026-09-01T10:00:00Z', lida_em: '2026-09-01T11:00:00Z',
      voltou_em: '2026-09-03T10:00:00Z', valor: 250, tipo: 'estimada',
    });
  });
});
