// ============================================================
// /admin/clients/:cid/custom-subscription (migration 386)
//
// Staff define, le e remove o valor mensal combinado de uma empresa. Banco de
// mentira (transacao com BEGIN/COMMIT), sem tocar a Asaas: o valor vale no
// proximo checkout. Audita em admin_audit_log (set/clear_custom_subscription).
// ============================================================
'use strict';

jest.mock('../../src/services/asaasClient', () => ({ asaas: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const { asaas } = require('../../src/services/asaasClient');
const router = require('../../src/routes/adminClients360');

const CID = '3a95021d-62e2-417c-8863-b9c4f0a5e155';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
const SECRET = 'aura-test-secret-2026';
const staff = jwt.sign({ id: USER, role: 'admin' }, SECRET);
const cliente = jwt.sign({ id: USER, role: 'client', company: CID }, SECRET);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const api = (metodo, url, token = staff) => request(makeApp())[metodo]('/admin' + url).set('Authorization', 'Bearer ' + token);

const COMBINADO = {
  custom_subscription_value: '211.20', custom_subscription_plan: 'negocio', custom_subscription_cycle: 'annual',
  custom_subscription_note: 'Fechado por telefone', custom_subscription_set_at: '2026-10-14T20:00:00.000Z',
  custom_subscription_set_by: USER,
};

// Cliente de transacao de mentira: registra tudo e responde por SQL.
function arrange({ row = { id: CID, plan: 'negocio', billing_cycle: 'annual', billing_status: 'trial' }, falhaColuna = false } = {}) {
  const log = [];
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ');
      log.push({ sql: s, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
      if (s.includes('FROM companies WHERE id = $1 FOR UPDATE')) {
        if (falhaColuna) { const e = new Error('column does not exist'); e.code = '42703'; throw e; }
        return { rows: row ? [row] : [] };
      }
      if (s.startsWith('UPDATE companies SET custom_subscription_value = $2')) {
        return { rows: [{
          custom_subscription_value: String(params[1]), custom_subscription_plan: params[2],
          custom_subscription_cycle: params[3], custom_subscription_note: params[4],
          custom_subscription_set_at: '2026-10-14T21:00:00.000Z', custom_subscription_set_by: params[5],
        }] };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  db.connect.mockResolvedValue(client);
  return { client, log };
}

const auditoria = (log) => log.find((c) => c.sql.includes('INSERT INTO admin_audit_log'));
const terminou = (log, verbo) => log.some((c) => c.sql.startsWith(verbo));

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  asaas.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('acesso', () => {
  test('sem token 401; cliente comum 403; nada e consultado', async () => {
    for (const metodo of ['get', 'put', 'delete']) {
      expect((await request(makeApp())[metodo](`/admin/clients/${CID}/custom-subscription`)).status).toBe(401);
      expect((await api(metodo, `/clients/${CID}/custom-subscription`, cliente)).status).toBe(403);
    }
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });
});

describe('PUT /admin/clients/:cid/custom-subscription', () => {
  test('grava o valor, audita antes/depois e o motivo; nao toca a Asaas', async () => {
    const { log } = arrange();

    const res = await api('put', `/clients/${CID}/custom-subscription`).send({
      value: 211.2, plan: 'negocio', cycle: 'annual', note: '  2 lojas, fechado por telefone ', reason: 'Combinado com o Luis Henrique',
    });

    expect(res.status).toBe(200);
    expect(res.body.applies).toBe('next_checkout');
    expect(res.body.previous).toBeNull();
    expect(res.body.custom_subscription).toMatchObject({
      value: 211.2, plan: 'negocio', cycle: 'annual', note: '2 lojas, fechado por telefone', set_by: USER,
    });
    expect(res.body.custom_subscription.table_value).toBe(140.83);

    const upd = log.find((c) => c.sql.startsWith('UPDATE companies SET custom_subscription_value = $2'));
    expect(upd.params).toEqual([CID, 211.2, 'negocio', 'annual', '2 lojas, fechado por telefone', USER]);

    const aud = auditoria(log);
    expect(aud.sql).toContain("'set_custom_subscription'");
    expect(aud.params[0]).toBe(USER);
    expect(aud.params[1]).toBe(CID);
    expect(aud.params[3]).toBe('Combinado com o Luis Henrique');
    const payload = JSON.parse(aud.params[2]);
    expect(payload.before).toBeNull();
    expect(payload.after).toMatchObject({ value: 211.2, plan: 'negocio', cycle: 'annual' });

    expect(terminou(log, 'COMMIT')).toBe(true);
    expect(asaas).not.toHaveBeenCalled();
  });

  test('substituir um valor ja gravado guarda o anterior no audit e na resposta', async () => {
    const { log } = arrange({ row: { id: CID, plan: 'negocio', billing_cycle: 'annual', billing_status: 'active', ...COMBINADO } });

    const res = await api('put', `/clients/${CID}/custom-subscription`).send({ value: '199,90', plan: 'negocio', cycle: 'annual' });

    expect(res.status).toBe(200);
    expect(res.body.previous).toMatchObject({ value: 211.2, plan: 'negocio', note: 'Fechado por telefone' });
    expect(res.body.custom_subscription.value).toBe(199.9);
    expect(JSON.parse(auditoria(log).params[2]).before.value).toBe(211.2);
    expect(auditoria(log).params[3]).toBeNull(); // sem motivo informado
  });

  test.each([
    ['sem valor', { plan: 'negocio', cycle: 'annual' }],
    ['valor zero', { value: 0, plan: 'negocio', cycle: 'annual' }],
    ['valor negativo', { value: -10, plan: 'negocio', cycle: 'annual' }],
    ['valor texto', { value: 'abc', plan: 'negocio', cycle: 'annual' }],
    ['abaixo do minimo do provedor', { value: 4.99, plan: 'negocio', cycle: 'annual' }],
    ['acima do limite', { value: 100000.01, plan: 'negocio', cycle: 'annual' }],
    ['plano invalido', { value: 211.2, plan: 'ouro', cycle: 'annual' }],
    ['plano dojo (fora do varejo)', { value: 211.2, plan: 'dojo', cycle: 'annual' }],
    ['ciclo invalido', { value: 211.2, plan: 'negocio', cycle: 'weekly' }],
    ['sem ciclo', { value: 211.2, plan: 'negocio' }],
    ['nota que nao e texto', { value: 211.2, plan: 'negocio', cycle: 'annual', note: 5 }],
    ['nota enorme', { value: 211.2, plan: 'negocio', cycle: 'annual', note: 'x'.repeat(1001) }],
  ])('400: %s', async (_nome, body) => {
    arrange();
    const res = await api('put', `/clients/${CID}/custom-subscription`).send(body);
    expect(res.status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('o minimo exato (R$ 5,00) e aceito', async () => {
    arrange();
    const res = await api('put', `/clients/${CID}/custom-subscription`).send({ value: 5, plan: 'essencial', cycle: 'monthly' });
    expect(res.status).toBe(200);
  });

  test('empresa inexistente: 404 e a transacao e desfeita; id que nao e uuid: 404 sem abrir transacao', async () => {
    const { log } = arrange({ row: null });
    const res = await api('put', `/clients/${CID}/custom-subscription`).send({ value: 211.2, plan: 'negocio', cycle: 'annual' });
    expect(res.status).toBe(404);
    expect(terminou(log, 'ROLLBACK')).toBe(true);
    expect(terminou(log, 'COMMIT')).toBe(false);

    db.connect.mockClear();
    const res2 = await api('put', '/clients/nao-e-uuid/custom-subscription').send({ value: 211.2, plan: 'negocio', cycle: 'annual' });
    expect(res2.status).toBe(404);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('migration 386 pendente (42703): 503 com mensagem clara e nada gravado', async () => {
    const { log } = arrange({ falhaColuna: true });
    const res = await api('put', `/clients/${CID}/custom-subscription`).send({ value: 211.2, plan: 'negocio', cycle: 'annual' });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('386');
    expect(terminou(log, 'ROLLBACK')).toBe(true);
    expect(terminou(log, 'COMMIT')).toBe(false);
  });

  test('falha ao auditar desfaz a gravacao (transacao) e libera a conexao', async () => {
    const { client, log } = arrange();
    const base = client.query.getMockImplementation();
    client.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes('INSERT INTO admin_audit_log')) throw new Error('audit fora');
      return base(sql, params);
    });

    const res = await api('put', `/clients/${CID}/custom-subscription`).send({ value: 211.2, plan: 'negocio', cycle: 'annual' });

    expect(res.status).toBe(500);
    expect(terminou(log, 'ROLLBACK')).toBe(true);
    expect(terminou(log, 'COMMIT')).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });
});

describe('DELETE /admin/clients/:cid/custom-subscription', () => {
  test('remove, audita o que tinha e responde changed:true', async () => {
    const { log } = arrange({ row: { id: CID, plan: 'negocio', billing_cycle: 'annual', ...COMBINADO } });

    const res = await api('delete', `/clients/${CID}/custom-subscription`).send({ reason: 'Voltou para a tabela' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ custom_subscription: null, changed: true, previous: { value: 211.2, plan: 'negocio' } });
    const upd = log.find((c) => c.sql.includes('custom_subscription_value = NULL'));
    expect(upd.params).toEqual([CID]);
    const aud = auditoria(log);
    expect(aud.sql).toContain("'clear_custom_subscription'");
    expect(aud.params[3]).toBe('Voltou para a tabela');
    expect(JSON.parse(aud.params[2])).toMatchObject({ before: { value: 211.2 }, after: null });
    expect(terminou(log, 'COMMIT')).toBe(true);
  });

  test('sem valor combinado: idempotente, changed:false e nada auditado', async () => {
    const { log } = arrange();

    const res = await api('delete', `/clients/${CID}/custom-subscription`).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ custom_subscription: null, previous: null, changed: false });
    expect(auditoria(log)).toBeUndefined();
  });

  test('empresa inexistente: 404', async () => {
    arrange({ row: null });
    expect((await api('delete', `/clients/${CID}/custom-subscription`).send({})).status).toBe(404);
  });
});

describe('GET /admin/clients/:cid/custom-subscription', () => {
  test('devolve o bloco com a nota (e staff), quem definiu, valor de tabela e o contexto da empresa', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (s.includes('FROM companies c LEFT JOIN users u')) {
        return { rows: [{
          id: CID, plan: 'negocio', billing_cycle: 'annual', billing_status: 'active', has_subscription: true,
          ...COMBINADO, set_by_name: 'Caio',
        }] };
      }
      if (s.includes('extra_seats_granted')) return { rows: [{ id: CID, extra_seats_granted: 1 }] };
      return { rows: [] };
    });

    const res = await api('get', `/clients/${CID}/custom-subscription`);

    expect(res.status).toBe(200);
    expect(res.body.custom_subscription).toMatchObject({
      value: 211.2, plan: 'negocio', cycle: 'annual', note: 'Fechado por telefone', set_by_name: 'Caio',
    });
    expect(res.body.custom_subscription.table_value).toBe(159.83); // 140,83 + 1 acesso
    expect(res.body.company).toMatchObject({ plan: 'negocio', billing_cycle: 'annual', has_subscription: true });
    expect(res.body.min_value).toBe(5);
  });

  test('sem valor combinado: custom_subscription null', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (s.includes('FROM companies c LEFT JOIN users u')) {
        return { rows: [{ id: CID, plan: 'essencial', billing_cycle: null, billing_status: 'trial', has_subscription: false, custom_subscription_value: null }] };
      }
      return { rows: [] };
    });

    const res = await api('get', `/clients/${CID}/custom-subscription`);

    expect(res.status).toBe(200);
    expect(res.body.custom_subscription).toBeNull();
    expect(res.body.company.billing_cycle).toBe('monthly');
  });

  test('empresa inexistente 404; coluna ausente 503', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect((await api('get', `/clients/${CID}/custom-subscription`)).status).toBe(404);

    const e = new Error('x'); e.code = '42703';
    db.query.mockRejectedValueOnce(e);
    expect((await api('get', `/clients/${CID}/custom-subscription`)).status).toBe(503);
  });
});

