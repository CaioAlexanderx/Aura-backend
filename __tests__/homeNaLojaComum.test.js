// ============================================================
// A home da loja comum (fase 3 do redesign, 02/09/2026)
//
// O que se trava: a ORDEM da pagina (anuncio, cabecalho, hero, blocos,
// grade, selos, WhatsApp, rodape), o contrato entre o HTML e os parts/
// (ids que o JS procura), o cartao unico (grade e home desenham com a
// MESMA funcao), o modo home, e as tres regras novas do builder — barra
// de anuncio composta, resumo de horario e CNPJ formatado.
// ============================================================
const fs = require('fs');
const path = require('path');

const buildPage = require('../src/templates/storefrontPage');
const buildStyles = require('../src/templates/storefrontStyles');
const { anuncioAutomatico, resumoDeHorario, formatarCnpj } = require('../src/services/storefrontBuilder');

const parts = (n) => fs.readFileSync(path.join(__dirname, '../src/templates/storefront/parts/', n), 'utf8');
const semComentarios = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function pagina(extra) {
  return buildPage(Object.assign({
    site: {
      name: 'Finesse', tagline: 'O look perfeito', primary_color: '#7a1f3a',
      logo_url: 'https://x/logo.jpg', cnpj_formatado: '12.345.678/0001-90',
      announcement_auto: 'Troca em até 7 dias', horario_resumo: 'Seg a sáb, 9h às 18h',
      banners: [{ headline: 'Peças que vestem a semana', cta: 'Ver a coleção', cta_url: '#cat=/vestidos', image_url: 'https://x/b.jpg' }],
      service_cards: [{ icon: 'shield', title: 'Compra segura', body: 'Pix ou cartão' }],
      is_open_now: true,
    },
    contact: { whatsapp: '5534999999999', address: 'Av. Presidente Vargas, 341' },
    settings: { has_pix: true, pickup_enabled: true },
    products: [], categories: [], categorias_arvore: [], tira_de_categorias: [],
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
  }, extra || {}), 'finesse');
}

describe('a ordem da pagina', () => {
  const html = pagina();
  const pos = (s) => { const i = html.indexOf(s); expect({ s, i }).toEqual({ s, i: expect.any(Number) }); expect(i).toBeGreaterThan(0); return i; };
  test('anuncio, cabecalho, hero, blocos, grade, selos, WhatsApp, rodape', () => {
    const ordem = [
      'class="announcement-bar"', 'id="topbar"', 'id="bannerStage"',
      'id="tiraCats"', 'id="homeMaisVendidos"', 'id="homeUltimas"', 'id="homeNovidades"',
      'id="catsWrap"', 'id="productsAnchor"', 'class="service-strip"', 'class="whats-block"', '<footer',
    ];
    const idx = ordem.map(pos);
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });
  test('o body nasce em modo home', () => {
    expect(html).toMatch(/<body class="[^"]*\bhome\b/);
  });
  test('os blocos nascem escondidos — o JS decide o que tem dado', () => {
    for (const id of ['homeMaisVendidos', 'homeUltimas', 'homeNovidades']) {
      expect(html).toMatch(new RegExp('id="' + id + '"[^>]*hidden'));
    }
  });
});

describe('cabecalho', () => {
  const html = pagina();
  test('categorias de topo, mega-menu, gaveta e busca sempre visivel', () => {
    expect(html).toContain('id="topNav"');
    expect(html).toContain('id="megaMenu"');
    expect(html).toContain('id="drawerMenu"');
    expect(html).toContain('class="search-pill"');
    expect(html).toContain('id="searchInput"');
  });
  test('o selo Aberta nao aparece; Fechada sim, com o proximo horario', () => {
    expect(html).not.toContain('open-badge is-open');
    const fechada = pagina({ site: { name: 'F', is_open_now: false, next_open_text: 'Abre amanhã às 09:00', banners: [] } });
    expect(fechada).toContain('open-badge is-closed');
    expect(fechada).toContain('Abre amanhã às 09:00');
  });
  test('o mega-menu abre no mouse E no clique, e fecha ao sair do cabecalho', () => {
    const src = semComentarios(parts('home.js'));
    expect(src).toContain("addEventListener('mouseenter'");
    expect(src).toContain("addEventListener('click'");
    expect(src).toContain("addEventListener('mouseleave',fecharMega)");
    expect(src).toContain("e.key==='Escape'");
  });
});

