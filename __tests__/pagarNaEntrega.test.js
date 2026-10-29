// ============================================================
// AURA. — Pagar na entrega com forma, troco e aceite (tq-44, 29/10/2026)
//
// Desenho aprovado pela Nina em 19/10 (piloto: uma adega). Aqui:
//   - regra pura (services/pagarNaEntrega.js): quem entra no fluxo novo,
//     forma e troco conferidos no servidor, a frase para a lojista;
//   - rota do pedido: loja com as formas marcadas cria 'aguardando_aceite'
//     SEM baixa e SEM lancamento; loja sem as formas (inclusive as que ja
//     tinham "pagar na entrega" ligado) segue exatamente como antes;
//   - vitrine: lojas sem as formas saem byte a byte iguais (hash do HTML
//     gerado com o codigo de antes do card); a loja com as formas ganha a
//     escolha da forma e do troco.
// ============================================================
'use strict';

const crypto = require('crypto');

jest.mock('../src/services/pixService', () => ({
  generatePix: jest.fn(async () => ({
    payment_id: null, qrcode: null, payload: '000201PIXDETESTE', expires_at: null, mode: 'manual',
  })),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn() }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(async () => {}),
  notifyManualPixOrder: jest.fn(async () => {}),
  notifyPedidoAAceitar: jest.fn(async () => {}),
}));
jest.mock('../src/services/digitalOrderConfirmation', () => ({
  onOrderConfirmed: jest.fn(async () => null),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const notify = require('../src/services/digitalOrderNotifications');
const { onOrderConfirmed } = require('../src/services/digitalOrderConfirmation');
const ne = require('../src/services/pagarNaEntrega');

// ── regra pura ─────────────────────────────────────────────
describe('quem usa o fluxo com aceite', () => {
  test('so a loja com pagar na entrega ligado E formas marcadas', () => {
    expect(ne.formasDaLoja({ pay_on_delivery_enabled: true, pay_on_delivery_methods: ['pix', 'cash'] })).toEqual(['cash', 'pix']);
    expect(ne.formasDaLoja({ pay_on_delivery_enabled: true, pay_on_delivery_methods: null })).toEqual([]);
    expect(ne.formasDaLoja({ pay_on_delivery_enabled: true, pay_on_delivery_methods: [] })).toEqual([]);
    expect(ne.formasDaLoja({ pay_on_delivery_enabled: true })).toEqual([]);
    expect(ne.formasDaLoja({ pay_on_delivery_enabled: false, pay_on_delivery_methods: ['cash'] })).toEqual([]);
    expect(ne.formasDaLoja(null)).toEqual([]);
  });
  test('le text[] cru, JSON e ignora forma desconhecida', () => {
    expect(ne.normalizarFormas('{card,cash}')).toEqual(['cash', 'card']);
    expect(ne.normalizarFormas('["pix"]')).toEqual(['pix']);
    expect(ne.normalizarFormas(['boleto', 'CASH', 'cash'])).toEqual(['cash']);
    expect(ne.normalizarFormas(42)).toEqual([]);
  });
  test('o que se grava: vazio vira NULL (fluxo de hoje); undefined nao mexe', () => {
    expect(ne.formasParaGravar(undefined)).toBeUndefined();
    expect(ne.formasParaGravar(null)).toBeNull();
    expect(ne.formasParaGravar([])).toBeNull();
    expect(ne.formasParaGravar(['boleto'])).toBeNull();
    expect(ne.formasParaGravar(['pix', 'card'])).toEqual(['card', 'pix']);
  });
});

describe('forma e troco conferidos no servidor', () => {
  const formas = ['cash', 'card'];
  test('sem forma ou forma que a loja nao aceita: erro em portugues', () => {
    expect(ne.conferirPagamentoNaEntrega({ formas, forma: null, total: 78 }).erro).toMatch(/Escolha como você vai pagar/);
    expect(ne.conferirPagamentoNaEntrega({ formas, forma: 'pix', total: 78 }).erro).toMatch(/não recebe pix na hora/);
  });
  test('dinheiro com troco para 100 num pedido de 78', () => {
    expect(ne.conferirPagamentoNaEntrega({ formas, forma: 'cash', trocoPara: 100, total: 78 }))
      .toEqual({ forma: 'cash', trocoPara: 100 });
    expect(ne.conferirPagamentoNaEntrega({ formas, forma: 'cash', trocoPara: '100,50', total: 78 }))
      .toEqual({ forma: 'cash', trocoPara: 100.5 });
  });
  test('"nao preciso" e troco igual ao total viram sem troco', () => {
    expect(ne.conferirPagamentoNaEntrega({ formas, forma: 'cash', trocoPara: null, total: 78 })).toEqual({ forma: 'cash', trocoPara: null });
    expect(ne.conferirPagamentoNaEntrega({ formas, forma: 'cash', trocoPara: 0, total: 78 })).toEqual({ forma: 'cash', trocoPara: null });
    expect(ne.conferirPagamentoNaEntrega({ formas, forma: 'cash', trocoPara: 78, total: 78 })).toEqual({ forma: 'cash', trocoPara: null });
  });
  test('troco menor que o total e barrado', () => {
    expect(ne.conferirPagamentoNaEntrega({ formas, forma: 'cash', trocoPara: 50, total: 78 }).erro)
      .toBe('O valor para troco precisa ser maior que o total do pedido (R$ 78,00).');
    expect(ne.conferirPagamentoNaEntrega({ formas, forma: 'cash', trocoPara: 'abc', total: 78 }).erro).toMatch(/troco/);
  });
  test('troco so no dinheiro: cartao com troco ignora o valor', () => {
    expect(ne.conferirPagamentoNaEntrega({ formas, forma: 'card', trocoPara: 100, total: 78 })).toEqual({ forma: 'card', trocoPara: null });
  });
});

describe('a frase para a lojista', () => {
  test('dinheiro com troco calculado', () => {
    const o = { pay_on_delivery_method: 'cash', change_for: '100.00', total: '78.00' };
    expect(ne.trocoALevar(o)).toBe(22);
    expect(ne.fraseDoPagamento(o)).toBe('Dinheiro. Paga com R$ 100,00: levar R$ 22,00 de troco.');
  });
  test('dinheiro sem troco, cartao e Pix', () => {
    expect(ne.fraseDoPagamento({ pay_on_delivery_method: 'cash', change_for: null, total: 78 })).toBe('Dinheiro, sem troco.');
    expect(ne.fraseDoPagamento({ pay_on_delivery_method: 'card', total: 78 })).toBe('Cartão na máquina na entrega.');
    expect(ne.fraseDoPagamento({ pay_on_delivery_method: 'pix', total: 78 })).toBe('Pix na hora na entrega.');
  });
  test('pedido de outro tipo nao tem frase', () => {
    expect(ne.fraseDoPagamento({ payment_method: 'pix' })).toBeNull();
    expect(ne.pedidoComAceite({ payment_method: 'on_delivery' })).toBe(false);
    expect(ne.pedidoComAceite({ payment_method: 'on_delivery', pay_on_delivery_method: 'cash' })).toBe(true);
  });
});

// ── rota do pedido ─────────────────────────────────────────
const PRODUTO = { id: 'p1', name: 'Cerveja 600 ml', price: '39.00', stock_qty: 10, image_url: null, is_active: true };
let config;
let inserts;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/storefront', require('../src/routes/storefront'));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  require('../src/services/pedidoOnlineIdempotente')._resetCache();
  inserts = [];
  config = { company_id: 'c1', pickup_enabled: true, pix_key: 'chave', company_display_name: 'Adega', pay_on_delivery_enabled: true };
  const consulta = async (sql, params) => {
    const s = String(sql);
    if (/information_schema\.columns/.test(s)) return { rows: [{ n: 2 }] };
    if (/FROM digital_channel_config/.test(s)) return { rows: [config] };
    if (/FROM products/.test(s)) return { rows: [PRODUTO] };
    if (/INSERT INTO digital_orders/.test(s)) {
      inserts.push({ sql: s, params });
      return { rows: [{ id: 'o1', order_number: '0412', company_id: params[0], total: params[8], status: params[9], payment_method: params[11] }] };
    }
    return { rows: [] };
  };
  db.query.mockReset();
  db.connect.mockReset();
  db.query.mockImplementation(consulta);
  db.connect.mockImplementation(() => ({ query: jest.fn(consulta), release: jest.fn() }));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

const CORPO = {
  customer_name: 'Cliente', customer_phone: '11999999999',
  delivery_type: 'pickup', payment_method: 'on_delivery',
  items: [{ product_id: 'p1', quantity: 2 }],
};
const pedir = (extra = {}) => request(makeApp()).post('/storefront/adega/order').send({ ...CORPO, ...extra });

describe('loja sem as formas marcadas: igual a antes', () => {
  test('pagar na entrega nasce confirmado, confirma na hora e nao grava forma', async () => {
    const r = await pedir({ pay_on_delivery_method: 'cash', change_for: 100 });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('confirmed');
    expect(r.body).not.toHaveProperty('na_entrega');
    expect(inserts[0].sql).not.toMatch(/pay_on_delivery_method/);
    expect(onOrderConfirmed).toHaveBeenCalledWith('o1');
    expect(notify.notifyPaymentConfirmed).toHaveBeenCalled();
    expect(notify.notifyPedidoAAceitar).not.toHaveBeenCalled();
  });

  test('Pix pago em loja sem formas nao entra na fila de aceite', async () => {
    const r = await pedir({ payment_method: 'pix' });
    expect(r.status).toBe(201);
    expect(db.query.mock.calls.some(([s]) => /aceite_na_fila/.test(String(s)))).toBe(false);
  });
});

describe('loja com as formas marcadas: o pedido espera o aceite', () => {
  beforeEach(() => { config.pay_on_delivery_methods = ['cash', 'card']; });

  test('dinheiro com troco: aguardando_aceite, sem baixa, sem lancamento', async () => {
    const r = await pedir({ pay_on_delivery_method: 'cash', change_for: 100 });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('aguardando_aceite');
    expect(r.body.na_entrega).toEqual({ forma: 'cash', rotulo: 'Dinheiro', troco_para: 100, troco: 22 });
    expect(inserts[0].sql).toMatch(/pay_on_delivery_method, change_for/);
    expect(inserts[0].params.slice(-2)).toEqual(['cash', 100]);
    expect(inserts[0].params[9]).toBe('aguardando_aceite');
    // confirmed_at so nasce preenchido no 'confirmed'.
    expect(inserts[0].sql).toMatch(/CASE WHEN \$10 = 'confirmed' THEN NOW\(\) ELSE NULL END/);
    expect(onOrderConfirmed).not.toHaveBeenCalled();
    expect(notify.notifyPaymentConfirmed).not.toHaveBeenCalled();
    expect(notify.notifyPedidoAAceitar).toHaveBeenCalledTimes(1);
  });

  test('com chave de idempotencia os parametros continuam no lugar', async () => {
    const r = await pedir({ pay_on_delivery_method: 'card', idempotency_key: 'chave-checkout-0001' });
    expect(r.status).toBe(201);
    const { sql, params } = inserts[0];
    const n = (sql.match(/\$\d+/g) || []).map((x) => Number(x.slice(1)));
    expect(Math.max(...n)).toBe(params.length);
    expect(params.slice(-3)).toEqual(['chave-checkout-0001', 'card', null]);
  });

  test('sem forma, forma que a loja nao aceita ou troco menor que o total: 400 e nada gravado', async () => {
    expect((await pedir({})).status).toBe(400);
    expect((await pedir({ pay_on_delivery_method: 'pix' })).status).toBe(400);
    const r = await pedir({ pay_on_delivery_method: 'cash', change_for: 50 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('O valor para troco precisa ser maior que o total do pedido (R$ 78,00).');
    expect(inserts).toHaveLength(0);
  });

  test('Pix online da mesma loja segue como hoje e nasce marcado para a fila de aceite', async () => {
    const r = await pedir({ payment_method: 'pix' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending_payment');
    expect(inserts[0].sql).not.toMatch(/pay_on_delivery_method/);
    expect(db.query.mock.calls.some(([s]) => /SET aceite_na_fila = TRUE/.test(String(s)))).toBe(true);
  });

  test('pagar na entrega nao usa a marca (ja nasce aguardando aceite)', async () => {
    await pedir({ pay_on_delivery_method: 'cash' });
    expect(db.query.mock.calls.some(([s]) => /aceite_na_fila/.test(String(s)))).toBe(false);
  });
});

// ── vitrine ────────────────────────────────────────────────
describe('vitrine', () => {
  const buildPage = require('../src/templates/storefrontPage');
  const dados = require('./fixtures/vitrineSemPagarNaEntregaNova/dados');
  const hashes = require('./fixtures/vitrineSemPagarNaEntregaNova/hashes.json');
  const { formasNaEntregaNoPayload } = require('../src/services/storefrontBuilder');
  const naEntrega = require('../src/templates/storefront/parts/na_entrega');
  const checkout = require('../src/templates/storefront/parts/checkout');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

  test.each(Object.keys(hashes))('loja sem as formas (%s): HTML byte a byte igual ao de antes', (nome) => {
    const html = buildPage(dados[nome](), 'loja-exemplo');
    expect({ bytes: Buffer.byteLength(html), sha256: sha(html) }).toEqual(hashes[nome]);
  });

  test('o payload so ganha a chave quando a loja marcou formas', () => {
    expect(formasNaEntregaNoPayload({ pay_on_delivery_enabled: true, pay_on_delivery_methods: null })).toEqual({});
    expect(formasNaEntregaNoPayload({ pay_on_delivery_enabled: true, pay_on_delivery_methods: [] })).toEqual({});
    expect(formasNaEntregaNoPayload({ pay_on_delivery_enabled: false, pay_on_delivery_methods: ['cash'] })).toEqual({});
    expect(formasNaEntregaNoPayload({ pay_on_delivery_enabled: true, pay_on_delivery_methods: ['card', 'cash'] }))
      .toEqual({ pay_on_delivery_methods: ['cash', 'card'] });
  });

  test('loja com as formas: escolha da forma e do troco, e o script continua valido', () => {
    const d = dados.na_entrega_legado();
    d.settings.pay_on_delivery_methods = ['cash', 'card'];
    const html = buildPage(d, 'loja-exemplo');
    expect(html).toContain("eod.addEventListener('click',function(){abrirPagarNaEntrega();});");
    expect(html).toContain('function renderPagarNaEntrega(body,btn)');
    expect(html).toContain('Troco para quanto?');
    expect(html).toContain("pay_on_delivery_method:customerData.payment_method==='on_delivery'?NA_ENTREGA.forma:null");
    expect(html).not.toContain("chooseMethod('on_delivery')");
    const ini = html.indexOf('<script>\nvar __S');
    const js = html.slice(ini + '<script>'.length, html.indexOf('</script>', ini));
    expect(() => new Function(js)).not.toThrow();
  });

  test('cada troca acha o seu trecho do checkout uma vez so', () => {
    for (const [de] of naEntrega.TROCAS) expect(checkout.split(de).length - 1).toBe(1);
    expect(() => naEntrega.aplicar(checkout.replace("chooseMethod('on_delivery')", 'x'))).toThrow(/na_entrega/);
  });
});