describe('PATCH /extra-seats e /resync-subscription nao reajustam a assinatura com valor combinado', () => {
  test('resync: billing_sync.skipped = valor_customizado, audit registra e nenhum PUT na Asaas', async () => {
    const audit = [];
    db.query.mockImplementation(async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (s.startsWith('SELECT id, plan, billing_cycle, billing_status, asaas_subscription_id FROM companies')) {
        return { rows: [{ id: CID, plan: 'negocio', billing_cycle: 'annual', billing_status: 'active', asaas_subscription_id: 'sub_1' }] };
      }
      if (s.includes('custom_subscription_value') && s.includes('FROM companies')) {
        return { rows: [{ custom_subscription_value: '211.20', custom_subscription_plan: 'negocio', custom_subscription_cycle: 'annual' }] };
      }
      if (s.includes('INSERT INTO admin_audit_log')) { audit.push(params); return { rows: [] }; }
      return { rows: [] };
    });

    const res = await api('post', `/clients/${CID}/resync-subscription`).send({ reason: 'conferir' });

    expect(res.status).toBe(200);
    expect(res.body.billing_sync).toMatchObject({ updated: false, skipped: 'valor_customizado', value: 211.2 });
    expect(asaas).not.toHaveBeenCalled();
    expect(JSON.parse(audit[0][2]).billing_sync.skipped).toBe('valor_customizado');
  });
});
