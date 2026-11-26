// ============================================================
// AURA. — Pacotes do saldo do WhatsApp (migration 472) — Postgres real
// services/waSaldoPacotes.js, routes/whatsappSaldo.js (pacotes) e o
// webhook do Asaas (wa-pack-<id>).
//
//   novidades 100 por R$ 69 | avisos 200 por R$ 19 | Aurinha 300 por R$ 29
//
// Provado no banco de verdade:
//   - o pedido nasce 'pending' e NAO credita nada antes do pagamento;
//   - preco e quantidade saem do servidor (nunca do corpo da requisicao);
//   - pagamento recebido credita UMA vez, no saldo que o pacote comprou,
//     mesmo com o webhook reenviado, em paralelo ou com a Gestao junto;
//   - pacote pendente ou cancelado nunca credita;
//   - sem cliente Asaas o pedido fica pendente com needs_manual.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
process.env.ASAAS_WEBHOOK_SECRET = 'segredo-do-webhook-teste';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => next(),
  requireCompanyAccess: () => (req, _res, next) => next(),
  requirePlan: () => (req, _res, next) => next(),
  requireRole: () => (req, _res, next) => next(),
}));
jest.mock('../src/services/asaasClient', () => ({
  asaasRequest: jest.fn(async () => ({ id: 'pay_novo', invoiceUrl: 'https://asaas.test/i/1' })),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN = process.env.SUPABASE_DB_URL || 'postgresql://aura_test:aura_test@localhost:5432/aura_test';
jest.setTimeout(60000);

const ID = { dono: uuid(), loja: uuid(), semAsaas: uuid(), webhook: uuid() };
const EMPRESAS = [ID.loja, ID.semAsaas, ID.webhook];

let pool;
let waSaldo;
let pacotes;
let asaasRequest;
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  for (const sql of [
    'DELETE FROM wa_saldo_lancamentos WHERE company_id = ANY($1)',
    'DELETE FROM wa_marketing_packs WHERE company_id = ANY($1)',
    'DELETE FROM alert_history WHERE company_id = ANY($1)',
    'DELETE FROM webhook_logs WHERE company_id = ANY($1)',
    'DELETE FROM companies WHERE id = ANY($1)',
  ]) {
    try { await q(sql, [EMPRESAS]); } catch (_) { /* banco descartavel */ }
  }
  try { await q('DELETE FROM users WHERE id = $1', [ID.dono]); } catch (_) { /* idem */ }
}

const saldo = async (companyId, bucket) => (await waSaldo.getSaldos(companyId)).saldos[bucket];
const creditos = async (companyId, bucket) => {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(qty), 0)::int AS qty FROM wa_saldo_lancamentos
      WHERE company_id = $1 AND bucket = $2 AND kind = 'pacote'`, [companyId, bucket]);
  return rows[0];
};
// o que o webhook faz ao receber o dinheiro: ativa o pacote e credita
const pagar = async (packId, paymentId = 'pay_x') => {
  const quota = require('../src/services/marketing/marketingQuota');
  const pack = await quota.activatePack(packId, paymentId);
  if (pack) await pacotes.creditarPacote(pack.id);
  return pack;
};

const app = express();
app.use(express.json());

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 12 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  process.env.WA_SALDO_ATIVO = '1';
  waSaldo = require('../src/services/waSaldo');
  pacotes = require('../src/services/waSaldoPacotes');
  asaasRequest = require('../src/services/asaasClient').asaasRequest;
  app.use('/companies/:id', require('../src/routes/whatsappSaldo'));
  app.use('/webhooks/asaas', require('../src/routes/webhookAsaas'));

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Pacotes')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  for (const [id, nome] of [[ID.loja, 'Pacotes Loja'], [ID.semAsaas, 'Pacotes Sem Asaas'], [ID.webhook, 'Pacotes Webhook']]) {
    await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan) VALUES ($1, $2, $3, $3, 'negocio')`,
      [id, ID.dono, nome]);
  }
  await q(`UPDATE companies SET asaas_customer_id = 'cus_pacotes_1' WHERE id = ANY($1)`, [[ID.loja, ID.webhook]]);
});

afterAll(async () => {
  await limpar();
  await pool.end();
});

