// ============================================================
// AURA. — Orcamento vencido (B1c do QA de 26/11/2026)
//   - a cliente nao aprova nem recusa pelo link: 409 ORCAMENTO_VENCIDO
//   - a loja nao aprova vencido sem renovar (409 ORCAMENTO_VENCIDO)
//   - a loja renova a validade: PATCH /studio/quotes/:qid/validade
// Regra do dia em Sao Paulo: "valido ate 25/11" vale ate o fim do dia 25/11.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const V = require('../src/utils/validadeDoOrcamento');
const quotePublic = require('../src/routes/studioQuotePublic');
const quotesRouter = require('../src/routes/studioQuotes');
const lojaEvents = require('../src/services/lojaEvents');

let db;
beforeAll(() => { db = require('../src/config/database'); });
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(lojaEvents, 'emit').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const iso = (dia, hora = '12:00:00') => `${dia}T${hora}-03:00`;
const hoje = V.diaEmSP(new Date());
const ontem = V.somarDias(hoje, -1);
const amanha = V.somarDias(hoje, 1);

describe('vencido (dia em Sao Paulo)', () => {
  const agora = new Date('2026-11-26T15:00:00Z'); // 12:00 em SP, 26/11
  test('validade ontem: vencido; hoje (mesmo ja tendo passado a hora): vale; amanha: vale', () => {
    expect(V.vencido(iso('2026-11-25', '23:59:59'), agora)).toBe(true);
    expect(V.vencido(iso('2026-11-26', '08:00:00'), agora)).toBe(false);
    expect(V.vencido(iso('2026-11-26', '23:59:59'), agora)).toBe(false);
    expect(V.vencido(iso('2026-11-27'), agora)).toBe(false);
  });
  test('fuso: 02:00 UTC de 27/11 ainda e 26/11 em SP', () => {
    expect(V.vencido(new Date('2026-11-27T02:00:00Z'), new Date('2026-11-27T02:30:00Z'))).toBe(false);
    // virou o dia em SP: 03:00 UTC de 27/11
    expect(V.vencido(new Date('2026-11-26T20:00:00Z'), new Date('2026-11-27T03:00:00Z'))).toBe(true);
  });
  test('sem validade nunca vence', () => {
    expect(V.vencido(null)).toBe(false);
    expect(V.vencido(undefined)).toBe(false);
  });
  test('auxiliares de data', () => {
    expect(V.somarDias('2026-11-30', 1)).toBe('2026-12-01');
    expect(V.diasEntre('2026-11-26', '2026-12-03')).toBe(7);
    expect(V.diaExiste('2026-02-30')).toBe(false);
    expect(V.diaExiste('2026-02-28')).toBe(true);
    expect(V.diaExiste('26/11/2026')).toBe(false);
    expect(V.fimDoDiaSP('2026-11-26')).toBe('2026-11-26T23:59:59-03:00');
  });
});

