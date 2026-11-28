// ============================================================
// AURA — WhatsApp: modelos-base preparados sozinhos na conexão
// Prova: (1) a conexão chama o preparo depois de responder; (2) falha do
// preparo não derruba a conexão e não vaza token; (3) a rede de segurança
// só cria o que falta e é idempotente; (4) nada passa pela wa_outbox.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  exchangeCodeForToken: jest.fn(), getPhoneInfo: jest.fn(), listPhoneNumbers: jest.fn(),
  subscribeApp: jest.fn(), unsubscribeApp: jest.fn(), registerPhone: jest.fn(),
  getPhoneOnboarding: jest.fn(), shareCreditLine: jest.fn(), createTemplate: jest.fn(),
}));
jest.mock('../src/services/lojaEvents', () => ({ emitLojaEvent: jest.fn().mockResolvedValue({ id: 'n1' }) }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const waOutbox = require('../src/services/waOutbox');
const catalogo = require('../src/services/waAutomaticas/modelos');
const store = require('../src/services/waAutomaticas/modelosStore');
const job = require('../src/jobs/waModelosPreparoJob');

const COMPANY = 'company-uuid-wa-modelos';
const TOTAL = catalogo.listar().length;
const token = jwt.sign({ id: 'user-admin', role: 'admin', plan: 'essencial' }, 'aura-test-secret-2026', { expiresIn: '1h' });
const flush = () => new Promise((r) => setImmediate(r));

// Banco falso: wa_templates por loja, só o que o preparo toca.
function simular({ conectadas = [COMPANY], templates = {} } = {}) {
  const estado = templates; // companyId -> Map(name -> status)
  const outbox = [];
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (s.includes('wa_outbox')) outbox.push(s);
    if (s.includes('-- wa:modelos-faltando')) {
      const ids = conectadas.filter((id) => (estado[id] ? estado[id].size : 0) < TOTAL);
      return Promise.resolve({ rows: ids.map((id) => ({ id })) });
    }
    if (s.includes('-- wa:modelos-cred')) return Promise.resolve({ rows: [{ wa_waba_id: 'W1', wa_access_token: 'EAAsegredoLongoDoTokenDaMeta12345' }] });
    if (s.includes('-- wa:modelos-padroes')) {
      const m = estado[params[0]] || new Map();
      return Promise.resolve({ rows: [...m].map(([name, status]) => ({ name, status })) });
    }
    return Promise.resolve({ rows: [] });
  });
  return { estado, outbox };
}

