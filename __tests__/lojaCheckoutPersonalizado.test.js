// ============================================================
// O checkout da loja comum com a peca personalizada (p-183, loja unica
// 3.3c, 17/11/2026). Mockup p-132, versao A (sacola mista e checkout).
//
// O que este teste segura:
//   1. o checkout manda o `customization` no POST /order (contrato do
//      p-184) e a sacola mista (prateleira + personalizado) vira UM pedido;
//   2. o resumo do checkout: miniatura, resumo da escolha, Editar e
//      Remover, o aviso "Voce aprova a arte antes da producao" e o Pix de
//      72 h; a tela do Pix criado repete o prazo;
//   3. o 400 de personalizacao aparece para a cliente e marca a linha; a
//      sacola antiga (peca personalizavel sem a escolha) pede "Personalizar"
//      em vez de ir ao servidor e levar o 400;
//   4. a loja sem personalizavel fica igual: o script e a pagina nao
//      trazem nada disto (o fixture por hash do p-179 roda em
//      lojaSemPersonalizavel.fixture.test.js).
//
// Os trechos do checkout rodam DE VERDADE: state_utils, sacola, cart,
// checkout e pix com as trocas, a ponte do quadro e o EXTRA deste card,
// num DOM de mentira.
// ============================================================
'use strict';

const stateUtils = require('../src/templates/storefront/parts/state_utils');
const sacolaSrc = require('../src/templates/storefront/parts/sacola');
const cartSrc = require('../src/templates/storefront/parts/cart');
const checkoutSrc = require('../src/templates/storefront/parts/checkout');
const pixSrc = require('../src/templates/storefront/parts/pix');
const toastSrc = require('../src/templates/storefront/parts/toast');
const naEntrega = require('../src/templates/storefront/parts/na_entrega');
const quadro = require('../src/templates/storefront/parts/quadro');
const pedidoPz = require('../src/templates/storefront/parts/pedido_personalizado');
const buildScript = require('../src/templates/storefront/index');
const { PRAZO_HORAS_STUDIO } = require('../src/jobs/lojaPixExpiradoJob');

const CANECA = '0b1a9999-0000-4000-8000-000000000001';
const BOLSA = '0b1a1111-0000-4000-8000-000000000001';
const ORIGEM = 'https://loja.getaura.com.br';
const ERRO_DO_NOME = 'Personalizacao de "Caneca personalizada": campo "Nome" obrigatorio';

// ── Um DOM de mentira, so o que o checkout usa ──────────────────
function elemento(tag) {
  const filhos = {};
  return {
    tagName: String(tag || 'div').toUpperCase(), className: '', innerHTML: '', hidden: false, textContent: '',
    value: '', disabled: false, attrs: {}, style: {}, parentNode: null, ouvintes: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    addEventListener(t, f) { (this.ouvintes[t] = this.ouvintes[t] || []).push(f); },
    focus() {},
    querySelector(sel) {
      if (!filhos[sel]) {
        filhos[sel] = elemento(sel === 'iframe' ? 'iframe' : 'span');
        if (sel === 'iframe') filhos[sel].contentWindow = { postMessage: jest.fn() };
      }
      return filhos[sel];
    },
  };
}

const escapar = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A loja com personalizavel no navegador de mentira. `responder(url, corpo)`
 * devolve { status, json } por chamada; tudo o que sai fica em `chamadas`.
 */
