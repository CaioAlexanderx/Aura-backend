// ============================================================
// AURA KARATÊ — Fase F2: testes de GET /financial/annuities/summary
//
// A rota faz UMA query (GROUPING SETS) que devolve até 3 linhas: kind='dojo',
// kind='praticante', kind=NULL (total). Os testes mockam db.query e cobrem:
//   1. mapeamento correto das 3 linhas pro shape { year, total, dojo, praticante }
//   2. bucket ausente (ex.: federação sem cobrança de dojo) -> zeros, não quebra
//   3. defensivo 42703/42P01 -> zeros (nunca 500)
//   4. year: default (ano corrente) e explícito via querystring
//   5. a query em si RESPEITA as regras de negócio que não podem ser violadas:
//      - só entra no segmento praticante quem é preta E ativo
//        (não conta inativo/não-preta)
//      - "atrasado" exige due_date <= CURRENT_DATE; "em_aberto" não exige
//        due_date nenhum — logo uma parcela FUTURA (due_date > hoje, ainda
//        não vencida) cai em em_aberto mas NUNCA em atrasado.
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

const FED_ID = 'fed-uuid-annuity-summary';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id/financial', require('../src/routes/karateAnnuitySummary'));
  return app;
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
});

describe('GET /federation/:id/financial/annuities/summary', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('mapeia as 3 linhas (dojo/praticante/total) pro shape esperado, com valor e count em cada bucket', (done) => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          kind: 'dojo',
          previsto_count: 11, previsto_valor: '4611.00',
          recebido_count: 11, recebido_valor: '4611.00',
          em_aberto_count: 0, em_aberto_valor: '0',
          atrasado_count: 0, atrasado_valor: '0',
        },
        {
          kind: 'praticante',
          previsto_count: 548, previsto_valor: '32825.00',
          recebido_count: 29, recebido_valor: '1720.00',
          em_aberto_count: 519, em_aberto_valor: '31105.00',
          atrasado_count: 519, atrasado_valor: '31105.00',
        },
        {
          kind: null,
          previsto_count: 559, previsto_valor: '37436.00',
          recebido_count: 40, recebido_valor: '6331.00',
          em_aberto_count: 519, em_aberto_valor: '31105.00',
          atrasado_count: 519, atrasado_valor: '31105.00',
        },
      ],
    });

    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/summary?year=2026`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.year).toBe('2026');
        // Total bate com a conferência de produção da federação de referência.
        expect(res.body.total.atrasado).toEqual({ valor: 31105, count: 519 });
        expect(res.body.total.em_aberto).toEqual({ valor: 31105, count: 519 });
        expect(res.body.total.recebido).toEqual({ valor: 6331, count: 40 });
        expect(res.body.total.previsto).toEqual({ valor: 37436, count: 559 });
        // Segmentado — dojo totalmente pago, praticante com 519 em atraso.
        expect(res.body.dojo.atrasado).toEqual({ valor: 0, count: 0 });
        expect(res.body.praticante.atrasado).toEqual({ valor: 31105, count: 519 });
        // dojo + praticante == total, em todo bucket (a soma nunca é feita
        // no cliente — é a própria query que garante isso via GROUPING SETS)
        for (const bucket of ['previsto', 'recebido', 'em_aberto', 'atrasado']) {
          expect(res.body.dojo[bucket].valor + res.body.praticante[bucket].valor).toBeCloseTo(res.body.total[bucket].valor, 2);
          expect(res.body.dojo[bucket].count + res.body.praticante[bucket].count).toBe(res.body.total[bucket].count);
        }
        done();
      });
  });

  it('segmento ausente na query (ex.: federação sem cobrança de dojo) devolve zeros nesse segmento, não quebra', (done) => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          kind: 'praticante',
          previsto_count: 5, previsto_valor: '300.00',
          recebido_count: 0, recebido_valor: '0',
          em_aberto_count: 5, em_aberto_valor: '300.00',
          atrasado_count: 2, atrasado_valor: '120.00',
        },
        {
          kind: null,
          previsto_count: 5, previsto_valor: '300.00',
          recebido_count: 0, recebido_valor: '0',
          em_aberto_count: 5, em_aberto_valor: '300.00',
          atrasado_count: 2, atrasado_valor: '120.00',
        },
      ],
    });

    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/summary`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.dojo).toEqual({
          previsto: { valor: 0, count: 0 },
          recebido: { valor: 0, count: 0 },
          em_aberto: { valor: 0, count: 0 },
          atrasado: { valor: 0, count: 0 },
        });
        expect(res.body.praticante.atrasado).toEqual({ valor: 120, count: 2 });
        done();
      });
  });

  it('year default = ano corrente quando não informado na querystring', (done) => {
    db.query.mockResolvedValueOnce({ rows: [] });
    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/summary`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.year).toBe(String(new Date().getFullYear()));
        // segundo parâmetro da query é o ano (reference_period)
        expect(db.query.mock.calls[0][1][1]).toBe(String(new Date().getFullYear()));
        done();
      });
  });

  it('year inválido (não 4 dígitos) cai no default, não quebra', (done) => {
    db.query.mockResolvedValueOnce({ rows: [] });
    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/summary?year=abc`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.year).toBe(String(new Date().getFullYear()));
        done();
      });
  });

  it('42703 (coluna ausente / deployment parcial) devolve zeros, nunca 500', (done) => {
    const err = new Error('column "plan" does not exist');
    err.code = '42703';
    db.query.mockRejectedValueOnce(err);

    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/summary?year=2026`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((reqErr, res) => {
        if (reqErr) return done(reqErr);
        expect(res.status).toBe(200);
        expect(res.body.total).toEqual({
          previsto: { valor: 0, count: 0 },
          recebido: { valor: 0, count: 0 },
          em_aberto: { valor: 0, count: 0 },
          atrasado: { valor: 0, count: 0 },
        });
        done();
      });
  });

  it('42P01 (tabela/view ausente) devolve zeros, nunca 500', (done) => {
    const err = new Error('relation "karate_annuity_installments" does not exist');
    err.code = '42P01';
    db.query.mockRejectedValueOnce(err);

    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/summary`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((reqErr, res) => {
        if (reqErr) return done(reqErr);
        expect(res.status).toBe(200);
        expect(res.body.praticante.previsto.count).toBe(0);
        done();
      });
  });

  it('erro inesperado (sem code 42xxx) devolve 500, não mascara falha real', (done) => {
    db.query.mockRejectedValueOnce(new Error('connection terminated'));

    request(app)
      .get(`/federation/${FED_ID}/financial/annuities/summary`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((reqErr, res) => {
        if (reqErr) return done(reqErr);
        expect(res.status).toBe(500);
        done();
      });
  });

  // ── Regras de negócio embutidas na query em si (SQL) ───────────────────────
  describe('regras de negócio embutidas na SQL (proteção contra regressão silenciosa)', () => {
    it('segmento praticante só considera faixa-preta ATIVA (join com is_active + belt_level=preta)', (done) => {
      db.query.mockResolvedValueOnce({ rows: [] });
      request(app)
        .get(`/federation/${FED_ID}/financial/annuities/summary?year=2026`)
        .set('Authorization', 'Bearer ' + adminToken)
        .end((err) => {
          if (err) return done(err);
          const sql = db.query.mock.calls[0][0];
          expect(sql).toMatch(/COALESCE\(cu\.is_active,\s*true\)/);
          expect(sql).toMatch(/cb\.belt_level\s*=\s*'preta'/);
          done();
        });
    });

    it('"atrasado" exige due_date <= CURRENT_DATE (parcela futura nunca conta como atrasado)', (done) => {
      db.query.mockResolvedValueOnce({ rows: [] });
      request(app)
        .get(`/federation/${FED_ID}/financial/annuities/summary?year=2026`)
        .set('Authorization', 'Bearer ' + adminToken)
        .end((err) => {
          if (err) return done(err);
          const sql = db.query.mock.calls[0][0];
          // Isola a condição do FILTER (WHERE ...) que precede cada rótulo
          // "AS <coluna>" (sintaxe SQL: a condição vem ANTES do "AS").
          const filterFor = (label) => {
            const m = sql.match(new RegExp('FILTER \\(WHERE ([\\s\\S]*?)\\)(?:::int)? AS ' + label + '\\b'));
            return m ? m[1] : null;
          };
          // "atrasado" exige due_date <= CURRENT_DATE (parcela futura nunca
          // conta como atrasado).
          expect(filterFor('atrasado_count')).toMatch(/due_date <= CURRENT_DATE/);
          // "em_aberto" (tudo não pago, vencido ou não) NÃO tem condição de
          // due_date — senão parcela futura ficaria de fora dos R$ em
          // aberto, o que violaria a regra de negócio.
          expect(filterFor('em_aberto_count')).not.toMatch(/due_date/);
          done();
        });
    });

    it('reference_period usa exatamente o `year` da querystring (parametrizado, não concatenado)', (done) => {
      db.query.mockResolvedValueOnce({ rows: [] });
      request(app)
        .get(`/federation/${FED_ID}/financial/annuities/summary?year=2031`)
        .set('Authorization', 'Bearer ' + adminToken)
        .end((err) => {
          if (err) return done(err);
          const [sql, params] = db.query.mock.calls[0];
          expect(sql).toMatch(/h\.reference_period\s*=\s*\$2/);
          // $3 = dojoStatusValues (filtro companies.is_active do dojo,
          // default [true] — ver karateAnnuityService.js/dojoStatusToIsActiveValues).
          // $4 = memberStatusValues (customers.is_active do praticante),
          // mesmo default [true] — ver parseMemberStatus/memberStatusToIsActiveValues.
          expect(params).toEqual([FED_ID, '2031', [true], [true]]);
          done();
        });
    });
  });
});
