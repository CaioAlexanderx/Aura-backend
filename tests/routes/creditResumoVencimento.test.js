// ============================================================
// AURA. -- p-90: resumo do que vence num periodo (crediario)
// Somente leitura: nenhum INSERT/UPDATE/DELETE, nenhuma transacao.
// O banco e simulado; as consultas sao conferidas pelo texto e pelos
// parametros, e as respostas pela forma do JSON.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const SECRET = 'aura-test-secret-2026';
const A = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const B = '18c05f0e-b75b-4c12-870e-d7fb65f1dca1';
const token = (extra) => `Bearer ${jwt.sign({ id: 'u1', role: 'admin', plan: 'negocio', ...extra }, SECRET, { expiresIn: '3000d' })}`;

let db;
let mod;
let consultas;

function banco({ enabled = 'true', lojas = [], semanas = [], habilitadas, donas } = {}) {
  consultas = [];
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    consultas.push({ s, params });
    if (/pdv_settings->>'crediario_enabled' AS enabled/i.test(s)) {
      return Promise.resolve({ rows: enabled === null ? [] : [{ enabled }] });
    }
    if (/SELECT DISTINCT c\.id/i.test(s)) return Promise.resolve({ rows: (donas || []).map((id) => ({ id })) });
    if (/SELECT id FROM companies/i.test(s)) return Promise.resolve({ rows: (habilitadas || []).map((id) => ({ id })) });
    if (/AS nome FROM companies/i.test(s)) return Promise.resolve({ rows: [{ id: A, nome: 'Loja A' }, { id: B, nome: 'Loja B' }] });
    if (/GROUP BY ci\.company_id/i.test(s)) return Promise.resolve({ rows: lojas });
    if (/DATE_TRUNC\('week'/i.test(s)) return Promise.resolve({ rows: semanas });
    return Promise.resolve({ rows: [] });
  });
}

function appLoja() {
  const app = express();
  const r = express.Router({ mergeParams: true });
  r.use('/credit', mod.companyRouter);
  app.use('/api/v1/companies/:id', r);
  return app;
}
function appMe() {
  const app = express();
  app.use('/api/v1/me/credit', mod.meRouter);
  return app;
}

beforeEach(() => {
  jest.resetModules();
  db = require('../../src/config/database');
  db.query.mockReset();
  db.connect.mockReset();
  mod = require('../../src/routes/creditResumoVencimento');
});

function somenteLeitura() {
  expect(db.connect).not.toHaveBeenCalled();
  for (const c of consultas) expect(c.s).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
}