function montarLoja({ responder, settings = {} } = {}) {
  const els = {};
  const ouvintesDoc = {};
  const ouvintesJanela = {};
  const body = { style: { overflow: '' }, filhos: [], appendChild(e) { e.parentNode = body; this.filhos.push(e); }, removeChild(e) { e.parentNode = null; this.filhos = this.filhos.filter((x) => x !== e); } };
  const document = {
    body, activeElement: null, documentElement: { style: { setProperty() {} } },
    createElement: elemento,
    getElementById: (id) => (els[id] = els[id] || elemento('div')),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (t, f) => { (ouvintesDoc[t] = ouvintesDoc[t] || []).push(f); },
  };
  const guardado = {};
  const window = {
    addEventListener: (t, f) => { (ouvintesJanela[t] = ouvintesJanela[t] || []).push(f); },
    localStorage: {
      getItem: (k) => (k in guardado ? guardado[k] : null),
      setItem: (k, v) => { guardado[k] = String(v); },
      removeItem: (k) => { delete guardado[k]; },
    },
    confirm: () => false,
    location: { href: '' },
  };
  const chamadas = [];
  const fetch = jest.fn(async (url, opts = {}) => {
    const corpo = opts.body ? JSON.parse(opts.body) : null;
    chamadas.push({ url, metodo: opts.method || 'GET', corpo });
    const r = responder(url, corpo) || { status: 200, json: {} };
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  });
  const SETTINGS = Object.assign({ pickup_enabled: true, has_pix: true }, settings);
  const PROD_MAP = {
    [CANECA]: { id: CANECA, name: 'Caneca personalizada', price: 38, personalizavel: true, image_url: 'https://r2.exemplo/caneca.jpg' },
    [BOLSA]: { id: BOLSA, name: 'Bolsa Tiracolo', price: 219.9, image_url: null },
  };
  const fonte = stateUtils
    + 'function esc(s){ return ESCAPAR(s); }\n'
    + pedidoPz.aplicarNoResumo(quadro.aplicarNaSacola(sacolaSrc))
    + quadro.aplicarNoCarrinho(cartSrc)
    + pedidoPz.aplicarNoCheckout(checkoutSrc)
    + pixSrc
    + quadro.PONTE
    + pedidoPz.EXTRA
    + toastSrc
    + `\nreturn {
      cart: function(){ return cart; },
      definirSacola: function(c){ cart=c; },
      submitOrder: submitOrder, openCheckout: openCheckout, renderCheckoutStep: renderCheckoutStep,
      updateCartUI: updateCartUI, conferirPrecosDaSacola: conferirPrecosDaSacola,
      renderResumoDoCheckout: renderResumoDoCheckout, abrirQuadro: abrirQuadro,
      quadroAberto: function(){ return QUADRO; },
      estado: function(){ return { checkoutStep: checkoutStep, currentOrder: currentOrder, customerData: customerData, erro: erroDaPersonalizacao }; },
      preparar: function(o){ checkoutStep=o.checkoutStep; customerData=o.customerData; selectedDelivery=o.selectedDelivery||'pickup'; },
    };`;
  const api = new Function(
    'window', 'document', 'location', 'fetch', 'SLUG', 'API_BASE', 'SETTINGS', 'CONTACT', 'SITE', '__S', 'PROD_MAP',
    'INICIAIS', 'escJsAttr', 'renderProducts', 'PARCELAS_TXT', 'ESCAPAR', 'setTimeout', 'clearTimeout',
    fonte,
  )(
    window, document, { pathname: '/atelie', origin: ORIGEM }, fetch, 'atelie', '', SETTINGS, { whatsapp: '' },
    { primary_color: '#2a221b' }, {}, PROD_MAP,
    (n) => String(n).slice(0, 2), (s) => String(s), () => {}, () => '', escapar,
    () => 0, () => {},
  );
  const emitir = (tipo, ev) => (ouvintesJanela[tipo] || []).forEach((f) => f(ev));
  const clicar = (alvo) => (ouvintesDoc.click || []).forEach((f) => f({ target: { closest: () => alvo } }));
  return { api, els, chamadas, emitir, clicar, guardado };
}

const esperar = () => new Promise((r) => setImmediate(r));
const pedidos = (chamadas) => chamadas.filter((c) => /\/storefront\/atelie\/order$/.test(c.url) && c.metodo === 'POST');
const conferencias = (chamadas) => chamadas.filter((c) => /\/sacola\/precos$/.test(c.url));

const linhaDaBolsa = () => ({ key: BOLSA, product_id: BOLSA, variant_id: null, name: 'Bolsa Tiracolo', price: 219.9, image_url: null, qty: 1 });
const linhaDaCaneca = (extra) => Object.assign({
  key: `pz-${CANECA}-a`, product_id: CANECA, variant_id: null, name: 'Caneca personalizada', price: 38, subtotal: 81, qty: 2,
  image_url: 'data:image/jpeg;base64,AAAA', personalizado: true,
  customization: { nome: 'Ana', arte: 'https://r2.exemplo/studio/arte.png', has_back_selected: false },
  resumo: ['Nome: Ana', 'Arte: arte.png'], rev: 1,
}, extra || {});

