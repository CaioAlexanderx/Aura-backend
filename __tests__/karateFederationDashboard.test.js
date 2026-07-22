// ============================================================
// AURA KARATÊ — Teste do dashboard da federação (coerência de métricas)
// Foca no GET /federation/:id/dashboard:
//   1. dojo_count conta TODOS os dojôs (sem is_active).
//   2. Dojô SEM cobrança (sem registro de anuidade ou due_date NULL) é
//      'no_charge' → NEUTRO, fora de overdue_dojos.
//   3. overdue_rate = overdue / dojôs COM cobrança; 0 quando ninguém tem
//      cobrança (sem divisão por zero) e overdue_dojos vazio.
//   4. Mix realista: 1 overdue + 1 paid + 1 no_charge → rate 0.5, lista
//      contém apenas o dojô realmente vencido.
//
// Estratégia: mock do db (jest.setup.js mocka src/config/database). O handler
// dispara, na ordem: [dojoRes, practRes, revenueRes] (Promise.all),
// depois annuityRes, beltRes e as queries defensivas de alerta.
// As de alerta retornam count 0; falhas 42P01 são toleradas pelo handler.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const db      = require('../src/config/database');

const adminToken = jwt.sign(
  { id: 'user-test-uuid', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

const FED_ID = 'fed-uuid-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  const fedRouter = require('../src/routes/karateFederation');
  app.use('/federation/:id', fedRouter);
  return app;
}

// Programa a sequência de respostas do db.query para o dashboard.
// annuityRows = linhas já com annuity_status calculado (simula o CASE do SQL).
function primeDashboard({ dojoCount, annuityRows }) {
  db.query
    // Promise.all: dojoRes, practRes, revenueRes
    .mockResolvedValueOnce({ rows: [{ dojo_count: String(dojoCount) }] })
    .mockResolvedValueOnce({ rows: [{ practitioner_count: '0' }] })
    .mockResolvedValueOnce({ rows: [{ revenue_ytd: '0' }] })
    // annuityRes
    .mockResolvedValueOnce({ rows: annuityRows })
    // beltRes
    .mockResolvedValueOnce({ rows: [] })
    // alerts: connections, sync, reminders (count 0)
    .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
    .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
    .mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
}

describe('GET /federation/:id/dashboard — coerência de métricas', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('dojo_count reflete o COUNT(*) total (sem is_active)', (done) => {
    primeDashboard({
      dojoCount: 111,
      annuityRows: Array.from({ length: 111 }, (_, i) => ({
        dojo_id: `d${i}`, name: `Dojô ${i}`, amount: null,
        due_date: null, days_since_due: 0, annuity_status: 'no_charge',
      })),
    });
    request(app)
      .get(`/federation/${FED_ID}/dashboard`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.kpis.dojo_count).toBe(111);
        done();
      });
  });

  it('todos os dojôs SEM cobrança → overdue_rate 0 e overdue_dojos vazio', (done) => {
    primeDashboard({
      dojoCount: 111,
      annuityRows: Array.from({ length: 111 }, (_, i) => ({
        dojo_id: `d${i}`, name: `Dojô ${i}`, amount: null,
        due_date: null, days_since_due: 0, annuity_status: 'no_charge',
      })),
    });
    request(app)
      .get(`/federation/${FED_ID}/dashboard`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.kpis.overdue_rate).toBe(0);
        expect(res.body.overdue_dojos).toEqual([]);
        done();
      });
  });

  it('dojô sem registro de anuidade NÃO aparece em overdue_dojos', (done) => {
    primeDashboard({
      dojoCount: 1,
      annuityRows: [
        { dojo_id: 'd0', name: 'Dojô sem cobrança', amount: null,
          due_date: null, days_since_due: 0, annuity_status: 'no_charge' },
      ],
    });
    request(app)
      .get(`/federation/${FED_ID}/dashboard`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.overdue_dojos).toEqual([]);
        expect(res.body.kpis.overdue_rate).toBe(0);
        done();
      });
  });

  it('mix: 1 overdue + 1 paid + 1 no_charge → rate 0.5, lista só o vencido', (done) => {
    primeDashboard({
      dojoCount: 3,
      annuityRows: [
        { dojo_id: 'd-overdue', name: 'Atrasado', amount: '200',
          due_date: '2026-01-01', days_since_due: 60, annuity_status: 'overdue' },
        { dojo_id: 'd-paid', name: 'Em dia', amount: '200',
          due_date: '2026-12-01', days_since_due: 0, annuity_status: 'paid' },
        { dojo_id: 'd-nocharge', name: 'Sem cobrança', amount: null,
          due_date: null, days_since_due: 0, annuity_status: 'no_charge' },
      ],
    });
    request(app)
      .get(`/federation/${FED_ID}/dashboard`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        // 1 overdue entre 2 dojôs COM cobrança (overdue + paid) → 0.5
        expect(res.body.kpis.overdue_rate).toBe(0.5);
        expect(res.body.overdue_dojos).toHaveLength(1);
        expect(res.body.overdue_dojos[0].dojo_id).toBe('d-overdue');
        done();
      });
  });

  it('overdue_dojos é limitado a 50 itens (C7 teto defensivo)', (done) => {
    const annuityRows = Array.from({ length: 60 }, (_, i) => ({
      dojo_id: `d${i}`, name: `Dojô ${i}`, amount: '100',
      due_date: '2025-01-01', days_since_due: 400, annuity_status: 'suspended',
    }));
    primeDashboard({ dojoCount: 60, annuityRows });
    request(app)
      .get(`/federation/${FED_ID}/dashboard`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.overdue_dojos).toHaveLength(50);
        // rate considera todos os 60 com cobrança (suspended conta como overdue)
        expect(res.body.kpis.overdue_rate).toBe(1);
        done();
      });
  });
});

