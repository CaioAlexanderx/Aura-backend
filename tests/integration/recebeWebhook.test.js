// ============================================================
// AURA. — Testes: Recebe na Aura, avisos da Asaas das subcontas (RA-07)
// Cobre:
//   token: sem segredo configurado → 401 sempre; segredo curto → 401; token
//     errado ou ausente → 401; nada lido nem gravado; token nunca no log;
//     sandbox usa o segredo do sandbox (o de produção não vale lá)
//   flag desligada: 200 sem processar, evento registrado como flag_off
//   ACCOUNT_STATUS_* (inclusive documentos) grava os 4 blocos pela função
//     do RA-06; retrato mais velho não sobrescreve um mais novo
//   idempotência: reenvio e duas entregas ao mesmo tempo processam uma vez
//   falha no processamento → 500 + 'error'; o reenvio retoma
//   subconta desconhecida: registra sem empresa, não processa
//   PAYMENT_*: só registra (id do pagamento e externalReference)
//   migration 449 pendente: 503 com a flag ligada, 200 com ela desligada
//
// Banco mockado por SQL (tabelas em memória). Nenhuma chamada à Asaas.
// ============================================================
'use strict';

delete process.env.ASAAS_ENV;

const request = require('supertest');

let app, db, svc;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  svc = require('../../src/services/recebeWebhookService');
});

// Segredos só de teste (≥ 32 caracteres, como a Asaas exige).
const TOKEN = 'token-de-teste-do-recebe-na-aura-0123456789';
const SANDBOX_TOKEN = 'token-de-teste-do-sandbox-recebe-9876543210';
const URL = '/api/v1/webhooks/asaas-recebe';

const companyA = 'a0000000-0000-4000-8000-00000000000a';
const ACC_A = 'acc-subconta-a-teste';

let baas;      // company_baas_accounts por company_id
let events;    // recebe_webhook_events por asaas_event_id
let semTabela; // migration 449 pendente
let falharGravacao; // próxima gravação da situação falha
let seq;

function rowsOf(r) { return Promise.resolve({ rows: r }); }

function fakeQuery(sql, params = []) {
  const s = String(sql);
  if (s.includes('recebe_webhook_events')) {
    if (semTabela) {
      const e = new Error('relation "recebe_webhook_events" does not exist');
      e.code = '42P01';
      return Promise.reject(e);
    }
    if (/^\s*INSERT INTO recebe_webhook_events/.test(s)) {
      const [eventId, event, accountId, paymentId, extRef, eventAt, payload, outcome] = params;
      if (events[eventId]) return rowsOf([]);
      const id = `ev-${++seq}`;
      events[eventId] = {
        id, asaas_event_id: eventId, event, asaas_account_id: accountId, asaas_payment_id: paymentId,
        external_reference: extRef, event_created_at: eventAt, payload: JSON.parse(payload),
        outcome, attempts: 1, company_id: null, detail: null, claimed_at: Date.now(),
      };
      return rowsOf([{ id }]);
    }
    if (/SET outcome = 'processing'/.test(s)) {
      const [eventId, minutes] = params;
      const ev = events[eventId];
      const parado = ev && ev.outcome === 'processing' && ev.claimed_at < Date.now() - Number(minutes) * 60000;
      if (!ev || !(ev.outcome === 'error' || parado)) return rowsOf([]);
      Object.assign(ev, { outcome: 'processing', attempts: ev.attempts + 1, claimed_at: Date.now(), detail: null });
      return rowsOf([{ id: ev.id }]);
    }
    if (/SET outcome = \$2/.test(s)) {
      const [id, outcome, detail, companyId] = params;
      const ev = Object.values(events).find((e) => e.id === id);
      if (ev) Object.assign(ev, { outcome, detail, company_id: companyId });
      return rowsOf([]);
    }
    return rowsOf([]);
  }
  if (s.includes('company_baas_accounts')) {
    if (/SELECT company_id FROM company_baas_accounts WHERE asaas_account_id/.test(s)) {
      const row = Object.values(baas).find((r) => r.asaas_account_id === params[0]);
      return rowsOf(row ? [{ company_id: row.company_id }] : []);
    }
    if (/^\s*SELECT status FROM company_baas_accounts/.test(s)) {
      const row = baas[params[0]];
      return rowsOf(row ? [{ status: row.status }] : []);
    }
    if (/^\s*UPDATE company_baas_accounts\s+SET account_status/.test(s)) {
      if (falharGravacao) {
        falharGravacao = false;
        return Promise.reject(new Error('conexão caiu'));
      }
      const [cid, st, at, status] = params;
      const row = baas[cid];
      if (!row) return rowsOf([]);
      if (row.account_status_at && new Date(row.account_status_at) > new Date(at)) return rowsOf([]);
      Object.assign(row, { account_status: JSON.parse(st), account_status_at: at, status });
      row.saves = (row.saves || 0) + 1;
      return rowsOf([{ status }]);
    }
  }
  return rowsOf([]);
}

