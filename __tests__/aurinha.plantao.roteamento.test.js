// ============================================================
// AURA — AURINHA DE PLANTÃO: roteamento do webhook para o hub (375)
//
// Cobertura (webhook real via supertest, banco fake em memória):
//  (1) tenant Aura × loja: número da Aura vira conversa no hub; número
//      de loja segue o fluxo de sempre (wa_messages + touchInbound) sem
//      tocar em nada do hub.
//  (2) dormente: sem AURA_COMPANY_ID, ou com wa_phone_number_id
//      diferente, o webhook nem consulta o hub.
//  (3) idempotência pelo id da mensagem da Meta: duas entregas do mesmo
//      webhook = uma mensagem, uma resposta, um evento.
//  (4) relógio: de noite responde na hora (stub na fila); de dia fica
//      aguardando e registra 'resposta_agendada'.
//  (5) eco do app do celular (o Caio respondeu): vira mensagem humana,
//      limpa a pendência e cancela a resposta da Aurinha na fila.
//  (6) job por minuto: reavalia pendentes (15 min de dia; humano que
//      respondeu no meio impede a Aurinha).
//  (7) painel: resposta humana em conversa WhatsApp entra na fila com
//      origem hub; janela fechada → 422.
// ============================================================
'use strict';

process.env.WA_VERIFY_TOKEN = 'verify-test';
process.env.WA_APP_SECRET = 'secret-test-hub';

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
const { TEXTO_STUB } = hubWhatsapp;

const AURA = '11111111-1111-4111-8111-111111111111';
const CLIENTE = '5511988887777';

// 14/10/2026 em Brasília (UTC-3) — o relógio do teste congela a data e
// deixa os timers reais (supertest e a espera pós-200 dependem deles).
const brt = (hh, mm = 0, ss = 0) => new Date(Date.UTC(2026, 9, 14, hh + 3, mm, ss));
const REAL_TIMERS = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate',
  'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
function congelarEm(date) {
  jest.useFakeTimers({ now: date, doNotFake: REAL_TIMERS });
}

let world;

beforeEach(() => {
  world = makeWorld();
  process.env.AURA_COMPANY_ID = AURA;
  db.query.mockReset();
  db.query.mockImplementation(handler(world));
});

afterEach(() => {
  jest.useRealTimers();
  delete process.env.AURA_COMPANY_ID;
});

function webhookApp() {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/webhooks/whatsapp', require('../src/routes/webhookWhatsapp'));
  return app;
}
function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', 'secret-test-hub')
    .update(Buffer.from(JSON.stringify(body), 'utf8')).digest('hex');
}
async function postar(body) {
  const res = await request(webhookApp()).post('/webhooks/whatsapp')
    .set('x-hub-signature-256', sign(body)).send(body);
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 40)); // processamento pós-200
}

function bodyMensagem({ pn = 'PN_AURA', wamid = 'wamid.IN1', from = CLIENTE, texto = 'Oi, preciso de ajuda', ts } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: pn },
      contacts: [{ wa_id: from, profile: { name: 'Marina' } }],
      messages: [{
        id: wamid, from, type: 'text', text: { body: texto },
        timestamp: String(Math.floor((ts || new Date()).getTime() / 1000)),
      }],
    } }] }],
  };
}
function bodyEco({ pn = 'PN_AURA', wamid = 'wamid.ECO1', to = CLIENTE, texto = 'Oi Marina, já te ajudo!', ts } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ field: 'smb_message_echoes', value: {
      metadata: { phone_number_id: pn },
      message_echoes: [{
        id: wamid, from: '5511900000000', to, text: { body: texto },
        timestamp: String(Math.floor((ts || new Date()).getTime() / 1000)),
      }],
    } }] }],
  };
}

const sqlsHub = () => world.queries.filter((q) => /-- hubwa:|hub_messages|hub_conversations/.test(q.sql));
const gravouWaMessages = () => world.queries.some((q) => /INSERT INTO wa_messages/i.test(q.sql));
const tocouContato = () => world.queries.some((q) => q.sql.includes('-- wa:contact-touch') && !q.sql.includes('outbound-human'));

