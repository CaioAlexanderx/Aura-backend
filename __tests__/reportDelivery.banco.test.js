// ============================================================
// AURA. — report_deliveries no Postgres de verdade (tq-72, 21/10/2026)
//
// O CASO REAL: o relatório semanal de 19/10 saiu, mas o UPDATE de status
// falhava com 42P08 "inconsistent types deduced for parameter $2" e as
// linhas ficavam 'pending'. O $2 aparecia em `status=$2` (coluna VARCHAR:
// o Postgres deduz character varying) e em `$2='sent'` (deduz text); o
// node-pg manda os parâmetros sem tipo, então a dedução é do servidor.
//
// O que este arquivo cobre (banco do CI, tudo numa transação revertida):
//   1. o SQL antigo falha com 42P08 — a causa, documentada
//   2. updateDelivery 'sent' grava status, resend_id, sent_at, attempts
//   3. updateDelivery 'failed' grava last_error curto e sem e-mail
//   4. reportScheduler + mailer em modo dev (sem RESEND_API_KEY) levam a
//      linha de 'pending' a 'sent' com o id do envio, e a 'failed' quando o
//      envio lança
//
// Mesmo padrão de codigoDeAcessoManual.banco.test.js: o db mockado do
// jest.setup é redirecionado para a conexão desta transação.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

jest.mock('../src/services/reportGenerator', () => {
  const real = jest.requireActual('../src/services/reportGenerator');
  return { ...real, generateReport: jest.fn(), generateConsolidatedReport: jest.fn() };
});

const reportGenerator = require('../src/services/reportGenerator');
const { updateDelivery } = reportGenerator;

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const SQL_ANTIGO = `UPDATE report_deliveries SET status=$2, last_error=$3, sent_at=CASE WHEN $2='sent' THEN NOW() ELSE NULL END, attempts=attempts+1 WHERE id=$1`;

const ENV = { ...process.env };
let pool;
let client;
let db;
let companyId;

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  db = require('../src/config/database');

  const userId = uuid();
  companyId = uuid();
  await client.query(
    // tq-113: dono com e-mail confirmado (conta pendente fica fora do relatório).
    `INSERT INTO users (id, email, password_hash, full_name, email_verified) VALUES ($1, $2, 'x', 'Fixture tq-72', true)`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    // tq-88: o scheduler só manda para teste vigente ou assinatura ativa.
    // Hotfix 26/10: só entra no relatório a empresa criada antes do fim do período.
    `INSERT INTO companies (id, owner_id, legal_name, email, weekly_report_enabled, billing_status, created_at)
     VALUES ($1, $2, 'Fixture tq-72', 'dona-tq72@example.test', true, 'active', NOW() - interval '30 days')`,
    [companyId, userId]
  );
});