// ── belt_distribution: segmentação por is_active do PRATICANTE ──────
// Auditoria 21/07/2026 (Caio: "não podemos cobrar e controlar os inativos
// [...] sempre ativos primeiro"): "Praticantes por graduação" não filtrava
// por customers.is_active. Cobre: default só ativos (params traz o array
// boolean[] e a query text traz o filtro), toggle ?status=all (sem filtro)
// e ?status=inactive (filtro por inativos), e 422 pra status inválido —
// SEM tocar na ordem/contagem das outras queries do handler (mesma
// primeDashboard, mesmo mock sequencial).
describe('GET /federation/:id/dashboard — belt_distribution por is_active', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('default (sem ?status): filtra customers.is_active = ANY([true]) e devolve belt_distribution_status="active"', (done) => {
    primeDashboard({ dojoCount: 1, annuityRows: [] });
    request(app)
      .get(`/federation/${FED_ID}/dashboard`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.belt_distribution_status).toBe('active');
        // beltRes é a 5ª chamada a db.query (dojoRes, practRes, revenueRes, annuityRes, beltRes)
        const beltCall = db.query.mock.calls[4];
        expect(beltCall[0]).toMatch(/c\.is_active = ANY\(\$2::boolean\[\]\)/);
        expect(beltCall[1]).toEqual([FED_ID, [true]]);
        done();
      });
  });

  it('?status=all: remove o filtro de is_active (só $1)', (done) => {
    primeDashboard({ dojoCount: 1, annuityRows: [] });
    request(app)
      .get(`/federation/${FED_ID}/dashboard?status=all`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.belt_distribution_status).toBe('all');
        const beltCall = db.query.mock.calls[4];
        expect(beltCall[0]).not.toMatch(/is_active/);
        expect(beltCall[1]).toEqual([FED_ID]);
        done();
      });
  });

  it('?status=inactive: filtra customers.is_active = ANY([false])', (done) => {
    primeDashboard({ dojoCount: 1, annuityRows: [] });
    request(app)
      .get(`/federation/${FED_ID}/dashboard?status=inactive`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.belt_distribution_status).toBe('inactive');
        const beltCall = db.query.mock.calls[4];
        expect(beltCall[1]).toEqual([FED_ID, [false]]);
        done();
      });
  });

  it('?status inválido -> 422 VALIDATION_ERROR, nenhuma query dispara', (done) => {
    request(app)
      .get(`/federation/${FED_ID}/dashboard?status=bogus`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });
});
