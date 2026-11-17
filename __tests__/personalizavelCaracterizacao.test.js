// ============================================================
// p-174 (loja unica 3.4a) — caracterizacao da vitrine Studio
//
// Este arquivo foi escrito ANTES de mover a validacao da customization,
// a cotacao do item personalizado e o status inicial da arte para
// services/personalizavel.js. Ele congela o que a vitrine Studio faz
// HOJE: as mesmas entradas tem de dar as mesmas mensagens, os mesmos
// precos e o mesmo art_review_status depois da mudanca.
//
// Tres camadas:
//   1. a validacao pura (export de teste da rota);
//   2. POST /studio/cotacao e POST /studio/order de ponta a ponta, com o
//      banco mockado por SQL (nunca por posicao) — resposta, mensagem,
//      `indice`, e os parametros do INSERT de digital_order_items;
//   3. depois da mudanca: o servico novo responde igual a rota, caso a
//      caso, e a rota usa as funcoes dele (nao uma copia).
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
jest.mock('../src/services/shippingQuote', () => ({ calculateShippingQuote: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { generatePix } = require('../src/services/pixService');
const { limparCache } = require('../src/services/lojaDeTeste');

const validarDaRota = require('../src/routes/studioStorefront').__validateCustomizationValues;

const CID = 'c0000000-0000-0000-0000-000000000174';

// ─────────────────────────────────────────────────────────────
// 1. Validacao da customization contra o customization_config
// ─────────────────────────────────────────────────────────────
const TEXTO_OBRIG = { id: 'nome', type: 'text', label: 'Nome', required: true };
const TEXTO_SEM_LABEL = { id: 'f9', type: 'text', required: true };
const FOTO_OBRIG = { id: 'foto', type: 'image', label: 'Foto', required: true };
const GALERIA = { id: 'tpl', type: 'template', label: 'Galeria' };
const GALERIA_OBRIG = { ...GALERIA, required: true };
const COR_OBRIG = { id: 'cor', type: 'color', label: 'Cor', required: true };
const SERVICO_ARTE = {
  id: 'art_service', type: 'option', label: 'Arte',
  config: { is_art_service: true, choices: [
    { value: 'none', label: 'Envio pronta', price_delta: 0 },
    { value: 'adjust', label: 'Ajustem', price_delta: 10 },
    { value: 'designer', label: 'Criem', price_delta: 30 },
  ] },
};
const FOTO_VERSO = { id: 'foto_v', type: 'image', label: 'Foto do verso', side: 'back', required: true };
const TEXTO_VERSO = { id: 'txt_v', type: 'text', label: 'Texto do verso', side: 'back', required: true };
const FOTO_MEIO = { id: 'foto_m', type: 'image', label: 'Foto do meio', side: 'middle', required: true };

// [descricao, config, values, mensagem esperada (null = aceita)]
const CASOS_DE_VALIDACAO = [
  ['config nulo: produto nao personalizavel', null, { a: 1 }, null],
  ['config que nao e objeto', 'x', { a: 1 }, null],
  ['customization ausente', { fields: [] }, undefined, 'customization obrigatoria'],
  ['customization nula', { fields: [] }, null, 'customization obrigatoria'],
  ['customization string', { fields: [] }, 'texto', 'customization obrigatoria'],
  ['customization lista vazia passa (typeof object)', { fields: [TEXTO_OBRIG] }, [], 'campo "Nome" obrigatorio'],
  ['config sem fields', { has_back: true }, {}, null],
  ['fields que nao e lista', { fields: 'x' }, {}, null],
  ['campo obrigatorio vazio', { fields: [TEXTO_OBRIG] }, {}, 'campo "Nome" obrigatorio'],
  ['campo obrigatorio so com espacos', { fields: [TEXTO_OBRIG] }, { nome: '   ' }, 'campo "Nome" obrigatorio'],
  ['campo obrigatorio preenchido', { fields: [TEXTO_OBRIG] }, { nome: 'Ana' }, null],
  ['zero conta como preenchido', { fields: [TEXTO_OBRIG] }, { nome: 0 }, null],
  ['false conta como preenchido', { fields: [TEXTO_OBRIG] }, { nome: false }, null],
  ['sem label cita o id', { fields: [TEXTO_SEM_LABEL] }, {}, 'campo "f9" obrigatorio'],
  ['entrada nula na lista de campos e ignorada', { fields: [null, TEXTO_OBRIG] }, { nome: 'Ana' }, null],
  ['campo opcional vazio passa', { fields: [{ id: 'x', type: 'text', label: 'X' }] }, {}, null],
  ['foto obrigatoria sozinha', { fields: [FOTO_OBRIG] }, {}, 'informe a arte em "Foto"'],
  ['grupo foto ou galeria: nenhum', { fields: [FOTO_OBRIG, GALERIA] }, {}, 'informe a arte em "Foto" ou "Galeria"'],
  ['grupo foto ou galeria: galeria basta', { fields: [FOTO_OBRIG, GALERIA_OBRIG] }, { tpl: 'tpl-1' }, null],
  ['grupo foto ou galeria: foto basta', { fields: [FOTO_OBRIG, GALERIA_OBRIG] }, { foto: 'https://r2/a.png' }, null],
  ['grupo sem nenhum obrigatorio nao exige', { fields: [{ ...FOTO_OBRIG, required: false }, GALERIA] }, {}, null],
  ['arte vem antes dos outros campos', { fields: [TEXTO_OBRIG, FOTO_OBRIG] }, {}, 'informe a arte em "Foto"'],
  ['outros campos na ordem do config', { fields: [COR_OBRIG, TEXTO_OBRIG] }, {}, 'campo "Cor" obrigatorio'],
  ['criem minha arte dispensa a foto', { fields: [SERVICO_ARTE, FOTO_OBRIG] }, { art_service: 'designer' }, null],
  ['ajustem a arte ainda exige a foto', { fields: [SERVICO_ARTE, FOTO_OBRIG] }, { art_service: 'adjust' }, 'informe a arte em "Foto"'],
  ['criem minha arte nao dispensa texto obrigatorio', { fields: [SERVICO_ARTE, FOTO_OBRIG, TEXTO_OBRIG] }, { art_service: 'designer' }, 'campo "Nome" obrigatorio'],
  ['verso sem has_back: campo do verso ignorado', { fields: [FOTO_VERSO] }, {}, null],
  ['verso gratis: sempre ativo', { has_back: true, fields: [FOTO_VERSO] }, {}, 'informe a arte em "Foto do verso"'],
  ['verso cobrado e nao escolhido: ignorado', { has_back: true, back_charge_enabled: true, fields: [FOTO_VERSO] }, {}, null],
  ['verso cobrado e escolhido: exigido', { has_back: true, back_charge_enabled: true, fields: [FOTO_VERSO] }, { has_back_selected: true }, 'informe a arte em "Foto do verso"'],
  ['verso escolhido como "true" (texto) nao conta', { has_back: true, back_charge_enabled: true, fields: [FOTO_VERSO] }, { has_back_selected: 'true' }, null],
  ['texto do verso ativo', { has_back: true, fields: [TEXTO_VERSO] }, {}, 'campo "Texto do verso" obrigatorio'],
  ['frente antes do verso', { has_back: true, fields: [FOTO_VERSO, FOTO_OBRIG] }, {}, 'informe a arte em "Foto"'],
  ['meio sem has_middle: ignorado', { fields: [FOTO_MEIO] }, {}, null],
  ['meio gratis: sempre ativo', { has_middle: true, fields: [FOTO_MEIO] }, {}, 'informe a arte em "Foto do meio"'],
  ['meio cobrado e nao escolhido: ignorado', { has_middle: true, middle_charge_enabled: true, fields: [FOTO_MEIO] }, {}, null],
  ['meio cobrado e escolhido: exigido', { has_middle: true, middle_charge_enabled: true, fields: [FOTO_MEIO] }, { has_middle_selected: true }, 'informe a arte em "Foto do meio"'],
  ['verso antes do meio', { has_back: true, has_middle: true, fields: [FOTO_MEIO, FOTO_VERSO] }, {}, 'informe a arte em "Foto do verso"'],
  ['servico de arte no verso inativo nao dispensa a frente',
    { has_back: true, back_charge_enabled: true, fields: [{ ...SERVICO_ARTE, side: 'back' }, FOTO_OBRIG] },
    { art_service: 'designer' }, 'informe a arte em "Foto"'],
  ['grupo por lado: foto da frente nao cobre o verso',
    { has_back: true, fields: [FOTO_OBRIG, FOTO_VERSO] }, { foto: 'u' }, 'informe a arte em "Foto do verso"'],
  ['side desconhecido conta como frente', { fields: [{ ...FOTO_OBRIG, side: 'lateral' }] }, {}, 'informe a arte em "Foto"'],
];

describe('1. validacao da customization (comportamento de hoje)', () => {
  test.each(CASOS_DE_VALIDACAO)('%s', (_d, config, values, esperado) => {
    expect(validarDaRota(config, values)).toBe(esperado);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Rotas de ponta a ponta: cotacao e pedido
// ─────────────────────────────────────────────────────────────
const PRODUTOS = {
  // Caneca com tudo: opcao com preco, verso e meio cobrados, servico de
  // arte, foto obrigatoria e texto opcional.
  p1: {
    id: 'p1', name: 'Caneca Completa', price: '50.00', stock_qty: 0, image_url: 'https://r2/p1.jpg',
    is_active: true, is_personalizable: true,
    customization_config: {
      fields: [
        SERVICO_ARTE,
        { id: 'cor', type: 'option', label: 'Cor', config: { choices: [
          { value: 'rosa', label: 'Rosa', price_delta: 2.5 }, { value: 'branca', label: 'Branca', price_delta: 0 },
        ] } },
        { id: 'nome', type: 'text', label: 'Nome' },
        FOTO_OBRIG,
      ],
      has_back: true, back_charge_enabled: true, back_price_delta: 8,
      has_middle: true, middle_charge_enabled: true, middle_price_delta: 4,
    },
  },
  // So texto obrigatorio, sem arte: art_review_status sempre nulo.
  p2: {
    id: 'p2', name: 'Chaveiro', price: '19.90', stock_qty: 3, image_url: null,
    is_active: true, is_personalizable: true,
    customization_config: { fields: [TEXTO_OBRIG] },
  },
  p3: {
    id: 'p3', name: 'Camiseta Lisa', price: '30.00', stock_qty: 5, image_url: null,
    is_active: true, is_personalizable: false, customization_config: null,
  },
  p4: {
    id: 'p4', name: 'Caneca Antiga', price: '30.00', stock_qty: 0, image_url: null,
    is_active: false, is_personalizable: true, customization_config: { fields: [] },
  },
  // Personalizavel sem config: nada a validar, nada a triar.
  p5: {
    id: 'p5', name: 'Bloco', price: '12.00', stock_qty: 0, image_url: null,
    is_active: true, is_personalizable: true, customization_config: null,
  },
};

let loja;
let regras;
let inserts;

function lojaPadrao() {
  return {
    company_id: CID, slug: 'loja-174', site_name: 'Loja 174', company_display_name: 'Loja 174 LTDA',
    pickup_enabled: true, delivery_enabled: false, delivery_fee: '0',
    pix_key: 'chave@loja.com', pix_discount_pct: 0, pay_on_delivery_enabled: true,
    is_published: true,
    studio_settings: { default_sla_days: 3 },
  };
}

function mockBanco() {
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql);
    if (/is_sandbox/.test(s)) return { rows: [{ is_sandbox: false }] };
    if (/FROM digital_channel_config/.test(s)) return { rows: loja ? [loja] : [] };
    if (/FROM companies_payment_gateways/.test(s)) return { rows: [] };
    if (/FROM studio_pricing_rules/.test(s)) return { rows: regras };
    if (/FROM products/.test(s)) {
      const ids = params[0] || [];
      return { rows: ids.map((id) => PRODUTOS[id]).filter(Boolean) };
    }
    return { rows: [] };
  });
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO digital_orders/.test(s)) {
        return { rows: [{ id: 'o1', order_number: '00174', company_id: CID, public_token: 'tok', created_at: new Date().toISOString() }] };
      }
      if (/INSERT INTO digital_order_items/.test(s)) inserts.push({ sql: s, params });
      return { rows: [] };
    }),
    release: jest.fn(),
  }));
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/storefront', require('../src/routes/studioStorefront'));

