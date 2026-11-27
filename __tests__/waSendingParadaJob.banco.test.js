'use strict';
// Alerta de 'sending' parada — Postgres real: a SQL do job contra wa_outbox e
// alert_history. Mesmo arranjo do waOutbox.despacho.banco.test.js (db global
// mockado, redirecionado para o pool de teste).

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
let db;
let waOutbox;
let job;
let seq = 0;
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  for (const sql of [
    'DELETE FROM alert_history WHERE company_id = $1',
    'DELETE FROM wa_saldo_lancamentos WHERE company_id = $1',
    'DELETE FROM wa_outbox WHERE company_id = $1',
    'DELETE FROM wa_templates WHERE company_id = $1',
    'DELETE FROM companies WHERE id = $1',
  ]) {
    try { await q(sql, [ID.loja]); } catch (_) { /* banco descartavel */ }
  }
  try { await q('DELETE FROM users WHERE id = $1', [ID.dono]); } catch (_) { /* idem */ }
}

// Linha em 'sending' ha `minutos`, com ou sem wamid.
async function emSending({ minutos, wamid = null, erro = null }) {
  seq += 1;
  const e = await waOutbox.enqueue({
    companyId: ID.loja, toPhone: `5511955${String(seq).padStart(6, '0')}`, kind: 'template',
    templateName: 'parcela_lembrete', sourceType: 'crediario', sourceId: `s-${seq}`,
  });
  await q(
    `UPDATE wa_outbox SET status = 'sending', wa_message_id = $2, last_error = $3,
            updated_at = NOW() - ($4 || ' minutes')::interval WHERE id = $1`,
    [e.id, wamid, erro, String(minutos)]
  );
  return e.id;
}
const linha = async (id) => (await q('SELECT status, wa_message_id, last_error FROM wa_outbox WHERE id = $1', [id])).rows[0];
const alertas = async (id) => (await q(
  `SELECT 1 FROM alert_history WHERE company_id = $1 AND alert_type = 'wa_outbox_sending_parada' AND message LIKE $2`,
  [ID.loja, `%${id}%`])).rows.length;

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  waOutbox = require('../src/services/waOutbox');
  job = require('../src/jobs/waSendingParadaJob');

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Sending')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan)
           VALUES ($1, $2, 'Sending Loja', 'Sending Loja', 'negocio')`, [ID.loja, ID.dono]);
  await q(`INSERT INTO wa_templates (company_id, name, language, status) VALUES ($1, 'parcela_lembrete', 'pt_BR', 'APPROVED')`, [ID.loja]);
});

afterAll(async () => {
  await limpar();
  await pool.end();
});

test('com wamid ha mais de 15 min: vira sent, sem alerta', async () => {
  const id = await emSending({ minutos: 40, wamid: 'wamid.ABC', erro: 'ENVIADO_SEM_REGISTRO' });
  await job.verificarSendingParadas({ db, log: jest.fn() });
  expect(await linha(id)).toMatchObject({ status: 'sent', wa_message_id: 'wamid.ABC', last_error: null });
  expect(await alertas(id)).toBe(0);
});

test('sem wamid ha mais de 15 min: alerta uma vez so, continua sending, nao reenvia', async () => {
  const wa = require('../src/services/whatsapp');
  wa.sendTemplate.mockClear();
  const id = await emSending({ minutos: 40 });
  const log = jest.fn();
  await job.verificarSendingParadas({ db, log });
  await job.verificarSendingParadas({ db, log });
  expect(await linha(id)).toMatchObject({ status: 'sending', wa_message_id: null, last_error: job.MARCA_ALERTADA });
  expect(await alertas(id)).toBe(1);
  expect(log.mock.calls.filter((c) => c[0].includes(id))).toHaveLength(1);
  expect(wa.sendTemplate).not.toHaveBeenCalled();
});

test('sending recente (2 min) nao e tocada', async () => {
  const id = await emSending({ minutos: 2 });
  await job.verificarSendingParadas({ db, log: jest.fn() });
  expect(await linha(id)).toMatchObject({ status: 'sending', last_error: null });
  expect(await alertas(id)).toBe(0);
});
