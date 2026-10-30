// ============================================================
// POST /webhooks/asaas — eventos PIX_AUTOMATIC_* (tq-105, 24/10/2026)
//
// 1. Idempotente pelo id do evento (pix_automatico_eventos.event_key UNIQUE).
// 2. REFUSED depois do PAYMENT_RECEIVED: nada liga; ACTIVATED atrasado não
//    religa.
// 3. Cancelada pela cliente no banco: aviso no sininho da empresa "Aura.";
//    cancelada pela Aura: sem aviso.
// 4. Sem ASAAS_WEBHOOK_SECRET: a autorização é relida na Asaas; evento forjado
//    não grava nada.
// 5. Elegibilidade gravada (linha única) e INELIGIBLE avisa a equipe.
//
// Banco de mentira: guarda empresas, autorizações, eventos e elegibilidade e
// interpreta só as consultas que o handler faz.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const SECRET = 'segredo-de-teste-asaas-abc123';
const LOJA = 'aaaaaaaa-0000-4000-8000-000000000001';
const EQUIPE = '645c1325-8865-48be-af6f-430d93fb2b6c';
const AUTH = 'a33047b1-fb19-4b68-9373-a7ba8a8162aa';

let webhookSvc = null;

function buildApp({ secret = SECRET, ligado = true } = {}) {
  jest.resetModules();
  if (ligado) process.env.PIX_AUTOMATIC_ENABLED = 'true';
  else delete process.env.PIX_AUTOMATIC_ENABLED;
  if (secret === null) delete process.env.ASAAS_WEBHOOK_SECRET;
  else process.env.ASAAS_WEBHOOK_SECRET = secret;
  jest.doMock('../src/config/database');
  jest.doMock('../src/services/asaasClient', () => ({ asaas: jest.fn(), asaasRequest: jest.fn() }));
  jest.doMock('../src/services/digitalOrderNotifications', () => ({
    notifyPaymentConfirmed: jest.fn().mockResolvedValue(undefined),
  }));
  const chaves = new Set();
  jest.doMock('../src/services/appNotifications', () => ({
    notifyCompany: jest.fn(async (companyId, p) => {
      if (p.dedupeKey && chaves.has(p.dedupeKey)) return null;
      if (p.dedupeKey) chaves.add(p.dedupeKey);
      return { id: 'n-' + chaves.size, target_company_id: companyId, ...p };
    }),
  }));
  const db = require('../src/config/database');
  const asaasClient = require('../src/services/asaasClient');
  const notifications = require('../src/services/appNotifications');
  const app = express();
  app.use(express.json());
  app.use('/webhooks/asaas', require('../src/routes/webhookAsaas'));
  webhookSvc = require('../src/services/pixAutomaticoWebhook');
  return { app, db, asaasClient, notifications, svc: webhookSvc };
}

