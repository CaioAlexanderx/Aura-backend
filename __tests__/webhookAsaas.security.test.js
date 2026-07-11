// ============================================================
// Testes de segurança — POST /webhooks/asaas (rota pública, sem auth)
//
// Cobre a correção fail-closed / reverificação server-to-server descrita
// no topo de src/routes/webhookAsaas.js (ver também PR do webhookMp.js e
// PR #360, referência de padrão pro webhook de pagamento do karatê).
//
//   (a) segredo configurado + token inválido -> 401, ZERO mutação
//       (nenhuma query de billing é sequer executada).
//   (b) segredo ausente + evento forjado -> reverificação server-to-server
//       falha (Asaas não confirma o payment.id) -> ZERO mutação.
//   (c) evento legítimo continua sendo processado — testado nos dois
//       regimes: com segredo válido (fluxo antigo, confia no body após
//       validar o token) e sem segredo (fluxo novo, usa exclusivamente o
//       que a API do Asaas devolve pro payment.id informado).
//
// ASAAS_WEBHOOK_SECRET é lido 1x no module-load (const de topo do
// arquivo), então cada regime (com/sem segredo) precisa de um require()
// fresco do módulo de rota, com o env var setado ANTES do require.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

function buildApp({ secret } = {}) {
  jest.resetModules();

  if (secret === undefined) {
    delete process.env.ASAAS_WEBHOOK_SECRET;
  } else {
    process.env.ASAAS_WEBHOOK_SECRET = secret;
  }

  jest.doMock('../src/config/database');
  jest.doMock('../src/services/asaasClient', () => ({ asaas: jest.fn() }));
  jest.doMock('../src/services/digitalOrderNotifications', () => ({
    notifyPaymentConfirmed: jest.fn().mockResolvedValue(undefined),
  }));

  const db          = require('../src/config/database');
  const asaasClient = require('../src/services/asaasClient');
  const route        = require('../src/routes/webhookAsaas');

  const app = express();
  app.use(express.json());
  app.use('/webhooks/asaas', route);

  return { app, db, asaasClient };
}

// Query que muta billing_status — usada pra provar "zero mutação".
const UPDATE_COMPANIES_RE = /UPDATE\s+companies/i;

