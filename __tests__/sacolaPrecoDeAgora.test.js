// ============================================================
// A sacola confere o preco de agora antes do checkout (p-124, 15/11/2026)
//
// QA da Black Friday: o item entrou na sacola a R$ 98,90 (promocao), a
// promocao encerrou, e o resumo do checkout somou 163,80 enquanto o QR do
// Pix cobrou 204,80 (o servidor, certo, cobrou o preco de agora). O que
// trava aqui:
//   (a) sacola com preco antigo: ao abrir o checkout o resumo mostra o preco
//       de agora e a cliente le UM aviso; o QR cobra o mesmo do resumo;
//   (b) preco baixou: muda sem aviso;
//   (c) POST /sacola/precos devolve o MESMO preco que o pedido cobra
//       (promocao no ar, encerrada, variante);
//   (d) a faixa fina da campanha nao deixa o "·" sozinho na quebra.
// O script da vitrine roda de verdade (state_utils + sacola + cart +
// checkout + pix) num DOM minimo, e o fetch dele vai para a rota de
// verdade (supertest), com o banco simulado como em pedidoOnlineDePor.
// ============================================================
'use strict';

jest.mock('../src/services/pixService', () => ({
  generatePix: jest.fn(async () => ({
    payment_id: null, qrcode: null, payload: '000201PIXDETESTE', expires_at: null, mode: 'manual',
  })),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn() }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(async () => {}),
  notifyManualPixOrder: jest.fn(async () => {}),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { _resetarParaTeste } = require('../src/services/precoEfetivo');
const campanha = require('../src/templates/storefront/parts/campanha');

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const V_G = '33333333-3333-4333-8333-333333333333';
const V_P = '44444444-4444-4444-8444-444444444444';
const DIA = 864e5;
const ATIVA = () => ({ promo_starts_at: new Date(Date.now() - DIA), promo_ends_at: new Date(Date.now() + 7 * DIA) });
const ENCERRADA = () => ({ promo_starts_at: new Date(Date.now() - 9 * DIA), promo_ends_at: new Date(Date.now() - DIA) });

let produtos;
let variantes;
let comVariantes;
let itensGravados;
let configDaLoja;

function consulta(sql) {
  if (/FROM digital_channel_config/.test(sql)) return { rows: [configDaLoja] };
  if (/SELECT product_id, COUNT\(\*\) AS cnt/.test(sql)) return { rows: comVariantes };
  if (/FROM product_variants pv/.test(sql)) return { rows: variantes };
  if (/FROM products/.test(sql)) return { rows: produtos };
  return { rows: [] };
}

beforeEach(() => {
  _resetarParaTeste();
  comVariantes = [];
  variantes = [];
  itensGravados = [];
  configDaLoja = { company_id: 'c1', pickup_enabled: true, pix_key: 'chave', company_display_name: 'Loja' };
  db.query.mockReset();
  db.connect.mockReset();
  db.query.mockImplementation(async (sql) => consulta(String(sql)));
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO digital_orders/.test(s)) {
        return { rows: [{ id: 'o1', order_number: 7, company_id: params[0], subtotal: params[7], total: params[8] }] };
      }
      if (/INSERT INTO digital_order_items/.test(s)) {
        itensGravados.push({ product_id: params[1], unit_price: params[4], quantity: params[5], variant_id: params[7] });
        return { rows: [] };
      }
      return consulta(s);
    }),
    release: jest.fn(),
  }));
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/storefront', require('../src/routes/storefront'));
  return a;
}

const peca = (id, name, price, extra) => ({
  id, name, price, stock_qty: 10, image_url: null, is_active: true,
  promo_price: null, promo_starts_at: null, promo_ends_at: null, ...extra,
});