function bancoDeMentira(db, { empresa, autorizacoes = [], semTabela = false } = {}) {
  const estado = {
    empresa: { ...empresa },
    autorizacoes: autorizacoes.map((a) => ({ ...a })),
    eventos: new Map(),
    elegibilidade: null,
    billingUpdates: 0,
    pixUpdates: 0,
    webhookLogs: [],
  };
  const tabelaAusente = () => { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; };
  db.query.mockImplementation(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT INTO pix_automatico_eventos')) {
      if (semTabela) tabelaAusente();
      if (estado.eventos.has(params[0])) return { rows: [], rowCount: 0 };
      estado.eventos.set(params[0], { event: params[1], processed: false });
      return { rows: [{ id: 'ev' }], rowCount: 1 };
    }
    if (s.startsWith('UPDATE pix_automatico_eventos')) {
      const ev = estado.eventos.get(params[0]);
      if (ev) Object.assign(ev, { company_id: params[1], result: params[2], processed: true });
      return { rows: [], rowCount: ev ? 1 : 0 };
    }
    if (s.startsWith('DELETE FROM pix_automatico_eventos')) {
      estado.eventos.delete(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (/FROM companies WHERE asaas_pix_auto_authorization_id = \$1/.test(s)) {
      const e = estado.empresa;
      return { rows: e.asaas_pix_auto_authorization_id === params[0]
        ? [{ id: e.id, pix_auto_status: e.pix_auto_status, nome: e.trade_name }] : [] };
    }
    if (s.startsWith('SELECT company_id FROM pix_automatico_autorizacoes')) {
      if (semTabela) tabelaAusente();
      const a = estado.autorizacoes.find((x) => x.id === params[0]);
      return { rows: a ? [{ company_id: a.company_id }] : [] };
    }
    if (s.startsWith('UPDATE pix_automatico_autorizacoes')) {
      if (semTabela) tabelaAusente();
      const a = estado.autorizacoes.find((x) => x.id === params[0]);
      if (a && !['refused', 'cancelled', 'expired'].includes(a.status) && !(params[1] === 'pending' && a.status === 'active')) {
        a.status = params[1];
        if (params[2]) a.subscription_id = params[2];
        if (params[3]) a.cancellation_reason = params[3];
      }
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE companies SET pix_auto_status = $1')) {
      const [novo, id, auth, anterior] = params;
      const e = estado.empresa;
      if (e.id === id && e.asaas_pix_auto_authorization_id === auth && (e.pix_auto_status || '') === anterior) {
        e.pix_auto_status = novo;
        estado.pixUpdates += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('INSERT INTO pix_automatico_elegibilidade')) {
      if (semTabela) tabelaAusente();
      const [status, motivos, accountId, chave, data] = params;
      const atual = estado.elegibilidade;
      if (!atual || !atual.event_date || !data || atual.event_date <= data) {
        estado.elegibilidade = { status, ineligible_reasons: JSON.parse(motivos), account_id: accountId, event_key: chave, event_date: data };
      }
      return { rows: [], rowCount: 1 };
    }
    // ── troca depois de ativar (tq-105): pixAutomaticoPiloto ──
    if (/FROM companies WHERE id = \$1$/.test(s)) {
      const e = estado.empresa;
      return { rows: e.id === params[0] ? [{ ...e, nome: e.trade_name }] : [] };
    }
    if (s.startsWith('UPDATE companies SET asaas_subscription_id = $2')) {
      const e = estado.empresa;
      if ((e.asaas_subscription_id || null) === params[2]) e.asaas_subscription_id = params[1];
      return { rows: [], rowCount: 1 };
    }
    // ── fluxo de pagamento já existente ──
    if (/FROM companies WHERE asaas_customer_id/.test(s)) {
      return { rows: [{ id: estado.empresa.id, plan: 'negocio', billing_status: estado.empresa.billing_status,
        is_primary: false, asaas_subscription_id: estado.empresa.asaas_subscription_id }] };
    }
    if (s.startsWith('SELECT 1 FROM webhook_logs') && s.includes('dedupe_key')) {
      return { rows: estado.webhookLogs.filter((l) => l.payload && l.payload.dedupe_key === params[0]).map(() => ({ '?column?': 1 })) };
    }
    if (s.startsWith('SELECT 1 FROM webhook_logs')) return { rows: [] };
    if (/SELECT last_payment_date::text/.test(s)) return { rows: [{ last_payment_text: null }] };
    if (/UPDATE companies SET billing_status = \$1,/.test(s)) {
      estado.empresa.billing_status = params[0];
      estado.billingUpdates += 1;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO webhook_logs')) {
      estado.webhookLogs.push({ company_id: params[0], event: params[1], payload: JSON.parse(params[2]) });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return estado;
}

const loja = (extra) => ({
  id: LOJA, trade_name: 'Loja Piloto', asaas_customer_id: 'cus_loja', asaas_subscription_id: 'sub_antiga',
  billing_status: 'active', pix_auto_status: 'pending', asaas_pix_auto_authorization_id: AUTH, ...extra,
});

const evento = (event, id, auth = {}) => ({
  id, event, dateCreated: '2099-03-05 08:24:11',
  account: { id: 'acc_aura', ownerId: null },
  authorization: { id: AUTH, status: 'CREATED', customerId: 'cus_loja', frequency: 'MONTHLY', value: 140.83, ...auth },
});

const enviar = (app, body, comToken = true) => {
  const r = request(app).post('/webhooks/asaas');
  return (comToken ? r.set('asaas-access-token', SECRET) : r).send(body);
};

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  // A troca depois do ACTIVATED roda depois da resposta: espera antes de limpar.
  if (webhookSvc) await webhookSvc.aguardarTarefas();
  webhookSvc = null;
  delete process.env.PIX_AUTOMATIC_TROCA_AUTOMATICA;
  delete process.env.ASAAS_WEBHOOK_SECRET;
  delete process.env.PIX_AUTO_ALERT_COMPANY_ID;
  delete process.env.PIX_AUTOMATIC_ENABLED;
  jest.restoreAllMocks();
  jest.resetModules();
});

describe('idempotência pelo id do evento', () => {
  test('o mesmo ACTIVATED duas vezes: um efeito só, o segundo responde duplicate', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    const ev = evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_1', { status: 'ACTIVE', subscriptionId: 'sub_nova' });

    const r1 = await enviar(app, ev);
    const r2 = await enviar(app, ev);

    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ handled: true, status: 'active', status_anterior: 'pending' });
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ duplicate: true });
    expect(estado.empresa.pix_auto_status).toBe('active');
    expect(estado.pixUpdates).toBe(1);
    expect(estado.eventos.get('evt_1')).toMatchObject({ processed: true, company_id: LOJA, result: 'status_active' });
  });

  test('cancelamento reenviado não vira segundo aviso', async () => {
    const { app, db, notifications } = buildApp();
    bancoDeMentira(db, { empresa: loja({ pix_auto_status: 'active' }) });
    const ev = evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED', 'evt_c1',
      { status: 'CANCELLED', cancellationReason: 'REQUESTED_BY_PAYER_USER', cancellationDate: '2099-03-05' });
    await enviar(app, ev);
    await enviar(app, ev);
    expect(notifications.notifyCompany).toHaveBeenCalledTimes(1);
  });

  test('instrução sem id no topo usa evento + objeto + status como chave', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja({ pix_auto_status: 'active' }) });
    const body = {
      event: 'PIX_AUTOMATIC_RECURRING_PAYMENT_INSTRUCTION_SCHEDULED',
      paymentInstruction: { id: 'pi_1', status: 'SCHEDULED', dueDate: '2099-04-18', paymentId: 'pay_1', authorization: { id: AUTH } },
    };
    const r1 = await enviar(app, body);
    const r2 = await enviar(app, body);
    expect(r1.body).toMatchObject({ handled: true, result: 'registrado' });
    expect(r2.body).toMatchObject({ duplicate: true });
    expect([...estado.eventos.keys()]).toEqual(['PIX_AUTOMATIC_RECURRING_PAYMENT_INSTRUCTION_SCHEDULED:pi_1:SCHEDULED:']);
    expect(estado.eventos.get([...estado.eventos.keys()][0]).company_id).toBe(LOJA);
    expect(estado.empresa.pix_auto_status).toBe('active');
  });

  test('falha no meio solta a reserva: o reenvio processa', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    const original = db.query.getMockImplementation();
    let falhar = true;
    db.query.mockImplementation(async (sql, params) => {
      if (falhar && /^\s*UPDATE companies\s+SET pix_auto_status = \$1/.test(sql)) { falhar = false; throw new Error('conexão caiu'); }
      return original(sql, params);
    });
    const ev = evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_f', { status: 'ACTIVE' });
    const r1 = await enviar(app, ev);
    expect(r1.body).toMatchObject({ error: true });
    expect(estado.eventos.has('evt_f')).toBe(false);
    const r2 = await enviar(app, ev);
    expect(r2.body).toMatchObject({ handled: true, status: 'active' });
  });

  test('sem a migration 406 (42P01) processa assim mesmo, sem reserva', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja(), semTabela: true });
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_s', { status: 'ACTIVE' }));
    expect(r.body).toMatchObject({ handled: true, status: 'active' });
    expect(estado.empresa.pix_auto_status).toBe('active');
  });
});

