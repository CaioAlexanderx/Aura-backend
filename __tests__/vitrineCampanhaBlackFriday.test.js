// ============================================================
// A faixa de Black Friday na loja online (p-119b, 14/11/2026)
//
// So entra com payload.campanha no ar (p-118). O que mais importa e o que
// NAO muda: loja sem campanha sai byte a byte igual — as fixtures da
// vitrine (pagarNaEntrega, textosDaFrente) seguem sem regenerar. Aqui: as
// trocas acham o trecho, a faixa fina, a grande e "Ofertas" aparecem, o
// script continua valido e a rota do catalogo filtra as promocoes.
// ============================================================
'use strict';

const crypto = require('crypto');
const campanha = require('../src/templates/storefront/parts/campanha');
const home = require('../src/templates/storefront/parts/home');
const products = require('../src/templates/storefront/parts/products');
const productDetail = require('../src/templates/storefront/parts/product_detail');
const buildPage = require('../src/templates/storefrontPage');
const dadosEntrega = require('./fixtures/vitrineSemPagarNaEntregaNova/dados');
const hashes = require('./fixtures/vitrineSemPagarNaEntregaNova/hashes.json');
const db = require('../src/config/database');
const { paginaDoCatalogo, EM_PROMOCAO_NO_AR } = require('../src/services/catalogoPaginado');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const CAMPANHA = { ativa: true, titulo: 'Black Friday da Loja <Exemplo>', ate_pct: 40, ate_data: '2026-11-30' };
const scriptDa = (html) => {
  const ini = html.indexOf('<script>\nvar __S');
  return html.slice(ini + '<script>'.length, html.indexOf('</script>', ini));
};

describe('loja sem campanha: nada muda', () => {
  test.each(Object.keys(hashes))('fixture %s segue byte a byte', (nome) => {
    const html = buildPage(dadosEntrega[nome](), 'loja-exemplo');
    expect({ bytes: Buffer.byteLength(html), sha256: sha(html) }).toEqual(hashes[nome]);
  });

  test.each([
    ['campanha ausente', undefined],
    ['campanha desligada', { ...CAMPANHA, ativa: false }],
    ['sem desconto de verdade', { ...CAMPANHA, ate_pct: 0 }],
  ])('%s: mesma pagina de antes', (_n, c) => {
    const d = dadosEntrega.so_pix();
    expect(buildPage({ ...d, campanha: c }, 'loja-exemplo')).toBe(buildPage(d, 'loja-exemplo'));
  });
});

