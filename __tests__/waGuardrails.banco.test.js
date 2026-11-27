// ============================================================
// AURA. — Guardrails de custo do WhatsApp — Postgres real (27/11/2026)
//
// A Aura paga a Meta por cada modelo (template) enviado. Este arquivo e a
// PROVA, com WA_SALDO_ATIVO ligado, de que nenhum template sai fora do
// controle. A unica coisa simulada e a Graph API (o fetch da Meta): cada
// chamada e contada, e a prova e que o numero de templates aceitos pela
// Meta nunca passa do saldo (debito liquido no livro-razao).
//
//   a) reserva na mesma transacao do INSERT: concorrencia com conexoes reais
//   b) saldo esgotado: nada enfileira, motivo gravado
//   c) automatica nao passa da parte (4/4/2), nem com dois "enviar agora"
//   d) pacote so soma depois do pagamento, uma vez so
//   e) conversa fechada: convite UTILITY gasta 1 aviso; sessao recusada
//   f) todos os caminhos: teste, envio direto, despacho, retry, dedupe
//   g) teto diario e teto por contato; pix_sessao e excecao documentada
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
process.env.ASAAS_WEBHOOK_SECRET = 'segredo-guardrails';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => next(),
  requireCompanyAccess: () => (req, _res, next) => next(),
  requirePlan: () => (req, _res, next) => next(),
  requireRole: () => (req, _res, next) => next(),
}));
jest.mock('../src/services/aurinhaAgent', () => ({
  responderSuporte: jest.fn(async () => ({ texto: 'Oi de novo, aqui e a Aurinha.' })),
}));
jest.mock('../src/services/asaasClient', () => ({
  asaasRequest: jest.fn(async () => ({ id: 'pay_guard', invoiceUrl: 'https://asaas.test/i/g' })),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN = process.env.SUPABASE_DB_URL || 'postgresql://aura_test:aura_test@localhost:5432/aura_test';
jest.setTimeout(90000);

const ID = {
  dono: uuid(),
  corrida: uuid(), corrida10: uuid(), auto: uuid(), autoPouco: uuid(), pacote: uuid(),
  convite: uuid(), teste: uuid(), despacho: uuid(), dedupe: uuid(), origem: uuid(),
  aurinha: uuid(), teto: uuid(), contato: uuid(), desligado: uuid(),
  retry: uuid(), lock: uuid(), categoria: uuid(), aurinhaSkip: uuid(),
};
const EMPRESAS = Object.keys(ID).filter((k) => k !== 'dono').map((k) => ID[k]);

let pool;
let db;
let waSaldo;
let waOutbox;
let seq = 0;
const q = (sql, params) => pool.query(sql, params);
const fone = () => `5511977${String(++seq).padStart(6, '0')}`;

// ── A Meta, simulada: conta cada chamada ─────────────────────
// `falhas[companyId]` faz a proxima chamada DAQUELA loja cair (rede) ou
// voltar erro da Graph. So o que a Meta ACEITOU conta como enviado.
const meta = { chamadas: [], falhas: {} };
function metaFetch(url, opts = {}) {
  const u = String(url);
  let body = null;
  try { body = opts.body ? JSON.parse(opts.body) : null; } catch (_) { body = null; }
  const chamada = { url: u, body, aceita: false };
  meta.chamadas.push(chamada);
  const pn = (u.match(/\/pn_([0-9a-f-]{36})\//) || [])[1];
  const fila = pn && meta.falhas[pn];
  const falha = fila && fila.length ? fila.shift() : null;
  if (falha === 'rede') return Promise.reject(new TypeError('fetch failed'));
  if (falha && falha.code) {
    return Promise.resolve({ status: 400, json: async () => ({ error: { message: 'erro da Meta', code: falha.code } }) });
  }
  chamada.aceita = true;
  return Promise.resolve({ status: 200, json: async () => ({ messages: [{ id: `wamid.G${meta.chamadas.length}` }] }) });
}
const doPn = (companyId) => (c) => c.url.includes(`/pn_${companyId}/messages`);
const templatesAceitos = (companyId) => meta.chamadas
  .filter((c) => doPn(companyId)(c) && c.aceita && c.body && c.body.type === 'template').length;
const chamadasDa = (companyId) => meta.chamadas.filter(doPn(companyId)).length;

// Debito liquido do livro-razao (consumo - estorno) de um saldo.
async function debito(companyId, bucket = null) {
  const { rows } = await q(
    `SELECT COALESCE(-SUM(qty), 0)::int AS n FROM wa_saldo_lancamentos
      WHERE company_id = $1 AND kind IN ('consumo','estorno') AND ($2::text IS NULL OR bucket = $2)
        AND ref_key NOT LIKE 'seed:%'`,
    [companyId, bucket]
  );
  return rows[0].n;
}
const restante = async (companyId, bucket) => (await waSaldo.getSaldos(companyId)).saldos[bucket].restante;

async function linhas(companyId, where = 'TRUE', params = []) {
  const { rows } = await q(
    `SELECT id, status, skip_reason, source_type, dedupe_key, kind FROM wa_outbox
      WHERE company_id = $1 AND ${where} ORDER BY created_at`, [companyId, ...params]);
  return rows;
}

// Deixa N mensagens livres num saldo (gasta o resto da franquia do mes).
async function deixar(companyId, bucket, n) {
  const total = waSaldo.FRANQUIA_MENSAL[bucket];
  if (total - n <= 0) return;
  await q(
    `INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, periodo, ref_key)
     SELECT $1::uuid, $2::text, 'consumo', 'franquia', -1, $3::date, 'seed:' || $2::text || ':' || g || ':' || $1::text
       FROM generate_series(1, $4::int) g`,
    [companyId, bucket, waSaldo.periodoDe(), total - n]
  );
}
async function creditarPacote(companyId, bucket, qty) {
  await q(`INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, ref_key)
           VALUES ($1, $2, 'pacote', 'pacote', $3, $4)`, [companyId, bucket, qty, `pacote:${uuid()}`]);
}
async function modelo(companyId, name, category = 'UTILITY') {
  await q(`INSERT INTO wa_templates (company_id, name, language, status, category)
           VALUES ($1, $2, 'pt_BR', 'APPROVED', $3) ON CONFLICT (company_id, name, language) DO NOTHING`,
    [companyId, name, category]);
}

const aviso = (companyId, extra = {}) => waOutbox.enqueue({
  companyId, toPhone: fone(), kind: 'template', templateName: 'parcela_lembrete',
  sourceType: 'crediario', sourceId: `g-${seq}`, ...extra,
});
const despachar = () => waOutbox.processBatch(500);

async function limpar() {
  for (const sql of [
    'DELETE FROM wa_saldo_lancamentos WHERE company_id = ANY($1)',
    'DELETE FROM wa_messages WHERE company_id = ANY($1)',
    'DELETE FROM hub_messages WHERE company_id = ANY($1)',
    'DELETE FROM hub_agent_events WHERE company_id = ANY($1)',
    'DELETE FROM wa_outbox WHERE company_id = ANY($1)',
    'DELETE FROM hub_conversations WHERE company_id = ANY($1)',
    'DELETE FROM wa_marketing_log WHERE company_id = ANY($1)',
    'DELETE FROM wa_contacts WHERE company_id = ANY($1)',
    'DELETE FROM wa_templates WHERE company_id = ANY($1)',
    'DELETE FROM wa_automaticas WHERE company_id = ANY($1)',
    'DELETE FROM wa_marketing_packs WHERE company_id = ANY($1)',
    'DELETE FROM webhook_logs WHERE company_id = ANY($1)',
    'DELETE FROM alert_history WHERE company_id = ANY($1)',
    'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))',
    'DELETE FROM sales WHERE company_id = ANY($1)',
    'DELETE FROM products WHERE company_id = ANY($1)',
    'DELETE FROM customers WHERE company_id = ANY($1)',
    'DELETE FROM companies WHERE id = ANY($1)',
  ]) {
    try { await q(sql, [EMPRESAS]); } catch (_) { /* banco descartavel */ }
  }
  try { await q('DELETE FROM users WHERE id = $1', [ID.dono]); } catch (_) { /* idem */ }
}

const ENV_ANTES = {};
const app = express();
app.use(express.json());

beforeAll(async () => {
  for (const k of ['WA_SALDO_ATIVO', 'AURA_COMPANY_ID', 'WA_DAILY_CAP', 'WA_PER_PHONE_DAILY_CAP']) ENV_ANTES[k] = process.env[k];
  process.env.WA_SALDO_ATIVO = '1';
  delete process.env.AURA_COMPANY_ID;
  delete process.env.WA_DAILY_CAP;
  delete process.env.WA_PER_PHONE_DAILY_CAP;

  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 16 });
  db = require('../src/config/database');
  // As colunas de credencial (src/migrations/039) ficam fora das migrations do
  // CI: so as consultas de credencial das NOSSAS lojas sao simuladas. Todo o
  // resto (fila, saldo, guardas) roda no Postgres de verdade.
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    const nossa = params && EMPRESAS.includes(params[0]);
    if (nossa && (s.includes('-- wa:creds') || s.includes('-- hubenvio:creds'))) {
      return Promise.resolve({ rows: [{ wa_phone_number_id: `pn_${params[0]}`, wa_access_token: 'token_guard' }] });
    }
    if (nossa && s.includes('-- hubconvite:loja')) {
      return Promise.resolve({ rows: [{ trade_name: 'Loja Guard', legal_name: 'Loja Guard', wa_phone_display: '11999990000', wa_waba_id: 'waba_guard', has_token: true }] });
    }
    return pool.query(sql, params);
  });
  db.connect.mockImplementation(() => pool.connect());
  global.fetch = jest.fn(metaFetch);

  waSaldo = require('../src/services/waSaldo');
  waOutbox = require('../src/services/waOutbox');
  app.use('/companies/:id', require('../src/routes/whatsappCloud'));
  app.use('/companies/:id/whatsapp', require('../src/routes/whatsappRoutes'));
  app.use('/webhooks/asaas', require('../src/routes/webhookAsaas'));

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Guardrails')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  for (const id of EMPRESAS) {
    await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, wa_marketing_consent_at, asaas_customer_id)
             VALUES ($1, $2, 'Guard Loja', 'Guard Loja', 'negocio', NOW(), 'cus_guard')`, [id, ID.dono]);
    await modelo(id, 'parcela_lembrete');
  }
});

afterAll(async () => {
  for (const [k, v] of Object.entries(ENV_ANTES)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await limpar();
  await pool.end();
});

beforeEach(() => { meta.falhas = {}; });

// ── a) ──────────────────────────────────────────────────────
describe('a) reserva na mesma transacao do INSERT na fila', () => {
  test('dois envios ao mesmo tempo com o ultimo aviso: um entra, o outro fica SALDO_ESGOTADO, a Meta recebe 1', async () => {
    await deixar(ID.corrida, 'avisos', 1);
    const [r1, r2] = await Promise.all([aviso(ID.corrida), aviso(ID.corrida)]);
    const rs = [r1, r2];
    expect(rs.filter((r) => r.queued)).toHaveLength(1);
    expect(rs.filter((r) => !r.queued)).toEqual([expect.objectContaining({ status: 'skipped', reason: 'SALDO_ESGOTADO' })]);
    expect(await debito(ID.corrida, 'avisos')).toBe(1);
    expect(await restante(ID.corrida, 'avisos')).toBe(0);
    await despachar();
    expect(templatesAceitos(ID.corrida)).toBe(1);
  });

  test('dez ao mesmo tempo com 3 livres e dois despachos em paralelo: exatamente 3 templates na Meta', async () => {
    await deixar(ID.corrida10, 'avisos', 3);
    const rs = await Promise.all(Array.from({ length: 10 }, () => aviso(ID.corrida10)));
    expect(rs.filter((r) => r.queued)).toHaveLength(3);
    expect(rs.filter((r) => r.reason === 'SALDO_ESGOTADO')).toHaveLength(7);
    await Promise.all([despachar(), despachar()]);
    expect(templatesAceitos(ID.corrida10)).toBe(3);
    expect(chamadasDa(ID.corrida10)).toBe(3);
    expect(await debito(ID.corrida10, 'avisos')).toBe(3);
  });
});

// ── b) ──────────────────────────────────────────────────────
describe('b) saldo esgotado', () => {
  test('nada entra na fila, o motivo fica gravado e nada vai a Meta', async () => {
    const antes = chamadasDa(ID.corrida);
    const r = await aviso(ID.corrida);
    expect(r).toMatchObject({ queued: false, status: 'skipped', reason: 'SALDO_ESGOTADO' });
    const [row] = await linhas(ID.corrida, 'id = $2', [r.id]);
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'SALDO_ESGOTADO' });
    expect(await linhas(ID.corrida, `status = 'pending'`)).toHaveLength(0);
    await despachar();
    expect(chamadasDa(ID.corrida)).toBe(antes);
    expect(await debito(ID.corrida, 'avisos')).toBe(1);
  });
});

// ── c) ──────────────────────────────────────────────────────
describe('c) automatica nao passa da parte dela (4/4/2)', () => {
  const executor = () => require('../src/services/waAutomaticas/executor');

  async function clientesSumindo(companyId, n) {
    // Venda+ cita a peca da ultima compra: sem ela o cliente fica de fora (#1145).
    const produto = (await q(`INSERT INTO products (company_id, name, price) VALUES ($1, 'Blusa de linho', 120) RETURNING id`,
      [companyId])).rows[0].id;
    for (let i = 0; i < n; i++) {
      const cli = (await q(`INSERT INTO customers (company_id, name, phone, total_spent, is_active, last_purchase_at)
               VALUES ($1, $2, $3, $4, true, NOW() - INTERVAL '40 days') RETURNING id`,
        [companyId, `Cliente ${i}`, fone(), 1000 - i])).rows[0].id;
      const venda = (await q(`INSERT INTO sales (company_id, customer_id, total_amount, status, created_at)
               VALUES ($1, $2, 120, 'completed', NOW() - INTERVAL '40 days') RETURNING id`, [companyId, cli])).rows[0].id;
      await q(`INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price) VALUES ($1, $2, 1, 120, 120)`,
        [venda, produto]);
    }
  }
  async function prepararVendaMais(companyId) {
    await modelo(companyId, 'aura_venda_sumindo_sem', 'MARKETING');
    await q(`INSERT INTO wa_automaticas (company_id, automatica, ligada, config)
             VALUES ($1, 'venda_mais', true, '{"segmento":"sumindo","presente":null}'::jsonb)`, [companyId]);
  }

  test('dois "enviar agora" ao mesmo tempo: a parte de Venda+ (4) nao passa, nem na fila nem na Meta', async () => {
    await prepararVendaMais(ID.auto);
    await clientesSumindo(ID.auto, 9);
    const [a, b] = await Promise.all([
      executor().rodar(ID.auto, 'venda_mais', { ignorarLigada: true }),
      executor().rodar(ID.auto, 'venda_mais', { ignorarLigada: true }),
    ]);
    if (a.enfileiradas + b.enfileiradas !== 4) {
      const publico = require('../src/services/waAutomaticas/publico');
      const auto = require('../src/services/waAutomaticas/automaticas');
      const previa = await executor().previa(ID.auto, 'venda_mais').catch((e) => ({ erro: e.message }));
      const brutos = (await q(`SELECT last_purchase_at, NOW() AS agora, current_setting('TimeZone') AS tz,
        ($2::date - last_purchase_at::date) AS dias FROM customers WHERE company_id = $1 LIMIT 2`, [ID.auto, publico.hojeBRT()])).rows;
      console.log('DIAG-AUTO', JSON.stringify({
        a, b, hoje: publico.hojeBRT(), brutos,
        cands: (await publico.candidatosVendaMais(ID.auto, 'sumindo', publico.hojeBRT())).length,
        divisao: await auto.lerDivisao(ID.auto), usadas: await auto.usadasNoMes(ID.auto),
        linhas: [...(await auto.lerLinhas(ID.auto)).values()],
        previa: { elegiveis: previa.elegiveis, cabem: previa.cabem, fora: previa.fora, erro: previa.erro },
        saldo: (await waSaldo.getSaldos(ID.auto)).saldos.novidades,
      }));
    }
    expect(a.enfileiradas + b.enfileiradas).toBe(4);
    expect(await linhas(ID.auto, `source_type = 'venda_mais' AND status = 'pending'`)).toHaveLength(4);
    expect(await debito(ID.auto, 'novidades')).toBe(4);
    // uma terceira rodada nao acha mais nada na parte
    const c = await executor().rodar(ID.auto, 'venda_mais', { ignorarLigada: true });
    expect(c.enfileiradas).toBe(0);
    await despachar();
    expect(templatesAceitos(ID.auto)).toBe(4);
    expect(await restante(ID.auto, 'novidades')).toBe(6);
  });

  test('parte (4) maior que o saldo de novidades (2): para no saldo', async () => {
    await q('UPDATE companies SET wa_marketing_quota = 2 WHERE id = $1', [ID.autoPouco]);
    await prepararVendaMais(ID.autoPouco);
    await clientesSumindo(ID.autoPouco, 6);
    const r = await executor().rodar(ID.autoPouco, 'venda_mais', { ignorarLigada: true });
    expect(r).toMatchObject({ enfileiradas: 2, parou_por: 'SALDO_ESGOTADO' });
    await despachar();
    expect(templatesAceitos(ID.autoPouco)).toBe(2);
    expect(await restante(ID.autoPouco, 'novidades')).toBe(0);
  });
});

// ── d) ──────────────────────────────────────────────────────
describe('d) pacote so soma depois do pagamento confirmado', () => {
  const pacotes = () => require('../src/services/waSaldoPacotes');
  const webhook = (event, packId, paymentId) => request(app)
    .post('/webhooks/asaas')
    .set('asaas-access-token', 'segredo-guardrails')
    .send({ event, payment: { id: paymentId, externalReference: `wa-pack-${packId}`, customer: 'cus_guard' } });
  const creditos = async () => (await q(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(qty), 0)::int AS qty FROM wa_saldo_lancamentos
      WHERE company_id = $1 AND kind = 'pacote'`, [ID.pacote])).rows[0];

  test('pendente nao credita; pago credita UMA vez com o webhook reenviado; so entao o template sai', async () => {
    await deixar(ID.pacote, 'avisos', 0);
    const pack = await pacotes().criarPacote(ID.pacote, { bucket: 'avisos', qty: 2 });
    expect(pack.status).toBe('pending');
    expect(await aviso(ID.pacote)).toMatchObject({ queued: false, reason: 'SALDO_ESGOTADO' });

    await webhook('PAYMENT_OVERDUE', pack.id, 'pay_d1');
    await webhook('PAYMENT_CREATED', pack.id, 'pay_d1');
    expect((await creditos()).n).toBe(0);

    const rs = await Promise.all([1, 2, 3].map(() => webhook('PAYMENT_RECEIVED', pack.id, 'pay_d1')));
    rs.forEach((r) => expect(r.status).toBe(200));
    await webhook('PAYMENT_CONFIRMED', pack.id, 'pay_d1');
    expect(await creditos()).toEqual({ n: 1, qty: 2 });

    const env = await Promise.all([1, 2, 3].map(() => aviso(ID.pacote)));
    expect(env.filter((r) => r.queued)).toHaveLength(2);
    await despachar();
    expect(templatesAceitos(ID.pacote)).toBe(2);
  });

  test('pacote cancelado nunca credita, mesmo com o pagamento chegando depois', async () => {
    const pack = await pacotes().criarPacote(ID.pacote, { bucket: 'avisos', qty: 5 });
    await q(`UPDATE wa_marketing_packs SET status = 'cancelled' WHERE id = $1`, [pack.id]);
    await webhook('PAYMENT_RECEIVED', pack.id, 'pay_d2');
    expect(await creditos()).toEqual({ n: 1, qty: 2 });
    expect(await aviso(ID.pacote)).toMatchObject({ queued: false, reason: 'SALDO_ESGOTADO' });
  });
});

