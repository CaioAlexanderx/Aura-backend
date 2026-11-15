// ============================================================
// A sacola esvazia quando o pedido ja nasceu (p-123b, 14/11/2026)
//
// QA da Black Friday na loja real: depois do pedido Pix criado, a sacola
// continuava com o item ("1 no carrinho"). Era o comportamento de sempre: a
// sacola so esvaziava no "Ja paguei", na confirmacao do Pix ou no botao final
// do pagar na entrega. Agora fechar o checkout com o pedido criado (Pix ou na
// entrega) esvazia; cartao nao (recusado no Mercado Pago, volta com a sacola).
// ============================================================
'use strict';

const checkout = require('../src/templates/storefront/parts/checkout');

/** closeCheckout de verdade, num ambiente minimo. */
function ambiente() {
  const ini = checkout.indexOf('function closeCheckout(){');
  const fim = checkout.indexOf('function checkoutBack(){');
  const fonte = checkout.slice(ini, fim);
  const doc = { getElementById: () => ({ classList: { remove() {} } }), body: { style: {} } };
  const chamadas = [];
  const fn = new Function('document', 'window', 'SLUG', 'registrar',
    'var cart={a:{qty:1}},paymentMarked=false,currentOrder=null,pollInterval=null,timerInterval=null;'
    + 'function updateCartUI(){registrar("updateCartUI");} function renderProducts(){registrar("renderProducts");}'
    + fonte
    + '; return { closeCheckout: closeCheckout, cart: function(){return cart;}, armar: function(v){esvaziarSacolaAoFechar=v;}, flag: function(){return esvaziarSacolaAoFechar;} };');
  const api = fn(doc, { localStorage: { removeItem() {} } }, 'loja', (x) => chamadas.push(x));
  return { ...api, chamadas };
}

test('fechar sem pedido criado: a sacola fica', () => {
  const a = ambiente();
  a.closeCheckout();
  expect(a.cart()).toEqual({ a: { qty: 1 } });
  expect(a.chamadas).toEqual([]);
});

test('fechar com o pedido criado: a sacola esvazia, uma vez so', () => {
  const a = ambiente();
  a.armar(true);
  a.closeCheckout();
  expect(a.cart()).toEqual({});
  expect(a.chamadas).toEqual(['updateCartUI', 'renderProducts']);
  expect(a.flag()).toBe(false);
});

test('o pedido criado arma a limpeza, menos no cartao (novo e retomado)', () => {
  const armar = "esvaziarSacolaAoFechar=currentOrder.payment_method!=='card';";
  expect(checkout.split(armar).length - 1).toBe(2);
  // Logo depois do pedido criado e do pedido retomado pelo dedup.
  expect(checkout.indexOf(armar, checkout.indexOf('currentOrder=res.data; paymentMarked=false;'))).toBeGreaterThan(0);
  expect(checkout.indexOf(armar, checkout.indexOf('currentOrder=Object.assign({},o,{pix:p.pix||null'))).toBeGreaterThan(0);
});
