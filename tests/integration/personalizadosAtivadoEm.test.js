// ============================================================
// AURA. — Integracao: personalizados_ativado_em pelo app inteiro (p-172)
//
// Pela rota real /api/v1/companies/:id/pdv-settings (JWT, acesso a empresa,
// router privado). O banco e uma linha de companies em memoria que imita a
// guarda do UPDATE (a data do banco vence o objeto enviado). O que segura:
//   1. o lojista nao edita a chave (dono ou membro, qualquer valor);
//   2. o app salvando o objeto inteiro que leu nao apaga nem troca a data;
//   3. o PUT que liga a frente grava a hora uma vez so;
//   4. sem acesso a empresa, nada e lido nem gravado.
// ============================================================
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const CID = '00000000-0000-0000-0000-000000000172';
const CHAVE = 'personalizados_ativado_em';
const ANTIGA = '2026-05-22T12:00:00.000Z';
const token = (over = {}) => `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio', ...over }, SECRET, { expiresIn: '1h' })}`;
const url = `/api/v1/companies/${CID}/pdv-settings`;

function banco({ pdv_settings = {}, vertical_active = null, papel = 'owner' } = {}) {
  const state = { pdv_settings, vertical_active, updates: [] };
  db.query.mockImplementation(async (sql, params) => {
    const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
    if (/AS role FROM companies/.test(text)) return { rows: papel ? [{ role: papel }] : [] };
    if (/^\s*SELECT pdv_settings, vertical_active FROM companies/.test(text)) {
      return { rows: [{ pdv_settings: state.pdv_settings, vertical_active: state.vertical_active }] };
    }
    if (/^\s*UPDATE companies SET pdv_settings = \$1::jsonb \|\|/.test(text)) {
      const novo = JSON.parse(params[0]);
      const noBanco = (state.pdv_settings || {})[CHAVE];
      if (noBanco !== undefined && noBanco !== null && noBanco !== '') novo[CHAVE] = noBanco;
      state.pdv_settings = novo;
      state.updates.push(novo);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return state;
}

afterEach(() => db.query.mockReset());

describe('PUT /companies/:id/pdv-settings — data de ativacao somente leitura', () => {
  test('dono nao grava a chave pelo corpo', async () => {
    const state = banco();
    const res = await request(app).put(url).set('Authorization', token())
      .send({ settings: { [CHAVE]: '2020-01-01T00:00:00.000Z', caixa_enabled: true } });
    expect(res.status).toBe(200);
    expect(res.body.settings).not.toHaveProperty(CHAVE);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).not.toHaveProperty(CHAVE);
    expect(state.updates[0].caixa_enabled).toBe(true);
  });

  test('membro tambem nao troca uma data gravada', async () => {
    const state = banco({ papel: 'Vendedor', pdv_settings: { studio_enabled: true, [CHAVE]: ANTIGA } });
    const res = await request(app).put(url).set('Authorization', token({ id: 'u2' }))
      .send({ settings: { [CHAVE]: '2026-11-17T00:00:00.000Z' } });
    expect(res.status).toBe(200);
    expect(res.body.settings[CHAVE]).toBe(ANTIGA);
    expect(state.pdv_settings[CHAVE]).toBe(ANTIGA);
  });

  test('o app salvando o objeto inteiro do GET mantem a data', async () => {
    const state = banco({ pdv_settings: { studio_enabled: true, [CHAVE]: ANTIGA } });
    const get = await request(app).get(url).set('Authorization', token());
    expect(get.status).toBe(200);
    expect(get.body.settings[CHAVE]).toBe(ANTIGA);

    const lido = { ...get.body.settings, require_customer: true };
    const res = await request(app).put(url).set('Authorization', token()).send({ settings: lido });
    expect(res.status).toBe(200);
    expect(state.pdv_settings[CHAVE]).toBe(ANTIGA);
    expect(state.pdv_settings.require_customer).toBe(true);
  });

  test('ligar a frente grava a hora uma vez; desligar e ligar de novo nao troca', async () => {
    const state = banco({ pdv_settings: { studio_enabled: false } });
    const r1 = await request(app).put(url).set('Authorization', token()).send({ settings: { studio_enabled: true } });
    expect(r1.status).toBe(200);
    const primeira = state.pdv_settings[CHAVE];
    expect(typeof primeira).toBe('string');
    expect(Math.abs(Date.now() - Date.parse(primeira))).toBeLessThan(60 * 1000);

    await request(app).put(url).set('Authorization', token()).send({ settings: { studio_enabled: false } });
    await request(app).put(url).set('Authorization', token()).send({ settings: { studio_enabled: true } });
    expect(state.pdv_settings[CHAVE]).toBe(primeira);
    expect(state.updates.map((u) => u[CHAVE])).toEqual([primeira, primeira, primeira]);
  });

  test('empresa da vertical Studio sem data nao ganha data por um PUT qualquer', async () => {
    const state = banco({ vertical_active: 'studio', pdv_settings: { studio_enabled: true } });
    const res = await request(app).put(url).set('Authorization', token()).send({ settings: { caixa_enabled: true } });
    expect(res.status).toBe(200);
    expect(state.pdv_settings).not.toHaveProperty(CHAVE);
  });

  test('sem acesso a empresa: 403 e nada gravado', async () => {
    const state = banco({ papel: null });
    const res = await request(app).put(url).set('Authorization', token({ id: 'estranho' }))
      .send({ settings: { studio_enabled: true } });
    expect(res.status).toBe(403);
    expect(state.updates).toHaveLength(0);
  });
});
