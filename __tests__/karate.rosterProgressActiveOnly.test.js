// ============================================================
// AURA KARATÊ — GET /federation/:id/dojos/roster-progress
// Restrição a dojôs ATIVOS (default) + resumo agregado para os KPIs da
// aba "Atualização cadastral".
//
// Cobre:
//   1. Default (sem ?status) filtra por vertical_active = 'karate_dojo'
//      (NÃO `vertical`) + is_active IS NOT FALSE.
//   2. ?status=all remove o filtro de is_active (mantém vertical_active).
//   3. `summary` é derivado do MESMO array `data` (fonte única): contagens
//      de nao_abriram/em_andamento/validados + soma de sem_contato batem
//      com as linhas retornadas.
//   4. 42P01/42703 (schema pendente) devolve data:[] + summary zerado, sem
//      500.
//
// Estratégia: mock do db (jest.setup.js mocka src/config/database). Só uma
// query no handler (rows já vêm com status/last_accessed_at/contadores
// pré-calculados, como o SQL real devolveria).
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
  const router = require('../src/routes/karateRosterValidation');
  app.use('/federation/:id/dojos', router);
  return app;
}

describe('GET /federation/:id/dojos/roster-progress', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    db.query.mockReset();
  });

  it('default: filtra por vertical_active (não vertical) + is_active IS NOT FALSE', (done) => {
    db.query.mockResolvedValueOnce({ rows: [] });
    request(app)
      .get(`/federation/${FED_ID}/dojos/roster-progress`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toMatch(/vertical_active = 'karate_dojo'/);
        expect(sql).not.toMatch(/WHERE\s+vertical\s*=\s*'karate_dojo'/);
        expect(sql).toMatch(/is_active IS NOT FALSE/);
        expect(res.body.data).toEqual([]);
        expect(res.body.summary).toEqual({
          total_dojos: 0, nao_abriram: 0, em_andamento: 0, validados: 0, praticantes_sem_contato: 0,
        });
        done();
      });
  });

  it('?status=all remove o filtro de is_active (mantém vertical_active)', (done) => {
    db.query.mockResolvedValueOnce({ rows: [] });
    request(app)
      .get(`/federation/${FED_ID}/dojos/roster-progress?status=all`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toMatch(/vertical_active = 'karate_dojo'/);
        expect(sql).not.toMatch(/is_active IS NOT FALSE/);
        done();
      });
  });

  it('summary bate com as linhas de data (fonte única)', (done) => {
    db.query.mockResolvedValueOnce({
      rows: [
        { dojo_id: 'd1', dojo_nome: 'Dojô A', status: null, last_accessed_at: null, requested_at: null, validated_at: null, praticantes_sem_contato: 3, essenciais_faltando: 1, total_praticantes: 10 },
        { dojo_id: 'd2', dojo_nome: 'Dojô B', status: 'pending', last_accessed_at: '2026-07-10T00:00:00Z', requested_at: '2026-07-09T00:00:00Z', validated_at: null, praticantes_sem_contato: 2, essenciais_faltando: 0, total_praticantes: 5 },
        { dojo_id: 'd3', dojo_nome: 'Dojô C', status: 'validated', last_accessed_at: '2026-07-01T00:00:00Z', requested_at: '2026-06-30T00:00:00Z', validated_at: '2026-07-02T00:00:00Z', praticantes_sem_contato: 0, essenciais_faltando: 0, total_praticantes: 8 },
      ],
    });
    request(app)
      .get(`/federation/${FED_ID}/dojos/roster-progress`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(3);
        expect(res.body.data.map((r) => r.status)).toEqual(['nao_aberto', 'em_andamento', 'validado']);
        expect(res.body.summary).toEqual({
          total_dojos: 3, nao_abriram: 1, em_andamento: 1, validados: 1, praticantes_sem_contato: 5,
        });
        done();
      });
  });

  it('42P01 (schema pendente) devolve data:[] + summary zerado, sem 500', (done) => {
    const err42P01 = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    db.query.mockRejectedValueOnce(err42P01);
    request(app)
      .get(`/federation/${FED_ID}/dojos/roster-progress`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.summary).toEqual({
          total_dojos: 0, nao_abriram: 0, em_andamento: 0, validados: 0, praticantes_sem_contato: 0,
        });
        done();
      });
  });
});
