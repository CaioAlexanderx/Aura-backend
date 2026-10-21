// ============================================================
// Fotos da vitrine pelo dominio proprio (tq-65, 20/10/2026)
//
// As URLs gravadas usam pub-<hash>.r2.dev: sem cache da Cloudflare, sem
// Cache-Control, ~0,59 s por foto. O mesmo bucket responde em
// r2.getaura.com.br com cache (~0,10 s). A troca e so no texto que a
// vitrine manda; o banco nao muda e STOREFRONT_FOTOS_HOST=off desliga.
// ============================================================
const fs = require('fs');
const path = require('path');

const R2DEV = 'https://pub-f21f233f50d1412abc93a05bbdffd0d3.r2.dev';
const chave = '3a95021d-62e2-417c-8863-b9c4f0a5e155/products/29ef149c/gallery/4f56861e.thumb.jpg?v=1791074512381';

function carregar(env) {
  jest.resetModules();
  const antes = process.env.STOREFRONT_FOTOS_HOST;
  if (env === undefined) delete process.env.STOREFRONT_FOTOS_HOST;
  else process.env.STOREFRONT_FOTOS_HOST = env;
  const mod = require('../src/services/fotosPeloDominioProprio');
  return { mod, restaurar: () => { if (antes === undefined) delete process.env.STOREFRONT_FOTOS_HOST; else process.env.STOREFRONT_FOTOS_HOST = antes; } };
}

describe('a troca do host', () => {
  test('padrao: r2.dev vira r2.getaura.com.br, caminho e ?v= intactos', () => {
    const { mod, restaurar } = carregar(undefined);
    expect(mod.fotosPeloDominioProprio(`<img src="${R2DEV}/${chave}">`))
      .toBe(`<img src="https://r2.getaura.com.br/${chave}">`);
    restaurar();
  });

  test('troca todas as ocorrencias, no HTML e no JSON embutido', () => {
    const { mod, restaurar } = carregar(undefined);
    const html = `<link rel="icon" href="${R2DEV}/a.png?v=1"><script>var __S={"image_url":"${R2DEV}/b.jpg?v=2"}</script>`;
    const saida = mod.fotosPeloDominioProprio(html);
    expect(saida).not.toContain('r2.dev');
    expect(saida.match(/https:\/\/r2\.getaura\.com\.br\//g)).toHaveLength(2);
    restaurar();
  });

  test('so o host do R2 de desenvolvimento: outros hosts e textos ficam iguais', () => {
    const { mod, restaurar } = carregar(undefined);
    const outros = [
      'https://r2.getaura.com.br/x.jpg',
      'https://cdn.jsdelivr.net/x.jpg',
      'https://pub.r2.dev/x.jpg',                // nao e pub-<32 hex>
      'http://pub-f21f233f50d1412abc93a05bbdffd0d3.r2.dev/x.jpg', // http nao
      'https://pub-f21f233f50d1412abc93a05bbdffd0d3.r2.dev.evil.com/x.jpg',
      'texto sem url nenhuma',
    ].join(' ');
    expect(mod.fotosPeloDominioProprio(outros)).toBe(outros);
    restaurar();
  });

  test('STOREFRONT_FOTOS_HOST=off desliga sem deploy de codigo', () => {
    const { mod, restaurar } = carregar('off');
    const html = `<img src="${R2DEV}/${chave}">`;
    expect(mod.fotosPeloDominioProprio(html)).toBe(html);
    const obj = { products: [{ image_url: `${R2DEV}/${chave}` }] };
    expect(mod.fotosPeloDominioProprioNoJson(obj)).toBe(obj);
    restaurar();
  });

  test('outro host configurado e usado; valor invalido desliga em vez de quebrar a foto', () => {
    let c = carregar('https://midia.getaura.com.br/');
    expect(c.mod.fotosPeloDominioProprio(`${R2DEV}/a.jpg`)).toBe('https://midia.getaura.com.br/a.jpg');
    c.restaurar();
    c = carregar('javascript:alert(1)');
    expect(c.mod.fotosPeloDominioProprio(`${R2DEV}/a.jpg`)).toBe(`${R2DEV}/a.jpg`);
    c.restaurar();
  });

  test('JSON: troca dentro de objetos e listas; sem r2.dev devolve o mesmo objeto', () => {
    const { mod, restaurar } = carregar(undefined);
    const obj = { products: [{ image_url: `${R2DEV}/a.jpg?v=1`, thumb_url: `${R2DEV}/a.thumb.jpg?v=1`, variants: [{ image_url: `${R2DEV}/v.jpg` }] }], total: 1, facetas: null };
    const saida = mod.fotosPeloDominioProprioNoJson(obj);
    expect(saida.products[0].image_url).toBe('https://r2.getaura.com.br/a.jpg?v=1');
    expect(saida.products[0].thumb_url).toBe('https://r2.getaura.com.br/a.thumb.jpg?v=1');
    expect(saida.products[0].variants[0].image_url).toBe('https://r2.getaura.com.br/v.jpg');
    expect(saida.total).toBe(1);
    expect(saida.facetas).toBeNull();
    const semFoto = { products: [], total: 0 };
    expect(mod.fotosPeloDominioProprioNoJson(semFoto)).toBe(semFoto);
    restaurar();
  });
});

describe('onde a vitrine aplica', () => {
  const rota = fs.readFileSync(path.join(__dirname, '../src/routes/storefront.js'), 'utf8');
  test('a pagina da loja (e a copia guardada da home sai ja trocada)', () => {
    expect(rota).toContain('const html = fotosPeloDominioProprio(buildStorefrontPage(data, slug));');
    expect(rota.indexOf('const html = fotosPeloDominioProprio(')).toBeLessThan(rota.indexOf('lembrarPagina(slug, html)'));
  });
  test('as paginas seguintes do catalogo e a galeria da peca', () => {
    expect(rota).toContain('res.json(fotosPeloDominioProprioNoJson({\n      products: pagina.produtos.map(');
    expect(rota).toContain('res.json(fotosPeloDominioProprioNoJson(galeria));');
  });
  test('o CSP da vitrine ja aceita qualquer imagem https', () => {
    expect(rota).toContain(`"img-src 'self' data: blob: https:"`);
  });
});