/** O POST /order de sempre e o /sacola/precos devolvendo o que a sacola tem. */
function servidorQueAceita() {
  return (url, corpo) => {
    if (/\/sacola\/precos$/.test(url)) {
      return { status: 200, json: { itens: corpo.items.map((it, indice) => (it.customization
        ? { indice, product_id: it.product_id, variant_id: null, personalizado: true, preco: 38, subtotal: 81, disponivel: true }
        : { indice, product_id: it.product_id, variant_id: null, preco: 219.9, disponivel: true })) } };
    }
    if (/\/order$/.test(url)) {
      return { status: 201, json: {
        order_id: 'o1', order_number: 42, payment_method: 'pix', subtotal: 300.9, delivery_fee: 0, total: 300.9,
        pix: { payload: '00020126PIX' }, personalizado: true, studio_production_status: 'pending_art',
        itens: [
          { product_id: BOLSA, variant_id: null, unit_price: 219.9 },
          { product_id: CANECA, variant_id: null, unit_price: 38, subtotal: 81, personalizado: true },
        ],
      } };
    }
    return null;
  };
}

// ── 1. O checkout manda o customization; a sacola mista e um pedido so ──
describe('o pedido da sacola mista', () => {
  test('o POST /order leva o personalizado com o customization, sem variante, junto da prateleira', async () => {
    const loja = montarLoja({ responder: servidorQueAceita() });
    loja.api.definirSacola({ [BOLSA]: linhaDaBolsa(), [`pz-${CANECA}-a`]: linhaDaCaneca() });
    loja.api.preparar({ checkoutStep: 3, customerData: { name: 'Cliente', phone: '11999990000', payment_method: 'pix' } });
    loja.api.submitOrder();
    await esperar(); await esperar();

    const enviados = pedidos(loja.chamadas);
    expect(enviados).toHaveLength(1); // um pedido so
    expect(enviados[0].corpo.items).toEqual([
      { product_id: BOLSA, variant_id: null, quantity: 1 },
      { product_id: CANECA, quantity: 2, customization: { nome: 'Ana', arte: 'https://r2.exemplo/studio/arte.png', has_back_selected: false } },
    ]);
    expect(enviados[0].corpo.payment_method).toBe('pix');
    expect(enviados[0].corpo.idempotency_key).toBeTruthy();

    // O pedido criado: a tela do Pix diz o prazo de 72 h e o aviso da arte.
    expect(loja.api.estado().currentOrder.personalizado).toBe(true);
    const tela = loja.els.checkoutBody.innerHTML;
    expect(tela).toContain(`Você tem até ${PRAZO_HORAS_STUDIO} horas para pagar o Pix.`);
    expect(tela).toContain('a gente mostra a arte para você aprovar, e só então produz.');
    // O resumo fica com o que o servidor cobrou, e sem Editar/Remover.
    expect(loja.api.cart()[`pz-${CANECA}-a`]).toMatchObject({ price: 38, subtotal: 81 });
    expect(loja.els.checkoutResumo.innerHTML).not.toContain('data-pzq-editar');
  });

  test('a soma da sacola usa a linha inteira do personalizado (a arte entra uma vez)', () => {
    const loja = montarLoja({ responder: servidorQueAceita() });
    loja.api.definirSacola({ [BOLSA]: linhaDaBolsa(), [`pz-${CANECA}-a`]: linhaDaCaneca() });
    loja.api.updateCartUI();
    // 219,90 + 81,00 (38 x 2 + 5 da arte), nao 219,90 + 76,00.
    expect(loja.els.cartSubtotal.textContent).toBe('R$ 300,90');
    expect(loja.els.cartItems.innerHTML).toContain('R$ 81,00');
  });

  test('pedido so de prateleira na loja com personalizavel: o corpo de sempre', async () => {
    const loja = montarLoja({ responder: () => ({ status: 201, json: { order_id: 'o2', order_number: 43, payment_method: 'pix', subtotal: 219.9, delivery_fee: 0, total: 219.9, pix: { payload: 'x' }, itens: [] } }) });
    loja.api.definirSacola({ [BOLSA]: linhaDaBolsa() });
    loja.api.preparar({ checkoutStep: 3, customerData: { name: 'Cliente', phone: '11999990000', payment_method: 'pix' } });
    loja.api.submitOrder();
    await esperar(); await esperar();
    expect(pedidos(loja.chamadas)[0].corpo.items).toEqual([{ product_id: BOLSA, variant_id: null, quantity: 1 }]);
    expect(loja.els.checkoutBody.innerHTML).not.toContain('horas para pagar o Pix');
  });
});

