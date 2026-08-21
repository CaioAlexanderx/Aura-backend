// ============================================================
// AURA KARATÊ — P1-3: ARBITRAGEM + TERMO DE RESPONSABILIDADE
//
// Cobertura:
//   (1) cadastro: cria árbitro com credencial válida; credencial fora de
//       A-D → 422; DELETE é DESATIVAÇÃO (soft), nunca apaga.
//   (2) convocação em lote: só oficiais DESTA federação entram; quem não
//       é da federação vira skipped; reconvocar é no-op (already).
//   (3) escala: confirmar carimba confirmed_at; escalar em área valida
//       que a área é da competição (404 se não for); marcar ausência com
//       multa grava penalty_amount.
//   (4) status inválido → 422 sem tocar o banco.
//   (5) termo: PATCH waiver-terms valida shape; POST waiver exige atleta
//       INSCRITO (404 se não estiver) e é idempotente (ON CONFLICT).
//   (6) GET waivers: status por atleta com contadores accepted/pending.
//   (7) 42P01 (migração 298 pendente): GET degrada, escrita → 503.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

const FED_ID = 'fed-uuid-p13';
const COMP_ID = 'comp-uuid-p13';
const AREA_A = 'area-a-uuid-p13';
const OFF_1 = 'off-1-uuid';
const OFF_2 = 'off-2-uuid';
const ROW_1 = 'row-1-uuid';
const PRAC_1 = 'prac-1-uuid';
const PRAC_2 = 'prac-2-uuid';

const adminToken = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateOfficials'));
  return app;
}

