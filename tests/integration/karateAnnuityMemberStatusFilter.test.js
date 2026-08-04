// ============================================================
// AURA KARATÊ — Testes: filtro member_status (ativo/inativo do PRATICANTE)
//
// Espelha tests/integration/karateAnnuityDojoStatusFilter.test.js, mas
// para o lado CPF: GET /annuities/cpf e o segmento `praticante` de
// GET /annuities/summary. Antes deste PR, cpfBaseSql/CPF_LEGACY_BASE_SQL
// filtravam `COALESCE(cu.is_active, true)` de forma FIXA (sem toggle) —
// agora aceitam o mesmo leque active|inactive|all do dojo_status, sempre
// preservando `cb.belt_level = 'preta'` (que NUNCA é afrouxado por este
// parâmetro — só o is_active é opcional).
//
// Numeração posicional (CLAUDE.md): memberStatusValues vai no FIM dos
// arrays de params — $5 no COUNT (4 params antes: fed/year/search/status),
// $7 no SELECT (6 params antes: + pageSize/offset). $1..$6 do SELECT e
// $1..$4 do COUNT continuam intocados — é isso que o teste de paginação
// legado (__tests__/karate.annuityF2Pagination.test.js) verifica.
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const financialBase = `/api/v1/federation/${fedId}/financial`;

const authHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client' }, SECRET, { expiresIn: '1h' })}`,
});

function mockCompanyAccess() {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
}

afterEach(() => {
  db.query.mockReset();
});

describe('GET /annuities/cpf — member_status', () => {
  test('default (sem member_status na query): filtra customers.is_active = [true] no $5(COUNT)/$7(SELECT)', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }) // COUNT
      .mockResolvedValueOnce({ rows: [] });             // SELECT

    const res = await request(app)
      .get(`${financialBase}/annuities/cpf`)
      .set(authHeader());

    expect(res.status).toBe(200);
    const countParams = db.query.mock.calls[1][1];
    const selectParams = db.query.mock.calls[2][1];
    // COUNT: [federationId, year, search, statusValues, memberStatusValues]
    expect(countParams[4]).toEqual([true]);
    // SELECT: [federationId, year, search, statusValues, pageSize, offset, memberStatusValues]
    expect(selectParams[6]).toEqual([true]);
  });

  test('member_status=inactive: filtra customers.is_active = [false]', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`${financialBase}/annuities/cpf`)
      .query({ member_status: 'inactive' })
      .set(authHeader());

    expect(res.status).toBe(200);
    const countParams = db.query.mock.calls[1][1];
    const selectParams = db.query.mock.calls[2][1];
    expect(countParams[4]).toEqual([false]);
    expect(selectParams[6]).toEqual([false]);
  });

  test('member_status=all: sem filtro de is_active (memberStatusValues = null)', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`${financialBase}/annuities/cpf`)
      .query({ member_status: 'all' })
      .set(authHeader());

    expect(res.status).toBe(200);
    const countParams = db.query.mock.calls[1][1];
    const selectParams = db.query.mock.calls[2][1];
    expect(countParams[4]).toBeNull();
    expect(selectParams[6]).toBeNull();
  });

  test('member_status inválido -> 400 VALIDATION_ERROR, nunca chega ao banco', async () => {
    mockCompanyAccess();

    const res = await request(app)
      .get(`${financialBase}/annuities/cpf`)
      .query({ member_status: 'bogus' })
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // só o role check rodou -- nenhuma query de listagem foi disparada
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('numeração posicional: $1..$6 do SELECT continuam intocados com member_status=all (memberStatusValues vira $7)', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get(`${financialBase}/annuities/cpf`)
      .query({ page: 2, pageSize: 10, q: 'silva', member_status: 'all' })
      .set(authHeader());

    const selectSql = db.query.mock.calls[2][0];
    const selectParams = db.query.mock.calls[2][1];
    expect(selectSql).toMatch(/LIMIT \$5 OFFSET \$6/);
    expect(selectParams[0]).toBe(fedId);
    expect(selectParams[2]).toBe('silva'); // search continua em $3
    expect(selectParams[4]).toBe(10);      // pageSize continua em $5
    expect(selectParams[5]).toBe(10);      // offset = (page-1)*pageSize continua em $6
    expect(selectParams[6]).toBeNull();    // memberStatusValues (all) no fim, $7
  });

  test('belt_level=preta continua FIXO em todos os caminhos (COUNT+SELECT), independente de member_status=all', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get(`${financialBase}/annuities/cpf`)
      .query({ member_status: 'all' })
      .set(authHeader());

    const countSql = db.query.mock.calls[1][0];
    const selectSql = db.query.mock.calls[2][0];
    for (const sql of [countSql, selectSql]) {
      expect(sql).toMatch(/belt_level\s*=\s*'preta'/);
      expect(sql).toMatch(/is_active/);
    }
  });

  // Mesmo fix precisa valer no fallback legado (migration 222 ausente).
  test('fallback legado (42703): member_status também é respeitado e belt_level=preta continua fixo', async () => {
    let isolatedApp, isolatedDb;
    jest.isolateModules(() => {
      isolatedDb = require('../../src/config/database');
      isolatedApp = require('../../src/index').app;
    });

    isolatedDb.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
    const err = new Error('column h.plan does not exist');
    err.code = '42703';
    isolatedDb.query
      .mockRejectedValueOnce(err)                        // COUNT com h.plan falha
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })    // COUNT fallback legado
      .mockResolvedValueOnce({ rows: [] });                // SELECT fallback legado

    const res = await request(isolatedApp)
      .get(`${financialBase}/annuities/cpf`)
      .query({ member_status: 'inactive' })
      .set(authHeader());

    expect(res.status).toBe(200);
    const legacyCountSql = isolatedDb.query.mock.calls[2][0];
    const legacyCountParams = isolatedDb.query.mock.calls[2][1];
    const legacySelectSql = isolatedDb.query.mock.calls[3][0];
    const legacySelectParams = isolatedDb.query.mock.calls[3][1];
    for (const sql of [legacyCountSql, legacySelectSql]) {
      expect(sql).toMatch(/belt_level\s*=\s*'preta'/);
      expect(sql).toMatch(/is_active/);
    }
    expect(legacyCountParams[4]).toEqual([false]);
    expect(legacySelectParams[6]).toEqual([false]);
    isolatedDb.query.mockReset();
  });
});