// ── (1) tenant Aura × loja ──────────────────────────────────
describe('roteamento — tenant Aura × loja', () => {
  it('mensagem para o número da Aura vira conversa no hub (canal whatsapp, pelo telefone)', async () => {
    congelarEm(brt(23, 0));
    await postar(bodyMensagem({ ts: brt(23, 0) }));

    expect(world.convs).toHaveLength(1);
    const c = world.convs[0];
    expect(c.channel).toBe('whatsapp');
    expect(c.external_id).toBe(CLIENTE);
    expect(c.company_id).toBe(AURA);
    expect(c.customer_name).toBe('Marina');

    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]).toMatchObject({
      conversation_id: c.id, external_message_id: 'wamid.IN1', content: 'Oi, preciso de ajuda',
    });
    expect(world.events.map((e) => e.type)).toContain('mensagem_recebida');

    // Fluxo das lojas NÃO roda para o tenant: nada em wa_messages, e
    // "cancelar"/"parar" de suporte nunca passa por opt-out de marketing.
    expect(gravouWaMessages()).toBe(false);
    expect(tocouContato()).toBe(false);
  });

  it('mensagem para o número de uma LOJA segue o fluxo atual, sem tocar no hub', async () => {
    await postar(bodyMensagem({ pn: 'PN_LOJA', wamid: 'wamid.LOJA1' }));

    expect(gravouWaMessages()).toBe(true);
    expect(tocouContato()).toBe(true);
    expect(world.convs).toHaveLength(0);
    expect(world.messages).toHaveLength(0);
    expect(world.events).toHaveLength(0);
    expect(world.outbox).toHaveLength(0);
    // a única consulta ao hub é a do tenant (não casou) — nenhuma escrita
    expect(sqlsHub().filter((q) => !q.sql.includes('-- hubwa:tenant'))).toHaveLength(0);
  });

  it('loja com a mesma conversa não vaza: conversa da Aura e da loja não se misturam', async () => {
    congelarEm(brt(23, 0));
    await postar(bodyMensagem({ ts: brt(23, 0) }));
    await postar(bodyMensagem({ pn: 'PN_LOJA', wamid: 'wamid.LOJA2', ts: brt(23, 0) }));
    expect(world.convs).toHaveLength(1);
    expect(world.messages).toHaveLength(1);
  });
});

// ── (2) dormente ────────────────────────────────────────────
describe('roteamento — dormente por padrão', () => {
  it('sem AURA_COMPANY_ID o webhook nem consulta o hub', async () => {
    delete process.env.AURA_COMPANY_ID;
    await postar(bodyMensagem({ pn: 'PN_AURA' }));
    expect(world.queries.some((q) => q.sql.includes('-- hubwa:'))).toBe(false);
    expect(world.convs).toHaveLength(0);
  });

  it('número diferente do wa_phone_number_id das settings não roteia', async () => {
    world.settings.waPhoneNumberId = 'PN_OUTRO';
    await postar(bodyMensagem({ pn: 'PN_AURA' }));
    expect(world.convs).toHaveLength(0);
    expect(world.messages).toHaveLength(0);
  });

  it('migration 375 pendente (42703 na consulta do tenant) → fluxo das lojas, sem erro', async () => {
    db.query.mockImplementation((sql, params) => {
      if (String(sql).includes('-- hubwa:tenant')) {
        const e = new Error('column wa_phone_number_id does not exist'); e.code = '42703';
        return Promise.reject(e);
      }
      return handler(world)(sql, params);
    });
    await postar(bodyMensagem({ pn: 'PN_LOJA', wamid: 'wamid.LOJA3' }));
    expect(gravouWaMessages()).toBe(true);
  });
});

// ── (3) idempotência ────────────────────────────────────────
describe('roteamento — idempotente pelo id da mensagem da Meta', () => {
  it('a mesma entrega duas vezes: uma mensagem, uma resposta, um evento', async () => {
    congelarEm(brt(23, 0));
    const body = bodyMensagem({ wamid: 'wamid.DUP', ts: brt(23, 0) });
    await postar(body);
    await postar(body);

    expect(world.messages).toHaveLength(1);
    expect(world.outbox).toHaveLength(1);
    expect(world.events.filter((e) => e.type === 'mensagem_recebida')).toHaveLength(1);
    expect(world.events.filter((e) => e.type === 'resposta_enfileirada')).toHaveLength(1);
  });

  it('duas mensagens DIFERENTES da mesma pessoa caem na mesma conversa', async () => {
    congelarEm(brt(10, 0));
    await postar(bodyMensagem({ wamid: 'wamid.A', ts: brt(10, 0) }));
    await postar(bodyMensagem({ wamid: 'wamid.B', texto: 'e aí?', ts: brt(10, 1) }));
    expect(world.convs).toHaveLength(1);
    expect(world.messages).toHaveLength(2);
  });
});

