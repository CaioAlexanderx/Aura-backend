// ============================================================
// POST /webhooks/asaas — próximo vencimento e pagamento sem loja (13/10/2026)
//
// O webhook gravava next_billing_date = payment.dueDate: o vencimento da
// cobrança que acabou de ser PAGA. Agora a data vem da Asaas
// (services/asaasAssinaturas → proximoVencimento) e o dueDate do pagamento
// nunca mais entra na coluna.
//
// ASAAS_WEBHOOK_SECRET é lido no carregamento do módulo, daí o require fresco
// por teste (mesmo padrão de webhookAsaas.security.test.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const SECRET = 'segredo-de-teste-asaas-abc123';
const EMPRESA = 'aaaaaaaa-0000-4000-8000-000000000001';

function buildApp({ secret = SECRET } = {}) {
  jest.resetModules();
  if (secret === null) delete process.env.ASAAS_WEBHOOK_SECRET;
  else process.env.ASAAS_WEBHOOK_SECRET = secret;

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

// Banco: devolve a empresa (ou nenhuma) e guarda tudo o que foi escrito.
function ligarBanco(db, empresa) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM companies WHERE asaas_customer_id/i.test(sql)) return { rows: empresa ? [empresa] : [] };
    return { rows: [], rowCount: 1 };
  });
  const chamada = (re) => db.query.mock.calls.find(([sql]) => re.test(sql));
  return {
    update: () => chamada(/UPDATE\s+companies\s+SET billing_status/i),
    log: () => chamada(/INSERT INTO webhook_logs/i),
  };
}

// Asaas: responde por caminho. `assinatura`/`cobrancas` podem ser um Error.
function ligarAsaas(asaas, { assinatura, cobrancas = { data: [] }, pagamento } = {}) {
  asaas.mockImplementation(async (metodo, caminho) => {
    const r = /\/payments\?/.test(caminho) ? cobrancas
      : caminho.startsWith('/subscriptions/') ? assinatura
        : caminho.startsWith('/payments/') ? pagamento
          : undefined;
    if (r instanceof Error) throw r;
    return r;
  });
}