describe('campanha no ar', () => {
  const html = buildPage({ ...dadosEntrega.so_pix(), campanha: CAMPANHA }, 'loja-exemplo');

  test('faixa fina no topo do corpo, antes da barra de anuncio e do cabecalho', () => {
    const corpo = html.slice(html.indexOf('<body'));
    const faixa = corpo.indexOf('<div class="bf-faixa" role="note">');
    expect(faixa).toBeGreaterThan(0);
    expect(faixa).toBeLessThan(corpo.indexOf('<header class="topbar"'));
    expect(corpo).toContain('<span>Black Friday da Loja &lt;Exemplo&gt;</span><span class="bf-sep" aria-hidden="true">·</span><span>até 40% OFF</span><span class="bf-sep" aria-hidden="true">·</span><span>até 30/11</span>');
  });

  test('faixa grande na home, depois do cabecalho e antes do banner da loja, com "Ver ofertas"', () => {
    const grande = html.indexOf('<section class="bf-hero"');
    expect(grande).toBeGreaterThan(html.indexOf('<aside class="drawer" id="drawerMenu"'));
    expect(grande).toBeLessThan(html.indexOf('id="bannerStage"'));
    expect(html).toContain('<h2 class="bf-hero-h">Até <em>40% OFF</em></h2>');
    expect(html).toContain('Preços já com desconto até 30/11.');
    expect(html).toContain(`onclick="verTudo('ofertas')">Ver ofertas`);
    expect(html).toContain('body:not(.home) .bf-hero{display:none}');
  });

  test('dourado sobre preto, igual em capa clara e escura', () => {
    const escura = buildPage({ ...dadosEntrega.so_pix(), site: { ...dadosEntrega.so_pix().site, dark_mode: true }, campanha: CAMPANHA }, 'x');
    for (const h of [html, escura]) {
      expect(h).toContain('.bf-faixa{background:#0a0a0a;color:#f5c542;');
      expect(h).toContain('.bf-hero-cta{margin-left:auto;flex:none;background:#f5c542;color:#0a0a0a;');
    }
  });

  test('"Ofertas" no menu, na gaveta e no rodape; vista propria; a grade pede promo=1', () => {
    const js = scriptDa(html);
    expect(js).toContain("ofertas:'Ofertas' };");
    expect(js).toContain('itens+=ofertasNoMenu();');
    expect(js).toContain("+ofertasNaGaveta()+");
    expect(js).toContain('li+=ofertasNoRodape();');
    expect(js).toContain("q.push('promo=1');");
    expect(js).toContain('FAIXA_DA_CAMPANHA+\'<div class="pd-topo">');
    // O texto da faixa vai com "<" escapado: nada de </div> cru no <script>.
    expect(js).toContain('var FAIXA_DA_CAMPANHA="\\u003cdiv class=\\"bf-faixa\\"');
    expect(() => new Function(js)).not.toThrow();
  });

  test('cada troca acha o seu trecho as vezes esperadas; trecho sumido quebra', () => {
    const conta = (s, x) => s.split(x).length - 1;
    for (const [de, , n] of campanha.TROCAS_DA_HOME) expect(conta(home, de)).toBe(n);
    for (const [de, , n] of campanha.TROCAS_DOS_PRODUTOS) expect(conta(products, de)).toBe(n);
    for (const [de, , n] of campanha.TROCAS_DO_DETALHE) expect(conta(productDetail, de)).toBe(n);
    expect(() => campanha.aplicarNaHome(home.replace('  nav.innerHTML=itens;\n', ''), { titulo: 'x', ate_pct: 1, ate: '' })).toThrow(/campanha/);
    expect(() => campanha.aplicarNoCorpo('<body></body>', { titulo: 'x', ate_pct: 1, ate: '' })).toThrow(/campanha/);
  });
});

describe('regras', () => {
  test('so desenha com ativa e desconto entre 1 e 99; data DD/MM', () => {
    expect(campanha.campanhaNoAr({ campanha: CAMPANHA })).toEqual({ titulo: 'Black Friday da Loja <Exemplo>', ate_pct: 40, ate: '30/11' });
    expect(campanha.campanhaNoAr({ campanha: { ...CAMPANHA, ate_data: null } }).ate).toBe('');
    expect(campanha.campanhaNoAr({ campanha: { ...CAMPANHA, ate_pct: 100 } })).toBe(null);
    expect(campanha.campanhaNoAr({})).toBe(null);
    expect(campanha.campanhaNoAr(null)).toBe(null);
  });

  test('sem data, a faixa nao diz "ate"', () => {
    expect(campanha.htmlDaFaixaFina({ titulo: 'Black Friday', ate_pct: 30, ate: '' })).not.toMatch(/até \d\d\//);
  });
});

describe('catalogo: "Ofertas" filtra as promocoes no ar', () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(String(sql)) ? { rows: [{ n: 0 }] } : { rows: [] }));
  });

  test('com soPromocao, o filtro entra na contagem e na pagina', async () => {
    await paginaDoCatalogo({ cid: 'c1', visibilityWhere: '(company_id = $1)', soPromocao: true });
    const sqls = db.query.mock.calls.map(([s]) => String(s));
    expect(sqls.filter((s) => s.includes(EM_PROMOCAO_NO_AR))).toHaveLength(2);
  });

  test('sem a opcao, o SQL e o de antes', async () => {
    await paginaDoCatalogo({ cid: 'c1', visibilityWhere: '(company_id = $1)' });
    expect(db.query.mock.calls.some(([s]) => String(s).includes('promo_price > 0 AND products.promo_price'))).toBe(false);
  });

  test('a regra e a do preco efetivo: abaixo do base, entre comeco e fim; variante com saldo', () => {
    expect(EM_PROMOCAO_NO_AR).toContain('products.promo_price < products.price');
    expect(EM_PROMOCAO_NO_AR).toContain('products.promo_starts_at <= NOW() AND products.promo_ends_at > NOW()');
    expect(EM_PROMOCAO_NO_AR).toContain('pv.promo_price < COALESCE(pv.price_override, products.price)');
    expect(EM_PROMOCAO_NO_AR).toContain('pv.stock_qty > 0');
  });
});