// ── (4) relógio de plantão no roteamento ────────────────────
describe('roteamento — plantão decide responder agora ou agendar', () => {
  it('23:00 (noite): responde na hora — stub na fila com origem hub', async () => {
    congelarEm(brt(23, 0));
    await postar(bodyMensagem({ ts: brt(23, 0) }));

    expect(world.outbox).toHaveLength(1);
    expect(world.outbox[0]).toMatchObject({
      company_id: AURA, to_phone: CLIENTE, kind: 'text', status: 'pending',
      source_type: 'aurinha', text_body: TEXTO_STUB, hub_conversation_id: world.convs[0].id,
    });
    expect(TEXTO_STUB).toBe('Oi! Aqui é a Aurinha, da Aura. Anotei sua mensagem e o Caio te responde às 8h.');
    expect(world.convs[0].aguardando_resposta_desde).toBeNull();
    expect(world.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['mensagem_recebida', 'resposta_enfileirada'])
    );
  });

  it('10:00 (dia): não responde; fica aguardando e agenda para 10:15', async () => {
    congelarEm(brt(10, 0));
    await postar(bodyMensagem({ ts: brt(10, 0) }));

    expect(world.outbox).toHaveLength(0);
    expect(world.convs[0].aguardando_resposta_desde).not.toBeNull();
    const ag = world.events.find((e) => e.type === 'resposta_agendada');
    expect(ag).toBeTruthy();
    expect(ag.detail.responder_a_partir_de).toBe(brt(10, 15).toISOString());
  });

  it('20:59 espera; mensagem às 21:00 sai na hora', async () => {
    congelarEm(brt(20, 59));
    await postar(bodyMensagem({ wamid: 'wamid.D1', ts: brt(20, 59) }));
    expect(world.outbox).toHaveLength(0);

    jest.setSystemTime(brt(21, 0));
    await postar(bodyMensagem({ wamid: 'wamid.N1', from: '5511977776666', ts: brt(21, 0) }));
    expect(world.outbox).toHaveLength(1);
    expect(world.outbox[0].to_phone).toBe('5511977776666');
  });

  it('Aurinha desligada (enabled=false): grava a conversa e não responde nem agenda', async () => {
    world.settings.enabled = false;
    congelarEm(brt(23, 0));
    await postar(bodyMensagem({ ts: brt(23, 0) }));
    expect(world.messages).toHaveLength(1);
    expect(world.outbox).toHaveLength(0);
    expect(world.events.some((e) => e.type === 'resposta_agendada')).toBe(false);
  });

  it('conversa nas mãos do humano (status != ia): grava e não responde', async () => {
    congelarEm(brt(23, 0));
    await postar(bodyMensagem({ wamid: 'wamid.H0', ts: brt(23, 0) }));
    world.convs[0].status = 'humano';
    world.outbox.length = 0;
    await postar(bodyMensagem({ wamid: 'wamid.H1', texto: 'alô?', ts: brt(23, 1) }));
    expect(world.messages).toHaveLength(2);
    expect(world.outbox).toHaveLength(0);
  });

  it('rajada de 3 mensagens à noite: o aviso fixo sai UMA vez', async () => {
    congelarEm(brt(23, 0));
    await postar(bodyMensagem({ wamid: 'wamid.R1', ts: brt(23, 0) }));
    await postar(bodyMensagem({ wamid: 'wamid.R2', texto: 'alô', ts: brt(23, 0, 20) }));
    await postar(bodyMensagem({ wamid: 'wamid.R3', texto: '???', ts: brt(23, 0, 40) }));
    expect(world.messages).toHaveLength(3);
    expect(world.outbox.filter((o) => o.source_type === 'aurinha')).toHaveLength(1);
  });

  it('mensagem velha demais (webhook ficou fora do ar): grava, mas não responde', async () => {
    congelarEm(brt(23, 0));
    await postar(bodyMensagem({ ts: new Date(brt(23, 0).getTime() - 30 * 3600000) }));
    expect(world.messages).toHaveLength(1);
    expect(world.outbox).toHaveLength(0);
    expect(world.convs[0].aguardando_resposta_desde).toBeNull();
  });
});