describe('hero full-bleed', () => {
  test('banner com foto: scrim e texto branco; sem banner: headline sobre o wash', () => {
    const com = pagina();
    expect(com).toContain('hero-slide com-foto');
    expect(com).toContain('hero-scrim');
    const sem = pagina({ site: { name: 'F', tagline: 'Bem-vinda', banners: [] } });
    expect(sem).toContain('hero-slide sem-foto');
    expect(sem).toContain('Bem-vinda');
  });
  test('CTA interno (#cat=) navega na mesma aba; http(s) abre em nova aba', () => {
    const interno = pagina();
    expect(interno).toContain('href="#cat=/vestidos" onclick="return irPeloCta(this)"');
    const externo = pagina({ site: { name: 'F', banners: [{ headline: 'x', cta: 'Ir', cta_url: 'https://loja.com/x' }] } });
    expect(externo).toContain('href="https://loja.com/x" target="_blank"');
  });
  test('a rotacao continua lendo #bannerStage e #bannerDots', () => {
    const html = pagina({ site: { name: 'F', banners: [{ headline: 'a' }, { headline: 'b' }] } });
    expect(html).toContain('id="bannerDots"');
    expect(html).toContain("querySelectorAll('#bannerStage .banner-slide')");
  });
  test('a proporcao e 3:1 no desktop (1920x640) e 340px no celular', () => {
    const css = buildStyles('#7a1f3a', null, false, 'classic');
    expect(css).toContain('.hero{position:relative;width:100%;height:clamp(360px,38vw,540px)');
    expect(css).toMatch(/@media\(max-width:600px\)\{[\s\S]*\.hero\{height:340px;\}/);
  });
});

describe('um cartao so', () => {
  const produtos = semComentarios(parts('products.js'));
  const home = semComentarios(parts('home.js'));
  test('a grade desenha com cardHtml', () => {
    expect(produtos).toContain('grid.innerHTML=visiveis.map(function(p){ return cardHtml(p); })');
  });
  test('a home desenha com o MESMO cardHtml', () => {
    expect(home).toContain('lista.map(function(p){return cardHtml(p);})');
    expect(home).toContain('nov.map(function(p){return cardHtml(p);})');
  });
  test('o cartao mostra NOVO, Pix, parcela e tamanhos com saldo', () => {
    const card = semComentarios(parts('card.js'));
    expect(card).toContain("p.is_new?'NOVO':''");
    expect(card).toContain('class="product-pix"');
    expect(card).toContain('class="product-parcela"');
    expect(card).toContain('class="card-tams"');
    expect(card).toContain('if(!(v.stock_qty>0)) return;');
  });
  test('a grade reavalia o modo home a cada render', () => {
    expect(produtos).toContain("if(typeof atualizarModoHome==='function') atualizarModoHome();");
  });
  test('os blocos so aparecem em modo home; a barra antiga some na home', () => {
    const css = buildStyles('#7a1f3a', null, false, 'classic');
    expect(css).toContain('body:not(.home) .home-sec{display:none;}');
    expect(css).toContain('body.home .cats-wrap{display:none;}');
  });
});

describe('rodape', () => {
  const html = pagina();
  const foot = html.slice(html.indexOf('<footer'));
  test('tres colunas: identidade, como atende, navegue', () => {
    expect(foot).toContain('site-footer-cols3');
    expect(foot).toContain('site-footer-logo');
    expect(foot).toContain('Formas de pagamento');
    expect(foot).toContain('Trocas e devoluções');
    expect(foot).toContain('id="footerNav"');
  });
  test('CNPJ e horario entram quando existem', () => {
    expect(foot).toContain('CNPJ 12.345.678/0001-90');
    expect(foot).toContain('Seg a sáb, 9h às 18h');
  });
  test('o selo "Loja verificada Aura" fica junto da assinatura, e a Aura continua UMA vez', () => {
    expect(foot).toContain('Loja verificada Aura');
    expect((foot.match(/getaura\.com\.br/g) || []).length).toBe(1);
    const bottom = foot.slice(foot.indexOf('site-footer-bottom'));
    expect(bottom).toContain('class="powered"');
    expect(bottom).toContain('selo-aura');
  });
});

describe('barra de anuncio composta do que a lojista ligou', () => {
  test('so troca, quando nao ha frete gratis nem Pix', () => {
    expect(anuncioAutomatico({ delivery_enabled: false, delivery_free_above_amount: 299, pix_discount_pct: 0 })).toBe('Troca em até 7 dias');
  });
  test('frete gratis exige entrega ligada E valor', () => {
    expect(anuncioAutomatico({ delivery_enabled: true, delivery_free_above_amount: 299, pix_discount_pct: 0 })).toBe('Frete grátis acima de R$ 299 · Troca em até 7 dias');
    expect(anuncioAutomatico({ delivery_enabled: true, delivery_free_above_amount: null, pix_discount_pct: 0 })).toBe('Troca em até 7 dias');
  });
  test('o desconto do Pix entra com o percentual dela', () => {
    expect(anuncioAutomatico({ delivery_enabled: true, delivery_free_above_amount: 150.5, pix_discount_pct: 5 })).toBe('Frete grátis acima de R$ 150,50 · Troca em até 7 dias · 5% off no Pix');
  });
  test('o texto escrito pela lojista vence o composto', () => {
    const html = pagina({ site: { name: 'F', announcement_bar: 'Minha frase', announcement_auto: 'Composta', banners: [] } });
    const i = html.indexOf('class="announcement-bar"');
    const barra = html.slice(i, html.indexOf('</div>', i));
    expect(barra).toContain('Minha frase');
    expect(barra).not.toContain('Composta');
  });
});

describe('resumo de horario', () => {
  test('dias consecutivos com o mesmo horario viram uma faixa', () => {
    const h = { seg: { open: '09:00', close: '18:00' }, ter: { open: '09:00', close: '18:00' }, qua: { open: '09:00', close: '18:00' }, qui: { open: '09:00', close: '18:00' }, sex: { open: '09:00', close: '18:00' }, sab: { open: '09:00', close: '18:00' }, dom: { closed: true } };
    expect(resumoDeHorario(h, false)).toBe('Seg a sáb, 9h às 18h');
  });
  test('sabado diferente vira um segundo grupo', () => {
    const h = { seg: { open: '09:00', close: '18:00' }, ter: { open: '09:00', close: '18:00' }, qua: { open: '09:00', close: '18:00' }, qui: { open: '09:00', close: '18:00' }, sex: { open: '09:00', close: '18:00' }, sab: { open: '09:00', close: '13:30' } };
    expect(resumoDeHorario(h, false)).toBe('Seg a sex, 9h às 18h · Sáb, 9h às 13h30');
  });
  test('24 horas e um estado, nao um intervalo', () => {
    expect(resumoDeHorario({ seg: { open: '09:00', close: '18:00' } }, true)).toBe('Aberta 24 horas');
  });
  test('sem horario, nada — e horario ilegivel nao inventa', () => {
    expect(resumoDeHorario({}, false)).toBe('');
    expect(resumoDeHorario(null, false)).toBe('');
    expect(resumoDeHorario({ seg: { open: '24:00', close: 'x' } }, false)).toBe('');
  });
});

describe('CNPJ formatado', () => {
  test('14 digitos viram a mascara; o resto vira vazio', () => {
    expect(formatarCnpj('12345678000190')).toBe('12.345.678/0001-90');
    expect(formatarCnpj('12.345.678/0001-90')).toBe('12.345.678/0001-90');
    expect(formatarCnpj('123')).toBe('');
    expect(formatarCnpj(null)).toBe('');
  });
});
