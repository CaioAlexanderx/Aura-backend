// ============================================================
// AURA. — Pedido da loja online idempotente (migration 416, 27/10/2026)
//
// Medido em producao: cada compra pela loja online gerava de 3 a 5 pedidos
// iguais (0,1 a 0,7 s de diferenca) — cada toque no botao de pagamento
// virava um pedido novo. Aqui:
//   - rota: mesma chave duas vezes -> 1 pedido; chaves diferentes -> 2;
//     sem chave -> como antes; mesma chave com outros itens -> 409;
//     migration ausente -> como antes;
//   - vitrine: toque repetido nao envia de novo; erro de rede mantem a
//     chave; pedido criado troca a chave.
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
const pedidoIdem = require('../src/services/pedidoOnlineIdempotente');

const PRODUTO = { id: 'p1', name: 'BLUSA', price: '50.00', stock_qty: 10, image_url: null, is_active: true };
const PRODUTO2 = { id: 'p2', name: 'SAIA', price: '80.00', stock_qty: 10, image_url: null, is_active: true };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/storefront', require('../src/routes/storefront'));
  return app;
}

// Banco de mentira com o que a rota usa: pedidos, itens e o indice unico
// parcial (company_id, idempotency_key).
let pedidos;
let itens;
let colunasDaMigration;
let insertsDePedido;

function acharPorChave(cid, key) {
  return pedidos.find((p) => p.company_id === cid && p.idempotency_key === key) || null;
}

function consultaComum(sql, params) {
  if (/information_schema\.columns/.test(sql)) {
    return { rows: [{ n: colunasDaMigration ? 2 : 0 }] };
  }
  if (/FROM digital_channel_config/.test(sql)) {
    return { rows: [{ company_id: 'c1', pickup_enabled: true, pix_key: 'chave', company_display_name: 'Loja' }] };
  }
  if (/FROM products/.test(sql)) return { rows: [PRODUTO, PRODUTO2] };
  if (/SELECT id FROM digital_orders WHERE company_id = \$1 AND idempotency_key = \$2/.test(sql)) {
    const p = acharPorChave(params[0], params[1]);
    return { rows: p ? [{ id: p.id }] : [] };
  }
  if (/SELECT \* FROM digital_orders WHERE company_id = \$1 AND idempotency_key = \$2/.test(sql)) {
    const p = acharPorChave(params[0], params[1]);
    return { rows: p ? [{ ...p }] : [] };
  }
  if (/FROM digital_order_items WHERE order_id = \$1/.test(sql)) {
    return { rows: itens.filter((i) => i.order_id === params[0]) };
  }
  if (/UPDATE digital_orders SET idempotency_response/.test(sql)) {
    const p = pedidos.find((x) => x.id === params[1]);
    if (p) p.idempotency_response = JSON.parse(params[0]);
    return { rows: [] };
  }
  return { rows: [] };
}

function insertDePedido(sql, params) {
  insertsDePedido.push({ sql, params });
  const comChave = /idempotency_key/.test(sql);
  const key = comChave ? params[params.length - 1] : null;
  if (key && acharPorChave(params[0], key)) {
    const e = new Error('duplicate key value violates unique constraint');
    e.code = '23505';
    e.constraint = pedidoIdem.INDICE;
    throw e;
  }
  const p = {
    id: 'o' + (pedidos.length + 1), order_number: pedidos.length + 1, company_id: params[0],
    total: params[8], subtotal: params[7], delivery_fee: params[6], status: params[9],
    payment_method: params[11], idempotency_key: key, idempotency_response: null,
  };
  pedidos.push(p);
  return { rows: [{ ...p }] };
}

