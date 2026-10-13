// ============================================================
// Assento de temporada (migration 374) — contra o Postgres REAL.
//
// Cobre o que um mock de db.query nao enxerga: os dois CTEs que mudam o
// passe E o total de acessos extras na MESMA instrucao (aplicar / encerrar),
// os tipos dos parametros e o efeito em companies.extra_seats_granted.
//
// Bypassa o mock global de src/config/database (mesmo padrao dos testes
// karate.*): o servico recebe o client por `deps.db`. Tudo roda numa
// transacao que e' revertida no fim.
//
// companies.extra_seats_granted / billing_cycle nascem em src/migrations/
// (legado), que o CI nao aplica — o teste cria as colunas DENTRO da
// transacao (ALTER TABLE e' transacional no Postgres) e reverte.
//
// No CI o job sobe postgres:16 com migrations/*.sql, incluindo a 374.
// ============================================================
'use strict';

jest.mock('../../src/services/asaasClient', () => ({
  ...jest.requireActual('../../src/services/asaasClient'),
  asaas: jest.fn(),
}));

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const seatPass = require('../../src/services/seatPass');
const { asaas } = require('../../src/services/asaasClient');
const { syncSubscriptionSeatValue } = require('../../src/services/seatSubscription');
const { summarizeSeats } = require('../../src/services/memberSeats');
const globalDb = require('../../src/config/database');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let userId;

const okSync = (value = 188) => jest.fn(async () => ({ updated: true, value, previousValue: 169, subscriptionId: 'sub_x' }));

async function novaEmpresa({ assinatura = 'sub_x', extras = 1, status = 'active', plano = 'negocio' } = {}) {
  const id = uuid();
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, plan, billing_status, asaas_subscription_id, extra_seats_granted, billing_cycle)
     VALUES ($1, $2, 'Loja Temporada', $3, $4, $5, $6, 'monthly')`,
    [id, userId, plano, status, assinatura, extras]
  );
  return id;
}

const extras = async (companyId) =>
  (await client.query('SELECT extra_seats_granted AS n FROM companies WHERE id = $1', [companyId])).rows[0].n;

const passe = async (id) =>
  (await client.query(
    `SELECT status, applied_at, ended_reason, asaas_ref, sync_pendente, cortesia,
            to_char(starts_at, 'YYYY-MM-DD') AS starts_at, to_char(ends_at, 'YYYY-MM-DD') AS ends_at
       FROM seat_passes WHERE id = $1`, [id])).rows[0];

const acoesAudit = async (companyId) =>
  (await client.query('SELECT action FROM audit_log WHERE company_id = $1 ORDER BY created_at, action', [companyId]))
    .rows.map((r) => r.action);

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS extra_seats_granted INTEGER NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(20) DEFAULT 'monthly'`);
  userId = uuid();
  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Dona da Loja')`,
    [userId, `temporada-${userId}@example.com`]
  );
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('contratar durante a temporada', () => {
  test('soma os assentos, cobra pela Asaas e registra a validade fixa', async () => {
    const cid = await novaEmpresa({ extras: 1 });
    const sync = okSync();

    const r = await seatPass.contratar(
      { companyId: cid, qty: 2, source: 'loja', userId },
      { db: client, sync, hoje: '2026-11-10' }
    );

    expect(await extras(cid)).toBe(3);
    // o sync recebe a empresa JA com o novo total (1 permanente + 2 do passe)
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0]).toMatchObject({ id: cid, plan: 'negocio', asaas_subscription_id: 'sub_x', extra_seats_granted: 3 });

    const p = await passe(r.passe.id);
    expect(p).toMatchObject({ status: 'ativo', cortesia: false, asaas_ref: 'sub_x', starts_at: '2026-11-10', ends_at: '2027-01-31' });
    expect(p.applied_at).not.toBeNull();

    expect(r.aplicado_agora).toBe(true);
    expect(r.cobranca).toMatchObject({ forma: 'assinatura_asaas', valor_mensal: 38, ate: '2027-01-31' });
    expect(await acoesAudit(cid)).toEqual(['seat_pass.applied', 'seat_pass.created']);
  });

  test('contratou antes de 01/11: fica agendado, nada muda hoje e o job aplica na data', async () => {
    const cid = await novaEmpresa({ extras: 0 });
    const sync = okSync(207);

    const r = await seatPass.contratar({ companyId: cid, qty: 1, source: 'loja', userId }, { db: client, sync, hoje: '2026-10-13' });
    expect(r.aplicado_agora).toBe(false);
    expect(r.comeca_em).toBe('2026-11-01');
    expect(await extras(cid)).toBe(0);
    expect(sync).not.toHaveBeenCalled();

    // 31/10: ainda nao
    let d = await seatPass.rodarDiario({ db: client, sync, hoje: '2026-10-31' });
    expect(d.aplicados).toBe(0);
    expect(await extras(cid)).toBe(0);

    // 01/11: entra
    d = await seatPass.rodarDiario({ db: client, sync, hoje: '2026-11-01' });
    expect(d.aplicados).toBe(1);
    expect(await extras(cid)).toBe(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect((await passe(r.passe.id)).applied_at).not.toBeNull();

    // rodar de novo no mesmo dia nao soma outra vez
    d = await seatPass.rodarDiario({ db: client, sync, hoje: '2026-11-01' });
    expect(d.aplicados).toBe(0);
    expect(await extras(cid)).toBe(1);
  });

  test('sem assinatura a loja nao compra (409) e nada e gravado', async () => {
    const cid = await novaEmpresa({ assinatura: null, status: 'trial', extras: 0 });
    await expect(
      seatPass.contratar({ companyId: cid, qty: 1, source: 'loja', userId }, { db: client, sync: okSync(), hoje: '2026-11-10' })
    ).rejects.toMatchObject({ status: 409, code: 'SEM_ASSINATURA' });
    const { rows } = await client.query('SELECT 1 FROM seat_passes WHERE company_id = $1', [cid]);
    expect(rows).toHaveLength(0);
  });

  test('passou de 31/01/2027: temporada encerrada', async () => {
    const cid = await novaEmpresa();
    await expect(
      seatPass.contratar({ companyId: cid, qty: 1, source: 'loja', userId }, { db: client, sync: okSync(), hoje: '2027-02-01' })
    ).rejects.toMatchObject({ status: 409, code: 'TEMPORADA_ENCERRADA' });
  });

  test('qty fora de 1..10 e limite acumulado', async () => {
    const cid = await novaEmpresa({ extras: 0 });
    const deps = { db: client, sync: okSync(), hoje: '2026-11-10' };
    await expect(seatPass.contratar({ companyId: cid, qty: 0, source: 'loja', userId }, deps)).rejects.toMatchObject({ code: 'QTY_INVALIDA' });
    await expect(seatPass.contratar({ companyId: cid, qty: 11, source: 'loja', userId }, deps)).rejects.toMatchObject({ code: 'QTY_INVALIDA' });
    await seatPass.contratar({ companyId: cid, qty: 8, source: 'loja', userId }, deps);
    await expect(seatPass.contratar({ companyId: cid, qty: 3, source: 'loja', userId }, deps))
      .rejects.toMatchObject({ status: 409, code: 'LIMITE_DE_ASSENTOS' });
    expect(await extras(cid)).toBe(8);
  });
});