// ── e) ──────────────────────────────────────────────────────
describe('e) conversa fechada: convite UTILITY gasta 1 aviso; sessao e recusada', () => {
  let convFechada;
  let convAberta;
  const convites = () => require('../src/services/hubConvites');

  beforeAll(async () => {
    await modelo(ID.convite, 'aura_convite_chegou');
    await modelo(ID.convite, 'aura_convite_orcamento');
    const nova = async (horas) => (await q(
      `INSERT INTO hub_conversations (company_id, channel, external_id, customer_name, status, last_inbound_at, last_message_at)
       VALUES ($1, 'whatsapp', $2, 'Bia Souza', 'humano', NOW() - ($3 || ' hours')::interval, NOW())
       RETURNING id`, [ID.convite, fone(), String(horas)])).rows[0].id;
    convFechada = await nova(48);
    convAberta = await nova(1);
    await deixar(ID.convite, 'avisos', 1);
  });

  test('convite gasta 1 aviso; sem aviso o segundo e recusado e nada entra na fila', async () => {
    const r = await convites().enviar({
      companyId: ID.convite, conversationId: convFechada, key: 'chegou',
      campos: { produto: 'o cinto de couro', ate: 'sabado' },
    });
    expect(r.ok).toBe(true);
    expect(await debito(ID.convite, 'avisos')).toBe(1);
    await expect(convites().enviar({
      companyId: ID.convite, conversationId: convFechada, key: 'orcamento',
      campos: { valor: 'R$ 10,00', ate: '03/12' },
    })).rejects.toMatchObject({ code: 'SALDO_ESGOTADO' });
    expect(await linhas(ID.convite, `source_type = 'convite_conversa'`)).toHaveLength(1);
    await despachar();
    expect(templatesAceitos(ID.convite)).toBe(1);
    const sent = meta.chamadas.filter(doPn(ID.convite))[0];
    expect(sent.body.template.name).toBe('aura_convite_chegou');
  });

  test('conversa aberta nao usa convite (responde direto, sem gastar)', async () => {
    await expect(convites().enviar({
      companyId: ID.convite, conversationId: convAberta, key: 'chegou', campos: { produto: 'x', ate: 'y' },
    })).rejects.toMatchObject({ code: 'CONVERSA_ABERTA' });
  });

  test('mensagem de sessao com a janela fechada: recusada no servidor, nada vai a Meta', async () => {
    const antes = chamadasDa(ID.convite);
    const envio = require('../src/services/hubWhatsappEnvio');
    await expect(envio.enviarSessao({ companyId: ID.convite, conversationId: convFechada, tipo: 'link_loja' }))
      .rejects.toMatchObject({ code: 'JANELA_FECHADA' });
    // texto do hub com a janela fechada e sem template: fica parado, nunca despacha
    const h = await waOutbox.enqueueHub({
      companyId: ID.convite, conversationId: convFechada, toPhone: fone(), textBody: 'oi',
      sourceType: 'humano', lastInboundAt: new Date(Date.now() - 48 * 3600000),
    });
    expect(h).toMatchObject({ queued: false, held: true, reason: 'JANELA_FECHADA_SEM_TEMPLATE' });
    // texto da fila comum com a janela fechada: pulado na entrada
    const t = await waOutbox.enqueue({ companyId: ID.convite, toPhone: fone(), kind: 'text', textBody: 'oi', sourceType: 'humano' });
    expect(t).toMatchObject({ queued: false, reason: 'JANELA_FECHADA' });
    await despachar();
    expect(chamadasDa(ID.convite)).toBe(antes);
    expect(await debito(ID.convite, 'avisos')).toBe(1);
  });
});

