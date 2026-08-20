// ============================================================
// AURA DOJÔ — Testes Integração: F3b Conta Aura do dojô (BaaS Asaas opt-in)
// Cobre:
//   flag OFF → GET enabled:false + activate 503 BAAS_DISABLED
//   activate feliz (mock asaas) → 201 e apiKey NUNCA aparece na resposta
//   activate duplicado → 409 BAAS_JA_ATIVADO
//   PUT provider baas sem approved → 409 PROVIDER_NAO_DISPONIVEL
//   webhook token inválido → 401
//   PAYMENT_RECEIVED marca paga + repetido → idempotente (already_paid)
//   PAYMENT_DELETED não despaga (nenhuma escrita de status='paid')
//   pix com provider baas (mock) → payload + provider:'baas' + split no body
//
// Padrão karateDojoBilling.test.js: db.query.mockReset() em afterEach.
// A apiKey da conta-mãe (asaasRequest) e a chave de cifra são setadas ANTES
// de requerer o app.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = 'a'.repeat(64); // 32 bytes hex
process.env.ASAAS_API_KEY = 'mother-key-test';
process.env.ASAAS_DOJO_MOTHER_WALLET_ID = 'wallet-mother-aura';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, baasCrypto;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  baasCrypto = require('../../src/services/dojoBaasCrypto');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const cid = 'c1000000-0000-0000-0000-00000000000c';
const base = `/api/v1/federation/${fedId}/dojo/billing`;

const canalA = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'sensei@dojo.com.br', type: 'access', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

const validKyc = {
  person_type: 'JURIDICA',
  name: 'Dojo Aura LTDA',
  cpf_cnpj: '12345678000199',
  company_type: 'LIMITED',
  email: 'dojo@aura.com.br',
  mobile_phone: '11999998888',
  income_value: 5000,
  address: 'Rua do Karatê',
  address_number: '100',
  province: 'Centro',
  postal_code: '01001000',
};

afterEach(() => {
  db.query.mockReset();
  if (global.fetch && global.fetch.mockReset) global.fetch.mockReset();
  delete process.env.DOJO_BAAS_ENABLED;
});

const okJson = (obj) => ({ ok: true, json: async () => obj });

