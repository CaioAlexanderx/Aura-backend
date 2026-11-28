// ============================================================
// AURA — Trava da Aurinha no WhatsApp (28/11/2026)
//
// AURINHA_WA_LIBERADA desligada (padrao): a Aurinha nao responde loja
// nenhuma, nao consome o saldo "aurinha" e PUT /hub/settings com
// enabled:true recusa com 403 AURINHA_NAO_LIBERADA. Empresa sandbox, a
// propria Aura e a equipe (is_staff) passam. Com a trava ligada, tudo
// como antes.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/aurinhaAgent', () => ({
  responderSuporte: jest.fn(async () => ({ texto: 'Oi! Aqui e a Aurinha.' })),
}));

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const aurinhaLiberada = require('../src/services/aurinhaLiberada');
const waSaldoAurinha = require('../src/services/waSaldoAurinha');
const hubWhatsapp = require('../src/services/hubWhatsapp');

const LOJA = 'loja-comum';
const SANDBOX = 'loja-sandbox';
const CONV = 'conv-1';

function bancoFake() {
  const chamadas = [];
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    chamadas.push(s);
    if (s.includes('SELECT is_sandbox FROM companies')) return Promise.resolve({ rows: [{ is_sandbox: false }] });
    return Promise.resolve({ rows: [] });
  });
  return chamadas;
}

beforeEach(() => {
  delete process.env.AURINHA_WA_LIBERADA;
  delete process.env.AURA_COMPANY_ID;
  process.env.WA_SALDO_ATIVO = '1';
  db.query.mockReset();
  db.connect.mockReset();
});

describe('permitida', () => {
  test('desligada por padrao: loja comum nao passa', async () => {
    bancoFake();
    expect(await aurinhaLiberada.permitida(LOJA)).toBe(false);
  });
  test('sandbox passa; a Aura passa; trava ligada libera todas', async () => {
    db.query.mockImplementation(async (sql, p) => ({ rows: [{ is_sandbox: p[0] === SANDBOX }] }));
    expect(await aurinhaLiberada.permitida(SANDBOX)).toBe(true);
    process.env.AURA_COMPANY_ID = 'aura';
    expect(await aurinhaLiberada.permitida('aura')).toBe(true);
    process.env.AURINHA_WA_LIBERADA = '1';
    expect(await aurinhaLiberada.permitida(LOJA)).toBe(true);
  });
  test('erro ao ler a empresa: na duvida, calada', async () => {
    db.query.mockRejectedValue(Object.assign(new Error('boom'), { code: 'XX000' }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await aurinhaLiberada.permitida(LOJA)).toBe(false);
  });
});

describe('atender (saldo da Aurinha)', () => {
  test('trava desligada: recusa e nao consome (nem abre transacao)', async () => {
    bancoFake();
    const r = await waSaldoAurinha.atender({ companyId: LOJA, conversationId: CONV });
    expect(r).toMatchObject({ ok: false, code: 'AURINHA_NAO_LIBERADA' });
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('sandbox passa da trava e chega ao saldo', async () => {
    db.query.mockImplementation(async () => ({ rows: [{ is_sandbox: true }] }));
    process.env.WA_SALDO_ATIVO = '0';
    const r = await waSaldoAurinha.atender({ companyId: SANDBOX, conversationId: CONV });
    expect(r).toEqual({ ok: true, modo: 'desligado' });
  });

  test('trava ligada: segue o fluxo de sempre', async () => {
    bancoFake();
    process.env.AURINHA_WA_LIBERADA = '1';
    process.env.WA_SALDO_ATIVO = '0';
    expect(await waSaldoAurinha.atender({ companyId: LOJA, conversationId: CONV })).toEqual({ ok: true, modo: 'desligado' });
  });
});

describe('avaliarConversa', () => {
  const conv = { id: CONV, company_id: LOJA, external_id: '5511999990000', status: 'ia', last_inbound_at: new Date().toISOString(), aguardando_resposta_desde: new Date().toISOString() };

  test('trava desligada: nao responde, limpa a pendencia e deixa a conversa com a lojista', async () => {
    const chamadas = bancoFake();
    const r = await hubWhatsapp.avaliarConversa(conv, { companyId: LOJA, plantao: null });
    expect(r).toEqual({ respondeu: false, motivo: 'AURINHA_NAO_LIBERADA' });
    const upd = chamadas.find((s) => s.includes('hubwa:aurinha-travada'));
    expect(upd).toBeTruthy();
    expect(upd).toMatch(/aguardando_resposta_desde = NULL/);
    expect(upd).toMatch(/precisa_humano/);
    expect(chamadas.some((s) => s.includes('hubwa:claim'))).toBe(false);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('trava ligada: nao cai na trava', async () => {
    const chamadas = bancoFake();
    process.env.AURINHA_WA_LIBERADA = '1';
    await hubWhatsapp.avaliarConversa(conv, { companyId: LOJA, plantao: null }).catch(() => {});
    expect(chamadas.some((s) => s.includes('hubwa:aurinha-travada'))).toBe(false);
  });
});

describe('PUT /hub/settings', () => {
  function app(user, role = 'owner') {
    const a = express();
    a.use(express.json());
    a.use('/companies/:id/hub', (req, _res, next) => { req.user = user; req.companyRole = role; next(); },
      require('../src/routes/hubSocial'));
    return a;
  }
  function banco({ sandbox = false } = {}) {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('SELECT is_sandbox FROM companies')) return { rows: [{ is_sandbox: sandbox }] };
      if (s.includes('INSERT INTO hub_agent_settings')) return { rows: [{ enabled: true, approval_mode: true, model: null, extra_instructions: null }] };
      return { rows: [] };
    });
  }

  test('desligada, loja comum: ligar recusa com 403 AURINHA_NAO_LIBERADA e nada grava', async () => {
    banco();
    const res = await request(app({ id: 'u1' })).put(`/companies/${LOJA}/hub/settings`).send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AURINHA_NAO_LIBERADA');
    expect(db.query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO hub_agent_settings'))).toBe(false);
  });

  test('desligar sempre pode, e mudar o modo aprovacao tambem', async () => {
    banco();
    const a = await request(app({ id: 'u1' })).put(`/companies/${LOJA}/hub/settings`).send({ enabled: false });
    expect(a.status).toBe(200);
    const b = await request(app({ id: 'u1' })).put(`/companies/${LOJA}/hub/settings`).send({ approval_mode: false });
    expect(b.status).toBe(200);
  });

  test('sandbox liga', async () => {
    banco({ sandbox: true });
    const res = await request(app({ id: 'u1' })).put(`/companies/${SANDBOX}/hub/settings`).send({ enabled: true });
    expect(res.status).toBe(200);
  });

  test('equipe Aura (is_staff) liga', async () => {
    banco();
    const res = await request(app({ id: 'u1', is_staff: true })).put(`/companies/${LOJA}/hub/settings`).send({ enabled: true });
    expect(res.status).toBe(200);
  });

  test('trava ligada: loja comum liga', async () => {
    banco();
    process.env.AURINHA_WA_LIBERADA = '1';
    const res = await request(app({ id: 'u1' })).put(`/companies/${LOJA}/hub/settings`).send({ enabled: true });
    expect(res.status).toBe(200);
  });
});
