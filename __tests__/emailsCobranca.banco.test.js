// ============================================================
// AURA. — E-mails do ciclo no Postgres de verdade (24/10/2026; migrations
// 407 e 408; tq-74, tq-76, tq-77, tq-78, tq-84, tq-86, tq-93)
//
// Os testes com banco em memória provam a regra; este prova o SQL (tipos dos
// parâmetros, ON CONFLICT, CHECK, backfill), tudo numa transação revertida
// no banco do CI. Mesmo padrão de reportDelivery.banco.test.js: o db
// mockado do jest.setup é redirecionado para a conexão desta transação.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let db;
let dono;
let empresa;

const emailLog = require('../src/services/emailLog');
const C = require('../src/services/cobrancaAssinatura');
const R = require('../src/services/reguaDeCobranca');
const { desligarTipoDeEmail } = require('../src/services/emailPreferencias');

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));

  dono = uuid();
  empresa = uuid();
  await client.query(
    // tq-113: dono com e-mail confirmado (conta pendente não recebe cobrança).
    `INSERT INTO users (id, email, password_hash, full_name, email_verified) VALUES ($1, $2, 'x', 'Maria Fixture', true)`,
    [dono, `maria-${dono}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, email, weekly_report_enabled, billing_status, asaas_customer_id)
     VALUES ($1, $2, 'Modas Fixture', 'loja-fixture@example.test', true, 'overdue', $3)`,
    [empresa, dono, 'cus_' + empresa.slice(0, 8)]
  );
});

