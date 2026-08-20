// ============================================================
// AURA KARATÊ — Follow-up QA Onda 1 (migration 293): VOID + auditoria
// de correção de transferências (karateTransfers.js).
//
// Cobertura:
//   (1) GET lista só transferências ATIVAS (WHERE ... voided_at IS NULL),
//       escopado por praticante + federação.
//   (2) DELETE vira VOID: faz UPDATE SET voided_at (NUNCA DELETE FROM),
//       preserva a linha, grava auditoria action='void', escopo mantido.
//   (3) Guard EXPLAINS_CURRENT_DOJO: anular/editar o registro que explica o
//       dojô atual exige ?confirm=true (409 sem ele; passa com ele).
//   (4) PATCH auditado: grava before/after em
//       karate_practitioner_transfer_audit, na MESMA transação.
//   (5) VOID e PATCH ligam o escape hatch (SET LOCAL app.allow_transfer_purge)
//       — sem ele a trigger de imutabilidade da 180 barraria o UPDATE.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/karateMailer', () => ({ sendKarateEmail: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');

const adminToken = jwt.sign(
  { id: 'user-actor-uuid', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

const FED_ID = 'fed-uuid-293';
const PRAC_ID = 'prac-uuid-293';
const TRANSFER_ID = 'transfer-uuid-293';
const DEST_DOJO = 'dojo-dest-293';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateTransfers'));
  return app;
}

const base = `/federation/${FED_ID}/practitioners/${PRAC_ID}/transfers`;

// Client transacional fake keyed on SQL — evita depender da ordem exata das
// queries. `opts.currentDojo` controla o customers.dojo_id (guard); `opts.latestId`
// controla qual é a transferência ativa mais recente.
function makeClient(opts = {}) {
  const currentDojo = opts.currentDojo !== undefined ? opts.currentDojo : 'dojo-outro';
  const latestId = opts.latestId !== undefined ? opts.latestId : 'transfer-outro';
  const curRow = {
    id: TRANSFER_ID,
    practitioner_id: PRAC_ID,
    origin_dojo_id: 'dojo-origem',
    destination_dojo_id: DEST_DOJO,
    origin_dojo_name: 'Dojô Origem',
    destination_dojo_name: 'Dojô Destino',
    reason: 'motivo antigo',
    transferred_at: '2026-01-10',
    created_at: '2026-01-10T00:00:00.000Z',
  };
  const query = jest.fn((sql) => {
    const s = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({});
    if (/SET LOCAL/i.test(s)) return Promise.resolve({});
    if (/FOR UPDATE/i.test(s)) return Promise.resolve({ rows: [curRow] });
    if (/FROM customers/i.test(s)) return Promise.resolve({ rows: [{ dojo_id: currentDojo }] });
    if (/LIMIT 1/i.test(s) && /karate_practitioner_transfers/i.test(s)) return Promise.resolve({ rows: latestId ? [{ id: latestId }] : [] });
    if (/UPDATE karate_practitioner_transfers/i.test(s)) {
      return Promise.resolve({ rows: [{ ...curRow, reason: 'motivo novo', voided_at: '2026-08-20T12:00:00.000Z' }] });
    }
    if (/FROM users/i.test(s)) return Promise.resolve({ rows: [{ full_name: 'Caio', email: 'caio@x' }] });
    if (/INSERT INTO karate_practitioner_transfer_audit/i.test(s)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ── (1) GET só lista ativas, escopado ───────────────────────
describe('GET transfers — filtra voided_at IS NULL, escopo praticante+federação', () => {
  it('a query de listagem inclui voided_at IS NULL e escopa por praticante e federação', (done) => {
    db.query.mockResolvedValue({ rows: [] });
    request(buildApp())
      .get(base)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/voided_at IS NULL/);
        expect(sql).toMatch(/t\.practitioner_id = \$1 AND t\.federation_id = \$2/);
        expect(params).toEqual([PRAC_ID, FED_ID]);
        done();
      });
  });
});

// ── (2) DELETE vira VOID (não apaga) + auditoria ────────────
describe('DELETE transfers/:id — VOID (soft-delete) preserva a linha e audita', () => {
  it('faz UPDATE SET voided_at, NUNCA DELETE FROM, grava auditoria action=void, escopo mantido', (done) => {
    const client = makeClient(); // não é o registro que explica o dojô atual
    db.connect.mockResolvedValue(client);

    request(buildApp())
      .delete(`${base}/${TRANSFER_ID}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ reason: 'lançamento em duplicidade' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.voided).toBe(true);
        expect(res.body.id).toBe(TRANSFER_ID);

        const sqls = client.query.mock.calls.map((c) => String(c[0]));
        // Nunca apaga a linha.
        expect(sqls.some((s) => /DELETE\s+FROM\s+karate_practitioner_transfers/i.test(s))).toBe(false);
        // Marca o void.
        const voidCall = client.query.mock.calls.find((c) => /UPDATE karate_practitioner_transfers[\s\S]*voided_at\s*=\s*NOW\(\)/i.test(String(c[0])));
        expect(voidCall).toBeTruthy();
        // Escopo: id + practitioner_id + federation_id nos params do UPDATE.
        expect(voidCall[1].slice(0, 3)).toEqual([TRANSFER_ID, PRAC_ID, FED_ID]);
        // Auditoria action='void'.
        const auditCall = client.query.mock.calls.find((c) => /INSERT INTO karate_practitioner_transfer_audit/i.test(String(c[0])));
        expect(auditCall).toBeTruthy();
        expect(auditCall[1][3]).toBe('void');       // action
        expect(auditCall[1][1]).toBe(FED_ID);       // federation_id
        expect(auditCall[1][2]).toBe(PRAC_ID);      // practitioner_id
        // Escape hatch ligado.
        expect(sqls.some((s) => /SET LOCAL app\.allow_transfer_purge/i.test(s))).toBe(true);
        done();
      });
  });

  it('registro inexistente/ativo ausente → 404 (não escreve)', (done) => {
    const client = makeClient();
    client.query = jest.fn((sql) => {
      const s = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({});
      if (/FOR UPDATE/i.test(s)) return Promise.resolve({ rows: [] }); // não achou ativo
      return Promise.resolve({ rows: [] });
    });
    db.connect.mockResolvedValue(client);

    request(buildApp())
      .delete(`${base}/${TRANSFER_ID}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(404);
        const sqls = client.query.mock.calls.map((c) => String(c[0]));
        expect(sqls.some((s) => /UPDATE karate_practitioner_transfers/i.test(s))).toBe(false);
        expect(sqls.some((s) => /INSERT INTO karate_practitioner_transfer_audit/i.test(s))).toBe(false);
        done();
      });
  });
});

// ── (3) Guard EXPLAINS_CURRENT_DOJO ─────────────────────────
describe('Guard — anular o registro que explica o dojô atual exige ?confirm=true', () => {
  it('sem confirm → 409 EXPLAINS_CURRENT_DOJO e ROLLBACK (não escreve)', (done) => {
    // É o registro explicativo: dojô atual == destino E é a transferência mais recente.
    const client = makeClient({ currentDojo: DEST_DOJO, latestId: TRANSFER_ID });
    db.connect.mockResolvedValue(client);

    request(buildApp())
      .delete(`${base}/${TRANSFER_ID}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('EXPLAINS_CURRENT_DOJO');
        const sqls = client.query.mock.calls.map((c) => String(c[0]));
        expect(sqls.some((s) => /UPDATE karate_practitioner_transfers/i.test(s))).toBe(false);
        done();
      });
  });

  it('com ?confirm=true → prossegue e anula', (done) => {
    const client = makeClient({ currentDojo: DEST_DOJO, latestId: TRANSFER_ID });
    db.connect.mockResolvedValue(client);

    request(buildApp())
      .delete(`${base}/${TRANSFER_ID}?confirm=true`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.voided).toBe(true);
        const sqls = client.query.mock.calls.map((c) => String(c[0]));
        expect(sqls.some((s) => /UPDATE karate_practitioner_transfers[\s\S]*voided_at/i.test(s))).toBe(true);
        done();
      });
  });
});

// ── (4) PATCH auditado (before/after) ───────────────────────
describe('PATCH transfers/:id — corrige metadados e grava trilha de auditoria', () => {
  it('atualiza + grava auditoria action=patch com before/after e liga o escape hatch', (done) => {
    const client = makeClient(); // não explicativo
    db.connect.mockResolvedValue(client);

    request(buildApp())
      .patch(`${base}/${TRANSFER_ID}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ reason: 'motivo novo' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.reason).toBe('motivo novo');

        const sqls = client.query.mock.calls.map((c) => String(c[0]));
        expect(sqls.some((s) => /SET LOCAL app\.allow_transfer_purge/i.test(s))).toBe(true);

        const auditCall = client.query.mock.calls.find((c) => /INSERT INTO karate_practitioner_transfer_audit/i.test(String(c[0])));
        expect(auditCall).toBeTruthy();
        const p = auditCall[1];
        expect(p[3]).toBe('patch');                          // action
        const before = JSON.parse(p[6]);
        const after = JSON.parse(p[7]);
        expect(before).toEqual({ reason: 'motivo antigo' }); // só o campo editado
        expect(after).toEqual({ reason: 'motivo novo' });
        done();
      });
  });

  it('nenhum campo → 400 (não abre transação)', (done) => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    request(buildApp())
      .patch(`${base}/${TRANSFER_ID}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(400);
        done();
      });
  });

  it('transferred_at inválido → 422', (done) => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    request(buildApp())
      .patch(`${base}/${TRANSFER_ID}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ transferred_at: '10/01/2026' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ── (5) Schema pendente (migration 293) → 503 MIGRATION_PENDING ──
describe('VOID/PATCH — coluna/tabela da 293 ausente → 503 MIGRATION_PENDING', () => {
  it('VOID: 42703 na coluna voided_at → 503', (done) => {
    const client = {
      query: jest.fn((sql) => {
        const s = String(sql);
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({});
        if (/FOR UPDATE/i.test(s)) { const e = new Error('column "voided_at" does not exist'); e.code = '42703'; return Promise.reject(e); }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    db.connect.mockResolvedValue(client);
    request(buildApp())
      .delete(`${base}/${TRANSFER_ID}`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('MIGRATION_PENDING');
        done();
      });
  });
});
