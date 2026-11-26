// ============================================================
// AURA — Hub do WhatsApp da Aura: histórico da coexistência e quem
// pode mudar as configurações da Aurinha.
//
// Cobertura (webhook real via supertest, banco fake em memória):
//  (1) change.field 'history' no número da Aura: cada thread vira conversa
//      do hub; fala do contato = cliente (inbound), fala do número da
//      empresa = humano (outbound); datas originais da Meta.
//  (2) nada dispara: sem evento, sem fila, sem aguardando_resposta_desde,
//      mesmo com a Aurinha LIGADA e de noite.
//  (3) idempotente pelo wamid: a mesma entrega duas vezes e o eco já
//      gravado não duplicam.
//  (4) volume: lote por INSERT e teto por chamada.
//  (5) loja (fora do hub) e Aura dormente: só o log de sempre.
//  (6) PUT /hub/settings: só dono ou admin; membro comum recebe 403.
// ============================================================
'use strict';

process.env.WA_VERIFY_TOKEN = 'verify-test';
process.env.WA_APP_SECRET = 'secret-test-hub-hist';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  sendTemplate: jest.fn(),
  sendText: jest.fn(),
}));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const { makeWorld, handler } = require('./helpers/hubFakeDb');
const hubWhatsapp = require('../src/services/hubWhatsapp');

const AURA = '11111111-1111-4111-8111-111111111111';
const EMPRESA = '5511956305269';
const MARINA = '5511988887777';
const JOAO = '5521977776666';

let world;

beforeEach(() => {
  world = makeWorld();
  process.env.AURA_COMPANY_ID = AURA;
  db.query.mockReset();
  db.query.mockImplementation(handler(world));
});

afterEach(() => {
  delete process.env.AURA_COMPANY_ID;
});

function webhookApp() {
  const app = express();
  app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/webhooks/whatsapp', require('../src/routes/webhookWhatsapp'));
  return app;
}
function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', 'secret-test-hub-hist')
    .update(Buffer.from(JSON.stringify(body), 'utf8')).digest('hex');
}
async function postar(body) {
  const res = await request(webhookApp()).post('/webhooks/whatsapp')
    .set('x-hub-signature-256', sign(body)).send(body);
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 60)); // processamento pós-200
}

const ts = (iso) => String(Math.floor(new Date(iso).getTime() / 1000));
const msg = (id, from, iso, texto, extra = {}) => ({
  id, from, timestamp: ts(iso), type: 'text', text: { body: texto },
  history_context: { status: 'READ' }, ...extra,
});

function bodyHistorico(threads, { pn = 'PN_AURA', errors } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ field: 'history', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: pn, display_phone_number: EMPRESA },
      history: [{
        metadata: { phase: 0, chunk_order: 1, progress: 100 },
        ...(threads ? { threads } : {}),
        ...(errors ? { errors } : {}),
      }],
    } }] }],
  };
}

const conversaDe = (tel) => world.convs.find((c) => c.external_id === tel);
const mensagensDe = (tel) => {
  const c = conversaDe(tel);
  return c ? world.messages.filter((m) => m.conversation_id === c.id) : [];
};