// ── (c) a rota e o pedido: o mesmo preco ─────────────────────────────
describe('POST /sacola/precos devolve o preco que o pedido cobra', () => {
  const precos = (items) => request(app()).post('/api/v1/storefront/loja/sacola/precos').send({ items });
  const pedir = (items) => request(app()).post('/api/v1/storefront/loja/order').send({
    customer_name: 'Cliente', customer_phone: '11999999999', delivery_type: 'pickup', payment_method: 'pix', items,
  });

  async function mesmoPreco(items) {
    const r = await precos(items);
    expect(r.status).toBe(200);
    const o = await pedir(items);
    expect(o.status).toBe(201);
    expect(r.body.itens.map((i) => i.preco)).toEqual(itensGravados.map((i) => i.unit_price));
    // A resposta do pedido leva o preco de cada item, na ordem do corpo.
    expect(o.body.itens.map((i) => i.unit_price)).toEqual(itensGravados.map((i) => i.unit_price));
    return r.body.itens.map((i) => i.preco);
  }

  test('promocao no ar: o preco da promocao', async () => {
    produtos = [peca(P1, 'Blusa', '139.90', { promo_price: '98.90', ...ATIVA() })];
    expect(await mesmoPreco([{ product_id: P1, quantity: 1 }])).toEqual([98.9]);
  });

  test('promocao encerrada: o preco normal', async () => {
    produtos = [peca(P1, 'Blusa', '139.90', { promo_price: '98.90', ...ENCERRADA() })];
    expect(await mesmoPreco([{ product_id: P1, quantity: 1 }])).toEqual([139.9]);
  });

  test('variante com promocao propria e variante que segue a do produto', async () => {
    produtos = [peca(P1, 'Blusa', '100.00', { promo_price: '80.00', ...ATIVA() })];
    comVariantes = [{ product_id: P1, cnt: '2' }];
    variantes = [
      { id: V_G, product_id: P1, price_override: '120.00', stock_qty: 5, is_active: true, promo_price: '99.00', ...ATIVA() },
      { id: V_P, product_id: P1, price_override: null, stock_qty: 5, is_active: true, promo_price: null, promo_starts_at: null, promo_ends_at: null },
    ];
    expect(await mesmoPreco([
      { product_id: P1, variant_id: V_G, quantity: 1 },
      { product_id: P1, variant_id: V_P, quantity: 1 },
    ])).toEqual([99, 80]);
  });

  test('peca que saiu da loja, sem estoque ou id torto: a sacola nao quebra', async () => {
    produtos = [peca(P1, 'Blusa', '139.90', { stock_qty: 0 })];
    const r = await precos([
      { product_id: P1, quantity: 2 },
      { product_id: P2, quantity: 1 },
      { product_id: 'nao-e-uuid', quantity: 1 },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.itens).toEqual([
      { indice: 0, product_id: P1, variant_id: null, preco: 139.9, disponivel: false, motivo: 'estoque' },
      { indice: 1, product_id: P2, variant_id: null, preco: null, disponivel: false, motivo: 'nao_encontrado' },
      { indice: 2, product_id: 'nao-e-uuid', variant_id: null, preco: null, disponivel: false, motivo: 'nao_encontrado' },
    ]);
    // O id torto nem chega ao banco (derrubaria o ANY($1::uuid[])).
    const params = db.query.mock.calls.filter(([s]) => /FROM products/.test(String(s))).map(([, p]) => p[0]);
    expect(params).toEqual([[P1, P2]]);
  });

  test('loja que esconde os precos: nada de preco na resposta', async () => {
    configDaLoja = { ...configDaLoja, show_prices: false };
    produtos = [peca(P1, 'Blusa', '139.90')];
    const r = await precos([{ product_id: P1, quantity: 1 }]);
    expect(r.body.itens[0]).toMatchObject({ preco: null, disponivel: true });
  });

  test('loja nao publicada: 404; corpo vazio: 400', async () => {
    db.query.mockImplementation(async () => ({ rows: [] }));
    expect((await precos([{ product_id: P1, quantity: 1 }])).status).toBe(404);
    expect((await precos([])).status).toBe(400);
  });
});

// ── o script da vitrine num DOM minimo ───────────────────────────────
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function elemento(id) {
  const cls = new Set();
  const el = {
    id, hidden: false, disabled: false, value: '', style: {}, attrs: {}, _html: '', _text: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this._html = escHtml(v); },
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : !!f; if (on) cls.add(c); else cls.delete(c); return on; },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, remove() {}, insertAdjacentHTML() {}, appendChild() {},
  };
  return el;
}

/**
 * A vitrine com a sacola salva `salva` e o catalogo `catalogo`. `falharPrecos`
 * derruba a conferencia (rede). Devolve a api do script e os elementos.
 */
