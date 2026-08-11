// ============================================================
// AURA DOJÔ — F11: GET /public/karate/federations
//
// ⚠️ MOCK POR SQL (regex), nunca fila posicional.
//
// O que este arquivo trava:
//   - a rota é PÚBLICA (quem chama ainda não tem conta);
//   - filtra por vertical='karate_federation' + is_active;
//   - devolve SÓ id + name — qualquer campo a mais aqui vira dado público
//     permanente, então a superfície é assertada explicitamente;
//   - lista vazia é 200, nunca 404 (o front mostra estado vazio);
//   - schema faltando (42703/42P01) degrada para lista vazia, não 500.
// ============================================================
const request = require('supertest');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const PATH = '/api/v1/public/karate/federations';

// Responde por SQL: a query de federações casa; o resto devolve vazio.
function mockFederations(rows) {
  db.query.mockImplementation((sql) => {
    const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
    if (/FROM companies/.test(text) && /karate_federation/.test(text)) {
      return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
}

function lastFederationSql() {
  const call = db.query.mock.calls.find(([sql]) => {
    const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
    return /FROM companies/.test(text) && /karate_federation/.test(text);
  });
  const raw = call ? call[0] : '';
  return typeof raw === 'string' ? raw : (raw && raw.text) || '';
}

describe('GET /public/karate/federations', () => {
  test('200 — lista federações sem exigir token', async () => {
    mockFederations([
      { id: '274994b3-6324-4e7b-942e-e6dd19666149', name: 'Federação Paulista de Karatê-do Tradicional' },
    ]);

    const res = await request(app).get(PATH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.federations)).toBe(true);
    expect(res.body.federations).toHaveLength(1);
    expect(res.body.federations[0].name).toMatch(/Paulista/);
  });

  test('200 — devolve SÓ id e name (superfície mínima)', async () => {
    mockFederations([
      {
        id: 'fed-1',
        name: 'FPKT',
        // Campos que o SELECT nunca deve vazar mesmo se aparecerem na row.
        cnpj: '11222333000181',
        legal_name: 'FEDERACAO PAULISTA',
        slug: 'fpkt',
      },
    ]);

    const res = await request(app).get(PATH);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.federations[0]).sort()).toEqual(['id', 'name']);
  });

  test('filtra por vertical canônico + is_active', async () => {
    mockFederations([]);
    await request(app).get(PATH);

    const sql = lastFederationSql();
    expect(sql).toMatch(/vertical = 'karate_federation'/);
    expect(sql).toMatch(/is_active = true/);
    // Nome resiliente: companies.name é nullable, legal_name é o NOT NULL.
    expect(sql).toMatch(/COALESCE/);
  });

  test('200 com lista vazia — nunca 404', async () => {
    mockFederations([]);
    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body.federations).toEqual([]);
  });

  test('42703/42P01 (schema pré-migration) degrada para lista vazia', async () => {
    db.query.mockImplementation(() => {
      const err = new Error('column "vertical" does not exist');
      err.code = '42703';
      return Promise.reject(err);
    });

    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body.federations).toEqual([]);
  });

  test('rota estática não é capturada como :slug pelos routers de karatê', async () => {
    // 'federations' tem 1 segmento e é montada ANTES de /public/karate/:slug/*.
    // Se algum dia alguém mover o mount para baixo, este teste cai: a resposta
    // deixaria de ser o objeto { federations: [...] }.
    mockFederations([{ id: 'fed-1', name: 'FPKT' }]);
    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('federations');
  });
});