// ── f) ──────────────────────────────────────────────────────
describe('f) nenhum template sai sem saldo, por nenhum caminho', () => {
  test('envio de TESTE (POST /whatsapp/test-send): gasta 1 aviso; sem saldo, 422 SALDO_ESGOTADO e nada vai a Meta', async () => {
    await deixar(ID.teste, 'avisos', 1);
    const ok = await request(app).post(`/companies/${ID.teste}/whatsapp/test-send`)
      .send({ to: fone(), template_name: 'qualquer_modelo' });
    expect(ok.status).toBe(200);
    expect(ok.body.result.status).toBe('sent');
    expect(templatesAceitos(ID.teste)).toBe(1);
    expect(await debito(ID.teste, 'avisos')).toBe(1);

    const sem = await request(app).post(`/companies/${ID.teste}/whatsapp/test-send`)
      .send({ to: fone(), template_name: 'qualquer_modelo' });
    expect(sem.status).toBe(422);
    expect(sem.body.code).toBe('SALDO_ESGOTADO');
    expect(chamadasDa(ID.teste)).toBe(1);
  });

  test('teste com modelo MARKETING gasta novidade, nao aviso', async () => {
    await modelo(ID.teste, 'promo_teste', 'MARKETING');
    const r = await waOutbox.enqueue({ companyId: ID.teste, toPhone: fone(), templateName: 'promo_teste', sourceType: 'teste' });
    expect(r.queued).toBe(true);
    expect(await debito(ID.teste, 'novidades')).toBe(1);
  });

  test('envio direto pela Graph (POST /whatsapp/send legado): desativado, 410, nada vai a Meta', async () => {
    const antes = meta.chamadas.length;
    for (const body of [{ to: fone(), type: 'template', template_name: 'parcela_lembrete' }, { to: fone(), type: 'text', text: 'oi' }]) {
      const res = await request(app).post(`/companies/${ID.teste}/whatsapp/send`).send(body);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('ENVIO_DIRETO_DESATIVADO');
    }
    expect(meta.chamadas.length).toBe(antes);
  });

  test('linha na fila sem reserva (nasceu com a trava desligada ou INSERT direto): o despacho reserva ou nao envia', async () => {
    await deixar(ID.despacho, 'avisos', 1);
    const inserir = async () => (await q(
      `INSERT INTO wa_outbox (company_id, to_phone, kind, template_name, template_language, status, source_type)
       VALUES ($1, $2, 'template', 'parcela_lembrete', 'pt_BR', 'pending', 'crediario') RETURNING id`,
      [ID.despacho, fone()])).rows[0].id;
    const a = await inserir();
    const b = await inserir();
    await despachar();
    expect(templatesAceitos(ID.despacho)).toBe(1);
    const st = Object.fromEntries((await linhas(ID.despacho)).map((r) => [r.id, r]));
    expect([st[a].status, st[b].status].sort()).toEqual(['sent', 'skipped']);
    expect([st[a].skip_reason, st[b].skip_reason]).toContain('SALDO_ESGOTADO');
    expect(await debito(ID.despacho, 'avisos')).toBe(1);
  });

  test('retry da fila: erro de rede reenvia a MESMA reserva (1 debito); erro permanente devolve', async () => {
    await creditarPacote(ID.despacho, 'avisos', 2);
    const antesDeb = await debito(ID.despacho, 'avisos');
    const antesMeta = templatesAceitos(ID.despacho);
    const r = await aviso(ID.despacho);
    expect(r.queued).toBe(true);
    meta.falhas[ID.despacho] = ['rede'];
    expect(await despachar()).toMatchObject({ retried: 1 });
    await q(`UPDATE wa_outbox SET next_attempt_at = NOW() WHERE id = $1`, [r.id]);
    expect(await despachar()).toMatchObject({ sent: 1 });
    expect(templatesAceitos(ID.despacho)).toBe(antesMeta + 1);
    expect(await debito(ID.despacho, 'avisos')).toBe(antesDeb + 1);

    const p = await aviso(ID.despacho);
    meta.falhas[ID.despacho] = [{ code: 132001 }];
    expect(await despachar()).toMatchObject({ failed: 1 });
    expect((await linhas(ID.despacho, 'id = $2', [p.id]))[0].status).toBe('failed');
    expect(await debito(ID.despacho, 'avisos')).toBe(antesDeb + 1); // reservou e devolveu
    expect(templatesAceitos(ID.despacho)).toBe(antesMeta + 1);
  });

  test('dedupe: recusa por saldo NAO segura a chave (o envio legitimo sai depois do pacote); duplo continua barrado', async () => {
    await deixar(ID.dedupe, 'avisos', 0);
    const dedupeKey = `cred-guard-${uuid()}`;
    const r1 = await aviso(ID.dedupe, { dedupeKey });
    expect(r1).toMatchObject({ queued: false, reason: 'SALDO_ESGOTADO' });
    await creditarPacote(ID.dedupe, 'avisos', 1);
    const r2 = await aviso(ID.dedupe, { dedupeKey });
    expect(r2.queued).toBe(true);
    const [r3, r4] = await Promise.all([aviso(ID.dedupe, { dedupeKey }), aviso(ID.dedupe, { dedupeKey })]);
    expect([r3.reason, r4.reason]).toEqual(['DUPLICADO', 'DUPLICADO']);
    const ls = await linhas(ID.dedupe, `dedupe_key LIKE $2`, [`${dedupeKey}%`]);
    expect(ls).toHaveLength(2);
    expect(ls.find((l) => l.status === 'skipped').dedupe_key).toBe(`${dedupeKey}:recusa:${r1.id}`);
    await despachar();
    expect(templatesAceitos(ID.dedupe)).toBe(1);
    expect(await debito(ID.dedupe, 'avisos')).toBe(1);
  });

  test('dedupe: recusa que nao e de saldo continua segurando a chave (sem duplo)', async () => {
    await creditarPacote(ID.dedupe, 'avisos', 5);
    const dedupeKey = `cred-guard-${uuid()}`;
    const phone = fone();
    await q(`INSERT INTO wa_contacts (company_id, phone, opted_out_at) VALUES ($1, $2, NOW())`, [ID.dedupe, phone]);
    expect(await aviso(ID.dedupe, { dedupeKey, toPhone: phone })).toMatchObject({ reason: 'OPT_OUT' });
    expect(await aviso(ID.dedupe, { dedupeKey, toPhone: phone })).toMatchObject({ reason: 'DUPLICADO' });
  });

  test('origem nova nao registrada gasta aviso (na duvida, gasta); MARKETING gasta novidade', async () => {
    await modelo(ID.origem, 'promo_x', 'MARKETING');
    const u = await waOutbox.enqueue({ companyId: ID.origem, toPhone: fone(), templateName: 'parcela_lembrete', sourceType: 'origem_nova' });
    expect(u.queued).toBe(true);
    expect(await debito(ID.origem, 'avisos')).toBe(1);
    const m = await waOutbox.enqueue({ companyId: ID.origem, toPhone: fone(), templateName: 'promo_x', sourceType: 'origem_nova' });
    expect(m.queued).toBe(true);
    expect(await debito(ID.origem, 'novidades')).toBe(1);
  });

  test('excecao documentada: mensalidade do dojo, otica pronta/adaptacao e placar do dia NAO gastam saldo', async () => {
    for (const sourceType of ['dojo_mensalidade', 'otica_pronta', 'otica_adaptacao', 'placar_dia']) {
      expect(waSaldo.foraDoSaldo(sourceType)).toBe(true);
    }
    const antes = await debito(ID.origem);
    const r = await waOutbox.enqueue({ companyId: ID.origem, toPhone: fone(), templateName: 'parcela_lembrete', sourceType: 'dojo_mensalidade' });
    expect(r.queued).toBe(true);
    expect(await debito(ID.origem)).toBe(antes);
  });

  test('Aurinha: template fora da janela gasta 1 aviso; humano assumiu antes do envio, o aviso volta', async () => {
    await modelo(ID.aurinha, 'aurinha_retomada');
    const conv = (await q(
      `INSERT INTO hub_conversations (company_id, channel, external_id, status, last_inbound_at)
       VALUES ($1, 'whatsapp', $2, 'ia', NOW() - INTERVAL '30 hours') RETURNING id`, [ID.aurinha, fone()])).rows[0].id;
    const r = await waOutbox.enqueueHub({
      companyId: ID.aurinha, conversationId: conv, toPhone: fone(), textBody: 'Oi de novo',
      sourceType: 'aurinha', lastInboundAt: new Date(Date.now() - 30 * 3600000),
      template: { nome: 'aurinha_retomada', idioma: 'pt_BR' },
    });
    expect(r.queued).toBe(true);
    expect(await debito(ID.aurinha, 'avisos')).toBe(1);
    await require('../src/services/hubWhatsapp').marcarRespostaHumana(ID.aurinha, conv, null);
    expect((await linhas(ID.aurinha, 'id = $2', [r.id]))[0]).toMatchObject({ status: 'skipped', skip_reason: 'HUMANO_RESPONDEU' });
    expect(await debito(ID.aurinha, 'avisos')).toBe(0);
    await despachar();
    expect(templatesAceitos(ID.aurinha)).toBe(0);
  });
});

