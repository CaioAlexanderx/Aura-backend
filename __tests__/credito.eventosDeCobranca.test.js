// ============================================================
// AURA — histórico de avisos do crediário (credit_collection_events)
//
// 09/11/2026. Em produção a tabela tem company_id e customer_id NOT NULL
// (formato diferente da 136). Os dois INSERTs mandavam só installment_id,
// channel, template, days_relative, status e message_preview → 23502 a
// cada aviso: histórico nunca gravado, aviso manual devolvendo 500 e a
// régua automática parando no meio da company.
//
// Cobertura:
//  (1) buildNotice (aviso manual wa.me e saldo do Studio) grava com
//      company_id/customer_id da parcela, template/canal/dias nunca nulos.
//  (2) recordEvent (régua automática e avulso oficial) grava com
//      company_id/customer_id da parcela.
//  (3) 23502 no histórico NÃO derruba o tick: a régua segue para a
//      próxima parcela, o estágio avança e cada parcela vai à fila 1 vez.
//  (4) o tick seguinte não reenvia: sem o evento gravado, quem barra é o
//      dedupeKey da fila (DUPLICADO), e nada é contado como enfileirado.
//  (5) POST /collection/trigger (whatsapp_auto) com 23502 no histórico
//      devolve 200 queued — a mensagem já está na fila.
//  (6) POST /collection/trigger (wa.me) devolve o texto e grava o evento
//      com os dois ids.
//  (7) a 430 só adiciona (sem DROP, sem UPDATE, sem NOT NULL sem default).
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const addons = require('../src/services/addons');
const collectionAuto = require('../src/services/credit/collectionAuto');
const collectionNotice = require('../src/services/credit/collectionNotice');

const COMPANY = 'company-uuid-crediario';
const HOJE = '2026-09-14';

const token = jwt.sign(
  { id: 'user-lojista', role: 'admin', plan: 'negocio' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

function buildCreditApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/credit', require('../src/routes/creditInstallments'));
  return app;
}

function parcela(over = {}) {
  return {
    id: 'inst-1', company_id: COMPANY, customer_id: 'cust-1',
    installment_number: 2, total_installments: 6,
    amount_due: '150.00', covered_amount: '0.00',
    due_date: '2026-09-17', status: 'pending', pix_link: null,
    late_fee: '0', late_interest: '0', collection_stage: 0,
    customer_name: 'Ana Souza', phone: '11988887777',
    store_name: 'Loja Exemplo',
    ...over,
  };
}

function erro23502() {
  const e = new Error('null value in column "customer_id" of relation "credit_collection_events" violates not-null constraint');
  e.code = '23502';
  return e;
}

// "Banco" por âncora de SQL, igual ao de credito.whatsappAuto.test.js.
function mockBanco({ parcelas = [], eventoFalha = false, filaDuplicada = false } = {}) {
  const visto = { eventos: [], stages: [], outboxInserts: [], noticeEventos: [] };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (s.includes('crediario_enabled')) return Promise.resolve({ rows: [{ enabled: 'true' }] });
    if (s.includes('-- addon:has')) return Promise.resolve({ rows: [] });
    if (s.includes('-- addon:plan')) return Promise.resolve({ rows: [{ plan: 'negocio' }] });
    if (s.includes('-- wa:conn-state-flag')) return Promise.resolve({ rows: [{ wa_token_invalid_at: null }] });
    if (s.includes('-- wa:conn-state')) return Promise.resolve({ rows: [{ wa_phone_number_id: 'PN1', has_token: true }] });
    if (s.includes('-- wa:guard-template')) return Promise.resolve({ rows: [{ status: 'APPROVED' }] });
    if (s.includes('-- wa:guard-paused')) return Promise.resolve({ rows: [{ wa_paused_reason: null }] });
    if (s.includes('-- wa:guard-count-today')) return Promise.resolve({ rows: [{ n: 0 }] });
    if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: [] });
    if (s.includes('-- wa:outbox-enqueue')) {
      visto.outboxInserts.push(params);
      return Promise.resolve({ rows: filaDuplicada ? [] : [{ id: 'ob-' + visto.outboxInserts.length, status: params[7] }] });
    }
    if (s.includes('-- cred:auto-rules')) {
      return Promise.resolve({ rows: [{ company_id: COMPANY, enabled: true, whatsapp_auto: true,
        rules: [{ days: -3, active: true, channel: 'whatsapp', template: 'lembrete' }] }] });
    }
    if (s.includes('-- cred:auto-parcelas')) return Promise.resolve({ rows: parcelas });
    // O evento nunca foi gravado (é o caso de produção): dedupe pelo
    // histórico não acha nada.
    if (s.includes('-- cred:auto-ja-enviado')) return Promise.resolve({ rows: [] });
    if (s.includes('-- cred:auto-evento')) {
      visto.eventos.push(params);
      return eventoFalha ? Promise.reject(erro23502()) : Promise.resolve({ rows: [] });
    }
    if (s.includes('-- cred:auto-stage')) { visto.stages.push(params); return Promise.resolve({ rows: [] }); }
    if (s.includes('-- cred:notice-evento')) { visto.noticeEventos.push(params); return Promise.resolve({ rows: [] }); }
    if (s.includes('-- cred:trigger-parcela')) return Promise.resolve({ rows: parcelas.length ? [parcelas[0]] : [] });
    return Promise.resolve({ rows: [] });
  });
  db.connect.mockResolvedValue({ query: db.query, release: () => {} });
  return visto;
}

