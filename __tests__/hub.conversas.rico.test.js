// ============================================================
// AURA — WhatsApp · Conversas: mensagens ricas da conversa aberta
//
//  (1) produto sai com foto, nome e preço; sem foto vai só o texto;
//      produto de outra loja não sai.
//  (2) Pix e link da loja saem do cadastro da loja; sem chave Pix ou sem
//      loja publicada, o lojista lê o motivo e nada vai para a Meta.
//  (3) conversa fechada (24 h) nunca envia: JANELA_FECHADA, sem chamar a Meta.
//  (4) número recusado pela Meta e conta pausada bloqueiam.
//  (5) a mensagem enviada aparece na thread e conta como resposta humana.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({ graphPost: jest.fn(), sendText: jest.fn() }));
jest.mock('../src/services/hubWhatsapp', () => ({ marcarRespostaHumana: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/waOutbox', () => ({
  decryptToken: (t) => t,
  normalizePhone: (p) => String(p || '').replace(/\D+/g, '') || null,
  windowOpenAt: (d) => !!(d && Date.now() - new Date(d).getTime() < 24 * 3600000),
  getContact: jest.fn().mockResolvedValue(null),
  loadPauseReason: jest.fn().mockResolvedValue(null),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const waOutbox = require('../src/services/waOutbox');
const hubWhatsapp = require('../src/services/hubWhatsapp');

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const horas = (h) => new Date(Date.now() - h * 3600000).toISOString();

function app() {
  const a = express();
  a.use(express.json());
  a.use('/companies/:id/hub', (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
    require('../src/routes/hubSocialRico'));
  return a;
}

let inseridas;
let conversa;
let dados;

beforeEach(() => {
  db.query.mockReset();
  wa.graphPost.mockReset().mockResolvedValue({ messages: [{ id: 'wamid.ENVIADO' }] });
  waOutbox.getContact.mockReset().mockResolvedValue(null);
  waOutbox.loadPauseReason.mockReset().mockResolvedValue(null);
  hubWhatsapp.marcarRespostaHumana.mockClear();
  inseridas = [];
  conversa = { id: CONV, channel: 'whatsapp', external_id: '5511988887777', customer_id: null, customer_name: null, last_inbound_at: horas(2) };
  dados = {
    produto: { id: 'p1', name: 'Saia midi plissada', price: '189.90', image_url: 'https://r2.getaura.com.br/p1.jpg', promo_price: null, promo_starts_at: null, promo_ends_at: null },
    loja: { slug: 'lumemoda', is_published: true, pix_key: '11144477735', pix_key_type: 'CPF', pix_holder_name: 'Lume Moda', pix_holder_city: 'Sao Paulo', trade_name: 'Lume Moda', legal_name: 'Lume LTDA' },
  };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (s.includes('hubenvio:conv')) return Promise.resolve({ rows: params[1] === COMPANY ? [conversa] : [] });
    if (s.includes('hubenvio:creds')) return Promise.resolve({ rows: [{ wa_phone_number_id: 'PNID', wa_access_token: 'tok' }] });
    if (s.includes('hubenvio:produto')) return Promise.resolve({ rows: params[0] === 'p1' ? [dados.produto] : [] });
    if (s.includes('hubenvio:loja')) return Promise.resolve({ rows: [dados.loja] });
    if (s.includes('hubenvio:orcamento-itens')) return Promise.resolve({ rows: dados.itens || [] });
    if (s.includes('hubenvio:orcamento')) return Promise.resolve({ rows: dados.orcamento ? [dados.orcamento] : [] });
    if (s.includes('hubenvio:grava')) { inseridas.push(params); return Promise.resolve({ rows: [] }); }
    return Promise.resolve({ rows: [] });
  });
});

const enviar = (body, company = COMPANY) =>
  request(app()).post(`/companies/${company}/hub/conversations/${CONV}/send`).send(body);

describe('produto', () => {
  it('manda foto com nome e preço e grava na thread', async () => {
    const res = await enviar({ type: 'produto', product_id: 'p1' });
    expect(res.status).toBe(200);
    const [path, token, corpo] = wa.graphPost.mock.calls[0];
    expect(path).toBe('/PNID/messages');
    expect(token).toBe('tok');
    expect(corpo.type).toBe('image');
    expect(corpo.to).toBe('5511988887777');
    expect(corpo.image.link).toBe('https://r2.getaura.com.br/p1.jpg');
    expect(corpo.image.caption).toBe('*Saia midi plissada*\nR$ 189,90');
    expect(inseridas).toHaveLength(1);
    expect(inseridas[0][2]).toBe('wamid.ENVIADO');
    expect(JSON.parse(inseridas[0][4]).tipo).toBe('produto');
    expect(hubWhatsapp.marcarRespostaHumana).toHaveBeenCalledWith(COMPANY, CONV, 'user-1');
  });

  it('sem foto vai só o texto', async () => {
    dados.produto.image_url = null;
    const res = await enviar({ type: 'produto', product_id: 'p1' });
    expect(res.status).toBe(200);
    expect(wa.graphPost.mock.calls[0][2].type).toBe('text');
  });

  it('produto que não é da loja → 404 e nada sai', async () => {
    const res = await enviar({ type: 'produto', product_id: 'de-outra-loja' });
    expect(res.status).toBe(404);
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('preço de promoção vigente vale no lugar do preço cheio', async () => {
    dados.produto.promo_price = '149.90';
    dados.produto.promo_starts_at = horas(24);
    dados.produto.promo_ends_at = new Date(Date.now() + 24 * 3600000).toISOString();
    await enviar({ type: 'produto', product_id: 'p1' });
    expect(wa.graphPost.mock.calls[0][2].image.caption).toContain('R$ 149,90');
  });
});

describe('pix e link da loja', () => {
  it('Pix sai com o código copia e cola da chave da loja', async () => {
    const res = await enviar({ type: 'pix', amount: 189.9 });
    expect(res.status).toBe(200);
    const corpo = wa.graphPost.mock.calls[0][2];
    expect(corpo.type).toBe('text');
    expect(corpo.text.body).toContain('Pix da Lume Moda: R$ 189,90');
    expect(corpo.text.body).toContain('00020126');
    expect(corpo.text.body).toContain('54061');
  });

  it('sem chave Pix → 409 SEM_PIX', async () => {
    dados.loja.pix_key = null;
    const res = await enviar({ type: 'pix' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEM_PIX');
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('link da loja usa o slug publicado', async () => {
    const res = await enviar({ type: 'link_loja' });
    expect(res.status).toBe(200);
    expect(wa.graphPost.mock.calls[0][2].text.body).toContain('/lumemoda');
  });

  it('loja não publicada → 409', async () => {
    dados.loja.is_published = false;
    const res = await enviar({ type: 'link_loja' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOJA_NAO_PUBLICADA');
  });
});

describe('cartões estruturados no metadata (Main.dc.html)', () => {
  const meta = () => JSON.parse(inseridas[0][4]);

  it('orçamento: número, itens, total, validade e o link de aprovar', async () => {
    const validade = new Date(Date.now() + 7 * 24 * 3600000);
    dados.orcamento = { id: 'q1', token: 'tok123', status: 'sent', total: '189.90', expires_at: validade.toISOString(), customer_name: 'Ana', numero: 21 };
    dados.itens = [
      { description: 'Saia midi plissada · M', quantity: '1.00', unit_price: '189.90' },
      { description: 'Ajuste de barra', quantity: '1.00', unit_price: '0.00' },
    ];
    const res = await enviar({ type: 'orcamento', quote_id: 'q1' });
    expect(res.status).toBe(200);
    const m = meta();
    expect(m.tipo).toBe('orcamento');
    expect(m.cartao.numero).toBe(21);
    expect(m.cartao.itens).toEqual([
      { nome: 'Saia midi plissada · M', qtd: 1, valor: 189.9 },
      { nome: 'Ajuste de barra', qtd: 1, valor: 0 },
    ]);
    expect(m.cartao.total).toBe(189.9);
    expect(m.cartao.validade).toBe(validade.toISOString());
    expect(m.cartao.url).toMatch(/\/orcamento\/tok123$/);
  });

  it('Pix: valor, chave e o código copia e cola', async () => {
    const res = await enviar({ type: 'pix', amount: 180.4 });
    expect(res.status).toBe(200);
    const m = meta();
    expect(m.cartao.valor).toBe(180.4);
    expect(m.cartao.loja).toBe('Lume Moda');
    expect(m.cartao.chave).toBe('11144477735');
    expect(m.cartao.codigo).toContain('00020126');
  });

  it('link da loja: nome, URL, imagem e descrição da prévia (só https)', async () => {
    dados.loja.logo_url = 'https://r2.getaura.com.br/logo.png';
    dados.loja.tagline = 'Moda feita para você';
    const res = await enviar({ type: 'link_loja' });
    expect(res.status).toBe(200);
    const m = meta();
    expect(m.cartao.loja).toBe('Lume Moda');
    expect(m.cartao.url).toMatch(/\/lumemoda$/);
    expect(m.cartao.imagem).toBe('https://r2.getaura.com.br/logo.png');
    expect(m.cartao.descricao).toBe('Moda feita para você');
  });

  it('link da loja sem logo https e sem texto: imagem e descrição nulas', async () => {
    dados.loja.logo_url = 'http://inseguro/logo.png';
    await enviar({ type: 'link_loja' });
    const m = meta();
    expect(m.cartao.imagem).toBeNull();
    expect(m.cartao.descricao).toBeNull();
  });
});

describe('guardas', () => {
  it('conversa fechada → 422 JANELA_FECHADA, sem chamar a Meta', async () => {
    conversa.last_inbound_at = horas(25);
    const res = await enviar({ type: 'link_loja' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('JANELA_FECHADA');
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('conversa de outra loja → 404', async () => {
    const res = await enviar({ type: 'link_loja' }, '99999999-9999-4999-8999-999999999999');
    expect(res.status).toBe(404);
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('número recusado pela Meta bloqueia', async () => {
    waOutbox.getContact.mockResolvedValue({ invalid_at: new Date().toISOString() });
    const res = await enviar({ type: 'link_loja' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TELEFONE_INVALIDO_META');
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('conta pausada bloqueia', async () => {
    waOutbox.loadPauseReason.mockResolvedValue('CONTA_RESTRITA');
    const res = await enviar({ type: 'link_loja' });
    expect(res.body.code).toBe('PAUSADO');
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('tipo desconhecido → 400', async () => {
    const res = await enviar({ type: 'video' });
    expect(res.status).toBe(400);
  });

  it('a Meta recusa → 502 e a thread não ganha mensagem', async () => {
    wa.graphPost.mockRejectedValue(Object.assign(new Error('boom'), { meta: { code: 131000 } }));
    const res = await enviar({ type: 'link_loja' });
    expect(res.status).toBe(502);
    expect(inseridas).toHaveLength(0);
  });
});
