// ============================================================
// Banner proprio pro celular (02/09/2026, QA da Finesse)
//
// O hero e 3:1 e no celular e cortado no centro: a arte da Finesse tem
// "Aqui voce encontra" desenhado na imagem e sobrava "ce / a". A Oscar
// resolve com um banner separado pro celular; aqui tambem. O item do
// JSON ganha image_url_mobile; o upload aceita banner_N_mobile; o hero
// poe as duas fotos em variaveis CSS e o CSS escolhe por largura.
// ============================================================
const fs = require('fs');
const path = require('path');
const buildPage = require('../src/templates/storefrontPage');
const homeStyles = require('../src/templates/storefrontHomeStyles');

const fonte = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function pagina(banners) {
  return buildPage({
    site: { name: 'Finesse', primary_color: '#7a1f3a', banners },
    contact: { whatsapp: '5534999999999' }, settings: {}, products: [], categories: [],
    categorias_arvore: [], tira_de_categorias: [], facetas: { preco: { min: 10, max: 300 } },
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
  }, 'finesse');
}

describe('o campo passa pelo builder e pelo painel', () => {
  test('parseBanners leva image_url_mobile; sanitizeBanners so aceita http', () => {
    expect(fonte('src/services/storefrontBuilder.js'))
      .toContain("image_url_mobile: typeof b?.image_url_mobile === 'string' && b.image_url_mobile ? b.image_url_mobile : null,");
    expect(fonte('src/routes/digitalChannel.js'))
      .toContain("image_url_mobile: typeof b?.image_url_mobile === 'string' && b.image_url_mobile.startsWith('http') ? b.image_url_mobile : null,");
  });
  test('upload e delete aceitam banner_N_mobile e mexem so no campo certo', () => {
    const rota = fonte('src/routes/digitalChannel.js');
    expect(rota.split('/^banner_([0-2])(_mobile)?$/').length - 1).toBe(2);
    expect(rota).toContain("`banner_${bannerIdx}${bannerMobile ? '_mobile' : ''}`");
    expect(rota).toContain("jsonb_set(banners, ARRAY[$2::text, $4::text], to_jsonb($3::text), true)");
    expect(rota).toContain("jsonb_set(banners, ARRAY[$2::text, $3::text], 'null'::jsonb, false)");
    expect(rota).toContain("[cid, String(bannerIdx), url, bannerCampo]");
    expect(rota).toContain("[cid, String(bannerIdx), bannerCampo]");
  });
});

describe('o hero poe as duas fotos em variaveis CSS', () => {
  test('com a foto do celular: --hero-desk e --hero-mob', () => {
    const html = pagina([{ headline: 'Oi', image_url: 'https://a/x.jpg', image_url_mobile: 'https://a/m.jpg', enabled: true }]);
    expect(html).toContain(`style="--hero-desk:url('https://a/x.jpg');--hero-mob:url('https://a/m.jpg')"`);
  });
  test('sem a foto do celular: so --hero-desk, e nada de --hero-mob', () => {
    const html = pagina([{ headline: 'Oi', image_url: 'https://a/x.jpg', enabled: true }]);
    expect(html).toContain(`style="--hero-desk:url('https://a/x.jpg')"`);
    expect(html).not.toContain('--hero-mob');
  });
  test('sem foto nenhuma: sem style', () => {
    const html = pagina([{ headline: 'Oi', enabled: true }]);
    expect(html).not.toContain('--hero-desk');
  });
});

describe('o CSS escolhe por largura', () => {
  const css = homeStyles({ fontSerif: 'S', fontSans: 'A', fontMono: 'M' });
  test('no desktop a larga; no celular a quadrada, com a larga de reserva', () => {
    expect(css).toContain('.hero-bg{position:absolute;inset:0;background-image:var(--hero-desk);');
    const i = css.indexOf('.hero{height:340px;}');
    expect(i).toBeGreaterThan(0);
    expect(css.slice(i, i + 300)).toContain('.hero-bg{background-image:var(--hero-mob,var(--hero-desk));}');
  });
});
