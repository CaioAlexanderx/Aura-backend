// ============================================================
// Rota de staff do piloto do Pix Automático (tq-105, 24/10/2026)
//
//   POST /admin/painel/pix-automatico/:companyId/autorizar
//   POST /admin/painel/pix-automatico/:companyId/trocar-assinatura
//   GET  /admin/painel/pix-automatico/:companyId
//   GET  /admin/painel/pix-automatico/elegibilidade
//
// A Asaas é mockada em asaasClient.asaasRequest (nenhuma chamada real). O
// banco de mentira guarda a empresa e as autorizações.
// ============================================================
'use strict';

jest.mock('../src/services/asaasClient', () => ({ asaas: jest.fn(), asaasRequest: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const { asaasRequest } = require('../src/services/asaasClient');

const SECRET = 'aura-test-secret-2026';
const LOJA = 'aaaaaaaa-0000-4000-8000-000000000001';
const MATRIZ = 'aaaaaaaa-0000-4000-8000-0000000000ff';
const tok = (user) => ({ Authorization: 'Bearer ' + jwt.sign(user, SECRET, { expiresIn: '1h' }) });
const staff = tok({ id: 'u-staff', role: 'admin' });
const lojista = tok({ id: 'u-dono', role: 'client' });

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/painel/pix-automatico', require('../src/routes/adminPainelPixAutomatico'));
  return app;
}

let app;
beforeAll(() => { app = makeApp(); });
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  asaasRequest.mockReset();
  db.query.mockReset();
  process.env.PIX_AUTOMATIC_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.PIX_AUTOMATIC_ENABLED;
  jest.restoreAllMocks();
});

