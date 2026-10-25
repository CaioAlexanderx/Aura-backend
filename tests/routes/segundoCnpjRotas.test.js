// ============================================================
// Segundo CNPJ do Negócio a 50% (25/10/2026) — textos e valores das rotas
//   - POST /me/companies no Essencial: mensagem com o preço da tabela
//   - POST /me/companies: passa a ação da loja ao sync e escolhe a nota
//   - GET /me/companies/billing-preview: devolve o preview da tabela única
// ============================================================
jest.mock('../../src/utils/multicnpjBilling', () => ({
  ...jest.requireActual('../../src/utils/multicnpjBilling'),
  calculateMulticnpjValue: jest.fn(),
  safeSyncSubscriptionValue: jest.fn(),
  previewDaAssinatura: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../../src/config/database');
const multicnpj = require('../../src/utils/multicnpjBilling');

const SECRET = 'aura-test-secret-2026';
const OWNER = '11111111-1111-4111-8111-111111111111';
const PRIMARY = '22222222-2222-4222-8222-222222222222';
const NOVA = '33333333-3333-4333-8333-333333333333';
const auth = { Authorization: `Bearer ${jwt.sign({ id: OWNER, role: 'client' }, SECRET, { expiresIn: '1h' })}` };

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/v1/me/companies', require('../../src/routes/userCompanies'));
});

function banco(plan) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql || '');
    if (/WHERE owner_id = \$1 AND is_primary = true AND is_active = true/.test(s)) {
      return { rows: [{ id: PRIMARY, plan, billing_owner_company_id: PRIMARY, trade_name: 'Matriz', legal_name: 'Matriz' }] };
    }
    if (/SELECT COUNT\(\*\)::int AS total FROM companies/.test(s)) return { rows: [{ total: 1 }] };
    if (/INSERT INTO companies/.test(s)) {
      return { rows: [{ id: NOVA, trade_name: 'Filial', legal_name: 'Filial LTDA', cnpj: null, plan, vertical_active: null, is_primary: false, billing_owner_company_id: PRIMARY, created_at: '2026-10-25' }] };
    }
    return { rows: [] };
  });
}

const calc = {
  total_companies: 2, included_in_plan: 1, extra_cnpjs: 1, base_price: 169, seats_value: 0,
  extra_unit_price: 84.5, extras_value: 84.5, total_monthly: 253.5,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

describe('Essencial: mensagem do limite', () => {
  test('fala dos 50% no Negócio com o preço da tabela (sem 169,90 nem "até 2 CNPJs")', async () => {
    banco('essencial');
    const res = await request(app).post('/api/v1/me/companies').set(auth).send({ legal_name: 'Filial LTDA' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PLAN_LIMIT_REACHED');
    expect(res.body.message).toContain('No plano Negócio (R$ 169,00/mês), o segundo CNPJ tem 50% de desconto sobre o plano (R$ 84,50/mês)');
    expect(res.body.message).not.toMatch(/169,90|até 2 CNPJs/);
    expect(res.body.suggested_plan_price).toBe(169);
    expect(res.body.upgrade_savings_note).toBe(
      'Negócio com 2 CNPJs: R$ 169,00 + R$ 84,50 = R$ 253,50 por mês. No anual: R$ 140,83 + R$ 70,42 = R$ 211,25 por mês.'
    );
  });
});

describe('POST /me/companies no Negócio', () => {
  test('passa a ação da loja ao sync e mostra o valor novo', async () => {
    banco('negocio');
    multicnpj.calculateMulticnpjValue.mockResolvedValue(calc);
    multicnpj.safeSyncSubscriptionValue.mockResolvedValue({ synced: true, old_value: 169, new_value: 253.5 });
    const res = await request(app).post('/api/v1/me/companies').set(auth).send({ legal_name: 'Filial LTDA' });
    expect(res.status).toBe(201);
    expect(multicnpj.safeSyncSubscriptionValue).toHaveBeenCalledWith(PRIMARY, { evento: 'add', companyId: NOVA, companyName: 'Filial' });
    expect(res.body.billing_preview).toMatchObject({
      new_total_monthly: 253.5, extra_unit_price: 84.5, extras_price: 84.5, plan_base_price: 169,
      included_in_plan: 1, ajuste_pela_equipe: false,
    });
    expect(res.body.billing_preview.note).toBe('Mensalidade atualizada de R$ 169,00 para R$ 253,50. A próxima fatura já vem com o novo valor.');
  });

  test('assinatura combinada: devolve o cálculo e diz que a equipe ajusta', async () => {
    banco('negocio');
    multicnpj.calculateMulticnpjValue.mockResolvedValue({ ...calc, total_companies: 3, extra_cnpjs: 2, extras_value: 140.84, total_monthly: 281.67, base_price: 140.83, extra_unit_price: 70.42 });
    multicnpj.safeSyncSubscriptionValue.mockResolvedValue({ synced: false, reason: 'valor_combinado', combined_value: 211.2, new_value: 281.67 });
    const res = await request(app).post('/api/v1/me/companies').set(auth).send({ legal_name: 'Filial LTDA' });
    expect(res.status).toBe(201);
    expect(res.body.billing_preview).toMatchObject({ new_total_monthly: 281.67, ajuste_pela_equipe: true, asaas_synced: false, asaas_reason: 'valor_combinado' });
    expect(res.body.billing_preview.note).toMatch(/condição especial/);
    expect(res.body.billing_preview.note).toMatch(/equipe Aura/);
  });
});

describe('GET /me/companies/billing-preview', () => {
  test('devolve o preview da tabela única', async () => {
    banco('negocio');
    multicnpj.previewDaAssinatura.mockResolvedValue({
      current: { ...calc, total_companies: 1, extra_cnpjs: 0, extras_value: 0, total_monthly: 169 },
      if_add_one: { total_companies: 2, extra_cnpjs: 1, extra_unit_price: 84.5, new_total_monthly: 253.5, delta_monthly: 84.5, ajuste_pela_equipe: false },
    });
    const res = await request(app).get('/api/v1/me/companies/billing-preview').set(auth);
    expect(res.status).toBe(200);
    expect(multicnpj.previewDaAssinatura).toHaveBeenCalledWith(PRIMARY);
    expect(res.body.if_add_one).toMatchObject({ new_total_monthly: 253.5, delta_monthly: 84.5 });
    expect(res.body.can_add).toBe(true);
  });
});
