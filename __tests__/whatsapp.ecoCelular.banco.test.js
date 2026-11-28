// ============================================================
// AURA. — WhatsApp · eco do celular (coexistência) até as Conversas — Postgres real
//
// Ponta a ponta: webhook assinado (HMAC) com change.field 'smb_message_echoes'
// → routes/webhookWhatsapp → hubWhatsapp.registrarEcho → hub_conversations /
// hub_messages → GET /companies/:id/hub/conversations/:convId/messages (hubSocial).
//
//  1. eco para telefone SEM conversa cria a conversa da loja certa (pelo
//     phone_number_id) e o texto aparece na thread;
//  2. segundo eco para o mesmo telefone cai na MESMA conversa;
//  3. eco reentregue (mesmo id) não duplica na thread;
//  4. eco de mensagem da própria fila (wa_outbox) não vira mensagem humana
//     nem abre conversa;
//  5. com WA_HUB_LOJAS_LIGADO desligado nada vai ao hub — só wa_messages.
//
// companies.wa_phone_number_id e wa_messages vêm de src/migrations/039, fora
// do diretório que o CI aplica: o teste cria os dois (IF NOT EXISTS), igual
// ao banco de produção. Fixtures com uuid próprio, apagadas no afterAll.
// ============================================================
'use strict';

process.env.WA_VERIFY_TOKEN = 'verify-test';
process.env.WA_APP_SECRET = 'secret-test-eco-celular';

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

const ID = { dono: uuid(), loja: uuid(), outra: uuid() };
const PN = `PN-ECO-${ID.loja.slice(0, 8)}`;
const PN_OUTRA = `PN-ECO-${ID.outra.slice(0, 8)}`;
const EMPRESA = '5511956305269';
const CLIENTE = '5511988880001';
const CLIENTE_2 = '5521977770002';
const CLIENTE_OFF = '5531966660003';
const CLIENTE_FILA = '5541955550004';

let pool;
let webhookApp;
let hubApp;
const q = (sql, params) => pool.query(sql, params);

const assinar = (body) => 'sha256=' + crypto.createHmac('sha256', 'secret-test-eco-celular')
  .update(JSON.stringify(body)).digest('hex');

// O webhook responde 200 e processa depois: espera a condição aparecer.
async function esperar(fn, { tentativas = 60, passo = 50 } = {}) {
  for (let i = 0; i < tentativas; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, passo));
  }
  return fn();
}

let seq = 0;
function eco(id, para, texto, extra = {}) {
  return {
    from: EMPRESA, to: para, id, type: 'text', text: { body: texto },
    timestamp: String(Math.floor(Date.now() / 1000) + (seq++)),
    ...extra,
  };
}

async function enviarEco(echoes, phoneNumberId = PN) {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA-ECO',
      changes: [{
        field: 'smb_message_echoes',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: phoneNumberId, display_phone_number: EMPRESA },
          message_echoes: echoes,
        },
      }],
    }],
  };
  const res = await request(webhookApp).post('/webhooks/whatsapp')
    .set('x-hub-signature-256', assinar(body))
    .set('content-type', 'application/json')
    .send(JSON.stringify(body));
  expect(res.status).toBe(200);
}

const conversas = (loja, tel) => q(
  `SELECT * FROM hub_conversations WHERE company_id = $1 AND channel = 'whatsapp' AND external_id = $2`,
  [loja, tel]).then((r) => r.rows);
const waMsgs = (tel) => q(
  `SELECT * FROM wa_messages WHERE company_id = $1 AND to_phone = $2`, [ID.loja, tel]).then((r) => r.rows);
const thread = async (convId, loja = ID.loja) => {
  const res = await request(hubApp).get(`/companies/${loja}/hub/conversations/${convId}/messages`);
  expect(res.status).toBe(200);
  return res.body.messages;
};

async function limpar() {
  const lojas = [ID.loja, ID.outra];
  const passos = [
    [`DELETE FROM hub_agent_events WHERE company_id = ANY($1)`, [lojas]],
    [`DELETE FROM hub_messages WHERE company_id = ANY($1)`, [lojas]],
    [`DELETE FROM hub_conversations WHERE company_id = ANY($1)`, [lojas]],
    [`DELETE FROM wa_messages WHERE company_id = ANY($1)`, [lojas]],
    [`DELETE FROM wa_outbox WHERE company_id = ANY($1)`, [lojas]],
    [`DELETE FROM wa_contacts WHERE company_id = ANY($1)`, [lojas]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [lojas]],
    [`DELETE FROM users WHERE id = $1`, [ID.dono]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco de CI é descartável */ }
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 4 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));

  // Schema de src/migrations/039 (não aplicado pelo CI).
  await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_phone_number_id VARCHAR(50)`);
  await q(`CREATE TABLE IF NOT EXISTS wa_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL DEFAULT 'outbound',
    wa_message_id VARCHAR(100), to_phone VARCHAR(20), from_phone VARCHAR(20),
    template_name VARCHAR(100), content TEXT, status VARCHAR(20) DEFAULT 'sent',
    error_message TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW())`);

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Eco')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, wa_phone_number_id)
           VALUES ($1, $3, 'Fixture Eco Loja', $4), ($2, $3, 'Fixture Eco Outra', $5)`,
    [ID.loja, ID.outra, ID.dono, PN, PN_OUTRA]);

  webhookApp = express();
  webhookApp.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  webhookApp.use('/webhooks/whatsapp', require('../src/routes/webhookWhatsapp'));

  hubApp = express();
  hubApp.use(express.json());
  hubApp.use('/companies/:id/hub',
    (req, _res, next) => { req.user = { id: ID.dono }; next(); },
    require('../src/routes/hubSocial'));
});