describe('POST /orcamento/:token/respond', () => {
  const app = express();
  app.use(express.json());
  app.use('/orcamento', quotePublic);

  function mockClient(quote) {
    const query = jest.fn().mockImplementation((sql) => {
      if (/FROM studio_quotes WHERE token/i.test(String(sql))) return Promise.resolve({ rows: quote ? [quote] : [] });
      return Promise.resolve({ rows: [] });
    });
    const client = { query, release: jest.fn() };
    db.connect.mockResolvedValue(client);
    return client;
  }
  const base = { id: 'q1', company_id: 'c1', status: 'sent', customer_name: 'Ana', total: '100', created_by: 'u' };

  test('vencido ontem: 409 ORCAMENTO_VENCIDO com a frase, nada e aceito, e o status vira expired', async () => {
    const client = mockClient({ ...base, expires_at: iso(ontem, '23:59:59') });
    const r = await request(app).post('/orcamento/tok/respond').send({ action: 'accept' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Este orçamento venceu. Fale com a loja para renovar.', code: 'ORCAMENTO_VENCIDO' });
    const sqls = client.query.mock.calls.map(([s]) => String(s));
    expect(sqls.some((s) => /SET status\s+= \$1/.test(s))).toBe(false); // nao gravou accepted
    expect(sqls.some((s) => /SET status = 'expired'/.test(s))).toBe(true);
    expect(lojaEvents.emit).not.toHaveBeenCalled();
  });

  test('recusar tambem e barrado; ja marcado expired responde igual', async () => {
    mockClient({ ...base, status: 'expired', expires_at: iso(ontem) });
    const r = await request(app).post('/orcamento/tok/respond').send({ action: 'reject' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ORCAMENTO_VENCIDO');
  });

  test('valido ate hoje: aceita normalmente', async () => {
    mockClient({ ...base, expires_at: iso(hoje, '23:59:59') });
    const r = await request(app).post('/orcamento/tok/respond').send({ action: 'accept' });
    expect(r.status).toBe(200);
    expect(r.body.new_status).toBe('accepted');
  });

  test('ja respondido segue 409 sem o codigo de vencido', async () => {
    mockClient({ ...base, status: 'accepted', expires_at: iso(ontem) });
    const r = await request(app).post('/orcamento/tok/respond').send({ action: 'accept' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBeUndefined();
  });
});

describe('loja: /aprovar e /validade', () => {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/studio', quotesRouter);

  function mockClient(rows) {
    const calls = [];
    const query = jest.fn().mockImplementation((sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push([s, params]);
      if (/FROM studio_quotes WHERE id = \$1 AND company_id = \$2 LIMIT 1 FOR UPDATE/.test(s)) {
        return Promise.resolve({ rows: rows.quote ? [rows.quote] : [] });
      }
      if (/^UPDATE studio_quotes SET expires_at/.test(s)) {
        return Promise.resolve({ rows: [{ id: 'q1', status: 'sent', expires_at: params[0] }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const client = { query, release: jest.fn() };
    db.connect.mockResolvedValue(client);
    return { client, calls };
  }

  test('aprovar orcamento enviado e vencido: 409 ORCAMENTO_VENCIDO, nada criado', async () => {
    const { calls } = mockClient({ quote: { id: 'q1', status: 'sent', expires_at: iso(ontem), order_id: null } });
    const r = await request(app).post('/companies/c1/studio/quotes/q1/aprovar');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Este orçamento venceu. Renove a validade antes de aprovar.', code: 'ORCAMENTO_VENCIDO' });
    expect(calls.some(([s]) => /INSERT INTO digital_orders/.test(s))).toBe(false);
    expect(calls.map(([s]) => s)).toContain('ROLLBACK');
  });

  test('aprovar orcamento ja marcado expired: tambem ORCAMENTO_VENCIDO', async () => {
    mockClient({ quote: { id: 'q1', status: 'expired', expires_at: iso(ontem), order_id: null } });
    const r = await request(app).post('/companies/c1/studio/quotes/q1/aprovar');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ORCAMENTO_VENCIDO');
  });

  test('renovar com valid_until: grava o fim desse dia, volta a sent, escopo da empresa', async () => {
    const { calls } = mockClient({ quote: { id: 'q1', status: 'expired' } });
    const r = await request(app).patch('/companies/c1/studio/quotes/q1/validade').send({ valid_until: amanha });
    expect(r.status).toBe(200);
    const upd = calls.find(([s]) => /^UPDATE studio_quotes SET expires_at/.test(s));
    expect(upd[1]).toEqual([V.fimDoDiaSP(amanha), 1, 'q1', 'c1']);
    expect(upd[0]).toMatch(/status\s+= 'sent'/);
    expect(upd[0]).toMatch(/WHERE id = \$3 AND company_id = \$4/);
    // o lock tambem e por empresa
    const sel = calls.find(([s]) => /FOR UPDATE/.test(s));
    expect(sel[1]).toEqual(['q1', 'c1']);
  });

  test('renovar com validity_days: n dias a partir de hoje', async () => {
    const { calls } = mockClient({ quote: { id: 'q1', status: 'sent' } });
    const r = await request(app).patch('/companies/c1/studio/quotes/q1/validade').send({ validity_days: 7 });
    expect(r.status).toBe(200);
    const upd = calls.find(([s]) => /^UPDATE studio_quotes SET expires_at/.test(s));
    expect(upd[1]).toEqual([V.fimDoDiaSP(V.somarDias(hoje, 7)), 7, 'q1', 'c1']);
  });

  test('renovar: data no passado, invalida, sem corpo, alem de 1 ano = 400, sem tocar no banco', async () => {
    mockClient({ quote: { id: 'q1', status: 'sent' } });
    const patch = (b) => request(app).patch('/companies/c1/studio/quotes/q1/validade').send(b);
    expect((await patch({ valid_until: ontem })).body.code).toBe('VALIDADE_NO_PASSADO');
    expect((await patch({ valid_until: '2026-02-30' })).body.code).toBe('VALIDADE_INVALIDA');
    expect((await patch({})).status).toBe(400);
    expect((await patch({ valid_until: V.somarDias(hoje, 400) })).status).toBe(400);
    expect((await patch({ validity_days: 999 })).status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('renovar: orcamento de outra empresa (nao achado) = 404; aceito/convertido = 409', async () => {
    mockClient({ quote: null });
    expect((await request(app).patch('/companies/c1/studio/quotes/q1/validade').send({ validity_days: 3 })).status).toBe(404);
    mockClient({ quote: { id: 'q1', status: 'converted' } });
    const r = await request(app).patch('/companies/c1/studio/quotes/q1/validade').send({ validity_days: 3 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STATUS_NAO_RENOVAVEL');
  });
});
