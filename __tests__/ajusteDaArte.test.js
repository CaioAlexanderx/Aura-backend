// ============================================================
// Vitrine Studio · ajuste da arte na peca (28/09/2026)
//
// A cliente posiciona/escala/gira a arte e escolhe fonte e tamanho do
// texto. Isso chega como chaves laterais do customization:
//   <F>_ajuste, <F>_fonte, <F>_tam, <F>_contorno
// services/ajusteDaArte.js limpa essas chaves — nunca recusa o pedido.
//
// O que trava aqui:
//   - o contrato de cada chave (limites, tipos, lista de fontes);
//   - chave de campo inexistente ou de tipo errado sai;
//   - qualquer outra chave passa intacta; a entrada nao e mutada;
//   - POST /studio/order grava o customization limpo, e a cotacao aceita
//     ajuste malformado sem 400 e com o mesmo total;
//   - "pedir outro igual" devolve as chaves quando o campo volta;
//   - a tecnica de impressao no customization_config.
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
const { sanitizarAjustesDaArte } = require('../src/services/ajusteDaArte');
const { cotarItens } = require('../src/services/precoDoStudio');
const { personalizacaoDaLinha, montarRepeticao } = require('../src/services/repetirPedido');
const { __validateCustomizationConfig: validarConfig } = require('../src/routes/studio');

const NOME = { id: 'nome', type: 'text', label: 'Nome', config: { fonts: ['Montserrat', 'Pacifico'] } };
const FRASE = { id: 'frase', type: 'text', label: 'Frase' }; // sem lista de fontes
const FOTO = { id: 'foto', type: 'image', label: 'Sua foto' };
const MODELO = { id: 'modelo', type: 'template', label: 'Modelo' };
const COR = {
  id: 'cor', type: 'option', label: 'Cor da alça',
  config: { choices: [{ value: 'rosa', label: 'Rosa', price_delta: 2.5 }, { value: 'branca', label: 'Branca', price_delta: 0 }] },
};
const CFG = { fields: [NOME, FRASE, FOTO, MODELO, COR] };

const AJUSTE_FOTO = {
  v: 1, cx: 0.5, cy: 0.4, larg: 0.8, rot: 90, encaixe: 'preencher',
  cm: { x: 1.234, y: 2, w: 8.5, h: 6.789 }, arquivo: { w: 3000, h: 2000 }, dpi: 299.6,
};