afterAll(async () => {
  delete process.env.WA_HUB_LOJAS_LIGADO;
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 200));
  await limpar();
  await pool.end();
});

beforeEach(() => {
  delete process.env.AURA_COMPANY_ID; // sem tenant da Aura: só o fluxo das lojas
});

describe('eco do celular → Conversas da loja (WA_HUB_LOJAS_LIGADO=1)', () => {
  beforeAll(() => { process.env.WA_HUB_LOJAS_LIGADO = '1'; });

  it('telefone sem conversa: cria a conversa da loja certa e o texto aparece na thread', async () => {
    expect(await conversas(ID.loja, CLIENTE)).toHaveLength(0);

    await enviarEco([eco('wamid.ECO1', CLIENTE, 'Oi, já separei o seu pedido')]);
    const convs = await esperar(async () => {
      const c = await conversas(ID.loja, CLIENTE);
      return c.length ? c : null;
    });
    expect(convs).toHaveLength(1);
    expect(convs[0].company_id).toBe(ID.loja);
    expect(convs[0].ultima_mensagem_humana_em).not.toBeNull();

    // nada vazou para a outra loja
    expect(await conversas(ID.outra, CLIENTE)).toHaveLength(0);

    const msgs = await esperar(async () => {
      const t = await thread(convs[0].id);
      return t.length ? t : null;
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: 'outbound', author: 'humano', content: 'Oi, já separei o seu pedido' });

    // a tela abre a conversa de outra loja? não.
    const outra = await request(hubApp).get(`/companies/${ID.outra}/hub/conversations/${convs[0].id}/messages`);
    expect(outra.status).toBe(404);
  });

  it('segundo eco para o mesmo telefone cai na MESMA conversa', async () => {
    await enviarEco([eco('wamid.ECO2', CLIENTE, 'Pode vir buscar hoje')]);
    const [conv] = await conversas(ID.loja, CLIENTE);
    const msgs = await esperar(async () => {
      const t = await thread(conv.id);
      return t.length >= 2 ? t : null;
    });
    expect(await conversas(ID.loja, CLIENTE)).toHaveLength(1);
    expect(msgs.map((m) => m.content)).toEqual(['Oi, já separei o seu pedido', 'Pode vir buscar hoje']);
  });

  it('eco reentregue (mesmo id) não duplica a mensagem', async () => {
    const [conv] = await conversas(ID.loja, CLIENTE);
    const antes = (await thread(conv.id)).length;
    // reentrega do ECO2 e, na mesma chamada, um eco novo (marcador de que o lote foi processado)
    await enviarEco([eco('wamid.ECO2', CLIENTE, 'Pode vir buscar hoje'), eco('wamid.ECO3', CLIENTE, 'Até já')]);
    await esperar(async () => (await thread(conv.id)).length > antes);
    const msgs = await thread(conv.id);
    expect(msgs.map((m) => m.content)).toEqual(['Oi, já separei o seu pedido', 'Pode vir buscar hoje', 'Até já']);
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM hub_messages WHERE company_id = $1 AND external_message_id = 'wamid.ECO2'`, [ID.loja]);
    expect(rows[0].n).toBe(1);
  });

  it('eco de mensagem enviada pela fila da API não vira mensagem humana nem abre conversa', async () => {
    await q(`INSERT INTO wa_outbox (company_id, to_phone, kind, text_body, status, wa_message_id)
             VALUES ($1, $2, 'text', 'Lembrete da fila', 'sent', 'wamid.FILA1')`, [ID.loja, CLIENTE_FILA]);

    // marcador: um eco humano de outro telefone no mesmo lote prova que o lote foi processado
    await enviarEco([eco('wamid.FILA1', CLIENTE_FILA, 'Lembrete da fila'), eco('wamid.ECO4', CLIENTE_2, 'Marcador')]);
    await esperar(async () => (await conversas(ID.loja, CLIENTE_2)).length);

    expect(await conversas(ID.loja, CLIENTE_FILA)).toHaveLength(0);
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM hub_messages WHERE company_id = $1 AND external_message_id = 'wamid.FILA1'`, [ID.loja]);
    expect(rows[0].n).toBe(0);
    expect(await conversas(ID.loja, CLIENTE_2)).toHaveLength(1);
  });
});

describe('eco do celular com WA_HUB_LOJAS_LIGADO desligado', () => {
  beforeAll(() => { delete process.env.WA_HUB_LOJAS_LIGADO; });

  it('nada é criado no hub; só wa_messages', async () => {
    await enviarEco([eco('wamid.OFF1', CLIENTE_OFF, 'Sem hub')]);
    const linhas = await esperar(async () => {
      const r = await waMsgs(CLIENTE_OFF);
      return r.length ? r : null;
    });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ direction: 'outbound', content: 'Sem hub', wa_message_id: 'wamid.OFF1' });
    expect(linhas[0].metadata).toMatchObject({ source: 'smb_app' });

    expect(await conversas(ID.loja, CLIENTE_OFF)).toHaveLength(0);
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM hub_messages WHERE company_id = $1 AND external_message_id = 'wamid.OFF1'`, [ID.loja]);
    expect(rows[0].n).toBe(0);
  });
});