describe('F3b — Conta Aura do dojô (BaaS Asaas opt-in)', () => {
  test('flag OFF: GET /baas → enabled:false, status none, provider pix_manual', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // sem registro
    const res = await request(app).get(`${base}/baas`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.status).toBe('none');
    expect(res.body.provider).toBe('pix_manual');
    expect(res.body.account).toBeNull();
  });

  test('flag OFF: POST /baas/activate → 503 BAAS_DISABLED (sem tocar o banco)', async () => {
    const res = await request(app).post(`${base}/baas/activate`).set(canalA()).send(validKyc);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('BAAS_DISABLED');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('activate feliz (mock asaas) → 201 created; apiKey NUNCA na resposta', async () => {
    process.env.DOJO_BAAS_ENABLED = 'true';
    global.fetch = jest.fn().mockResolvedValueOnce(okJson({
      id: 'acc_1',
      apiKey: 'SUPER_SECRET_SUBACCOUNT_KEY',
      walletId: 'wallet_dojo_1',
      accountNumber: { agency: '0001', account: '123456', accountDigit: '7' },
    }));
    db.query
      .mockResolvedValueOnce({ rows: [] })                          // sem registro existente
      .mockResolvedValueOnce({ rows: [{ onboarding_url: null }] }); // INSERT RETURNING

    const res = await request(app).post(`${base}/baas/activate`).set(canalA()).send(validKyc);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('created');
    // a apiKey (exibida 1x pela Asaas) nunca pode vazar na resposta
    expect(JSON.stringify(res.body)).not.toContain('SUPER_SECRET_SUBACCOUNT_KEY');
    expect(res.body.api_key).toBeUndefined();
    // Asaas foi chamado em POST /accounts com webhooks[] contendo authToken + events
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/accounts');
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.webhooks[0].events).toContain('PAYMENT_RECEIVED');
    expect(typeof sentBody.webhooks[0].authToken).toBe('string');
  });

  test('activate duplicado → 409 BAAS_JA_ATIVADO (não chama Asaas)', async () => {
    process.env.DOJO_BAAS_ENABLED = 'true';
    global.fetch = jest.fn();
    db.query.mockResolvedValueOnce({ rows: [{ id: 'existing' }] }); // já existe

    const res = await request(app).post(`${base}/baas/activate`).set(canalA()).send(validKyc);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BAAS_JA_ATIVADO');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('PUT /baas/provider baas sem approved → 409 PROVIDER_NAO_DISPONIVEL', async () => {
    process.env.DOJO_BAAS_ENABLED = 'true';
    db.query.mockResolvedValueOnce({ rows: [{ status: 'under_review' }] });
    const res = await request(app).put(`${base}/baas/provider`).set(canalA()).send({ provider: 'baas' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROVIDER_NAO_DISPONIVEL');
  });

  test('webhook token inválido → 401', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // hash não encontrado
    const res = await request(app)
      .post('/api/v1/webhooks/asaas-dojo')
      .set('asaas-access-token', 'token-que-nao-existe')
      .send({ event: 'PAYMENT_RECEIVED', payment: { id: 'p1', externalReference: cid } });
    expect(res.status).toBe(401);
  });

  test('webhook PAYMENT_RECEIVED marca paga; repetido → idempotente', async () => {
    // 1ª vez: lookup conta → confirmCharge (pending→paid)
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: dojoId, status: 'approved' }] })                      // findAccountByWebhookToken
      .mockResolvedValueOnce({ rows: [{ id: cid, status: 'pending' }] })                               // confirm: SELECT status
      .mockResolvedValueOnce({ rows: [] })                                                             // confirm: UPDATE
      .mockResolvedValueOnce({ rows: [{ id: cid, competence: '2026-07', amount: '140.00', due_date: '2026-07-05', status: 'paid', paid_at: '2026-07-19', payment_method: 'pix', pix_txid: 'pay_1', student_id: 's1', student_name: 'Aluno', guardian_id: null, guardian_name: null }] }); // getChargeShaped
    const r1 = await request(app)
      .post('/api/v1/webhooks/asaas-dojo')
      .set('asaas-access-token', 'valid-token')
      .send({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', externalReference: cid } });
    expect(r1.status).toBe(200);
    expect(r1.body.handled).toBe(true);
    expect(r1.body.already_paid).toBe(false);

    db.query.mockReset();

    // 2ª vez: cobrança já paga → already_paid:true
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: dojoId, status: 'approved' }] })                      // lookup
      .mockResolvedValueOnce({ rows: [{ id: cid, status: 'paid' }] })                                  // confirm: SELECT status (paid)
      .mockResolvedValueOnce({ rows: [{ id: cid, competence: '2026-07', amount: '140.00', due_date: '2026-07-05', status: 'paid', paid_at: '2026-07-19', payment_method: 'pix', pix_txid: 'pay_1', student_id: 's1', student_name: 'Aluno', guardian_id: null, guardian_name: null }] }); // getChargeShaped
    const r2 = await request(app)
      .post('/api/v1/webhooks/asaas-dojo')
      .set('asaas-access-token', 'valid-token')
      .send({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', externalReference: cid } });
    expect(r2.status).toBe(200);
    expect(r2.body.already_paid).toBe(true);
  });

  test('webhook PAYMENT_DELETED não despaga (nenhum UPDATE status=paid)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ dojo_id: dojoId, status: 'approved' }] }); // lookup só
    const res = await request(app)
      .post('/api/v1/webhooks/asaas-dojo')
      .set('asaas-access-token', 'valid-token')
      .send({ event: 'PAYMENT_DELETED', payment: { id: 'pay_1', externalReference: cid } });
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(false);
    // só a query de lookup rodou — confirmCharge nunca foi chamado
    expect(db.query).toHaveBeenCalledTimes(1);
    const touchedPaid = db.query.mock.calls.some((c) => String(c[0]).includes("status = 'paid'"));
    expect(touchedPaid).toBe(false);
  });

  test('pix com provider baas (mock) → payload + provider:baas + split no body', async () => {
    process.env.DOJO_BAAS_ENABLED = 'true';
    const encKey = baasCrypto.encrypt('SUBACCT_KEY');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ id: 'pay_baas_1' }))                          // POST /payments
      .mockResolvedValueOnce(okJson({ payload: '000201PIXBAAS', encodedImage: 'img' })); // GET pixQrCode
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, amount: '140.00', competence: '2026-07', status: 'pending', due_date: '2026-07-10' }] }) // SELECT charge
      .mockResolvedValueOnce({ rows: [{ status: 'approved', provider_selected: 'baas', api_key_enc: encKey, wallet_id: 'wallet_dojo_1', asaas_account_id: 'acc_1' }] }); // resolveActiveBaas

    const res = await request(app).post(`${base}/charges/${cid}/pix`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('baas');
    expect(res.body.payload).toBe('000201PIXBAAS');
    // split de 0,5% pra wallet da conta-mãe no corpo do POST /payments
    const paymentsCall = global.fetch.mock.calls.find((c) => String(c[0]).includes('/payments') && c[1] && c[1].method === 'POST');
    expect(paymentsCall).toBeDefined();
    const sent = JSON.parse(paymentsCall[1].body);
    expect(sent.externalReference).toBe(cid);
    expect(sent.split).toEqual([{ walletId: 'wallet-mother-aura', percentualValue: 0.5 }]);
  });

  test('A1 — pix com pix_txid já criado e payload ausente → RE-BUSCA, NÃO cria 2ª cobrança', async () => {
    process.env.DOJO_BAAS_ENABLED = 'true';
    const encKey = baasCrypto.encrypt('SUBACCT_KEY');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ payload: '000201REFETCH', encodedImage: 'img' })); // GET pixQrCode (re-busca)
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, amount: '140.00', competence: '2026-07', status: 'pending', due_date: '2026-07-10', pix_txid: 'pay_existing', pix_payload: null }] }) // SELECT charge: tem pix_txid, sem payload
      .mockResolvedValueOnce({ rows: [{ status: 'approved', provider_selected: 'baas', api_key_enc: encKey, wallet_id: 'wallet_dojo_1', asaas_account_id: 'acc_1' }] }) // resolveActiveBaas
      .mockResolvedValue({ rows: [] }); // persistPixArtifacts (best-effort)

    const res = await request(app).post(`${base}/charges/${cid}/pix`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('baas');
    expect(res.body.payload).toBe('000201REFETCH');
    // NÃO duplicou: nenhum POST /payments (criação de cobrança)
    const createCall = global.fetch.mock.calls.find((c) => c[1] && c[1].method === 'POST' && String(c[0]).includes('/payments'));
    expect(createCall).toBeUndefined();
    // Fez a re-busca do pagamento existente
    const getQr = global.fetch.mock.calls.find((c) => String(c[0]).includes('/payments/pay_existing/pixQrCode'));
    expect(getQr).toBeDefined();
  });
});
