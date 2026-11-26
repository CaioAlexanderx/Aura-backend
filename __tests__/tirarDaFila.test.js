// ============================================================
// AURA. — Tirar da Fila de producao (C1 do QA de 26/11/2026), sem banco.
// Contrato: services/tirarDaFila.js + rotas em studioKdsApproval.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const svc = require('../src/services/tirarDaFila');
const router = require('../src/routes/studioKdsApproval');

let db;
beforeAll(() => { db = require('../src/config/database'); });
beforeEach(() => { jest.resetAllMocks(); svc._zerarCache(); });

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 'u1' }; next(); });
app.use('/companies/:id/studio', router);

const CID = 'c1';
const OID = 'o1';

/** Banco de mentira: view studio_orders, digital_orders/studio_payments, studio_fila_tirados. */
function banco({ tabela = true, head, digital, tirados = new Set() }) {
  const calls = [];
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    calls.push([s, params]);
    if (/to_regclass\('public.studio_fila_tirados'\)/.test(s)) return { rows: [{ t: tabela ? 'studio_fila_tirados' : null }] };
    if (/FROM studio_orders WHERE id = \$1 AND company_id = \$2/.test(s)) {
      return { rows: head && params[1] === CID ? [head] : [] };
    }
    if (/FROM digital_orders o WHERE o.id = \$1 AND o.company_id = \$2/.test(s)) {
      return { rows: digital && params[1] === CID ? [digital] : [] };
    }
    if (/^INSERT INTO studio_fila_tirados/.test(s)) {
      if (tirados.has(params[0])) return { rows: [] };
      tirados.add(params[0]);
      return { rows: [{ tirado_em: '2026-11-26T12:00:00Z' }] };
    }
    if (/^SELECT tirado_em FROM studio_fila_tirados/.test(s)) return { rows: [{ tirado_em: '2026-11-26T11:00:00Z' }] };
    if (/^DELETE FROM studio_fila_tirados/.test(s)) {
      const tinha = tirados.delete(params[0]);
      return { rows: tinha ? [{ order_id: params[0] }] : [] };
    }
    return { rows: [] };
  });
  return { calls, tirados };
}

const ORC_SEM_PAGAMENTO = { total: '100', payment_status: 'pending', marcos_pagos: '0' };
const DIGITAL = { id: OID, source: 'digital', digital_order_id: OID };

describe('POST /orders/:oid/tirar-da-fila', () => {
  test('pedido sem recebimento: 200, grava a marca com empresa e usuario', async () => {
    const { calls, tirados } = banco({ head: DIGITAL, digital: ORC_SEM_PAGAMENTO });
    const r = await request(app).post(`/companies/${CID}/studio/orders/${OID}/tirar-da-fila`).send({ motivo: '  pedido de teste ' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, order_id: OID, tirado_em: '2026-11-26T12:00:00Z', ja_estava: false });
    expect(tirados.has(OID)).toBe(true);
    const ins = calls.find(([s]) => /^INSERT INTO studio_fila_tirados/.test(s));
    expect(ins[1]).toEqual([OID, CID, 'u1', 'pedido de teste']);
    // nada de venda/dinheiro: so a marca
    expect(calls.some(([s]) => /^(UPDATE|DELETE FROM) (digital_orders|sales|transactions|studio_payments)/.test(s))).toBe(false);
  });

  test('tirar de novo e idempotente (ja_estava true)', async () => {
    banco({ head: DIGITAL, digital: ORC_SEM_PAGAMENTO, tirados: new Set([OID]) });
    const r = await request(app).post(`/companies/${CID}/studio/orders/${OID}/tirar-da-fila`).send({});
    expect(r.status).toBe(200);
    expect(r.body.ja_estava).toBe(true);
  });

  test('sinal recebido (marcos pagos): 409 TEM_RECEBIMENTO com o valor, nada gravado', async () => {
    const { calls } = banco({ head: DIGITAL, digital: { total: '100', payment_status: 'pending', marcos_pagos: '30' } });
    const r = await request(app).post(`/companies/${CID}/studio/orders/${OID}/tirar-da-fila`).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TEM_RECEBIMENTO');
    expect(r.body.recebido).toBe(30);
    expect(calls.some(([s]) => /^INSERT INTO studio_fila_tirados/.test(s))).toBe(false);
  });

  test('pedido da loja online com Pix confirmado: TEM_RECEBIMENTO pelo total', async () => {
    banco({ head: DIGITAL, digital: { total: '49.90', payment_status: 'confirmed', marcos_pagos: '0' } });
    const r = await request(app).post(`/companies/${CID}/studio/orders/${OID}/tirar-da-fila`).send({});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'TEM_RECEBIMENTO', recebido: 49.9 });
  });

  test('venda do Caixa (pdv): sai da Fila sem a regra do recebimento', async () => {
    const { tirados } = banco({ head: { id: OID, source: 'pdv', digital_order_id: null } });
    const r = await request(app).post(`/companies/${CID}/studio/orders/${OID}/tirar-da-fila`).send({});
    expect(r.status).toBe(200);
    expect(tirados.has(OID)).toBe(true);
  });

  test('pedido de outra empresa ou inexistente: 404 PEDIDO_NAO_ENCONTRADO', async () => {
    banco({ head: DIGITAL, digital: ORC_SEM_PAGAMENTO });
    const r = await request(app).post(`/companies/outra/studio/orders/${OID}/tirar-da-fila`).send({});
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('PEDIDO_NAO_ENCONTRADO');
  });

  test('sem a migration 471: 409 FILA_INDISPONIVEL (a Fila segue como antes)', async () => {
    banco({ tabela: false, head: DIGITAL, digital: ORC_SEM_PAGAMENTO });
    const r = await request(app).post(`/companies/${CID}/studio/orders/${OID}/tirar-da-fila`).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('FILA_INDISPONIVEL');
  });
});

