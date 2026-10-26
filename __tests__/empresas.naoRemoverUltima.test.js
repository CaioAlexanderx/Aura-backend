// ============================================================
// Não remover a única empresa; cadastro marca a principal
// (INC-2026-10-22-01, tq-103, 22/10/2026)
//
// O caso real: uma lojista em teste clicou em "Remover empresa" na própria
// e única empresa. O DELETE /me/companies/:id só recusava is_primary, e o
// cadastro não marcava a primeira empresa como principal. A empresa ficou
// is_active = false e a conta abriu vazia no login seguinte.
//
// O que este arquivo trava:
//   1. remover a última empresa ativa do dono → 409 LAST_COMPANY, sem UPDATE
//   2. remover a segunda com uma principal ativa → 200, desativa e grava
//      audit_log (action 'remove_company', company_id = empresa removida)
//   3. a regra da principal continua (403 CANNOT_REMOVE_PRIMARY)
//   4. corrida: se o UPDATE não desativar (contagem caiu para 1), 409
//   5. POST /auth/register cria a empresa com is_primary = true; convite e
//      entrada numa empresa existente não criam empresa
// Banco mockado por SQL (nunca fila posicional).
// ============================================================
jest.mock('../src/utils/multicnpjBilling', () => ({
  ...jest.requireActual('../src/utils/multicnpjBilling'),
  calculateMulticnpjValue: jest.fn().mockResolvedValue(null),
  safeSyncSubscriptionValue: jest.fn().mockResolvedValue({ synced: false, reason: 'no_subscription' }),
}));
jest.mock('../src/services/cnpj', () => {
  const real = jest.requireActual('../src/services/cnpj');
  return { ...real, lookupCNPJ: jest.fn() };
});
jest.mock('../src/services/asaasClient', () => ({
  ...jest.requireActual('../src/services/asaasClient'),
  asaas: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');

const SECRET = 'aura-test-secret-2026';
const OWNER = '11111111-1111-4111-8111-111111111111';
const UNICA = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = '33333333-3333-4333-8333-333333333333';
const SEGUNDA = '44444444-4444-4444-8444-444444444444';
const auth = { Authorization: `Bearer ${jwt.sign({ id: OWNER, role: 'client' }, SECRET, { expiresIn: '1h' })}` };

const MENSAGEM =
  'Esta é a sua única empresa. Para mudar nome, endereço ou contato, edite em Configurações. Para trocar o CNPJ, fale com o suporte da Aura.';

let db;
let routeApp;
beforeAll(() => {
  db = require('../src/config/database');
  routeApp = express();
  routeApp.use(express.json());
  routeApp.use('/api/v1/me/companies', require('../src/routes/userCompanies'));
});
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

// Banco falso do DELETE: `empresas` são as linhas de companies do dono.
function bancoDoDono(empresas, { updateFalha = false } = {}) {
  const linhas = empresas.map((e) => ({ owner_id: OWNER, is_active: true, is_primary: false, ...e }));
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql || '');
    if (/SELECT id, trade_name, legal_name, is_primary, billing_owner_company_id/.test(s)) {
      const c = linhas.find((l) => l.id === params[0] && l.owner_id === params[1] && l.is_active);
      return { rows: c ? [{ ...c }] : [] };
    }
    if (/SELECT COUNT\(\*\)::int AS total\s+FROM companies\s+WHERE owner_id = \$1 AND is_active = true/.test(s)) {
      return { rows: [{ total: linhas.filter((l) => l.owner_id === params[0] && l.is_active).length }] };
    }
    if (/FROM sales WHERE company_id/.test(s)) return { rows: [{ total: 0 }] };
    if (/UPDATE companies\s+SET is_active = false/.test(s)) {
      const ativas = linhas.filter((l) => l.owner_id === params[1] && l.is_active).length;
      if (updateFalha || ativas <= 1) return { rows: [] };
      const c = linhas.find((l) => l.id === params[0]);
      c.is_active = false;
      return { rows: [{ id: c.id }] };
    }
    return { rows: [] };
  });
  return linhas;
}
const chamadas = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0] || '')));
const remover = (id) => request(routeApp).delete(`/api/v1/me/companies/${id}`).set(auth);