// ── 2. O resumo do checkout ─────────────────────────────────────
describe('o resumo do checkout', () => {
  test('miniatura, "Personalizada", resumo, Editar, Remover e o aviso da arte com o Pix de 72 h', () => {
    const loja = montarLoja({ responder: servidorQueAceita() });
    loja.api.definirSacola({ [BOLSA]: linhaDaBolsa(), [`pz-${CANECA}-a`]: linhaDaCaneca({ name: 'Caneca <b>' }) });
    loja.api.renderResumoDoCheckout();
    const h = loja.els.checkoutResumo.innerHTML;
    expect(h).toContain('Bolsa Tiracolo'); // a prateleira continua com a linha de sempre
    expect(h).toContain('<div class="resumo-item pzq-resumo-item"><div class="resumo-thumb"><img src="data:image/jpeg;base64,AAAA" alt=""></div>');
    expect(h).toContain('Caneca &lt;b&gt; <span class="pzq-pill">Personalizada</span>');
    expect(h).toContain('Nome: Ana · Arte: arte.png<br>2 un.');
    expect(h).toContain(`data-pzq-editar="pz-${CANECA}-a">Editar</button>`);
    expect(h).toContain(`data-pzq-remover="pz-${CANECA}-a">Remover</button>`);
    expect(h).toContain('R$ 81,00');
    expect(h).toContain('<b>Você aprova a arte antes da produção.</b>');
    expect(h).toContain(`O Pix deste pedido vale por ${PRAZO_HORAS_STUDIO} horas.`);
    expect(h).toContain('R$ 300,90'); // subtotal com a arte
  });

  test('sem Pix na loja, o aviso da arte fica e o prazo do Pix sai', () => {
    const loja = montarLoja({ responder: servidorQueAceita(), settings: { has_pix: false, has_card: true } });
    loja.api.definirSacola({ [`pz-${CANECA}-a`]: linhaDaCaneca() });
    loja.api.renderResumoDoCheckout();
    expect(loja.els.checkoutResumo.innerHTML).toContain('Você aprova a arte antes da produção.');
    expect(loja.els.checkoutResumo.innerHTML).not.toContain('horas.');
  });

  test('Editar pelo resumo reabre o quadro por cima do checkout e volta para ele, sem abrir a sacola', () => {
    const loja = montarLoja({ responder: servidorQueAceita() });
    loja.api.definirSacola({ [`pz-${CANECA}-a`]: linhaDaCaneca() });
    loja.els.checkoutOverlay = elemento('div');
    loja.els.checkoutOverlay.classList.add('open');
    loja.els.cartDrawer = elemento('div');
    const chave = `pz-${CANECA}-a`;
    loja.clicar({ hasAttribute: (k) => k === 'data-pzq-editar', getAttribute: (k) => (k === 'data-pzq-editar' ? chave : null) });
    const q = loja.api.quadroAberto();
    expect(q.doCheckout).toBe(true);
    loja.emitir('message', { origin: ORIGEM, source: q.iframe.contentWindow, data: {
      fonte: 'aura:personalizador', versao: 1, tipo: 'confirmou', produto_id: CANECA, nome: 'Caneca personalizada', quantidade: 3,
      customization: { nome: 'Bia' }, resumo: ['Nome: Bia'], preco: { unitario: 38, total: 119, fonte: 'servidor' }, miniatura: null, editando: true,
    } });
    expect(Object.keys(loja.api.cart())).toEqual([chave]);
    expect(loja.api.cart()[chave]).toMatchObject({ qty: 3, subtotal: 119, customization: { nome: 'Bia' } });
    expect(loja.els.cartDrawer.classList.contains('open')).toBe(false);
    expect(loja.els.checkoutResumo.innerHTML).toContain('Nome: Bia<br>3 un.');
  });

  test('Remover pelo resumo tira a linha inteira', () => {
    const loja = montarLoja({ responder: servidorQueAceita() });
    loja.api.definirSacola({ [BOLSA]: linhaDaBolsa(), [`pz-${CANECA}-a`]: linhaDaCaneca() });
    const chave = `pz-${CANECA}-a`;
    loja.clicar({ hasAttribute: (k) => k === 'data-pzq-remover', getAttribute: (k) => (k === 'data-pzq-remover' ? chave : null) });
    expect(Object.keys(loja.api.cart())).toEqual([BOLSA]);
    expect(loja.els.checkoutResumo.innerHTML).not.toContain('Personalizada');
  });
});