beforeEach(() => {
  pedidos = [];
  itens = [];
  insertsDePedido = [];
  colunasDaMigration = true;
  pedidoIdem._resetCache();
  pedidoIdem.ESPERA.totalMs = 1000;
  pedidoIdem.ESPERA.passoMs = 5;
  db.query.mockReset();
  db.connect.mockReset();
  db.query.mockImplementation(async (sql, params) => consultaComum(String(sql), params));
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      // Deixa o outro toque andar entre uma consulta e outra (simultaneos).
      await new Promise((r) => setImmediate(r));
      if (/INSERT INTO digital_orders/.test(s)) return insertDePedido(s, params);
      if (/INSERT INTO digital_order_items/.test(s)) {
        itens.push({ order_id: params[0], product_id: params[1], quantity: params[5], variant_id: params[7] });
        return { rows: [] };
      }
      return consultaComum(s, params);
    }),
    release: jest.fn(),
  }));
});

const CORPO = {
  customer_name: 'Cliente', customer_phone: '11999999999',
  delivery_type: 'pickup', payment_method: 'pix',
  items: [{ product_id: 'p1', quantity: 1 }],
};
const pedir = (app, extra = {}) => request(app).post('/storefront/loja/order').send({ ...CORPO, ...extra });

describe('POST /storefront/:slug/order com chave de idempotencia', () => {
  test('mesma chave duas vezes -> 1 pedido; a segunda devolve o mesmo (200)', async () => {
    const app = makeApp();
    const r1 = await pedir(app, { idempotency_key: 'chave-checkout-0001' });
    const r2 = await pedir(app, { idempotency_key: 'chave-checkout-0001' });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(pedidos).toHaveLength(1);
    expect(insertsDePedido).toHaveLength(1);
    expect(r2.body.order_id).toBe(r1.body.order_id);
    expect(r2.body.order_number).toBe(r1.body.order_number);
    // O Pix da primeira resposta volta igual na repeticao.
    expect(r2.body.pix).toEqual(r1.body.pix);
    expect(r2.body.idempotent_replay).toBe(true);
    expect(r2.headers['idempotent-replayed']).toBe('true');
  });

  test('toques simultaneos com a mesma chave -> 1 pedido (indice unico como garantia final)', async () => {
    const app = makeApp();
    const rs = await Promise.all([1, 2, 3, 4].map(() => pedir(app, { idempotency_key: 'chave-checkout-0002' })));

    expect(pedidos).toHaveLength(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(3);
    expect(new Set(rs.map((r) => r.body.order_id))).toEqual(new Set(['o1']));
  });

  test('a chave tambem vale pelo cabecalho Idempotency-Key', async () => {
    const app = makeApp();
    await pedir(app).set('Idempotency-Key', 'chave-cabecalho-01');
    const r2 = await pedir(app).set('Idempotency-Key', 'chave-cabecalho-01');
    expect(r2.status).toBe(200);
    expect(pedidos).toHaveLength(1);
  });

  test('chaves diferentes -> 2 pedidos', async () => {
    const app = makeApp();
    const r1 = await pedir(app, { idempotency_key: 'chave-checkout-000A' });
    const r2 = await pedir(app, { idempotency_key: 'chave-checkout-000B' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(pedidos).toHaveLength(2);
    expect(r1.body.order_id).not.toBe(r2.body.order_id);
  });

  test('sem chave (pagina antiga em cache) -> como antes: cada envio e um pedido, INSERT sem a coluna', async () => {
    const app = makeApp();
    const r1 = await pedir(app);
    const r2 = await pedir(app);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(pedidos).toHaveLength(2);
    expect(insertsDePedido.every((i) => !/idempotency_key/.test(i.sql))).toBe(true);
    // Nem consulta a coluna: o caminho de hoje fica intocado.
    expect(db.query.mock.calls.some(([sql]) => /information_schema/.test(String(sql)))).toBe(false);
  });

  test('migration 416 ausente -> chave ignorada, pedido como antes', async () => {
    colunasDaMigration = false;
    const app = makeApp();
    const r1 = await pedir(app, { idempotency_key: 'chave-checkout-0003' });
    expect(r1.status).toBe(201);
    expect(insertsDePedido[0].sql).not.toMatch(/idempotency_key/);
  });

  test('chave fora do formato -> ignorada, pedido como antes', async () => {
    const app = makeApp();
    const r1 = await pedir(app, { idempotency_key: 'curta' });
    expect(r1.status).toBe(201);
    expect(insertsDePedido[0].sql).not.toMatch(/idempotency_key/);
  });

  test('mesma chave com outros itens -> 409, sem pedido novo', async () => {
    const app = makeApp();
    await pedir(app, { idempotency_key: 'chave-checkout-0004' });
    const r2 = await pedir(app, {
      idempotency_key: 'chave-checkout-0004',
      items: [{ product_id: 'p2', quantity: 1 }],
    });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(r2.body.order_number).toBe(1);
    expect(pedidos).toHaveLength(1);
  });

  test('repeticao sem resposta guardada: remonta o basico a partir do pedido', async () => {
    const app = makeApp();
    await pedir(app, { idempotency_key: 'chave-checkout-0005' });
    pedidos[0].idempotency_response = null;
    pedidos[0].asaas_pix_payload = '000201PIXDETESTE';
    pedidoIdem.ESPERA.totalMs = 20;
    const r2 = await pedir(app, { idempotency_key: 'chave-checkout-0005' });
    expect(r2.status).toBe(200);
    expect(r2.body.order_id).toBe('o1');
    expect(r2.body.payment_method).toBe('pix');
    expect(r2.body.pix.payload).toBe('000201PIXDETESTE');
    expect(pedidos).toHaveLength(1);
  });
});

describe('mesmosItens', () => {
  test('ordem nao importa; quantidade e variante sim', () => {
    const gravados = [
      { product_id: 'p1', variant_id: 'v1', quantity: 2 },
      { product_id: 'p2', variant_id: null, quantity: 1 },
    ];
    expect(pedidoIdem.mesmosItens([
      { product_id: 'p2', quantity: 1 }, { product_id: 'p1', variant_id: 'v1', quantity: '2' },
    ], gravados)).toBe(true);
    expect(pedidoIdem.mesmosItens([
      { product_id: 'p2', quantity: 1 }, { product_id: 'p1', variant_id: 'v2', quantity: 2 },
    ], gravados)).toBe(false);
    expect(pedidoIdem.mesmosItens([{ product_id: 'p1', variant_id: 'v1', quantity: 2 }], gravados)).toBe(false);
  });

  test('variante mandada para produto sem grade e ignorada, como a rota faz', () => {
    expect(pedidoIdem.mesmosItens(
      [{ product_id: 'p2', variant_id: 'qualquer', quantity: 1 }],
      [{ product_id: 'p2', variant_id: null, quantity: 1 }],
    )).toBe(true);
  });
});

// ── Vitrine: trava de envio e chave por tentativa ──────────────────────
describe('vitrine: submitOrder com trava e chave', () => {
  const fonte = require('../src/templates/storefront/parts/checkout.js');

  function el(extra = {}) {
    const attrs = {};
    return {
      disabled: false, textContent: '', style: {},
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      removeAttribute: (k) => { delete attrs[k]; },
      querySelector: () => null,
      ...extra,
    };
  }

  function montar(fetchImpl) {
    const detalhePix = el({ textContent: 'QR Code gerado ao confirmar' });
    const els = {
      nextBtn: el({ textContent: 'Continuar para o pagamento' }),
      opt_pix_method: el({ querySelector: () => detalhePix }),
      opt_card_method: el(),
    };
    const fetch = jest.fn(fetchImpl);
    const showToast = jest.fn();
    const render = jest.fn();
    const storage = {};
    const win = {
      localStorage: {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = v; },
        removeItem: (k) => { delete storage[k]; },
      },
      location: {},
    };
    const f = new Function(
      'document', 'window', 'fetch', 'showToast', 'saveCustomerToLocalStorage', '__render', 'crypto',
      'var SLUG="loja", API_BASE="", SETTINGS={}, SITE={}, CONTACT={}, selectedDelivery="pickup",'
      + ' shippingQuote=null, currentOrder=null, paymentMarked=false, checkoutStep=3,'
      + ' cart={a:{product_id:"p1",variant_id:null,qty:1}},'
      + ' customerData={name:"Cliente",phone:"11999999999",payment_method:"pix"};\n'
      + fonte
      + '; renderCheckoutStep = __render;'
      + ' return { submitOrder: submitOrder, estado: function(){ return { enviando: enviandoPedido, chave: chaveDoPedido, currentOrder: currentOrder }; } };'
    );
    let n = 0;
    const cryptoFalso = { randomUUID: () => 'uuid-' + (++n) + '-0000-0000' };
    const api = f({ getElementById: (id) => els[id] }, win, fetch, showToast, jest.fn(), render, cryptoFalso);
    return { api, els, fetch, showToast, render, detalhePix };
  }

  const resposta = (ok, data) => Promise.resolve({ ok, json: () => Promise.resolve(data) });
  const corpoDe = (fetch, i) => JSON.parse(fetch.mock.calls[i][1].body);
  const tique = () => new Promise((r) => setImmediate(r));

  test('toques repetidos enquanto envia -> 1 POST; botoes travados com "Enviando…"', async () => {
    let soltar;
    const { api, els, fetch, detalhePix } = montar(() => new Promise((r) => { soltar = r; }));
    api.submitOrder(); api.submitOrder(); api.submitOrder();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(corpoDe(fetch, 0).idempotency_key).toBe('uuid-1-0000-0000');
    expect(els.nextBtn.disabled).toBe(true);
    expect(els.nextBtn.textContent).toBe('Enviando…');
    expect(detalhePix.textContent).toBe('Enviando…');
    expect(els.opt_pix_method.style.pointerEvents).toBe('none');
    expect(els.opt_card_method.getAttribute('aria-disabled')).toBe('true');
    soltar({ ok: true, json: () => Promise.resolve({ order_id: 'o1', order_number: 1, payment_method: 'pix' }) });
    await tique(); await tique();
    expect(api.estado().enviando).toBe(false);
  });

  test('erro de rede: destrava e a nova tentativa usa a MESMA chave', async () => {
    const { api, els, fetch, showToast } = montar(() => Promise.reject(new Error('rede')));
    api.submitOrder();
    await tique(); await tique();
    expect(showToast).toHaveBeenCalledWith('Erro de conexão. Tente novamente.');
    expect(els.nextBtn.disabled).toBe(false);
    expect(els.nextBtn.textContent).toBe('Continuar para o pagamento');
    expect(els.opt_pix_method.style.pointerEvents).toBe('');
    api.submitOrder();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(corpoDe(fetch, 1).idempotency_key).toBe(corpoDe(fetch, 0).idempotency_key);
  });

  test('pedido criado: a proxima compra na mesma pagina leva chave nova', async () => {
    const { api, fetch, render } = montar(() => resposta(true, { order_id: 'o1', order_number: 1, payment_method: 'pix' }));
    api.submitOrder();
    await tique(); await tique();
    expect(render).toHaveBeenCalled();
    expect(api.estado().chave).toBeNull();
    api.submitOrder();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(corpoDe(fetch, 1).idempotency_key).not.toBe(corpoDe(fetch, 0).idempotency_key);
  });

  test('chave usada com outros itens (409): troca a chave', async () => {
    const { api, fetch } = montar(() => resposta(false, { code: 'IDEMPOTENCY_KEY_REUSED', error: 'x' }));
    api.submitOrder();
    await tique(); await tique();
    api.submitOrder();
    expect(corpoDe(fetch, 1).idempotency_key).not.toBe(corpoDe(fetch, 0).idempotency_key);
  });
});
