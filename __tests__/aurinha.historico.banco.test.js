// ============================================================
// AURA. — Histórico da coexistência no hub da Aura — Postgres real
//
// O teste em memória (aurinha.historico.test.js) cobre as regras; este
// trava o SQL de verdade (migrations 312/375):
//   - unnest em lote com timestamptz[] e metadata::jsonb grava com a data
//     original da Meta e o autor certo (CHECK de author/direction);
//   - ON CONFLICT no índice parcial de hub_messages: a mesma entrega duas
//     vezes não duplica;
//   - GREATEST com NULL: fala antiga não volta o relógio da conversa, e
//     conversa só com fala da empresa fica sem last_inbound_at;
//   - pelo webhook, com a Aurinha LIGADA: nenhum evento, nada na wa_outbox
//     e nada aguardando resposta.
// Fixtures com uuid próprio, apagadas no afterAll.
// ============================================================
'use strict';

process.env.WA_VERIFY_TOKEN = 'verify-test';
process.env.WA_APP_SECRET = 'secret-test-hist-banco';

jest.mock('../src/services/whatsapp', () => ({ sendTemplate: jest.fn(), sendText: jest.fn() }));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const userId = uuid();
const companyId = uuid();
const PN = `PN-HIST-${companyId.slice(0, 8)}`;
const EMPRESA = '5511956305269';
const MARINA = '5511988880001';
const JOAO = '5521977770002';

let pool;
let hubWhatsapp;
const q = (sql, params) => pool.query(sql, params);

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 4 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  hubWhatsapp = require('../src/services/hubWhatsapp');

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Hist')`,
    [userId, `fixture-${userId}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Hist')`, [companyId, userId]);
  await q(`INSERT INTO hub_agent_settings (company_id, enabled, approval_mode, wa_phone_number_id)
           VALUES ($1, true, false, $2)`, [companyId, PN]);
});

afterAll(async () => {
  if (!pool) return;
  delete process.env.AURA_COMPANY_ID;
  await new Promise((r) => setTimeout(r, 200));
  const limpar = [
    [`DELETE FROM wa_outbox WHERE company_id = $1`, [companyId]],
    [`DELETE FROM hub_agent_events WHERE company_id = $1`, [companyId]],
    [`DELETE FROM hub_messages WHERE company_id = $1`, [companyId]],
    [`DELETE FROM hub_conversations WHERE company_id = $1`, [companyId]],
    [`DELETE FROM hub_agent_settings WHERE company_id = $1`, [companyId]],
    [`DELETE FROM companies WHERE id = $1`, [companyId]],
    [`DELETE FROM users WHERE id = $1`, [userId]],
  ];
  for (const [sql, params] of limpar) {
    try { await q(sql, params); } catch (e) { /* banco de CI é descartável */ }
  }
  await pool.end();
});

const ts = (iso) => String(Math.floor(new Date(iso).getTime() / 1000));
const msg = (id, from, iso, texto, extra = {}) => ({
  id, from, timestamp: ts(iso), type: 'text', text: { body: texto }, ...extra,
});
const valor = (threads) => ({
  messaging_product: 'whatsapp',
  metadata: { phone_number_id: PN, display_phone_number: EMPRESA },
  history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads }],
});

const mensagens = (tel) => q(
  `SELECT m.external_message_id, m.direction, m.author, m.content, m.created_at, m.metadata
     FROM hub_messages m JOIN hub_conversations c ON c.id = m.conversation_id
    WHERE c.company_id = $1 AND c.external_id = $2
    ORDER BY m.created_at`, [companyId, tel]).then((r) => r.rows);
const conversa = (tel) => q(
  `SELECT * FROM hub_conversations WHERE company_id = $1 AND channel = 'whatsapp' AND external_id = $2`,
  [companyId, tel]).then((r) => r.rows[0]);