const CLIENTE = { customer_name: 'Cliente Teste', customer_phone: '12999990000' };
const cotar = (items, extra = {}) =>
  request(app).post('/storefront/loja-174/studio/cotacao').send({ items, ...extra });
const pedir = (items, extra = {}) =>
  request(app).post('/storefront/loja-174/studio/order')
    .send({ ...CLIENTE, payment_method: 'on_delivery', delivery_type: 'pickup', items, ...extra });

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  generatePix.mockReset();
  limparCache();
  loja = lojaPadrao();
  regras = [];
  inserts = [];
  mockBanco();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

// Itens recusados: a mesma mensagem e o mesmo indice na cotacao, e a
// mesma mensagem (sem indice) no pedido.
const RECUSAS = [
  ['produto que nao existe', [{ product_id: 'p2', quantity: 1, customization: { nome: 'A' } }, { product_id: 'zz', quantity: 1 }],
    'Produto zz nao encontrado', 1],
  ['produto inativo', [{ product_id: 'p4', quantity: 1, customization: {} }],
    'Produto "Caneca Antiga" nao esta disponivel', 0],
  ['produto de prateleira', [{ product_id: 'p3', quantity: 1 }],
    'Produto "Camiseta Lisa" nao e personalizavel — use /storefront/:slug/order', 0],
  ['quantidade negativa', [{ product_id: 'p2', quantity: -2, customization: { nome: 'A' } }],
    'Quantidade invalida para "Chaveiro"', 0],
  ['customization ausente', [{ product_id: 'p2', quantity: 1 }],
    'Personalizacao de "Chaveiro": customization obrigatoria', 0],
  ['campo obrigatorio', [{ product_id: 'p2', quantity: 1, customization: { nome: ' ' } }],
    'Personalizacao de "Chaveiro": campo "Nome" obrigatorio', 0],
  ['arte faltando na segunda linha', [
    { product_id: 'p2', quantity: 1, customization: { nome: 'A' } },
    { product_id: 'p1', quantity: 1, customization: { art_service: 'adjust' } },
  ], 'Personalizacao de "Caneca Completa": informe a arte em "Foto"', 1],
];