describe('REFUSED depois do PAYMENT_RECEIVED', () => {
  test('o primeiro pagamento entra como pagamento, a autorização fica recusada e nada liga', async () => {
    const { app, db, asaasClient } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    asaasClient.asaas.mockResolvedValue({ data: [] });

    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CREATED', 'evt_a'));
    const pago = await enviar(app, {
      id: 'evt_b', event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_qr', customer: 'cus_loja', value: 140.83, billingType: 'PIX', status: 'RECEIVED',
        paymentDate: '2099-03-01', dueDate: '2099-03-01' },
    });
    expect(pago.status).toBe(200);
    expect(estado.billingUpdates).toBe(1);
    // PAYMENT_RECEIVED não mexe no Pix Automático.
    expect(estado.empresa.pix_auto_status).toBe('pending');

    const recusa = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED', 'evt_c', { status: 'REFUSED' }));
    expect(recusa.body).toMatchObject({ status: 'refused' });
    expect(estado.empresa.pix_auto_status).toBe('refused');

    // ACTIVATED atrasado (outro id) não religa.
    const atrasado = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_d', { status: 'ACTIVE' }));
    expect(atrasado.body).toMatchObject({ result: 'sem_mudanca', status: 'refused' });
    expect(estado.empresa.pix_auto_status).toBe('refused');
  });

  test('CREATED atrasado não rebaixa uma autorização ativa', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja({ pix_auto_status: 'active' }) });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CREATED', 'evt_old'));
    expect(estado.empresa.pix_auto_status).toBe('active');
  });

  test('evento de uma autorização antiga não mexe na empresa', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, {
      empresa: loja({ asaas_pix_auto_authorization_id: 'auth-nova', pix_auto_status: 'pending' }),
      autorizacoes: [{ id: AUTH, company_id: LOJA, status: 'pending' }],
    });
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_x', { status: 'ACTIVE' }));
    expect(r.body).toMatchObject({ result: 'autorizacao_antiga' });
    expect(estado.empresa.pix_auto_status).toBe('pending');
    expect(estado.autorizacoes[0].status).toBe('active');
  });
});