function contaCriada(cid, accId, extra = {}) {
  baas[cid] = { company_id: cid, asaas_account_id: accId, status: 'created', ...extra };
}

const statusBody = (id, event, at, st, accId = ACC_A) => ({
  id, event, dateCreated: at,
  account: { id: accId, ownerId: null },
  accountStatus: { id: accId, ...st },
});

const post = (body, token = TOKEN) => {
  const r = request(app).post(URL);
  if (token != null) r.set('asaas-access-token', token);
  return r.send(body);
};

let logSpies;
beforeEach(() => {
  baas = {};
  events = {};
  semTabela = false;
  falharGravacao = false;
  seq = 0;
  db.query.mockReset();
  db.query.mockImplementation(fakeQuery);
  process.env.RECEBE_ASAAS_WEBHOOK_TOKEN = TOKEN;
  logSpies = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m));
});
afterEach(() => {
  delete process.env.RECEBE_NA_AURA_ENABLED;
  delete process.env.RECEBE_ASAAS_WEBHOOK_TOKEN;
  delete process.env.RECEBE_ASAAS_SANDBOX_WEBHOOK_TOKEN;
  delete process.env.ASAAS_ENV;
  logSpies.forEach((sp) => sp.mockRestore());
});
const loggedText = () => logSpies.map((sp) => JSON.stringify(sp.mock.calls)).join('\n');
const docAprovado = (id, at) => statusBody(id, 'ACCOUNT_STATUS_DOCUMENT_APPROVED', at, {
  commercialInfo: 'APPROVED', documentation: 'APPROVED', bankAccountInfo: 'APPROVED', general: 'AWAITING_APPROVAL',
});