describe('2a. cotacao e pedido recusam com a mesma mensagem de hoje', () => {
  test.each(RECUSAS)('cotacao: %s', async (_d, items, msg, indice) => {
    const r = await cotar(items);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: msg, indice });
  });
  test.each(RECUSAS)('pedido: %s', async (_d, items, msg) => {
    const r = await pedir(items);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: msg });
    expect(inserts).toHaveLength(0);
  });
});

// Itens aceitos: preco da cotacao e o que vai ao INSERT do item.
// [descricao, item, cotacao esperada {preco_unitario,total,detalhe}, INSERT esperado {unit_price, quantity, subtotal, customization, art_review_status}]
const ACEITOS = [
  ['caneca com foto, cor rosa, verso e meio, ajuste da arte, 2 un',
    { product_id: 'p1', quantity: 2, customization: {
      art_service: 'adjust', cor: 'rosa', foto: 'https://r2/f.png',
      has_back_selected: true, has_middle_selected: true,
    } },
    { preco_unitario: 64.5, total: 139, detalhe: { base: 50, opcoes: 2.5, verso: 8, meio: 4, arte: 10, faixa: null } },
    { unit_price: 64.5, quantity: 2, subtotal: 139,
      customization: { art_service: 'adjust', cor: 'rosa', foto: 'https://r2/f.png', has_back_selected: true, has_middle_selected: true },
      art_review_status: 'pendente' }],
  ['caneca com "criem minha arte": sem foto, sem triagem',
    { product_id: 'p1', quantity: 3, customization: { art_service: 'designer', cor: 'branca' } },
    { preco_unitario: 50, total: 180, detalhe: { base: 50, opcoes: 0, verso: 0, meio: 0, arte: 30, faixa: null } },
    { unit_price: 50, quantity: 3, subtotal: 180,
      customization: { art_service: 'designer', cor: 'branca' }, art_review_status: null }],
  ['"criem minha arte" com foto de referencia: ainda sem triagem',
    { product_id: 'p1', quantity: 1, customization: { art_service: 'designer', foto: 'https://r2/ref.png' } },
    { preco_unitario: 50, total: 80, detalhe: { base: 50, opcoes: 0, verso: 0, meio: 0, arte: 30, faixa: null } },
    { unit_price: 50, quantity: 1, subtotal: 80,
      customization: { art_service: 'designer', foto: 'https://r2/ref.png' }, art_review_status: null }],
  ['quantidade 0 vira 1; ajuste da arte malformado sai, o valido fica',
    { product_id: 'p1', quantity: 0, customization: {
      art_service: 'none', foto: 'https://r2/f.png',
      foto_ajuste: { v: 1, cx: 0.5, cy: 0.5, larg: 0.8, rot: 45 },
      nome_ajuste: 'lixo', nome_tam: 'XG', nome_fonte: 'Arial',
      chave_desconhecida: 'passa',
    } },
    { preco_unitario: 50, total: 50, detalhe: { base: 50, opcoes: 0, verso: 0, meio: 0, arte: 0, faixa: null } },
    { unit_price: 50, quantity: 1, subtotal: 50,
      customization: {
        art_service: 'none', foto: 'https://r2/f.png',
        foto_ajuste: { v: 1, cx: 0.5, cy: 0.5, larg: 0.8, rot: 0 },
        nome_fonte: 'Arial',
        chave_desconhecida: 'passa',
      },
      art_review_status: 'pendente' }],
  ['so texto: sem triagem',
    { product_id: 'p2', quantity: '4', customization: { nome: 'Ana' } },
    { preco_unitario: 19.9, total: 79.6, detalhe: { base: 19.9, opcoes: 0, verso: 0, meio: 0, arte: 0, faixa: null } },
    { unit_price: 19.9, quantity: 4, subtotal: 79.6, customization: { nome: 'Ana' }, art_review_status: null }],
  ['personalizavel sem config e sem customization',
    { product_id: 'p5', quantity: 2 },
    { preco_unitario: 12, total: 24, detalhe: { base: 12, opcoes: 0, verso: 0, meio: 0, arte: 0, faixa: null } },
    { unit_price: 12, quantity: 2, subtotal: 24, customization: null, art_review_status: null }],
];

