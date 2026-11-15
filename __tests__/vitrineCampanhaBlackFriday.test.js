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
const { paginaDoCatalogo, facetasDoCatalogo, faixaDePreco, EM_PROMOCAO_NO_AR, PRECO_NA_VITRINE } = require('../src/services/catalogoPaginado');

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
    expect(corpo).toContain('<span>Black Friday da Loja &lt;Exemplo&gt;</span><span class="bf-sep" aria-hidden="true">·</span><wbr><span>até 40% OFF</span><span class="bf-sep" aria-hidden="true">·</span><wbr><span>até 30/11</span>');
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

// p-123a (QA 14/11): os filtros da vista Ofertas sao das pecas da vista.
describe('Ofertas: filtros e faixas so das pecas em promocao', () => {
  const express = require('express');
  const request = require('supertest');
  let sqls;
  beforeEach(() => {
    sqls = [];
    db.query.mockReset();
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      sqls.push(s);
      if (/FROM digital_channel_config WHERE slug/.test(s)) return { rows: [{ company_id: 'c1', slug: 'loja', is_published: true }] };
      if (/COUNT\(\*\)::int AS n FROM products/.test(s)) return { rows: [{ n: 0 }] };
      if (/AS atributo/.test(s)) return { rows: [{ atributo: 'Tamanho', valor: 'M', total: 2 }] };
      if (/AS min/.test(s)) return { rows: [{ min: 59.9, max: 111.9 }] };
      return { rows: [] };
    });
  });
  const catalogo = (q) => {
    const app = express();
    app.use('/storefront', require('../src/routes/storefront'));
    return request(app).get('/storefront/loja/catalogo' + q);
  };
  const facetaSql = () => sqls.find((s) => /AS atributo/.test(s));
  const faixaSql = () => sqls.find((s) => /AS min/.test(s));

  test('promo=1: facetas e faixa so com a promocao no ar, faixa pelo preco do cartao', async () => {
    const res = await catalogo('?promo=1');
    expect(res.status).toBe(200);
    expect(facetaSql()).toContain(EM_PROMOCAO_NO_AR);
    expect(faixaSql()).toContain(EM_PROMOCAO_NO_AR);
    expect(faixaSql()).toContain('MIN(' + PRECO_NA_VITRINE + ')');
    expect(res.body.facetas.preco).toEqual({ min: 59.9, max: 111.9 });
  });

  test('sem promo (grade, categoria, Novidades): o SQL de antes', async () => {
    for (const q of ['', '?ordem=novidades', '?cat=%2Fvestidos']) {
      sqls = [];
      const res = await catalogo(q);
      expect(res.status).toBe(200);
      expect(facetaSql()).not.toContain('promo_price');
      expect(faixaSql()).not.toContain('promo_price');
      expect(faixaSql()).toContain('SELECT MIN(price)::float AS min, MAX(price)::float AS max');
    }
  });

  test('promo=1 com faixa escolhida: filtra pelo preco do cartao; fora da vista, pelo preco normal', async () => {
    await paginaDoCatalogo({ cid: 'c1', visibilityWhere: '(company_id = $1)', soPromocao: true, precoMin: 50, precoMax: 100 });
    expect(sqls.find((s) => /COUNT\(\*\)::int AS n FROM products/.test(s))).toContain(PRECO_NA_VITRINE + ' >= $2');
    sqls = [];
    await paginaDoCatalogo({ cid: 'c1', visibilityWhere: '(company_id = $1)', precoMin: 50, precoMax: 100 });
    const contagem = sqls.find((s) => /COUNT\(\*\)::int AS n FROM products/.test(s));
    expect(contagem).toContain('price >= $2');
    expect(contagem).not.toContain('promo_price');
  });

  test('funcoes: sem a opcao, nada de promocao no SQL', async () => {
    await facetasDoCatalogo({ cid: 'c1', visibilityWhere: 'TRUE' });
    await faixaDePreco({ cid: 'c1', visibilityWhere: 'TRUE' });
    expect(sqls.some((s) => /promo_price/.test(s))).toBe(false);
  });
});

// p-122 (14/11/2026): o texto escrito pela loja. Sem ele, a pagina com a
// campanha sai byte a byte igual a de antes (hashes gerados com origin/main
// antes deste card, com CAMPANHA acima).
describe('texto da faixa escrito pela loja (p-122)', () => {
  const ANTES = {
    so_pix: { bytes: 311930, sha256: 'e51a0b53913219855e1dc8f68500acec5e484b58047daabd26d2cf2cde742e5d' },
    na_entrega_legado: { bytes: 312044, sha256: '36ca8bf0b51153f7593760e87f8a52a374296ce24879c49795ac33e324e12521' },
  };

  test.each(Object.keys(ANTES))('campanha sem texto escrito (%s): HTML byte a byte igual ao de antes', (nome) => {
    const html = buildPage({ ...dadosEntrega[nome](), campanha: CAMPANHA }, 'loja-exemplo');
    expect({ bytes: Buffer.byteLength(html), sha256: sha(html) }).toEqual(ANTES[nome]);
    // frase vazia ou so espacos = o texto padrao
    expect(buildPage({ ...dadosEntrega[nome](), campanha: { ...CAMPANHA, frase: '   ' } }, 'loja-exemplo')).toBe(html);
  });

  test('titulo de 28 W: na faixa fina, na faixa grande e na pagina do produto, escapado', () => {
    const W28 = 'W'.repeat(28);
    const html = buildPage({ ...dadosEntrega.so_pix(), campanha: { ...CAMPANHA, titulo: W28 } }, 'loja-exemplo');
    expect(html).toContain('<div class="bf-faixa" role="note"><span>' + W28 + '</span>');
    expect(html).toContain('<div class="bf-hero-k">' + W28 + '</div>');
    // Palavra sem espaco desse tamanho quebra no meio em vez de passar da tela.
    expect(html).toContain('.bf-faixa>span:first-child{white-space:normal;overflow-wrap:anywhere}');
    expect(html).toContain('.bf-hero-k{overflow-wrap:anywhere}');
    // Titulo com espacos (os prontos, ou o escrito com palavras normais): sem a regra.
    const normal = buildPage({ ...dadosEntrega.so_pix(), campanha: { ...CAMPANHA, titulo: 'Semana da Moda Aurora Fashion' } }, 'loja-exemplo');
    expect(normal).not.toContain('overflow-wrap:anywhere');
    expect(html).toContain('var FAIXA_DA_CAMPANHA="\\u003cdiv class=\\"bf-faixa\\" role=\\"note\\">\\u003cspan>' + W28);
  });

  test('frase da faixa grande: escapada, no lugar do texto padrao', () => {
    const frase = 'Leve <b>2</b> & pague "menos" — só na \'Aurora\' até domingo, enquanto durar o estoque!';
    const html = buildPage({ ...dadosEntrega.so_pix(), campanha: { ...CAMPANHA, frase } }, 'loja-exemplo');
    expect(html).toContain('<p class="bf-hero-p">Leve &lt;b&gt;2&lt;/b&gt; &amp; pague &quot;menos&quot; — só na &#39;Aurora&#39; até domingo, enquanto durar o estoque!</p>');
    expect(html).not.toContain('Os melhores achados');
    expect(html).not.toContain('<b>2</b>');
  });
});
