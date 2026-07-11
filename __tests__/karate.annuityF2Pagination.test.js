// ============================================================
// AURA KARATÊ — Fase F2: paginação real + status alias nas listagens
// (GET /financial/annuities/dojos e /cpf) e PUT /financial/fees por plano.
//
// As listagens agora fazem 2 queries (COUNT + SELECT ... LIMIT/OFFSET) em
// vez de buscar tudo e fatiar em memória. Os mocks abaixo respeitam essa
// ordem: 1) COUNT, 2) SELECT paginado, 3) (opcional) parcelas da página.
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

const FED_ID = 'fed-uuid-f2-pag';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id/financial', require('../src/routes/karateAnnuities'));
  app.use('/federation/:id/financial', require('../src/routes/karateFees'));
  return app;
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

describe('GET /financial/annuities/dojos — paginação real', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('shape da resposta é { data, total, page, pageSize } (default pageSize=50)', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 3 }] }) // COUNT
      .mockResolvedValueOnce({ rows: [
        { dojo_id: 'd1', dojo_name: 'Dojo 1', fpkt_affiliation_id: 'F1', whatsapp: null,
          annuity_id: null, reference_period: null, amount: null, due_date: null,
          paid_at: null, annuity_status: null, transaction_id: null, plan: null,
          computed_status: 'no_charge', days_overdue: 0 },
      ] }) // SELECT paginado
      .mockResolvedValueOnce({ rows: [] }); // parcelas (nenhum annuity_id)

    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/dojos`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(3);
        expect(res.body.page).toBe(1);
        expect(res.body.pageSize).toBe(50);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].status).toBe('no_charge');
        done();
      });
  });

  it('pageSize é limitado a 100 mesmo se o cliente pedir mais', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/dojos?pageSize=500`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.pageSize).toBe(100);
        // LIMIT deve ter ido pro banco já capado em 100
        const dataCallParams = db.query.mock.calls[1][1];
        expect(dataCallParams[4]).toBe(100);
        done();
      });
  });

  it('status=atrasado (alias) filtra overdue ∪ defaulting ∪ suspended no banco', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/dojos?status=atrasado`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        const countParams = db.query.mock.calls[0][1];
        expect(countParams[3]).toEqual(['overdue', 'defaulting', 'suspended']);
        done();
      });
  });

  // Módulo ISOLADO (jest.resetModules + require novo) — HAS_INSTALLMENTS é
  // um cache module-level compartilhado entre /dojos e /cpf; se este teste
  // reusasse o `app` do beforeAll ele "vazaria" o flag=false pros testes
  // seguintes do arquivo (inclusive os de /cpf), fazendo-os silenciosamente
  // exercitar o fallback legado em vez do caminho principal. Mesmo padrão
  // de isolamento de __tests__/karate.trackK.regression.test.js.
  it('42703 (migration 222 ausente) cai no fallback legado sem quebrar, mantendo paginação', (done) => {
    let isolatedApp, isolatedDb;
    jest.isolateModules(() => {
      isolatedDb = require('../src/config/database');
      const isolatedRouter = require('../src/routes/karateAnnuities');
      isolatedApp = express();
      isolatedApp.use(express.json());
      isolatedApp.use('/federation/:id/financial', isolatedRouter);
    });

    const err = new Error('column h.plan does not exist');
    err.code = '42703';
    isolatedDb.query
      .mockRejectedValueOnce(err)               // COUNT com h.plan falha
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })  // COUNT fallback (sem plan)
      .mockResolvedValueOnce({ rows: [
        { dojo_id: 'd1', dojo_name: 'Dojo 1', fpkt_affiliation_id: 'F1', whatsapp: null,
          annuity_id: null, reference_period: null, amount: null, due_date: null,
          paid_at: null, annuity_status: null, transaction_id: null,
          computed_status: 'no_charge', days_overdue: 0 },
      ] }); // SELECT fallback

    request(isolatedApp)
      .get(`/federation/${FED_ID}/financial/annuities/dojos`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((reqErr, res) => {
        if (reqErr) return done(reqErr);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.data[0].plan).toBeUndefined();
        isolatedDb.query.mockReset();
        done();
      });
  });
});

describe('GET /financial/annuities/cpf — paginação real', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('shape { data, total, page, pageSize } e busca (q) chega como parâmetro', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/cpf?q=silva&page=2&pageSize=10`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.page).toBe(2);
        expect(res.body.pageSize).toBe(10);
        const countParams = db.query.mock.calls[0][1];
        expect(countParams[2]).toBe('silva');
        const dataParams = db.query.mock.calls[1][1];
        // offset = (page-1)*pageSize = 10
        expect(dataParams[5]).toBe(10);
        // confirma que é o caminho PRIMÁRIO (pós-migration 222), não o
        // fallback legado (transactions) — guarda contra vazamento do
        // cache HAS_INSTALLMENTS entre testes deste arquivo.
        expect(db.query.mock.calls[0][0]).toMatch(/karate_dojo_annuity_history/);
        done();
      });
  });
});

describe('PUT /financial/fees — vigência por plano (Fase F2)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('cria vigência plano-based válida (dojo/trimestral, 4 meses) e não mexe em transação', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: FED_ID }] }) // valida federação
      .mockResolvedValueOnce({ rows: [{
        id: 'fee-plan-1', fee_type: 'dojo', plan: 'trimestral', size_tier: null,
        amount: '150.00', due_months: [2, 5, 8, 11], effective_from: '2026-07-11',
      }] }); // INSERT

    request(app)
      .put(`/federation/${FED_ID}/financial/fees`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ fee_type: 'dojo', plan: 'trimestral', amount: 150, due_months: [2, 5, 8, 11] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.plan).toBe('trimestral');
        expect(res.body.due_months).toEqual([2, 5, 8, 11]);
        expect(res.body.amount).toBe(150);
        // não deve ter usado db.connect (transação) — é um INSERT único
        expect(db.connect).not.toHaveBeenCalled();
        done();
      });
  });

  it('rejeita due_months incoerente com o plano (semestral exige 2, recebeu 1)', (done) => {
    request(app)
      .put(`/federation/${FED_ID}/financial/fees`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ fee_type: 'dojo', plan: 'semestral', amount: 280, due_months: [5] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        done();
      });
  });

  it('cpf sempre exige exatamente 1 cobrança, mesmo com plan diferente de anual', (done) => {
    request(app)
      .put(`/federation/${FED_ID}/financial/fees`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ fee_type: 'cpf', plan: 'trimestral', amount: 60, due_months: [2, 5, 8, 11] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });

  it('rejeita mês fora do intervalo 1-12', (done) => {
    request(app)
      .put(`/federation/${FED_ID}/financial/fees`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ fee_type: 'cpf', plan: 'anual', amount: 60, due_months: [13] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });

  it('rejeita plan inválido', (done) => {
    request(app)
      .put(`/federation/${FED_ID}/financial/fees`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ fee_type: 'dojo', plan: 'mensal', amount: 100, due_months: [1] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });

  it('shape legado (fees: []) continua funcionando (retrocompatibilidade com o front antigo)', (done) => {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: FED_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: 'fee-1', fee_type: 'dojo', size_tier: 'up_to_40', amount: 600, effective_from: '2027-01-01' }] })
      .mockResolvedValueOnce({});

    request(app)
      .put(`/federation/${FED_ID}/financial/fees`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ effective_from: '2027-01-01', fees: [{ fee_type: 'dojo', size_tier: 'up_to_40', amount: 600 }] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        done();
      });
  });
});
