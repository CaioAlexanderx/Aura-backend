// ============================================================
// POST /webhooks/asaas — e-mails e espelho da assinatura (24/10/2026)
//
//   - PAYMENT_CREDIT_CARD_CAPTURE_REFUSED (tq-84): registrado, NÃO muda o
//     billing_status, manda o 2.8; sem o segredo (body não confiável) é
//     ignorado
//   - PAYMENT_RECEIVED: recibo pelo serviço, resposta igual à de antes
//   - tq-86: pagar a cobrança nova com uma vencida mais antiga em aberto não
//     empurra next_billing_date além da vencida
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
  jest.doMock('../src/services/digitalOrderNotifications', () => ({ notifyPaymentConfirmed: jest.fn() }));
  jest.doMock('../src/services/mailer', () => ({
    ...jest.requireActual('../src/services/mailer'),
    sendMail: jest.fn().mockResolvedValue({ id: 're_1' }),
  }));
  const db = require('../src/config/database');
  const { asaas } = require('../src/services/asaasClient');
  const mailer = require('../src/services/mailer');
  const app = express();
  app.use(express.json());
  app.use('/webhooks/asaas', require('../src/routes/webhookAsaas'));
  return { app, db, asaas, mailer };
}

const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();

function ligarBanco(db, { empresa, vencidaMaisAntiga = null } = {}) {
  db.query.mockImplementation(async (sql, params) => {
    const s = limpo(sql);
    if (/FROM companies WHERE asaas_customer_id/i.test(s)) return { rows: empresa ? [empresa] : [] };
    if (s.includes('FROM companies c LEFT JOIN users u ON u.id = c.owner_id')) {
      return { rows: [{ id: EMPRESA, loja: 'Modas da Maria', company_email: null, is_active: true, is_sandbox: false, user_id: 'u1', user_email: 'maria@exemplo.com', full_name: 'Maria', is_staff: false }] };
    }
    if (s.startsWith('INSERT INTO email_log')) return { rows: [{ id: 'log1' }] };
    if (s.startsWith('INSERT INTO assinatura_cobrancas')) {
      return { rows: [{ asaas_payment_id: params[0], status: params[3], due_iso: params[4], retentativa_em: null }] };
    }
    if (s.includes("FROM assinatura_cobrancas WHERE company_id = $1 AND status = 'OVERDUE'")) {
      return { rows: [{ venc: vencidaMaisAntiga }] };
    }
    return { rows: [], rowCount: 1 };
  });
  const achar = (re) => db.query.mock.calls.filter(([sql]) => re.test(limpo(sql)));
  return { achar };
}

const empresa = (extra) => ({ id: EMPRESA, plan: 'negocio', billing_status: 'active', is_primary: false, asaas_subscription_id: 'sub_1', ...extra });
const enviar = (app, body, comToken = true) => {
  const r = request(app).post('/webhooks/asaas');
  return (comToken ? r.set('asaas-access-token', SECRET) : r).send(body);
};
const hoje = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ASAAS_WEBHOOK_SECRET;
});

test('cartão recusado: registra, não muda billing_status e manda o 2.8', async () => {
  const { app, db, asaas, mailer } = buildApp();
  asaas.mockRejectedValue(new Error('sem pix'));
  const b = ligarBanco(db, { empresa: empresa() });
  const res = await enviar(app, {
    event: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
    payment: { id: 'pay_9', customer: 'cus_1', status: 'PENDING', value: 169, billingType: 'CREDIT_CARD', dueDate: hoje(), creditCard: { creditCardNumber: '4821' } },
  });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ handled: true, status_changed: false, event_neutral: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED' });
  expect(b.achar(/UPDATE companies SET billing_status/)).toHaveLength(0);
  expect(b.achar(/INSERT INTO webhook_logs/)).toHaveLength(1);
  expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  expect(mailer.sendMail.mock.calls[0][0]).toMatchObject({ to: 'maria@exemplo.com', subject: 'O cartão não passou na mensalidade da Aura' });
  expect(mailer.sendMail.mock.calls[0][0].text).toContain('R$ 169,00');
});

test('cartão recusado sem o segredo (body não confiável): ignorado, sem e-mail', async () => {
  const { app, db, asaas, mailer } = buildApp({ secret: null });
  asaas.mockResolvedValue({ id: 'pay_9', customer: 'cus_1', status: 'PENDING', value: 169 });
  ligarBanco(db, { empresa: empresa() });
  const res = await enviar(app, { event: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', payment: { id: 'pay_9' } }, false);
  expect(res.body).toMatchObject({ handled: false });
  expect(mailer.sendMail).not.toHaveBeenCalled();
});

test('pagamento confirmado: recibo com o valor pago na cobrança', async () => {
  const { app, db, asaas, mailer } = buildApp();
  asaas.mockImplementation(async (m, caminho) => (caminho.startsWith('/subscriptions/sub_1/payments') ? { data: [] } : { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-12-20' }));
  ligarBanco(db, { empresa: empresa({ billing_status: 'overdue' }) });
  const res = await enviar(app, {
    event: 'PAYMENT_RECEIVED',
    payment: { id: 'pay_5', customer: 'cus_1', subscription: 'sub_1', status: 'RECEIVED', value: 119, netValue: 115.5, billingType: 'PIX', dueDate: hoje(), paymentDate: hoje() },
  });
  expect(res.body).toMatchObject({ handled: true, status: 'active', next_billing_date: '2026-12-20' });
  expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  const m = mailer.sendMail.mock.calls[0][0];
  expect(m.subject).toBe('Recebi seu pagamento, obrigado!');
  expect(m.text).toContain('Valor: R$ 119,00');
  expect(m.text).not.toContain('115,50');
  expect(m.text).toContain('Próximo vencimento: 20/12/2026');
});

test('tq-86: vencida mais antiga em aberto segura o next_billing_date', async () => {
  const { app, db, asaas } = buildApp();
  asaas.mockImplementation(async (m, caminho) => (caminho.startsWith('/subscriptions/sub_1/payments') ? { data: [] } : { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-12-20' }));
  const b = ligarBanco(db, { empresa: empresa({ billing_status: 'overdue' }), vencidaMaisAntiga: '2026-10-20' });
  const res = await enviar(app, {
    event: 'PAYMENT_RECEIVED',
    payment: { id: 'pay_nova', customer: 'cus_1', subscription: 'sub_1', status: 'RECEIVED', value: 169, dueDate: '2026-11-20', paymentDate: hoje() },
  });
  expect(res.body.next_billing_date).toBe('2026-10-20');
  const segundo = b.achar(/UPDATE companies SET next_billing_date/)[0];
  expect(segundo[1]).toEqual(['2026-10-20', EMPRESA]);
});