describe('POST /orders/:oid/devolver-a-fila', () => {
  test('devolve: apaga so a marca; devolver de novo e idempotente', async () => {
    const { tirados } = banco({ head: DIGITAL, digital: ORC_SEM_PAGAMENTO, tirados: new Set([OID]) });
    const r = await request(app).post(`/companies/${CID}/studio/orders/${OID}/devolver-a-fila`).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, order_id: OID, na_fila: true, ja_estava: false });
    expect(tirados.has(OID)).toBe(false);
    const r2 = await request(app).post(`/companies/${CID}/studio/orders/${OID}/devolver-a-fila`).send({});
    expect(r2.body.ja_estava).toBe(true);
  });

  test('outra empresa: 404', async () => {
    banco({ head: DIGITAL, digital: ORC_SEM_PAGAMENTO, tirados: new Set([OID]) });
    const r = await request(app).post(`/companies/outra/studio/orders/${OID}/devolver-a-fila`).send({});
    expect(r.status).toBe(404);
  });
});

describe('filtros da listagem', () => {
  test('semOsTirados / soOsTirados: confere a empresa e o id da view', () => {
    expect(svc.semOsTirados('o')).toMatch(/NOT EXISTS \(SELECT 1 FROM studio_fila_tirados ft WHERE ft\.company_id = o\.company_id AND ft\.order_id = o\.id\)/);
    expect(svc.soOsTirados('')).toMatch(/ AND EXISTS \(SELECT 1 FROM studio_fila_tirados ft WHERE ft\.company_id = company_id AND ft\.order_id = id\)/);
  });

  test('GET /orders: sem ?tirados a consulta exclui os tirados; ?tirados=true so os tirados; A receber nao filtra', async () => {
    const sqls = [];
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/to_regclass\('public.studio_fila_tirados'\)/.test(s)) return { rows: [{ t: 'x' }] };
      if (/to_regclass\('public.credit_installments'\)/.test(s)) return { rows: [{ t: null }] };
      if (/information_schema.columns/.test(s)) return { rows: [] };
      if (/FROM studio_orders o/.test(s)) sqls.push(s);
      return { rows: [] };
    });
    await request(app).get(`/companies/${CID}/studio/orders`);
    await request(app).get(`/companies/${CID}/studio/orders?tirados=true`);
    await request(app).get(`/companies/${CID}/studio/orders?with_balance=true`);
    const rica = (n) => sqls[n];
    expect(rica(0)).toMatch(/AND NOT EXISTS \(SELECT 1 FROM studio_fila_tirados/);
    expect(rica(1)).toMatch(/AND EXISTS \(SELECT 1 FROM studio_fila_tirados/);
    expect(rica(1)).not.toMatch(/NOT EXISTS \(SELECT 1 FROM studio_fila_tirados/);
    expect(rica(2)).not.toMatch(/studio_fila_tirados/);
  });
});

describe('comRecebimento (campos da listagem)', () => {
  test('digital com sinal pago: fila_tem_recebimento true e valor; pdv e sem pagamento: false', async () => {
    db.query.mockResolvedValue({ rows: [
      { id: 'd1', total: '100', payment_status: 'pending', marcos_pagos: '30' },
      { id: 'd2', total: '80', payment_status: 'pending', marcos_pagos: '0' },
      { id: 'd3', total: '49.9', payment_status: 'confirmed', marcos_pagos: '0' },
    ] });
    const out = await svc.comRecebimento(db, CID, [
      { id: 'd1', source: 'digital', digital_order_id: 'd1' },
      { id: 'd2', source: 'digital', digital_order_id: 'd2' },
      { id: 'd3', source: 'digital', digital_order_id: 'd3' },
      { id: 'p1', source: 'pdv', digital_order_id: null },
    ]);
    expect(out.map((o) => [o.fila_tem_recebimento, o.fila_recebido])).toEqual([[true, 30], [false, 0], [true, 49.9], [false, 0]]);
    expect(db.query.mock.calls[0][1]).toEqual([CID, ['d1', 'd2', 'd3']]);
  });

  test('falha do banco nao derruba a lista', async () => {
    db.query.mockRejectedValue(new Error('boom'));
    const out = await svc.comRecebimento(db, CID, [{ id: 'd1', source: 'digital', digital_order_id: 'd1' }]);
    expect(out).toEqual([{ id: 'd1', source: 'digital', digital_order_id: 'd1', fila_recebido: 0, fila_tem_recebimento: false }]);
  });
});
