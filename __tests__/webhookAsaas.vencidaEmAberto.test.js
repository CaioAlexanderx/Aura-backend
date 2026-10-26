// ============================================================
// POST /webhooks/asaas — pagamento confirmado com outra cobrança vencida
// em aberto (26/10/2026, caso SHEID MANIA)
//
// A cobrança de 21/10 estava OVERDUE; em 23/10 chegou PAYMENT_RECEIVED da
// cobrança de 21/09 (cartão confirmado em 21/09, creditado em 23/10) e o
// webhook gravou 'active' por cima do atraso. Regra: pagamento confirmado só
// leva a 'active' se, fora a cobrança paga, não sobrar outra OVERDUE da
// empresa. Fonte: a Asaas (GET /payments?customer=...&status=OVERDUE); se a
// leitura falhar, o espelho assinatura_cobrancas.
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
const ESPELHO_RE = /SELECT asaas_payment_id AS id, to_char\(due_date, 'YYYY-MM-DD'\) AS vencimento FROM assinatura_cobrancas/;

// espelho: linhas OVERDUE do espelho (já sem a cobrança paga, como o SQL
// filtra), ou um Error para "tabela indisponível".
function ligarBanco(db, { empresa, espelho = [] } = {}) {
  db.query.mockImplementation(async (sql, params) => {
    const s = limpo(sql);
    if (/FROM companies WHERE asaas_customer_id/i.test(s)) return { rows: [empresa] };
    if (ESPELHO_RE.test(s)) {
      if (espelho instanceof Error) throw espelho;
      return { rows: espelho.filter((l) => l.id !== params[1]) };
    }
    if (s.includes('FROM companies c LEFT JOIN users u ON u.id = c.owner_id')) {
      return { rows: [{ id: EMPRESA, loja: 'Sheid', company_email: null, is_active: true, is_sandbox: false, user_id: 'u1', user_email: 'dona@exemplo.com', full_name: 'Dona', is_staff: false }] };
    }
    if (s.startsWith('INSERT INTO email_log')) return { rows: [{ id: 'log1' }] };
    if (s.startsWith('INSERT INTO assinatura_cobrancas')) {
      return { rows: [{ asaas_payment_id: params[0], status: params[3], due_iso: params[4], retentativa_em: null }] };
    }
    return { rows: [], rowCount: 1 };
  });
  const achar = (re) => db.query.mock.calls.filter(([sql]) => re.test(limpo(sql)));
  return {
    update: () => achar(/^UPDATE companies SET billing_status = \$1, last_payment_date/)[0],
    filiais: () => achar(/UPDATE companies SET billing_status = \$1, updated_at = NOW\(\) WHERE billing_owner_company_id/)[0],
    log: () => achar(/^INSERT INTO webhook_logs/)[0],
    espelho: () => achar(ESPELHO_RE),
    ordem: () => db.query.mock.calls.map(([sql]) => limpo(sql)),
  };
}

// Asaas por caminho. vencidas: lista de cobranças OVERDUE do cliente (ou Error).
function ligarAsaas(asaas, { vencidas = [], pagamento } = {}) {
  asaas.mockImplementation(async (metodo, caminho) => {
    if (caminho.startsWith('/payments?customer=')) {
      if (vencidas instanceof Error) throw vencidas;
      return { data: vencidas, hasMore: false };
    }
    if (/\/payments\?status=/.test(caminho)) return { data: [] };
    if (caminho === '/subscriptions/sub_1') return { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-11-21' };
    if (caminho.startsWith('/payments/') && caminho.endsWith('/pixQrCode')) throw new Error('sem pix');
    if (caminho.startsWith('/payments/')) return pagamento;
    return undefined;
  });
}

const hoje = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const empresa = (extra) => ({ id: EMPRESA, plan: 'negocio', billing_status: 'overdue', is_primary: false, asaas_subscription_id: 'sub_1', ...extra });
// A cobrança de 21/09, creditada hoje.
const pagamentoAntigo = (extra) => ({
  id: 'pay_setembro', customer: 'cus_sheid', subscription: 'sub_1', value: 99.9, billingType: 'CREDIT_CARD',
  dueDate: '2026-09-21', paymentDate: hoje(), status: 'RECEIVED', externalReference: EMPRESA, ...extra,
});
const vencidaDeOutubro = { id: 'pay_2decv65ik9buvp6x', status: 'OVERDUE', dueDate: '2026-10-21', externalReference: EMPRESA };
const enviar = (app, body) => request(app).post('/webhooks/asaas').set('asaas-access-token', SECRET).send(body);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ASAAS_WEBHOOK_SECRET;
});