let errSpy;
beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  errSpy.mockRestore();
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
  addons.clearCache();
});

describe('(1) buildNotice grava o evento no formato da produção', () => {
  it('manda company_id e customer_id da parcela', async () => {
    const visto = mockBanco();
    const client = { query: db.query };
    const r = await collectionNotice.buildNotice(client, {
      companyId: COMPANY, installmentId: 'inst-1', template: 'lembrete', channel: 'whatsapp',
      row: parcela({ company_id: 'company-da-parcela', customer_id: 'cust-77' }),
    });
    expect(r.message).toMatch(/Ana Souza/);
    expect(visto.noticeEventos).toHaveLength(1);
    const p = visto.noticeEventos[0];
    // (installment_id, channel, template, days_relative, message_preview, company_id, customer_id)
    expect(p[0]).toBe('inst-1');
    expect(p[1]).toBe('whatsapp');
    expect(p[2]).toBe('lembrete');
    expect(Number.isInteger(p[3])).toBe(true);
    expect(p[5]).toBe('company-da-parcela');
    expect(p[6]).toBe('cust-77');
  });

  it('template, canal e dias nunca vão nulos', async () => {
    const visto = mockBanco();
    await collectionNotice.buildNotice({ query: db.query }, {
      companyId: COMPANY, installmentId: 'inst-1', template: null, channel: null,
      row: parcela({ due_date: 'data-invalida', company_id: undefined }),
    });
    const p = visto.noticeEventos[0];
    expect(p[1]).toBe('whatsapp');
    expect(p[2]).toBe('atraso_1');
    expect(p[3]).toBe(0);
    expect(p[5]).toBe(COMPANY); // sem company_id na linha, vale a do escopo
    expect(p[6]).toBe('cust-1');
  });
});

describe('(2) recordEvent grava com os dois ids', () => {
  it('runForCompany passa company_id/customer_id da parcela', async () => {
    const visto = mockBanco({ parcelas: [parcela({ customer_id: 'cust-9' })] });
    const r = await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.enqueued).toBe(1);
    expect(visto.eventos).toHaveLength(1);
    const p = visto.eventos[0];
    // (installment_id, template, days_relative, message_preview, company_id, customer_id)
    expect(p[0]).toBe('inst-1');
    expect(p[1]).toBe('parcela_lembrete');
    expect(p[2]).toBe(-3);
    expect(p[4]).toBe(COMPANY);
    expect(p[5]).toBe('cust-9');
  });

  it('template e dias nunca vão nulos', async () => {
    const visto = mockBanco();
    const r = await collectionAuto.recordEvent({
      installmentId: 'inst-1', companyId: COMPANY, customerId: 'cust-1',
      templateName: null, daysRelative: undefined, preview: null,
    });
    expect(r).toEqual({ event: true, stage: true });
    expect(visto.eventos[0][1]).toBe('parcela_lembrete');
    expect(visto.eventos[0][2]).toBe(0);
  });
});

