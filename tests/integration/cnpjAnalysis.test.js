// ============================================================
// AURA. — Testes Integração: Simulador de Prospect (FEAT-01)
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app;
beforeAll(() => { ({ app } = require('../../src/index')); });

const SECRET      = 'aura-test-secret-2026';
const adminAuth   = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'admin' }, SECRET, { expiresIn:'1h' })}` };
const analystAuth = { Authorization: `Bearer ${jwt.sign({ id:'u2', role:'analyst' }, SECRET, { expiresIn:'1h' })}` };
const clientAuth  = { Authorization: `Bearer ${jwt.sign({ id:'u3', role:'client' }, SECRET, { expiresIn:'1h' })}` };

jest.mock('../../src/services/cnpjAnalysis', () => ({ analyzeCNPJ: jest.fn() }));
const { analyzeCNPJ } = require('../../src/services/cnpjAnalysis');

const mockMei = {
  cnpj: '12.345.678/0001-90', cnpj_raw: '12345678000190',
  company: { name:'JOAO DA SILVA', situation:'ATIVA', is_active:true, porte:'MEI' },
  fiscal_profile: { cnae_code:8650, cnae_desc:'Odontologia', regime_inferred:'mei', regime_label:'MEI', vertical_detected:'odontologia' },
  recommendation: { plan:'essencial', price:99, market_cost:239, savings:140, savings_pct:58, pitch_points:['DAS-MEI automático'] },
  alerts: ['🎯 Atividade de odontologia detectada — mencionar módulo vertical'],
  consulted_at: new Date().toISOString(),
};

describe('GET /admin/prospect/:cnpj — controle de acesso', () => {
  beforeEach(() => jest.clearAllMocks());

  test('admin consegue acessar', async () => {
    analyzeCNPJ.mockResolvedValueOnce(mockMei);
    const res = await request(app).get('/api/v1/admin/prospect/12345678000190').set(adminAuth);
    expect(res.status).toBe(200);
  });

  test('analyst consegue acessar', async () => {
    analyzeCNPJ.mockResolvedValueOnce(mockMei);
    const res = await request(app).get('/api/v1/admin/prospect/12345678000190').set(analystAuth);
    expect(res.status).toBe(200);
  });

  test('client recebe 403', async () => {
    const res = await request(app).get('/api/v1/admin/prospect/12345678000190').set(clientAuth);
    expect(res.status).toBe(403);
  });

  test('sem token retorna 401', async () => {
    const res = await request(app).get('/api/v1/admin/prospect/12345678000190');
    expect(res.status).toBe(401);
  });
});

describe('GET /admin/prospect/:cnpj — retorno da análise', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna campos esperados', async () => {
    analyzeCNPJ.mockResolvedValueOnce(mockMei);
    const res = await request(app).get('/api/v1/admin/prospect/12345678000190').set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cnpj');
    expect(res.body).toHaveProperty('fiscal_profile');
    expect(res.body).toHaveProperty('recommendation');
    expect(res.body).toHaveProperty('alerts');
  });

  test('plano recomendado correto para MEI', async () => {
    analyzeCNPJ.mockResolvedValueOnce(mockMei);
    const res = await request(app).get('/api/v1/admin/prospect/12345678000190').set(adminAuth);
    expect(res.body.recommendation.plan).toBe('essencial');
    expect(res.body.recommendation.price).toBe(99);
  });

  test('pitch_points é array não vazio', async () => {
    analyzeCNPJ.mockResolvedValueOnce(mockMei);
    const res = await request(app).get('/api/v1/admin/prospect/12345678000190').set(adminAuth);
    expect(Array.isArray(res.body.recommendation.pitch_points)).toBe(true);
    expect(res.body.recommendation.pitch_points.length).toBeGreaterThan(0);
  });

  test('alerta de vertical detectada presente', async () => {
    analyzeCNPJ.mockResolvedValueOnce(mockMei);
    const res = await request(app).get('/api/v1/admin/prospect/12345678000190').set(adminAuth);
    expect(res.body.alerts.some(a => a.includes('odontologia'))).toBe(true);
  });

  test('savings e savings_pct calculados corretamente', async () => {
    analyzeCNPJ.mockResolvedValueOnce(mockMei);
    const res = await request(app).get('/api/v1/admin/prospect/12345678000190').set(adminAuth);
    expect(res.body.recommendation.savings).toBe(140);
    expect(res.body.recommendation.savings_pct).toBe(58);
  });
});

describe('GET /admin/prospect/:cnpj — tratamento de erros', () => {
  beforeEach(() => jest.clearAllMocks());

  test('400 para CNPJ inválido', async () => {
    analyzeCNPJ.mockRejectedValueOnce(new Error('CNPJ inválido'));
    const res = await request(app).get('/api/v1/admin/prospect/00000000000000').set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inv[aá]lido/i);
  });

  test('404 para CNPJ não encontrado na RF', async () => {
    analyzeCNPJ.mockRejectedValueOnce(new Error('CNPJ não encontrado na Receita Federal.'));
    const res = await request(app).get('/api/v1/admin/prospect/99999999000100').set(adminAuth);
    expect(res.status).toBe(404);
  });

  test('429 ao atingir limite de consultas', async () => {
    analyzeCNPJ.mockRejectedValueOnce(new Error('Limite de consultas atingido. Aguarde alguns minutos.'));
    const res = await request(app).get('/api/v1/admin/prospect/12345678000190').set(adminAuth);
    expect(res.status).toBe(429);
  });
});