const empresa = (extra) => ({
  id: EMPRESA, plan: 'negocio', billing_status: 'active', is_primary: false, asaas_subscription_id: 'sub_1', ...extra,
});
// Cobrança de 15/09 paga em 15/09: o caso da Encanto Presentes.
const pagamento = (extra) => ({
  id: 'pay_1', customer: 'cus_1', subscription: 'sub_1', value: 140.83,
  dueDate: '2026-09-15', paymentDate: '2026-09-15', status: 'RECEIVED', externalReference: EMPRESA, ...extra,
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

describe('pagamento recebido: next_billing_date é o próximo vencimento', () => {
  test('grava o nextDueDate da assinatura, não o dueDate da cobrança paga', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, empresa());
    ligarAsaas(asaas, { assinatura: { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-10-15' } });

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento() });

    expect(res.body).toMatchObject({ handled: true, status: 'active', next_billing_date: '2026-10-15' });
    expect(asaas).toHaveBeenCalledWith('GET', '/subscriptions/sub_1');
    const [sql, params] = banco.update();
    expect(sql).toContain('next_billing_date = COALESCE($4, next_billing_date)');
    // status, pago?, last_payment_date, next_billing_date, empresa
    expect(params).toEqual(['active', true, '2026-09-15', '2026-10-15', EMPRESA]);
  });

  test('cobrança do próximo ciclo já criada (40 dias antes): vale a pendente, não o nextDueDate', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, empresa());
    ligarAsaas(asaas, {
      // a Asaas já criou a de 15/10 e empurrou o nextDueDate para 15/11
      assinatura: { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-11-15' },
      cobrancas: { data: [
        { id: 'pay_1', status: 'RECEIVED', dueDate: '2026-09-15' },
        { id: 'pay_2', status: 'PENDING', dueDate: '2026-10-15' },
      ] },
    });

    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento() });

    expect(banco.update()[1][3]).toBe('2026-10-15');
  });

  test('a Asaas não responde: next_billing_date não é gravado, e o dueDate não entra no lugar', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, empresa());
    ligarAsaas(asaas, { assinatura: new Error('Asaas error 503') });

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento() });

    expect(res.body).toMatchObject({ handled: true, status: 'active', next_billing_date: null });
    const [, params] = banco.update();
    expect(params[3]).toBeNull(); // COALESCE($4, next_billing_date) preserva o que estava
    expect(params[2]).toBe('2026-09-15'); // last_payment_date continua avançando
    expect(params).not.toContain('2026-10-15');
  });

  test('o dueDate da cobrança paga nunca vira next_billing_date, em evento nenhum', async () => {
    for (const event of ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_OVERDUE', 'PAYMENT_REFUNDED']) {
      const { app, db, asaas } = buildApp();
      const banco = ligarBanco(db, empresa());
      ligarAsaas(asaas, { assinatura: { id: 'sub_1', status: 'ACTIVE' } }); // sem nextDueDate
      await enviar(app, { event, payment: pagamento({ dueDate: '2026-09-15', paymentDate: null }) });
      expect(banco.update()[1][3]).toBeNull();
      expect(banco.update()[1]).not.toContain('2026-09-15');
    }
  });

  test('evento que não é dinheiro recebido não consulta a assinatura', async () => {
    const { app, db, asaas } = buildApp();
    ligarBanco(db, empresa());
    ligarAsaas(asaas, { assinatura: { id: 'sub_1', nextDueDate: '2026-10-15' } });
    await enviar(app, { event: 'PAYMENT_OVERDUE', payment: pagamento({ status: 'OVERDUE' }) });
    expect(asaas).not.toHaveBeenCalled();
  });

  test('empresa sem asaas_subscription_id usa a assinatura que veio no pagamento', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, empresa({ asaas_subscription_id: null }));
    ligarAsaas(asaas, { assinatura: { id: 'sub_9', status: 'ACTIVE', nextDueDate: '2026-10-20' } });
    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento({ subscription: 'sub_9' }) });
    expect(asaas).toHaveBeenCalledWith('GET', '/subscriptions/sub_9');
    expect(banco.update()[1][3]).toBe('2026-10-20');
  });

  test('sem segredo (reverificação): o próximo vencimento também vem da Asaas', async () => {
    const { app, db, asaas } = buildApp({ secret: null });
    const banco = ligarBanco(db, empresa());
    ligarAsaas(asaas, {
      pagamento: pagamento(),
      assinatura: { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-10-15' },
    });
    await request(app).post('/webhooks/asaas').send({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } });
    expect(banco.update()[1]).toEqual(['active', true, '2026-09-15', '2026-10-15', EMPRESA]);
  });
});

describe('pagamento sem loja', () => {
  test('fica em webhook_logs com company_id nulo e não muda empresa nenhuma', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, null);
    ligarAsaas(asaas, {});

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento({ customer: 'cus_orfao' }) });

    expect(res.body).toEqual({ received: true, company_found: false });
    const [, params] = banco.log();
    expect(params[0]).toBeNull();
    expect(params[1]).toBe('PAYMENT_RECEIVED');
    expect(JSON.parse(params[2])).toMatchObject({ customer: 'cus_orfao', value: 140.83 });
    expect(banco.update()).toBeUndefined();
    expect(asaas).not.toHaveBeenCalled();
  });

  test('externalReference que não é UUID não entra na busca por id', async () => {
    const { app, db, asaas } = buildApp();
    ligarBanco(db, null);
    ligarAsaas(asaas, {});
    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento({ externalReference: 'pedido 123' }) });
    const [, params] = db.query.mock.calls.find(([sql]) => /FROM companies WHERE asaas_customer_id/i.test(sql));
    expect(params).toEqual(['cus_1', null]);
  });
});
