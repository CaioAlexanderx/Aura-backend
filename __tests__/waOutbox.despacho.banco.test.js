// ============================================================
// AURA. — Despacho da wa_outbox: claim atomico, envio sem registro e
// devolucao do saldo (migration 472) — Postgres real
//
//   - dois despachos ao mesmo tempo nunca enviam a mesma linha;
//   - a Meta aceitou e so o registro 'sent' falhou: nao reenvia e nao
//     devolve o saldo (fica para conferencia, com o wamid anotado);
//   - devolver funciona mesmo com a trava WA_SALDO_ATIVO desligada, se a
//     reserva existe no livro-razao.
// ============================================================
'use strict';

jest.mock('../src/services/whatsapp', () => ({
  sendTemplate: jest.fn(async () => ({ messages: [{ id: 'wamid.TESTE' }] })),
  sendText: jest.fn(async () => ({ messages: [{ id: 'wamid.TESTE' }] })),
}));

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN = process.env.SUPABASE_DB_URL || 'postgresql://aura_test:aura_test@localhost:5432/aura_test';
jest.setTimeout(60000);

const ID = { dono: uuid(), loja: uuid() };
let pool;
let waSaldo;
let waOutbox;
let wa;
let db;
let seq = 0;
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  for (const sql of [
    'DELETE FROM wa_saldo_lancamentos WHERE company_id = $1',
    'DELETE FROM wa_messages WHERE company_id = $1',
    'DELETE FROM wa_outbox WHERE company_id = $1',
    'DELETE FROM wa_templates WHERE company_id = $1',
    'DELETE FROM companies WHERE id = $1',
  ]) {
    try { await q(sql, [ID.loja]); } catch (_) { /* banco descartavel */ }
  }
  try { await q('DELETE FROM users WHERE id = $1', [ID.dono]); } catch (_) { /* idem */ }
}

const enfileirar = () => {
  seq += 1;
  return waOutbox.enqueue({
    companyId: ID.loja, toPhone: `5511966${String(seq).padStart(6, '0')}`, kind: 'template',
    templateName: 'parcela_lembrete', sourceType: 'crediario', sourceId: `d-${seq}`,
  });
};
const linha = async (id) => (await q('SELECT status, wa_message_id, last_error FROM wa_outbox WHERE id = $1', [id])).rows[0];
const estornos = async () => (await q(
  `SELECT COUNT(*)::int AS n FROM wa_saldo_lancamentos WHERE company_id = $1 AND kind = 'estorno'`, [ID.loja])).rows[0].n;
const usado = async () => (await waSaldo.getSaldos(ID.loja)).saldos.avisos.usado;

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 12 });
  db = require('../src/config/database');
  // As colunas de credencial (039) ficam fora das migrations do CI: o loadCreds e simulado.
  db.query.mockImplementation((sql, params) => (String(sql).includes('-- wa:creds')
    ? Promise.resolve({ rows: [{ wa_phone_number_id: 'pn_teste', wa_access_token: 'token_teste' }] })
    : pool.query(sql, params)));
  db.connect.mockImplementation(() => pool.connect());
  process.env.WA_SALDO_ATIVO = '1';
  waSaldo = require('../src/services/waSaldo');
  waOutbox = require('../src/services/waOutbox');
  wa = require('../src/services/whatsapp');

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Despacho')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan)
           VALUES ($1, $2, 'Despacho Loja', 'Despacho Loja', 'negocio')`, [ID.loja, ID.dono]);
  await q(`INSERT INTO wa_templates (company_id, name, language, status) VALUES ($1, 'parcela_lembrete', 'pt_BR', 'APPROVED')`, [ID.loja]);
});

afterAll(async () => {
  process.env.WA_SALDO_ATIVO = '1';
  await limpar();
  await pool.end();
});

test('dois despachos ao mesmo tempo enviam a mesma linha uma vez so', async () => {
  const e = await enfileirar();
  expect(e.queued).toBe(true);
  wa.sendTemplate.mockClear();
  const [a, b] = await Promise.all([waOutbox.processBatch(500), waOutbox.processBatch(500)]);
  expect(wa.sendTemplate).toHaveBeenCalledTimes(1);
  expect(a.sent + b.sent).toBe(1);
  expect((await linha(e.id)).status).toBe('sent');
});

test('a Meta aceitou e o registro falhou: nao reenvia e nao devolve', async () => {
  const e = await enfileirar();
  const antes = await usado();
  wa.sendTemplate.mockClear();
  const impl = db.query.getMockImplementation();
  db.query.mockImplementation((sql, params) => {
    if (/UPDATE wa_outbox SET status = \$1/.test(String(sql)) && params && params[0] === 'sent') {
      return Promise.reject(new Error('queda no registro'));
    }
    return impl(sql, params);
  });
  let r1;
  try { r1 = await waOutbox.processBatch(500); } finally { db.query.mockImplementation(impl); }
  expect(wa.sendTemplate).toHaveBeenCalledTimes(1);
  expect(r1.failed).toBe(0);
  expect(r1.retried).toBe(0);
  const l = await linha(e.id);
  expect(l).toMatchObject({ status: 'sending', wa_message_id: 'wamid.TESTE', last_error: 'ENVIADO_SEM_REGISTRO' });
  // proximo despacho nao pega de novo
  await waOutbox.processBatch(500);
  expect(wa.sendTemplate).toHaveBeenCalledTimes(1);
  expect(await usado()).toBe(antes);
  expect(await estornos()).toBe(0);
});

test('falha de vez devolve, mesmo com a trava desligada depois da reserva', async () => {
  const e = await enfileirar(); // reservou com a trava ligada
  const antes = await usado();
  process.env.WA_SALDO_ATIVO = '0';
  try {
    wa.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('numero invalido'), { meta: { code: 131026 } }));
    const r = await waOutbox.processBatch(500);
    expect(r.failed).toBe(1);
  } finally { process.env.WA_SALDO_ATIVO = '1'; }
  expect((await linha(e.id)).status).toBe('failed');
  expect(await estornos()).toBe(1);
  expect(await usado()).toBe(antes - 1);
});

test('erro transitorio volta para pending e tenta de novo depois', async () => {
  const e = await enfileirar();
  wa.sendTemplate.mockRejectedValueOnce(new Error('rede'));
  const r = await waOutbox.processBatch(500);
  expect(r.retried).toBe(1);
  expect((await linha(e.id)).status).toBe('pending');
});