describe('cancelamento', () => {
  test('pela cliente no banco: status cancelled e aviso no sininho da equipe', async () => {
    const { app, db, notifications } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja({ pix_auto_status: 'active' }) });
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED', 'evt_c',
      { status: 'CANCELLED', cancellationReason: 'REQUESTED_BY_PAYER_USER', cancellationDate: '2099-03-05' }));

    expect(r.body).toMatchObject({ status: 'cancelled', alerta: true });
    expect(estado.empresa.pix_auto_status).toBe('cancelled');
    expect(notifications.notifyCompany).toHaveBeenCalledTimes(1);
    const [alvo, aviso] = notifications.notifyCompany.mock.calls[0];
    expect(alvo).toBe(EQUIPE);
    expect(aviso.title).toBe('Pix Automático cancelado no banco: Loja Piloto');
    expect(aviso.body).toContain('05/03/2099');
    expect(aviso.body).toContain('sinal de saída');
    expect(aviso.dedupeKey).toBe('pix-auto-cancelada:' + AUTH);
  });

  test('a empresa da equipe pode vir de PIX_AUTO_ALERT_COMPANY_ID', async () => {
    process.env.PIX_AUTO_ALERT_COMPANY_ID = 'bbbbbbbb-0000-4000-8000-000000000009';
    const { app, db, notifications } = buildApp();
    bancoDeMentira(db, { empresa: loja({ pix_auto_status: 'active' }) });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED', 'evt_c',
      { status: 'CANCELLED', cancellationReason: 'OTHER' }));
    expect(notifications.notifyCompany.mock.calls[0][0]).toBe('bbbbbbbb-0000-4000-8000-000000000009');
    expect(notifications.notifyCompany.mock.calls[0][1].title).toBe('Pix Automático cancelado: Loja Piloto');
  });

  test('cancelada pela própria Aura: muda o status, sem aviso', async () => {
    const { app, db, notifications } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja({ pix_auto_status: 'active' }) });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED', 'evt_c',
      { status: 'CANCELLED', cancellationReason: 'REQUESTED_BY_RECEIVER_USER' }));
    expect(estado.empresa.pix_auto_status).toBe('cancelled');
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
  });

  test('autorização já recusada que recebe CANCELLED: sem aviso (nunca esteve ligada)', async () => {
    const { app, db, notifications } = buildApp();
    bancoDeMentira(db, { empresa: loja({ pix_auto_status: 'refused' }) });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED', 'evt_c',
      { status: 'CANCELLED', cancellationReason: 'REQUESTED_BY_PAYER_USER' }));
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
  });
});

describe('sem ASAAS_WEBHOOK_SECRET', () => {
  test('relê a autorização na Asaas e vale o status de lá', async () => {
    const { app, db, asaasClient } = buildApp({ secret: null });
    const estado = bancoDeMentira(db, { empresa: loja() });
    asaasClient.asaasRequest.mockResolvedValue({ id: AUTH, status: 'REFUSED' });
    // O corpo diz ACTIVATED; a Asaas diz REFUSED.
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_1', { status: 'ACTIVE' }), false);
    expect(asaasClient.asaasRequest.mock.calls[0].slice(0, 2)).toEqual(['GET', '/pix/automatic/authorizations/' + AUTH]);
    expect(r.body).toMatchObject({ status: 'refused' });
    expect(estado.empresa.pix_auto_status).toBe('refused');
  });

  test('evento forjado (a Asaas não acha a autorização): nada gravado', async () => {
    const { app, db, asaasClient } = buildApp({ secret: null });
    const estado = bancoDeMentira(db, { empresa: loja() });
    const e = new Error('not found'); e.asaasStatus = 404;
    asaasClient.asaasRequest.mockRejectedValue(e);
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_1', { status: 'ACTIVE' }), false);
    expect(r.body).toMatchObject({ handled: false, reason: 'no_secret_reverification_failed' });
    expect(estado.empresa.pix_auto_status).toBe('pending');
    expect(estado.eventos.size).toBe(0);
  });

  test('elegibilidade sem o token não é gravada', async () => {
    const { app, db } = buildApp({ secret: null });
    const estado = bancoDeMentira(db, { empresa: loja() });
    const r = await enviar(app, { id: 'evt_e', event: 'PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED',
      account: { id: 'acc', ownerId: null }, eligibility: { status: 'ELIGIBLE', ineligibleReasons: [] } }, false);
    expect(r.body).toMatchObject({ handled: false, reason: 'no_secret_unverifiable' });
    expect(estado.elegibilidade).toBeNull();
  });

  test('token errado continua 401', async () => {
    const { app, db } = buildApp();
    bancoDeMentira(db, { empresa: loja() });
    const r = await request(app).post('/webhooks/asaas').set('asaas-access-token', 'x'.repeat(SECRET.length))
      .send(evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_1'));
    expect(r.status).toBe(401);
  });
});

describe('elegibilidade da conta da Aura', () => {
  const eleg = (id, status, data, motivos = []) => ({
    id, event: 'PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED', dateCreated: data,
    account: { id: 'acc_aura', ownerId: null }, eligibility: { status, ineligibleReasons: motivos },
  });

  test('ELIGIBLE é gravada sem aviso; INELIGIBLE grava e avisa a equipe', async () => {
    const { app, db, notifications } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    await enviar(app, eleg('evt_e1', 'ELIGIBLE', '2099-03-05 08:00:00'));
    expect(estado.elegibilidade).toMatchObject({ status: 'ELIGIBLE', account_id: 'acc_aura' });
    expect(notifications.notifyCompany).not.toHaveBeenCalled();

    await enviar(app, eleg('evt_e2', 'INELIGIBLE', '2099-03-06 08:00:00', ['CNPJ_RECENTE']));
    expect(estado.elegibilidade).toMatchObject({ status: 'INELIGIBLE', ineligible_reasons: ['CNPJ_RECENTE'] });
    expect(notifications.notifyCompany).toHaveBeenCalledTimes(1);
    expect(notifications.notifyCompany.mock.calls[0][0]).toBe(EQUIPE);
  });

  test('evento mais velho chegando depois não sobrescreve', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    await enviar(app, eleg('evt_novo', 'ELIGIBLE', '2099-03-06 08:00:00'));
    await enviar(app, eleg('evt_velho', 'INELIGIBLE', '2099-03-01 08:00:00'));
    expect(estado.elegibilidade).toMatchObject({ status: 'ELIGIBLE', event_key: 'evt_novo' });
  });

  test('evento de subconta (ownerId) é ignorado', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    const body = eleg('evt_sub', 'INELIGIBLE', '2099-03-06 08:00:00');
    body.account.ownerId = 'acc_mae';
    const r = await enviar(app, body);
    expect(r.body).toMatchObject({ result: 'subconta_ignorada' });
    expect(estado.elegibilidade).toBeNull();
  });
});