describe('GET /annuities/summary — member_status (segmento praticante)', () => {
  function summaryRows({ dojo, praticante, total } = {}) {
    const zero = { previsto_count: 0, previsto_valor: 0, recebido_count: 0, recebido_valor: 0, em_aberto_count: 0, em_aberto_valor: 0, atrasado_count: 0, atrasado_valor: 0 };
    return [
      { kind: 'dojo', ...zero, ...dojo },
      { kind: 'praticante', ...zero, ...praticante },
      { kind: null, ...zero, ...total },
    ];
  }

  test('default: memberStatusValues=[true] chega no $4 do SUMMARY_SQL', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({ rows: summaryRows() });

    const res = await request(app)
      .get(`${financialBase}/annuities/summary`)
      .set(authHeader());

    expect(res.status).toBe(200);
    const summaryParams = db.query.mock.calls[1][1];
    expect(summaryParams).toEqual([fedId, expect.any(String), [true], [true]]);
  });

  test('member_status=all: $4 = null (praticante inativo entra no cálculo, mas belt_level continua exigido)', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({ rows: summaryRows() });

    await request(app)
      .get(`${financialBase}/annuities/summary`)
      .query({ member_status: 'all' })
      .set(authHeader());

    const summarySql = db.query.mock.calls[1][0];
    const summaryParams = db.query.mock.calls[1][1];
    expect(summaryParams[3]).toBeNull();
    expect(summarySql).toMatch(/cb\.belt_level\s*=\s*'preta'/);
  });

  test('member_status inválido -> 400, nunca chega ao banco', async () => {
    mockCompanyAccess();

    const res = await request(app)
      .get(`${financialBase}/annuities/summary`)
      .query({ member_status: 'nope' })
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

// ── Consistência lista × summary ────────────────────────────────────
describe('member_status — consistência lista × summary (mesmo universo)', () => {
  test('mesmo member_status produz o MESMO array de is_active em ambas as rotas (via helper compartilhado)', () => {
    const annuitySvc = require('../../src/services/karateAnnuityService');
    for (const raw of ['active', 'inactive', 'all', undefined]) {
      const parsed = annuitySvc.parseMemberStatus(raw);
      const valuesA = annuitySvc.memberStatusToIsActiveValues(parsed);
      const valuesB = annuitySvc.memberStatusToIsActiveValues(annuitySvc.parseMemberStatus(raw));
      expect(valuesA).toEqual(valuesB);
    }
    expect(annuitySvc.memberStatusToIsActiveValues('active')).toEqual([true]);
    expect(annuitySvc.memberStatusToIsActiveValues('inactive')).toEqual([false]);
    expect(annuitySvc.memberStatusToIsActiveValues('all')).toBeNull();
  });

  test('lista e summary, sem member_status explícito, mandam ambos [true] pro banco (mesmo default)', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    await request(app).get(`${financialBase}/annuities/cpf`).set(authHeader());
    const cpfParams = db.query.mock.calls[2][1]; // SELECT params

    db.query.mockReset();
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({ rows: [] });
    await request(app).get(`${financialBase}/annuities/summary`).set(authHeader());
    const summaryParams = db.query.mock.calls[1][1];

    expect(cpfParams[6]).toEqual(summaryParams[3]);
    expect(cpfParams[6]).toEqual([true]);
  });
});