describe('registrarHistorico — Postgres real', () => {
  it('grava em lote com autor e data originais; repetir não duplica', async () => {
    const v = valor([
      { id: MARINA, messages: [
        msg('wamid.HB1', MARINA, '2026-06-02T13:00:00Z', 'Oi, a Aura emite NFC-e?'),
        msg('wamid.HB2', EMPRESA, '2026-06-02T13:05:00Z', 'Emite sim!', { to: MARINA }),
        msg('wamid.HB3', MARINA, '2026-06-02T13:07:00Z', 'Quero ver'),
      ] },
      { id: JOAO, messages: [msg('wamid.HB4', EMPRESA, '2026-07-10T18:00:00Z', 'Oi João', { to: JOAO })] },
    ]);
    const r1 = await hubWhatsapp.registrarHistorico({ companyId }, v, { lote: 2 });
    expect(r1).toMatchObject({ ok: true, conversas: 2, gravadas: 4, duplicadas: 0 });

    const ms = await mensagens(MARINA);
    expect(ms.map((m) => [m.external_message_id, m.direction, m.author])).toEqual([
      ['wamid.HB1', 'inbound', 'cliente'],
      ['wamid.HB2', 'outbound', 'humano'],
      ['wamid.HB3', 'inbound', 'cliente'],
    ]);
    expect(new Date(ms[0].created_at).toISOString()).toBe('2026-06-02T13:00:00.000Z');
    expect(ms[0].metadata).toMatchObject({ source: 'history', type: 'text' });

    const c = await conversa(MARINA);
    expect(new Date(c.last_inbound_at).toISOString()).toBe('2026-06-02T13:07:00.000Z');
    expect(new Date(c.ultima_mensagem_humana_em).toISOString()).toBe('2026-06-02T13:05:00.000Z');
    expect(c.aguardando_resposta_desde).toBeNull();
    expect((await conversa(JOAO)).last_inbound_at).toBeNull();

    const r2 = await hubWhatsapp.registrarHistorico({ companyId }, v, { lote: 2 });
    expect(r2).toMatchObject({ ok: true, gravadas: 0, duplicadas: 4 });
    expect(await mensagens(MARINA)).toHaveLength(3);
  });

  it('fala antiga não volta o relógio de uma conversa mais nova', async () => {
    await q(`UPDATE hub_conversations SET last_inbound_at = '2026-11-20T12:00:00Z', last_message_at = '2026-11-20T12:00:00Z'
              WHERE company_id = $1 AND external_id = $2`, [companyId, MARINA]);
    await hubWhatsapp.registrarHistorico({ companyId },
      valor([{ id: MARINA, messages: [msg('wamid.HB5', MARINA, '2026-05-01T10:00:00Z', 'bem antiga')] }]));
    const c = await conversa(MARINA);
    expect(new Date(c.last_inbound_at).toISOString()).toBe('2026-11-20T12:00:00.000Z');
    expect(new Date(c.last_message_at).toISOString()).toBe('2026-11-20T12:00:00.000Z');
  });
});

describe('webhook history — número da Aura com a Aurinha ligada', () => {
  function webhookApp() {
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use('/webhooks/whatsapp', require('../src/routes/webhookWhatsapp'));
    return app;
  }
  const sign = (body) => 'sha256=' + crypto.createHmac('sha256', 'secret-test-hist-banco')
    .update(Buffer.from(JSON.stringify(body), 'utf8')).digest('hex');

  it('grava a conversa e não dispara evento, fila nem espera', async () => {
    process.env.AURA_COMPANY_ID = companyId;
    const CLIENTE = '5511966660003';
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA-HIST', changes: [{ field: 'history', value: valor([
        { id: CLIENTE, messages: [msg('wamid.HB9', CLIENTE, new Date(Date.now() - 60000).toISOString(), 'Oi, alguém aí?')] },
      ]) }] }],
    };
    const res = await request(webhookApp()).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(body)).send(body);
    expect(res.status).toBe(200);

    let ms = [];
    for (let i = 0; i < 40 && !ms.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      ms = await mensagens(CLIENTE);
    }
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ author: 'cliente', direction: 'inbound' });
    expect((await conversa(CLIENTE)).aguardando_resposta_desde).toBeNull();
    const { rows: ev } = await q(`SELECT 1 FROM hub_agent_events WHERE company_id = $1`, [companyId]);
    const { rows: out } = await q(`SELECT 1 FROM wa_outbox WHERE company_id = $1`, [companyId]);
    expect(ev).toHaveLength(0);
    expect(out).toHaveLength(0);
  });
});