describe('pedido de pacote (POST /whatsapp/saldo/pacotes)', () => {
  test.each([
    ['novidades', 100, 6900, 'novidades'],
    ['avisos', 200, 1900, 'avisos'],
    ['aurinha', 300, 2900, 'aurinha'],
  ])('%s: %i por %i centavos, pendente, sem creditar nada antes do pagamento', async (bucket, qty, preco) => {
    asaasRequest.mockClear();
    const antes = await saldo(ID.loja, bucket);
    const res = await request(app).post(`/companies/${ID.loja}/whatsapp/saldo/pacotes`).send({ bucket });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ needs_manual: false, payment_url: 'https://asaas.test/i/1' });
    expect(res.body.pack).toMatchObject({ bucket, qty, price_cents: preco, status: 'pending', asaas_payment_id: 'pay_novo' });
    const cobranca = asaasRequest.mock.calls[0][2];
    expect(cobranca.value).toBe(preco / 100);
    expect(cobranca.externalReference).toBe(`wa-pack-${res.body.pack.id}`);
    expect((await saldo(ID.loja, bucket)).total).toBe(antes.total);
    expect((await creditos(ID.loja, bucket)).n).toBe(0);
  });

  test('preco e quantidade do corpo da requisicao sao ignorados', async () => {
    const res = await request(app).post(`/companies/${ID.loja}/whatsapp/saldo/pacotes`)
      .send({ bucket: 'avisos', qty: 5000, price_cents: 1, priceCents: 1 });
    expect(res.body.pack).toMatchObject({ qty: 200, price_cents: 1900 });
  });

  test('bucket invalido: 422', async () => {
    const res = await request(app).post(`/companies/${ID.loja}/whatsapp/saldo/pacotes`).send({ bucket: 'tudo' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('sem cliente no Asaas: fica pendente com needs_manual e avisa a Gestao', async () => {
    const res = await request(app).post(`/companies/${ID.semAsaas}/whatsapp/saldo/pacotes`).send({ bucket: 'aurinha' });
    expect(res.body).toMatchObject({ needs_manual: true, payment_url: null });
    expect(res.body.pack.status).toBe('pending');
    expect((await creditos(ID.semAsaas, 'aurinha')).n).toBe(0);
  });

  test('GET lista os pedidos com o saldo de cada um', async () => {
    const res = await request(app).get(`/companies/${ID.loja}/whatsapp/saldo/pacotes`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(4);
    expect(res.body.data[0]).toHaveProperty('bucket');
  });
});

describe('credito do pacote pago', () => {
  const novoPedido = async (companyId, bucket) => (await pacotes.criarPacote(companyId, { bucket })).id;

  test('pacote pendente nunca credita', async () => {
    const id = await novoPedido(ID.loja, 'avisos');
    expect(await pacotes.creditarPacote(id)).toMatchObject({ creditado: false });
    expect((await creditos(ID.loja, 'avisos')).n).toBe(0);
  });

  test('pago credita no saldo que comprou, e so nele', async () => {
    const antes = { avisos: await saldo(ID.loja, 'avisos'), novidades: await saldo(ID.loja, 'novidades') };
    await pagar(await novoPedido(ID.loja, 'avisos'), 'pay_a1');
    const avisos = await saldo(ID.loja, 'avisos');
    expect(avisos.total).toBe(antes.avisos.total + 200);
    expect(avisos.fontes.find((f) => f.fonte === 'pacote')).toMatchObject({ total: 200, restante: 200, renova_em: null });
    expect((await saldo(ID.loja, 'novidades')).total).toBe(antes.novidades.total);
  });

  test('o mesmo pacote creditado 6 vezes ao mesmo tempo soma uma so', async () => {
    const id = await novoPedido(ID.loja, 'aurinha');
    const quota = require('../src/services/marketing/marketingQuota');
    await quota.activatePack(id, 'pay_a2');
    const rs = await Promise.all(Array.from({ length: 6 }, () => pacotes.creditarPacote(id)));
    expect(rs.filter((r) => r.creditado)).toHaveLength(1);
    expect(await creditos(ID.loja, 'aurinha')).toEqual({ n: 1, qty: 300 });
    await pagar(id, 'pay_a2'); // reenvio do webhook
    expect(await creditos(ID.loja, 'aurinha')).toEqual({ n: 1, qty: 300 });
  });

  test('pacote cancelado nao ressuscita nem credita', async () => {
    const id = await novoPedido(ID.loja, 'novidades');
    await q(`UPDATE wa_marketing_packs SET status = 'cancelled' WHERE id = $1`, [id]);
    expect(await pagar(id)).toBeNull();
    expect((await creditos(ID.loja, 'novidades')).n).toBe(0);
  });

  test('pacote ja ativo pela Gestao Aura credita ao nascer, uma vez', async () => {
    const pack = await pacotes.criarPacote(ID.semAsaas, { bucket: 'novidades', status: 'active', source: 'admin' });
    expect(pack.status).toBe('active');
    expect(await creditos(ID.semAsaas, 'novidades')).toEqual({ n: 1, qty: 100 });
    await pacotes.creditarPacote(pack.id);
    expect(await creditos(ID.semAsaas, 'novidades')).toEqual({ n: 1, qty: 100 });
  });

  test('o pacote comprado e gasto depois da franquia e o saldo diminui', async () => {
    const pack = await pacotes.criarPacote(ID.semAsaas, { bucket: 'avisos', status: 'active', source: 'admin' });
    await q(`INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, periodo, ref_key)
             SELECT $1, 'avisos', 'consumo', 'franquia', -1, $2::date, 'seed-pac:' || g FROM generate_series(1, 100) g`,
    [ID.semAsaas, waSaldo.periodoDe()]);
    const r = await waSaldo.reservarAvulso({ companyId: ID.semAsaas, bucket: 'avisos', refKey: `pac:${uuid()}` });
    expect(r).toMatchObject({ ok: true, fonte: 'pacote', restante: 199 });
    expect(pack.qty).toBe(200);
  });
});

describe('webhook do Asaas (wa-pack-<id>)', () => {
  const enviar = (event, packId, paymentId) => request(app)
    .post('/webhooks/asaas')
    .set('asaas-access-token', 'segredo-do-webhook-teste')
    .send({ event, payment: { id: paymentId, externalReference: `wa-pack-${packId}`, customer: 'cus_pacotes_1' } });

  test('PAYMENT_RECEIVED credita; reenvio e PAYMENT_CONFIRMED nao creditam de novo; vencida nao credita', async () => {
    const pack = await pacotes.criarPacote(ID.webhook, { bucket: 'avisos' });
    const vencida = await enviar('PAYMENT_OVERDUE', pack.id, 'pay_w1');
    expect(vencida.body.handled).toBe(false);
    expect((await creditos(ID.webhook, 'avisos')).n).toBe(0);

    const pago = await enviar('PAYMENT_RECEIVED', pack.id, 'pay_w1');
    expect(pago.status).toBe(200);
    expect(pago.body).toMatchObject({ handled: true, pack_id: pack.id });
    expect(await creditos(ID.webhook, 'avisos')).toEqual({ n: 1, qty: 200 });

    await enviar('PAYMENT_RECEIVED', pack.id, 'pay_w1');
    await enviar('PAYMENT_CONFIRMED', pack.id, 'pay_w1');
    expect(await creditos(ID.webhook, 'avisos')).toEqual({ n: 1, qty: 200 });
    expect((await saldo(ID.webhook, 'avisos')).total).toBe(100 + 200);
  });
});

describe('cota antiga de marketing (activePacksQty)', () => {
  const quota = require('../src/services/marketing/marketingQuota');

  test('pacote de avisos ou da Aurinha nao mexe na cota antiga de marketing', async () => {
    const antes = await quota.activePacksQty(ID.semAsaas);
    await pacotes.criarPacote(ID.semAsaas, { bucket: 'avisos', status: 'active', source: 'admin' });
    await pacotes.criarPacote(ID.semAsaas, { bucket: 'aurinha', status: 'active', source: 'admin' });
    expect(await quota.activePacksQty(ID.semAsaas)).toBe(antes);
  });

  test('pacote de novidades soma na cota antiga e vale 60 dias', async () => {
    const antes = await quota.activePacksQty(ID.semAsaas);
    const pack = await pacotes.criarPacote(ID.semAsaas, { bucket: 'novidades', status: 'active', source: 'admin' });
    expect(await quota.activePacksQty(ID.semAsaas)).toBe(antes + 100);
    const { rows } = await q(`SELECT (valid_until - CURRENT_DATE)::int AS dias FROM wa_marketing_packs WHERE id = $1`, [pack.id]);
    expect(rows[0].dias).toBe(60);
  });
});