function mockCompanyLookupAndUpdate(db, companyRow) {
  db.query.mockImplementation((sql) => {
    if (/SELECT id, plan, billing_status, is_primary FROM companies/i.test(sql)) {
      return Promise.resolve({ rows: companyRow ? [companyRow] : [] });
    }
    if (UPDATE_COMPANIES_RE.test(sql)) {
      return Promise.resolve({ rowCount: 1 });
    }
    if (/INSERT INTO webhook_logs/i.test(sql)) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

afterEach(() => {
  delete process.env.ASAAS_WEBHOOK_SECRET;
  jest.resetModules();
});

describe('POST /webhooks/asaas — segredo configurado', () => {
  const SECRET = 'segredo-de-teste-asaas-abc123';

  it('(a) token inválido -> 401, ZERO mutação (nenhuma query de billing)', async () => {
    const { app, db } = buildApp({ secret: SECRET });
    mockCompanyLookupAndUpdate(db, { id: 'company-1', plan: 'negocio', billing_status: 'trial', is_primary: false });

    const res = await request(app)
      .post('/webhooks/asaas')
      .set('asaas-access-token', 'token-completamente-errado')
      .send({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1', customer: 'cus_1' } });

    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('(a2) sem header nenhum -> 401, ZERO mutação', async () => {
    const { app, db } = buildApp({ secret: SECRET });
    mockCompanyLookupAndUpdate(db, { id: 'company-1', plan: 'negocio', billing_status: 'trial', is_primary: false });

    const res = await request(app)
      .post('/webhooks/asaas')
      .send({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1', customer: 'cus_1' } });

    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('(c) token válido + evento legítimo -> processa normalmente e atualiza billing_status', async () => {
    const { app, db } = buildApp({ secret: SECRET });
    mockCompanyLookupAndUpdate(db, { id: 'company-1', plan: 'negocio', billing_status: 'trial', is_primary: false });

    const res = await request(app)
      .post('/webhooks/asaas')
      .set('asaas-access-token', SECRET)
      .send({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1', customer: 'cus_1', paymentDate: '2026-07-11' } });

    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(true);
    expect(res.body.status).toBe('active');

    const updateCall = db.query.mock.calls.find((c) => UPDATE_COMPANIES_RE.test(c[0]));
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][0]).toBe('active'); // newStatus
    expect(updateCall[1][4]).toBe('company-1'); // company.id
  });
});

describe('POST /webhooks/asaas — segredo AUSENTE (modo reverificação server-to-server)', () => {
  it('(b) evento forjado (payment.id inventado) -> Asaas não confirma -> ZERO mutação', async () => {
    const { app, db, asaasClient } = buildApp({ secret: undefined });
    mockCompanyLookupAndUpdate(db, { id: 'company-1', plan: 'negocio', billing_status: 'trial', is_primary: false });
    asaasClient.asaas.mockRejectedValueOnce(new Error('Asaas error 404'));

    const res = await request(app)
      .post('/webhooks/asaas')
      // nenhum header de auth — não há segredo pra apresentar
      .send({
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_forjado_inexistente', customer: 'cus_alvo', externalReference: null, status: 'CONFIRMED' },
      });

    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(false);
    expect(res.body.reason).toBe('no_secret_reverification_failed');

    // Prova de zero mutação: a API do Asaas foi consultada (payment.id do
    // body só serve de CHAVE de busca), mas nenhuma UPDATE companies rodou.
    expect(asaasClient.asaas).toHaveBeenCalledWith('GET', expect.stringContaining('pay_forjado_inexistente'));
    const updateCall = db.query.mock.calls.find((c) => UPDATE_COMPANIES_RE.test(c[0]));
    expect(updateCall).toBeFalsy();
  });

  it('(b2) evento forjado reivindicando status CONFIRMED, mas Asaas diz que o pagamento real está PENDING -> ZERO mutação', async () => {
    // Ataque mais sutil: o payment.id EXISTE de verdade (então a reverificação
    // não falha), mas o body mente sobre o status pra tentar forçar
    // billing_status=active antes da hora. Como usamos SOMENTE o status
    // devolvido pela API (nunca o do body) no modo sem segredo, PENDING não
    // tem entrada em ASAAS_STATUS_TO_BILLING -> newStatus fica undefined ->
    // "event_ignored", zero UPDATE.
    const { app, db, asaasClient } = buildApp({ secret: undefined });
    mockCompanyLookupAndUpdate(db, { id: 'company-1', plan: 'negocio', billing_status: 'trial', is_primary: false });
    asaasClient.asaas.mockResolvedValueOnce({
      id: 'pay_real_mas_pendente', status: 'PENDING', customer: 'cus_alvo', externalReference: null,
    });

    const res = await request(app)
      .post('/webhooks/asaas')
      .send({
        event: 'PAYMENT_CONFIRMED', // mentira do body
        payment: { id: 'pay_real_mas_pendente', customer: 'cus_alvo', status: 'CONFIRMED' }, // mentira do body
      });

    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(false);

    const updateCall = db.query.mock.calls.find((c) => UPDATE_COMPANIES_RE.test(c[0]));
    expect(updateCall).toBeFalsy();
  });

  it('(c) evento legítimo (Asaas confirma CONFIRMED de verdade) -> billing continua sendo reconciliado mesmo sem o segredo', async () => {
    const { app, db, asaasClient } = buildApp({ secret: undefined });
    mockCompanyLookupAndUpdate(db, { id: 'company-1', plan: 'negocio', billing_status: 'trial', is_primary: false });
    asaasClient.asaas.mockResolvedValueOnce({
      id: 'pay_real_1', status: 'CONFIRMED', customer: 'cus_real_1', externalReference: null, paymentDate: '2026-07-11',
    });

    const res = await request(app)
      .post('/webhooks/asaas')
      .send({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_real_1' } });

    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(true);
    expect(res.body.status).toBe('active');

    const updateCall = db.query.mock.calls.find((c) => UPDATE_COMPANIES_RE.test(c[0]));
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][0]).toBe('active');
  });

  it('ASAAS_API_KEY também ausente (asaasClient lança) -> reverificação falha -> ZERO mutação', async () => {
    const { app, db, asaasClient } = buildApp({ secret: undefined });
    mockCompanyLookupAndUpdate(db, { id: 'company-1', plan: 'negocio', billing_status: 'trial', is_primary: false });
    asaasClient.asaas.mockRejectedValueOnce(new Error('ASAAS_API_KEY nao configurada'));

    const res = await request(app)
      .post('/webhooks/asaas')
      .send({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_qualquer' } });

    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(false);
    const updateCall = db.query.mock.calls.find((c) => UPDATE_COMPANIES_RE.test(c[0]));
    expect(updateCall).toBeFalsy();
  });
});
