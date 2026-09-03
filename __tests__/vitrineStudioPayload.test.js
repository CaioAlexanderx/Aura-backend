// ============================================================
// O payload da vitrine Studio depois do S0 (03/09/2026)
//
// O redesign pede uma home com banner, rodape com contato, um bloco de
// mais pedidos e um chip de "Mockup 3D" na grade. Nada disso existia no
// payload — e quase tudo ja existia no BANCO, lido so pela loja comum.
//
// O que este teste guarda:
//  1. o bloco `site` é montado em UM lugar (ele nascia escrito duas
//     vezes na mesma rota, e as duas copias ja tinham divergido);
//  2. os campos novos saem da vitrine;
//  3. o desconto do Pix é calculado no servidor, com a MESMA conta da
//     loja comum — regra de dinheiro divergente entre as duas vitrines
//     da mesma empresa foi o defeito da fase 6.
// ============================================================
const fs = require('fs');
const path = require('path');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const studio = fonte('src/routes/studioStorefront.js');
const comum  = fonte('src/routes/storefront.js');

describe('o bloco site vive num lugar so', () => {
  test('existe um montarSite, e os dois retornos chamam ele', () => {
    expect(studio).toContain('function montarSite(config, nomeDaEmpresa)');
    // Um para a loja sem produto nenhum, outro para o retorno normal.
    expect((studio.match(/site: montarSite\(config, /g) || []).length).toBe(2);
  });

  test('nenhum dos retornos monta o site na mao', () => {
    // A marca da copia antiga: `site: {` seguido de `name:`.
    expect(studio).not.toMatch(/site:\s*\{\s*\n\s*name:/);
  });

  test('o site carrega o que a home precisa desenhar', () => {
    const i = studio.indexOf('function montarSite');
    const bloco = studio.slice(i, studio.indexOf('}', studio.indexOf('return {', i)));
    ['name', 'tagline', 'primary_color', 'logo_url', 'cover_url',
     'font_family', 'card_style', 'whatsapp', 'banners', 'redes']
      .forEach((campo) => expect(bloco).toContain(campo + ':'));
  });

  test('banner e redes vem das MESMAS funcoes da loja comum', () => {
    // Uma segunda implementacao de banner divergiria na primeira mudanca
    // — foi assim que a versao de celular quase nasceu so de um lado.
    expect(studio).toContain("parseBanners,");
    expect(studio).toContain("require('../services/redesSociais')");
    expect(studio).toContain('parseBanners(config.banners, config.cover_url');
    expect(studio).toContain('montarRedes(config)');
    expect(comum).not.toContain('function parseBannersStudio');
  });
});

describe('os campos novos do produto e da loja', () => {
  test('cada peca diz quantos pedidos ja teve', () => {
    expect(studio).toContain('pedidos: pedidosPorProduto[p.id] || 0');
    // Cancelado nao conta: pedido desfeito viraria popularidade.
    expect(studio).toContain("COALESCE(o.status, '') <> 'cancelled'");
  });

  test('cada peca diz o TIPO do mockup, sem uma requisicao por produto', () => {
    expect(studio).toContain('visual_kind: visualPorProduto[p.id] || null');
    expect(studio).toContain("t.status = 'published'");
  });

  test('a loja diz quantos pedidos ja entregou', () => {
    expect(studio).toContain('numeros: { pedidos_entregues: entregues }');
    expect(studio).toContain('delivered_at IS NOT NULL');
  });

  test('loja sem produto nenhum devolve os mesmos blocos', () => {
    // Payload que muda de forma conforme o estoque quebra o consumidor
    // justamente no dia em que a lojista despublica o ultimo item.
    const i = studio.indexOf('products: [],');
    expect(studio.slice(i - 200, i + 200)).toContain('numeros:');
  });

  test('as consultas novas nao derrubam loja com migration pendente', () => {
    const i = studio.indexOf('let pedidosPorProduto');
    const bloco = studio.slice(i, studio.indexOf('const categories = await', i));
    expect((bloco.match(/e\.code !== '42703' && e\.code !== '42P01'/g) || []).length).toBe(2);
  });
});

describe('o desconto do Pix, igual nas duas lojas', () => {
  test('a vitrine anuncia o percentual da loja', () => {
    expect(studio).toContain('pix_discount_pct: Number(config.pix_discount_pct) || 0');
  });

  test('e cobra com a MESMA conta da loja comum', () => {
    const conta = /const discount_amount = \(pmethod === 'pix' && pixPct > 0\)\s*\n\s*\? Math\.round\(subtotal \* pixPct\) \/ 100\s*\n\s*: 0;/;
    expect(studio).toMatch(conta);
    expect(comum).toMatch(conta);
    // Frete fora do desconto, nos dois.
    expect(studio).toContain('const total = subtotal - discount_amount + delivery_fee;');
    expect(comum).toContain('const total = subtotal - discount_amount + delivery_fee;');
  });

  test('o pedido grava o desconto, com saida para banco sem a migration 316', () => {
    expect(studio).toContain("comDesconto ? ', discount_amount, discount_reason' : ''");
    expect(studio).toContain("if (e.code !== '42703') throw e;");
  });
});

describe('as rotas de lote', () => {
  test('cotar nao grava; registrar grava como rascunho', () => {
    expect(studio).toContain("router.post('/:slug/studio/bulk-quote'");
    expect(studio).toContain("router.post('/:slug/studio/bulk-order'");
    // Quem confirma um pedido em lote e a lojista, olhando.
    expect(studio).toContain("'draft',NULL");
    expect(studio).not.toContain("'confirmed',NULL");
  });

  test('o preco unitario vem do banco, nunca do cliente', () => {
    const i = studio.indexOf('async function lojaEProdutoDoLote');
    const bloco = studio.slice(i, i + 1200);
    expect(bloco).toContain('SELECT id, name, price FROM products');
    // A rota le produto.price; nao existe unit_price vindo do corpo.
    expect(studio).toContain('cotarLote(qty, parseFloat(produto.price))');
    expect(studio).not.toContain('req.body.unit_price');
    expect(studio).not.toContain('b.unit_price');
  });

  test('so produto visivel na vitrine desta loja entra no lote', () => {
    const i = studio.indexOf('async function lojaEProdutoDoLote');
    const bloco = studio.slice(i, i + 1200);
    expect(bloco).toContain('is_personalizable = true');
    expect(bloco).toContain('studio_storefront_visible IS NOT FALSE');
    expect(bloco).toContain("listVisibilityWhere('$2')");
  });

  test('a lista de nomes tem teto, e o contato e obrigatorio', () => {
    expect(studio).toContain('.slice(0, 200)');
    expect(studio).toContain("if (fone.length < 10)");
  });

  test('as rotas novas nao sao engolidas pelo curinga de produto', () => {
    const i = studio.indexOf('const reservados =');
    const bloco = studio.slice(i, i + 200);
    expect(bloco).toContain("'bulk-quote'");
    expect(bloco).toContain("'bulk-order'");
    // E foram declaradas ANTES dele.
    expect(studio.indexOf("router.post('/:slug/studio/bulk-order'"))
      .toBeLessThan(studio.indexOf("router.get('/:slug/studio/:pid'"));
  });
});
