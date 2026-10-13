// ============================================================
// services/healthScore — o cálculo que saiu de POST /admin/health/recalculate.
//
// Mesmos pesos e níveis de risco. Fonte nova: atividade por
// companies.last_active_at (com a última venda de reserva) e uso por vendas
// dos últimos 30 dias. A rota e o job diário chamam a mesma função.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const { calcularScore, recalculateAll } = require('../../src/services/healthScore');

const AGORA = new Date('2026-10-13T12:00:00.000Z');
const dias = (n) => new Date(AGORA.getTime() - n * 86400000).toISOString();
const c = (extra) => ({ id: 'c1', plan: 'negocio', billing_status: 'active', last_active_at: null, last_sale_at: null, sales_30d: '0', ...extra });

afterEach(() => db.query.mockReset());

describe('calcularScore', () => {
  test('pesos: atividade + uso + pagamento + adoção', () => {
    expect(calcularScore(c({ plan: 'expansao', last_active_at: dias(1), sales_30d: '25' }), AGORA)).toMatchObject({
      score: 100, activity_score: 25, usage_score: 25, payment_score: 25, adoption_score: 25, risk_level: 'healthy',
    });
    expect(calcularScore(c({ plan: 'essencial', billing_status: 'trial' }), AGORA)).toMatchObject({
      score: 20, activity_score: 0, usage_score: 0, payment_score: 15, adoption_score: 5, risk_level: 'at_risk',
    });
  });

  test.each([[1, 25], [7, 25], [10, 15], [14, 15], [20, 5], [30, 5], [45, 0]])(
    'atividade: último acesso há %i dias vale %i', (n, pontos) => {
      expect(calcularScore(c({ last_active_at: dias(n) }), AGORA).activity_score).toBe(pontos);
    }
  );

  test.each([[0, 0], [1, 5], [5, 10], [10, 20], [20, 25]])('uso: %i vendas em 30 dias valem %i', (n, pontos) => {
    expect(calcularScore(c({ sales_30d: String(n) }), AGORA).usage_score).toBe(pontos);
  });

  test('atividade usa last_active_at e, na falta dele, a última venda', () => {
    expect(calcularScore(c({ last_active_at: dias(40), last_sale_at: dias(1) }), AGORA).activity_score).toBe(0);
    const r = calcularScore(c({ last_active_at: null, last_sale_at: dias(3) }), AGORA);
    expect(r.activity_score).toBe(25);
    expect(r.last_login).toBe(dias(3));
  });

  test.each([[70, 'healthy'], [40, 'attention'], [20, 'at_risk'], [15, 'critical']])('risco: %i pontos é %s', (alvo, risco) => {
    const casos = {
      70: c({ last_active_at: dias(1), sales_30d: '1' }), // 25 + 5 + 25 + 15
      40: c({}), // 0 + 0 + 25 + 15
      20: c({ plan: 'essencial', billing_status: 'trial' }), // 15 + 5
      15: c({ plan: 'personalizado', billing_status: 'trial' }), // 15
    };
    const r = calcularScore(casos[alvo], AGORA);
    expect(r.score).toBe(alvo);
    expect(r.risk_level).toBe(risco);
  });
});

describe('recalculateAll', () => {
  test('lê last_active_at e vendas (não transactions) e grava tudo num INSERT só', async () => {
    db.query.mockImplementation(async (sql) => (sql.includes('FROM companies c')
      ? { rows: [c({ id: 'a', last_active_at: dias(2), sales_30d: '12' }), c({ id: 'b', billing_status: 'trial', plan: 'essencial' })] }
      : { rows: [] }));
    const r = await recalculateAll({ agora: AGORA });
    expect(r).toEqual({ updated: 2 });
    expect(db.query).toHaveBeenCalledTimes(2);

    const leitura = db.query.mock.calls[0][0];
    expect(leitura).toContain('c.last_active_at');
    expect(leitura).toContain('FROM sales s');
    expect(leitura).not.toContain('transactions');

    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toContain('ON CONFLICT (company_id) DO UPDATE');
    expect(JSON.parse(params[0]).map((s) => [s.company_id, s.score, s.risk_level])).toEqual([
      ['a', 85, 'healthy'], // 25 + 20 + 25 + 15
      ['b', 20, 'at_risk'],
    ]);
  });

  test('sem empresas não grava nada', async () => {
    db.query.mockResolvedValue({ rows: [] });
    expect(await recalculateAll()).toEqual({ updated: 0 });
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('POST /admin/health/recalculate', () => {
  test('a rota chama o mesmo serviço e mantém a resposta', async () => {
    db.query.mockImplementation(async (sql) => (sql.includes('FROM companies c') ? { rows: [c({ id: 'a' })] } : { rows: [] }));
    const app = express();
    app.use(express.json());
    app.use('/admin', require('../../src/routes/adminMetrics'));
    const token = jwt.sign({ id: 'staff-1', role: 'admin' }, 'aura-test-secret-2026');
    const res = await request(app).post('/admin/health/recalculate').set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Health scores recalculados para 1 empresas', updated: 1 });
    expect(db.query.mock.calls[1][0]).toContain('INSERT INTO client_health_scores');
  });
});
