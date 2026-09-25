// ============================================================
// Vitrine Studio · Fase 4 "Pos-compra com a marca" — backend
//
//   BE-6  /aprovacao/:token e /acompanhar/:token devolvem a marca da loja
//         (`marca`) — e nada a mais do cliente.
//   LINKS aprovacao e acompanhamento no endereco da loja com a chave
//         `vitrine_v2` ligada; desligada, o endereco de sempre.
//
// MOCK POR SQL, NUNCA POR POSICAO. db.query vem do mock global
// (tests/jest.setup.js).
// ============================================================
'use strict';

jest.mock('../src/services/pixService', () => ({ generatePix: jest.fn() }));
jest.mock('../src/services/mpService', () => ({
  createMpPixPayment: jest.fn(), createMpPreference: jest.fn(),
}));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(() => Promise.resolve()),
  notifyManualPixOrder: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/digitalOrderConfirmation', () => ({
  onOrderConfirmed: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { generatePix } = require('../src/services/pixService');
const { limparCache } = require('../src/services/lojaDeTeste');
const { montarMarca, linkDoPosCompra } = require('../src/services/marcaDaLoja');

const CID = 'c0000000-0000-0000-0000-000000000001';
const TOKEN = 'a3f1c2d4e5b6978812ab34cd56ef7890';
const APROV = 'hx7k2mq1hx7k2mq1hx7k2mq1';

const APP_URL_ANTES = process.env.APP_PUBLIC_URL;
beforeAll(() => { process.env.APP_PUBLIC_URL = 'https://app.getaura.com.br'; });
afterAll(() => { process.env.APP_PUBLIC_URL = APP_URL_ANTES; });