// ── (5) eco do app do celular ───────────────────────────────
describe('roteamento — eco do app do celular (o Caio respondeu)', () => {
  it('vira mensagem humana, limpa a pendência e cancela a resposta da Aurinha na fila', async () => {
    congelarEm(brt(10, 0));
    await postar(bodyMensagem({ ts: brt(10, 0) }));
    expect(world.convs[0].aguardando_resposta_desde).not.toBeNull();
    // uma sugestão da Aurinha já estava na fila para esta conversa
    world.outbox.push({
      id: 'out-x', hub_conversation_id: world.convs[0].id, status: 'pending',
      source_type: 'aurinha', wa_message_id: null,
    });

    jest.setSystemTime(brt(10, 5));
    await postar(bodyEco({ ts: brt(10, 5) }));

    const humana = world.messages.find((m) => m.external_message_id === 'wamid.ECO1');
    expect(humana).toMatchObject({ author: 'humano', direction: 'outbound' });
    expect(world.convs[0].ultima_mensagem_humana_em).toEqual(brt(10, 5));
    expect(world.convs[0].aguardando_resposta_desde).toBeNull();
    expect(world.outbox[0]).toMatchObject({ status: 'skipped', skip_reason: 'HUMANO_RESPONDEU' });
    expect(world.events.map((e) => e.type)).toContain('mensagem_humana');
  });

  it('eco de mensagem que a PRÓPRIA fila mandou não conta como humano', async () => {
    world.outbox.push({ id: 'out-1', wa_message_id: 'wamid.ECO-PROPRIO', hub_conversation_id: 'c', status: 'sent' });
    await postar(bodyEco({ wamid: 'wamid.ECO-PROPRIO' }));
    expect(world.messages).toHaveLength(0);
    expect(world.events.some((e) => e.type === 'mensagem_humana')).toBe(false);
  });

  it('eco do número de uma LOJA não toca no hub', async () => {
    await postar(bodyEco({ pn: 'PN_LOJA', wamid: 'wamid.ECO-LOJA' }));
    expect(world.convs).toHaveLength(0);
    expect(world.messages).toHaveLength(0);
  });

  it('o mesmo eco duas vezes: uma mensagem', async () => {
    await postar(bodyEco({ wamid: 'wamid.ECO-DUP' }));
    await postar(bodyEco({ wamid: 'wamid.ECO-DUP' }));
    expect(world.messages.filter((m) => m.external_message_id === 'wamid.ECO-DUP')).toHaveLength(1);
  });
});

// ── (6) job por minuto ──────────────────────────────────────
describe('job de plantão — reavalia o que ficou aguardando', () => {
  it('de dia: 14 min ainda espera, 15 min entra (uma vez só)', async () => {
    congelarEm(brt(10, 0));
    await postar(bodyMensagem({ ts: brt(10, 0) }));
    expect(world.outbox).toHaveLength(0);

    let r = await hubWhatsapp.processarPendentes({ agora: brt(10, 14, 59) });
    expect(r).toMatchObject({ picked: 1, aguardando: 1, respondidas: 0 });
    expect(world.outbox).toHaveLength(0);

    r = await hubWhatsapp.processarPendentes({ agora: brt(10, 15, 0) });
    expect(r).toMatchObject({ picked: 1, respondidas: 1 });
    expect(world.outbox).toHaveLength(1);
    expect(world.outbox[0]).toMatchObject({ source_type: 'aurinha', text_body: TEXTO_STUB });
    expect(world.events.map((e) => e.type)).toContain('resposta_enfileirada');

    // próximo minuto: nada mais pendente, nada duplicado
    r = await hubWhatsapp.processarPendentes({ agora: brt(10, 16, 0) });
    expect(r.picked).toBe(0);
    expect(world.outbox).toHaveLength(1);
  });

  it('o humano respondeu no meio da espera: a Aurinha não entra', async () => {
    congelarEm(brt(10, 0));
    await postar(bodyMensagem({ ts: brt(10, 0) }));
    jest.setSystemTime(brt(10, 7));
    await postar(bodyEco({ ts: brt(10, 7) }));

    const r = await hubWhatsapp.processarPendentes({ agora: brt(10, 20) });
    expect(r.picked).toBe(0);
    expect(world.outbox).toHaveLength(0);
  });

  it('pendência com humano já posterior ao cliente é limpa, sem responder', async () => {
    congelarEm(brt(10, 0));
    await postar(bodyMensagem({ ts: brt(10, 0) }));
    // estado inconsistente: humano falou depois mas a pendência ficou
    world.convs[0].ultima_mensagem_humana_em = brt(10, 3);

    const r = await hubWhatsapp.processarPendentes({ agora: brt(10, 20) });
    expect(r.respondidas).toBe(0);
    expect(world.outbox).toHaveLength(0);
    expect(world.convs[0].aguardando_resposta_desde).toBeNull();
  });

  it('sem AURA_COMPANY_ID o job é dormente e não consulta o banco', async () => {
    delete process.env.AURA_COMPANY_ID;
    const antes = world.queries.length;
    const r = await hubWhatsapp.processarPendentes({ agora: brt(10, 20) });
    expect(r.dormente).toBe(true);
    expect(world.queries.length).toBe(antes);
  });

  it('Aurinha desligada: o job não pega nada', async () => {
    congelarEm(brt(10, 0));
    await postar(bodyMensagem({ ts: brt(10, 0) }));
    world.settings.enabled = false;
    const r = await hubWhatsapp.processarPendentes({ agora: brt(10, 20) });
    expect(r.picked).toBe(0);
  });

  it('plantão configurado (espera 5 min) vale no job', async () => {
    world.settings.plantao = { espera_minutos: 5 };
    congelarEm(brt(10, 0));
    await postar(bodyMensagem({ ts: brt(10, 0) }));
    let r = await hubWhatsapp.processarPendentes({ agora: brt(10, 4) });
    expect(r.aguardando).toBe(1);
    r = await hubWhatsapp.processarPendentes({ agora: brt(10, 5) });
    expect(r.respondidas).toBe(1);
  });

  it('job (initPlantaoJob) respeita PLANTAO_ENABLED=false', () => {
    process.env.PLANTAO_ENABLED = 'false';
    const job = require('../src/jobs/plantaoJob');
    const spy = jest.spyOn(global, 'setInterval');
    job.initPlantaoJob();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    delete process.env.PLANTAO_ENABLED;
  });

  it('tick do job chama o processamento e nunca lança com schema pendente', async () => {
    db.query.mockImplementation(() => {
      const e = new Error('relation "hub_conversations" does not exist'); e.code = '42P01';
      return Promise.reject(e);
    });
    const job = require('../src/jobs/plantaoJob');
    await expect(job.tick()).resolves.toMatchObject({ dormente: true, picked: 0 });
  });
});