function banco({ empresa, autorizacoes = [], trava = true } = {}) {
  const estado = { empresa: { ...empresa }, autorizacoes: autorizacoes.map((a) => ({ ...a })), auditoria: [], updates: [] };
  db.query.mockImplementation(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    const e = estado.empresa;
    if (/FROM companies WHERE id = \$1$/.test(s)) {
      return { rows: e && e.id === params[0] ? [{ ...e, nome: e.trade_name }] : [] };
    }
    if (s.startsWith("UPDATE companies SET pix_auto_status = 'creating'")) {
      const livre = trava && (e.pix_auto_status == null || ['refused', 'cancelled', 'expired'].includes(e.pix_auto_status));
      if (!livre) return { rows: [] };
      e.pix_auto_status = 'creating';
      return { rows: [{ id: e.id }] };
    }
    if (/^UPDATE companies SET pix_auto_status = \$2, updated_at = NOW\(\) WHERE id = \$1 AND pix_auto_status = 'creating'/.test(s)) {
      if (e.pix_auto_status === 'creating') e.pix_auto_status = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE companies SET pix_auto_status = $2, asaas_pix_auto_authorization_id = $3')) {
      e.pix_auto_status = params[1];
      e.asaas_pix_auto_authorization_id = params[2];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE companies SET pix_auto_status = $1, updated_at = NOW() WHERE id = $2 AND asaas_pix_auto_authorization_id = $3')) {
      if (e.asaas_pix_auto_authorization_id === params[2]) e.pix_auto_status = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE companies SET asaas_subscription_id = $2')) {
      if ((e.asaas_subscription_id || null) === params[2]) e.asaas_subscription_id = params[1];
      estado.updates.push('assinatura');
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO pix_automatico_autorizacoes')) {
      estado.autorizacoes.push({ id: params[0], company_id: params[1], status: params[2], contract_id: params[3],
        value: params[4], start_date: params[6], finish_date: params[7], subscription_id: params[9], old_subscription_id: params[10] });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT subscription_id FROM pix_automatico_autorizacoes')) {
      const a = estado.autorizacoes.find((x) => x.id === params[0]);
      return { rows: a ? [{ subscription_id: a.subscription_id }] : [] };
    }
    if (s.startsWith('UPDATE pix_automatico_autorizacoes')) {
      const a = estado.autorizacoes.find((x) => x.id === params[0]);
      if (a && s.includes('swapped_at')) a.swapped = true;
      return { rows: [], rowCount: a ? 1 : 0 };
    }
    if (/FROM pix_automatico_autorizacoes WHERE company_id/.test(s)) {
      return { rows: estado.autorizacoes.filter((a) => a.company_id === params[0]) };
    }
    if (/FROM pix_automatico_elegibilidade/.test(s)) {
      return { rows: [{ status: 'ELIGIBLE', ineligible_reasons: [] }] };
    }
    if (s.startsWith('INSERT INTO admin_audit_log')) {
      estado.auditoria.push({ action: params[2], payload: JSON.parse(params[3]) });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return estado;
}

// Asaas de mentira: responde por "MÉTODO caminho".
function asaasDeMentira(rotas) {
  asaasRequest.mockImplementation(async (method, path, body) => {
    const k = method + ' ' + path;
    for (const [padrao, resp] of Object.entries(rotas)) {
      if (k === padrao || (padrao.endsWith('*') && k.startsWith(padrao.slice(0, -1)))) {
        return typeof resp === 'function' ? resp(body) : resp;
      }
    }
    throw new Error('chamada inesperada à Asaas: ' + k);
  });
}
const chamadas = () => asaasRequest.mock.calls.map((c) => c[0] + ' ' + c[1]);

const loja = (extra) => ({
  id: LOJA, trade_name: 'Loja Piloto', asaas_customer_id: 'cus_loja', asaas_subscription_id: 'sub_antiga',
  pix_auto_status: null, asaas_pix_auto_authorization_id: null, billing_owner_company_id: null,
  billing_cycle: 'annual', ...extra,
});

const autorizacaoCriada = {
  id: 'auth-1', status: 'CREATED', payload: '00020126...copia', encodedImage: 'iVBORw0KGgo',
  immediateQrCode: { expirationDate: '2099-01-30 12:00:00' }, subscriptionId: null,
};

describe('quem pode', () => {
  test('lojista leva 403 e nada é chamado', async () => {
    banco({ empresa: loja() });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(lojista).send({});
    expect(r.status).toBe(403);
    expect(asaasRequest).not.toHaveBeenCalled();
  });

  test('sem token, 401; companyId inválido, 400', async () => {
    banco({ empresa: loja() });
    expect((await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).send({})).status).toBe(401);
    expect((await request(app).post('/admin/painel/pix-automatico/xyz/autorizar').set(staff).send({})).status).toBe(400);
  });
});

describe('POST /:companyId/autorizar', () => {
  test('cria no modo SUBSCRIPTION com notificação desligada e devolve QR e copia e cola, sem tocar na assinatura antiga', async () => {
    const estado = banco({ empresa: loja() });
    asaasDeMentira({
      'GET /subscriptions/sub_antiga': { id: 'sub_antiga', value: 140.83, nextDueDate: '2099-01-31', billingType: 'PIX' },
      'PUT /customers/cus_loja': { id: 'cus_loja', notificationDisabled: true },
      'POST /pix/automatic/authorizations': autorizacaoCriada,
    });

    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff)
      .send({ cobrancas_restantes: 11 });

    expect(r.status).toBe(200);
    expect(chamadas()).toEqual([
      'GET /subscriptions/sub_antiga',
      'PUT /customers/cus_loja',
      'POST /pix/automatic/authorizations',
    ]);
    expect(asaasRequest.mock.calls[1][2]).toEqual({ notificationDisabled: true });
    const corpo = asaasRequest.mock.calls[2][2];
    expect(corpo).toMatchObject({
      customerId: 'cus_loja',
      paymentCreationMode: 'SUBSCRIPTION',
      retryPolicy: 'ALLOW_THREE_IN_SEVEN_DAYS',
      frequency: 'MONTHLY',
      value: 140.83,
      // O QR paga o ciclo de 31/01; o primeiro débito é um mês depois (preso no fim de fevereiro).
      startDate: '2099-02-28',
      // 11 cobranças restantes a partir de 28/02.
      finishDate: '2099-12-28',
      immediateQrCode: { originalValue: 140.83 },
    });
    expect(corpo.contractId.length).toBeLessThanOrEqual(35);

    expect(r.body.authorization).toMatchObject({
      id: 'auth-1', copia_e_cola: '00020126...copia', qr_code_base64: 'iVBORw0KGgo', expira_em: '2099-01-30 12:00:00',
    });
    expect(r.body.plano).toMatchObject({ ciclo_pago_pelo_qr: '2099-01-31', primeiro_debito: '2099-02-28', data_fim: '2099-12-28' });
    expect(r.body.assinatura_antiga).toBe('sub_antiga');
    expect(r.body.aviso).toMatch(/continua ativa/);

    expect(estado.empresa).toMatchObject({ pix_auto_status: 'pending', asaas_pix_auto_authorization_id: 'auth-1', asaas_subscription_id: 'sub_antiga' });
    expect(estado.autorizacoes).toEqual([expect.objectContaining({ id: 'auth-1', company_id: LOJA, status: 'pending', old_subscription_id: 'sub_antiga' })]);
    expect(estado.auditoria.map((a) => a.action)).toEqual(['pix_automatico_autorizar']);
    expect(chamadas().some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  test('valores do corpo vencem os da assinatura (sem consultar a assinatura)', async () => {
    banco({ empresa: loja() });
    asaasDeMentira({
      'PUT /customers/cus_loja': {},
      'POST /pix/automatic/authorizations': autorizacaoCriada,
    });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff)
      .send({ valor: 99.9, primeiro_debito: '2099-05-10', data_fim: '2099-10-10' });
    expect(r.status).toBe(200);
    expect(chamadas()).not.toContain('GET /subscriptions/sub_antiga');
    expect(asaasRequest.mock.calls[1][2]).toMatchObject({ value: 99.9, startDate: '2099-05-10', finishDate: '2099-10-10' });
  });

  test('segunda autorização para a mesma empresa: 409 se a da Asaas segue viva, sem criar outra', async () => {
    const estado = banco({ empresa: loja({ pix_auto_status: 'pending', asaas_pix_auto_authorization_id: 'auth-1' }) });
    asaasDeMentira({ 'GET /pix/automatic/authorizations/auth-1': { id: 'auth-1', status: 'CREATED' } });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff).send({});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'ja_tem_autorizacao', authorization_id: 'auth-1' });
    expect(chamadas()).toEqual(['GET /pix/automatic/authorizations/auth-1']);
    expect(estado.empresa.pix_auto_status).toBe('pending');
  });

  test('autorização ativa também bloqueia', async () => {
    banco({ empresa: loja({ pix_auto_status: 'active', asaas_pix_auto_authorization_id: 'auth-1' }) });
    asaasDeMentira({ 'GET /pix/automatic/authorizations/auth-1': { id: 'auth-1', status: 'ACTIVE' } });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff).send({});
    expect(r.status).toBe(409);
    expect(chamadas()).not.toContain('POST /pix/automatic/authorizations');
  });

  test('pendente no banco mas recusada na Asaas (evento perdido): sincroniza e cria a nova', async () => {
    const estado = banco({ empresa: loja({ pix_auto_status: 'pending', asaas_pix_auto_authorization_id: 'auth-velha' }) });
    asaasDeMentira({
      'GET /pix/automatic/authorizations/auth-velha': { id: 'auth-velha', status: 'REFUSED' },
      'GET /subscriptions/sub_antiga': { id: 'sub_antiga', value: 140.83, nextDueDate: '2099-01-10' },
      'PUT /customers/cus_loja': {},
      'POST /pix/automatic/authorizations': autorizacaoCriada,
    });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff).send({});
    expect(r.status).toBe(200);
    expect(estado.empresa).toMatchObject({ pix_auto_status: 'pending', asaas_pix_auto_authorization_id: 'auth-1' });
  });

  test('outra criação em andamento (trava ocupada): 409 sem chamar a Asaas para criar', async () => {
    banco({ empresa: loja(), trava: false });
    asaasDeMentira({ 'GET /subscriptions/sub_antiga': { id: 'sub_antiga', value: 140.83, nextDueDate: '2099-01-10' } });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff).send({});
    expect(r.status).toBe(409);
    expect(chamadas()).not.toContain('POST /pix/automatic/authorizations');
    expect(chamadas()).not.toContain('PUT /customers/cus_loja');
  });

  test('Asaas recusa a criação: 502 e a trava volta ao status anterior', async () => {
    const estado = banco({ empresa: loja({ pix_auto_status: 'refused' }) });
    const e = new Error('Cliente não habilitado para Pix Automático'); e.asaasStatus = 400;
    asaasDeMentira({
      'GET /subscriptions/sub_antiga': { id: 'sub_antiga', value: 140.83, nextDueDate: '2099-01-10' },
      'PUT /customers/cus_loja': {},
      'POST /pix/automatic/authorizations': () => { throw e; },
    });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff).send({});
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('asaas_falhou');
    expect(estado.empresa.pix_auto_status).toBe('refused');
    expect(estado.autorizacoes).toHaveLength(0);
  });

  test('não desligou a notificação: não cria a autorização', async () => {
    const estado = banco({ empresa: loja() });
    const e = new Error('timeout'); e.asaasTimeout = true;
    asaasDeMentira({
      'GET /subscriptions/sub_antiga': { id: 'sub_antiga', value: 140.83, nextDueDate: '2099-01-10' },
      'PUT /customers/cus_loja': () => { throw e; },
    });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff).send({});
    expect(r.status).toBe(502);
    expect(chamadas()).not.toContain('POST /pix/automatic/authorizations');
    expect(estado.empresa.pix_auto_status).toBe(null);
  });

  test('filial de grupo: recusa e aponta a principal', async () => {
    banco({ empresa: loja({ billing_owner_company_id: MATRIZ }) });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff).send({});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'cobranca_na_principal', billing_owner_company_id: MATRIZ });
    expect(asaasRequest).not.toHaveBeenCalled();
  });

  test('primeiro débito no passado: 400', async () => {
    banco({ empresa: loja() });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff)
      .send({ valor: 140.83, primeiro_debito: '2020-01-01' });
    expect(r.status).toBe(400);
    expect(asaasRequest).not.toHaveBeenCalled();
  });
});

