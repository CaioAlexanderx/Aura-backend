// ============================================================
// A ponte da loja comum com o personalizador no quadro (p-182, loja
// unica 3.3b, 17/11/2026). Mockup p-132, versao A.
//
// O que este teste segura:
//   1. loja SEM personalizavel: a CSP de sempre e nada da ponte (o fixture
//      por hash do p-179 continua em lojaSemPersonalizavel.fixture.test.js);
//   2. loja COM personalizavel: o JS da ponte, o CSS do quadro e a CSP com
//      `frame-src 'self'`, tambem na home lembrada (60 s);
//   3. a rota do quadro (/<slug>/personalizar/<id>): casca do app pelo host
//      da loja, so a loja enquadra, nunca indexada; falha com a marca;
//   4. a ponte rodando de verdade: origem estranha, janela estranha e
//      envelope errado sao ignorados; `confirmou` vira item da sacola com
//      miniatura e resumo; "Editar" manda o `editar` e troca no lugar;
//   5. a sacola: a linha do personalizado, o aviso, a sacola guardada e a
//      conferencia de preco (p-124) sem o personalizado;
//   6. `site.dominio_proprio` no /studio/products so com dominio ativo.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const cache = require('../src/services/cacheDaPaginaDaLoja');
const { customDomainMiddleware } = require('../src/middleware/customDomain');
const shell = require('../src/services/vitrineStudioShell');
const storefront = require('../src/routes/storefront');
const studioStorefront = require('../src/routes/studioStorefront');
const quadro = require('../src/templates/storefront/parts/quadro');
const sacolaSrc = require('../src/templates/storefront/parts/sacola');
const cartSrc = require('../src/templates/storefront/parts/cart');
const { AGORA, cenarios } = require('./fixtures/lojaSemPersonalizavel/dados');

const CANECA = '0b1a9999-0000-4000-8000-000000000001';
const ORIGEM = 'https://loja.getaura.com.br';

// ── O banco de mentira (o mesmo roteiro do lojaPersonalizavelBanner) ──
function lojaComPersonalizavel() {
  const loja = cenarios.loja_simples();
  loja.produtos = loja.produtos.concat([Object.assign({}, loja.produtos[0], {
    id: CANECA, name: 'Caneca personalizada', price: '38.00', stock_qty: '0', personalizavel: true,
  })]);
  return loja;
}

let naoRespondidas = [];
let pecaPersonalizavel = true;
function bancoDa(loja, { temPersonalizavel }) {
  return async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    const cabeca = s.split(' WHERE ')[0];
    const ids = Array.isArray(params[0]) ? params[0] : [];
    if (s.startsWith('WITH todos AS')) return { rows: loja.resumo ? [loja.resumo] : [] };
    if (s.startsWith('WITH visiveis AS')) return { rows: loja.arvore };
    if (s.startsWith('WITH pecas AS')) return { rows: loja.capas };
    if (s.includes(' AS restam')) return { rows: loja.ultimas };
    if (s.includes(' AS vendidos')) return { rows: loja.mais_vendidos };
    if (s.includes(' AS atributo')) return { rows: loja.facetas };
    if (s.includes('category AS nome')) return { rows: loja.barra };
    if (s.includes('::float AS min')) return { rows: [loja.faixa] };
    if (s.includes('COUNT(*)::int AS n')) return { rows: [{ n: loja.total, tem_personalizavel: temPersonalizavel }] };
    if (/FROM product_variants pv /.test(s)) return { rows: loja.variantes.filter((v) => ids.includes(v.product_id)) };
    // A rota do quadro: a loja publicada e a peca personalizavel dela.
    if (s.startsWith('SELECT company_id FROM digital_channel_config')) {
      return { rows: params[0] === loja.config.slug ? [{ company_id: loja.config.company_id }] : [] };
    }
    if (s.startsWith('SELECT 1 FROM products')) {
      const ok = pecaPersonalizavel && params[0] === loja.config.company_id && params[1] === CANECA
        && s.includes('products.is_personalizable IS TRUE');
      return { rows: ok ? [{ '?column?': 1 }] : [] };
    }
    if (s.includes('WHERE custom_domain = $1')) {
      return { rows: params[0] === 'www.atelie.com.br' ? [{ slug: loja.config.slug }] : [] };
    }
    if (cabeca.includes('company_pdv_settings') || cabeca === 'SELECT * FROM digital_channel_config') {
      return { rows: params[0] === loja.config.slug ? [loja.config] : [] };
    }
    if (cabeca.includes('FROM companies_payment_gateways')) return { rows: loja.gateway };
    if (cabeca.startsWith('SELECT trade_name')) return { rows: [loja.empresa] };
    if (cabeca.includes('FROM product_category_links')) return { rows: loja.vinculos.filter((l) => ids.includes(l.product_id)) };
    if (cabeca.includes('FROM product_categories')) return { rows: loja.categorias };
    if (cabeca.includes('FROM product_images')) return { rows: [] };
    if (cabeca.includes('FROM products')) {
      if (cabeca.includes('stock_min')) return { rows: loja.novidades };
      if (s.includes('AND id = $2')) return { rows: loja.produtos.filter((p) => p.id === params[1]) };
      return { rows: loja.produtos };
    }
    naoRespondidas.push(s.slice(0, 160));
    throw new Error('consulta sem resposta no teste: ' + s.slice(0, 160));
  };
}