let applySpy;
beforeEach(() => {
  applySpy = jest.spyOn(waOutbox, 'applyTemplateStatus');
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  Object.values(wa).forEach((f) => f.mockReset && f.mockReset());
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/whatsappCloud'));
  return app;
}

async function conectar() {
  wa.exchangeCodeForToken.mockResolvedValue('EAAtokenNovoDaConexaoQueNaoPodeVazar99');
  wa.subscribeApp.mockResolvedValue({ success: true });
  wa.registerPhone.mockResolvedValue({ success: true });
  wa.getPhoneOnboarding.mockResolvedValue({ is_on_biz_app: false });
  wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 99999-0000' });
  return request(buildApp())
    .post(`/companies/${COMPANY}/whatsapp/connect`)
    .set('Authorization', 'Bearer ' + token)
    .send({ code: 'CODE', waba_id: 'WABA1', phone_number_id: 'PN1' });
}

describe('conexão do número', () => {
  test('depois de conectar, chama o preparo dos modelos para a loja', async () => {
    simular();
    const spy = jest.spyOn(store, 'prepararPadroesSeguro').mockResolvedValue({ ok: true });
    const res = await conectar();
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    await flush();
    expect(spy).toHaveBeenCalledWith(COMPANY, { origem: 'conexao' });
  });

  test('não chama o preparo se o número não ficou registrado', async () => {
    simular();
    wa.registerPhone.mockReset();
    const spy = jest.spyOn(store, 'prepararPadroesSeguro').mockResolvedValue({ ok: true });
    wa.exchangeCodeForToken.mockResolvedValue('EAAtokenNovoDaConexaoQueNaoPodeVazar99');
    wa.subscribeApp.mockResolvedValue({ success: true });
    wa.registerPhone.mockRejectedValue(new Error('falhou'));
    wa.getPhoneOnboarding.mockResolvedValue({ is_on_biz_app: false });
    wa.getPhoneInfo.mockResolvedValue({});
    const res = await request(buildApp())
      .post(`/companies/${COMPANY}/whatsapp/connect`)
      .set('Authorization', 'Bearer ' + token)
      .send({ code: 'CODE', waba_id: 'WABA1', phone_number_id: 'PN1' });
    expect(res.status).toBe(200);
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });

  test('o preparo falha na Meta: a conexão responde 200 e o log não leva o token', async () => {
    simular();
    wa.createTemplate.mockRejectedValue(new Error('Meta fora, token EAAtokenNovoDaConexaoQueNaoPodeVazar99'));
    const res = await conectar();
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    await flush(); await flush();
    expect(wa.createTemplate).toHaveBeenCalled();
    const log = console.error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(log).toMatch(/preparo \(conexao\) falhou/);
    expect(log).toMatch(/META_RECUSOU/);
    expect(log).not.toMatch(/EAAtokenNovo/);
    expect(log).not.toMatch(/EAAsegredo/);
  });
});

describe('rede de segurança', () => {
  test('cria só o que falta e uma segunda rodada não cria nada (idempotente)', async () => {
    const { estado, outbox } = simular({ templates: { [COMPANY]: new Map() } });
    // já existem 3 modelos (um deles ainda PENDING na Meta)
    const todos = catalogo.listar().map((m) => m.template_base);
    todos.slice(0, 3).forEach((n) => estado[COMPANY].set(n, 'PENDING'));
    wa.createTemplate.mockResolvedValue({ id: '1', status: 'PENDING' });
    applySpy.mockImplementation(async (cid, { name, status }) => { estado[cid].set(name, status); });

    const r1 = await store.prepararPendentes();
    expect(r1).toEqual({ lojas: 1, ok: 1, falhas: 0 });
    expect(wa.createTemplate).toHaveBeenCalledTimes(TOTAL - 3);
    expect(estado[COMPANY].size).toBe(TOTAL);

    wa.createTemplate.mockClear();
    const r2 = await store.prepararPendentes();
    expect(r2).toEqual({ lojas: 0, ok: 0, falhas: 0 });
    expect(wa.createTemplate).not.toHaveBeenCalled();
    expect(outbox).toEqual([]); // nada passou pela wa_outbox
  });

  test('uma loja que falha não impede as outras e conta como falha; a próxima rodada tenta de novo', async () => {
    const OUTRA = 'company-uuid-outra';
    const { estado } = simular({ conectadas: [COMPANY, OUTRA], templates: { [COMPANY]: new Map(), [OUTRA]: new Map() } });
    applySpy.mockImplementation(async (cid, { name, status }) => { estado[cid].set(name, status); });
    wa.createTemplate.mockRejectedValueOnce(new Error('Meta fora')).mockResolvedValue({ id: '1', status: 'PENDING' });
    const r1 = await store.prepararPendentes();
    expect(r1).toEqual({ lojas: 2, ok: 1, falhas: 1 });
    const r2 = await store.prepararPendentes();
    expect(r2).toEqual({ lojas: 1, ok: 1, falhas: 0 });
    expect(estado[COMPANY].size).toBe(TOTAL);
    expect(estado[OUTRA].size).toBe(TOTAL);
  });

  test('duas chamadas ao mesmo tempo para a mesma loja: a Meta é chamada uma vez por modelo', async () => {
    const { estado } = simular({ templates: { [COMPANY]: new Map() } });
    applySpy.mockImplementation(async (cid, { name, status }) => { estado[cid].set(name, status); });
    wa.createTemplate.mockResolvedValue({ id: '1', status: 'PENDING' });
    const [a, b] = await Promise.all([
      store.prepararPadroesSeguro(COMPANY), store.prepararPadroesSeguro(COMPANY),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(wa.createTemplate).toHaveBeenCalledTimes(TOTAL);
  });

  test('o job só chama o preparo de pendentes e não repete enquanto roda', async () => {
    const fake = { prepararPendentes: jest.fn().mockResolvedValue({ lojas: 0, ok: 0, falhas: 0 }) };
    await job.tick(fake);
    expect(fake.prepararPendentes).toHaveBeenCalledTimes(1);
  });

  test('tabela ausente (42P01): nenhuma loja, sem erro', async () => {
    db.query.mockRejectedValue(Object.assign(new Error('x'), { code: '42P01' }));
    await expect(store.prepararPendentes()).resolves.toEqual({ lojas: 0, ok: 0, falhas: 0 });
  });
});