describe('falha na Asaas ao contratar', () => {
  test('nada fica concedido: assentos devolvidos, passe cancelado, 502', async () => {
    const cid = await novaEmpresa({ extras: 1 });
    const sync = jest.fn(async () => ({ updated: false, skipped: 'error', error: 'timeout' }));

    await expect(
      seatPass.contratar({ companyId: cid, qty: 2, source: 'loja', userId }, { db: client, sync, hoje: '2026-11-10' })
    ).rejects.toMatchObject({ status: 502, code: 'FALHA_ASAAS' });

    expect(await extras(cid)).toBe(1);
    const { rows } = await client.query(
      `SELECT status, applied_at, ended_reason, sync_pendente FROM seat_passes WHERE company_id = $1`, [cid]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'cancelado', applied_at: null, ended_reason: 'falha_asaas' });
    // 2a chamada (devolver o valor) tambem falhou → o job refaz
    expect(rows[0].sync_pendente).toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);

    // o job refaz o valor quando a Asaas volta
    const sync2 = okSync(169 + 19);
    const d = await seatPass.rodarDiario({ db: client, sync: sync2, hoje: '2026-11-11' });
    expect(d.ressincronizados).toBeGreaterThanOrEqual(1);
    expect(sync2.mock.calls.some((c) => c[0].id === cid && c[0].extra_seats_granted === 1)).toBe(true);
    const { rows: depois } = await client.query('SELECT sync_pendente FROM seat_passes WHERE company_id = $1', [cid]);
    expect(depois[0].sync_pendente).toBe(false);
  });
});

