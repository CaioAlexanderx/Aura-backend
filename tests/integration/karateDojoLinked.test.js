// ============================================================
// AURA DOJÔ — Testes Integração: visibilidade do dojô para a federação
// (karate_dojo_linked_at — fix "dojô só aparece após conexão/filiação")
//
// Modelo: federation_id é vínculo TÉCNICO (roteamento/guard); a
// VISIBILIDADE para a federação nasce só com a conexão aceita e é marcada
// por companies.karate_dojo_linked_at (NULL = self-serve, invisível).
//
// Como o database é 100% mockado (tests/integration/setup.js), o WHERE não
// é executado de fato — então validamos o CONTRATO no ponto de query:
// as superfícies da federação (listagem, cobrança por dojô, campanha de
// anuidade) DEVEM conter `karate_dojo_linked_at IS NOT NULL`; o deep-link
// por id (GET /dojos/:dojoId) NÃO deve filtrar (dojô continua acessível
// direto). Token role:'admin' (plataforma) faz requireCompanyAccess passar
// SEM SELECT de papel, então as únicas db.query são as do handler.
//
// db.query.mockReset() em afterEach (jest.clearAllMocks NÃO drena filas).
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
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const LINKED = "karate_dojo_linked_at IS NOT NULL";

const adminHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'admin' }, SECRET, { expiresIn: '1h' })}`,
});

const sqls = () => db.query.mock.calls.map((c) => String(c[0]));

afterEach(() => {
  db.query.mockReset();
});

describe('Aura Dojô — dojô só aparece para a federação após conexão (karate_dojo_linked_at)', () => {
  test('sem token → 401', async () => {
    const res = await request(app).get(`/api/v1/federation/${fedId}/dojos`);
    expect(res.status).toBe(401);
  });

  test('GET /dojos (lista da federação) filtra por karate_dojo_linked_at IS NOT NULL', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: '0' }] }) // COUNT
      .mockResolvedValueOnce({ rows: [] });               // data
    const res = await request(app)
      .get(`/api/v1/federation/${fedId}/dojos`)
      .set(adminHeader());

    expect(res.status).toBe(200);
    const listSql = sqls().find(
      (s) => /FROM companies c/.test(s) && /vertical_active = 'karate_dojo'/.test(s)
    );
    expect(listSql).toBeDefined();
    expect(listSql).toContain(LINKED);
  });

  test('GET /dojos/:dojoId (deep-link) NÃO filtra — dojô acessível por id direto', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // lookup vazio → 404
    const res = await request(app)
      .get(`/api/v1/federation/${fedId}/dojos/${dojoId}`)
      .set(adminHeader());

    expect(res.status).toBe(404);
    const lookupSql = sqls().find(
      (s) => /c\.id = \$1 AND c\.federation_id = \$2 AND c\.vertical = 'karate_dojo'/.test(s)
    );
    expect(lookupSql).toBeDefined();
    expect(lookupSql).not.toContain('karate_dojo_linked_at');
  });

  test('GET /financial/annuities/dojos (cobrança por dojô) exclui unlinked', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }) // COUNT
      .mockResolvedValueOnce({ rows: [] });             // data
    const res = await request(app)
      .get(`/api/v1/federation/${fedId}/financial/annuities/dojos`)
      .set(adminHeader());

    expect(res.status).toBe(200);
    const sql = sqls().find(
      (s) => /karate_dojo_annuity_history/.test(s) && /vertical_active = 'karate_dojo'/.test(s)
    );
    expect(sql).toBeDefined();
    expect(sql).toContain(LINKED);
  });

  test('campanha de anuidade (preview) não elege dojô unlinked', async () => {
    // eligible vazio + getVigentFee null — só nos importa a SQL de elegibilidade
    db.query.mockResolvedValue({ rows: [] });
    await request(app)
      .post(`/api/v1/federation/${fedId}/financial/annuities/campaign/preview`)
      .set(adminHeader())
      .send({ year: '2026', scope: 'dojos' });

    const eligSql = sqls().find(
      (s) => /NOT EXISTS/.test(s) && /c\.vertical_active = 'karate_dojo'/.test(s)
    );
    expect(eligSql).toBeDefined();
    expect(eligSql).toContain(LINKED);
  });
});