describe('sanitizarAjustesDaArte · o contrato', () => {
  test('ajuste valido de imagem passa inteiro (cm com 2 casas, dpi inteiro)', () => {
    const out = sanitizarAjustesDaArte({ foto: 'https://r2/x.png', foto_ajuste: AJUSTE_FOTO }, CFG);
    expect(out.foto_ajuste).toEqual({
      v: 1, cx: 0.5, cy: 0.4, larg: 0.8, rot: 90, encaixe: 'preencher',
      cm: { x: 1.23, y: 2, w: 8.5, h: 6.79 }, arquivo: { w: 3000, h: 2000 }, dpi: 300,
    });
  });

  test('ajuste de texto usa alt, nao larg; e de imagem usa larg, nao alt', () => {
    const t = sanitizarAjustesDaArte({ nome_ajuste: { v: 1, cx: 0.5, cy: 0.5, alt: 0.2, larg: 0.9 } }, CFG);
    expect(t.nome_ajuste).toEqual({ v: 1, cx: 0.5, cy: 0.5, alt: 0.2 });
    const i = sanitizarAjustesDaArte({ modelo_ajuste: { v: 1, cx: 0.5, cy: 0.5, alt: 0.2, larg: 0.9 } }, CFG);
    expect(i.modelo_ajuste).toEqual({ v: 1, cx: 0.5, cy: 0.5, larg: 0.9 });
  });

  test('limites: cx/cy em [-0.5, 1.5], larg em [0.02, 3], alt em [0.02, 2], cm em [-500, 500]', () => {
    const out = sanitizarAjustesDaArte({
      foto_ajuste: { v: 1, cx: -9, cy: 42, larg: 0.0001, cm: { x: -1e6, y: 1e6, w: 0, h: 3 } },
      modelo_ajuste: { v: 1, cx: 1.5, cy: -0.5, larg: 99 },
      nome_ajuste: { v: 1, cx: 0, cy: 1, alt: 50 },
      frase_ajuste: { v: 1, cx: 0, cy: 1, alt: 0 },
    }, CFG);
    expect(out.foto_ajuste).toEqual({ v: 1, cx: -0.5, cy: 1.5, larg: 0.02, cm: { x: -500, y: 500, w: 0, h: 3 } });
    expect(out.modelo_ajuste).toEqual({ v: 1, cx: 1.5, cy: -0.5, larg: 3 });
    expect(out.nome_ajuste.alt).toBe(2);
    expect(out.frase_ajuste.alt).toBe(0.02);
  });

  test('sem v:1 ou sem cx/cy numericos finitos: a chave inteira sai', () => {
    const casos = [
      { v: 2, cx: 0.5, cy: 0.5 },
      { cx: 0.5, cy: 0.5 },
      { v: '1', cx: 0.5, cy: 0.5 },
      { v: 1, cx: '0.5', cy: 0.5 },
      { v: 1, cx: 0.5 },
      { v: 1, cx: NaN, cy: 0.5 },
      { v: 1, cx: Infinity, cy: 0.5 },
      'texto', 42, null, [1, 2], true,
    ];
    for (const ajuste of casos) {
      const out = sanitizarAjustesDaArte({ foto: 'u', foto_ajuste: ajuste }, CFG);
      expect(out).not.toHaveProperty('foto_ajuste');
      expect(out.foto).toBe('u');
    }
  });

  test('props invalidas saem sozinhas; rot fora de 0/90/180/270 vira 0', () => {
    const out = sanitizarAjustesDaArte({
      foto_ajuste: {
        v: 1, cx: 0.5, cy: 0.5,
        larg: 'grande', rot: 45, encaixe: 'esticar',
        cm: { x: 1, y: 2, w: 3 }, arquivo: { w: 0, h: 10 }, dpi: 30000,
        extra: 'x', __proto_hack: { a: 1 },
      },
      modelo_ajuste: { v: 1, cx: 0.5, cy: 0.5, rot: '90', arquivo: { w: 10.5, h: 10 }, dpi: -1, cm: 'x' },
    }, CFG);
    expect(out.foto_ajuste).toEqual({ v: 1, cx: 0.5, cy: 0.5, rot: 0 });
    expect(out.modelo_ajuste).toEqual({ v: 1, cx: 0.5, cy: 0.5, rot: 0 });
  });

  test('encaixe aceita ajustar | preencher | livre', () => {
    for (const e of ['ajustar', 'preencher', 'livre']) {
      expect(sanitizarAjustesDaArte({ foto_ajuste: { v: 1, cx: 0, cy: 0, encaixe: e } }, CFG).foto_ajuste.encaixe).toBe(e);
    }
  });

  test('arquivo: inteiros 1..100000; dpi 0..20000', () => {
    const ok = sanitizarAjustesDaArte({ foto_ajuste: { v: 1, cx: 0, cy: 0, arquivo: { w: 1, h: 100000 }, dpi: 0 } }, CFG);
    expect(ok.foto_ajuste.arquivo).toEqual({ w: 1, h: 100000 });
    expect(ok.foto_ajuste.dpi).toBe(0);
    const ruim = sanitizarAjustesDaArte({ foto_ajuste: { v: 1, cx: 0, cy: 0, arquivo: { w: 1, h: 100001 }, dpi: 20001 } }, CFG);
    expect(ruim.foto_ajuste).not.toHaveProperty('arquivo');
    expect(ruim.foto_ajuste).not.toHaveProperty('dpi');
  });

  test('fonte: aparada, ate 60, e dentro de config.fonts quando ha lista', () => {
    const out = sanitizarAjustesDaArte({
      nome_fonte: '  Pacifico ',
      frase_fonte: 'Qualquer Uma',
    }, CFG);
    expect(out.nome_fonte).toBe('Pacifico');
    expect(out.frase_fonte).toBe('Qualquer Uma');

    expect(sanitizarAjustesDaArte({ nome_fonte: 'Comic Sans' }, CFG)).not.toHaveProperty('nome_fonte');
    expect(sanitizarAjustesDaArte({ nome_fonte: 'pacifico' }, CFG)).not.toHaveProperty('nome_fonte'); // exata
    expect(sanitizarAjustesDaArte({ frase_fonte: 'x'.repeat(61) }, CFG)).not.toHaveProperty('frase_fonte');
    expect(sanitizarAjustesDaArte({ frase_fonte: 'x'.repeat(60) }, CFG).frase_fonte).toHaveLength(60);
    expect(sanitizarAjustesDaArte({ frase_fonte: '   ' }, CFG)).not.toHaveProperty('frase_fonte');
    expect(sanitizarAjustesDaArte({ frase_fonte: 12 }, CFG)).not.toHaveProperty('frase_fonte');
  });

  test('tam: P | M | G; contorno: booleano', () => {
    const out = sanitizarAjustesDaArte({ nome_tam: 'G', nome_contorno: false, frase_tam: 'g', frase_contorno: 'true' }, CFG);
    expect(out.nome_tam).toBe('G');
    expect(out.nome_contorno).toBe(false);
    expect(out).not.toHaveProperty('frase_tam');
    expect(out).not.toHaveProperty('frase_contorno');
  });

  test('prefixo que nao e campo, ou de tipo errado: a chave sai', () => {
    const out = sanitizarAjustesDaArte({
      fantasma_ajuste: { v: 1, cx: 0.5, cy: 0.5 },
      fantasma_fonte: 'Pacifico',
      cor_ajuste: { v: 1, cx: 0.5, cy: 0.5 }, // option nao tem ajuste
      foto_fonte: 'Pacifico', // so texto tem fonte
      foto_tam: 'M',
      modelo_contorno: true,
      _ajuste: { v: 1, cx: 0, cy: 0 },
    }, CFG);
    expect(out).toEqual({});
  });

  test('chaves alheias passam intactas (campos, _cor, briefing, verso)', () => {
    const entrada = {
      nome: 'Helena', nome_cor: '#ff0000', foto: 'https://r2/x.png', cor: 'rosa',
      art_service_brief: 'flores', has_back_selected: true, qualquer: { a: [1, 2] },
      nome_ajuste: { v: 1, cx: 0.5, cy: 0.5 },
    };
    const out = sanitizarAjustesDaArte(entrada, CFG);
    expect(out).toEqual(entrada);
  });

  test('um campo cujo id termina em _fonte e campo, nao chave lateral', () => {
    const cfg = { fields: [{ id: 'nome', type: 'text' }, { id: 'nome_fonte', type: 'option' }] };
    const out = sanitizarAjustesDaArte({ nome_fonte: 'opcao-livre' }, cfg);
    expect(out.nome_fonte).toBe('opcao-livre');
  });

  test('nao muta a entrada e devolve objeto novo', () => {
    const entrada = { foto_ajuste: { v: 1, cx: 9, cy: 0, lixo: 1 }, fantasma_tam: 'P', nome: 'A' };
    const copia = JSON.parse(JSON.stringify(entrada));
    const out = sanitizarAjustesDaArte(entrada, CFG);
    expect(entrada).toEqual(copia);
    expect(out).not.toBe(entrada);
    expect(out.foto_ajuste).not.toBe(entrada.foto_ajuste);
  });

  test('nunca lanca: config ausente, customization nao-objeto, getter que explode', () => {
    expect(sanitizarAjustesDaArte(null, CFG)).toBeNull();
    expect(sanitizarAjustesDaArte(undefined, CFG)).toBeUndefined();
    expect(sanitizarAjustesDaArte('x', CFG)).toBe('x');
    expect(sanitizarAjustesDaArte({ nome: 'A', nome_tam: 'P' }, null)).toEqual({ nome: 'A' });
    expect(sanitizarAjustesDaArte({ nome: 'A' }, { fields: 'x' })).toEqual({ nome: 'A' });
    const bomba = { v: 1, cy: 0 };
    Object.defineProperty(bomba, 'cx', { enumerable: true, get() { throw new Error('boom'); } });
    expect(() => sanitizarAjustesDaArte({ foto_ajuste: bomba }, CFG)).not.toThrow();
    expect(sanitizarAjustesDaArte({ foto_ajuste: bomba }, CFG)).toEqual({});
  });
});

