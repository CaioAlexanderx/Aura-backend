// ============================================================
// Acessos do checkout (p-106, migration 445) — contra o Postgres REAL.
//
// Cobre o que o mock de db.query não enxerga: a instrução única que trava a
// empresa, soma a temporada (seat_passes) e limpa a pendência, os tipos dos
// parâmetros e a CHECK de 0 a 10 da migration.
//
// Mesmo padrão de seatPassLive: o serviço recebe o client por `deps.db` e tudo
// roda numa transação revertida no fim. extra_seats_granted / billing_cycle
// nascem em src/migrations/ (o CI não aplica): criadas dentro da transação.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const svc = require('../../src/services/acessosPendentes');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let userId;

async function novaEmpresa({ extras = 0, pendente = null, sub = null, pay = null } = {}) {
  const id = uuid();
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, plan, billing_status, asaas_subscription_id,
                            extra_seats_granted, billing_cycle)
     VALUES ($1, $2, 'Loja Acessos', 'negocio', 'pending', $3, $4, 'monthly')`,
    [id, userId, sub, extras]
  );
  if (pendente !== null) {
    expect(await svc.gravarPendencia(id, { qty: pendente, subscriptionId: sub, paymentId: pay }, { db: client })).toBe(true);
  }
  return id;
}

async function passe(companyId, qty, { aplicado = true, status = 'ativo' } = {}) {
  await client.query(
    `INSERT INTO seat_passes (company_id, qty, starts_at, ends_at, status, season, source, cortesia, unit_price, applied_at)
     VALUES ($1, $2, '2026-11-01', '2027-01-31', $3, 'bf-2026', 'loja', false, 19, $4)`,
    [companyId, qty, status, aplicado ? new Date() : null]
  );
}

const linha = async (id) => (await client.query(
  `SELECT extra_seats_granted, pending_extra_seats, pending_extra_seats_subscription_id,
          pending_extra_seats_payment_id, pending_extra_seats_at
     FROM companies WHERE id = $1`, [id])).rows[0];

const semSync = async () => ({ updated: false, skipped: 'value_unchanged', value: 0 });

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS extra_seats_granted INTEGER NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(20) DEFAULT 'monthly'`);
  userId = uuid();
  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Dona da Loja')`,
    [userId, `acessos-${userId}@example.com`]
  );
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('a pendência fica gravada e o pagamento da assinatura libera: pendente + temporada ativa aplicada', async () => {
  const cid = await novaEmpresa({ extras: 3, pendente: 4, sub: 'sub_novo', pay: 'pay_1' });
  await passe(cid, 2);                          // ativo e aplicado: conta
  await passe(cid, 5, { aplicado: false });     // agendado: não conta
  await passe(cid, 7, { status: 'expirado' });  // encerrado: não conta

  const antes = await linha(cid);
  expect(antes).toMatchObject({ extra_seats_granted: 3, pending_extra_seats: 4, pending_extra_seats_subscription_id: 'sub_novo' });
  expect(antes.pending_extra_seats_at).not.toBeNull();
  expect(await svc.acessosDeTemporadaAtivos(cid, { db: client })).toBe(2);

  const r = await svc.aplicarPendenciaDoPagamento(
    { companyId: cid, payment: { id: 'pay_outro', subscription: 'sub_novo' } }, { db: client, sync: semSync });
  expect(r).toMatchObject({ aplicado: true, extra_seats_granted: 6, pendente: 4, temporada: 2 });

  expect(await linha(cid)).toMatchObject({
    extra_seats_granted: 6, pending_extra_seats: null, pending_extra_seats_subscription_id: null,
    pending_extra_seats_payment_id: null, pending_extra_seats_at: null,
  });
  const { rows } = await client.query(`SELECT action, metadata FROM audit_log WHERE company_id = $1`, [cid]);
  expect(rows.map((x) => x.action)).toEqual(['billing.extra_seats_applied']);
  expect(rows[0].metadata).toMatchObject({ pendente: 4, temporada: 2, extra_seats_granted_antes: 3, extra_seats_granted: 6 });

  // segunda vez: nada pendente
  const de = await svc.aplicarPendenciaDoPagamento(
    { companyId: cid, payment: { id: 'pay_outro', subscription: 'sub_novo' } }, { db: client, sync: semSync });
  expect(de).toEqual({ aplicado: false, motivo: 'sem_pendencia' });
});

test('cobrança avulsa do cartão casa pelo payment id; outra assinatura não casa', async () => {
  const cid = await novaEmpresa({ extras: 0, pendente: 2, sub: null, pay: 'pay_cartao' });
  const outra = await svc.aplicarPendenciaDoPagamento(
    { companyId: cid, payment: { id: 'pay_velho', subscription: 'sub_velha' } }, { db: client, sync: semSync });
  expect(outra.aplicado).toBe(false);
  expect((await linha(cid)).pending_extra_seats).toBe(2);

  const r = await svc.aplicarPendenciaDoPagamento(
    { companyId: cid, payment: { id: 'pay_cartao', subscription: null } }, { db: client, sync: semSync });
  expect(r).toMatchObject({ aplicado: true, extra_seats_granted: 2 });
});

test('limpar a pendência e a CHECK de 0 a 10', async () => {
  const cid = await novaEmpresa({ pendente: 10, sub: 'sub_a', pay: 'pay_a' });
  await svc.gravarPendencia(cid, { qty: null }, { db: client });
  expect(await linha(cid)).toMatchObject({ pending_extra_seats: null, pending_extra_seats_subscription_id: null, pending_extra_seats_at: null });

  await client.query('SAVEPOINT fora_da_faixa');
  await expect(client.query('UPDATE companies SET pending_extra_seats = 11 WHERE id = $1', [cid]))
    .rejects.toThrow(/companies_pending_extra_seats_range/);
  await client.query('ROLLBACK TO SAVEPOINT fora_da_faixa');
});