describe('DELETE /me/companies/:id — última empresa', () => {
  test('1. única empresa ativa (sem principal, o caso real): 409 LAST_COMPANY e nada desativado', async () => {
    const linhas = bancoDoDono([{ id: UNICA, trade_name: 'Loja da Ana' }]);
    const res = await remover(UNICA);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_COMPANY');
    expect(res.body.error).toBe('LAST_COMPANY');
    expect(res.body.message).toBe(MENSAGEM);
    expect(chamadas(/UPDATE companies/)).toHaveLength(0);
    expect(chamadas(/INSERT INTO audit_log/)).toHaveLength(0);
    expect(linhas[0].is_active).toBe(true);
  });

  test('1b. única empresa ativa e principal: a mensagem é a da última empresa, não a da principal', async () => {
    bancoDoDono([{ id: UNICA, trade_name: 'Loja da Ana', is_primary: true }]);
    const res = await remover(UNICA);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_COMPANY');
  });

  test('1c. empresa inativa do dono não conta: com uma ativa e uma inativa, ainda é a última', async () => {
    bancoDoDono([
      { id: UNICA, trade_name: 'Loja da Ana' },
      { id: SEGUNDA, trade_name: 'Loja antiga', is_active: false },
    ]);
    const res = await remover(UNICA);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_COMPANY');
  });

  test('2. segunda empresa com uma principal ativa: 200, desativa e grava audit_log com a empresa removida', async () => {
    const linhas = bancoDoDono([
      { id: PRINCIPAL, trade_name: 'Matriz', is_primary: true, billing_owner_company_id: PRINCIPAL },
      { id: SEGUNDA, trade_name: 'Filial', billing_owner_company_id: PRINCIPAL },
    ]);
    const res = await remover(SEGUNDA);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    expect(linhas.find((l) => l.id === SEGUNDA).is_active).toBe(false);
    expect(linhas.find((l) => l.id === PRINCIPAL).is_active).toBe(true);

    const audit = chamadas(/INSERT INTO audit_log/);
    expect(audit).toHaveLength(1);
    const [userId, companyId, action] = audit[0][1];
    expect(userId).toBe(OWNER);
    expect(companyId).toBe(SEGUNDA);
    expect(action).toBe('remove_company');
    // o registro de sempre em multicnpj_audit continua
    expect(chamadas(/INSERT INTO multicnpj_audit/)).toHaveLength(1);
  });

  test('3. a regra da principal continua: principal com outra ativa → 403 CANNOT_REMOVE_PRIMARY', async () => {
    bancoDoDono([
      { id: PRINCIPAL, trade_name: 'Matriz', is_primary: true },
      { id: SEGUNDA, trade_name: 'Filial' },
    ]);
    const res = await remover(PRINCIPAL);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CANNOT_REMOVE_PRIMARY');
    expect(chamadas(/UPDATE companies/)).toHaveLength(0);
  });

  test('4. corrida: o UPDATE repete a contagem e, se não desativar, responde 409 sem audit', async () => {
    bancoDoDono([
      { id: PRINCIPAL, trade_name: 'Matriz', is_primary: true },
      { id: SEGUNDA, trade_name: 'Filial' },
    ], { updateFalha: true });
    const res = await remover(SEGUNDA);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_COMPANY');
    const upd = chamadas(/UPDATE companies\s+SET is_active = false/);
    expect(upd).toHaveLength(1);
    expect(upd[0][0]).toMatch(/owner_id = \$2 AND is_active = true\) > 1/);
    expect(upd[0][1]).toEqual([SEGUNDA, OWNER]);
    expect(chamadas(/INSERT INTO audit_log/)).toHaveLength(0);
  });
});

describe('POST /auth/register — a empresa nasce principal', () => {
  let app;
  beforeAll(() => { ({ app } = require('../src/index')); });
  beforeEach(() => db.query.mockResolvedValue({ rows: [] }));

  const body = (extra) => ({
    name: 'Ana', email: 'ana@loja.com', password: 'senha1234',
    company_name: 'Loja da Ana', phone: '11999990000',
    terms_accepted: true, self_serve: true,
    ...(extra || {}),
  });

  test('5. conta nova com empresa: INSERT INTO companies grava is_primary = true', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body());
    expect(res.status).toBe(201);
    const ins = fake.writesTo(/INSERT INTO companies/);
    expect(ins).toHaveLength(1);
    expect(ins[0].text).toMatch(/federation_id, tax_regime, is_primary, email\)/);
    expect(ins[0].text).toMatch(/'simples_nacional'::tax_regime\), true, \$11\)/);
    // is_primary é literal; o $11 é o e-mail do dono (tq-41, 26/10/2026)
    expect(ins[0].params).toHaveLength(11);
  });

  test('5b. entrar numa empresa existente pelo CNPJ não cria empresa nem mexe em is_primary', async () => {
    const fake = fakeSegmentDb({ existingCnpj: { id: 'c-existente', legal_name: 'Loja Antiga', plan: 'negocio' } });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ cnpj: '11222333000181' }));
    expect(res.status).toBe(201);
    expect(fake.writesTo(/INSERT INTO companies/)).toHaveLength(0);
    expect(fake.writesTo(/is_primary/)).toHaveLength(0);
  });

  test('5c. convite (sem nome de empresa) não cria empresa', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ company_name: undefined, self_serve: false }));
    expect(res.status).toBe(201);
    expect(fake.writesTo(/INSERT INTO companies/)).toHaveLength(0);
  });
});