const compRow = { id: COMP_ID, status: 'open', waiver_required: true, waiver_terms: { version: 'v1', title: 'Termo 2026', body: 'texto' } };

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ── (1) cadastro ────────────────────────────────────────────
describe('cadastro de oficiais', () => {
  it('(1) cria árbitro com credencial; credencial inválida → 422; DELETE desativa', async () => {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/INSERT INTO karate_officials/i.test(s)) {
        return Promise.resolve({ rows: [{
          id: OFF_1, name: params[2], role: params[5], credential: params[6], active: true,
          practitioner_id: null, dojo_id: null, dojo_name: params[4], credential_note: null, email: null, phone: null,
        }] });
      }
      if (/UPDATE karate_officials SET active = false/i.test(s)) {
        return Promise.resolve({ rows: [{ id: OFF_1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const ok = await request(buildApp())
      .post(`/federation/${FED_ID}/officials`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Roberto A. Batista Jr', dojo_name: 'Shugyokan Bauru', role: 'arbitro', credential: 'A' });
    expect(ok.status).toBe(201);
    expect(ok.body.credential).toBe('A');

    const bad = await request(buildApp())
      .post(`/federation/${FED_ID}/officials`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'X', credential: 'Z' });
    expect(bad.status).toBe(422);

    const del = await request(buildApp())
      .delete(`/federation/${FED_ID}/officials/${OFF_1}`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(del.status).toBe(200);
    expect(del.body.deactivated).toBe(true);
    const sqls = db.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /DELETE FROM karate_officials/i.test(s))).toBe(false); // nunca apaga
  });
});

// ── (2) convocação ──────────────────────────────────────────
describe('convocação em lote', () => {
  it('(2) só oficiais da federação entram; fora vira skipped; repetido é no-op', async () => {
    const inserted = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/FROM karate_competitions WHERE id/i.test(s)) return Promise.resolve({ rows: [compRow] });
      if (/SELECT id FROM karate_officials WHERE federation_id/i.test(s)) {
        // OFF_2 não é desta federação.
        return Promise.resolve({ rows: [{ id: OFF_1 }] });
      }
      if (/INSERT INTO karate_competition_officials/i.test(s)) {
        // Primeiro insert cria; segundo (mesmo oficial) devolve vazio (ON CONFLICT).
        const first = !inserted.includes(params[1]);
        inserted.push(params[1]);
        return Promise.resolve({ rows: first ? [{ id: ROW_1 }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/officials`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ official_ids: [OFF_1, OFF_2] });

    expect(res.status).toBe(201);
    expect(res.body.summoned).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].official_id).toBe(OFF_2);

    // Reconvocar o mesmo → already, sem novo summoned.
    const again = await request(buildApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/officials`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ official_ids: [OFF_1] });
    expect(again.body.summoned).toBe(0);
    expect(again.body.already).toBe(1);
  });
});

// ── (3)(4) escala ───────────────────────────────────────────
describe('escala do evento', () => {
  function mockEscala({ areaBelongs = true } = {}) {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/FROM karate_competitions WHERE id/i.test(s)) return Promise.resolve({ rows: [compRow] });
      if (/SELECT id FROM karate_competition_areas/i.test(s)) {
        return Promise.resolve({ rows: areaBelongs ? [{ id: AREA_A }] : [] });
      }
      if (/UPDATE karate_competition_officials/i.test(s)) {
        return Promise.resolve({ rows: [{
          id: ROW_1, official_id: OFF_1, area_id: AREA_A, status: 'confirmed',
          is_chief: true, sort_order: 0, penalty_amount: null, penalty_note: null,
          notes: null, confirmed_at: '2026-08-20T12:00:00Z',
        }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('(3) confirmar carimba confirmed_at; escalar valida a área; ausência grava multa', async () => {
    mockEscala({});
    const confirm = await request(buildApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/officials/${ROW_1}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ status: 'confirmed', area_id: AREA_A, is_chief: true });
    expect(confirm.status).toBe(200);
    expect(confirm.body.confirmed_at).toBeTruthy();
    const upd = db.query.mock.calls.find((c) => /UPDATE karate_competition_officials/i.test(String(c[0])));
    expect(String(upd[0])).toMatch(/COALESCE\(confirmed_at, NOW\(\)\)/);

    // Área de outra competição → 404
    mockEscala({ areaBelongs: false });
    const badArea = await request(buildApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/officials/${ROW_1}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ area_id: 'area-de-outro-evento' });
    expect(badArea.status).toBe(404);

    // Ausência com multa (R$100 do regulamento JKA)
    mockEscala({});
    const absent = await request(buildApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/officials/${ROW_1}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ status: 'absent', penalty_amount: 100, penalty_note: 'Ausência não justificada' });
    expect(absent.status).toBe(200);
    // O SET (não o RETURNING) precisa carregar penalty_amount com o valor.
    const penaltyCall = db.query.mock.calls.find((c) =>
      /UPDATE karate_competition_officials SET[\s\S]*penalty_amount = \$/.test(String(c[0])));
    expect(penaltyCall).toBeTruthy();
    expect(penaltyCall[1]).toContain(100);
    expect(penaltyCall[1]).toContain('absent');
  });

  it('(4) status inválido → 422 sem tocar o banco', async () => {
    const res = await request(buildApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/officials/${ROW_1}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ status: 'sumiu' });
    expect(res.status).toBe(422);
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ── (5)(6) termo ────────────────────────────────────────────
describe('termo de responsabilidade', () => {
  it('(5) waiver-terms valida shape; aceite exige atleta inscrito', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/UPDATE karate_competitions/i.test(s)) {
        return Promise.resolve({ rows: [{ id: COMP_ID, waiver_terms: { version: 'v1' }, waiver_required: true }] });
      }
      if (/FROM karate_competitions WHERE id/i.test(s)) return Promise.resolve({ rows: [compRow] });
      if (/FROM karate_competition_entries/i.test(s)) return Promise.resolve({ rows: [] }); // NÃO inscrito
      return Promise.resolve({ rows: [] });
    });

    const badTerms = await request(buildApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/waiver-terms`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ waiver_terms: 'texto solto' });
    expect(badTerms.status).toBe(422);

    const okTerms = await request(buildApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/waiver-terms`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ waiver_terms: { version: 'v1', title: 'Termo 2026', body: 'Declaro...' }, waiver_required: true });
    expect(okTerms.status).toBe(200);
    expect(okTerms.body.waiver_required).toBe(true);

    const notEnrolled = await request(buildApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/waivers`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ practitioner_id: PRAC_1, accepted_by_name: 'Mãe do atleta', accepted_by_role: 'guardian' });
    expect(notEnrolled.status).toBe(404);
  });

  it('(5b) aceite de atleta inscrito grava snapshot e é idempotente (upsert)', async () => {
    let insertSql = null;
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/FROM karate_competitions WHERE id/i.test(s)) return Promise.resolve({ rows: [compRow] });
      if (/SELECT 1 FROM karate_competition_entries/i.test(s)) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      if (/SELECT dojo_id FROM karate_competition_entries/i.test(s)) return Promise.resolve({ rows: [{ dojo_id: 'dojo-1' }] });
      if (/INSERT INTO karate_competition_waivers/i.test(s)) {
        insertSql = s;
        return Promise.resolve({ rows: [{
          id: 'waiver-1', practitioner_id: PRAC_1, accepted_by_role: params[4],
          accepted_by_name: params[5], modalities: params[7], image_consent: params[9],
          accepted_at: '2026-08-20T12:00:00Z',
        }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/waivers`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        practitioner_id: PRAC_1, accepted_by_role: 'guardian', accepted_by_name: 'Responsável',
        accepted_by_doc: '12.345.678-9', modalities: ['kata', 'kumite'], image_consent: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.accepted_by_role).toBe('guardian');
    expect(res.body.modalities).toEqual(['kata', 'kumite']);
    expect(insertSql).toMatch(/ON CONFLICT \(competition_id, practitioner_id\) DO UPDATE/);
    // Snapshot do termo vigente entra no INSERT.
    const insertCall = db.query.mock.calls.find((c) => /INSERT INTO karate_competition_waivers/i.test(String(c[0])));
    expect(JSON.parse(insertCall[1][8])).toEqual(compRow.waiver_terms);
  });

  it('(6) GET waivers devolve status por atleta com contadores', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM karate_competitions WHERE id/i.test(s)) return Promise.resolve({ rows: [compRow] });
      if (/FROM karate_competition_entries e/i.test(s)) {
        return Promise.resolve({ rows: [
          { practitioner_id: PRAC_1, practitioner_name: 'Atleta A', dojo_id: 'd1', dojo_name: 'Kondei',
            waiver_id: 'w1', accepted_at: '2026-08-19T10:00:00Z', accepted_by_role: 'guardian',
            accepted_by_name: 'Mãe', modalities: ['kata'], image_consent: true },
          { practitioner_id: PRAC_2, practitioner_name: 'Atleta B', dojo_id: 'd1', dojo_name: 'Kondei',
            waiver_id: null, accepted_at: null, accepted_by_role: null, accepted_by_name: null,
            modalities: null, image_consent: null },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/competitions/${COMP_ID}/waivers`)
      .set('Authorization', 'Bearer ' + adminToken);

    expect(res.status).toBe(200);
    expect(res.body.required).toBe(true);
    expect(res.body.total).toBe(2);
    expect(res.body.accepted).toBe(1);
    expect(res.body.pending).toBe(1);
    expect(res.body.items[0].accepted).toBe(true);
    expect(res.body.items[1].accepted).toBe(false);
  });
});

// ── (7) migração pendente ───────────────────────────────────
describe('migração 298 pendente', () => {
  it('(7) GET degrada (lista vazia) e escrita devolve 503 SCHEMA_PENDING', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM karate_competitions WHERE id/i.test(s)) return Promise.resolve({ rows: [compRow] });
      const e = new Error('relation does not exist'); e.code = '42P01';
      return Promise.reject(e);
    });

    const list = await request(buildApp())
      .get(`/federation/${FED_ID}/officials`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);

    const create = await request(buildApp())
      .post(`/federation/${FED_ID}/officials`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Novo Árbitro' });
    expect(create.status).toBe(503);
    expect(create.body.code).toBe('SCHEMA_PENDING');

    const waivers = await request(buildApp())
      .get(`/federation/${FED_ID}/competitions/${COMP_ID}/waivers`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(waivers.status).toBe(200);
    expect(waivers.body.schema_pending).toBe(true);
  });
});