describe('(3)-(4) 23502 no histórico não vira reenvio', () => {
  it('(3) o tick não cai: segue para a próxima parcela, estágio avança, cada uma vai à fila 1 vez', async () => {
    const visto = mockBanco({
      eventoFalha: true,
      parcelas: [parcela({ id: 'inst-1' }), parcela({ id: 'inst-2', phone: '11977776666' })],
    });
    const r = await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.enqueued).toBe(2);
    expect(visto.outboxInserts).toHaveLength(2);
    expect(visto.outboxInserts.map((p) => p[11])).toEqual([
      'cred-inst-1-parcela_lembrete', 'cred-inst-2-parcela_lembrete',
    ]);
    expect(visto.stages).toHaveLength(2);
    // o erro fica no log, com o código
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('evento nao gravado') && c[1].code === '23502')).toBe(true);
  });

  it('(3b) runAll não conta a company como falha', async () => {
    mockBanco({ eventoFalha: true, parcelas: [parcela()] });
    db.query.mockImplementationOnce(() => Promise.resolve({ rows: [{ company_id: COMPANY }] })); // listEnabledCompanies
    const agg = await collectionAuto.runAll(HOJE);
    expect(agg.failed).toBe(0);
    expect(agg.enqueued).toBe(1);
  });

  it('(4) tick seguinte: o dedupeKey da fila barra, nada novo é enfileirado', async () => {
    const visto = mockBanco({ eventoFalha: true, filaDuplicada: true, parcelas: [parcela()] });
    const r = await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.enqueued).toBe(0);
    expect(r.skipped.DUPLICADO).toBe(1);
    expect(visto.eventos).toHaveLength(0);
    expect(visto.stages).toHaveLength(0);
  });
});

describe('(5)-(6) POST /collection/trigger/:iid', () => {
  it('(5) whatsapp_auto com 23502 no histórico → 200 queued', async () => {
    const visto = mockBanco({ eventoFalha: true, parcelas: [parcela({ due_date: '2026-09-11' })] });
    const res = await request(buildCreditApp())
      .post(`/companies/${COMPANY}/credit/collection/trigger/inst-1`)
      .set('Authorization', 'Bearer ' + token)
      .send({ channel: 'whatsapp_auto' });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(visto.eventos).toHaveLength(1);
    expect(visto.eventos[0][4]).toBe(COMPANY);
    expect(visto.eventos[0][5]).toBe('cust-1');
  });

  it('(6) wa.me devolve o texto e grava o evento com os dois ids', async () => {
    const visto = mockBanco({ parcelas: [parcela({ due_date: '2026-09-11' })] });
    const res = await request(buildCreditApp())
      .post(`/companies/${COMPANY}/credit/collection/trigger/inst-1`)
      .set('Authorization', 'Bearer ' + token)
      .send({ template: 'atraso_1' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/Ana Souza/);
    expect(visto.noticeEventos).toHaveLength(1);
    expect(visto.noticeEventos[0][5]).toBe(COMPANY);
    expect(visto.noticeEventos[0][6]).toBe('cust-1');
  });
});

describe('(7) migration 430', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '430_credit_collection_events_alinha.sql'), 'utf8'
  ).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('só adiciona, idempotente', () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    for (const col of ['company_id', 'customer_id', 'sent_at']) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`, 'i'));
    }
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS \w+ ON credit_collection_events \(company_id, sent_at\)/i);
    // NOT NULL só com DEFAULT (nada que exija backfill)
    for (const line of sql.split('\n').filter((l) => /NOT NULL/i.test(l))) {
      expect(line).toMatch(/DEFAULT/i);
    }
  });
});