beforeEach(() => {
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ENV };
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

async function novaEntrega() {
  const { rows: [r] } = await client.query(
    `INSERT INTO report_deliveries (company_id, report_type, period_start, status)
     VALUES ($1, 'weekly', CURRENT_DATE - (random() * 1000)::int, 'pending') RETURNING id`,
    [companyId]
  );
  return r.id;
}

async function linha(id) {
  const { rows: [r] } = await client.query(
    `SELECT status, resend_id, attempts, last_error, sent_at FROM report_deliveries WHERE id = $1`,
    [id]
  );
  return r;
}

test('o SQL antigo falha com 42P08 (a causa do "inconsistent types")', async () => {
  const id = await novaEntrega();
  await client.query('SAVEPOINT antigo');
  let erro = null;
  try {
    await client.query(SQL_ANTIGO, [id, 'sent', null]);
  } catch (e) {
    erro = e;
  }
  await client.query('ROLLBACK TO SAVEPOINT antigo');
  expect(erro).not.toBeNull();
  expect(erro.code).toBe('42P08');
  // A mensagem sai no idioma do lc_messages do servidor; código e detalhe
  // não mudam.
  expect(erro.message).toContain('$2');
  expect(erro.detail).toBe('text versus character varying');
});

test("updateDelivery 'sent' grava status, resend_id, sent_at e attempts", async () => {
  const id = await novaEntrega();
  const erroSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  expect(await updateDelivery(id, 'sent', { resendId: 're_banco_1' })).toBe(true);

  const r = await linha(id);
  expect(erroSpy).not.toHaveBeenCalled();
  expect(r.status).toBe('sent');
  expect(r.resend_id).toBe('re_banco_1');
  expect(r.attempts).toBe(1);
  expect(r.last_error).toBeNull();
  expect(r.sent_at).toBeInstanceOf(Date);
});

test("updateDelivery 'failed' grava last_error curto, sem e-mail, e soma attempts", async () => {
  const id = await novaEntrega();
  await updateDelivery(id, 'failed', { error: 'Resend API 422: dona@loja.com.br invalido' });
  await updateDelivery(id, 'failed', { error: 'timeout' });

  const r = await linha(id);
  expect(r.status).toBe('failed');
  expect(r.attempts).toBe(2);
  expect(r.last_error).toBe('timeout');
  expect(r.sent_at).toBeNull();
  expect(r.resend_id).toBeNull();
});

describe('reportScheduler + mailer em modo dev', () => {
  function relatorioPara(deliveryId) {
    reportGenerator.generateReport.mockImplementation(async (id) => {
      // Só a empresa da fixture; qualquer outra do banco de teste é pulada.
      if (id !== companyId) return { skipped: true, reason: 'fora_do_teste' };
      return {
        skipped: false,
        deliveryId,
        company: { id: companyId, name: 'Fixture tq-72', recipient_email: 'dona-tq72@example.test' },
        kpis: { revenue: 100, sales: 2, avg_ticket: 50, health_score: 60 },
        reportUrl: 'https://app.getaura.com.br/relatorios/semanal/tok',
      };
    });
  }

  test("pending -> 'sent' com o id do envio dev", async () => {
    const id = await novaEntrega();
    relatorioPara(id);
    const logs = [];
    jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    jest.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));

    await client.query('DELETE FROM email_log WHERE company_id = $1', [companyId]);
    await require('../src/jobs/reportScheduler').triggerWeeklyReports({ forcar: true });

    const r = await linha(id);
    expect(r.status).toBe('sent');
    expect(r.resend_id).toMatch(/^dev-\d+$/);
    expect(r.attempts).toBe(1);
    expect(r.sent_at).toBeInstanceOf(Date);
    expect(logs.join('\n')).toContain('delivery_update_errors=0');
    // tq-88: a reserva no email_log virou 'sent' com o mesmo id do envio.
    const { rows: el } = await client.query(
      'SELECT status, resend_id, tipo, chave_idempotencia FROM email_log WHERE company_id = $1', [companyId]);
    expect(el).toHaveLength(1);
    expect(el[0]).toMatchObject({ status: 'sent', resend_id: r.resend_id, tipo: 'relatorio_semanal' });
    expect(el[0].chave_idempotencia.startsWith(`relatorio:${companyId}:`)).toBe(true);

    // Segunda volta no mesmo período: nada sai de novo.
    const antes = logs.length;
    await require('../src/jobs/reportScheduler').triggerWeeklyReports({ forcar: true });
    expect(logs.slice(antes).join('\n')).not.toContain('sent [');
    const { rows: el2 } = await client.query('SELECT 1 FROM email_log WHERE company_id = $1', [companyId]);
    expect(el2).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('dona-tq72@example.test');
  });

  test("pending -> 'failed' quando o envio lança", async () => {
    const id = await novaEntrega();
    relatorioPara(id);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mailer = require('../src/services/mailer');
    jest.spyOn(mailer, 'sendWeeklyReport').mockRejectedValue(new Error('Resend API 500: indisponivel'));

    await client.query('DELETE FROM email_log WHERE company_id = $1', [companyId]);
    await require('../src/jobs/reportScheduler').triggerWeeklyReports({ forcar: true });
    const { rows: el } = await client.query('SELECT status, erro FROM email_log WHERE company_id = $1', [companyId]);
    expect(el[0]).toMatchObject({ status: 'failed', erro: 'Resend API 500: indisponivel' });

    const r = await linha(id);
    expect(r.status).toBe('failed');
    expect(r.attempts).toBe(1);
    expect(r.last_error).toBe('Resend API 500: indisponivel');
    expect(r.resend_id).toBeNull();
    expect(r.sent_at).toBeNull();
  });
});