describe('expiracao pelo job diario', () => {
  test('31/01 ainda vale; 01/02 expira, tira os assentos e refaz o valor — uma unica vez', async () => {
    const cid = await novaEmpresa({ extras: 1 });
    const r = await seatPass.contratar({ companyId: cid, qty: 2, source: 'loja', userId }, { db: client, sync: okSync(), hoje: '2026-11-10' });
    expect(await extras(cid)).toBe(3);

    const sync = okSync(188);

    let d = await seatPass.rodarDiario({ db: client, sync, hoje: '2027-01-31' });
    expect(d.expirados).toBe(0);
    expect(await extras(cid)).toBe(3);

    d = await seatPass.rodarDiario({ db: client, sync, hoje: '2027-02-01' });
    expect(d.expirados).toBeGreaterThanOrEqual(1); // o banco de teste e compartilhado entre os casos
    expect(await extras(cid)).toBe(1); // volta ao permanente
    expect(sync.mock.calls.find((c) => c[0].id === cid)[0].extra_seats_granted).toBe(1);
    expect(await passe(r.passe.id)).toMatchObject({ status: 'expirado', ended_reason: 'fim_da_temporada' });
    expect(await acoesAudit(cid)).toContain('seat_pass.expired');

    d = await seatPass.rodarDiario({ db: client, sync, hoje: '2027-02-02' });
    expect(d.expirados).toBe(0);
    expect(await extras(cid)).toBe(1);
  });

  test('duas instancias expirando o mesmo passe: subtrai uma vez so', async () => {
    const cid = await novaEmpresa({ extras: 0 });
    const r = await seatPass.contratar({ companyId: cid, qty: 3, source: 'loja', userId }, { db: client, sync: okSync(), hoje: '2026-12-01' });
    const sync = okSync();
    const [a, b] = await Promise.all([
      seatPass.encerrarPasse(r.passe.id, { status: 'expirado', motivo: 'fim_da_temporada' }, { db: client, sync }),
      seatPass.encerrarPasse(r.passe.id, { status: 'expirado', motivo: 'fim_da_temporada' }, { db: client, sync }),
    ]);
    expect([a.encerrado, b.encerrado].sort()).toEqual([false, true]);
    expect(await extras(cid)).toBe(0);
  });

  test('o piso e zero: assentos ajustados a mao durante o passe nao ficam negativos', async () => {
    const cid = await novaEmpresa({ extras: 0 });
    const r = await seatPass.contratar({ companyId: cid, qty: 2, source: 'loja', userId }, { db: client, sync: okSync(), hoje: '2026-12-01' });
    await client.query('UPDATE companies SET extra_seats_granted = 0 WHERE id = $1', [cid]); // PATCH manual do admin
    await seatPass.rodarDiario({ db: client, sync: okSync(), hoje: '2027-02-01' });
    expect(await extras(cid)).toBe(0);
    expect((await passe(r.passe.id)).status).toBe('expirado');
  });

  test('Asaas fora na expiracao: assentos saem mesmo assim e o ajuste fica pendente', async () => {
    const cid = await novaEmpresa({ extras: 0 });
    await seatPass.contratar({ companyId: cid, qty: 1, source: 'loja', userId }, { db: client, sync: okSync(), hoje: '2026-12-01' });
    const fora = jest.fn(async () => ({ updated: false, skipped: 'fetch_failed', error: 'ECONNRESET' }));
    const d = await seatPass.rodarDiario({ db: client, sync: fora, hoje: '2027-02-01' });
    expect(d.expirados).toBeGreaterThanOrEqual(1); // o banco de teste e compartilhado entre os casos
    expect(d.erros.length).toBeGreaterThan(0);
    expect(await extras(cid)).toBe(0);
    const { rows } = await client.query('SELECT sync_pendente FROM seat_passes WHERE company_id = $1', [cid]);
    expect(rows[0].sync_pendente).toBe(true);
  });
});