// ── g) ──────────────────────────────────────────────────────
describe('g) teto diario (WA_DAILY_CAP) e teto por contato (WA_PER_PHONE_DAILY_CAP)', () => {
  afterEach(() => { delete process.env.WA_DAILY_CAP; delete process.env.WA_PER_PHONE_DAILY_CAP; });

  test('teto diario: o 4o com WA_DAILY_CAP=3 cai em LIMITE_DIARIO, sem gastar saldo', async () => {
    process.env.WA_DAILY_CAP = '3';
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await aviso(ID.teto));
    expect(rs.map((r) => r.reason)).toEqual([null, null, null, 'LIMITE_DIARIO']);
    expect(await debito(ID.teto, 'avisos')).toBe(3);
    await despachar();
    expect(templatesAceitos(ID.teto)).toBe(3);
  });

  test('teto por contato: o 3o para o mesmo telefone cai em LIMITE_POR_CONTATO; o texto de sessao do Pix e excecao', async () => {
    process.env.WA_PER_PHONE_DAILY_CAP = '2';
    const phone = fone();
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await aviso(ID.contato, { toPhone: phone }));
    expect(rs.map((r) => r.reason)).toEqual([null, null, 'LIMITE_POR_CONTATO']);
    expect(await debito(ID.contato, 'avisos')).toBe(2);
    // cliente tocou "Quero o Pix": janela aberta, resposta de sessao (gratis)
    await q(`INSERT INTO wa_contacts (company_id, phone, last_inbound_at) VALUES ($1, $2, NOW())`, [ID.contato, phone]);
    const pix = await waOutbox.enqueue({ companyId: ID.contato, toPhone: phone, kind: 'text', textBody: 'Pix: 000201...', sourceType: 'pix_sessao_codigo' });
    expect(pix.queued).toBe(true);
    expect(await debito(ID.contato, 'avisos')).toBe(2);
    // pix_sessao como TEMPLATE nao ganha a excecao
    const tpl = await aviso(ID.contato, { toPhone: phone, sourceType: 'pix_sessao_codigo' });
    expect(tpl.reason).toBe('LIMITE_POR_CONTATO');
    await despachar();
    expect(templatesAceitos(ID.contato)).toBe(2);
    expect(meta.chamadas.filter((c) => doPn(ID.contato)(c) && c.body.type === 'text')).toHaveLength(1);
  });
});