function vitrine({ salva, catalogo, falharPrecos = false, pixPct = 0 }) {
  const els = {};
  const document = {
    getElementById: (id) => els[id] || (els[id] = elemento(id)),
    createElement: () => elemento(null),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: elemento('body'),
    head: elemento('head'),
  };
  const guardado = { aura_sacola_loja: JSON.stringify({ ts: Date.now(), itens: salva }) };
  const window = {
    localStorage: {
      getItem: (k) => (k in guardado ? guardado[k] : null),
      setItem: (k, v) => { guardado[k] = String(v); },
      removeItem: (k) => { delete guardado[k]; },
    },
    location: { pathname: '/loja' },
    confirm: () => false,
  };
  const pendentes = new Set();
  const chamadas = [];
  const fetch = (url, opts = {}) => {
    const caminho = String(url).replace(/^https?:\/\/[^/]+/, '');
    chamadas.push(caminho);
    if (falharPrecos && /\/sacola\/precos$/.test(caminho)) return Promise.reject(new TypeError('Failed to fetch'));
    const metodo = (opts.method || 'GET').toLowerCase();
    let req = request(app())[metodo](caminho);
    if (opts.body) req = req.set('Content-Type', 'application/json').send(opts.body);
    const p = req.then((res) => ({ ok: res.status < 400, status: res.status, json: async () => res.body }));
    pendentes.add(p);
    p.finally(() => pendentes.delete(p));
    return p;
  };
  const parts = (n) => require('../src/templates/storefront/parts/' + n);
  const fonte = [
    "var __S={settings:{has_pix:true,pickup_enabled:true},pix_discount_pct:" + pixPct + "};",
    "var SLUG='loja',API_BASE='',SETTINGS=__S.settings,CONTACT={},SITE={},PROD_MAP=PROD_MAP_IN;",
    'function renderProducts(){} function showToast(m){toasts.push(m);} function INICIAIS(){return "";}',
    'function PARCELAS_TXT(){return "";} function showDetail(){} function escJsAttr(s){return String(s);}',
    parts('state_utils'), parts('sacola'), parts('cart'), parts('checkout'), parts('pix'),
    'return { carregarSacola:carregarSacola, openCart:openCart, openCheckout:openCheckout, closeCheckout:closeCheckout,',
    '  submitOrder:submitOrder, updateCartUI:updateCartUI, cart:function(){return cart;}, pedido:function(){return currentOrder;},',
    '  dados:function(d){customerData=d;}, esquecerConferencia:function(){ultimaConferencia=null;} };',
  ].join('\n');
  const toasts = [];
  // eslint-disable-next-line no-new-func
  const api = new Function('document', 'window', 'fetch', 'PROD_MAP_IN', 'toasts', 'navigator', fonte)(
    document, window, fetch, catalogo, toasts, {}
  );
  api.carregarSacola();
  api.updateCartUI();
  const esperar = async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setImmediate(r));
      if (!pendentes.size) { await new Promise((r) => setImmediate(r)); if (!pendentes.size) return; }
      await Promise.allSettled([...pendentes]);
    }
  };
  return { api, els, esperar, chamadas, toasts };
}

const AVISO = 'O preço de 1 item mudou desde que você o adicionou: Blusa Tricot Bege, de R$ 98,90 para R$ 139,90.';
const vezes = (txt, s) => txt.split(s).length - 1;
const salvaDoQa = () => [
  { key: P1, product_id: P1, variant_id: null, name: 'Blusa Tricot Bege', price: 98.9, qty: 1 },
  { key: P2, product_id: P2, variant_id: null, name: 'Saia Midi', price: 64.9, qty: 1 },
];
const catalogoDoQa = { [P1]: { id: P1, name: 'Blusa Tricot Bege', variants: [] }, [P2]: { id: P2, name: 'Saia Midi', variants: [] } };
const dadosDaCliente = { name: 'Cliente', phone: '11999999999', payment_method: 'pix' };