// ── (1) grava com o autor certo e as datas da Meta ──────────
describe('histórico da coexistência — número da Aura', () => {
  it('cada thread vira conversa; contato = cliente, empresa = humano, datas originais', async () => {
    await postar(bodyHistorico([
      { id: MARINA, messages: [
        msg('wamid.H1', MARINA, '2026-06-02T13:00:00Z', 'Oi, a Aura emite NFC-e?'),
        msg('wamid.H2', EMPRESA, '2026-06-02T13:05:00Z', 'Emite sim! Quer que eu te mostre?', { to: MARINA }),
        msg('wamid.H3', MARINA, '2026-06-02T13:07:00Z', 'Quero'),
      ] },
      { id: JOAO, messages: [
        msg('wamid.H4', EMPRESA, '2026-07-10T18:00:00Z', 'Oi João, tudo certo com o Caixa?', { to: JOAO }),
      ] },
    ]));

    expect(world.convs).toHaveLength(2);
    const ms = mensagensDe(MARINA);
    expect(ms.map((m) => [m.external_message_id, m.author, m.direction])).toEqual([
      ['wamid.H1', 'cliente', 'inbound'],
      ['wamid.H2', 'humano', 'outbound'],
      ['wamid.H3', 'cliente', 'inbound'],
    ]);
    expect(ms[0].created_at).toEqual(new Date('2026-06-02T13:00:00Z'));
    expect(ms[1].content).toBe('Emite sim! Quer que eu te mostre?');
    expect(ms[0].metadata).toMatchObject({ source: 'history', type: 'text' });

    const m = conversaDe(MARINA);
    expect(m.last_inbound_at).toEqual(new Date('2026-06-02T13:07:00Z'));
    expect(m.last_message_at).toEqual(new Date('2026-06-02T13:07:00Z'));
    expect(m.ultima_mensagem_humana_em).toEqual(new Date('2026-06-02T13:05:00Z'));

    const j = conversaDe(JOAO);
    expect(mensagensDe(JOAO)[0]).toMatchObject({ author: 'humano', direction: 'outbound' });
    expect(j.last_inbound_at).toBeNull();
  });

  it('telefone com máscara/sem 55 cai na mesma conversa da mensagem ao vivo', async () => {
    world.convs.push({
      id: 'conv-viva', company_id: AURA, channel: 'whatsapp', external_id: MARINA, status: 'humano',
      customer_name: 'Marina', last_inbound_at: new Date('2026-11-20T12:00:00Z'),
      last_message_at: new Date('2026-11-20T12:00:00Z'), aguardando_resposta_desde: null,
      ultima_mensagem_humana_em: null,
    });
    await postar(bodyHistorico([
      { id: '11988887777', messages: [msg('wamid.H9', '11988887777', '2026-06-02T13:00:00Z', 'mensagem antiga')] },
    ]));
    expect(world.convs).toHaveLength(1);
    const c = world.convs[0];
    // fala antiga não volta o relógio da conversa nem muda quem está no comando
    expect(c.last_inbound_at).toEqual(new Date('2026-11-20T12:00:00Z'));
    expect(c.status).toBe('humano');
    expect(world.messages[0]).toMatchObject({ conversation_id: 'conv-viva', author: 'cliente' });
  });

  it('mídia vira o marcador de sempre; reação e mensagem sem data ficam de fora', async () => {
    await postar(bodyHistorico([{ id: MARINA, messages: [
      { id: 'wamid.IMG', from: MARINA, timestamp: ts('2026-06-02T13:00:00Z'), type: 'image', image: { id: 'x' } },
      { id: 'wamid.FOTO', from: MARINA, timestamp: ts('2026-06-02T13:01:00Z'), type: 'image', caption: 'olha essa' },
      { id: 'wamid.REACT', from: EMPRESA, timestamp: ts('2026-06-02T13:02:00Z'), type: 'reaction', reaction: { emoji: '👍' } },
      { id: 'wamid.SEMDATA', from: MARINA, type: 'text', text: { body: 'sem data' } },
    ] }]));
    expect(mensagensDe(MARINA).map((m) => m.content)).toEqual(['[image]', 'olha essa']);
  });
});

// ── (2) nada dispara ────────────────────────────────────────
describe('histórico — não dispara Aurinha, aviso nem resposta', () => {
  it('com a Aurinha LIGADA: nenhum evento, nada na fila, nada aguardando', async () => {
    world.settings.enabled = true;
    await postar(bodyHistorico([{ id: MARINA, messages: [
      msg('wamid.N1', MARINA, new Date(Date.now() - 60000).toISOString(), 'Oi, alguém aí?'),
    ] }]));
    expect(world.messages).toHaveLength(1);
    expect(world.events).toHaveLength(0);
    expect(world.outbox).toHaveLength(0);
    expect(conversaDe(MARINA).aguardando_resposta_desde).toBeNull();
    expect(world.queries.some((q) => /-- hubwa:(claim|stub-recente|supersede|cancela-aurinha)|wa_outbox/.test(q.sql))).toBe(false);
  });

  it('o job de plantão não pega conversa que só tem histórico', async () => {
    await postar(bodyHistorico([{ id: MARINA, messages: [
      msg('wamid.N2', MARINA, new Date(Date.now() - 60000).toISOString(), 'Oi'),
    ] }]));
    const r = await hubWhatsapp.processarPendentes();
    expect(r.picked).toBe(0);
    expect(world.outbox).toHaveLength(0);
  });
});

// ── (3) idempotência ────────────────────────────────────────
describe('histórico — idempotente pelo wamid', () => {
  it('a mesma entrega duas vezes: uma mensagem de cada', async () => {
    const body = bodyHistorico([{ id: MARINA, messages: [
      msg('wamid.D1', MARINA, '2026-06-02T13:00:00Z', 'oi'),
      msg('wamid.D2', EMPRESA, '2026-06-02T13:01:00Z', 'olá', { to: MARINA }),
    ] }]);
    await postar(body);
    await postar(body);
    expect(world.messages).toHaveLength(2);
    expect(world.convs).toHaveLength(1);
  });

  it('mensagem que já entrou pelo eco do celular não duplica', async () => {
    world.convs.push({ id: 'conv-e', company_id: AURA, channel: 'whatsapp', external_id: MARINA, status: 'ia' });
    world.messages.push({ id: 'msg-e', company_id: AURA, conversation_id: 'conv-e', external_message_id: 'wamid.ECO', author: 'humano' });
    await postar(bodyHistorico([{ id: MARINA, messages: [
      msg('wamid.ECO', EMPRESA, '2026-11-01T13:00:00Z', 'eco', { to: MARINA }),
    ] }]));
    expect(world.messages).toHaveLength(1);
  });

  it('a Meta avisando que o contato não compartilhou: nada gravado, sem erro', async () => {
    await postar(bodyHistorico(null, { errors: [{ code: 2593109, title: 'History sync declined' }] }));
    expect(world.convs).toHaveLength(0);
    expect(world.messages).toHaveLength(0);
  });
});

