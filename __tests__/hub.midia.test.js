// ============================================================
// AURA — WhatsApp · Conversas: foto e áudio nos dois sentidos
//
//  (1) ENVIAR foto: sobe para a Meta, manda pelo id, guarda no R2 privado,
//      grava na thread. Formato errado e foto grande nem chegam na Meta.
//  (2) ENVIAR áudio: o WebM/Opus do Chrome chega à Meta como OGG/Opus; OGG
//      e MP4 passam direto; formato desconhecido é recusado.
//  (3) Conversa fechada: nada sobe, nada sai.
//  (4) RECEBER: o webhook só traz o id; o servidor baixa, guarda e a thread
//      ganha uma URL assinada (a chave do R2 nunca sai).
//  (5) Lojas: a mensagem recebida só vira conversa do hub com o ambiente ligado.
// ============================================================
'use strict';

process.env.WA_VERIFY_TOKEN = 'verify-test';
process.env.WA_APP_SECRET = 'secret-test-midia';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  graphPost: jest.fn(),
  graphError: (data, status) => Object.assign(new Error((data && data.error && data.error.message) || 'graph'), { meta: data && data.error, httpStatus: status }),
}));
jest.mock('../src/utils/r2Privado', () => ({
  disponivel: jest.fn(() => true),
  enviar: jest.fn(async () => ({ ok: true })),
  urlAssinada: jest.fn(async (key) => `https://r2.assinado/${key}?sig=1`),
}));
jest.mock('../src/services/waOutbox', () => ({
  decryptToken: (t) => t,
  normalizePhone: (p) => String(p || '').replace(/\D+/g, '') || null,
  windowOpenAt: (d) => !!(d && Date.now() - new Date(d).getTime() < 24 * 3600000),
  getContact: jest.fn().mockResolvedValue(null),
  loadPauseReason: jest.fn().mockResolvedValue(null),
  touchInbound: jest.fn().mockResolvedValue(null),
  touchOutboundHuman: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/services/customerConsent', () => ({ handleInboundReply: jest.fn().mockResolvedValue(undefined) }));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const r2 = require('../src/utils/r2Privado');
const waOutbox = require('../src/services/waOutbox');
const { criarWebm, pacote } = require('./helpers/webmFixture');

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const horas = (h) => new Date(Date.now() - h * 3600000).toISOString();
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)]);
const b64 = (b) => b.toString('base64');

function app() {
  const a = express();
  a.use(express.json({ limit: '5mb' }));
  a.use('/companies/:id/hub', (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
    require('../src/routes/hubSocial'));
  return a;
}

let conversa;
let inseridas;
let atualizacoes;
let uploads;
let downloads;
const fetchReal = global.fetch;

beforeEach(() => {
  db.query.mockReset();
  wa.graphPost.mockReset().mockResolvedValue({ messages: [{ id: 'wamid.SAIU' }] });
  r2.disponivel.mockReset().mockReturnValue(true);
  r2.enviar.mockClear();
  waOutbox.getContact.mockReset().mockResolvedValue(null);
  waOutbox.loadPauseReason.mockReset().mockResolvedValue(null);
  conversa = { id: CONV, channel: 'whatsapp', external_id: '5511988887777', customer_id: null, customer_name: null, last_inbound_at: horas(1) };
  inseridas = [];
  atualizacoes = [];
  uploads = [];
  downloads = [];
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (s.includes('hubenvio:conv')) return Promise.resolve({ rows: params[1] === COMPANY ? [conversa] : [] });
    if (s.includes('hubenvio:creds')) return Promise.resolve({ rows: [{ wa_phone_number_id: 'PNID', wa_access_token: 'tok' }] });
    if (s.includes('hubenvio:grava')) { inseridas.push(params); return Promise.resolve({ rows: [] }); }
    if (s.includes('hubmidia:recebida')) { atualizacoes.push(params); return Promise.resolve({ rows: [] }); }
    return Promise.resolve({ rows: [] });
  });
  global.fetch = jest.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/PNID/media')) {
      const arquivo = opts.body.get('file');
      uploads.push({ tipo: opts.body.get('type'), buffer: Buffer.from(await arquivo.arrayBuffer()), mime: arquivo.type });
      return { ok: true, status: 200, json: async () => ({ id: 'MEDIA-ENVIADA' }) };
    }
    if (u.endsWith('/MEDIA-RECEBIDA')) {
      return { ok: true, status: 200, json: async () => ({ url: 'https://lookaside.fbsbx.com/arquivo', mime_type: 'audio/ogg', file_size: 12 }) };
    }
    if (u.startsWith('https://lookaside.fbsbx.com')) {
      downloads.push(opts.headers && opts.headers.Authorization);
      return { ok: true, status: 200, headers: { get: () => 'audio/ogg' }, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer };
    }
    throw new Error(`fetch inesperado: ${u}`);
  });
});