// ── (7) resposta humana pelo painel ─────────────────────────
describe('painel — resposta humana em conversa WhatsApp (origem hub)', () => {
  function hubApp() {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id/hub', (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
      require('../src/routes/hubSocial'));
    return app;
  }

  it('janela aberta → entra na wa_outbox com origem hub, source humano; Aurinha sai de cena', async () => {
    congelarEm(brt(14, 0));
    world.convs.push({
      id: 'conv-w', company_id: AURA, channel: 'whatsapp', external_id: CLIENTE, status: 'ia',
      last_inbound_at: new Date(brt(14, 0).getTime() - 2 * 3600000), aguardando_resposta_desde: brt(13, 0),
      ultima_mensagem_humana_em: null,
    });
    // a consulta do reply lê a conversa por id
    db.query.mockImplementation((sql, params) => {
      if (String(sql).includes('FROM hub_conversations') && String(sql).includes('last_inbound_at, channel')) {
        const c = world.convs[0];
        return Promise.resolve({ rows: [{ external_id: c.external_id, last_inbound_at: c.last_inbound_at, channel: c.channel }] });
      }
      return handler(world)(sql, params);
    });

    const res = await request(hubApp())
      .post(`/companies/${AURA}/hub/conversations/conv-w/reply`)
      .send({ text: 'Oi! Aqui é o Caio.' });
    expect(res.status).toBe(200);
    expect(world.outbox).toHaveLength(1);
    expect(world.outbox[0]).toMatchObject({
      kind: 'text', source_type: 'humano', hub_conversation_id: 'conv-w', to_phone: CLIENTE, text_body: 'Oi! Aqui é o Caio.',
    });
    expect(world.convs[0].aguardando_resposta_desde).toBeNull();
    expect(world.convs[0].ultima_mensagem_humana_em).not.toBeNull();
  });

  it('janela fechada → 422 JANELA_FECHADA e nada entra na fila', async () => {
    congelarEm(brt(14, 0));
    db.query.mockImplementation((sql) => {
      if (String(sql).includes('FROM hub_conversations')) {
        return Promise.resolve({ rows: [{
          external_id: CLIENTE, channel: 'whatsapp',
          last_inbound_at: new Date(brt(14, 0).getTime() - 26 * 3600000).toISOString(),
        }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(hubApp())
      .post(`/companies/${AURA}/hub/conversations/conv-w/reply`)
      .send({ text: 'oi' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('JANELA_FECHADA');
    expect(world.outbox).toHaveLength(0);
  });
});
