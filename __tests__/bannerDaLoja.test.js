// ============================================================
// Banner da loja (QA das lojas, 08/09/2026)
//
// Tres achados no mesmo bloco:
//  - sem a arte do celular, a larga era cortada no centro e o texto da
//    arte ("Aqui voce encontra") ficava de fora;
//  - o gradiente escuro entrava em toda foto, com ou sem texto por cima,
//    e escurecia a esquerda da arte da Finesse;
//  - a arte subia como veio (PNG de 2 MB, tres por loja).
// ============================================================
const fs = require('fs');
const path = require('path');
const buildPage = require('../src/templates/storefrontPage');

function paginaCom(banners) {
  return buildPage({
    slug: 'loja',
    site: { name: 'Loja', primary_color: '#7a1f3a', banners },
    contact: {}, settings: {}, products: [], categories: [],
    categorias_arvore: [], tira_de_categorias: [], facetas: { preco: { min: 10, max: 300 } },
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
  }, 'loja');
}

const foto = 'https://cdn/banner_0.jpg';
const fotoMob = 'https://cdn/banner_0_mobile.jpg';

describe('o hero no celular sem a arte do celular', () => {
  test('nenhum banner com a versao do celular: o hero fica na proporcao da larga', () => {
    const html = paginaCom([{ image_url: foto }, { image_url: 'https://cdn/banner_1.jpg' }]);
    expect(html).toContain('<section class="hero hero-larga-no-celular" id="bannerStage">');
    expect(html).toMatch(/class="banner-slide hero-slide com-foto sem-foto-mob active"/);
  });

  test('basta UMA arte do celular pra voltar ao hero alto', () => {
    const html = paginaCom([{ image_url: foto, image_url_mobile: fotoMob }, { image_url: 'https://cdn/banner_1.jpg' }]);
    expect(html).toContain('<section class="hero" id="bannerStage">');
    // O banner sem a arte do celular continua marcado: o CSS so age sob
    // hero-larga-no-celular, entao ele segue cortado no centro, como antes.
    expect(html).toMatch(/class="banner-slide hero-slide com-foto active"/);
    expect(html).toMatch(/class="banner-slide hero-slide com-foto sem-foto-mob"/);
  });

  test('banner sem foto nenhuma nao muda o hero', () => {
    const html = paginaCom([{ headline: 'Bem-vinda' }]);
    expect(html).toContain('<section class="hero" id="bannerStage">');
    // (a classe existe no CSS; o que nao pode e um slide carregar ela)
    expect(html).not.toMatch(/class="banner-slide hero-slide[^"]*sem-foto-mob/);
  });

  test('o CSS do celular mostra a arte inteira sob o hero largo', () => {
    const css = paginaCom([{ image_url: foto }]);
    expect(css).toContain('.hero.hero-larga-no-celular{height:auto;aspect-ratio:3/1;min-height:0;}');
    expect(css).toContain('.hero.hero-larga-no-celular .hero-slide.sem-foto-mob .hero-bg{background-size:contain;');
  });
});