describe('proximoStatus', () => {
  const { proximoStatus } = jest.requireActual('../src/services/pixAutomaticoWebhook');
  test.each([
    [null, 'pending', 'pending'],
    ['pending', 'active', 'active'],
    ['active', 'cancelled', 'cancelled'],
    ['active', 'pending', null],
    ['refused', 'active', null],
    ['cancelled', 'active', null],
    ['expired', 'pending', null],
    ['active', 'active', null],
    ['creating', 'pending', 'pending'],
  ])('%s + %s -> %s', (atual, novo, esperado) => {
    expect(proximoStatus(atual, novo)).toBe(esperado);
  });
});

// ── tq-104 (29/10/2026): chave geral e webhook_logs ─────────────
describe('chave PIX_AUTOMATIC_ENABLED desligada (padrão)', () => {
  test('ACTIVATED com token: só registra; companies não muda, sem aviso, sem Asaas', async () => {
    const { app, db, asaasClient, notifications } = buildApp({ ligado: false });
    const estado = bancoDeMentira(db, { empresa: loja() });
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_off1', { status: 'ACTIVE' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handled: true, result: 'desligado' });
    expect(estado.empresa.pix_auto_status).toBe('pending');
    expect(estado.pixUpdates).toBe(0);
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
    expect(asaasClient.asaasRequest).not.toHaveBeenCalled();
    expect(estado.eventos.get('evt_off1')).toMatchObject({ processed: true, company_id: LOJA, result: 'desligado' });
    expect(estado.webhookLogs).toHaveLength(1);
    expect(estado.webhookLogs[0]).toMatchObject({ company_id: LOJA, event: 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED' });
  });

  test('cancelamento pela cliente com a chave desligada: nenhum aviso, status igual', async () => {
    const { app, db, notifications } = buildApp({ ligado: false });
    const estado = bancoDeMentira(db, { empresa: loja({ pix_auto_status: 'active' }) });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED', 'evt_off2',
      { status: 'CANCELLED', cancellationReason: 'REQUESTED_BY_PAYER_USER' }));
    expect(estado.empresa.pix_auto_status).toBe('active');
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
  });

  test('sem o segredo e desligada: não relê na Asaas e não grava nada', async () => {
    const { app, db, asaasClient } = buildApp({ secret: null, ligado: false });
    const estado = bancoDeMentira(db, { empresa: loja() });
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_off3', { status: 'ACTIVE' }), false);
    expect(r.body).toMatchObject({ handled: false, reason: 'pix_automatico_desligado' });
    expect(asaasClient.asaasRequest).not.toHaveBeenCalled();
    expect(estado.eventos.size).toBe(0);
    expect(estado.webhookLogs).toHaveLength(0);
  });

  test('reenvio com a chave desligada também é reconhecido', async () => {
    const { app, db } = buildApp({ ligado: false });
    const estado = bancoDeMentira(db, { empresa: loja() });
    const ev = evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CREATED', 'evt_off4');
    await enviar(app, ev);
    const r2 = await enviar(app, ev);
    expect(r2.body).toMatchObject({ duplicate: true });
    expect(estado.webhookLogs).toHaveLength(1);
  });

  test('elegibilidade continua gravada (é da conta da Aura, não de uma loja)', async () => {
    const { app, db } = buildApp({ ligado: false });
    const estado = bancoDeMentira(db, { empresa: loja() });
    const r = await enviar(app, { id: 'evt_el_off', event: 'PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED', dateCreated: '2099-03-05 08:00:00',
      account: { id: 'acc_aura', ownerId: null }, eligibility: { status: 'ELIGIBLE', ineligibleReasons: [] } });
    expect(r.body).toMatchObject({ handled: true, result: 'elegibilidade_eligible' });
    expect(estado.elegibilidade).toMatchObject({ status: 'ELIGIBLE' });
  });

  test('chave com valor diferente de "true" conta como desligada', async () => {
    const { app, db } = buildApp({ ligado: false });
    process.env.PIX_AUTOMATIC_ENABLED = '1';
    const estado = bancoDeMentira(db, { empresa: loja() });
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_off5', { status: 'ACTIVE' }));
    expect(r.body).toMatchObject({ result: 'desligado' });
    expect(estado.empresa.pix_auto_status).toBe('pending');
  });
});