describe('(a) preco antigo na sacola: o checkout mostra o de agora, com um aviso', () => {
  beforeEach(() => {
    // A promocao de 98,90 encerrou; o preco de agora e 139,90.
    produtos = [
      peca(P1, 'Blusa Tricot Bege', '139.90', { promo_price: '98.90', ...ENCERRADA() }),
      peca(P2, 'Saia Midi', '64.90'),
    ];
  });

  test('o resumo soma 204,80 (nao 163,80), o aviso aparece uma vez, e o QR cobra o mesmo', async () => {
    const v = vitrine({ salva: salvaDoQa(), catalogo: catalogoDoQa });
    // Antes de conferir: o preco guardado (o defeito do QA).
    expect(v.els.checkoutResumo.innerHTML).toContain('<span>Total</span><span class="mono">R$ 163,80</span>');
    v.api.openCheckout();
    expect(v.chamadas).toContain('/api/v1/storefront/loja/sacola/precos');
    await v.esperar();

    const resumo = v.els.checkoutResumo.innerHTML;
    expect(resumo).toContain('<span>Subtotal</span><span class="mono">R$ 204,80</span>');
    expect(resumo).toContain('<span>Total</span><span class="mono">R$ 204,80</span>');
    expect(resumo).not.toContain('163,80');
    expect(vezes(resumo, AVISO)).toBe(1);
    expect(resumo).toContain('<p class="aviso-fechada aviso-preco" role="status">');
    // A sacola salva no navegador ja guarda o preco novo.
    expect(v.api.cart()[P1].price).toBe(139.9);

    // Conferir de novo (outra abertura): nada mudou, nada de aviso novo.
    v.api.closeCheckout();
    v.api.esquecerConferencia();
    v.api.openCheckout();
    await v.esperar();
    expect(v.els.checkoutResumo.innerHTML).not.toContain('mudou desde que');
    expect(v.els.checkoutResumo.innerHTML).toContain('R$ 204,80');

    // O pedido: o QR cobra o total do resumo.
    v.api.dados({ ...dadosDaCliente });
    v.api.submitOrder();
    await v.esperar();
    expect(v.api.pedido().total).toBeCloseTo(204.8, 2);
    expect(v.els.checkoutBody.innerHTML).toContain('<div class="pix-valor">R$ 204,80</div>');
    expect(v.els.checkoutResumo.innerHTML).toContain('<span class="mono">R$ 204,80</span>');
  });

  test('abrir a sacola tambem confere: o aviso na sacola, uma vez', async () => {
    const v = vitrine({ salva: salvaDoQa(), catalogo: catalogoDoQa });
    v.api.openCart();
    await v.esperar();
    expect(vezes(v.els.cartItems.innerHTML, AVISO)).toBe(1);
    expect(v.els.cartTotal.textContent).toBe('R$ 204,80');
    // Fechar e abrir de novo: o aviso ja foi dado.
    v.api.esquecerConferencia();
    v.api.openCart();
    await v.esperar();
    expect(v.els.cartItems.innerHTML).not.toContain('mudou desde que');
  });

  test('varios itens: o aviso no plural, com cada um', async () => {
    produtos = [
      peca(P1, 'Blusa Tricot Bege', '139.90'),
      peca(P2, 'Saia Midi', '79.90'),
    ];
    const v = vitrine({ salva: salvaDoQa(), catalogo: catalogoDoQa });
    v.api.openCheckout();
    await v.esperar();
    expect(v.els.checkoutResumo.innerHTML).toContain(
      'O preço de 2 itens mudou desde que você os adicionou: Blusa Tricot Bege, de R$ 98,90 para R$ 139,90; Saia Midi, de R$ 64,90 para R$ 79,90.'
    );
  });

  test('sem rede na conferencia: a sacola fica, o pedido acerta o resumo pelo que cobrou', async () => {
    const v = vitrine({ salva: salvaDoQa(), catalogo: catalogoDoQa, falharPrecos: true });
    v.api.openCheckout();
    await v.esperar();
    expect(v.els.checkoutResumo.innerHTML).toContain('R$ 163,80'); // nao deu para conferir
    v.api.dados({ ...dadosDaCliente });
    v.api.submitOrder();
    await v.esperar();
    expect(v.api.pedido().total).toBeCloseTo(204.8, 2);
    const resumo = v.els.checkoutResumo.innerHTML;
    expect(resumo).toContain('<span>Total</span><span class="mono">R$ 204,80</span>');
    expect(resumo).not.toContain('163,80');
    expect(vezes(resumo, AVISO)).toBe(1);
  });

  test('Pix com desconto: o resumo ao lado do QR e o total do servidor', async () => {
    configDaLoja = { ...configDaLoja, pix_discount_pct: 5 };
    const v = vitrine({ salva: salvaDoQa(), catalogo: catalogoDoQa, falharPrecos: true, pixPct: 5 });
    v.api.openCheckout();
    await v.esperar();
    v.api.dados({ ...dadosDaCliente });
    v.api.submitOrder();
    await v.esperar();
    // 204,80 - 5% (10,24) = 194,56
    expect(v.api.pedido().total).toBeCloseTo(194.56, 2);
    expect(v.els.checkoutResumo.innerHTML).toContain('<span>Total no Pix</span><span class="mono">R$ 194,56</span>');
    expect(v.els.checkoutBody.innerHTML).toContain('<div class="pix-valor">R$ 194,56</div>');
  });

  test('pedido enviado com a conferencia no ar: espera por ela antes de mandar', async () => {
    const v = vitrine({ salva: salvaDoQa(), catalogo: catalogoDoQa });
    v.api.dados({ ...dadosDaCliente });
    v.api.openCheckout();
    v.api.submitOrder(); // a conferencia ainda nao voltou
    const antes = v.chamadas.filter((c) => /\/order$/.test(c)).length;
    expect(antes).toBe(0);
    await v.esperar();
    expect(v.chamadas.filter((c) => /\/order$/.test(c)).length).toBe(1);
    expect(v.chamadas.indexOf('/api/v1/storefront/loja/sacola/precos'))
      .toBeLessThan(v.chamadas.indexOf('/api/v1/storefront/loja/order'));
    expect(v.api.pedido().total).toBeCloseTo(204.8, 2);
  });
});