afterAll(() => { global.fetch = fetchReal; });

const midia = (body, company = COMPANY) =>
  request(app()).post(`/companies/${company}/hub/conversations/${CONV}/midia`).send(body);

describe('enviar foto', () => {
  it('sobe para a Meta, manda pelo id, guarda no R2 e grava na thread', async () => {
    const res = await midia({ kind: 'foto', mime: 'image/jpeg', data: b64(JPEG), caption: 'Olha a cor' });
    expect(res.status).toBe(200);
    expect(uploads[0].buffer.equals(JPEG)).toBe(true);
    expect(uploads[0].mime).toBe('image/jpeg');
    expect(wa.graphPost.mock.calls[0][2]).toMatchObject({ type: 'image', to: '5511988887777', image: { id: 'MEDIA-ENVIADA', caption: 'Olha a cor' } });
    expect(r2.enviar).toHaveBeenCalledTimes(1);
    expect(r2.enviar.mock.calls[0][0]).toMatch(new RegExp(`^wa/${COMPANY}/${CONV}/.+\\.jpg$`));
    const meta = JSON.parse(inseridas[0][4]);
    expect(meta.tipo).toBe('foto');
    expect(meta.media.key).toMatch(/\.jpg$/);
    expect(inseridas[0][3]).toBe('Olha a cor');
  });

  it('PNG também vale; sem bucket privado o envio continua e a thread fica só com o texto', async () => {
    r2.disponivel.mockReturnValue(false);
    const res = await midia({ kind: 'foto', mime: 'image/png', data: b64(PNG) });
    expect(res.status).toBe(200);
    expect(r2.enviar).not.toHaveBeenCalled();
    expect(JSON.parse(inseridas[0][4]).media.key).toBeNull();
    expect(inseridas[0][3]).toBe('[foto]');
  });

  it('GIF → 415 e a Meta nem é chamada', async () => {
    const res = await midia({ kind: 'foto', mime: 'image/gif', data: b64(Buffer.from('GIF89a....')) });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('FOTO_FORMATO');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('foto acima de 5 MB → 413', async () => {
    const grande = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]);
    const res = await midia({ kind: 'foto', mime: 'image/jpeg', data: b64(grande) });
    expect([413]).toContain(res.status);
  });
});