describe('webhook_logs', () => {
  test('evento processado com empresa ganha uma linha (com dedupe_key); o reenvio não', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    const ev = evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_wl1', { status: 'ACTIVE', subscriptionId: 'sub_nova' });
    await enviar(app, ev);
    await enviar(app, ev);
    expect(estado.webhookLogs).toHaveLength(1);
    expect(estado.webhookLogs[0]).toMatchObject({
      company_id: LOJA,
      event: 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED',
      payload: { id: 'evt_wl1', dedupe_key: 'evt_wl1', fonte: 'body', resultado: 'status_active',
        authorization: { id: AUTH, status: 'ACTIVE' } },
    });
  });

  test('elegibilidade e autorização desconhecida não entram (sem empresa)', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja({ asaas_pix_auto_authorization_id: 'outra' }) });
    await enviar(app, { id: 'evt_el', event: 'PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED', dateCreated: '2099-03-05 08:00:00',
      account: { id: 'acc_aura', ownerId: null }, eligibility: { status: 'ELIGIBLE', ineligibleReasons: [] } });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_desc', { status: 'ACTIVE' }));
    expect(estado.webhookLogs).toHaveLength(0);
    expect(estado.eventos.size).toBe(2);
  });

  test('nome de evento com mais de 60 caracteres é cortado na coluna e fica inteiro no payload', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja({ pix_auto_status: 'active' }) });
    const nome = 'PIX_AUTOMATIC_RECURRING_PAYMENT_INSTRUCTION_WAITING_PROCESSING_X';
    await enviar(app, { id: 'evt_longo', event: nome,
      paymentInstruction: { id: 'pi_9', status: 'X', authorization: { id: AUTH } } });
    expect(estado.webhookLogs).toHaveLength(1);
    expect(estado.webhookLogs[0].event).toBe(nome.slice(0, 60));
    expect(estado.webhookLogs[0].payload.event).toBe(nome);
  });

  test('sem a migration 406 o reenvio não duplica a linha (confere o dedupe_key)', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja(), semTabela: true });
    const ev = evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_st', { status: 'ACTIVE' });
    await enviar(app, ev);
    await enviar(app, ev);
    expect(estado.webhookLogs).toHaveLength(1);
  });

  test('falha ao gravar em webhook_logs não derruba o evento', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/^\s*INSERT INTO webhook_logs/.test(sql)) throw new Error('disco cheio');
      return original(sql, params);
    });
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_wf', { status: 'ACTIVE' }));
    expect(r.body).toMatchObject({ handled: true, status: 'active' });
    expect(estado.eventos.get('evt_wf')).toMatchObject({ processed: true });
  });
});

// ── tq-105 (29/10/2026): troca depois de ativar e recusa ─────────
// Asaas de mentira: responde por "MÉTODO caminho" (prefixo com *).
function asaasDeMentira(asaasClient, rotas) {
  asaasClient.asaasRequest.mockImplementation(async (method, path) => {
    const k = method + ' ' + path;
    for (const [padrao, resp] of Object.entries(rotas)) {
      if (k === padrao || (padrao.endsWith('*') && k.startsWith(padrao.slice(0, -1)))) {
        if (resp instanceof Error) throw resp;
        return typeof resp === 'function' ? resp() : resp;
      }
    }
    throw new Error('chamada inesperada à Asaas: ' + k);
  });
}
const chamadasAsaas = (asaasClient) => asaasClient.asaasRequest.mock.calls.map((c) => c[0] + ' ' + c[1]);
const titulos = (notifications) => notifications.notifyCompany.mock.calls.map((c) => c[1].title);