// ── erro de banco nao e falta de saldo ─────────────────────
describe('erro de banco no saldo: volta para a fila ou fica gravado, nunca some', () => {
  const inserirSemReserva = async (companyId, sourceType = 'crediario') => (await q(
    `INSERT INTO wa_outbox (company_id, to_phone, kind, template_name, template_language, status, source_type)
     VALUES ($1, $2, 'template', 'parcela_lembrete', 'pt_BR', 'pending', $3) RETURNING id`,
    [companyId, fone(), sourceType])).rows[0].id;
  const linha = async (id) => (await q(
    `SELECT status, skip_reason, attempts, last_error, next_attempt_at > NOW() AS adiada
       FROM wa_outbox WHERE id = $1`, [id])).rows[0];
  const vencer = (id) => q('UPDATE wa_outbox SET next_attempt_at = NOW() WHERE id = $1', [id]);
  const falharConsulta = (marca, companyOuId, erro) => {
    const impl = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => (String(sql).includes(marca) && params && params[0] === companyOuId
      ? Promise.reject(erro)
      : impl(sql, params)));
    return () => db.query.mockImplementation(impl);
  };

  test('a conferencia da reserva cai no despacho: a linha volta para pending (sem pular), depois sai com 1 debito', async () => {
    const id = await inserirSemReserva(ID.retry);
    const restaurar = falharConsulta('-- wa:saldo-despacho-reserva', id,
      Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }));
    try { await despachar(); } finally { restaurar(); }
    expect(await linha(id)).toMatchObject({
      status: 'pending', skip_reason: null, attempts: 0, adiada: true, last_error: 'SALDO_INDISPONIVEL:ECONNRESET',
    });
    expect(chamadasDa(ID.retry)).toBe(0);
    expect(await debito(ID.retry, 'avisos')).toBe(0);
    await vencer(id);
    await despachar();
    expect((await linha(id)).status).toBe('sent');
    expect(templatesAceitos(ID.retry)).toBe(1);
    expect(await debito(ID.retry, 'avisos')).toBe(1);
  });

  test('lock do saldo preso em outra conexao (lock_timeout): volta para pending; solto o lock, sai uma vez', async () => {
    const id = await inserirSemReserva(ID.lock);
    const outra = await pool.connect();
    try {
      await outra.query('BEGIN');
      await outra.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wa_saldo:${ID.lock}:avisos`]);
      await despachar(); // espera os 3 s do lock_timeout do reservarAvulso
    } finally {
      await outra.query('ROLLBACK');
      outra.release();
    }
    expect(await linha(id)).toMatchObject({
      status: 'pending', skip_reason: null, attempts: 0, last_error: 'SALDO_INDISPONIVEL:55P03',
    });
    expect(chamadasDa(ID.lock)).toBe(0);
    await vencer(id);
    await despachar();
    expect((await linha(id)).status).toBe('sent');
    expect(templatesAceitos(ID.lock)).toBe(1);
    expect(await debito(ID.lock, 'avisos')).toBe(1);
  });

  test('falta de saldo de verdade no despacho continua pulando (SALDO_ESGOTADO)', async () => {
    await deixar(ID.lock, 'avisos', 0);
    const id = await inserirSemReserva(ID.lock);
    await despachar();
    expect(await linha(id)).toMatchObject({ status: 'skipped', skip_reason: 'SALDO_ESGOTADO' });
    expect(templatesAceitos(ID.lock)).toBe(1);
  });

  test('erro ao ler a categoria do modelo no enqueue: recusa gravada SALDO_INDISPONIVEL, sem excecao e sem debito', async () => {
    const restaurar = falharConsulta('-- wa:template-categoria', ID.categoria,
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    let r;
    try {
      r = await waOutbox.enqueue({ companyId: ID.categoria, toPhone: fone(), templateName: 'parcela_lembrete', sourceType: 'origem_nova' });
    } finally { restaurar(); }
    expect(r).toMatchObject({ queued: false, status: 'skipped', reason: 'SALDO_INDISPONIVEL' });
    expect((await linhas(ID.categoria, 'id = $2', [r.id]))[0]).toMatchObject({ status: 'skipped', skip_reason: 'SALDO_INDISPONIVEL' });
    expect(await debito(ID.categoria)).toBe(0);
    await despachar();
    expect(chamadasDa(ID.categoria)).toBe(0);
  });

  test('erro ao ler a categoria no despacho: volta para pending, nao pula', async () => {
    const id = await inserirSemReserva(ID.categoria, 'origem_nova');
    const restaurar = falharConsulta('-- wa:template-categoria', ID.categoria,
      Object.assign(new Error('timeout'), { code: '57014' }));
    try { await despachar(); } finally { restaurar(); }
    expect(await linha(id)).toMatchObject({ status: 'pending', attempts: 0, last_error: 'SALDO_INDISPONIVEL:57014' });
    expect(chamadasDa(ID.categoria)).toBe(0);
    await vencer(id);
    await despachar();
    expect((await linha(id)).status).toBe('sent');
    expect(await debito(ID.categoria, 'avisos')).toBe(1);
  });
});

describe('Aurinha: resposta pulada devolve a conversa cobrada', () => {
  test('template fora da janela sem aviso (SALDO_ESGOTADO): a fila pula e a conversa da Aurinha volta', async () => {
    await modelo(ID.aurinhaSkip, 'aurinha_retomada');
    await deixar(ID.aurinhaSkip, 'avisos', 0);
    const conv = (await q(
      `INSERT INTO hub_conversations (company_id, channel, external_id, status, last_inbound_at, aguardando_resposta_desde)
       VALUES ($1, 'whatsapp', $2, 'ia', NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')
       RETURNING id, company_id, external_id, status, last_inbound_at, ultima_mensagem_humana_em, aguardando_resposta_desde`,
      [ID.aurinhaSkip, fone()])).rows[0];
    const aurinhaAntes = await restante(ID.aurinhaSkip, 'aurinha');
    const r = await require('../src/services/hubWhatsapp').avaliarConversa(conv, {
      companyId: ID.aurinhaSkip,
      plantao: { ativo: true, espera_minutos: 0, template: { nome: 'aurinha_retomada', idioma: 'pt_BR' } },
    }, { agora: new Date() });
    expect(r).toMatchObject({ respondeu: false, status: 'skipped', motivo: 'SALDO_ESGOTADO' });
    expect(await restante(ID.aurinhaSkip, 'aurinha')).toBe(aurinhaAntes);
    const { rows } = await q(
      `SELECT COUNT(*) FILTER (WHERE kind = 'consumo')::int AS consumos,
              COUNT(*) FILTER (WHERE kind = 'estorno')::int AS estornos
         FROM wa_saldo_lancamentos WHERE company_id = $1 AND bucket = 'aurinha'`, [ID.aurinhaSkip]);
    expect(rows[0]).toEqual({ consumos: 1, estornos: 1 });
    await despachar();
    expect(chamadasDa(ID.aurinhaSkip)).toBe(0);
  });
});

// ── hoje, com a trava desligada ─────────────────────────────
describe('com WA_SALDO_ATIVO desligado (producao hoje)', () => {
  test('nada e reservado nem barrado pelo saldo; valem as guardas antigas (aqui, o teto por contato)', async () => {
    process.env.WA_SALDO_ATIVO = '0';
    try {
      const phone = fone();
      const rs = [];
      for (let i = 0; i < 3; i++) rs.push(await aviso(ID.desligado, { toPhone: phone }));
      expect(rs.map((r) => r.reason)).toEqual([null, null, 'LIMITE_POR_CONTATO']);
      await despachar();
      expect(templatesAceitos(ID.desligado)).toBe(2);
      expect(await debito(ID.desligado)).toBe(0);
    } finally { process.env.WA_SALDO_ATIVO = '1'; }
  });
});

// ── a prova de conjunto ─────────────────────────────────────
describe('invariante: templates aceitos pela Meta = debito liquido do saldo', () => {
  test('em todas as lojas com a trava ligada, a Meta nunca recebeu template a mais do que o saldo pagou', async () => {
    await despachar();
    // A unica loja com excecao documentada (dojo_mensalidade fora do saldo) e a de origem.
    const excecao = (await linhas(ID.origem, `source_type = 'dojo_mensalidade' AND status = 'sent'`)).length;
    for (const id of EMPRESAS.filter((x) => x !== ID.desligado)) {
      const aceitos = templatesAceitos(id);
      const pago = await debito(id);
      const fora = id === ID.origem ? excecao : 0;
      expect({ loja: id, aceitos: aceitos - fora }).toEqual({ loja: id, aceitos: pago - (await linhas(id, `kind = 'template' AND status = 'pending'`)).length });
    }
  });
});