// ── 3. O 400 de personalizacao e a sacola antiga ────────────────
describe('a personalizacao recusada', () => {
  test('o 400 aparece para a cliente, marca a linha e o proximo toque nao vai ao servidor', async () => {
    const loja = montarLoja({ responder: (url, corpo) => {
      if (/\/order$/.test(url)) return { status: 400, json: { error: ERRO_DO_NOME } };
      if (/\/sacola\/precos$/.test(url)) {
        return { status: 200, json: { itens: corpo.items.map((it, indice) => ({ indice, product_id: it.product_id, variant_id: null, personalizado: true, preco: null, subtotal: null, disponivel: false, motivo: 'personalizacao' })) } };
      }
      return null;
    } });
    loja.api.definirSacola({ [`pz-${CANECA}-a`]: linhaDaCaneca({ customization: { nome: '' } }) });
    loja.api.preparar({ checkoutStep: 3, customerData: { name: 'Cliente', phone: '11999990000', payment_method: 'pix' } });
    loja.api.submitOrder();
    await esperar(); await esperar(); await esperar();

    const texto = 'Revise a personalização de "Caneca personalizada": campo "Nome" obrigatório.';
    expect(loja.els.toast.textContent).toBe(texto);
    expect(loja.els.checkoutResumo.innerHTML).toContain(`<p class="aviso-fechada pzq-erro" role="alert">${texto}</p>`);
    // A conferencia marcou a linha: ela pede revisao e o Editar segue la.
    expect(conferencias(loja.chamadas)).toHaveLength(1);
    expect(loja.api.cart()[`pz-${CANECA}-a`].pendente).toBe(true);
    expect(loja.els.checkoutResumo.innerHTML).toContain('Revise a personalização desta peça antes de finalizar.');
    expect(loja.api.estado().currentOrder).toBeNull();

    // O proximo toque nem sai: o servidor recusaria de novo.
    loja.api.submitOrder();
    await esperar();
    expect(pedidos(loja.chamadas)).toHaveLength(1);
    expect(loja.els.toast.textContent).toBe('Revise a personalização de "Caneca personalizada" antes de finalizar.');
  });

  test('outro 400 (estoque, por exemplo) segue o aviso de sempre', async () => {
    const loja = montarLoja({ responder: (url) => (/\/order$/.test(url) ? { status: 400, json: { error: 'Estoque insuficiente para Bolsa Tiracolo' } } : null) });
    loja.api.definirSacola({ [BOLSA]: linhaDaBolsa() });
    loja.api.preparar({ checkoutStep: 3, customerData: { name: 'Cliente', phone: '11999990000', payment_method: 'pix' } });
    loja.api.submitOrder();
    await esperar(); await esperar();
    expect(loja.els.toast.textContent).toBe('Estoque insuficiente para Bolsa Tiracolo');
    expect(loja.api.estado().erro).toBe('');
  });

  test('sacola antiga sem a escolha: a linha pede "Personalizar" e o pedido espera', async () => {
    const loja = montarLoja({ responder: (url, corpo) => {
      if (/\/sacola\/precos$/.test(url)) {
        return { status: 200, json: { itens: corpo.items.map((it, indice) => (it.product_id === CANECA
          ? { indice, product_id: CANECA, variant_id: null, personalizado: true, preco: null, subtotal: null, disponivel: false, motivo: 'personalizacao' }
          : { indice, product_id: it.product_id, variant_id: null, preco: 219.9, disponivel: true })) } };
      }
      return { status: 201, json: { order_id: 'o3', order_number: 44, payment_method: 'pix', subtotal: 1, delivery_fee: 0, total: 1, pix: { payload: 'x' }, itens: [] } };
    } });
    // Guardada antes de a loja ter o personalizador: peca comum, sem customization.
    loja.api.definirSacola({
      [BOLSA]: linhaDaBolsa(),
      [CANECA]: { key: CANECA, product_id: CANECA, variant_id: null, name: 'Caneca personalizada', price: 38, image_url: null, qty: 1 },
    });
    await loja.api.conferirPrecosDaSacola();
    expect(conferencias(loja.chamadas)[0].corpo.items[1]).toEqual({ product_id: CANECA, variant_id: null, quantity: 1 });
    expect(loja.api.cart()[CANECA].pendente).toBe(true);
    const sacola = loja.els.cartItems.innerHTML;
    expect(sacola).toContain('Falta escolher a personalização desta peça.');
    expect(sacola).toContain(`data-pzq-editar="${CANECA}">Personalizar</button>`);

    loja.api.preparar({ checkoutStep: 3, customerData: { name: 'Cliente', phone: '11999990000', payment_method: 'pix' } });
    loja.api.submitOrder();
    await esperar();
    expect(pedidos(loja.chamadas)).toHaveLength(0);
    expect(loja.els.toast.textContent).toBe('Falta escolher a personalização de "Caneca personalizada". Toque em Personalizar.');

    // "Personalizar": a escolha nova toma o lugar da linha antiga.
    loja.clicar({ hasAttribute: (k) => k === 'data-pzq-editar', getAttribute: (k) => (k === 'data-pzq-editar' ? CANECA : null) });
    const q = loja.api.quadroAberto();
    loja.emitir('message', { origin: ORIGEM, source: q.iframe.contentWindow, data: {
      fonte: 'aura:personalizador', versao: 1, tipo: 'pronto', produto_id: CANECA } });
    expect(q.iframe.contentWindow.postMessage).not.toHaveBeenCalled(); // nada para editar
    loja.emitir('message', { origin: ORIGEM, source: q.iframe.contentWindow, data: {
      fonte: 'aura:personalizador', versao: 1, tipo: 'confirmou', produto_id: CANECA, nome: 'Caneca personalizada', quantidade: 1,
      customization: { nome: 'Ana' }, resumo: ['Nome: Ana'], preco: { unitario: 38, total: 38, fonte: 'servidor' }, miniatura: null, editando: false,
    } });
    const linhas = Object.values(loja.api.cart());
    expect(linhas.map((l) => l.product_id)).toEqual([BOLSA, CANECA]);
    expect(linhas[1]).toMatchObject({ personalizado: true, customization: { nome: 'Ana' } });
    expect(linhas[1].key).toMatch(/^pz-/);
    expect(linhas[1].pendente).toBeUndefined();
  });

  test('a mensagem do servidor vira o texto da cliente; outra mensagem nao e de personalizacao', () => {
    const f = new Function('cart', 'linhaPendente', `${pedidoPz.EXTRA}\nreturn mensagemDaPersonalizacao;`)({}, () => false);
    expect(f(ERRO_DO_NOME)).toBe('Revise a personalização de "Caneca personalizada": campo "Nome" obrigatório.');
    expect(f('Personalizacao de "Caneca": customization obrigatoria'))
      .toBe('Falta escolher a personalização de "Caneca". Toque em Personalizar na sacola.');
    expect(f('Personalizacao de "Caneca": informe a arte em "Foto"')).toBe('Revise a personalização de "Caneca": informe a arte em "Foto".');
    expect(f('Estoque insuficiente')).toBe('');
  });
});