describe('token do webhook', () => {
  beforeEach(() => { process.env.RECEBE_NA_AURA_ENABLED = 'true'; contaCriada(companyA, ACC_A); });

  test('sem segredo configurado → 401 sempre, mesmo com qualquer token', async () => {
    delete process.env.RECEBE_ASAAS_WEBHOOK_TOKEN;
    for (const t of [TOKEN, '', 'x'.repeat(40)]) {
      const r = await post(docAprovado('evt_1', '2026-11-13 10:00:00'), t);
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('UNAUTHORIZED');
    }
    expect(db.query).not.toHaveBeenCalled();
    expect(loggedText()).toContain('RECEBE_ASAAS_WEBHOOK_TOKEN');
  });

  test('segredo com menos de 32 caracteres conta como não configurado', async () => {
    process.env.RECEBE_ASAAS_WEBHOOK_TOKEN = 'curto-demais';
    const r = await post(docAprovado('evt_1', '2026-11-13 10:00:00'), 'curto-demais');
    expect(r.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test.each([
    ['errado', 'token-errado-mas-bem-comprido-0123456789abc'],
    ['ausente', null],
    ['vazio', ''],
  ])('token %s → 401, nada lido nem gravado', async (_n, t) => {
    const r = await post(docAprovado('evt_1', '2026-11-13 10:00:00'), t);
    expect(r.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(Object.keys(events)).toHaveLength(0);
  });

  test('o token nunca aparece no log', async () => {
    await post(docAprovado('evt_1', '2026-11-13 10:00:00'), 'token-errado-mas-bem-comprido-0123456789abc');
    await post(docAprovado('evt_2', '2026-11-13 10:00:00'));
    const txt = loggedText();
    expect(txt).not.toContain(TOKEN);
    expect(txt).not.toContain('token-errado-mas-bem-comprido');
  });

  test('sandbox: vale o segredo do sandbox; o de produção é recusado', async () => {
    process.env.ASAAS_ENV = 'sandbox';
    process.env.RECEBE_ASAAS_SANDBOX_WEBHOOK_TOKEN = SANDBOX_TOKEN;
    expect((await post(docAprovado('evt_1', '2026-11-13 10:00:00'), TOKEN)).status).toBe(401);
    expect((await post(docAprovado('evt_2', '2026-11-13 10:00:00'), SANDBOX_TOKEN)).status).toBe(200);
  });

  test('sandbox sem o segredo do sandbox → 401 (não cai no de produção)', async () => {
    process.env.ASAAS_ENV = 'sandbox';
    expect((await post(docAprovado('evt_1', '2026-11-13 10:00:00'), TOKEN)).status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('flag desligada', () => {
  test('200 sem processar; o aviso fica registrado como flag_off', async () => {
    contaCriada(companyA, ACC_A);
    const r = await post(docAprovado('evt_1', '2026-11-13 10:00:00'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, handled: false, reason: 'flag_off' });
    expect(events.evt_1).toMatchObject({ outcome: 'flag_off', company_id: null });
    expect(baas[companyA].account_status).toBeUndefined();
    expect(baas[companyA].status).toBe('created');
  });

  test('migration 449 pendente com a flag desligada: 200 do mesmo jeito', async () => {
    semTabela = true;
    const r = await post(docAprovado('evt_1', '2026-11-13 10:00:00'));
    expect(r.status).toBe(200);
    expect(r.body.reason).toBe('flag_off');
  });
});

describe('flag ligada', () => {
  beforeEach(() => { process.env.RECEBE_NA_AURA_ENABLED = 'true'; contaCriada(companyA, ACC_A); });

  test('documentos aprovados: grava os 4 blocos e o status resumido', async () => {
    const r = await post(docAprovado('evt_1', '2026-11-13 10:00:00'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, handled: true, outcome: 'processed' });
    expect(baas[companyA].account_status).toEqual({
      commercialInfo: 'APPROVED', documentation: 'APPROVED', bankAccountInfo: 'APPROVED', general: 'AWAITING_APPROVAL',
    });
    expect(baas[companyA].status).toBe('under_review');
    // dateCreated da Asaas é horário de Brasília
    expect(baas[companyA].account_status_at).toBe('2026-11-13T13:00:00.000Z');
    expect(events.evt_1).toMatchObject({ outcome: 'processed', company_id: companyA, asaas_account_id: ACC_A });
  });

  test('documentos pendentes → docs_pending; conta aprovada → approved', async () => {
    await post(statusBody('evt_1', 'ACCOUNT_STATUS_DOCUMENT_PENDING', '2026-11-13 10:00:00', {
      commercialInfo: 'APPROVED', documentation: 'PENDING', bankAccountInfo: 'APPROVED', general: 'PENDING',
    }));
    expect(baas[companyA].status).toBe('docs_pending');
    await post(statusBody('evt_2', 'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED', '2026-11-13 11:00:00', {
      commercialInfo: 'APPROVED', documentation: 'APPROVED', bankAccountInfo: 'APPROVED', general: 'APPROVED',
    }));
    expect(baas[companyA].status).toBe('approved');
  });

  test('retrato mais velho não sobrescreve um mais novo', async () => {
    await post(statusBody('evt_novo', 'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED', '2026-11-13 12:00:00', {
      commercialInfo: 'APPROVED', documentation: 'APPROVED', bankAccountInfo: 'APPROVED', general: 'APPROVED',
    }));
    const r = await post(statusBody('evt_velho', 'ACCOUNT_STATUS_DOCUMENT_PENDING', '2026-11-13 09:00:00', {
      commercialInfo: 'APPROVED', documentation: 'PENDING', bankAccountInfo: 'APPROVED', general: 'PENDING',
    }));
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('stale');
    expect(baas[companyA].account_status.general).toBe('APPROVED');
    expect(baas[companyA].status).toBe('approved');
    expect(events.evt_velho.outcome).toBe('stale');
  });

  test('sem dateCreated: registra e não grava (não arrisca sobrescrever retrato mais novo)', async () => {
    const body = docAprovado('evt_1', undefined);
    delete body.dateCreated;
    const r = await post(body);
    expect(r.status).toBe(200);
    expect(events.evt_1).toMatchObject({ outcome: 'registered', detail: 'sem_data_do_evento' });
    expect(baas[companyA].account_status).toBeUndefined();
  });

  test('reenvio do mesmo evento: 200 duplicate, processado uma vez só', async () => {
    const body = docAprovado('evt_1', '2026-11-13 10:00:00');
    expect((await post(body)).body.outcome).toBe('processed');
    const r = await post(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, duplicate: true });
    expect(baas[companyA].saves).toBe(1);
    expect(events.evt_1.attempts).toBe(1);
  });

  test('duas entregas iguais ao mesmo tempo: uma processa, a outra é duplicate', async () => {
    const body = docAprovado('evt_1', '2026-11-13 10:00:00');
    const [a, b] = await Promise.all([post(body), post(body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.duplicate, b.body.duplicate].filter(Boolean)).toHaveLength(1);
    expect(baas[companyA].saves).toBe(1);
  });

  test('falha ao processar: 500 e error; o reenvio da Asaas retoma e processa', async () => {
    falharGravacao = true;
    const body = docAprovado('evt_1', '2026-11-13 10:00:00');
    const r1 = await post(body);
    expect(r1.status).toBe(500);
    expect(events.evt_1.outcome).toBe('error');
    const r2 = await post(body);
    expect(r2.status).toBe(200);
    expect(r2.body.outcome).toBe('processed');
    expect(events.evt_1).toMatchObject({ outcome: 'processed', attempts: 2 });
    expect(baas[companyA].saves).toBe(1);
    // e um terceiro envio já é duplicate
    expect((await post(body)).body.duplicate).toBe(true);
  });

  test('processing recente (outra entrega no meio) não é retomado', async () => {
    events.evt_1 = { id: 'ev-x', asaas_event_id: 'evt_1', outcome: 'processing', attempts: 1, claimed_at: Date.now() };
    const r = await post(docAprovado('evt_1', '2026-11-13 10:00:00'));
    expect(r.body.duplicate).toBe(true);
    expect(baas[companyA].saves).toBeUndefined();
  });

  test('processing parado há mais de 5 min é retomado', async () => {
    events.evt_1 = { id: 'ev-x', asaas_event_id: 'evt_1', outcome: 'processing', attempts: 1, claimed_at: Date.now() - 6 * 60000 };
    const r = await post(docAprovado('evt_1', '2026-11-13 10:00:00'));
    expect(r.body.outcome).toBe('processed');
    expect(events.evt_1.attempts).toBe(2);
  });

  test('subconta desconhecida: registra sem empresa e não processa', async () => {
    const r = await post(statusBody('evt_1', 'ACCOUNT_STATUS_DOCUMENT_APPROVED', '2026-11-13 10:00:00',
      { documentation: 'APPROVED' }, 'acc-que-nao-existe'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handled: false, reason: 'unknown_account' });
    expect(events.evt_1).toMatchObject({ outcome: 'unknown_account', company_id: null, asaas_account_id: 'acc-que-nao-existe' });
    expect(baas[companyA].saves).toBeUndefined();
  });

  test('aviso sem account: registra sem empresa', async () => {
    const r = await post({ id: 'evt_1', event: 'PAYMENT_RECEIVED', dateCreated: '2026-11-13 10:00:00', payment: { id: 'pay_1' } });
    expect(r.body.reason).toBe('unknown_account');
    expect(events.evt_1).toMatchObject({ outcome: 'unknown_account', detail: 'sem_account_id', company_id: null });
  });

  test.each(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_SPLIT_DONE'])(
    '%s: só registra (pagamento e externalReference), sem efeito na conta', async (ev) => {
      const r = await post({
        id: 'evt_pay', event: ev, dateCreated: '2026-11-13 10:00:00',
        account: { id: ACC_A, ownerId: null },
        payment: { object: 'payment', id: 'pay_123', status: 'RECEIVED', value: 50, externalReference: 'recebe:pedido:abc' },
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ handled: false, outcome: 'registered' });
      expect(events.evt_pay).toMatchObject({
        outcome: 'registered', company_id: companyA, asaas_payment_id: 'pay_123',
        external_reference: 'recebe:pedido:abc', event: ev,
      });
      expect(baas[companyA].saves).toBeUndefined();
    });

  test('evento que o Recebe não trata: registra como ignored', async () => {
    const r = await post({ id: 'evt_t', event: 'TRANSFER_DONE', dateCreated: '2026-11-13 10:00:00', account: { id: ACC_A } });
    expect(r.status).toBe(200);
    expect(events.evt_t).toMatchObject({ outcome: 'ignored', company_id: companyA });
  });

  test('aviso sem id de evento: 200, nada registrado nem processado', async () => {
    const body = docAprovado(undefined, '2026-11-13 10:00:00');
    delete body.id;
    const r = await post(body);
    expect(r.status).toBe(200);
    expect(r.body.reason).toBe('sem_id');
    expect(Object.keys(events)).toHaveLength(0);
    expect(baas[companyA].saves).toBeUndefined();
  });

  test('migration 449 pendente: 503 para a Asaas reenviar, nada processado', async () => {
    semTabela = true;
    const r = await post(docAprovado('evt_1', '2026-11-13 10:00:00'));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('SCHEMA_PENDING');
    expect(baas[companyA].saves).toBeUndefined();
  });
});

describe('peças puras', () => {
  test.each([
    ['2026-11-13 10:00:00', '2026-11-13T13:00:00.000Z'],
    ['2026-11-13T10:00:00Z', '2026-11-13T10:00:00.000Z'],
    ['2026-11-13', '2026-11-13T03:00:00.000Z'],
  ])('parseAsaasDate(%s)', (v, iso) => {
    expect(svc.parseAsaasDate(v).toISOString()).toBe(iso);
  });

  test.each(['', null, 'ontem', '2026-13-45 99:99:99'])('parseAsaasDate(%p) → null', (v) => {
    expect(svc.parseAsaasDate(v)).toBeNull();
  });

  test('os 18 eventos de situação da conta da Asaas são tratados como conta', () => {
    expect(svc.ACCOUNT_STATUS_EVENTS).toHaveLength(18);
    for (const e of svc.ACCOUNT_STATUS_EVENTS) expect(svc.kindOf(e)).toBe('account_status');
    expect(svc.ACCOUNT_STATUS_EVENTS.filter((e) => e.startsWith('ACCOUNT_STATUS_DOCUMENT_'))).toHaveLength(4);
    expect(svc.kindOf('PAYMENT_RECEIVED')).toBe('payment');
    expect(svc.kindOf('TRANSFER_DONE')).toBe('other');
  });
});