describe('troca da assinatura depois do ACTIVATED', () => {
  test('ativa: troca agendada; depois da resposta cancela a antiga e a pendente, aponta para a nova e avisa', async () => {
    const { app, db, asaasClient, notifications, svc } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    asaasDeMentira(asaasClient, {
      ['GET /pix/automatic/authorizations/' + AUTH]: { id: AUTH, status: 'ACTIVE', subscriptionId: 'sub_nova' },
      'GET /subscriptions/sub_antiga/payments?status=OVERDUE*': { data: [] },
      'GET /subscriptions/sub_antiga/payments?status=PENDING*': { data: [{ id: 'pay_pend', status: 'PENDING', dueDate: '2099-04-05', value: 140.83 }] },
      'DELETE /subscriptions/sub_antiga': { deleted: true },
      'DELETE /payments/pay_pend': { deleted: true },
    });

    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_at1', { status: 'ACTIVE', subscriptionId: 'sub_nova' }));
    expect(r.body).toMatchObject({ handled: true, status: 'active', troca: 'agendada' });
    await svc.aguardarTarefas();

    expect(chamadasAsaas(asaasClient)).toEqual([
      'GET /pix/automatic/authorizations/' + AUTH,
      'GET /subscriptions/sub_antiga/payments?status=OVERDUE&limit=100',
      'GET /subscriptions/sub_antiga/payments?status=PENDING&limit=100',
      'DELETE /subscriptions/sub_antiga',
      'DELETE /payments/pay_pend',
    ]);
    expect(estado.empresa.asaas_subscription_id).toBe('sub_nova');
    expect(titulos(notifications)).toEqual(['Pix Automático ativo: Loja Piloto']);
    expect(notifications.notifyCompany.mock.calls[0][0]).toBe(EQUIPE);
    expect(notifications.notifyCompany.mock.calls[0][1].body).toContain('1 cobrança pendente removida');
  });

  test('reenvio do ACTIVATED não agenda segunda troca', async () => {
    const { app, db, asaasClient, svc } = buildApp();
    bancoDeMentira(db, { empresa: loja() });
    asaasDeMentira(asaasClient, {
      ['GET /pix/automatic/authorizations/' + AUTH]: { id: AUTH, status: 'ACTIVE', subscriptionId: 'sub_nova' },
      'GET /subscriptions/sub_antiga/payments*': { data: [] },
      'DELETE /subscriptions/sub_antiga': { deleted: true },
    });
    const ev = evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_at2', { status: 'ACTIVE' });
    await enviar(app, ev);
    const r2 = await enviar(app, ev);
    await svc.aguardarTarefas();
    expect(r2.body).toMatchObject({ duplicate: true });
    expect(chamadasAsaas(asaasClient).filter((c) => c === 'DELETE /subscriptions/sub_antiga')).toHaveLength(1);
  });

  test('cobrança vencida na assinatura antiga: nada é cancelado e a equipe recebe o motivo', async () => {
    const { app, db, asaasClient, notifications, svc } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    asaasDeMentira(asaasClient, {
      ['GET /pix/automatic/authorizations/' + AUTH]: { id: AUTH, status: 'ACTIVE', subscriptionId: 'sub_nova' },
      'GET /subscriptions/sub_antiga/payments?status=OVERDUE*': { data: [{ id: 'pay_venc', status: 'OVERDUE', dueDate: '2099-02-23', value: 140.83 }] },
    });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_at3', { status: 'ACTIVE' }));
    await svc.aguardarTarefas();

    expect(chamadasAsaas(asaasClient).some((c) => c.startsWith('DELETE'))).toBe(false);
    expect(estado.empresa.asaas_subscription_id).toBe('sub_antiga');
    expect(estado.empresa.pix_auto_status).toBe('active');
    expect(titulos(notifications)).toEqual(['Pix Automático ativo, falta trocar a assinatura: Loja Piloto']);
    expect(notifications.notifyCompany.mock.calls[0][1].body).toContain('2099-02-23');
    expect(notifications.notifyCompany.mock.calls[0][1].dedupeKey).toBe('pix-auto-troca-pendente:' + AUTH);
  });

  test('na Asaas a autorização não está ACTIVE: nada é cancelado', async () => {
    const { app, db, asaasClient, notifications, svc } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    asaasDeMentira(asaasClient, {
      ['GET /pix/automatic/authorizations/' + AUTH]: { id: AUTH, status: 'CANCELLED' },
    });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_at4', { status: 'ACTIVE' }));
    await svc.aguardarTarefas();
    expect(chamadasAsaas(asaasClient)).toEqual(['GET /pix/automatic/authorizations/' + AUTH]);
    expect(estado.empresa.asaas_subscription_id).toBe('sub_antiga');
    expect(titulos(notifications)).toEqual(['Pix Automático ativo, falta trocar a assinatura: Loja Piloto']);
  });

  test('a Asaas falha no meio (cancelar a antiga): a empresa segue na antiga e a equipe é avisada', async () => {
    const { app, db, asaasClient, notifications, svc } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    const falha = new Error('Asaas 500'); falha.asaasStatus = 500;
    asaasDeMentira(asaasClient, {
      ['GET /pix/automatic/authorizations/' + AUTH]: { id: AUTH, status: 'ACTIVE', subscriptionId: 'sub_nova' },
      'GET /subscriptions/sub_antiga/payments*': { data: [] },
      'DELETE /subscriptions/sub_antiga': falha,
    });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_at5', { status: 'ACTIVE' }));
    await svc.aguardarTarefas();
    expect(estado.empresa.asaas_subscription_id).toBe('sub_antiga');
    expect(titulos(notifications)).toEqual(['Pix Automático ativo, falta trocar a assinatura: Loja Piloto']);
  });

  test('PIX_AUTOMATIC_TROCA_AUTOMATICA=false: status ativo, troca fica para a rota de staff', async () => {
    process.env.PIX_AUTOMATIC_TROCA_AUTOMATICA = 'false';
    const { app, db, asaasClient, notifications, svc } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_at6', { status: 'ACTIVE' }));
    await svc.aguardarTarefas();
    expect(r.body).toMatchObject({ status: 'active', troca: 'manual' });
    expect(asaasClient.asaasRequest).not.toHaveBeenCalled();
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
    expect(estado.empresa.asaas_subscription_id).toBe('sub_antiga');
  });

  test('chave geral desligada: ACTIVATED não troca nada', async () => {
    const { app, db, asaasClient, svc } = buildApp({ ligado: false });
    const estado = bancoDeMentira(db, { empresa: loja() });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_at7', { status: 'ACTIVE' }));
    await svc.aguardarTarefas();
    expect(asaasClient.asaasRequest).not.toHaveBeenCalled();
    expect(estado.empresa.asaas_subscription_id).toBe('sub_antiga');
  });

  test('autorização antiga que fica ACTIVE não dispara troca', async () => {
    const { app, db, asaasClient, svc } = buildApp();
    bancoDeMentira(db, {
      empresa: loja({ asaas_pix_auto_authorization_id: 'auth-nova' }),
      autorizacoes: [{ id: AUTH, company_id: LOJA, status: 'pending' }],
    });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'evt_at8', { status: 'ACTIVE' }));
    await svc.aguardarTarefas();
    expect(asaasClient.asaasRequest).not.toHaveBeenCalled();
  });
});