// ── 4. A loja sem personalizavel ────────────────────────────────
describe('a loja sem personalizavel', () => {
  test('o script nao traz nada do checkout personalizado, com e sem pagar na entrega', () => {
    for (const opcoes of [{}, { naEntrega: true }, { promocao: true }]) {
      const s = buildScript('{}', 'atelie', '', null, opcoes);
      for (const marca of ['itemParaOServidor', 'barrarPendenteDaPersonalizacao', 'htmlDoResumoPersonalizado', 'erroDaPersonalizacao', 'totalDaLinha']) {
        expect(s).not.toContain(marca);
      }
      expect(s).toContain('var items=Object.values(cart).map(function(i){return{product_id:i.product_id,variant_id:i.variant_id||null,quantity:i.qty};});');
    }
  });

  test('cada troca acha o trecho uma vez, tambem com o pagar na entrega', () => {
    expect(() => pedidoPz.aplicarNoCheckout(checkoutSrc)).not.toThrow();
    expect(() => pedidoPz.aplicarNoCheckout(naEntrega.aplicar(checkoutSrc))).not.toThrow();
    expect(() => pedidoPz.aplicarNoResumo(quadro.aplicarNaSacola(sacolaSrc))).not.toThrow();
    // Com personalizavel e pagar na entrega, o script inteiro e JS valido.
    const s = buildScript('{}', 'atelie', '', null, { personalizavel: true, naEntrega: true });
    expect(() => new Function(s.slice('<script>'.length, s.lastIndexOf('<')))).not.toThrow();
    expect(s).toContain('if(barrarPendenteDaPersonalizacao()) return;');
  });

});
