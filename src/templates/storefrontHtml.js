// AURA. — HTML body da loja comum
//
// REESCRITO em 02/09/2026 (fase 3 do redesign, Claude Design, loja-modelo
// Finesse). A home passa a ter secoes que nascem do estoque — ver
// services/homeDaLoja.js — em vez de "banner + grade". A ordem:
//
//   barra de anuncio (da config, ou composta do que a lojista LIGOU)
//   cabecalho: logo grande, categorias de topo com mega-menu, busca, sacola
//   hero full-bleed 3:1 (ate 3 banners; sem banner, headline sobre o wash)
//   Compre por categoria · Mais vendidos · Ultimas unidades · Acabaram de chegar
//   a grade de sempre (Todos os produtos, paginada)
//   selos · bloco do WhatsApp · rodape em tres colunas
//
// Os blocos da home so aparecem no MODO HOME (sem categoria, busca ou
// filtro) — o JS liga a classe `home` no <body>. Trocar de categoria
// esconde os blocos e mostra a grade: e a "pagina de categoria" da fase 4.
//
// Ids que o JS ja usava continuam os mesmos (topbar, searchInput,
// cartBadge, bannerStage/bannerDots, tiraCats, catsWrap, productsGrid,
// checkout...). O que mudou e o desenho, nao o contrato com os parts/.
//
// buildHtmlBody({
//   siteName, tagline, logoInTopbar, logoNoRodape, contactBar,
//   addrText, horarioTexto, cnpjTexto, announcementBar, banners[],
//   serviceCards[], isOpenNow, nextOpenText, pagamentos, politicaTroca,
//   whatsNum,
// }) → string HTML
//
// O texto da politica e as formas de pagamento moram em
// services/rodapeInstitucional.js — a vitrine Studio desenha o MESMO
// rodape, e calcular em dois lugares e como as duas lojas divergem.
const { POLITICA_PADRAO, montarRodape } = require('../services/rodapeInstitucional');

// Logo oficial do WhatsApp (glyph 24x24, fill currentColor). Nao usar o
// balao generico: e a logo que a cliente reconhece de relance.
const WHATSAPP_GLYPH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413"/></svg>';

// Logos das redes, glyph 24x24 em currentColor — a marca que a cliente
// reconhece de relance, pelo mesmo motivo do WhatsApp acima. Sem cor
// propria: no rodape elas herdam a tinta do texto e acendem na cor da
// loja no hover, senao viram tres adesivos coloridos num rodape sobrio.
const GLYPHS_REDES = {
  instagram: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>',
  tiktok: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
  facebook: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
};