describe('enviar áudio', () => {
  const pacotes = Array.from({ length: 5 }, (_, i) => pacote(i + 1, 40));

  it('WebM/Opus do Chrome chega à Meta como OGG/Opus', async () => {
    const res = await midia({ kind: 'audio', mime: 'audio/webm;codecs=opus', data: b64(criarWebm(pacotes)) });
    expect(res.status).toBe(200);
    expect(uploads[0].buffer.toString('ascii', 0, 4)).toBe('OggS');
    expect(uploads[0].mime).toBe('audio/ogg; codecs=opus');
    expect(uploads[0].tipo).toBe('audio/ogg');
    expect(wa.graphPost.mock.calls[0][2]).toMatchObject({ type: 'audio', audio: { id: 'MEDIA-ENVIADA' } });
    const meta = JSON.parse(inseridas[0][4]);
    expect(meta.media.kind).toBe('audio');
    expect(meta.media.key).toMatch(/\.ogg$/);
    expect(inseridas[0][3]).toBe('[audio]');
  });

  it('aceita data URL com ";codecs=opus" no tipo (é assim que o FileReader do Chrome devolve)', async () => {
    const url = `data:audio/webm;codecs=opus;base64,${b64(criarWebm(pacotes))}`;
    const res = await midia({ kind: 'audio', mime: 'audio/webm;codecs=opus', data: url });
    expect(res.status).toBe(200);
    expect(uploads[0].buffer.toString('ascii', 0, 4)).toBe('OggS');
  });

  it('OGG que já vem pronto passa direto, sem mexer nos bytes', async () => {
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 7)]);
    const res = await midia({ kind: 'audio', mime: 'audio/ogg', data: b64(ogg) });
    expect(res.status).toBe(200);
    expect(uploads[0].buffer.equals(ogg)).toBe(true);
  });

  it('MP4 (Safari) passa direto com o próprio tipo', async () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(40)]);
    const res = await midia({ kind: 'audio', mime: 'audio/mp4', data: b64(mp4) });
    expect(res.status).toBe(200);
    expect(uploads[0].tipo).toBe('audio/mp4');
  });

  it('formato desconhecido → 415 sem chamar a Meta', async () => {
    const res = await midia({ kind: 'audio', mime: 'audio/x-wav', data: b64(Buffer.from('RIFF....WAVE')) });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('AUDIO_FORMATO');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('WebM que não é Opus → 415 com texto claro', async () => {
    const res = await midia({ kind: 'audio', mime: 'audio/webm', data: b64(criarWebm(pacotes, { codec: 'A_VORBIS' })) });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/Grave de novo/);
  });
});