function vitrinePadrao(extra = {}) {
  return {
    company_id: CID, slug: 'sheid-mania', site_name: 'Sheid Mania', company_display_name: 'Sheid LTDA',
    logo_url: 'https://r2/logo.png', primary_color: '#D8436F', font_family: 'classic',
    whatsapp: '5512996145447', phone: null, address: 'Av. Dom Pedro I, 553 — Jardim Colonial',
    is_published: true, custom_domain: null, custom_domain_status: null,
    pickup_enabled: true, delivery_enabled: true, delivery_fee: '12.00', pix_key: 'chave@sheid.com',
    studio_settings: { vitrine_v2: true, default_sla_days: 3, max_revisions_included: 2, extra_revision_price: 10 },
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────
// marcaDaLoja — pura
// ─────────────────────────────────────────────────────────────
describe('montarMarca', () => {
  test('so dado da loja, no formato que o app le', () => {
    expect(montarMarca(vitrinePadrao())).toEqual({
      slug: 'sheid-mania', nome: 'Sheid Mania', logo_url: 'https://r2/logo.png',
      primary_color: '#D8436F', font_family: 'classic', whatsapp: '5512996145447',
      url: 'https://loja.getaura.com.br/sheid-mania', vitrine_v2: true,
    });
  });

  test('sem site_name o nome vem da empresa (COALESCE(trade_name, legal_name))', () => {
    expect(montarMarca(vitrinePadrao({ site_name: '  ' })).nome).toBe('Sheid LTDA');
  });

  test('WhatsApp cai para o telefone e para o da aprovacao', () => {
    expect(montarMarca(vitrinePadrao({ whatsapp: null, phone: '1233334444' })).whatsapp).toBe('1233334444');
    expect(montarMarca(vitrinePadrao({
      whatsapp: null, phone: null, studio_settings: { approval_wa_phone: '12999990000' },
    })).whatsapp).toBe('12999990000');
  });

  test('sem vitrine (sem slug) nao ha marca', () => {
    expect(montarMarca(null)).toBeNull();
    expect(montarMarca(vitrinePadrao({ slug: null }))).toBeNull();
  });

  test('dominio proprio ativo vira o endereco da loja', () => {
    const m = montarMarca(vitrinePadrao({ custom_domain: 'www.sheidmania.com.br', custom_domain_status: 'active' }));
    expect(m.url).toBe('https://www.sheidmania.com.br');
  });

  test('tipografia padrao e chave desligada sem studio_settings', () => {
    const m = montarMarca(vitrinePadrao({ font_family: null, studio_settings: null }));
    expect(m.font_family).toBe('classic');
    expect(m.vitrine_v2).toBe(false);
  });
});

describe('linkDoPosCompra', () => {
  test('chave ligada: endereco da loja', () => {
    const config = vitrinePadrao();
    expect(linkDoPosCompra({ config, tipo: 'aprovacao', token: 'abc' }))
      .toBe('https://loja.getaura.com.br/sheid-mania/aprovacao/abc');
    expect(linkDoPosCompra({ config, tipo: 'acompanhar', token: 'abc' }))
      .toBe('https://loja.getaura.com.br/sheid-mania/acompanhar/abc');
  });

  test('chave desligada: o endereco de sempre', () => {
    const config = vitrinePadrao({ studio_settings: {} });
    expect(linkDoPosCompra({ config, tipo: 'acompanhar', token: 'abc' }))
      .toBe('https://app.getaura.com.br/acompanhar/abc');
  });

  test('loja despublicada ou sem vitrine: o endereco de sempre', () => {
    expect(linkDoPosCompra({ config: vitrinePadrao({ is_published: false }), tipo: 'aprovacao', token: 'x' }))
      .toBe('https://app.getaura.com.br/aprovacao/x');
    expect(linkDoPosCompra({ config: null, tipo: 'aprovacao', token: 'x' }))
      .toBe('https://app.getaura.com.br/aprovacao/x');
  });

  test('studioSettings explicito vence o da linha', () => {
    expect(linkDoPosCompra({ config: vitrinePadrao(), studioSettings: {}, tipo: 'aprovacao', token: 'x' }))
      .toBe('https://app.getaura.com.br/aprovacao/x');
  });

  test('dominio proprio ativo', () => {
    const config = vitrinePadrao({ custom_domain: 'www.sheidmania.com.br', custom_domain_status: 'active' });
    expect(linkDoPosCompra({ config, tipo: 'acompanhar', token: 'x' }))
      .toBe('https://www.sheidmania.com.br/acompanhar/x');
  });

  test('tipo desconhecido e erro de programacao', () => {
    expect(() => linkDoPosCompra({ config: null, tipo: 'pedido', token: 'x' })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// BE-6 — GET /aprovacao/:token
// ─────────────────────────────────────────────────────────────
describe('GET /aprovacao/:token', () => {
  const app = express();
  app.use(express.json());
  app.use('/aprovacao', require('../src/routes/studioApprovalPublic'));

  let aprovacao;
  let vitrine;
  let vitrineErro;
  let semToken;

  function linhaDaAprovacao(extra = {}) {
    return {
      id: 'ap1', token: APROV, mockup_url: 'https://r2/mockup.webm', status: 'pending',
      expires_at: new Date(Date.now() + 86400000).toISOString(), response_note: null, responded_at: null,
      message_text: 'Oi Helena', company_id: CID,
      order_id: 'o1', total_amount: '129.70', customer_name: 'Helena Martins', order_number: '00123',
      public_token: TOKEN, trade_name: 'Sheid LTDA', legal_name: 'Sheid Mania LTDA',
      items: [{ product_id: 'p1', product_name: 'Caneca Alça Coração', product_image: 'https://r2/c.jpg', quantity: 1, unit_price: 49.9, customization: {} }],
      revisions: [{ revision_number: 1, mockup_url: 'https://r2/mockup.webm', note: 'Mockup inicial', created_by_type: 'shop', created_at: '2026-09-25' }],
      ajustes_pedidos: 2,
      ...extra,
    };
  }

  beforeEach(() => {
    db.query.mockReset();
    aprovacao = linhaDaAprovacao();
    vitrine = vitrinePadrao();
    vitrineErro = null;
    semToken = false;
    db.query.mockImplementation(async (sql, params = []) => {
      const s = String(sql);
      if (/FROM studio_approval_links a/.test(s)) {
        if (semToken && /public_token/.test(s)) { const e = new Error('col'); e.code = '42703'; throw e; }
        return { rows: aprovacao && params[0] === APROV ? [aprovacao] : [] };
      }
      if (/FROM digital_channel_config dcc/.test(s)) {
        if (vitrineErro) { const e = new Error('x'); e.code = vitrineErro; throw e; }
        return { rows: vitrine ? [vitrine] : [] };
      }
      if (/FROM studio_pricing_rules/.test(s)) return { rows: [] };
      return { rows: [] };
    });
  });

  test('devolve a marca, o placar de revisoes, o prazo e o numero do pedido', async () => {
    const r = await request(app).get(`/aprovacao/${APROV}`);
    expect(r.status).toBe(200);
    expect(r.body.marca).toEqual(expect.objectContaining({
      slug: 'sheid-mania', nome: 'Sheid Mania', primary_color: '#D8436F', font_family: 'classic',
      logo_url: 'https://r2/logo.png', whatsapp: '5512996145447', vitrine_v2: true,
    }));
    expect(r.body.revisoes).toEqual({ inclusas: 2, usadas: 2, valor_extra: 10 });
    expect(r.body.prazo_dias_uteis).toBe(3);
    expect(r.body.order.numero).toBe('00123');
    expect(r.body.acompanhar_token).toBe(TOKEN);
    // O contrato de hoje continua igual.
    expect(r.body.shop).toEqual({ name: 'Sheid LTDA' });
    expect(r.body.order.total_amount).toBe(129.7);
    expect(r.body.status).toBe('pending');
  });

  test('a marca nao traz nada do cliente nem da empresa alem da vitrine', async () => {
    const r = await request(app).get(`/aprovacao/${APROV}`);
    const marca = JSON.stringify(r.body.marca);
    expect(marca).not.toMatch(/Helena|studio_settings|cnpj|address|Dom Pedro|company_id/i);
    expect(Object.keys(r.body.marca).sort()).toEqual(
      ['font_family', 'logo_url', 'nome', 'primary_color', 'slug', 'url', 'vitrine_v2', 'whatsapp']);
  });

  test('empresa sem vitrine: marca null e a pagina abre igual', async () => {
    vitrine = null;
    const r = await request(app).get(`/aprovacao/${APROV}`);
    expect(r.status).toBe(200);
    expect(r.body.marca).toBeNull();
    expect(r.body.revisoes).toEqual({ inclusas: null, usadas: 2, valor_extra: 0 });
  });

  test('vitrine indisponivel (42P01) nao derruba a pagina', async () => {
    vitrineErro = '42P01';
    const r = await request(app).get(`/aprovacao/${APROV}`);
    expect(r.status).toBe(200);
    expect(r.body.marca).toBeNull();
  });

  test('base sem public_token (antes da 322): cai para a consulta sem ele', async () => {
    semToken = true;
    delete aprovacao.public_token;
    const r = await request(app).get(`/aprovacao/${APROV}`);
    expect(r.status).toBe(200);
    expect(r.body.acompanhar_token).toBeNull();
  });

  test('link que nao existe continua 404', async () => {
    const r = await request(app).get('/aprovacao/nao-existe-mesmo-123');
    expect(r.status).toBe(404);
  });
});

describe('POST /aprovacao/:token/respond — referencia do ajuste', () => {
  const app = express();
  app.use(express.json());
  app.use('/aprovacao', require('../src/routes/studioApprovalPublic'));
  const rota = require('../src/routes/studioApprovalPublic');

  let gravadas;
  beforeEach(() => {
    gravadas = [];
    db.connect.mockReset();
    db.connect.mockImplementation(() => ({
      query: jest.fn(async (sql, params) => {
        const s = String(sql);
        if (/FROM studio_approval_links WHERE token/.test(s)) {
          return { rows: [{ id: 'ap1', company_id: CID, order_id: 'o1', status: 'pending', expires_at: new Date(Date.now() + 86400000).toISOString() }] };
        }
        if (/COALESCE\(MAX\(revision_number\)/.test(s)) return { rows: [{ next: 2 }] };
        if (/UPDATE studio_approval_links/.test(s) || /INSERT INTO studio_approval_revisions/.test(s)) gravadas.push({ sql: s, params });
        return { rows: [] };
      }),
      release: jest.fn(),
    }));
  });

  test('a referencia vai junto da nota que a lojista ja le', async () => {
    const r = await request(app).post(`/aprovacao/${APROV}/respond`).send({
      action: 'request_changes', note: 'Deixar o nome maior', referencia_url: 'https://r2.getaura.com.br/ref.png',
    });
    expect(r.status).toBe(200);
    const upd = gravadas.find((g) => /UPDATE studio_approval_links/.test(g.sql));
    expect(upd.params[1]).toBe('Deixar o nome maior\nReferência: https://r2.getaura.com.br/ref.png');
  });

  test('endereco que nao e https e ignorado', async () => {
    await request(app).post(`/aprovacao/${APROV}/respond`).send({
      action: 'request_changes', note: 'Mais rosa', referencia_url: 'javascript:alert(1)',
    });
    const upd = gravadas.find((g) => /UPDATE studio_approval_links/.test(g.sql));
    expect(upd.params[1]).toBe('Mais rosa');
  });

  test('nota longa e cortada no texto, nunca no endereco', () => {
    const ref = 'https://r2.getaura.com.br/ref.png';
    const nota = rota._notaComReferencia('x'.repeat(2000), ref);
    expect(nota.length).toBeLessThanOrEqual(1000);
    expect(nota.endsWith('Referência: ' + ref)).toBe(true);
  });

  test('aprovar ignora a referencia', async () => {
    await request(app).post(`/aprovacao/${APROV}/respond`).send({
      action: 'approve', referencia_url: 'https://r2.getaura.com.br/ref.png',
    });
    const upd = gravadas.find((g) => /UPDATE studio_approval_links/.test(g.sql));
    expect(upd.params[1]).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// BE-6 — GET /acompanhar/:token (pedido da vitrine)
// ─────────────────────────────────────────────────────────────
describe('GET /acompanhar/:token — pedido da vitrine com a marca', () => {
  const app = express();
  app.use('/acompanhar', require('../src/routes/studioTrackPublic'));

  let pedido;
  let aprovacaoPendente;
  let venda;
  beforeEach(() => {
    db.query.mockReset();
    venda = null;
    aprovacaoPendente = { token: APROV };
    pedido = {
      id: 'o1', order_number: '00123', company_id: CID, created_at: '2026-09-25T12:00:00Z', total: '129.70',
      status: 'confirmed', studio_production_status: 'pending_art', customer_name: 'Helena Martins',
      delivery_type: 'pickup', loja: 'Sheid LTDA', imagem: 'https://r2/c.jpg',
      itens: [{
        nome: 'Caneca Alça Coração', qtd: 1, imagem: 'https://r2/c.jpg',
        customization: { nome: 'Mãe', foto: 'https://r2/uploads/foto-da-helena.png', has_back_selected: true },
        customization_config: { fields: [{ id: 'nome', type: 'text', label: 'Nome' }, { id: 'foto', type: 'image', label: 'Foto' }], has_back: true },
      }],
    };
    db.query.mockImplementation(async (sql, params = []) => {
      const s = String(sql);
      if (/FROM sales s/.test(s)) return { rows: venda ? [venda] : [] };
      if (/FROM digital_orders o/.test(s)) return { rows: pedido && params[0] === TOKEN ? [pedido] : [] };
      if (/FROM studio_approval_links/.test(s)) return { rows: aprovacaoPendente ? [aprovacaoPendente] : [] };
      if (/FROM digital_channel_config dcc/.test(s)) return { rows: [vitrinePadrao()] };
      if (/FROM credit_installments/.test(s)) return { rows: [] };
      return { rows: [] };
    });
  });

  test('marca, origem, aprovacao em aberto e onde retirar', async () => {
    const r = await request(app).get(`/acompanhar/${TOKEN}`);
    expect(r.status).toBe(200);
    // `loja` continua texto: o app de hoje (e o Matcon) le assim.
    expect(r.body.loja).toBe('Sheid LTDA');
    expect(r.body.marca).toEqual(expect.objectContaining({ slug: 'sheid-mania', nome: 'Sheid Mania', vitrine_v2: true }));
    expect(r.body.origem).toBe('vitrine');
    expect(r.body.aprovacao).toEqual({ token: APROV });
    expect(r.body.retirada_endereco).toBe('Av. Dom Pedro I, 553 — Jardim Colonial');
    expect(r.body.entregue).toBe(false);
    expect(r.body.etapa_atual).toBe(1);
  });

  test('itens com foto e resumo — sem o customization bruto (endereco do arquivo)', async () => {
    const r = await request(app).get(`/acompanhar/${TOKEN}`);
    expect(r.body.itens).toEqual([{
      nome: 'Caneca Alça Coração', qtd: 1, imagem: 'https://r2/c.jpg',
      resumo: ['Frente e verso', 'Nome: Mãe', 'Arte enviada'],
    }]);
    expect(JSON.stringify(r.body)).not.toMatch(/foto-da-helena|Martins/);
  });

  test('entregue e entrega em casa (sem endereco de retirada)', async () => {
    pedido.studio_production_status = 'delivered';
    pedido.delivery_type = 'delivery';
    const r = await request(app).get(`/acompanhar/${TOKEN}`);
    expect(r.body.entregue).toBe(true);
    expect(r.body.retirada_endereco).toBeNull();
    expect(r.body.etapa_atual).toBe(3);
  });

  test('pedido cancelado tambem leva a marca (a pagina de cancelado fala com a voz da loja)', async () => {
    pedido.status = 'cancelled';
    const r = await request(app).get(`/acompanhar/${TOKEN}`);
    expect(r.body.cancelado).toBe(true);
    expect(r.body.marca).toEqual(expect.objectContaining({ slug: 'sheid-mania' }));
  });

  test('encomenda do balcao tambem ganha a marca, e o formato de hoje fica', async () => {
    venda = {
      id: 'aaaaaaaa-0000-0000-0000-000000000001', company_id: CID, created_at: '2026-09-20', total_amount: '80',
      status: 'completed', studio_production_status: 'in_production', promised_date: null,
      customer_name: 'Ana Souza', loja: 'Sheid LTDA', itens: [{ nome: 'Caneca', qtd: 2 }], imagem: null,
    };
    const r = await request(app).get(`/acompanhar/${TOKEN}`);
    expect(r.body.loja).toBe('Sheid LTDA');
    expect(r.body.marca).toEqual(expect.objectContaining({ slug: 'sheid-mania' }));
    expect(r.body.origem).toBeUndefined();
    expect(r.body.itens).toEqual([{ nome: 'Caneca', qtd: 2 }]);
  });
});

// ─────────────────────────────────────────────────────────────
// LINKS — KDS, pedido e confirmacao
// ─────────────────────────────────────────────────────────────
describe('link de aprovacao gerado pelo painel', () => {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/studio', require('../src/routes/studioKdsApproval'));

  let vitrine;
  beforeEach(() => {
    db.query.mockReset();
    vitrine = vitrinePadrao();
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM studio_orders/.test(s)) return { rows: [{ source: 'digital', digital_order_id: 'o1' }] };
      if (/FROM digital_orders o/.test(s)) return { rows: [{ id: 'o1', customer_name: 'Helena Martins', customer_phone: '12999990000', display_name: 'Helena Martins', trade_name: 'Sheid LTDA' }] };
      if (/SELECT 1 FROM studio_approval_links/.test(s)) return { rows: [] };
      if (/FROM digital_channel_config dcc/.test(s)) return { rows: vitrine ? [vitrine] : [] };
      if (/INSERT INTO studio_approval_links/.test(s)) return { rows: [{ id: 'ap1', token: 'tok', status: 'pending' }] };
      return { rows: [] };
    });
  });
  const pedir = () => request(app).post(`/companies/${CID}/studio/orders/so1/approval`)
    .send({ mockup_url: 'https://r2/mockup.png' });

  test('chave ligada: o link vai para o endereco da loja', async () => {
    const r = await pedir();
    expect(r.status).toBe(201);
    expect(r.body.approval_url).toMatch(/^https:\/\/loja\.getaura\.com\.br\/sheid-mania\/aprovacao\/[\w-]+$/);
    expect(r.body.message_text).toContain(r.body.approval_url);
  });

  test('chave desligada: o endereco de sempre', async () => {
    vitrine = vitrinePadrao({ studio_settings: {} });
    const r = await pedir();
    expect(r.body.approval_url).toMatch(/^https:\/\/app\.getaura\.com\.br\/aprovacao\/[\w-]+$/);
  });

  test('empresa sem vitrine: o endereco de sempre', async () => {
    vitrine = null;
    const r = await pedir();
    expect(r.body.approval_url).toMatch(/^https:\/\/app\.getaura\.com\.br\/aprovacao\//);
  });
});

describe('track_url do pedido e acompanhar_url da confirmacao', () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/storefront', require('../src/routes/studioStorefront'));

  let loja;
  beforeEach(() => {
    db.query.mockReset();
    db.connect.mockReset();
    generatePix.mockReset();
    limparCache();
    loja = vitrinePadrao();
    generatePix.mockImplementation(async ({ order, total }) => ({
      payment_id: 'manual-' + order.id, qrcode: null, payload: `000201PIX-${total}`, expires_at: null, mode: 'manual',
    }));
    db.query.mockImplementation(async (sql, params = []) => {
      const s = String(sql);
      if (/is_sandbox/.test(s)) return { rows: [{ is_sandbox: false }] };
      if (/FROM digital_channel_config/.test(s)) return { rows: [loja] };
      if (/FROM products/.test(s)) {
        return { rows: [{ id: 'p2', name: 'Caneca Branca', price: '39.90', stock_qty: 10, image_url: 'https://r2/b.jpg',
          is_active: true, is_personalizable: true, customization_config: { fields: [] } }] };
      }
      if (/FROM digital_orders o/.test(s) && /public_token = \$1/.test(s)) {
        return { rows: params[0] === TOKEN ? [{ id: 'o1', company_id: CID, order_number: '00123', created_at: new Date().toISOString(),
          customer_name: 'Helena', status: 'confirmed', payment_status: 'paid', payment_method: 'pix', subtotal: 39.9,
          delivery_fee: 0, total: 39.9, delivery_type: 'pickup', studio_production_status: 'pending_art' }] : [] };
      }
      return { rows: [] };
    });
    db.connect.mockImplementation(() => ({
      query: jest.fn(async (sql) => {
        if (/INSERT INTO digital_orders/.test(String(sql))) {
          return { rows: [{ id: 'o1', order_number: '00123', company_id: CID, public_token: TOKEN, created_at: new Date().toISOString() }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const pedir = () => request(app).post('/storefront/sheid-mania/studio/order').send({
    customer_name: 'Helena Martins', customer_phone: '12999990000', payment_method: 'pix', delivery_type: 'pickup',
    items: [{ product_id: 'p2', quantity: 1, customization: {} }],
  });

  test('chave ligada: track_url no endereco da loja', async () => {
    const r = await pedir();
    expect(r.status).toBe(201);
    expect(r.body.track_url).toBe(`https://loja.getaura.com.br/sheid-mania/acompanhar/${TOKEN}`);
  });

  test('chave desligada: track_url no endereco de sempre', async () => {
    loja = vitrinePadrao({ studio_settings: {} });
    const r = await pedir();
    expect(r.body.track_url).toBe(`https://app.getaura.com.br/acompanhar/${TOKEN}`);
  });

  test('a confirmacao leva o acompanhar para a loja com a chave ligada', async () => {
    const r = await request(app).get(`/storefront/sheid-mania/studio/pedido/${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body.acompanhar_url).toBe(`https://loja.getaura.com.br/sheid-mania/acompanhar/${TOKEN}`);
    loja = vitrinePadrao({ studio_settings: {} });
    const r2 = await request(app).get(`/storefront/sheid-mania/studio/pedido/${TOKEN}`);
    expect(r2.body.acompanhar_url).toBe(`https://app.getaura.com.br/acompanhar/${TOKEN}`);
  });
});