// A porta de verdade: middleware de dominio + os routers de /storefront.
const app = express();
app.set('trust proxy', 1);
app.use(customDomainMiddleware);
app.use('/api/v1/storefront', storefront);
app.use((req, res) => res.status(404).json({ error: 'Rota nao encontrada' }));

const CASCA = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Aura.</title>'
  + '<meta name="robots" content="noindex, nofollow"></head><body><div id="root"></div>'
  + '<script src="/_expo/static/js/web/entry-abc.js" defer></script></body></html>';
let appNoAr = true;

beforeAll(() => {
  jest.useFakeTimers({
    now: new Date(AGORA),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
});
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => {
  naoRespondidas = [];
  pecaPersonalizavel = true;
  appNoAr = true;
  cache.esquecerPagina();
  shell.limparCache();
  db.query.mockReset();
  global.fetch = jest.fn(async (_url, opts = {}) => {
    if (!appNoAr) throw new Error('ECONNREFUSED');
    return opts.method === 'HEAD'
      ? { ok: true, status: 200, headers: { get: () => 'text/javascript' } }
      : { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => CASCA };
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  expect(naoRespondidas).toEqual([]);
});

// ── 1 e 2. A pagina da loja ───────────────────────────────────
describe('a pagina da loja', () => {
  test('sem personalizavel: a CSP de sempre, sem frame-src, e nada da ponte', async () => {
    const loja = cenarios.loja_simples();
    db.query.mockImplementation(bancoDa(loja, { temPersonalizavel: false }));
    const r = await request(app).get(`/api/v1/storefront/${loja.config.slug}/page`);
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).not.toContain('frame-src');
    expect(r.headers['content-security-policy']).toMatch(/form-action 'self'$/);
    expect(r.text).not.toMatch(/pzq-|aura:personalizador|abrirQuadro/);
  });

  test('com personalizavel: a ponte, o CSS do quadro e frame-src self, tambem no hit de 60 s', async () => {
    const loja = lojaComPersonalizavel();
    db.query.mockImplementation(bancoDa(loja, { temPersonalizavel: true }));
    const r = await request(app).get(`/api/v1/storefront/${loja.config.slug}/page`);
    expect(r.status).toBe(200);
    expect(r.headers['x-aura-cache']).toBe('miss');
    const csp = r.headers['content-security-policy'];
    expect(csp).toMatch(/; frame-src 'self'$/);
    expect(csp.split('; frame-src')[0]).toMatch(/form-action 'self'$/);
    expect(r.text).toContain("var FONTE_DO_QUADRO='aura:personalizador'");
    expect(r.text).toContain("window.addEventListener('aura:personalizar'");
    expect(r.text).toContain('if(i.personalizado) return htmlDoItemPersonalizado(i);');
    expect(r.text).toMatch(/<style>\.pz-selo\{[^<]*\.pzq-veu\{[^<]*<\/style>\n<\/head>/);

    const hit = await request(app).get(`/api/v1/storefront/${loja.config.slug}/page`);
    expect(hit.headers['x-aura-cache']).toBe('hit');
    expect(hit.headers['content-security-policy']).toBe(csp);
    expect(hit.text).toBe(r.text);
  });

  test('a pagina da peca (/p/<id>) tambem sai com frame-src', async () => {
    const loja = lojaComPersonalizavel();
    db.query.mockImplementation(bancoDa(loja, { temPersonalizavel: true }));
    const r = await request(app).get(`/api/v1/storefront/${loja.config.slug}/p/${CANECA}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("frame-src 'self'");
  });
});

// ── 3. A rota do quadro ───────────────────────────────────────
describe('o quadro do personalizador pelo host da loja', () => {
  const slug = () => cenarios.loja_simples().config.slug;
  beforeEach(() => { db.query.mockImplementation(bancoDa(lojaComPersonalizavel(), { temPersonalizavel: true })); });

  test('loja.getaura.com.br/<slug>/personalizar/<id>: a casca, so a loja enquadra, sem indice', async () => {
    const r = await request(app).get(`/${slug()}/personalizar/${CANECA}?origem=${encodeURIComponent(ORIGEM)}&cor=%237c3aed`)
      .set('Host', 'loja.getaura.com.br');
    expect(r.status).toBe(200);
    expect(r.text).toContain(`window.__AURA_VITRINE__={slug:"${slug()}"`);
    expect(r.text).toContain('https://app.getaura.com.br/_expo/static/js/web/entry-abc.js');
    expect(r.text).toContain('<meta name="robots" content="noindex">');
    expect(r.text).not.toContain('noindex, nofollow">'); // a do painel sai
    expect(r.text).toContain(`var w="/${slug()}/personalizar/${CANECA}"`);
    const csp = r.headers['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain('frame-ancestors *');
    expect(csp).toContain('https://app.getaura.com.br'); // o bundle
    expect(r.headers['x-frame-options']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  test('dominio proprio: /personalizar/<id> e o quadro recarregado (/<slug>/personalizar/<id>)', async () => {
    const a = await request(app).get(`/personalizar/${CANECA}`).set('Host', 'www.atelie.com.br');
    expect(a.status).toBe(200);
    expect(a.text).toContain(`window.__AURA_VITRINE__={slug:"${slug()}"`);
    const b = await request(app).get(`/${slug()}/personalizar/${CANECA}?_casca=1`).set('Host', 'www.atelie.com.br');
    expect(b.status).toBe(200);
    expect(b.text).toContain('window.__AURA_VITRINE__');
    // Slug repetido que nao e o da loja: nao e o quadro.
    const c = await request(app).get(`/outra-loja/personalizar/${CANECA}`).set('Host', 'www.atelie.com.br');
    expect(c.status).toBe(404);
    expect(c.text).not.toContain('__AURA_VITRINE__');
  });

  test('peca que nao e personalizavel, id torto ou loja que nao existe: a pagina de falha com a marca', async () => {
    pecaPersonalizavel = false;
    const a = await request(app).get(`/${slug()}/personalizar/${CANECA}`).set('Host', 'loja.getaura.com.br');
    expect(a.status).toBe(404);
    expect(a.text).toContain(shell.MARCA_QUADRO_INDISPONIVEL);
    expect(a.text).not.toContain('__AURA_VITRINE__');

    db.query.mockClear();
    const b = await request(app).get(`/${slug()}/personalizar/nao-e-uuid`).set('Host', 'loja.getaura.com.br');
    expect(b.status).toBe(404);
    expect(b.text).toContain(shell.MARCA_QUADRO_INDISPONIVEL);
    expect(db.query).not.toHaveBeenCalled();

    const c = await request(app).get(`/loja-que-nao-existe/personalizar/${CANECA}`).set('Host', 'loja.getaura.com.br');
    expect(c.status).toBe(404);
    expect(c.text).toContain(shell.MARCA_QUADRO_INDISPONIVEL);
  });

  test('app fora do ar: 503 com a marca (a loja oferece o WhatsApp)', async () => {
    appNoAr = false;
    const r = await request(app).get(`/${slug()}/personalizar/${CANECA}`).set('Host', 'loja.getaura.com.br');
    expect(r.status).toBe(503);
    expect(r.text).toContain(shell.MARCA_QUADRO_INDISPONIVEL);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'self'");
  });

  test('o script do caminho deixa a barra do quadro como o app conhece', () => {
    const js = shell.scriptDoCaminhoDoQuadro('atelie', CANECA).replace(/^<script>|<\/script>$/g, '');
    const trocas = [];
    const rodar = (pathname) => new Function('location', 'history', js)(
      { pathname, search: '?origem=x', hash: '' }, { state: null, replaceState: (_s, _t, u) => trocas.push(u) });
    rodar(`/atelie/personalizar/${CANECA}`);
    expect(trocas).toEqual([]);
    rodar(`/personalizar/${CANECA}`);
    expect(trocas).toEqual([`/atelie/personalizar/${CANECA}?origem=x`]);
  });
});

// ── 4. A ponte rodando de verdade ─────────────────────────────
// Um DOM de mentira com so o que a ponte usa.
function elemento(tag) {
  const filhos = {};
  const el = {
    tagName: String(tag).toUpperCase(), className: '', innerHTML: '', hidden: false, textContent: '', attrs: {},
    style: {}, parentNode: null, ouvintes: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
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
  return el;
}

// Toda ponte montada fecha o quadro no fim (o relogio de 25 s nao fica vivo).
const pontes = [];
afterEach(() => { pontes.splice(0).forEach((api) => api.fecharQuadro(true)); });

function montarPonte({ pathname = '/atelie', origin = ORIGEM, whatsapp = '11999990000' } = {}) {
  const ouvintesJanela = {};
  const ouvintesDoc = {};
  const body = { style: { overflow: '' }, filhos: [], appendChild(e) { e.parentNode = body; this.filhos.push(e); }, removeChild(e) { e.parentNode = null; this.filhos = this.filhos.filter((x) => x !== e); } };
  const badge = elemento('span');
  const document = {
    body, activeElement: null,
    createElement: elemento,
    getElementById: (id) => (id === 'cartBadge' ? badge : null),
    addEventListener: (t, f) => { (ouvintesDoc[t] = ouvintesDoc[t] || []).push(f); },
  };
  const window = { addEventListener: (t, f) => { (ouvintesJanela[t] = ouvintesJanela[t] || []).push(f); } };
  const location = { pathname, origin };
  const cart = {};
  const chamadas = { openCart: 0, closeCart: 0, toast: [], updateCartUI: 0 };
  const PROD_MAP = { [CANECA]: { id: CANECA, name: 'Caneca personalizada', price: 38, image_url: 'https://r2.exemplo/caneca.jpg' } };
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
  const api = new Function(
    'window', 'document', 'location', 'SLUG', 'SITE', 'PROD_MAP', 'cart', 'CONTACT', 'esc', 'fmt', 'INICIAIS',
    'updateCartUI', 'renderProducts', 'openCart', 'closeCart', 'changeQty', 'showToast', 'numeroDoWhatsapp',
    `${quadro.PONTE}\nreturn { abrirQuadro, fecharQuadro, caminhoDoQuadro, enderecoDoQuadro, lerMensagemDoQuadro,
      itemPersonalizadoDaSacola, htmlDoItemPersonalizado, avisoDoPersonalizado, quadroAberto: function(){ return QUADRO; } };`,
  )(
    window, document, location, 'atelie', { primary_color: '#2a221b', dark_mode: false, font_family: 'classic' },
    PROD_MAP, cart, { whatsapp }, esc, fmt, (n) => String(n).slice(0, 2),
    () => { chamadas.updateCartUI++; }, () => {}, () => { chamadas.openCart++; }, () => { chamadas.closeCart++; },
    (k, d) => { cart[k].qty += d; if (cart[k].qty <= 0) delete cart[k]; },
    (t) => chamadas.toast.push(t), (n) => (n ? '55' + String(n).replace(/\D/g, '') : ''),
  );
  pontes.push(api);
  const emitir = (tipo, ev) => (ouvintesJanela[tipo] || []).forEach((f) => f(ev));
  const clicar = (alvo) => (ouvintesDoc.click || []).forEach((f) => f({ target: { closest: () => alvo } }));
  return { api, cart, chamadas, body, emitir, clicar, PROD_MAP };
}

/** A mensagem como o navegador entrega. */
const msg = (q, data, extra) => Object.assign({ origin: ORIGEM, source: q.iframe.contentWindow, data }, extra || {});
const doQuadro = (tipo, dados) => Object.assign({ fonte: 'aura:personalizador', versao: 1, tipo }, dados || {});
const CONFIRMOU = (extra) => doQuadro('confirmou', Object.assign({
  produto_id: CANECA, nome: 'Caneca personalizada', quantidade: 2,
  customization: { nome: 'Ana', cor: 'branca', has_back_selected: false },
  resumo: ['Nome: Ana', 'Cor: Branca'],
  preco: { unitario: 38, total: 76, fonte: 'servidor' },
  miniatura: 'data:image/jpeg;base64,AAAA', editando: false,
}, extra || {}));

describe('a ponte', () => {
  test('o caminho do quadro segue o host por onde a loja abriu', () => {
    expect(montarPonte({ pathname: '/atelie' }).api.caminhoDoQuadro(CANECA)).toBe(`/atelie/personalizar/${CANECA}`);
    expect(montarPonte({ pathname: `/atelie/p/${CANECA}` }).api.caminhoDoQuadro(CANECA)).toBe(`/atelie/personalizar/${CANECA}`);
    expect(montarPonte({ pathname: '/api/v1/storefront/atelie/page' }).api.caminhoDoQuadro(CANECA))
      .toBe(`/api/v1/storefront/atelie/personalizar/${CANECA}`);
    expect(montarPonte({ pathname: '/' }).api.caminhoDoQuadro(CANECA)).toBe(`/personalizar/${CANECA}`);
    const url = montarPonte().api.enderecoDoQuadro(CANECA);
    expect(url).toBe(`/atelie/personalizar/${CANECA}?origem=${encodeURIComponent(ORIGEM)}&cor=%232a221b&modo=claro&fonte=classic`);
  });

  test('"Personalizar" (evento do p-180): a ponte atende e abre o quadro', () => {
    const { api, emitir, body } = montarPonte();
    const ev = { detail: { produto_id: CANECA, origem: 'detalhe', modo: '' }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    emitir('aura:personalizar', ev);
    expect(ev.defaultPrevented).toBe(true);
    const q = api.quadroAberto();
    expect(q.iframe.src).toBe(api.enderecoDoQuadro(CANECA));
    expect(body.filhos).toHaveLength(1);
    expect(body.style.overflow).toBe('hidden');
    // Id torto nao abre e deixa o WhatsApp do p-180 atender.
    const torto = { detail: { produto_id: '"><img>' }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    emitir('aura:personalizar', torto);
    expect(torto.defaultPrevented).toBe(false);
  });

  test('origem estranha, janela estranha e envelope errado: ignorados', () => {
    const { api, emitir, cart } = montarPonte();
    api.abrirQuadro(CANECA, null);
    const q = api.quadroAberto();
    emitir('message', msg(q, CONFIRMOU(), { origin: 'https://golpe.exemplo' }));
    emitir('message', msg(q, CONFIRMOU(), { source: {} }));
    emitir('message', msg(q, Object.assign(CONFIRMOU(), { fonte: 'outro' })));
    emitir('message', msg(q, Object.assign(CONFIRMOU(), { versao: 2 })));
    emitir('message', msg(q, 'texto solto'));
    emitir('message', msg(q, doQuadro('apagar_tudo')));
    expect(Object.keys(cart)).toHaveLength(0);
    expect(api.quadroAberto()).toBe(q);
    expect(api.lerMensagemDoQuadro(msg(q, CONFIRMOU(), { origin: 'http://loja.getaura.com.br' }), q.iframe.contentWindow)).toBeNull();
  });

  test('pronto mostra o quadro; confirmou guarda na sacola com miniatura e resumo e abre a sacola', () => {
    const { api, emitir, cart, chamadas, body } = montarPonte();
    api.abrirQuadro(CANECA, null);
    const q = api.quadroAberto();
    emitir('message', msg(q, doQuadro('pronto', { produto_id: CANECA, nome: 'Caneca personalizada' })));
    expect(q.veu.classList.contains('pzq-pronto')).toBe(true);
    expect(q.iframe.contentWindow.postMessage).not.toHaveBeenCalled(); // nao e edicao

    emitir('message', msg(q, CONFIRMOU()));
    const itens = Object.values(cart);
    expect(itens).toHaveLength(1);
    expect(itens[0]).toMatchObject({
      product_id: CANECA, variant_id: null, name: 'Caneca personalizada', price: 38, qty: 2,
      personalizado: true, customization: { nome: 'Ana', cor: 'branca', has_back_selected: false },
      resumo: ['Nome: Ana', 'Cor: Branca'], image_url: 'data:image/jpeg;base64,AAAA', preco_fonte: 'servidor',
    });
    expect(itens[0].key).toMatch(new RegExp(`^pz-${CANECA}-`));
    expect(api.quadroAberto()).toBeNull();
    expect(body.filhos).toHaveLength(0);
    expect(chamadas.openCart).toBe(1);
    expect(chamadas.updateCartUI).toBe(1);

    // Duas confirmacoes da mesma peca = duas linhas (cada uma com a sua arte).
    api.abrirQuadro(CANECA, null);
    const q2 = api.quadroAberto();
    emitir('message', msg(q2, CONFIRMOU({ customization: { nome: 'Bia' } })));
    expect(Object.keys(cart)).toHaveLength(2);
  });

  test('confirmou com dados ruins nao entra; miniatura estranha cai na foto da peca', () => {
    const { api, emitir, cart, chamadas } = montarPonte();
    api.abrirQuadro(CANECA, null);
    let q = api.quadroAberto();
    emitir('message', msg(q, CONFIRMOU({ customization: null })));
    emitir('message', msg(q, CONFIRMOU({ quantidade: 0 })));
    emitir('message', msg(q, CONFIRMOU({ preco: { unitario: 'x' } })));
    emitir('message', msg(q, CONFIRMOU({ produto_id: '0b1a9999-0000-4000-8000-000000000002' })));
    expect(Object.keys(cart)).toHaveLength(0);
    expect(chamadas.toast).toHaveLength(4);
    emitir('message', msg(q, CONFIRMOU({ miniatura: 'javascript:alert(1)' })));
    expect(Object.values(cart)[0].image_url).toBe('https://r2.exemplo/caneca.jpg');
    api.abrirQuadro(CANECA, null);
    q = api.quadroAberto();
    emitir('message', msg(q, CONFIRMOU({ miniatura: 'https://x/a.jpg" onerror="alert(1)' })));
    expect(Object.values(cart)[1].image_url).toBe('https://r2.exemplo/caneca.jpg');
  });

  test('Editar: reabre, manda o editar para a origem da loja e troca o item no lugar', () => {
    const { api, emitir, cart, clicar, chamadas } = montarPonte();
    api.abrirQuadro(CANECA, null);
    emitir('message', msg(api.quadroAberto(), CONFIRMOU()));
    const chave = Object.keys(cart)[0];

    clicar({ hasAttribute: (k) => k === 'data-pzq-editar', getAttribute: (k) => (k === 'data-pzq-editar' ? chave : null) });
    expect(chamadas.closeCart).toBe(1);
    const q = api.quadroAberto();
    expect(q.chave).toBe(chave);
    emitir('message', msg(q, doQuadro('pronto', { produto_id: CANECA })));
    expect(q.iframe.contentWindow.postMessage).toHaveBeenCalledWith(
      { fonte: 'aura:loja', versao: 1, tipo: 'editar', customization: { nome: 'Ana', cor: 'branca', has_back_selected: false }, quantidade: 2 },
      ORIGEM,
    );
    emitir('message', msg(q, CONFIRMOU({ editando: true, quantidade: 3, customization: { nome: 'Ana Clara' }, resumo: ['Nome: Ana Clara'] })));
    expect(Object.keys(cart)).toEqual([chave]);
    expect(cart[chave]).toMatchObject({ qty: 3, customization: { nome: 'Ana Clara' }, resumo: ['Nome: Ana Clara'] });

    // Remover tira a linha inteira.
    clicar({ hasAttribute: (k) => k === 'data-pzq-remover', getAttribute: (k) => (k === 'data-pzq-remover' ? chave : null) });
    expect(cart).toEqual({});
  });

  test('cancelou fecha; erro oferece o WhatsApp da loja', () => {
    const { api, emitir } = montarPonte();
    api.abrirQuadro(CANECA, null);
    emitir('message', msg(api.quadroAberto(), doQuadro('cancelou', { produto_id: CANECA })));
    expect(api.quadroAberto()).toBeNull();

    api.abrirQuadro(CANECA, null);
    const q = api.quadroAberto();
    emitir('message', msg(q, doQuadro('erro', { motivo: 'produto_indisponivel' })));
    const saida = q.veu.querySelector('.pzq-saida');
    expect(saida.hidden).toBe(false);
    expect(saida.innerHTML).toContain('href="https://wa.me/5511999990000?text=');
    expect(saida.innerHTML).toContain('Voltar para a loja');
    expect(q.veu.querySelector('.pzq-espera-tx').textContent).toBe('Não deu para abrir o personalizador agora.');
  });

  test('a pagina de falha do quadro (mesma origem) mostra a saida na hora', () => {
    const { api } = montarPonte();
    api.abrirQuadro(CANECA, null);
    const q = api.quadroAberto();
    q.iframe.contentDocument = { querySelector: () => ({ getAttribute: () => 'indisponivel' }) };
    q.iframe.ouvintes.load.forEach((f) => f());
    expect(q.veu.querySelector('.pzq-saida').hidden).toBe(false);
  });
});

// ── 5. A sacola ───────────────────────────────────────────────
describe('a sacola com o personalizado', () => {
  test('cada troca acha o trecho uma vez, e o resto do arquivo nao muda', () => {
    expect(() => quadro.aplicarNaSacola(sacolaSrc)).not.toThrow();
    expect(() => quadro.aplicarNoCarrinho(cartSrc)).not.toThrow();
    const s = quadro.aplicarNaSacola(sacolaSrc);
    expect(s).toContain('if(i.personalizado&&!itemPersonalizadoDaSacola(cart[i.key],i)) delete cart[i.key];');
    expect(s.length - sacolaSrc.length).toBeLessThan(200);
  });

  test('a linha da sacola: miniatura, "Personalizada", resumo, Editar e Remover, e o aviso da arte', () => {
    const ctx = montarPonte();
    // O cart.js de verdade com a troca, rodando junto da ponte.
    const src = quadro.aplicarNoCarrinho(cartSrc) + quadro.PONTE;
    const els = {};
    const doc = {
      getElementById: (id) => (els[id] = els[id] || { textContent: '', innerHTML: '', style: {}, classList: { toggle() {}, add() {}, remove() {} }, hidden: false }),
      addEventListener() {}, createElement: () => ({}),
    };
    const cart = {
      'p1': { key: 'p1', product_id: 'p1', variant_id: null, name: 'Bolsa', price: 219.9, image_url: null, qty: 1 },
      [`pz-${CANECA}-a`]: { key: `pz-${CANECA}-a`, product_id: CANECA, variant_id: null, name: 'Caneca <b>', price: 38, qty: 2,
        image_url: 'data:image/jpeg;base64,AAAA', personalizado: true, customization: { nome: 'Ana' }, resumo: ['Nome: Ana', 'Cor: <i>'] },
    };
    const updateCartUI = new Function('window', 'document', 'location', 'cart', 'esc', 'fmt', 'INICIAIS', 'SETTINGS', 'selectedDelivery', 'SLUG', 'SITE', 'PROD_MAP',
      `${src}\nreturn updateCartUI;`)(
      { addEventListener() {} }, doc, { pathname: '/atelie', origin: ORIGEM }, cart,
      (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ','), (n) => String(n).slice(0, 2),
      { delivery_fee: 0 }, 'pickup', 'atelie', {}, ctx.PROD_MAP);
    updateCartUI();
    const h = els.cartItems.innerHTML;
    expect(h).toContain('Bolsa'); // a peca de prateleira continua igual
    expect(h).toContain('<div class="cart-item pzq-item"><div class="cart-item-img"><img src="data:image/jpeg;base64,AAAA" alt=""></div>');
    expect(h).toContain('Caneca &lt;b&gt; <span class="pzq-pill">Personalizada</span>');
    expect(h).toContain('<div class="pzq-resumo">Nome: Ana · Cor: &lt;i&gt;<br>2 unidades</div>');
    expect(h).toContain(`data-pzq-editar="pz-${CANECA}-a">Editar</button>`);
    expect(h).toContain(`data-pzq-remover="pz-${CANECA}-a">Remover</button>`);
    expect(h).toContain('R$ 76,00');
    expect(h.trim().endsWith('e só então produz.</p>')).toBe(true);
    expect(els.cartSubtotal.textContent).toBe('R$ 295,90');
  });

  test('a sacola guardada volta com o que a cliente escolheu; item adulterado sai', () => {
    const { api } = montarPonte();
    const item = { key: `pz-${CANECA}-a`, product_id: CANECA, name: 'Caneca personalizada', price: 38, qty: 2, image_url: null };
    const ok = api.itemPersonalizadoDaSacola(item, {
      key: `pz-${CANECA}-a`, product_id: CANECA, name: 'Caneca personalizada', personalizado: true,
      customization: { nome: 'Ana' }, resumo: ['Nome: Ana', 7], image_url: 'data:image/jpeg;base64,AAAA', preco_fonte: 'servidor',
    });
    expect(ok).toBe(true);
    expect(item).toMatchObject({ personalizado: true, customization: { nome: 'Ana' }, resumo: ['Nome: Ana'], image_url: 'data:image/jpeg;base64,AAAA' });
    expect(api.itemPersonalizadoDaSacola({}, { key: 'x', product_id: CANECA, customization: { a: 1 } })).toBe(false);
    expect(api.itemPersonalizadoDaSacola({}, { key: `pz-${CANECA}-a`, product_id: CANECA, customization: [1] })).toBe(false);
  });

  test('a conferencia do preco de agora (p-124) manda so as pecas de prateleira', async () => {
    const src = quadro.aplicarNaSacola(sacolaSrc);
    const corpos = [];
    const cart = {
      p1: { key: 'p1', product_id: '0b1a1111-0000-4000-8000-000000000001', variant_id: null, name: 'Bolsa', price: 219.9, qty: 1 },
      pz: { key: 'pz', product_id: CANECA, variant_id: null, name: 'Caneca', price: 38, qty: 2, personalizado: true, customization: {} },
    };
    const conferir = new Function('cart', 'fetch', 'API_BASE', 'SLUG', 'cartKey', 'updateCartUI', 'fmt', 'esc', '__S',
      `${src}\nreturn conferirPrecosDaSacola;`)(
      cart,
      async (_u, o) => { corpos.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ itens: [{ indice: 0, product_id: cart.p1.product_id, preco: 219.9 }] }) }; },
      '', 'atelie', (p, v) => p + (v ? ':' + v : ''), () => {}, (v) => String(v), (s) => s, {});
    await conferir();
    expect(corpos).toEqual([{ items: [{ product_id: cart.p1.product_id, variant_id: null, quantity: 1 }] }]);
    expect(cart.pz.price).toBe(38);
  });
});

// ── 6. O dominio proprio no payload do /studio/products ───────
describe('site.dominio_proprio', () => {
  const base = { site_name: 'Ateliê', banners: null };
  test('so com o dominio ativo', () => {
    expect(studioStorefront.__montarSite({ ...base, custom_domain: 'WWW.Atelie.com.br', custom_domain_status: 'active' }, 'X').dominio_proprio)
      .toBe('www.atelie.com.br');
    expect('dominio_proprio' in studioStorefront.__montarSite({ ...base, custom_domain: 'www.atelie.com.br', custom_domain_status: 'pending' }, 'X')).toBe(false);
    expect('dominio_proprio' in studioStorefront.__montarSite({ ...base }, 'X')).toBe(false);
  });
});
