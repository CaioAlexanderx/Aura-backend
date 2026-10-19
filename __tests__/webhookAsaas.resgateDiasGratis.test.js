// ============================================================
// Resgate existente de cupom de dias gratis x webhook da Asaas (19/10/2026)
//
// A campanha PRIMEIROMES foi removida, mas o Caio decidiu MANTER a promocao
// para quem ja resgatou: assinatura com a 1a cobranca em 01/12/2026,
// billing_status='trial' e trial_ends_at=2026-12-01. Nada do webhook pode
// reescrever trial_ends_at (nem empurrar next_billing_date para tras) por
// causa da remocao. O caso aqui e generico (qualquer cupom de dias gratis),
// com as datas do resgate real.
//
// ASAAS_WEBHOOK_SECRET e lido no carregamento do modulo, dai o require fresco
// por teste (mesmo padrao de webhookAsaas.vencimento.test.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const SECRET = 'segredo-de-teste-asaas-resgate';
const EMPRESA = 'bbbbbbbb-0000-4000-8000-000000000001';
const ASSINATURA = 'sub_resgate_1';

function buildApp() {
  jest.resetModules();
  process.env.ASAAS_WEBHOOK_SECRET = SECRET;
  jest.doMock('../src/config/database');
  jest.doMock('../src/services/asaasClient', () => ({ asaas: jest.fn() }));
  jest.doMock('../src/services/digitalOrderNotifications', () => ({
    notifyPaymentConfirmed: jest.fn().mockResolvedValue(undefined),
  }));
  const db = require('../src/config/database');
  const { asaas } = require('../src/services/asaasClient');
  const app = express();
  app.use(express.json());
  app.use('/webhooks/asaas', require('../src/routes/webhookAsaas'));
  return { app, db, asaas };
}

// Empresa que resgatou o cupom: em trial ate 01/12 com a assinatura agendada.
const empresaComResgate = () => ({
  id: EMPRESA, plan: 'negocio', billing_status: 'trial', is_primary: false,
  asaas_subscription_id: ASSINATURA,
});

function ligarBanco(db) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM companies WHERE asaas_customer_id/i.test(sql)) return { rows: [empresaComResgate()] };
    return { rows: [], rowCount: 1 };
  });
  return {
    escritasEmCompanies: () => db.query.mock.calls
      .map(([sql, params]) => ({ sql, params }))
      .filter(({ sql }) => /UPDATE\s+companies/i.test(sql)),
  };
}

// A cobranca agendada pela assinatura: vence em 01/12/2026.
const cobranca = (extra) => ({
  id: 'pay_resgate_1', customer: 'cus_resgate', subscription: ASSINATURA, value: 140.83,
  dueDate: '2026-12-01', status: 'PENDING', externalReference: EMPRESA, ...extra,
});
const enviar = (app, body) => request(app).post('/webhooks/asaas').set('asaas-access-token', SECRET).send(body);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.ASAAS_WEBHOOK_SECRET;
  jest.restoreAllMocks();
  jest.resetModules();
});

describe('empresa com resgate de dias gratis: o webhook nao mexe no trial', () => {
  test('PAYMENT_CREATED da cobranca de 01/12: so registra, nenhuma escrita em companies', async () => {
    const { app, db } = buildApp();
    const banco = ligarBanco(db);

    const res = await enviar(app, { event: 'PAYMENT_CREATED', payment: cobranca() });

    expect(res.body).toMatchObject({ handled: true, status_changed: false, status: 'trial', event_neutral: 'PAYMENT_CREATED' });
    expect(banco.escritasEmCompanies()).toEqual([]);
  });

  test('evento de assinatura (SUBSCRIPTION_UPDATED) e ignorado: trial e datas ficam como estao', async () => {
    const { app, db } = buildApp();
    const banco = ligarBanco(db);

    const res = await enviar(app, { event: 'SUBSCRIPTION_UPDATED', payment: cobranca() });

    expect(res.body).toMatchObject({ received: true, handled: false });
    expect(banco.escritasEmCompanies()).toEqual([]);
  });

  test('PAYMENT_CONFIRMED em 01/12: vira active, mas nenhum UPDATE toca em trial_ends_at', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db);
    asaas.mockImplementation(async (metodo, caminho) => {
      if (/\/payments\?/.test(caminho)) return { data: [] };
      if (caminho === '/subscriptions/' + ASSINATURA) return { id: ASSINATURA, status: 'ACTIVE', nextDueDate: '2027-01-01' };
      return undefined;
    });

    const res = await enviar(app, {
      event: 'PAYMENT_CONFIRMED',
      payment: cobranca({ status: 'CONFIRMED', paymentDate: '2026-12-01' }),
    });

    expect(res.body).toMatchObject({ handled: true, status: 'active', next_billing_date: '2027-01-01' });
    const escritas = banco.escritasEmCompanies();
    expect(escritas.length).toBeGreaterThan(0);
    for (const { sql } of escritas) {
      expect(sql).not.toMatch(/trial_ends_at/i);
      expect(sql).not.toMatch(/trial_mode/i);
    }
    // next_billing_date anda para a data da Asaas (01/01), nunca volta para o dueDate pago.
    const datas = escritas.flatMap(({ params }) => params).filter((p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p));
    expect(datas).toContain('2027-01-01');
  });
});

describe('a regra do trial nao encurta a data de quem resgatou', () => {
  test('a primeira venda so inicia o trial de quem esta em primeira_venda e sem assinatura', () => {
    const { SQL_INICIAR, MODO_PRIMEIRA_VENDA } = jest.requireActual('../src/services/trialRegra');
    expect(SQL_INICIAR).toContain(`trial_mode = '${MODO_PRIMEIRA_VENDA}'`);
    expect(SQL_INICIAR).toContain('asaas_subscription_id IS NULL');
  });
});