describe('(b) preco baixou: muda sem aviso', () => {
  test('139,90 na sacola, promocao no ar a 98,90: resumo com 98,90 e nenhum aviso', async () => {
    produtos = [
      peca(P1, 'Blusa Tricot Bege', '139.90', { promo_price: '98.90', ...ATIVA() }),
      peca(P2, 'Saia Midi', '64.90'),
    ];
    const salva = salvaDoQa();
    salva[0].price = 139.9;
    const v = vitrine({ salva, catalogo: catalogoDoQa });
    v.api.openCheckout();
    await v.esperar();
    const resumo = v.els.checkoutResumo.innerHTML;
    expect(resumo).toContain('<span>Subtotal</span><span class="mono">R$ 163,80</span>');
    expect(resumo).not.toContain('mudou desde que');
    expect(resumo).not.toContain('aviso-preco');
    expect(v.toasts).toEqual([]);
  });
});

// ── (d) a faixa fina: o "·" nunca sozinho ────────────────────────────
describe('(d) faixa fina da campanha: o separador vai grudado no trecho seguinte', () => {
  const W28 = 'W'.repeat(28);
  const faixa = (c) => campanha.htmlDaFaixaFina(campanha.campanhaNoAr({ campanha: c }));

  test.each([
    ['titulo de 28 W, com data', { ativa: true, titulo: W28, ate_pct: 40, ate_data: '2026-11-30' }, 2],
    ['titulo comum, com data', { ativa: true, titulo: 'Black Friday', ate_pct: 40, ate_data: '2026-11-30' }, 2],
    ['sem data', { ativa: true, titulo: W28, ate_pct: 40 }, 1],
  ])('%s', (_n, c, seps) => {
    const h = faixa(c);
    expect(vezes(h, 'class="bf-sep"')).toBe(seps);
    // Cada "·" abre um trecho nowrap logo depois da unica quebra possivel...
    expect(vezes(h, '<wbr><span class="bf-trecho"><span class="bf-sep" aria-hidden="true">·</span>até ')).toBe(seps);
    expect(vezes(h, '<wbr>')).toBe(seps);
    // ...e nunca fica antes de uma quebra (o "·" no fim da linha).
    expect(h).not.toMatch(/·<\/span><wbr>/);
    expect(h).not.toMatch(/·<\/span><\/span><wbr>/);
  });

  test('todo span da faixa e nowrap (o trecho inteiro e o ponto andam juntos)', () => {
    expect(campanha.CSS).toContain('.bf-faixa span{white-space:nowrap}');
  });
});