describe('cotarItens com sanear', () => {
  const PRODUTO = {
    id: 'p1', name: 'Caneca', price: '40', is_active: true, is_personalizable: true,
    customization_config: CFG,
  };
  test('a linha leva o customization limpo e o preco nao muda', () => {
    const items = [{ product_id: 'p1', quantity: 2, customization: { cor: 'rosa', nome: 'A', nome_tam: 'X', foto_ajuste: { v: 1, cx: 3, cy: 0 } } }];
    const sem = cotarItens({ items, produtos: { p1: PRODUTO }, faixas: null });
    const com = cotarItens({ items, produtos: { p1: PRODUTO }, faixas: null, sanear: sanitizarAjustesDaArte });
    expect(com.subtotal).toBe(sem.subtotal);
    expect(com.linhas[0].customization).toEqual({ cor: 'rosa', nome: 'A', foto_ajuste: { v: 1, cx: 1.5, cy: 0 } });
    // o corpo do cliente nao foi tocado
    expect(items[0].customization.nome_tam).toBe('X');
  });
});

// ─────────────────────────────────────────────────────────────
// Rota: o pedido grava limpo; a cotacao nao recusa ajuste malformado
// ─────────────────────────────────────────────────────────────
describe('POST /studio/order e /studio/cotacao', () => {
  const CID = 'c0000000-0000-0000-0000-000000000001';
  const PRODUTOS = {
    p1: {
      id: 'p1', name: 'Caneca', price: '40.00', stock_qty: 10, image_url: null,
      is_active: true, is_personalizable: true, customization_config: CFG,
    },
  };
  let inserts;

  function mockBanco() {
    db.query.mockImplementation(async (sql, params = []) => {
      const s = String(sql);
      if (/is_sandbox/.test(s)) return { rows: [{ is_sandbox: false }] };
      if (/FROM digital_channel_config/.test(s)) {
        return { rows: [{
          company_id: CID, slug: 'loja-teste', site_name: 'Loja Teste', company_display_name: 'Loja Teste',
          pickup_enabled: true, delivery_enabled: false, pix_key: 'chave@teste.com', pix_discount_pct: 0,
          is_published: true, studio_settings: {},
        }] };
      }
      if (/FROM companies_payment_gateways/.test(s)) return { rows: [] };
      if (/FROM studio_pricing_rules/.test(s)) return { rows: [] };
      if (/FROM products/.test(s)) {
        const ids = params[0] || [];
        return { rows: (Array.isArray(ids) ? ids : [ids]).map((id) => PRODUTOS[id]).filter(Boolean) };
      }
      return { rows: [] };
    });
    db.connect.mockImplementation(() => ({
      query: jest.fn(async (sql, params) => {
        const s = String(sql);
        if (/INSERT INTO digital_orders/.test(s)) {
          return { rows: [{ id: 'o1', order_number: '00001', company_id: CID, public_token: 'a'.repeat(32), created_at: new Date().toISOString() }] };
        }
        if (/INSERT INTO digital_order_items/.test(s)) inserts.push(params);
        return { rows: [] };
      }),
      release: jest.fn(),
    }));
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/storefront', require('../src/routes/studioStorefront'));

  beforeEach(() => {
    db.query.mockReset();
    db.connect.mockReset();
    generatePix.mockReset();
    limparCache();
    inserts = [];
    generatePix.mockImplementation(async ({ order, total }) => ({
      payment_id: 'manual-' + order.id, qrcode: null,
      payload: `PIX-${Number(total).toFixed(2)}`, expires_at: null, mode: 'manual',
    }));
    mockBanco();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  const CUSTOM = {
    nome: 'Helena', nome_fonte: 'Pacifico', nome_tam: 'M', nome_contorno: true,
    nome_ajuste: { v: 1, cx: 0.5, cy: 0.2, alt: 0.1, lixo: 'x' },
    foto: 'https://r2/x.png', foto_ajuste: { v: 7, cx: 0.5, cy: 0.5 }, // malformado
    fantasma_ajuste: { v: 1, cx: 0, cy: 0 },
    cor: 'rosa',
  };

  test('o pedido grava o customization limpo', async () => {
    const r = await request(app).post('/storefront/loja-teste/studio/order').send({
      customer_name: 'Cliente Teste', customer_phone: '11999990000', payment_method: 'pix',
      items: [{ product_id: 'p1', quantity: 1, customization: CUSTOM }],
    });
    expect(r.status).toBe(201);
    expect(inserts).toHaveLength(1);
    const gravado = JSON.parse(inserts[0][7]);
    expect(gravado).toEqual({
      nome: 'Helena', nome_fonte: 'Pacifico', nome_tam: 'M', nome_contorno: true,
      nome_ajuste: { v: 1, cx: 0.5, cy: 0.2, alt: 0.1 },
      foto: 'https://r2/x.png', cor: 'rosa',
    });
  });

  test('a cotacao aceita ajuste malformado (sem 400) e da o mesmo total que sem ajuste', async () => {
    const semAjuste = { nome: 'Helena', foto: 'https://r2/x.png', cor: 'rosa' };
    const a = await request(app).post('/storefront/loja-teste/studio/cotacao')
      .send({ items: [{ product_id: 'p1', quantity: 2, customization: CUSTOM }] });
    const b = await request(app).post('/storefront/loja-teste/studio/cotacao')
      .send({ items: [{ product_id: 'p1', quantity: 2, customization: semAjuste }] });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.total).toBe(b.body.total);
    expect(a.body.subtotal).toBe(b.body.subtotal);
    expect(a.body.subtotal).toBe(85); // (40 + 2,50 da alca rosa) x 2
  });
});

// ─────────────────────────────────────────────────────────────
// "Pedir outro igual"
// ─────────────────────────────────────────────────────────────
describe('repetirPedido mantem o ajuste da arte', () => {
  const GRAVADO = {
    nome: 'Helena', nome_cor: '#112233', nome_fonte: 'Pacifico', nome_tam: 'G', nome_contorno: false,
    nome_ajuste: { v: 1, cx: 0.5, cy: 0.3, alt: 0.1 },
    foto: 'https://r2.getaura.com.br/f.png', foto_ajuste: { v: 1, cx: 0.4, cy: 0.6, larg: 0.7, rot: 180 },
    modelo_ajuste: { v: 1, cx: 0.5, cy: 0.5 }, // campo sem valor: nao volta
    fantasma_ajuste: { v: 1, cx: 0, cy: 0 },
  };

  test('as chaves voltam junto com o campo', () => {
    const { valores } = personalizacaoDaLinha(CFG, GRAVADO);
    expect(valores).toEqual({
      nome: 'Helena', nome_cor: '#112233', nome_fonte: 'Pacifico', nome_tam: 'G', nome_contorno: false,
      nome_ajuste: { v: 1, cx: 0.5, cy: 0.3, alt: 0.1 },
      foto: 'https://r2.getaura.com.br/f.png', foto_ajuste: { v: 1, cx: 0.4, cy: 0.6, larg: 0.7, rot: 180 },
    });
  });

  test('limpas contra o configurador de hoje: fonte que saiu da lista nao volta', () => {
    const hoje = { fields: [{ ...NOME, config: { fonts: ['Montserrat'] } }, FOTO] };
    const { valores } = personalizacaoDaLinha(hoje, GRAVADO);
    expect(valores).not.toHaveProperty('nome_fonte');
    expect(valores.nome_tam).toBe('G');
  });

  test('campo que saiu do produto leva as chaves dele junto', () => {
    const hoje = { fields: [NOME] };
    const { valores } = personalizacaoDaLinha(hoje, GRAVADO);
    expect(valores).not.toHaveProperty('foto');
    expect(valores).not.toHaveProperty('foto_ajuste');
  });

  test('ajuste malformado gravado nao volta, e o resto sim', () => {
    const { valores } = personalizacaoDaLinha(CFG, { ...GRAVADO, foto_ajuste: { cx: 1 } });
    expect(valores).not.toHaveProperty('foto_ajuste');
    expect(valores.foto).toBe(GRAVADO.foto);
  });

  test('montarRepeticao usa o config atual do produto', () => {
    const r = montarRepeticao({
      pedido: { order_number: '9' },
      itens: [{ product_id: 'p1', product_name: 'Caneca', quantity: 1, customization: GRAVADO }],
      naVitrine: { p1: { customization_config: CFG } },
    });
    expect(r.itens[0].personalizacao.valores.foto_ajuste).toEqual(GRAVADO.foto_ajuste);
  });
});

// ─────────────────────────────────────────────────────────────
// Tecnica de impressao no customization_config
// ─────────────────────────────────────────────────────────────
describe('customization_config.tecnica', () => {
  const BASE = {
    print_area: { width_cm: 20, height_cm: 9 },
    fields: [{ id: 'nome', type: 'text', label: 'Nome', required: false }],
  };
  test.each(['sublimacao', 'dtf', 'outra'])('"%s" e aceita', (t) => {
    expect(validarConfig({ ...BASE, tecnica: t })).toBeNull();
  });
  test('ausente ou null: ok', () => {
    expect(validarConfig(BASE)).toBeNull();
    expect(validarConfig({ ...BASE, tecnica: null })).toBeNull();
  });
  test.each(['serigrafia', 'DTF', '', 1, true, {}])('%p e recusada em portugues', (t) => {
    expect(validarConfig({ ...BASE, tecnica: t })).toBe('tecnica inválida: use sublimacao, dtf ou outra');
  });

  test('PUT customization-config grava a chave e responde 400 no valor invalido', async () => {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id/studio', require('../src/routes/studio'));
    db.query.mockReset();
    db.query.mockImplementation(async (sql, params) => {
      if (/UPDATE products SET customization_config/.test(String(sql))) {
        return { rows: [{ id: 'p1', name: 'Caneca', is_personalizable: true, customization_config: JSON.parse(params[0]) }] };
      }
      return { rows: [] };
    });
    const ok = await request(app).put('/companies/c1/studio/products/p1/customization-config').send({ ...BASE, tecnica: 'dtf' });
    expect(ok.status).toBe(200);
    expect(ok.body.config.tecnica).toBe('dtf');
    const ruim = await request(app).put('/companies/c1/studio/products/p1/customization-config').send({ ...BASE, tecnica: 'laser' });
    expect(ruim.status).toBe(400);
    expect(ruim.body.error).toBe('tecnica inválida: use sublimacao, dtf ou outra');
  });
});