describe('o gradiente escuro sobre a foto', () => {
  test('entra so quando ha texto ou CTA por cima', () => {
    expect(paginaCom([{ image_url: foto, headline: 'Nova colecao' }])).toMatch(/class="banner-slide hero-slide com-foto com-texto/);
    expect(paginaCom([{ image_url: foto, cta: 'Ver', cta_url: '#cat=/vestidos' }])).toMatch(/class="banner-slide hero-slide com-foto com-texto/);
    expect(paginaCom([{ image_url: foto, kicker: 'Outono' }])).toMatch(/class="banner-slide hero-slide com-foto com-texto/);
  });

  test('arte pronta do designer (sem texto) fica sem o gradiente', () => {
    const html = paginaCom([{ image_url: foto }]);
    expect(html).not.toMatch(/class="banner-slide hero-slide[^"]*com-texto/);
    // A regra do CSS exige as duas classes; a antiga, so com com-foto, nao existe mais.
    expect(html).toContain('.hero-slide.com-foto.com-texto .hero-scrim{');
    expect(html).not.toMatch(/\.hero-slide\.com-foto \.hero-scrim\s*\{/);
  });

  test('CTA sem destino nao conta como texto', () => {
    expect(paginaCom([{ image_url: foto, cta: 'Ver' }])).not.toMatch(/class="banner-slide hero-slide[^"]*com-texto/);
  });
});

describe('a arte passa pelo sharp no upload', () => {
  const rota = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'digitalChannel.js'), 'utf8');
  const upload = rota.slice(rota.indexOf("router.post('/upload-image'"));

  test('banner, banner do celular e capa de categoria sao comprimidos; o logo nao', () => {
    expect(upload).toContain('if (isBannerN || isCover || isCategoria) {');
    expect(upload).toContain('comprimirArteDaLoja(content, largura)');
    expect(upload).toContain("bannerMobile ? LARGURA_BANNER_MOBILE : isCategoria ? LARGURA_CAPA : LARGURA_BANNER");
  });

  test('sem o sharp no ambiente, sobe o original como sempre', () => {
    expect(upload).toMatch(/catch \(e\) \{\s*console\.warn\('\[canal-upload\] arte sem compressao/);
    expect(upload).toContain('uploadToR2(key, corpo, mime)');
  });

  test('as larguras sao as da loja: 1920 (3:1 do painel), 1080 celular, 1200 capa', () => {
    const u = require('../src/utils/fotosDeProduto');
    expect(u.LARGURA_BANNER).toBe(1920);
    expect(u.LARGURA_BANNER_MOBILE).toBe(1080);
    expect(u.LARGURA_CAPA).toBe(1200);
    expect(typeof u.comprimirArteDaLoja).toBe('function');
  });
});

describe('job 002 — banners que ja estavam no ar', () => {
  beforeEach(() => { jest.resetModules(); });

  function montar({ bytes, ext }) {
    jest.doMock('../src/utils/r2Storage', () => ({
      R2_CONFIG: { publicUrl: 'https://pub.r2.dev', accessKey: 'k', accountId: 'a' },
      uploadToR2: jest.fn(async (key) => ({ success: true, key, url: 'https://pub.r2.dev/' + key })),
    }));
    jest.doMock('../src/utils/fotosDeProduto', () => ({
      comprimirArteDaLoja: jest.fn(async () => ({ buffer: Buffer.alloc(150 * 1024), largura: 1920, altura: 640, bytesOriginais: bytes })),
      LARGURA_BANNER: 1920, LARGURA_BANNER_MOBILE: 1080, LARGURA_CAPA: 1200,
    }));
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(bytes) }));
    const job = require('../jobs/002_banners_leves');
    const r2 = require('../src/utils/r2Storage');
    const url = `https://pub.r2.dev/cid/canal/banner_0.${ext}?v=1`;
    const queries = [];
    const pool = {
      query: jest.fn(async (sql, params) => {
        queries.push({ sql, params });
        if (/FROM digital_channel_config/.test(sql)) return { rows: [{ company_id: 'cid', banners: [{ image_url: url, image_url_mobile: null, headline: '' }] }] };
        if (/FROM product_categories/.test(sql)) return { rows: [] };
        return { rows: [] };
      }),
    };
    return { job, r2, pool, queries, url };
  }

  test('PNG de 2 MB vira JPEG, guarda o original de lado e grava a URL nova', async () => {
    const { job, r2, pool, queries } = montar({ bytes: 2 * 1024 * 1024, ext: 'png' });
    const r = await job.run({ pool, log: () => {} });
    expect(r).toMatchObject({ concluido: true, ok: 1, falha: 0 });
    const chaves = r2.uploadToR2.mock.calls.map((c) => c[0]);
    expect(chaves).toEqual(['cid/canal/banner_0.orig.png', 'cid/canal/banner_0.jpg']);
    const update = queries.find((q) => /UPDATE digital_channel_config/.test(q.sql));
    expect(update).toBeTruthy();
    const banners = JSON.parse(update.params[0]);
    expect(banners[0].image_url).toMatch(/^https:\/\/pub\.r2\.dev\/cid\/canal\/banner_0\.jpg\?v=\d+$/);
    expect(banners[0].image_url_mobile).toBeNull();
    expect(banners[0].headline).toBe('');
  });

  test('JPEG ja leve fica como esta', async () => {
    const { job, r2, pool, queries } = montar({ bytes: 120 * 1024, ext: 'jpg' });
    const r = await job.run({ pool, log: () => {} });
    expect(r).toMatchObject({ concluido: true, ok: 0, pulado: 1 });
    expect(r2.uploadToR2).not.toHaveBeenCalled();
    expect(queries.some((q) => /UPDATE digital_channel_config/.test(q.sql))).toBe(false);
  });

  test('arte fora do nosso R2 fica como esta', async () => {
    const { job, pool, queries } = montar({ bytes: 2 * 1024 * 1024, ext: 'png' });
    pool.query.mockImplementation(async (sql) => {
      queries.push({ sql });
      if (/FROM digital_channel_config/.test(sql)) return { rows: [{ company_id: 'cid', banners: [{ image_url: 'https://outro.cdn/x.png' }] }] };
      return { rows: [] };
    });
    const r = await job.run({ pool, log: () => {} });
    expect(r).toMatchObject({ concluido: true, ok: 0, pulado: 1 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