describe('pagamento confirmado e outras cobranças vencidas', () => {
  test('pagamento da cobrança antiga com outra vencida em aberto: continua overdue, e o pagamento é registrado', async () => {
    const { app, db, asaas, mailer } = buildApp();
    const banco = ligarBanco(db, { empresa: empresa() });
    ligarAsaas(asaas, { vencidas: [vencidaDeOutubro] });

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamentoAntigo() });

    expect(res.body).toMatchObject({ handled: true, status: 'overdue', overdue_remaining: 1, overdue_source: 'asaas' });
    expect(asaas).toHaveBeenCalledWith('GET', '/payments?customer=cus_sheid&status=OVERDUE&limit=100');
    const [, params] = banco.update();
    expect(params[0]).toBe('overdue');
    expect(params[1]).toBe(true); // last_payment_date avança: o dinheiro entrou
    expect(params[2]).toBe(hoje());
    expect(params[3]).toBe('2026-10-21'); // o vencimento não passa da vencida
    expect(banco.log()).toBeTruthy();
    // Recibo do pagamento continua saindo.
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('fica overdue'));
    // A Asaas respondeu: o espelho não decide.
    expect(banco.espelho()).toHaveLength(0);
  });

  test('pagamento da única vencida: vira active', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, { empresa: empresa() });
    // A Asaas ainda lista a própria cobrança paga como vencida: ela não conta.
    ligarAsaas(asaas, { vencidas: [{ ...vencidaDeOutubro, id: 'pay_setembro' }] });

    const res = await enviar(app, { event: 'PAYMENT_CONFIRMED', payment: pagamentoAntigo({ status: 'CONFIRMED' }) });

    expect(res.body).toMatchObject({ handled: true, status: 'active' });
    expect(res.body.overdue_remaining).toBeUndefined();
    expect(banco.update()[1][0]).toBe('active');
  });

  test('pagamento sem nenhuma vencida: vira active', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, { empresa: empresa({ billing_status: 'active' }) });
    ligarAsaas(asaas, { vencidas: [] });

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamentoAntigo() });

    expect(res.body).toMatchObject({ handled: true, status: 'active', next_billing_date: '2026-11-21' });
    expect(banco.update()[1][0]).toBe('active');
  });

  test('vencida de pacote de marketing ou pedido do Canal Digital não segura a assinatura', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, { empresa: empresa() });
    ligarAsaas(asaas, { vencidas: [
      { id: 'pay_pack', status: 'OVERDUE', dueDate: '2026-10-01', externalReference: 'wa-pack-123' },
      { id: 'pay_ped', status: 'OVERDUE', dueDate: '2026-10-02', externalReference: 'digital-order-abc' },
    ] });

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamentoAntigo() });

    expect(res.body.status).toBe('active');
    expect(banco.update()[1][0]).toBe('active');
  });

  test('Asaas indisponível: decide pelo espelho, sem contar a cobrança que acabou de ser paga', async () => {
    const { app, db, asaas } = buildApp();
    // O espelho ainda tem a paga como OVERDUE (ele só é atualizado depois do
    // UPDATE em companies) e a de 21/10 vencida.
    const banco = ligarBanco(db, { empresa: empresa(), espelho: [
      { id: 'pay_setembro', vencimento: '2026-09-21' },
      { id: 'pay_2decv65ik9buvp6x', vencimento: '2026-10-21' },
    ] });
    ligarAsaas(asaas, { vencidas: new Error('Asaas error 503') });

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamentoAntigo() });

    expect(res.body).toMatchObject({ status: 'overdue', overdue_remaining: 1, overdue_source: 'espelho' });
    const [, params] = banco.espelho()[0];
    expect(params).toEqual([EMPRESA, 'pay_setembro']);
    expect(banco.update()[1][0]).toBe('overdue');
  });

  test('Asaas indisponível e só a cobrança paga no espelho: vira active', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, { empresa: empresa(), espelho: [{ id: 'pay_setembro', vencimento: '2026-09-21' }] });
    ligarAsaas(asaas, { vencidas: new Error('Asaas error 503') });

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamentoAntigo() });

    expect(res.body.status).toBe('active');
    expect(banco.update()[1][0]).toBe('active');
  });

  test('espelho vazio e Asaas indisponível: comportamento de antes (active), com o motivo no log', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, { empresa: empresa(), espelho: [] });
    ligarAsaas(asaas, { vencidas: new Error('Asaas error 503') });

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamentoAntigo() });

    expect(res.body).toMatchObject({ handled: true, status: 'active' });
    expect(banco.update()[1][0]).toBe('active');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('sem confirmacao da Asaas'));
  });

  test('espelho sem a tabela e Asaas indisponível: active, com o motivo no log', async () => {
    const { app, db, asaas } = buildApp();
    const erro = Object.assign(new Error('relation "assinatura_cobrancas" does not exist'), { code: '42P01' });
    const banco = ligarBanco(db, { empresa: empresa(), espelho: erro });
    ligarAsaas(asaas, { vencidas: new Error('Asaas error 503') });

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamentoAntigo() });

    expect(res.body.status).toBe('active');
    expect(banco.update()[1][0]).toBe('active');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('espelho tambem esta indisponivel'));
  });

  test('filiais: a propagação segue a mesma decisão (overdue)', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, { empresa: empresa({ is_primary: true }) });
    ligarAsaas(asaas, { vencidas: [vencidaDeOutubro] });

    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamentoAntigo() });

    const [, params] = banco.filiais();
    expect(params).toEqual(['overdue', EMPRESA]);
  });

  test('filiais: sem vencida, propaga active', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, { empresa: empresa({ is_primary: true }) });
    ligarAsaas(asaas, { vencidas: [] });

    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamentoAntigo() });

    expect(banco.filiais()[1]).toEqual(['active', EMPRESA]);
  });

  test('sem segredo (reverificação): a mesma regra vale para o status relido na Asaas', async () => {
    const { app, db, asaas } = buildApp({ secret: null });
    const banco = ligarBanco(db, { empresa: empresa() });
    ligarAsaas(asaas, { vencidas: [vencidaDeOutubro], pagamento: pagamentoAntigo() });

    const res = await request(app).post('/webhooks/asaas').send({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_setembro' } });

    expect(res.body.status).toBe('overdue');
    expect(banco.update()[1][0]).toBe('overdue');
  });

  test('PAYMENT_OVERDUE, REFUNDED e CHARGEBACK não consultam as vencidas e seguem como antes', async () => {
    const casos = [
      ['PAYMENT_OVERDUE', 'overdue'],
      ['PAYMENT_REFUNDED', 'refunded'],
      ['PAYMENT_CHARGEBACK_REQUESTED', 'chargeback'],
    ];
    for (const [event, status] of casos) {
      const { app, db, asaas } = buildApp();
      const banco = ligarBanco(db, { empresa: empresa({ billing_status: 'active' }) });
      ligarAsaas(asaas, { vencidas: [vencidaDeOutubro] });
      const res = await enviar(app, { event, payment: pagamentoAntigo({ paymentDate: null }) });
      expect(res.body.status).toBe(status);
      expect(banco.update()[1][0]).toBe(status);
      expect(asaas).not.toHaveBeenCalledWith('GET', expect.stringContaining('/payments?customer='));
      expect(banco.espelho()).toHaveLength(0);
    }
  });

  test('PAYMENT_DELETED continua neutro: não muda billing_status nem consulta as vencidas', async () => {
    const { app, db, asaas } = buildApp();
    const banco = ligarBanco(db, { empresa: empresa({ billing_status: 'active' }) });
    ligarAsaas(asaas, { vencidas: [vencidaDeOutubro] });
    const res = await enviar(app, { event: 'PAYMENT_DELETED', payment: pagamentoAntigo({ paymentDate: null }) });
    expect(res.body).toMatchObject({ status_changed: false, status: 'active' });
    expect(banco.update()).toBeUndefined();
    expect(asaas).not.toHaveBeenCalledWith('GET', expect.stringContaining('/payments?customer='));
  });
});