describe('2b. cotacao: precos de hoje', () => {
  test.each(ACEITOS)('%s', async (_d, item, cot) => {
    const r = await cotar([item]);
    expect(r.status).toBe(200);
    expect(r.body.itens).toEqual([{ indice: 0, ...cot }]);
    expect(r.body.subtotal).toBe(cot.total);
  });

  test('faixa de quantidade incide sobre o preco de tabela, deltas depois', async () => {
    regras = [{ product_id: 'p1', qty_tiers: [{ min_qty: 10, unit_price: 40 }] }];
    const item = { product_id: 'p1', quantity: 10, customization: { art_service: 'none', cor: 'rosa', foto: 'u' } };
    const r = await cotar([item]);
    expect(r.status).toBe(200);
    expect(r.body.itens).toEqual([{ indice: 0, preco_unitario: 42.5, total: 425,
      detalhe: { base: 40, opcoes: 2.5, verso: 0, meio: 0, arte: 0, faixa: { min_qty: 10, pct: 20 } } }]);
    // abaixo da faixa: preco de tabela
    const r9 = await cotar([{ ...item, quantity: 9 }]);
    expect(r9.body.itens[0]).toEqual({ indice: 0, preco_unitario: 52.5, total: 472.5,
      detalhe: { base: 50, opcoes: 2.5, verso: 0, meio: 0, arte: 0, faixa: null } });
    // regra global (product_id nulo) vale para quem nao tem regra propria
    regras = [{ product_id: null, qty_tiers: [{ min_qty: 2, unit_price: 15 }] }];
    const rg = await cotar([{ product_id: 'p2', quantity: 2, customization: { nome: 'A' } }]);
    expect(rg.body.itens[0].preco_unitario).toBe(15);
    expect(rg.body.itens[0].total).toBe(30);
  });

  test('pedido com faixa grava o preco da faixa', async () => {
    regras = [{ product_id: 'p1', qty_tiers: [{ min_qty: 10, unit_price: 40 }] }];
    const r = await pedir([{ product_id: 'p1', quantity: 10, customization: { art_service: 'none', cor: 'rosa', foto: 'u' } }]);
    expect(r.status).toBe(201);
    expect(inserts[0].params[4]).toBeCloseTo(42.5, 10);
    expect(inserts[0].params[6]).toBeCloseTo(425, 10);
    expect(inserts[0].params[8]).toBe('pendente');
  });
});