describe('periodo', () => {
  test('sem parametros: janeiro do ano que vem em Sao Paulo', () => {
    expect(mod.janeiroDoAnoQueVem(new Date('2026-11-08T12:00:00Z'))).toEqual({ de: '2027-01-01', ate: '2027-01-31' });
    // 1h da manha de 1/jan em UTC ainda e 31/dez em Sao Paulo
    expect(mod.janeiroDoAnoQueVem(new Date('2027-01-01T01:00:00Z'))).toEqual({ de: '2027-01-01', ate: '2027-01-31' });
    expect(mod.janeiroDoAnoQueVem(new Date('2027-01-01T04:00:00Z'))).toEqual({ de: '2028-01-01', ate: '2028-01-31' });
  });
  test('so "de": vale ate o fim daquele mes', () => {
    expect(mod.resolvePeriodo({ de: '2027-02-01' })).toEqual({ de: '2027-02-01', ate: '2027-02-28' });
  });
  test('de e ate explicitos, inclusive o dia 29 de fevereiro bissexto', () => {
    expect(mod.resolvePeriodo({ de: '2028-02-01', ate: '2028-02-29' })).toEqual({ de: '2028-02-01', ate: '2028-02-29' });
  });
  test('invalidos', () => {
    expect(mod.resolvePeriodo({ de: '2027-02-30', ate: '2027-03-01' }).erro).toBeTruthy();
    expect(mod.resolvePeriodo({ de: 'ontem' }).erro).toBeTruthy();
    expect(mod.resolvePeriodo({ de: '2027-02-10', ate: '2027-02-01' }).erro).toBeTruthy();
    expect(mod.resolvePeriodo({ de: '2025-01-01', ate: '2027-01-01' }).erro).toBeTruthy();
  });
  test('periodo invalido responde 400 sem tocar no banco', async () => {
    banco();
    const r = await request(appLoja()).get(`/api/v1/companies/${A}/credit/installments/resumo-vencimento?de=abc`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PERIODO_INVALIDO');
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('uma loja', () => {
  test('resumo de janeiro: contagens, valor, semanas, so SELECT', async () => {
    banco({
      lojas: [{ company_id: A, parcelas: '12', valor: '3456.70', clientes: '5', carnes: '7' }],
      semanas: [
        { semana_inicio: '2026-12-28', parcelas: '4', valor: '1000.10' },
        { semana_inicio: '2027-01-04', parcelas: '8', valor: '2456.60' },
      ],
    });
    const r = await request(appLoja()).get(`/api/v1/companies/${A}/credit/installments/resumo-vencimento`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      periodo: { de: '2027-01-01', ate: '2027-01-31' },
      parcelas: 12, valor: 3456.7, clientes: 5, carnes: 7,
      por_semana: [
        { semana_inicio: '2026-12-28', parcelas: 4, valor: 1000.1 },
        { semana_inicio: '2027-01-04', parcelas: 8, valor: 2456.6 },
      ],
      empresas: [{ company_id: A, nome: null, parcelas: 12, valor: 3456.7, clientes: 5, carnes: 7 }],
      consolidated: false,
    });
    somenteLeitura();
  });

  test('a consulta usa o periodo pedido (limites inclusivos) e a empresa', async () => {
    banco();
    await request(appLoja()).get(`/api/v1/companies/${A}/credit/installments/resumo-vencimento?de=2027-01-10&ate=2027-01-20`);
    const q = consultas.find((c) => /GROUP BY ci\.company_id/i.test(c.s));
    expect(q.params).toEqual([[A], '2027-01-10', '2027-01-20']);
    expect(q.s).toMatch(/due_date BETWEEN \$2::date AND \$3::date/);
  });

  test('so parcela aberta com saldo: pagas e canceladas ficam de fora, parcial entra pelo que falta', async () => {
    banco();
    await request(appLoja()).get(`/api/v1/companies/${A}/credit/installments/resumo-vencimento`);
    const q = consultas.find((c) => /GROUP BY ci\.company_id/i.test(c.s)).s;
    expect(q).toMatch(/status IN \('pending','overdue'\)/);
    expect(q).not.toMatch(/'paid'|'cancelled'|'canceled'/);
    // saldo = devido - coberto (pagamento parcial), acima da tolerancia de arredondamento
    expect(q).toMatch(/SUM\(ci\.amount_due - COALESCE\(ci\.covered_amount, 0\)\)/);
    expect(q).toMatch(/\(ci\.amount_due - COALESCE\(ci\.covered_amount, 0\)\) > 2/);
    // cliente que nao deve no razao nao conta
    expect(q).toMatch(/customer_credit_balances/);
    // carne = account_id, com a compra como reserva
    expect(q).toMatch(/COUNT\(DISTINCT COALESCE\(ci\.account_id::text, ci\.sale_id::text\)\)/);
    expect(q).toMatch(/COUNT\(DISTINCT ci\.customer_id\)/);
  });

  test('janeiro sem nada a vencer: zeros e listas vazias', async () => {
    banco({ lojas: [], semanas: [] });
    const r = await request(appLoja()).get(`/api/v1/companies/${A}/credit/installments/resumo-vencimento`);
    expect(r.status).toBe(200);
    expect(r.body.parcelas).toBe(0);
    expect(r.body.valor).toBe(0);
    expect(r.body.clientes).toBe(0);
    expect(r.body.carnes).toBe(0);
    expect(r.body.por_semana).toEqual([]);
    expect(r.body.empresas).toHaveLength(1);
  });

  test('crediario desligado: 403; empresa inexistente: 404', async () => {
    banco({ enabled: 'false' });
    let r = await request(appLoja()).get(`/api/v1/companies/${A}/credit/installments/resumo-vencimento`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('CREDIARIO_DISABLED');
    banco({ enabled: null });
    r = await request(appLoja()).get(`/api/v1/companies/${A}/credit/installments/resumo-vencimento`);
    expect(r.status).toBe(404);
  });

  test('erro de banco: 500 em portugues, sem vazar a mensagem', async () => {
    banco();
    db.query.mockImplementation((s) => (/enabled/.test(String(s))
      ? Promise.resolve({ rows: [{ enabled: 'true' }] })
      : Promise.reject(new Error('boom interno'))));
    const r = await request(appLoja()).get(`/api/v1/companies/${A}/credit/installments/resumo-vencimento`);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/boom/);
  });
});

describe('consolidado (todos os CNPJs)', () => {
  test('soma as lojas e traz uma linha por loja, inclusive a que nao tem nada', async () => {
    banco({
      donas: [A, B],
      habilitadas: [A, B],
      lojas: [{ company_id: A, parcelas: '3', valor: '300.25', clientes: '2', carnes: '2' }],
    });
    const r = await request(appMe())
      .get('/api/v1/me/credit/installments/resumo-vencimento')
      .set('Authorization', token());
    expect(r.status).toBe(200);
    expect(r.body.consolidated).toBe(true);
    expect(r.body.company_count).toBe(2);
    expect(r.body).toMatchObject({ parcelas: 3, valor: 300.25, clientes: 2, carnes: 2 });
    expect(r.body.empresas).toEqual([
      { company_id: A, nome: 'Loja A', parcelas: 3, valor: 300.25, clientes: 2, carnes: 2 },
      { company_id: B, nome: 'Loja B', parcelas: 0, valor: 0, clientes: 0, carnes: 0 },
    ]);
    const q = consultas.find((c) => /GROUP BY ci\.company_id/i.test(c.s));
    expect(q.params[0]).toEqual([A, B]);
    somenteLeitura();
  });

  test('so entram lojas com o crediario ligado', async () => {
    banco({ donas: [A, B], habilitadas: [B], lojas: [] });
    const r = await request(appMe())
      .get('/api/v1/me/credit/installments/resumo-vencimento')
      .set('Authorization', token());
    expect(r.body.company_count).toBe(1);
    expect(r.body.empresas.map((e) => e.company_id)).toEqual([B]);
  });

  test('sem nenhuma loja com crediario: zeros sem consultar parcelas', async () => {
    banco({ donas: [A], habilitadas: [] });
    const r = await request(appMe())
      .get('/api/v1/me/credit/installments/resumo-vencimento')
      .set('Authorization', token());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ parcelas: 0, valor: 0, empresas: [], company_count: 0, consolidated: true });
    expect(consultas.some((c) => /credit_installments/.test(c.s))).toBe(false);
  });

  test('plano sem crediario: 403; sem login: 401', async () => {
    banco();
    let r = await request(appMe())
      .get('/api/v1/me/credit/installments/resumo-vencimento')
      .set('Authorization', token({ role: 'owner', plan: 'essencial' }));
    expect(r.status).toBe(403);
    r = await request(appMe()).get('/api/v1/me/credit/installments/resumo-vencimento');
    expect(r.status).toBe(401);
  });
});
