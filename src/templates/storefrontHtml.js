// AURA. — HTML body da vitrine pública v2
// buildHtmlBody({
//   siteName, tagline, logoInTopbar, logoInHero, contactBar,
//   addrText, coverUrl, announcementBar, banners[], serviceCards[]
// }) → string HTML
//
// banners[]      = [{ kicker, headline, body, cta, tone, tint, image_url }]
// serviceCards[] = [{ icon, title, body }] — strip de benefícios na home
//
// O JS de auto-rotação fica em storefrontPage.js (injetado inline).
//
// v3 (18/05/2026): quando b.image_url é setado, renderiza variante
// "image-clean" independente do tone — imagem ocupa o topo full-bleed
// (sem scrim, sem SVG decorativo, sem texto overlay) e headline+body+CTA
// ficam numa caption band branca logo abaixo, dentro do mesmo slide.
// Cada slide do carrossel mantém sua própria caption (auto-rotation continua).
// Lojas com banner text-only (sem image_url) seguem em split/editorial/
// centered como antes — esses modos foram desenhados pra texto protagonista.
//
// v3.1 (18/05/2026 — Fase 3 PR A):
// Search agora é inline na topbar — botão lupa expande input sobrepondo
// o nome da loja (.topbar.searching). Sem .search-bar-wrap sticky abaixo.
function buildHtmlBody({
  siteName, tagline, logoInTopbar, logoInHero, contactBar,
  addrText, coverUrl, announcementBar, banners, serviceCards,
}) {
  banners = Array.isArray(banners) ? banners : [];
  serviceCards = Array.isArray(serviceCards) ? serviceCards : [];
  const hasBanners = banners.length > 0;
  const hasCover = !!coverUrl;
  const heroSectionClass = hasCover ? 'hero-section has-cover' : 'hero-section no-cover';
  const coverStyle = hasCover ? ` style="background-image:url('${coverUrl}')"` : '';

  // Icon set (mesmos paths que parts/products.js usa). Stroke=currentColor.
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

  // Banner slides
  const slidesHtml = banners.map((b, i) => {
    const tone = b.tone || 'split';
    const tint = b.tint || 'brand';
    const bgStyle = b.image_url ? ` style="background-image:url('${b.image_url}')"` : '';
    const bgClass = b.image_url ? 'banner-slide-bg with-image' : 'banner-slide-bg';
    const kicker  = b.kicker   ? `<div class="banner-kicker">${b.kicker}</div>` : '';
    const headline = b.headline ? `<h2 class="banner-headline">${b.headline}</h2>` : '';
    const body    = b.body     ? `<p class="banner-body">${b.body}</p>` : '';
    const cta     = b.cta      ? `<button class="banner-cta" onclick="scrollToProducts()">${b.cta}</button>` : '';

    // v3: image-clean — quando há image_url, imagem fica no topo full-bleed
    // (sem scrim, sem SVG decorativo, sem texto overlay) e headline+body+CTA
    // ficam numa caption band branca abaixo, dentro do mesmo slide.
    if (b.image_url) {
      const captionText = (headline || body) ? `<div class="banner-caption-text">${headline}${body}</div>` : '';
      const captionBand = (captionText || cta) ? `
        <div class="banner-caption-band">
          ${captionText}
          ${cta}
        </div>` : '';
      return `<div class="banner-slide tint-${tint} ${i===0?'active':''}" data-tone="image-clean">
        <div class="${bgClass}"${bgStyle}></div>
        ${captionBand}
      </div>`;
    }

    if (tone === 'editorial') {
      const word = b.headline || siteName;
      return `<div class="banner-slide tint-${tint} ${i===0?'active':''}" data-tone="editorial">
        <div class="${bgClass}"${bgStyle}></div>
        <div class="banner-slide-content">
          <div class="banner-editorial-word">${word}</div>
          <div class="banner-text">${kicker}${body}${cta}</div>
        </div>
      </div>`;
    }
    if (tone === 'centered') {
      return `<div class="banner-slide tint-${tint} ${i===0?'active':''}" data-tone="centered">
        <div class="${bgClass}"${bgStyle}></div>
        <div class="banner-slide-content">
          <div class="banner-text">${kicker}${headline}${body}${cta}</div>
        </div>
      </div>`;
    }
    return `<div class="banner-slide tint-${tint} ${i===0?'active':''}" data-tone="split">
      <div class="${bgClass}"${bgStyle}></div>
      <div class="banner-slide-content">
        <div class="banner-text">${kicker}${headline}${body}${cta}</div>
        <div class="banner-art">
          <svg viewBox="0 0 200 200" class="banner-art-shape" preserveAspectRatio="xMidYMid meet">
            <defs>
              <linearGradient id="bg${i}" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="var(--sf-brand)" stop-opacity="0.35"/>
                <stop offset="1" stop-color="var(--sf-accent)" stop-opacity="0.2"/>
              </linearGradient>
            </defs>
            <circle cx="100" cy="100" r="80" fill="url(#bg${i})"/>
            <circle cx="100" cy="100" r="40" fill="none" stroke="var(--sf-brand)" stroke-opacity="0.3" stroke-width="0.5"/>
          </svg>
        </div>
      </div>
    </div>`;
  }).join('\n');

  const dotsHtml = banners.length > 1
    ? `<div class="banner-dots" id="bannerDots">
        ${banners.map((_, i) => `<button class="banner-dot ${i===0?'active':''}" data-idx="${i}" onclick="goBanner(${i})"></button>`).join('')}
      </div>`
    : '';

  const bannerStage = hasBanners ? `
<section class="banner-stage" id="bannerStage">
  <div class="banner-frame">
    ${slidesHtml}
    ${dotsHtml}
  </div>
</section>` : '';

  const heroLegacy = hasBanners ? '' : `
<section class="${heroSectionClass}">
  <div class="hero-cover"${coverStyle}></div>
  <div class="hero-card">
    <div class="hero-card-logo">${logoInHero}</div>
    <div class="hero-card-info">
      <h1 class="hero-card-name">${siteName}</h1>
      ${tagline ? `<p class="hero-card-tag">${tagline}</p>` : ''}
      <div class="hero-card-pills" id="heroPills"></div>
    </div>
  </div>
</section>`;

  const announcementHtml = announcementBar
    ? `<div class="announcement-bar">${announcementBar}</div>`
    : '';

  // Service strip dinâmica — só renderiza se houver ao menos 1 card habilitado
  const serviceStrip = serviceCards.length > 0 ? `
<section class="service-strip">
${serviceCards.map((c) => `  <div class="service-card">
    <div class="service-card-icon">${svgFor(c.icon)}</div>
    <div>
      <div class="service-card-title">${escHtml(c.title)}</div>
      ${c.body ? `<div class="service-card-body">${escHtml(c.body)}</div>` : ''}
    </div>
  </div>`).join('\n')}
</section>` : '';

  // Topbar — search agora é inline (Fase 3 PR A). Botão lupa expande input
  // sobre .topbar-brand quando .topbar ganha classe .searching.
  return `${announcementHtml}
<header class="topbar" id="topbar">
  <a class="topbar-brand" href="#" onclick="return false">
    <div class="topbar-logo">${logoInTopbar}</div>
    <span class="topbar-name">${siteName}</span>
  </a>
  <div class="topbar-search-inline" id="topbarSearchInline">
    <svg class="topbar-search-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" placeholder="Buscar produtos..." id="searchInput" oninput="filterProducts()" onblur="searchBlur()" autocomplete="off">
    <button class="topbar-search-close" type="button" onclick="toggleSearch()" aria-label="Fechar busca">×</button>
  </div>
  <div class="topbar-right">
    <button class="search-btn" type="button" onclick="toggleSearch()" aria-label="Buscar produtos">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    </button>
    <div class="cart-btn" onclick="openCart()">
      <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M5 7h14l-1 13H6L5 7z"/><path d="M9 7V5a3 3 0 016 0v2"/></svg>
      <div class="cart-badge" id="cartBadge">0</div>
    </div>
  </div>
</header>

${bannerStage}
${heroLegacy}

<div class="cats-wrap" id="catsWrap"></div>

<section class="products-section" id="productsAnchor">
  <div class="products-header">
    <h2 id="catTitle">Todos os produtos</h2>
    <span class="products-count" id="prodCount"></span>
  </div>
  <div class="products-grid" id="productsGrid"></div>
</section>

${serviceStrip}

${contactBar}

<footer class="site-footer">
  <div class="site-footer-inner">
    <div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:18px;margin-bottom:24px;">
      <div>
        <div style="font-family:inherit;font-size:22px;color:var(--sf-ink);margin-bottom:6px;" class="serif">${siteName}</div>
        ${addrText ? `<div style="font-size:13px;color:var(--sf-ink-2);max-width:380px;">${addrText}</div>` : ''}
      </div>
      <div class="powered">
        <span style="font-size:11px;color:var(--sf-ink-3);">Loja desenvolvida com</span>
        <span class="brand">Aura<span class="brand-dot">.</span></span>
      </div>
    </div>
    <div class="site-footer-bottom">
      <span>© ${new Date().getFullYear()} ${siteName}</span>
      <a href="https://getaura.com.br" target="_blank" style="color:inherit;text-decoration:none;">Quero uma loja como essa</a>
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
    <button class="checkout-btn" onclick="openCheckout()">Finalizar compra →</button>
  </div>
</div>

<div class="checkout-overlay" id="checkoutOverlay">
  <div class="checkout-sheet">
    <div class="checkout-head">
      <div class="checkout-back" onclick="checkoutBack()">←</div>
      <div class="checkout-head-info">
        <div class="checkout-title" id="checkoutTitle">Seus dados</div>
        <div class="checkout-subtitle" id="checkoutSub">Etapa 1 de 3</div>
      </div>
      <div class="cart-close" onclick="closeCheckout()">×</div>
    </div>
    <div class="steps-bar">
      <div class="step"><div class="step-dot active" id="dot1">1</div><div class="step-label active" id="lbl1">Dados</div></div>
      <div style="flex:0 0 36px;height:1px;background:var(--sf-border-2);"></div>
      <div class="step"><div class="step-dot" id="dot2">2</div><div class="step-label" id="lbl2">Entrega</div></div>
      <div style="flex:0 0 36px;height:1px;background:var(--sf-border-2);"></div>
      <div class="step"><div class="step-dot" id="dot3">3</div><div class="step-label" id="lbl3">Pagamento</div></div>
    </div>
    <div class="checkout-body" id="checkoutBody"></div>
    <div class="checkout-foot"><button class="next-btn" id="nextBtn" onclick="checkoutNext()">Continuar</button></div>
  </div>
</div>

<div class="toast" id="toast"></div>`;
}
module.exports = buildHtmlBody;
