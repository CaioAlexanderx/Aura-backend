// ============================================================
// AURA. — Personalizados ligado so na conta de teste (p-188, 18/11/2026)
//
// A frente Personalizados segue atras da trava geral do app
// (PERSONALIZADOS_LIBERADO = false). A equipe liga a frente numa empresa de
// teste gravando, por SQL com audit_log:
//
//   companies.studio_settings.personalizados_teste = true
//
//   1. /auth/me: company.personalizados_teste so aparece quando true, na
//      mesma consulta da empresa (sem ida extra ao banco). Desligada,
//      ausente ou outro valor: o JSON do /me e o de sempre.
//   2. PATCH /studio/settings (o do lojista): a chave fica fora de
//      ALLOWED_STUDIO_SETTINGS, entao o lojista nao grava nem apaga.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const SECRET = 'aura-test-secret-2026';
const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();
const CID = 'b0000000-0000-4000-8000-0000000000c1';

let app;
let db;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
});

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// Linha da empresa como o SELECT do /me devolve. `extra` imita o que o
// Postgres calcula a partir de studio_settings.
function bancoDoMe(extra) {
  db.query.mockImplementation(async (sql) => {
    const s = limpo(sql);
    if (s.includes('FROM users WHERE id')) {
      return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@exemplo.com', role: 'client', email_verified: true }] };
    }
    if (s.includes('AS member_role')) {
      return {
        rows: [{
          id: CID, legal_name: 'Loja Teste', trade_name: 'Loja Teste', plan: 'expansao',
          module_overrides: {}, billing_status: null, vertical_active: null,
          member_role: 'owner', casa_negocio: false, ...extra,
        }],
      };
    }
    if (s.includes('COUNT(DISTINCT c.id)')) return { rows: [{ cnt: 1 }] };
    return { rows: [] };
  });
}

const me = () => request(app).post('/api/v1/auth/me')
  .set('Authorization', `Bearer ${jwt.sign({ id: 'u1', role: 'client', company: CID }, SECRET, { expiresIn: '1h' })}`);

// trial traz datas calculadas na hora; o resto do company e estavel.
const semTrial = (c) => {
  const { trial, ...resto } = c;
  return resto;
};

describe('1. /auth/me — personalizados_teste', () => {
  test('a consulta da empresa ja calcula a chave a partir de studio_settings', async () => {
    bancoDoMe({ personalizados_teste: false });
    await me();
    const q = db.query.mock.calls.find(([sql]) => limpo(sql).includes('AS member_role'));
    expect(limpo(q[0])).toContain(
      "(COALESCE(c.studio_settings->>'personalizados_teste', '') = 'true') AS personalizados_teste"
    );
  });

  test('ligada: company.personalizados_teste = true, sem consulta a mais', async () => {
    bancoDoMe({ personalizados_teste: false });
    await me();
    const consultasDesligada = db.query.mock.calls.length;

    db.query.mockReset();
    bancoDoMe({ personalizados_teste: true });
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.company.personalizados_teste).toBe(true);
    expect(db.query.mock.calls.length).toBe(consultasDesligada);
  });

  test('desligada ou ausente: o campo nao vem e o company e o de sempre', async () => {
    bancoDoMe({});
    const base = await me();
    expect(base.status).toBe(200);
    expect(base.body.company).not.toHaveProperty('personalizados_teste');

    for (const valor of [false, null, undefined, 'true', 1]) {
      db.query.mockReset();
      bancoDoMe({ personalizados_teste: valor });
      const res = await me();
      expect(res.status).toBe(200);
      expect(res.body.company).not.toHaveProperty('personalizados_teste');
      expect(semTrial(res.body.company)).toEqual(semTrial(base.body.company));
    }
  });

  test('ligada nao muda nenhum outro campo do company', async () => {
    bancoDoMe({ personalizados_teste: false });
    const desligada = await me();
    db.query.mockReset();
    bancoDoMe({ personalizados_teste: true });
    const ligada = await me();
    const { personalizados_teste, ...resto } = semTrial(ligada.body.company);
    expect(personalizados_teste).toBe(true);
    expect(resto).toEqual(semTrial(desligada.body.company));
  });
});

describe('2. PATCH /studio/settings — o lojista nao grava nem apaga', () => {
  const studioRouter = require('../src/routes/studio');
  const studioApp = () => {
    const a = express();
    a.use(express.json());
    a.use('/companies/:id/studio', studioRouter);
    return a;
  };

  let client;
  beforeEach(() => {
    client = { query: jest.fn(), release: jest.fn() };
    db.connect.mockReset().mockResolvedValue(client);
    client.query.mockImplementation(async (sql) => (
      /UPDATE companies/.test(sql) ? { rows: [{ settings: { pix_key: 'x', personalizados_teste: true } }] } : { rows: [] }
    ));
  });

  test('so a chave: 400 e nada no banco', async () => {
    for (const valor of [true, false, null]) {
      const res = await request(studioApp())
        .patch(`/companies/${CID}/studio/settings`)
        .send({ personalizados_teste: valor });
      expect(res.status).toBe(400);
    }
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('junto com chave permitida: a chave nao vai para o UPDATE, que so faz merge', async () => {
    for (const valor of [true, false, null]) {
      client.query.mockClear();
      const res = await request(studioApp())
        .patch(`/companies/${CID}/studio/settings`)
        .send({ pix_key: 'x', personalizados_teste: valor });
      expect(res.status).toBe(200);
      const upd = client.query.mock.calls.find(([sql]) => /UPDATE companies/.test(sql));
      // merge (||): o que ja esta gravado e nao veio no patch fica como esta
      expect(limpo(upd[0])).toContain("SET studio_settings = COALESCE(studio_settings, '{}'::jsonb) || $1::jsonb");
      expect(JSON.parse(upd[1][0])).toEqual({ pix_key: 'x' });
    }
  });
});