describe('2c. pedido: o INSERT de digital_order_items de hoje', () => {
  test.each(ACEITOS)('%s', async (_d, item, _cot, ins) => {
    const r = await pedir([item]);
    expect(r.status).toBe(201);
    expect(inserts).toHaveLength(1);
    const [orderId, productId, productName, productImage, unitPrice, quantity, subtotal, customization, artStatus] = inserts[0].params;
    expect(orderId).toBe('o1');
    expect(productId).toBe(item.product_id);
    expect(productName).toBe(PRODUTOS[item.product_id].name);
    expect(productImage).toBe(PRODUTOS[item.product_id].image_url);
    expect(unitPrice).toBeCloseTo(ins.unit_price, 10);
    expect(quantity).toBe(ins.quantity);
    expect(subtotal).toBeCloseTo(ins.subtotal, 10);
    expect(customization == null ? null : JSON.parse(customization)).toEqual(ins.customization);
    expect(artStatus).toBe(ins.art_review_status);
  });

  test('o SQL do INSERT do item nao muda', async () => {
    await pedir([ACEITOS[0][1]]);
    expect(inserts[0].sql.replace(/\s+/g, ' ').trim()).toBe(
      'INSERT INTO digital_order_items (order_id, product_id, product_name, product_image, unit_price, quantity, subtotal, customization, art_review_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)'
    );
  });

  test('pedido de varias linhas: uma linha por item, na ordem, total somado', async () => {
    const items = ACEITOS.map(([, item]) => item);
    const r = await pedir(items);
    expect(r.status).toBe(201);
    expect(inserts.map((i) => i.params[8])).toEqual(ACEITOS.map(([, , , ins]) => ins.art_review_status));
    const soma = ACEITOS.reduce((s, [, , , ins]) => s + ins.subtotal, 0);
    expect(inserts.reduce((s, i) => s + i.params[6], 0)).toBeCloseTo(soma, 10);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. O servico comum (services/personalizavel.js) e a regra da rota
// ─────────────────────────────────────────────────────────────
describe('3. services/personalizavel.js', () => {
  const svc = require('../src/services/personalizavel');
  const { initialArtStatus } = require('../src/services/artReview');
  const { cotarItens } = require('../src/services/precoDoStudio');
  const { sanitizarAjustesDaArte } = require('../src/services/ajusteDaArte');

  test('a rota usa a validacao do servico, nao uma copia', () => {
    expect(validarDaRota).toBe(svc.validateCustomizationValues);
    expect(svc.validarPersonalizacao).toBe(svc.validateCustomizationValues);
  });

  test.each(CASOS_DE_VALIDACAO)('validarPersonalizacao: %s', (_d, config, values, esperado) => {
    expect(svc.validarPersonalizacao(config, values)).toBe(esperado);
  });

  // A mesma conta que a rota fazia antes: cotarItens com a validacao e a
  // limpeza do ajuste da arte injetadas.
  const comoAntes = (items, faixas) => cotarItens({
    items, produtos: PRODUTOS, faixas,
    validar: svc.validateCustomizationValues, sanear: sanitizarAjustesDaArte,
  });

  test.each(RECUSAS)('cotarPersonalizados recusa igual: %s', (_d, items, msg, indice) => {
    expect(svc.cotarPersonalizados({ items, produtos: PRODUTOS, faixas: {} })).toEqual({ erro: msg, indice });
    expect(comoAntes(items, {})).toEqual({ erro: msg, indice });
  });

  test.each(ACEITOS)('cotarPersonalizados precifica igual: %s', (_d, item, cot, ins) => {
    const r = svc.cotarPersonalizados({ items: [item], produtos: PRODUTOS, faixas: {} });
    expect(r).toEqual(comoAntes([item], {}));
    expect(r.linhas[0].preco.preco_unitario).toBeCloseTo(cot.preco_unitario, 10);
    expect(r.linhas[0].preco.total).toBeCloseTo(cot.total, 10);
    expect(r.linhas[0].customization).toEqual(ins.customization);
  });

  test('cotarPersonalizados com faixa: igual ao de antes', () => {
    const faixas = { p1: [{ min_qty: 10, unit_price: 40 }] };
    const items = [{ product_id: 'p1', quantity: 10, customization: { art_service: 'none', cor: 'rosa', foto: 'u' } }];
    const r = svc.cotarPersonalizados({ items, produtos: PRODUTOS, faixas });
    expect(r).toEqual(comoAntes(items, faixas));
    expect(r.subtotal).toBeCloseTo(425, 10);
  });

  test('prepararPersonalizacao e a limpeza do ajuste da arte', () => {
    const [, item, , ins] = ACEITOS[3];
    const cfg = PRODUTOS.p1.customization_config;
    expect(svc.prepararPersonalizacao(item.customization, cfg)).toEqual(ins.customization);
    expect(svc.prepararPersonalizacao(item.customization, cfg))
      .toEqual(sanitizarAjustesDaArte(item.customization, cfg));
  });

  test.each(ACEITOS)('statusInicialDaArte: %s', (_d, item, _cot, ins) => {
    const cfg = PRODUTOS[item.product_id].customization_config;
    expect(svc.statusInicialDaArte(cfg, ins.customization)).toBe(ins.art_review_status);
    expect(svc.statusInicialDaArte(cfg, ins.customization)).toBe(initialArtStatus(cfg, ins.customization));
  });

  test('statusInicialDaArte sem config ou sem customization: null', () => {
    expect(svc.statusInicialDaArte(null, { foto: 'u' })).toBeNull();
    expect(svc.statusInicialDaArte({ fields: [FOTO_OBRIG] }, null)).toBeNull();
    expect(svc.statusInicialDaArte({ fields: [GALERIA] }, { tpl: 'tpl-1' })).toBe('pendente');
  });

  test('a API exportada e so esta', () => {
    expect(Object.keys(svc).sort()).toEqual([
      'cotarPersonalizados', 'prepararPersonalizacao', 'statusInicialDaArte',
      'validarPersonalizacao', 'validateCustomizationValues',
    ]);
  });
});