describe('guardas', () => {
  it('conversa fechada → 422 JANELA_FECHADA: nada sobe e nada sai', async () => {
    conversa.last_inbound_at = horas(30);
    const res = await midia({ kind: 'audio', mime: 'audio/ogg', data: b64(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(30)])) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('JANELA_FECHADA');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('conversa de outra loja → 404', async () => {
    const res = await midia({ kind: 'foto', mime: 'image/jpeg', data: b64(JPEG) }, '99999999-9999-4999-8999-999999999999');
    expect(res.status).toBe(404);
  });

  it('kind inválido → 400', async () => {
    const res = await midia({ kind: 'video', data: 'AA==' });
    expect(res.status).toBe(400);
  });
});

describe('receber', () => {
  const hubMidia = require('../src/services/hubWhatsappMidia');
  const msgAudio = { id: 'wamid.IN1', from: '5511988887777', type: 'audio', audio: { id: 'MEDIA-RECEBIDA', mime_type: 'audio/ogg; codecs=opus', voice: true } };

  it('reconhece foto, áudio e figurinha; ignora texto', () => {
    expect(hubMidia.midiaDaMensagem(msgAudio)).toEqual({ kind: 'audio', id: 'MEDIA-RECEBIDA', mime: 'audio/ogg; codecs=opus' });
    expect(hubMidia.midiaDaMensagem({ type: 'image', image: { id: 'I1' } }).kind).toBe('image');
    expect(hubMidia.midiaDaMensagem({ type: 'sticker', sticker: { id: 'S1' } }).kind).toBe('image');
    expect(hubMidia.midiaDaMensagem({ type: 'text', text: { body: 'oi' } })).toBeNull();
  });

  it('baixa pela Graph com o token da loja, guarda no R2 e anota na mensagem', async () => {
    const r = await hubMidia.guardarRecebida({ companyId: COMPANY, conversationId: CONV, msg: msgAudio });
    expect(r.ok).toBe(true);
    expect(downloads).toEqual(['Bearer tok']);
    expect(r2.enviar.mock.calls[0][0]).toMatch(new RegExp(`^wa/${COMPANY}/${CONV}/.+\\.ogg$`));
    expect(r2.enviar.mock.calls[0][1].equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    const [company, wamid, json] = atualizacoes[0];
    expect(company).toBe(COMPANY);
    expect(wamid).toBe('wamid.IN1');
    expect(JSON.parse(json).media).toMatchObject({ kind: 'audio', mime: 'audio/ogg', media_id: 'MEDIA-RECEBIDA' });
  });

  it('sem bucket privado não baixa nada (e não derruba o webhook)', async () => {
    r2.disponivel.mockReturnValue(false);
    const r = await hubMidia.guardarRecebida({ companyId: COMPANY, conversationId: CONV, msg: msgAudio });
    expect(r).toEqual({ ok: false, reason: 'SEM_BUCKET' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('falha no download nunca joga', async () => {
    global.fetch = jest.fn(async () => { throw new Error('rede caiu'); });
    const r = await hubMidia.guardarRecebida({ companyId: COMPANY, conversationId: CONV, msg: msgAudio });
    expect(r.ok).toBe(false);
  });

  it('a thread devolve a URL assinada e nunca a chave', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (s.includes('FROM hub_conversations')) return Promise.resolve({ rows: [{ id: CONV, channel: 'whatsapp', external_id: '5511988887777', customer_name: null, status: 'humano', category: null, handoff_reason: null, last_inbound_at: horas(1) }] });
      if (s.includes('hub:thread-whatsapp')) {
        return Promise.resolve({ rows: [
          { id: 'm1', direction: 'inbound', content: '[audio]', author: 'cliente', created_at: horas(1), media: { kind: 'audio', mime: 'audio/ogg', key: 'wa/c/v/a.ogg', bytes: 4 } },
          { id: 'm2', direction: 'inbound', content: 'oi', author: 'cliente', created_at: horas(1), media: null },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app()).get(`/companies/${COMPANY}/hub/conversations/${CONV}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages[0].media).toEqual({ kind: 'audio', mime: 'audio/ogg', url: 'https://r2.assinado/wa/c/v/a.ogg?sig=1' });
    expect(JSON.stringify(res.body)).not.toContain('"key"');
    expect(res.body.messages[1].media).toBeNull();
  });
});

describe('lojas no hub (WA_HUB_LOJAS_LIGADO)', () => {
  const hubWhatsapp = require('../src/services/hubWhatsapp');
  const spy = jest.spyOn(hubWhatsapp, 'registrarInbound').mockResolvedValue({ ok: true });
  const spyEcho = jest.spyOn(hubWhatsapp, 'registrarEcho').mockResolvedValue({ ok: true });

  function webhook() {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    a.use('/webhooks/whatsapp', require('../src/routes/webhookWhatsapp'));
    return a;
  }
  async function postar(value, field = 'messages') {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field, value }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(Buffer.from(body, 'utf8')).digest('hex');
    await request(webhook()).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(body);
    await new Promise((r) => setTimeout(r, 50));
  }
  const valor = { metadata: { phone_number_id: 'PN-LOJA' }, contacts: [{ wa_id: '5511988887777', profile: { name: 'Ana' } }], messages: [{ id: 'wamid.X', from: '5511988887777', type: 'text', text: { body: 'oi' } }] };

  beforeEach(() => {
    spy.mockClear(); spyEcho.mockClear();
    db.query.mockImplementation((sql) => {
      if (String(sql).includes('FROM companies WHERE wa_phone_number_id')) return Promise.resolve({ rows: [{ id: COMPANY }] });
      return Promise.resolve({ rows: [] });
    });
    delete process.env.AURA_COMPANY_ID;
  });
  afterEach(() => { delete process.env.WA_HUB_LOJAS_LIGADO; });

  it('desligado (padrão): a loja segue o fluxo de sempre, sem tocar no hub', async () => {
    await postar(valor);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ligado: a mensagem vira conversa sem Aurinha, "precisa de você", com o nome do perfil', async () => {
    process.env.WA_HUB_LOJAS_LIGADO = '1';
    await postar(valor);
    expect(spy).toHaveBeenCalledTimes(1);
    const [tenant, msg, opts] = spy.mock.calls[0];
    expect(tenant).toMatchObject({ companyId: COMPANY, enabled: false, statusAberto: 'precisa_humano' });
    expect(msg.id).toBe('wamid.X');
    expect(opts.nome).toBe('Ana');
  });

  it('ligado: o eco do celular da loja vira mensagem humana', async () => {
    process.env.WA_HUB_LOJAS_LIGADO = '1';
    await postar({ metadata: { phone_number_id: 'PN-LOJA' }, message_echoes: [{ id: 'wamid.E', to: '5511988887777', type: 'text', text: { body: 'já te mando' } }] }, 'smb_message_echoes');
    expect(spyEcho).toHaveBeenCalledTimes(1);
    expect(spyEcho.mock.calls[0][0]).toEqual({ companyId: COMPANY });
  });
});
