// ============================================================
// O "De" riscado na loja online (p-119a, 14/11/2026)
//
// So entra na loja com promocao no ar (o De/Por do Estoque). O que mais
// importa e o que NAO muda: loja sem promocao sai byte a byte igual — as
// fixtures da vitrine (pagarNaEntrega, textosDaFrente) seguem sem
// regenerar. Aqui: as trocas acham o trecho uma vez so, a loja com
// promocao ganha o riscado, e as funcoes novas desenham o que o mockup
// aprovado mostra.
// ============================================================
'use strict';

const crypto = require('crypto');
const promocao = require('../src/templates/storefront/parts/promocao');
const card = require('../src/templates/storefront/parts/card');
const productDetail = require('../src/templates/storefront/parts/product_detail');
const buildScript = require('../src/templates/storefront');
const buildPage = require('../src/templates/storefrontPage');
const dadosEntrega = require('./fixtures/vitrineSemPagarNaEntregaNova/dados');
const hashes = require('./fixtures/vitrineSemPagarNaEntregaNova/hashes.json');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fmt = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');

/** As funcoes do cartao com promocao, num ambiente minimo de navegador. */
function cliente(settings) {
  const doc = {
    _ids: {}, head: { appendChild(el) { doc._ids[el.id] = el; } },
    getElementById(id) { return doc._ids[id] || null; },
    createElement() { return {}; },
  };
  const fonte = promocao.aplicarNoCartao(card);
  const fn = new Function('document', 'SETTINGS', '__S', 'fmt', 'esc', 'PARCELAS_TXT', 'INICIAIS', 'FUNDO_CAPA', 'getProductCartQty',
    fonte + '\nreturn { cardHtml, pctDaPromocao, dataDaPromocao, promoDaEscolha, deDoDetalhe, offDoDetalhe, ateDoDetalhe };');
  return fn(doc, settings || { show_prices: true }, { pix_discount_pct: 10 }, fmt, (s) => String(s),
    () => '', () => 'VM', () => '#777', () => 0);
}

const emPromo = {
  id: 'p1', name: 'Vestido Midi Floral', price: 97.9, preco_de: 139.9, em_promocao: true,
  promo_ends_at: '2026-12-01T02:59:59.000Z', is_new: true, variants: [],
};
const semPromo = { id: 'p2', name: 'Bolsa Tiracolo', price: 189.9, is_new: true, variants: [] };

describe('loja sem promocao: nada muda', () => {
  test.each(Object.keys(hashes))('fixture %s segue byte a byte', (nome) => {
    const html = buildPage(dadosEntrega[nome](), 'loja-exemplo');
    expect({ bytes: Buffer.byteLength(html), sha256: sha(html) }).toEqual(hashes[nome]);
  });

  test('sem a opcao, o script e o mesmo de opcoes vazias', () => {
    expect(buildScript('{}', 'x', '', null, { promocao: false })).toBe(buildScript('{}', 'x', '', null));
  });

  test('promocao encerrada ou agendada nao chega ao payload, entao nao injeta nada', () => {
    expect(promocao.temPromocaoNoPayload({ products: [semPromo], home: {} })).toBe(false);
    expect(promocao.temPromocaoNoPayload({})).toBe(false);
    expect(promocao.temPromocaoNoPayload(null)).toBe(false);
  });
});

describe('quando a loja tem promocao no ar', () => {
  test('detecta na grade, na home, na variante e na peca da URL propria', () => {
    expect(promocao.temPromocaoNoPayload({ products: [semPromo, emPromo] })).toBe(true);
    expect(promocao.temPromocaoNoPayload({ products: [], home: { novidades: [emPromo] } })).toBe(true);
    expect(promocao.temPromocaoNoPayload({ products: [{ ...semPromo, variants: [{ id: 'v', em_promocao: true }] }] })).toBe(true);
    expect(promocao.temPromocaoNoPayload({ products: [], produto_inicial: emPromo })).toBe(true);
  });

  test('a pagina ganha o riscado e o script continua valido', () => {
    const d = dadosEntrega.so_pix();
    d.products = [emPromo, semPromo];
    const html = buildPage(d, 'loja-exemplo');
    expect(html).toContain("'<div class=\"product-price-row\">'+deRiscado(p)+");
    expect(html).toContain('offDoDetalhe(p,variante,v)');
    expect(html).toContain('function estiloDaPromocao()');
    const ini = html.indexOf('<script>\nvar __S');
    const js = html.slice(ini + '<script>'.length, html.indexOf('</script>', ini));
    expect(() => new Function(js)).not.toThrow();
  });

  test('cada troca acha o seu trecho uma vez so; trecho sumido quebra', () => {
    for (const [de] of promocao.TROCAS_DO_CARTAO) expect(card.split(de).length - 1).toBe(1);
    for (const [de] of promocao.TROCAS_DO_DETALHE) expect(productDetail.split(de).length - 1).toBe(1);
    expect(() => promocao.aplicarNoCartao(card.replace('product-price-row', 'x'))).toThrow(/promocao/);
    expect(() => promocao.aplicarNoDetalhe(productDetail.replace('pd-preco-linha', 'x'))).toThrow(/promocao/);
  });
});