describe('POST /:companyId/trocar-assinatura', () => {
  test('autorização pendente: 409 e nada é cancelado', async () => {
    banco({ empresa: loja({ pix_auto_status: 'pending', asaas_pix_auto_authorization_id: 'auth-1' }) });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/trocar-assinatura`).set(staff).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('autorizacao_nao_ativa');
    expect(asaasRequest).not.toHaveBeenCalled();
  });

  test('recusada (REFUSED depois do RECEIVED): 409 e nada é cancelado', async () => {
    banco({ empresa: loja({ pix_auto_status: 'refused', asaas_pix_auto_authorization_id: 'auth-1' }) });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/trocar-assinatura`).set(staff).send({});
    expect(r.status).toBe(409);
    expect(asaasRequest).not.toHaveBeenCalled();
  });

  test('ativa no banco mas não na Asaas: 409 e nada é cancelado', async () => {
    banco({ empresa: loja({ pix_auto_status: 'active', asaas_pix_auto_authorization_id: 'auth-1' }) });
    asaasDeMentira({ 'GET /pix/automatic/authorizations/auth-1': { id: 'auth-1', status: 'CANCELLED' } });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/trocar-assinatura`).set(staff).send({});
    expect(r.status).toBe(409);
    expect(chamadas()).toEqual(['GET /pix/automatic/authorizations/auth-1']);
  });

  test('ativa sem a assinatura nova informada: 409 e nada é cancelado', async () => {
    banco({ empresa: loja({ pix_auto_status: 'active', asaas_pix_auto_authorization_id: 'auth-1' }) });
    asaasDeMentira({ 'GET /pix/automatic/authorizations/auth-1': { id: 'auth-1', status: 'ACTIVE', subscriptionId: null } });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/trocar-assinatura`).set(staff).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('sem_assinatura_nova');
    expect(chamadas().some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  test('ativa: cancela a assinatura antiga e a cobrança pendente dela, e aponta para a nova', async () => {
    const estado = banco({
      empresa: loja({ pix_auto_status: 'active', asaas_pix_auto_authorization_id: 'auth-1' }),
      autorizacoes: [{ id: 'auth-1', company_id: LOJA, status: 'active' }],
    });
    const naoAchou = new Error('not found'); naoAchou.asaasStatus = 404;
    asaasDeMentira({
      'GET /pix/automatic/authorizations/auth-1': { id: 'auth-1', status: 'ACTIVE', subscriptionId: 'sub_nova' },
      'GET /subscriptions/sub_antiga/payments*': { data: [
        { id: 'pay_pend1', dueDate: '2099-01-31', value: 140.83 },
        { id: 'pay_pend2', dueDate: '2099-02-28', value: 140.83 },
      ] },
      'DELETE /subscriptions/sub_antiga': { deleted: true },
      'DELETE /payments/pay_pend1': { deleted: true },
      'DELETE /payments/pay_pend2': () => { throw naoAchou; },
    });

    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/trocar-assinatura`).set(staff).send({});

    expect(r.status).toBe(200);
    expect(chamadas()).toEqual([
      'GET /pix/automatic/authorizations/auth-1',
      'GET /subscriptions/sub_antiga/payments?status=OVERDUE&limit=100',
      'GET /subscriptions/sub_antiga/payments?status=PENDING&limit=100',
      'DELETE /subscriptions/sub_antiga',
      'DELETE /payments/pay_pend1',
      'DELETE /payments/pay_pend2',
    ]);
    expect(r.body).toMatchObject({
      assinatura_antiga_cancelada: 'sub_antiga', assinatura: 'sub_nova', cobrancas_nao_removidas: [], aviso: null,
    });
    expect(r.body.cobrancas_pendentes_removidas).toHaveLength(2);
    expect(estado.empresa.asaas_subscription_id).toBe('sub_nova');
    expect(estado.autorizacoes[0].swapped).toBe(true);
    expect(estado.auditoria.map((a) => a.action)).toEqual(['pix_automatico_trocar_assinatura']);
  });

  test('cancelar a assinatura antiga falha: 502 e o banco não muda', async () => {
    const estado = banco({ empresa: loja({ pix_auto_status: 'active', asaas_pix_auto_authorization_id: 'auth-1' }) });
    const e = new Error('erro'); e.asaasStatus = 500;
    asaasDeMentira({
      'GET /pix/automatic/authorizations/auth-1': { id: 'auth-1', status: 'ACTIVE', subscriptionId: 'sub_nova' },
      'GET /subscriptions/sub_antiga/payments*': { data: [{ id: 'pay_pend1' }] },
      'DELETE /subscriptions/sub_antiga': () => { throw e; },
    });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/trocar-assinatura`).set(staff).send({});
    expect(r.status).toBe(502);
    expect(estado.empresa.asaas_subscription_id).toBe('sub_antiga');
    expect(chamadas()).not.toContain('DELETE /payments/pay_pend1');
  });

  test('já trocada: responde sem cancelar nada', async () => {
    banco({ empresa: loja({ pix_auto_status: 'active', asaas_pix_auto_authorization_id: 'auth-1', asaas_subscription_id: 'sub_nova' }) });
    asaasDeMentira({ 'GET /pix/automatic/authorizations/auth-1': { id: 'auth-1', status: 'ACTIVE', subscriptionId: 'sub_nova' } });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/trocar-assinatura`).set(staff).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ja_trocada: true });
    expect(chamadas()).toEqual(['GET /pix/automatic/authorizations/auth-1']);
  });
});

describe('leitura', () => {
  test('GET /:companyId traz o estado e o QR atual da Asaas', async () => {
    banco({ empresa: loja({ pix_auto_status: 'pending', asaas_pix_auto_authorization_id: 'auth-1' }),
      autorizacoes: [{ id: 'auth-1', company_id: LOJA, status: 'pending' }] });
    asaasDeMentira({ 'GET /pix/automatic/authorizations/auth-1': autorizacaoCriada });
    const r = await request(app).get(`/admin/painel/pix-automatico/${LOJA}`).set(staff);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pix_auto_status: 'pending', authorization_id: 'auth-1',
      na_asaas: { copia_e_cola: '00020126...copia' } });
    expect(r.body.historico).toHaveLength(1);
  });

  test('GET /elegibilidade lê a linha gravada pelo webhook', async () => {
    banco({ empresa: loja() });
    const r = await request(app).get('/admin/painel/pix-automatico/elegibilidade').set(staff);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ELIGIBLE' });
  });
});

describe('somarMeses', () => {
  const { somarMeses } = require('../src/services/pixAutomaticoPiloto');
  test.each([
    ['2099-01-31', 1, '2099-02-28'],
    ['2096-01-31', 1, '2096-02-29'],
    ['2099-02-28', 10, '2099-12-28'],
    ['2099-11-15', 2, '2100-01-15'],
  ])('%s + %i -> %s', (d, n, esperado) => expect(somarMeses(d, n)).toBe(esperado));
});

// ── tq-104 (29/10/2026): chave geral desligada ───────────────────
describe('chave PIX_AUTOMATIC_ENABLED desligada (padrão)', () => {
  test('autorizar: 409 pix_automatico_desligado, sem chamar a Asaas e sem mexer no banco', async () => {
    delete process.env.PIX_AUTOMATIC_ENABLED;
    const estado = banco({ empresa: loja() });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/autorizar`).set(staff).send({ valor: 140.83 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('pix_automatico_desligado');
    expect(asaasRequest).not.toHaveBeenCalled();
    expect(estado.empresa.pix_auto_status).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('trocar a assinatura: 409 pix_automatico_desligado, nada cancelado', async () => {
    delete process.env.PIX_AUTOMATIC_ENABLED;
    const estado = banco({ empresa: loja({ pix_auto_status: 'active', asaas_pix_auto_authorization_id: 'auth-1' }) });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/trocar-assinatura`).set(staff).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('pix_automatico_desligado');
    expect(asaasRequest).not.toHaveBeenCalled();
    expect(estado.empresa.asaas_subscription_id).toBe('sub_antiga');
  });

  test('leituras seguem com a chave desligada', async () => {
    delete process.env.PIX_AUTOMATIC_ENABLED;
    banco({ empresa: loja() });
    const r = await request(app).get(`/admin/painel/pix-automatico/${LOJA}`).set(staff);
    expect(r.status).toBe(200);
    const e = await request(app).get('/admin/painel/pix-automatico/elegibilidade').set(staff);
    expect(e.status).toBe(200);
    expect(asaasRequest).not.toHaveBeenCalled();
  });
});

// ── tq-105 (29/10/2026): cobrança vencida na assinatura antiga ───
describe('trocar-assinatura com cobrança vencida na antiga', () => {
  test('409 cobranca_vencida_na_antiga e nada é cancelado', async () => {
    const estado = banco({
      empresa: loja({ pix_auto_status: 'active', asaas_pix_auto_authorization_id: 'auth-1' }),
      autorizacoes: [{ id: 'auth-1', company_id: LOJA, status: 'active', subscription_id: 'sub_nova' }],
    });
    asaasDeMentira({
      'GET /pix/automatic/authorizations/auth-1': { id: 'auth-1', status: 'ACTIVE', subscriptionId: 'sub_nova' },
      'GET /subscriptions/sub_antiga/payments?status=OVERDUE*': { data: [
        { id: 'pay_venc', status: 'OVERDUE', dueDate: '2099-01-23', value: 140.83 },
      ] },
    });
    const r = await request(app).post(`/admin/painel/pix-automatico/${LOJA}/trocar-assinatura`).set(staff).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('cobranca_vencida_na_antiga');
    expect(r.body.cobrancas_vencidas).toEqual([{ id: 'pay_venc', due_date: '2099-01-23', value: 140.83 }]);
    expect(chamadas().some((c) => c.startsWith('DELETE'))).toBe(false);
    expect(estado.empresa.asaas_subscription_id).toBe('sub_antiga');
  });
});
