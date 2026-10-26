// ============================================================
// Limitador de consultas de CNPJ do cadastro (tq-114, 26/10/2026)
//
// Medido em 26/10: o cnpjLimiter de POST /onboarding/cnpj-lookup era
// registrado no apiRouter DEPOIS de routes/index montar /onboarding. O
// Express roda as camadas na ordem: a rota respondia antes e o limitador
// nunca rodava. Medido com este teste antes da correcao: 21 consultas
// seguidas do mesmo IP davam 21 x 200, nenhum 429. Mesmo bug do tq-71
// (Aura-backend#904), mesmo padrao de correcao.
//
// Sobe o app DE VERDADE com NODE_ENV=development, porque os limitadores
// se desligam em NODE_ENV=test. A Receita e mockada (lookupCNPJ).
// ============================================================
'use strict';

const request = require('supertest');

jest.mock('../src/services/cnpj', () => {
  const real = jest.requireActual('../src/services/cnpj');
  return { ...real, lookupCNPJ: jest.fn() };
});

const LIMITE = 20; // 20 consultas por IP por hora (o limite de sempre)
const CNPJ = '11.222.333/0001-81';

let app;
let lookupCNPJ;
let ambienteOriginal;

beforeAll(() => {
  ambienteOriginal = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || 'postgresql://aura_test:aura_test@localhost:5432/aura_test';
  lookupCNPJ = require('../src/services/cnpj').lookupCNPJ;
  app = require('../src/app');
});

afterAll(() => {
  process.env.NODE_ENV = ambienteOriginal;
});

beforeEach(() => {
  lookupCNPJ.mockReset();
  lookupCNPJ.mockResolvedValue({
    cnpj: CNPJ, legal_name: 'LOJA X LTDA', is_active: true,
    cnae_principal: { code: '4781400', description: 'Comércio varejista de artigos do vestuário' },
    cnaes_secundarios: [],
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

/** Cada teste usa um IP proprio (o Railway poe o IP do cliente no fim do X-Forwarded-For). */
function consultar(ip, cnpj = CNPJ) {
  return request(app).post('/api/v1/onboarding/cnpj-lookup')
    .set('X-Forwarded-For', ip)
    .set('Host', 'aura-backend-production-f805.up.railway.app')
    .send({ cnpj });
}

async function consultarN(ip, n) {
  const status = [];
  for (let i = 0; i < n; i++) status.push((await consultar(ip)).status);
  return status;
}

describe('POST /onboarding/cnpj-lookup', () => {
  test('a consulta 21 seguida do mesmo IP leva 429', async () => {
    const status = await consultarN('203.0.113.40', LIMITE + 1);
    expect(status.slice(0, LIMITE)).toEqual(Array(LIMITE).fill(200));
    expect(status[LIMITE]).toBe(429);
  });

  test('o 429 nao consulta a Receita nem chega na rota', async () => {
    await consultarN('203.0.113.41', LIMITE);
    lookupCNPJ.mockClear();
    const r = await consultar('203.0.113.41');
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/Limite de consultas CNPJ/);
    expect(lookupCNPJ).not.toHaveBeenCalled();
  });

  test('outro IP segue consultando (o balde e por cliente, nao pelo proxy)', async () => {
    await consultarN('203.0.113.42', LIMITE + 1);
    expect(await consultarN('198.51.100.9', 1)).toEqual([200]);
  });

  test('o IP vem do fim do X-Forwarded-For: forjar o comeco nao fura o limite', async () => {
    await consultarN('203.0.113.43', LIMITE);
    const r = await consultar('10.9.8.7, 203.0.113.43');
    expect(r.status).toBe(429);
  });
});