beforeEach(() => {
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

const conn = () => ({ query: (s, p) => client.query(s, p) });

test('email_log: reserva única, failed pode voltar, sent não', async () => {
  const d = conn();
  const chave = 'teste:' + uuid();
  const id = await emailLog.reservarEnvio(d, { chave, tipo: 't', companyId: empresa, userId: dono, destinatario: 'a@b.com', assunto: 's' });
  expect(id).toBeTruthy();
  expect(await emailLog.reservarEnvio(d, { chave, tipo: 't' })).toBeNull();
  await emailLog.marcarFalha(d, id, 'Resend 500');
  const id2 = await emailLog.reservarEnvio(d, { chave, tipo: 't' });
  expect(id2).toBe(id);
  await emailLog.marcarEnviado(d, id2, 're_1');
  expect(await emailLog.reservarEnvio(d, { chave, tipo: 't' })).toBeNull();
  const { rows } = await client.query('SELECT status, tentativas, resend_id, sent_at FROM email_log WHERE id = $1', [id]);
  expect(rows[0]).toMatchObject({ status: 'sent', tentativas: 2, resend_id: 're_1' });
  expect(rows[0].sent_at).toBeTruthy();
});

test('email_log: registro sem chave (sendMail comum)', async () => {
  await emailLog.registrarEnvio({ db: conn(), tipo: 'verificacao_email', to: 'x@y.com', subject: 'oi', status: 'sent', resendId: 're_9' });
  const { rows } = await client.query(`SELECT status, chave_idempotencia FROM email_log WHERE resend_id = 're_9'`);
  expect(rows).toEqual([{ status: 'sent', chave_idempotencia: null }]);
});

test('espelho: insere, não regride de PAID para OVERDUE, atualiza sem vencimento', async () => {
  const d = conn();
  const pid = 'pay_' + uuid().slice(0, 8);
  const p = { id: pid, subscription: 'sub_1', value: 169, billingType: 'PIX', dueDate: '2026-10-20', invoiceUrl: 'https://www.asaas.com/i/x' };
  let l = await C.registrarCobranca(d, { companyId: empresa, payment: p, estado: 'PENDING' });
  expect(l).toMatchObject({ status: 'PENDING', due_iso: '2026-10-20' });
  l = await C.registrarCobranca(d, { companyId: empresa, payment: { ...p, paymentDate: '2026-10-21' }, estado: 'PAID' });
  expect(l.status).toBe('PAID');
  l = await C.registrarCobranca(d, { companyId: empresa, payment: p, estado: 'OVERDUE' });
  expect(l.status).toBe('PAID');
  l = await C.registrarCobranca(d, { companyId: empresa, payment: { id: pid }, estado: 'REFUNDED' });
  expect(l.status).toBe('REFUNDED');
  l = await C.registrarCobranca(d, { companyId: empresa, payment: { ...p, creditCard: { creditCardNumber: '4821' } }, estado: 'PENDING', cartaoRecusado: true });
  expect(l.status).toBe('REFUNDED');
  expect(l.cartao_final).toBe('4821');
});

test('backfill da 408: OVERDUE em webhook_logs sem pagamento posterior vira linha do espelho', async () => {
  const outra = uuid();
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, billing_status) VALUES ($1, $2, 'Backfill Fixture', 'overdue')`,
    [outra, dono]
  );
  const vencida = { id: 'pay_bf1', dueDate: '2026-10-20', value: 169.9, billingType: 'BOLETO', status: 'OVERDUE' };
  const paga = { id: 'pay_bf2', dueDate: '2026-09-20', value: 169.9, status: 'OVERDUE' };
  for (const [ev, p] of [['PAYMENT_OVERDUE', vencida], ['PAYMENT_OVERDUE', paga], ['PAYMENT_RECEIVED', { ...paga, status: 'RECEIVED' }]]) {
    await client.query(
      `INSERT INTO webhook_logs (company_id, provider, event, payload) VALUES ($1, 'asaas', $2, $3)`,
      [outra, ev, JSON.stringify(p)]
    );
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '408_assinatura_cobrancas.sql'), 'utf8');
  await client.query(sql);
  await client.query(sql); // idempotente
  const { rows } = await client.query(
    `SELECT asaas_payment_id, status, to_char(due_date, 'YYYY-MM-DD') AS due, valor::float AS valor, origem
       FROM assinatura_cobrancas WHERE company_id = $1`,
    [outra]
  );
  expect(rows).toEqual([{ asaas_payment_id: 'pay_bf1', status: 'OVERDUE', due: '2026-10-20', valor: 169.9, origem: 'backfill' }]);
  expect(await C.datasDoAtraso({ db: conn(), companyId: outra, billingStatus: 'overdue' })).toEqual({
    billing_overdue_since: '2026-10-20', billing_pause_screens_on: '2026-10-27', billing_pause_caixa_on: '2026-11-03',
  });
});

test('régua de atraso no banco: dia 3 manda 2.4 com o valor da Asaas, uma vez', async () => {
  const pid = 'pay_' + uuid().slice(0, 8);
  await C.registrarCobranca(conn(), {
    companyId: empresa, estado: 'OVERDUE',
    payment: { id: pid, value: 169, billingType: 'PIX', dueDate: '2026-10-20' },
  });
  const asaas = jest.fn(async (m, caminho) => {
    if (caminho.endsWith('/pixQrCode')) return { payload: 'PIXFIXTURE' };
    return { id: pid, status: 'OVERDUE', value: 119, interestValue: 0, dueDate: '2026-10-20', billingType: 'PIX' };
  });
  const enviados = [];
  const enviar = jest.fn(async (o) => { enviados.push(o); return { id: 're_x' }; });
  const notifications = { notifyCompany: jest.fn(async () => ({ id: 'n1' })) };
  const s = { varridas: 0, emails: 0, alertas: 0, retentativas: 0, ignorados: 0, adiados: 0, falhas: 0 };
  await R.processarAtrasos({ db: conn(), asaas, enviar, notifications, alertaCompanyId: empresa, hoje: '2026-10-23', summary: s });
  await R.processarAtrasos({ db: conn(), asaas, enviar, notifications, alertaCompanyId: empresa, hoje: '2026-10-23', summary: s });
  expect(s.falhas).toBe(0);
  // (a empresa do teste de backfill também está no dia 3: cada uma recebe o seu)
  const meus = enviados.filter((e) => e.text.includes('Modas Fixture'));
  expect(meus).toHaveLength(1);
  expect(meus[0].subject).toBe('Sobre a mensalidade da Aura: posso ajudar?');
  expect(meus[0].text).toContain('R$ 119,00');
  const { rows } = await client.query(`SELECT status FROM email_log WHERE chave_idempotencia = $1`, ['atraso-3:' + pid]);
  expect(rows).toEqual([{ status: 'sent' }]);
});

test('lembretes e nova tentativa: o SQL roda no banco', async () => {
  const pid = 'pay_' + uuid().slice(0, 8);
  await C.registrarCobranca(conn(), {
    companyId: empresa, estado: 'PENDING',
    payment: { id: pid, value: 169, billingType: 'BOLETO', dueDate: '2026-11-20' },
  });
  const asaas = jest.fn(async (m, caminho) => {
    if (caminho.endsWith('/pixQrCode')) throw new Error('sem pix');
    return { id: pid, status: 'PENDING', value: 169, dueDate: '2026-11-20', billingType: 'BOLETO' };
  });
  const enviados = [];
  const enviar = jest.fn(async (o) => { enviados.push(o); return { id: 're_y' }; });
  const s = { varridas: 0, emails: 0, alertas: 0, retentativas: 0, ignorados: 0, adiados: 0, falhas: 0 };
  await R.processarLembretes({ db: conn(), asaas, enviar, hoje: '2026-11-18', summary: s });
  expect(s.falhas).toBe(0);
  expect(enviados.map((e) => e.subject)).toEqual(['Sua mensalidade da Aura vence sexta-feira']);

  await R.processarRetentativas({ db: conn(), asaas, enviar, hoje: '2026-11-18', now: Date.now(), summary: s });
  expect(s.falhas).toBe(0);
});

test('descadastro no banco: desliga weekly_report_enabled e grava audit_log', async () => {
  const r = await desligarTipoDeEmail(conn(), empresa, 'relatorio', { origem: 'one_click', contexto: { ip: '200.1.2.3', userAgent: 'x'.repeat(300) } });
  expect(r.desligadas).toEqual([empresa]);
  const { rows } = await client.query('SELECT weekly_report_enabled FROM companies WHERE id = $1', [empresa]);
  expect(rows[0].weekly_report_enabled).toBe(false);
  const { rows: a } = await client.query(`SELECT action, metadata FROM audit_log WHERE company_id = $1 AND action = 'email.descadastro'`, [empresa]);
  expect(a).toHaveLength(1);
  expect(a[0].metadata).toMatchObject({ tipo: 'relatorio', origem: 'one_click' });
});