function buildHtmlBody({
  siteName, tagline, logoInTopbar, logoNoRodape, contactBar,
  addrText, horarioTexto, cnpjTexto, announcementBar, banners, serviceCards,
  isOpenNow, nextOpenText,
  pagamentos, politicaTroca, whatsNum, redes,
}) {
  banners = Array.isArray(banners) ? banners : [];
  serviceCards = Array.isArray(serviceCards) ? serviceCards : [];

  // ── Rodape institucional ──────────────────────────────
  // As formas saem da CONFIGURACAO da lojista, nao de uma lista fixa. Sem
  // selo de bandeira: nao temos as marcas, e inventar um retangulo escrito
  // "VISA" seria falsificar.
  const rodape = montarRodape({
    has_pix: !!(pagamentos && pagamentos.pix),
    has_card: !!(pagamentos && pagamentos.card),
    pay_on_delivery_enabled: !!(pagamentos && pagamentos.na_entrega),
  }, politicaTroca);
  const formas = rodape.formas;
  const politica = rodape.politica;

  // ── Redes sociais ─────────────────────────────────────
  // A lojista cadastra o @; quem normaliza e valida e
  // services/redesSociais.js. Aqui so se desenha o que veio. Sem rede
  // cadastrada, a linha inteira nao existe — icone que leva a lugar
  // nenhum e pior que icone nenhum.
  const listaRedes = Array.isArray(redes) ? redes : [];
  const redesHtml = listaRedes.length ? `
        <div class="footer-redes">
          ${listaRedes.map((r) => `<a class="footer-rede" href="${escHtml(r.url)}" target="_blank" rel="noopener"
            aria-label="${escHtml(r.nome)}: @${escHtml(r.handle)}" title="@${escHtml(r.handle)}">${GLYPHS_REDES[r.rede] || ''}</a>`).join('')}
        </div>` : '';

  const rodapeInstitucional = `
      <div class="footer-inst">
        ${formas.length ? `<div class="footer-inst-bloco">
          <div class="sf-label">Formas de pagamento</div>
          <div class="footer-inst-txt">${formas.join(' · ')}</div>
        </div>` : ''}
        ${politica ? `<div class="footer-inst-bloco">
          <div class="sf-label">Trocas e devoluções</div>
          <div class="footer-inst-txt">${escHtml(politica)}</div>
        </div>` : ''}
      </div>`;

  // Icones Feather (stroke 1.6, round). Mesmos paths que parts/products.js.
  const ICONS = {
    truck:   '<path d="M3 16V6h12v10M15 9h4l2 4v3h-6"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    pkg:     '<path d="M3 7v10l9 4 9-4V7l-9-4-9 4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
    shield:  '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z"/>',
    sparkle: '<path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.8 6.7 19.6l1.1-6-4.4-4.2 6-.8L12 3z"/>',
    leaf:    '<path d="M21 3c-7 0-13 4-13 12v6M21 3c0 7-4 13-12 13"/>',
    heart:   '<path d="M12 20s-7-4.5-7-10a4 4 0 017-2.7A4 4 0 0119 10c0 5.5-7 10-7 10z"/>',
    star:    '<path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.8 6.7 19.6l1.1-6-4.4-4.2 6-.8L12 3z"/>',
    pix:     '<path d="m12 3 9 9-9 9-9-9 9-9z"/><path d="M9 12h6M12 9v6"/>',
    card:    '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h2"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    bag:     '<path d="M5 7h14l-1 13H6L5 7z"/><path d="M9 7V5a3 3 0 016 0v2"/>',
    user:    '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>',
  };
  function svgFor(name) {
    const paths = ICONS[name] || ICONS.sparkle;
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  }
  function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // Selo Aberta/Fechada. So o FECHADA aparece no cabecalho novo: "Aberta"
  // ao lado da logo era ruido num cabecalho que ficou limpo, e fechada e
  // a informacao que muda o que a cliente faz (decisao 13, 02/09/2026).
  let openBadgeHtml = '';
  if (isOpenNow === false) {
    openBadgeHtml = `<span class="open-badge is-closed"><span class="open-badge-dot"></span><span class="open-badge-text">Fechada${nextOpenText ? ` · ${escHtml(nextOpenText)}` : ''}</span></span>`;
  }

  // ── Hero full-bleed 3:1 ───────────────────────────────
  // Ate 3 banners rotativos (o JS de rotacao esta em storefrontPage.js e
  // le #bannerStage .banner-slide / #bannerDots .banner-dot). Texto e CTA
  // sobre um gradiente a esquerda; com foto, a foto cobre; sem foto, o
  // wash da marca. CTA so com destino: http(s) abre em nova aba (a sacola
  // vive na memoria), categoria da loja (#cat=/caminho) navega aqui.
  const hasBanners = banners.length > 0;
  const slidesHtml = (hasBanners ? banners : [{
    kicker: '', headline: tagline || siteName, body: '', cta: '', cta_url: '', image_url: null,
  }]).map((b, i) => {
    const comFoto = !!b.image_url;
    // A foto vai em variaveis CSS: --hero-desk sempre, --hero-mob quando
    // a lojista subiu a versao do celular. O CSS escolhe por largura
    // (storefrontHomeStyles.js) — sem --hero-mob, o celular usa a larga.
    const mob = comFoto && b.image_url_mobile ? `;--hero-mob:url('${b.image_url_mobile}')` : '';
    const bgStyle = comFoto ? ` style="--hero-desk:url('${b.image_url}')${mob}"` : '';
    const kicker  = b.kicker   ? `<div class="hero-kicker">${b.kicker}</div>` : '';
    const headline = b.headline ? `<h1 class="hero-headline">${b.headline}</h1>` : '';
    const body    = b.body     ? `<p class="hero-body">${b.body}</p>` : '';
    let cta = '';
    if (b.cta && b.cta_url) {
      const interno = b.cta_url.charAt(0) === '#';
      cta = interno
        ? `<a class="banner-cta" href="${escHtml(b.cta_url)}" onclick="return irPeloCta(this)">${b.cta}<span class="hero-cta-seta" aria-hidden="true">→</span></a>`
        : `<a class="banner-cta" href="${escHtml(b.cta_url)}" target="_blank" rel="noopener">${b.cta}<span class="hero-cta-seta" aria-hidden="true">→</span></a>`;
    }
    return `<div class="banner-slide hero-slide${comFoto ? ' com-foto' : ' sem-foto'}${i===0?' active':''}">
      <div class="hero-bg"${bgStyle}></div>
      <div class="hero-scrim"></div>
      <div class="hero-inner"><div class="hero-text">${kicker}${headline}${body}${cta}</div></div>
    </div>`;
  }).join('\n');

  const dotsHtml = banners.length > 1
    ? `<div class="banner-dots" id="bannerDots">
        ${banners.map((_, i) => `<button class="banner-dot ${i===0?'active':''}" data-idx="${i}" onclick="goBanner(${i})" aria-label="Banner ${i+1}"></button>`).join('')}
      </div>`
    : '';

  const heroHtml = `
<section class="hero" id="bannerStage">
  ${slidesHtml}
  ${dotsHtml}
</section>`;

  const announcementHtml = announcementBar
    ? `<div class="announcement-bar">${announcementBar}</div>`
    : '';

  // Selos: o que a lojista escreveu (service_cards) — ou os padroes, que
  // o builder deriva do que ela ligou. Grade de 4, 2x2 no celular.
  const serviceStrip = serviceCards.length > 0 ? `
<section class="service-strip">
${serviceCards.map((c) => `  <div class="service-card">
    <span class="service-card-icon">${svgFor(c.icon)}</span>
    <div>
      <div class="service-card-title">${escHtml(c.title)}</div>
      ${c.body ? `<div class="service-card-body">${escHtml(c.body)}</div>` : ''}
    </div>
  </div>`).join('\n')}
</section>` : '';

  // Bloco do WhatsApp: em vez da contact-bar, um cartao no wash da marca
  // com o botao verde e a logo oficial. Chega pronto de storefrontPage
  // (contactBar) quando ha numero; vazio quando nao ha.
  const whatsBlock = whatsNum ? `
<section class="whats-block">
  <div class="whats-block-inner">
    <div>
      <div class="whats-block-tit serif">Dúvida com tamanho ou tecido?</div>
      <div class="whats-block-txt">Fale direto com a gente no WhatsApp.</div>
    </div>
    <a class="whatsapp-cta" href="https://wa.me/${whatsNum}" target="_blank" rel="noopener">${WHATSAPP_GLYPH}Chamar no WhatsApp</a>
  </div>
</section>` : (contactBar || '');

  return `${announcementHtml}
<header class="topbar" id="topbar">
  <button type="button" class="menu-btn" onclick="abrirDrawer()" aria-label="Abrir categorias" aria-controls="drawerMenu">
    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
  </button>
  <a class="topbar-brand" href="#" onclick="return irParaHome()" aria-label="${siteName}">
    <div class="topbar-logo">${logoInTopbar}</div>
    <div class="topbar-brand-text">
      <span class="topbar-name">${siteName}</span>
      ${openBadgeHtml}
    </div>
  </a>
  <nav class="topnav" id="topNav" aria-label="Categorias"></nav>
  <div class="topbar-right">
    <div class="cart-btn" onclick="openCart()" role="button" tabindex="0" aria-label="Abrir sacola">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M5 7h14l-1 13H6L5 7z"/><path d="M9 7V5a3 3 0 016 0v2"/></svg>
      <div class="cart-badge" id="cartBadge">0</div>
    </div>
  </div>
  <div class="search-pill" id="topbarSearchInline">
    <svg class="topbar-search-icon" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" placeholder="Buscar na ${siteName}" id="searchInput" oninput="filterProducts()" autocomplete="off" aria-label="Buscar produtos">
    <button class="topbar-search-close" type="button" onclick="limparBusca()" aria-label="Limpar busca" hidden>×</button>
  </div>
  <div class="mega" id="megaMenu" hidden></div>
</header>
<div class="drawer-overlay" id="drawerOverlay" hidden onclick="fecharDrawer()"></div>
<aside class="drawer" id="drawerMenu" hidden aria-label="Categorias"></aside>

${heroHtml}

<!-- Os blocos da home. Nascem escondidos; o JS decide o que tem dado. -->
<section class="home-sec" id="tiraCats" hidden></section>
<section class="home-sec" id="homeMaisVendidos" hidden></section>
<section class="home-sec" id="homeUltimas" hidden></section>
<section class="home-sec" id="homeNovidades" hidden></section>

<div class="cats-wrap" id="catsWrap"></div>
<div class="cats-painel" id="catsPainel" hidden></div>

<!-- A pagina de categoria (fase 4): migalhas, titulo com contagem e
     ordenacao, subcategorias, e a grade com a lateral de filtros. Na home
     a mesma secao e "Todos os produtos", sem lateral. -->
<section class="products-section" id="productsAnchor">
  <nav class="crumbs" id="crumbs" aria-label="Você está em" hidden></nav>
  <div class="products-header">
    <div class="products-header-tit">
      <h2 id="catTitle">Todos os produtos</h2>
      <span class="products-count mono" id="prodCount"></span>
    </div>
    <div class="products-header-acoes">
      <button type="button" class="filtro-btn-mobile" id="filtroBtnMobile" onclick="abrirFolhaDeFiltros()" hidden>Filtrar</button>
      <label class="sort-wrap" id="sortWrap" hidden>
        <span class="sort-lbl">Ordenar</span>
        <select id="sortSelect" onchange="setOrdem(this.value)">
          <option value="destaque">Destaque</option>
          <option value="novidades">Novidades</option>
          <option value="mais_vendidos">Mais vendidos</option>
          <option value="preco_asc">Menor preço</option>
          <option value="preco_desc">Maior preço</option>
          <option value="nome">Nome (A-Z)</option>
        </select>
      </label>
    </div>
  </div>
  <div class="cats-sub" id="catsSub" hidden></div>
  <div class="products-layout">
    <aside class="filtros-wrap" id="filtrosWrap" aria-label="Filtros" hidden></aside>
    <div class="products-main">
      <div class="products-grid" id="productsGrid"></div>
      <div class="grid-more" id="gridMore" hidden></div>
    </div>
  </div>
</section>
<div class="filtros-overlay" id="filtrosOverlay" onclick="fecharFolhaDeFiltros()"></div>

${serviceStrip}

${whatsBlock}

<footer class="site-footer">
  <div class="site-footer-inner">
    <!-- Tres colunas: quem e a loja; como ela atende; por onde navegar.
         Embaixo, o juridico e a assinatura — a Aura aparece UMA vez, na
         mesma frase-link, com o selo ao lado (decisao 5, 02/09/2026). -->
    <div class="site-footer-cols3">
      <div class="site-footer-id">
        <div class="site-footer-logo">${logoNoRodape || `<span class="site-footer-nome serif">${siteName}</span>`}</div>
        ${addrText ? `<div class="site-footer-addr">${addrText}${horarioTexto ? `<br>${escHtml(horarioTexto)}` : ''}</div>` : (horarioTexto ? `<div class="site-footer-addr">${escHtml(horarioTexto)}</div>` : '')}
        ${redesHtml}
      </div>
      ${rodapeInstitucional}
      <div class="footer-nav">
        <div class="sf-label">Navegue</div>
        <ul id="footerNav"></ul>
      </div>
    </div>
    <div class="site-footer-bottom">
      <span>© ${new Date().getFullYear()} ${siteName}${cnpjTexto ? ` · CNPJ ${escHtml(cnpjTexto)}` : ''}</span>
      <span class="site-footer-aura">
        <a class="powered" href="https://getaura.com.br" target="_blank" rel="noopener">
          <span>Loja desenvolvida com</span>
          <span class="brand">Aura<span class="brand-dot">.</span></span>
          <span class="powered-cta">— quero a minha</span>
        </a>
        <span class="selo-aura"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>Loja verificada Aura</span>
      </span>
    </div>
  </div>
</footer>

<div class="cart-overlay" id="cartOverlay" onclick="closeCart()"></div>
<div class="cart-drawer" id="cartDrawer">
  <div class="cart-header"><span class="cart-title">Sacola</span><div class="cart-close" onclick="closeCart()">×</div></div>
  <div class="cart-items" id="cartItems"></div>
  <div class="cart-footer" id="cartFooter" style="display:none">
    <div class="cart-summary-row"><span>Subtotal</span><span id="cartSubtotal">R$ 0,00</span></div>
    <div class="cart-summary-row"><span id="deliveryLabel">Entrega</span><span id="deliveryVal">—</span></div>
    <div class="cart-summary-row total"><span>Total</span><span id="cartTotal">R$ 0,00</span></div>
    <div class="cart-summary-row pix" id="cartPixRow" hidden><span>Pagando no Pix</span><span id="cartPixVal"></span></div>
    <button class="checkout-btn" onclick="openCheckout()">Finalizar compra →</button>
  </div>
</div>

<!-- Checkout em pagina inteira, no mesmo documento (decisao 9, 02/09/2026):
     a sacola vive no navegador e uma rota nova a perderia. Os ids que o
     JS usa (checkoutTitle/Sub, dot1-3, lbl1-3, checkoutBody, nextBtn)
     continuam; o resumo da direita e novo (parts/sacola.js). -->
<div class="checkout-overlay" id="checkoutOverlay">
  <div class="checkout-page">
    <div class="checkout-topo"><div class="checkout-topo-inner">
      <button type="button" class="checkout-voltar-loja" onclick="closeCheckout()">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"/></svg><span>Continuar comprando</span>
      </button>
      <div class="checkout-topo-logo">${logoNoRodape || `<span class="serif">${siteName}</span>`}</div>
      <span class="checkout-seguro"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg><span>Compra segura</span></span>
    </div></div>
    <div class="checkout-corpo">
      <div class="steps-bar">
        <div class="step"><div class="step-dot active" id="dot1">1</div><div class="step-label active" id="lbl1">Seus dados</div></div>
        <div class="step-linha"></div>
        <div class="step"><div class="step-dot" id="dot2">2</div><div class="step-label" id="lbl2">Entrega</div></div>
        <div class="step-linha"></div>
        <div class="step"><div class="step-dot" id="dot3">3</div><div class="step-label" id="lbl3">Pagamento</div></div>
      </div>
      <div class="checkout-cols">
        <div class="checkout-main">
          <div class="checkout-card">
            <div class="checkout-head">
              <div class="checkout-back" onclick="checkoutBack()">←</div>
              <div class="checkout-head-info">
                <div class="checkout-title" id="checkoutTitle">Seus dados</div>
                <div class="checkout-subtitle" id="checkoutSub">Etapa 1 de 3</div>
              </div>
            </div>
            <div class="checkout-body" id="checkoutBody"></div>
          </div>
          <div class="checkout-foot">
            <button type="button" class="prev-btn" id="prevBtn" onclick="checkoutBack()" hidden>← Voltar</button>
            <button class="next-btn" id="nextBtn" onclick="checkoutNext()">Continuar</button>
          </div>
          <div class="checkout-protegido"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>Seus dados são protegidos e usados só para este pedido</div>
        </div>
        <aside class="checkout-resumo" id="checkoutResumo" aria-label="Resumo da sacola"></aside>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>`;
}
module.exports = buildHtmlBody;
// O painel precisa do MESMO texto para pre-preencher o campo da lojista.
module.exports.POLITICA_PADRAO = POLITICA_PADRAO;
module.exports.WHATSAPP_GLYPH = WHATSAPP_GLYPH;