// ── (4) volume ──────────────────────────────────────────────
describe('histórico — volume', () => {
  const muitas = (n) => Array.from({ length: n }, (_, i) =>
    msg(`wamid.V${i}`, i % 2 ? EMPRESA : MARINA, new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(), `m${i}`,
      i % 2 ? { to: MARINA } : {}));

  it('450 mensagens de uma conversa: 3 INSERTs em lote, todas gravadas', async () => {
    await postar(bodyHistorico([{ id: MARINA, messages: muitas(450) }]));
    expect(world.messages).toHaveLength(450);
    expect(world.queries.filter((q) => q.sql.includes('-- hubwa:hist-msg-insert'))).toHaveLength(3);
    expect(world.queries.filter((q) => q.sql.includes('-- hubwa:hist-conv-upsert'))).toHaveLength(1);
  });

  it('acima do teto por chamada: grava até o teto e conta o resto', async () => {
    const body = bodyHistorico([{ id: MARINA, messages: muitas(30) }]);
    const r = await hubWhatsapp.registrarHistorico({ companyId: AURA }, body.entry[0].changes[0].value, { max: 20, lote: 7 });
    expect(r).toMatchObject({ ok: true, conversas: 1, gravadas: 20, cortadas: 10 });
    expect(world.messages).toHaveLength(20);
  });

  it('schema pendente (42P01) não derruba o webhook', async () => {
    db.query.mockImplementation((sql, params) => {
      if (String(sql).includes('-- hubwa:hist-conv-upsert')) {
        const e = new Error('relation "hub_messages" does not exist'); e.code = '42P01';
        return Promise.reject(e);
      }
      return handler(world)(sql, params);
    });
    const body = bodyHistorico([{ id: MARINA, messages: muitas(2) }]);
    const r = await hubWhatsapp.registrarHistorico({ companyId: AURA }, body.entry[0].changes[0].value);
    expect(r).toMatchObject({ ok: false, reason: 'SCHEMA_PENDENTE' });
  });
});

// ── (5) fora do hub ─────────────────────────────────────────
describe('histórico — fora do número da Aura', () => {
  it('número de uma LOJA: só o log, nada no hub', async () => {
    await postar(bodyHistorico([{ id: MARINA, messages: [msg('wamid.L1', MARINA, '2026-06-02T13:00:00Z', 'oi')] }], { pn: 'PN_LOJA' }));
    expect(world.convs).toHaveLength(0);
    expect(world.messages).toHaveLength(0);
  });

  it('sem AURA_COMPANY_ID (dormente): nada no hub', async () => {
    delete process.env.AURA_COMPANY_ID;
    await postar(bodyHistorico([{ id: MARINA, messages: [msg('wamid.L2', MARINA, '2026-06-02T13:00:00Z', 'oi')] }]));
    expect(world.convs).toHaveLength(0);
    expect(world.queries.some((q) => q.sql.includes('-- hubwa:'))).toBe(false);
  });
});

// ── (6) PUT /hub/settings ───────────────────────────────────
describe('PUT /hub/settings — só dono ou admin', () => {
  function hubApp(companyRole) {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id/hub', (req, _res, next) => {
      req.user = { id: 'user-1' }; req.companyRole = companyRole; next();
    }, require('../src/routes/hubSocial'));
    return app;
  }
  const gravou = () => world.queries.some((q) => /INSERT INTO hub_agent_settings/.test(q.sql));

  it.each(['employee', 'vendedor', 'gerente', undefined])('membro (%s) → 403 e nada muda', async (role) => {
    const res = await request(hubApp(role)).put(`/companies/${AURA}/hub/settings`).send({ enabled: true });
    expect(res.status).toBe(403);
    expect(gravou()).toBe(false);
  });

  it.each(['owner', 'admin'])('%s → grava', async (role) => {
    db.query.mockImplementation((sql, params) => {
      if (/INSERT INTO hub_agent_settings/.test(String(sql))) {
        world.queries.push({ sql: String(sql), params });
        return Promise.resolve({ rows: [{ enabled: false, approval_mode: true, model: null, extra_instructions: null }] });
      }
      return handler(world)(sql, params);
    });
    const res = await request(hubApp(role)).put(`/companies/${AURA}/hub/settings`).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(gravou()).toBe(true);
  });

  it('membro continua lendo as configurações (GET)', async () => {
    const res = await request(hubApp('employee')).get(`/companies/${AURA}/hub/settings`);
    expect(res.status).toBe(200);
  });
});