describe('cortesia da Gestao Aura (sem assinatura na Asaas)', () => {
  test('concede, vale nas contas de acesso, nao cobra e expira sozinho', async () => {
    const cid = await novaEmpresa({ assinatura: null, status: 'trial', extras: 0 });
    const sync = okSync();

    const r = await seatPass.contratar(
      { companyId: cid, qty: 2, source: 'admin', userId, reason: 'vendedora de natal' },
      { db: client, sync, hoje: '2026-11-20' }
    );
    expect(r.passe.cortesia).toBe(true);
    expect(r.cobranca).toMatchObject({ forma: 'cortesia', valor_mensal: 0, valor_maximo_total: 0 });
    expect(await extras(cid)).toBe(2);
    expect(sync).not.toHaveBeenCalled();

    await seatPass.rodarDiario({ db: client, sync, hoje: '2027-02-01' });
    expect(await extras(cid)).toBe(0);
    expect((await passe(r.passe.id)).status).toBe('expirado');
  });

  test('admin em empresa COM assinatura: e cobrado como qualquer extra', async () => {
    const cid = await novaEmpresa({ extras: 0 });
    const sync = okSync();
    const r = await seatPass.contratar({ companyId: cid, qty: 1, source: 'admin', userId }, { db: client, sync, hoje: '2026-11-20' });
    expect(r.passe.cortesia).toBe(false);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('cancelamento', () => {
  test('o dono cancela: assentos saem na hora e a assinatura e reajustada', async () => {
    const cid = await novaEmpresa({ extras: 1 });
    const r = await seatPass.contratar({ companyId: cid, qty: 2, source: 'loja', userId }, { db: client, sync: okSync(), hoje: '2026-11-10' });
    const sync = okSync(188);

    const out = await seatPass.cancelar({ companyId: cid, passId: r.passe.id, userId }, { db: client, sync, hoje: '2026-11-15' });
    expect(out).toMatchObject({ cancelado: true, assentos_removidos: 2 });
    expect(await extras(cid)).toBe(1);
    expect(sync.mock.calls[0][0].extra_seats_granted).toBe(1);
    expect(await passe(r.passe.id)).toMatchObject({ status: 'cancelado', ended_reason: 'cancelado_loja' });

    await expect(seatPass.cancelar({ companyId: cid, passId: r.passe.id, userId }, { db: client, sync }))
      .rejects.toMatchObject({ status: 404, code: 'PASSE_NAO_ENCONTRADO' });
  });

  test('cancelar antes de comecar nao mexe em assento nem em cobranca', async () => {
    const cid = await novaEmpresa({ extras: 0 });
    const sync = okSync();
    const r = await seatPass.contratar({ companyId: cid, qty: 1, source: 'loja', userId }, { db: client, sync, hoje: '2026-10-13' });
    const out = await seatPass.cancelar({ companyId: cid, passId: r.passe.id, userId }, { db: client, sync });
    expect(out.assentos_removidos).toBe(0);
    expect(sync).not.toHaveBeenCalled();
    expect(await extras(cid)).toBe(0);
  });

  test('passe de outra empresa nao e cancelavel por esta', async () => {
    const a = await novaEmpresa({ extras: 0 });
    const b = await novaEmpresa({ extras: 0 });
    const r = await seatPass.contratar({ companyId: a, qty: 1, source: 'loja', userId }, { db: client, sync: okSync(), hoje: '2026-11-10' });
    await expect(seatPass.cancelar({ companyId: b, passId: r.passe.id, userId }, { db: client, sync: okSync() }))
      .rejects.toMatchObject({ code: 'PASSE_NAO_ENCONTRADO' });
    expect(await extras(a)).toBe(1);
  });
});

describe('estado', () => {
  test('mostra passes, validade, valor atual e a previa de N assentos', async () => {
    const cid = await novaEmpresa({ extras: 0 });
    await seatPass.contratar({ companyId: cid, qty: 2, source: 'loja', userId }, { db: client, sync: okSync(), hoje: '2026-11-10' });

    const e = await seatPass.estado(cid, { previaQty: 3 }, { db: client, hoje: '2026-11-12' });
    expect(e).toMatchObject({
      assentos_ativos: 2,
      assentos_agendados: 0,
      valor_mensal_atual: 38,
      valido_ate: '2027-01-31',
      preco_assento_mensal: 19,
      pode_contratar: true,
      limite_restante: 8,
    });
    expect(e.temporada).toMatchObject({ starts_at: '2026-11-01', ends_at: '2027-01-31' });
    expect(e.previa).toMatchObject({ qty: 3, valor_mensal: 57, mensalidades_ate_o_fim: 3, ate: '2027-01-31' });
    expect(e.passes).toHaveLength(1);
    expect(e.passes[0].cobranca.texto).toContain('31/01/2027');
  });

  test('grupo: o passe vai para a empresa que paga (billing owner)', async () => {
    const dona = await novaEmpresa({ extras: 0 });
    const filial = uuid();
    await client.query(
      `INSERT INTO companies (id, owner_id, legal_name, plan, billing_owner_company_id) VALUES ($1, $2, 'Filial', 'negocio', $3)`,
      [filial, userId, dona]
    );
    const sync = okSync();
    const r = await seatPass.contratar({ companyId: filial, qty: 1, source: 'loja', userId }, { db: client, sync, hoje: '2026-11-10' });
    expect(await extras(dona)).toBe(1);
    expect(await extras(filial)).toBe(0);
    expect(sync.mock.calls[0][0].id).toBe(dona);
    expect((await seatPass.estado(filial, {}, { db: client, hoje: '2026-11-10' })).assentos_ativos).toBe(1);
    expect(r.passe.status).toBe('ativo');
  });
});

describe('cobranca de verdade (syncSubscriptionSeatValue) e contagem nos gates', () => {
  const putsDe = () => asaas.mock.calls.filter((c) => c[0] === 'PUT');
  let valorNaAsaas;

  beforeEach(() => {
    valorNaAsaas = 169;
    asaas.mockReset();
    globalDb.query.mockReset();
    globalDb.query.mockResolvedValue({ rows: [] }); // subscription_discounts: sem desconto em curso
    asaas.mockImplementation(async (method, path, body) => {
      if (method === 'GET') return { status: 'ACTIVE', billingType: 'CREDIT_CARD', value: valorNaAsaas, description: 'Aura Negocio' };
      if (method === 'PUT') { valorNaAsaas = body.value; return { ok: true }; }
      throw new Error('chamada inesperada ' + method + ' ' + path);
    });
  });

  test('contratar 2 assentos: PUT da assinatura em 169 + 2x19 = 207; expirar volta a 169', async () => {
    const cid = await novaEmpresa({ extras: 0 });
    const deps = { db: client, sync: syncSubscriptionSeatValue };

    await seatPass.contratar({ companyId: cid, qty: 2, source: 'loja', userId }, { ...deps, hoje: '2026-11-10' });
    expect(putsDe()).toHaveLength(1);
    expect(putsDe()[0][1]).toBe('/subscriptions/sub_x');
    expect(putsDe()[0][2]).toMatchObject({ value: 207, updatePendingPayments: true });
    expect(putsDe()[0][2].description).toContain('2 acesso(s) extra');

    await seatPass.rodarDiario({ ...deps, hoje: '2027-02-01' });
    expect(putsDe()).toHaveLength(2);
    expect(putsDe()[1][2]).toMatchObject({ value: 169, updatePendingPayments: true });
    expect(valorNaAsaas).toBe(169);
  });

  test('o passe soma ao que ja era pago: 1 extra fixo + 2 de temporada = 3 (226 -> 188 ao expirar)', async () => {
    const cid = await novaEmpresa({ extras: 1 });
    valorNaAsaas = 188;
    const deps = { db: client, sync: syncSubscriptionSeatValue };
    await seatPass.contratar({ companyId: cid, qty: 2, source: 'loja', userId }, { ...deps, hoje: '2026-11-10' });
    expect(putsDe()[0][2].value).toBe(226); // 169 + 3x19
    await seatPass.rodarDiario({ ...deps, hoje: '2027-02-01' });
    expect(putsDe()[1][2].value).toBe(188); // 169 + 1x19
  });

  test('gates: os assentos do passe entram em seats_included e saem na expiracao', async () => {
    const cid = await novaEmpresa({ extras: 0, plano: 'essencial' });
    const membros = [{ status: 'active', is_active: true }]; // o titular
    const deps = { db: client, sync: syncSubscriptionSeatValue };

    const antes = summarizeSeats('essencial', membros, await extras(cid));
    expect(antes).toMatchObject({ seats_included: 1, at_limit: true, monthly_cost: 0 });

    await seatPass.contratar({ companyId: cid, qty: 2, source: 'loja', userId }, { ...deps, hoje: '2026-11-10' });
    const durante = summarizeSeats('essencial', membros, await extras(cid));
    expect(durante).toMatchObject({ seats_included: 3, seats_remaining: 2, at_limit: false, extra_seats_granted: 2, monthly_cost: 38 });

    await seatPass.rodarDiario({ ...deps, hoje: '2027-02-01' });
    const depois = summarizeSeats('essencial', membros, await extras(cid));
    expect(depois).toMatchObject({ seats_included: 1, at_limit: true, extra_seats_granted: 0 });
  });
});