describe('o cartao', () => {
  const c = cliente();

  test('De riscado, Por, etiqueta -30% no lugar do NOVO, parcela e Pix sobre o Por', () => {
    const h = c.cardHtml(emPromo);
    expect(h).toContain('<s class="product-de mono"><span class="pr-sr">de </span>R$ 139,90</s><span class="pr-sr"> por </span><span class="product-price mono">R$ 97,90</span>');
    expect(h).toContain('<span class="card-off mono">-30%</span>');
    expect(h).not.toContain('NOVO');
    expect(h).toContain('R$ 88,11 no Pix');
  });

  test('peca sem promocao fica igual: sem riscado e com o selo NOVO', () => {
    const h = c.cardHtml(semPromo);
    expect(h).not.toContain('product-de');
    expect(h).not.toContain('card-off');
    expect(h).toContain('<span class="card-badge">NOVO</span>');
  });

  test('loja que esconde os precos nao mostra o riscado', () => {
    const h = cliente({ show_prices: false }).cardHtml(emPromo);
    expect(h).not.toContain('product-de');
    expect(h).not.toContain('card-off');
  });
});

describe('regras', () => {
  const c = cliente();

  test('a etiqueta arredonda para baixo e some sem desconto de verdade', () => {
    expect(c.pctDaPromocao(139.9, 97.9)).toBe(30);
    expect(c.pctDaPromocao(100, 70)).toBe(30);
    expect(c.pctDaPromocao(100, 70.01)).toBe(29);
    expect(c.pctDaPromocao(100, 99.5)).toBe(0);
    expect(c.pctDaPromocao(100, 100)).toBe(0);
    expect(c.pctDaPromocao(null, 10)).toBe(0);
  });

  test('a data do fim e o dia em Brasilia (23:59:59 de 30/11 e 30/11)', () => {
    expect(c.dataDaPromocao('2026-12-01T02:59:59.000Z')).toBe('30/11');
    // Fim gravado a meia-noite do dia seguinte ainda e "ate 30/11".
    expect(c.dataDaPromocao('2026-12-01T03:00:00.000Z')).toBe('30/11');
    expect(c.dataDaPromocao('2026-11-27T15:00:00.000Z')).toBe('27/11');
    expect(c.dataDaPromocao('lixo')).toBe('');
  });

  test('pagina do produto: a promocao da variante, a do produto, ou nenhuma', () => {
    const p = { ...emPromo };
    // Sem variante escolhida: a do produto.
    expect(c.promoDaEscolha(p, null)).toEqual({ de: 139.9, ate: emPromo.promo_ends_at });
    // Variante sem preco proprio: segue o produto.
    expect(c.promoDaEscolha(p, { price_override: null })).toEqual({ de: 139.9, ate: emPromo.promo_ends_at });
    // Variante com preco proprio e sem promocao: sem De.
    expect(c.promoDaEscolha(p, { price_override: 150 })).toBe(null);
    // Variante com promocao propria: a dela.
    expect(c.promoDaEscolha(semPromo, { price_override: 79.9, preco_de: 99.9, em_promocao: true, promo_ends_at: '2026-11-28T12:00:00Z' }))
      .toEqual({ de: 99.9, ate: '2026-11-28T12:00:00Z' });
  });

  test('pagina do produto: De, etiqueta e "Promocao ate 30/11"', () => {
    expect(c.deDoDetalhe(emPromo, null, 97.9)).toBe('<s class="pd-de mono"><span class="pr-sr">de </span>R$ 139,90</s><span class="pr-sr"> por </span>');
    expect(c.offDoDetalhe(emPromo, null, 97.9)).toBe('<span class="pd-off mono">-30%</span>');
    expect(c.ateDoDetalhe(emPromo, null, 97.9)).toBe('<span class="pd-ate">Promoção até 30/11</span>');
    expect(c.deDoDetalhe(semPromo, null, 189.9)).toBe('');
    expect(c.offDoDetalhe(semPromo, null, 189.9)).toBe('');
    expect(c.ateDoDetalhe(semPromo, null, 189.9)).toBe('');
  });
});
