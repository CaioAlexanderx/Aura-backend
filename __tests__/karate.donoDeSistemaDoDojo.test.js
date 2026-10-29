// ============================================================
// AURA KARATÊ — dojô novo da federação só reusa dono de SISTEMA (tq-41c)
//
// Achado do tq-41b: em karateDojos.js (POST /federation/:id/dojos) e em
// karateImport.js (POST .../import/batch-fpkt) a consulta que reusa o dono de
// um dojô já existente da federação não filtrava usuário de sistema. Um dojô
// que se cadastrou sozinho tem dono real (o sensei), e o dojô novo podia
// nascer na conta dele.
//
// O fake abaixo responde pelo CONTEÚDO do SQL: a consulta do dono só devolve
// o sensei (dono real) se NÃO filtrar por senha travada; com o filtro, não
// há dono de sistema na federação e o código cai no usuário de sistema
// dedicado (achado/criado pelo e-mail padrão).
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const FED_ID = 'fed-uuid-tq41c';
const SENSEI_REAL = 'user-sensei-real';
const SISTEMA = 'user-sistema-dojos';

const adminToken = jwt.sign(
  { id: 'user-admin-001', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

let inserts;
function fakeClient() {
  inserts = [];
  return {
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
      if (/pg_advisory_xact_lock/.test(s)) return { rows: [] };
      if (/karate_affiliation_prefix/.test(s)) return { rows: [{ prefix: 'FPKT', slug: 'fpkt', name: 'FPKT' }] };
      if (/vertical = 'karate_federation'/.test(s)) return { rows: [{ id: FED_ID }] };
      // A consulta do dono reaproveitado.
      if (/SELECT c\.owner_id FROM companies c/.test(s)) {
        return /password_hash = '!locked-system-no-login'/.test(s) ? { rows: [] } : { rows: [{ owner_id: SENSEI_REAL }] };
      }
      if (/SELECT owner_id FROM companies/.test(s)) return { rows: [{ owner_id: SENSEI_REAL }] }; // forma antiga
      if (/SELECT id FROM users WHERE email/.test(s)) return { rows: [{ id: SISTEMA }] };
      if (/INSERT INTO companies/i.test(s)) {
        inserts.push(params);
        return { rows: [{ id: 'dojo-novo', name: 'Dojo Novo', fpkt_affiliation_id: null }] };
      }
      return { rows: [] };
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  db.connect.mockReset();
  db.connect.mockImplementation(async () => fakeClient());
});

describe('POST /federation/:id/dojos — dono do dojô novo', () => {
  it('não herda o sensei de outro dojô: o dono é o usuário de sistema', async () => {
    const app = express();
    app.use(express.json());
    app.use('/federation/:id/dojos', require('../src/routes/karateDojos'));

    const res = await request(app)
      .post('/federation/' + FED_ID + '/dojos')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Dojô Novo', affiliation_model: 'annual' });

    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain(SISTEMA);
    expect(inserts[0]).not.toContain(SENSEI_REAL);
  });
});

describe('POST /federation/:id/practitioners/import/batch-fpkt — dono do dojô novo', () => {
  it('não herda o sensei de outro dojô: o dono é o usuário de sistema', async () => {
    const app = express();
    app.use(express.json());
    app.use('/federation/:id/practitioners/import', require('../src/routes/karateImport'));

    const res = await request(app)
      .post('/federation/' + FED_ID + '/practitioners/import/batch-fpkt')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ dojos: [{ name: 'Dojô Novo', cod: '12', status: 'active' }] });

    expect(res.status).toBeLessThan(300);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain(SISTEMA);
    expect(inserts[0]).not.toContain(SENSEI_REAL);
  });
});