describe('recusa (REFUSED)', () => {
  test('REFUSED depois do RECEIVED: nada liga, nada é cancelado e a equipe confere a cobrança antiga', async () => {
    const { app, db, asaasClient, notifications, svc } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja() });
    asaasClient.asaas.mockResolvedValue({ data: [] });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CREATED', 'evt_r1'));
    await enviar(app, {
      id: 'evt_r2', event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_qr', customer: 'cus_loja', value: 140.83, billingType: 'PIX', status: 'RECEIVED',
        paymentDate: '2099-03-01', dueDate: '2099-03-01' },
    });
    const r = await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED', 'evt_r3', { status: 'REFUSED' }));
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED', 'evt_r3', { status: 'REFUSED' }));
    await svc.aguardarTarefas();

    expect(r.body).toMatchObject({ status: 'refused', alerta: true });
    expect(r.body.troca).toBeUndefined();
    expect(estado.empresa.pix_auto_status).toBe('refused');
    expect(estado.empresa.asaas_subscription_id).toBe('sub_antiga');
    expect(asaasClient.asaasRequest).not.toHaveBeenCalled();
    expect(titulos(notifications)).toEqual(['Pix Automático não foi ativado: Loja Piloto']);
    expect(notifications.notifyCompany.mock.calls[0][1].body).toContain('não pagar o mesmo mês duas vezes');
    expect(notifications.notifyCompany.mock.calls[0][1].dedupeKey).toBe('pix-auto-recusada:' + AUTH);
  });

  test('REFUSED de autorização já encerrada não muda nada nem avisa', async () => {
    const { app, db, notifications } = buildApp();
    const estado = bancoDeMentira(db, { empresa: loja({ pix_auto_status: 'cancelled' }) });
    await enviar(app, evento('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED', 'evt_r4', { status: 'REFUSED' }));
    expect(estado.empresa.pix_auto_status).toBe('cancelled');
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
  });
});
