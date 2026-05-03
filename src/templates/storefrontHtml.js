// AURA. — HTML body da vitrine pública
// buildHtmlBody({ siteName, tagline, logoInTopbar, logoInHero, contactBar, addrText }) → string HTML
function buildHtmlBody({ siteName, tagline, logoInTopbar, logoInHero, contactBar, addrText }) {
  return `<header class="topbar">
  <a class="topbar-brand" href="#" onclick="return false">
    <div class="topbar-logo">${logoInTopbar}</div>
    <span class="topbar-name">${siteName}</span>
  </a>
  <div class="topbar-right">
    <div class="search-pill" onclick="toggleSearch()">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <span>Buscar</span>
    </div>
    <div class="cart-btn" onclick="openCart()">
      <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
      <div class="cart-badge" id="cartBadge">0</div>
    </div>
  </div>
</header>

<div class="search-bar-wrap" id="searchBar">
  <div class="search-bar">
    <svg width="16" height="16" fill="none" stroke="#888" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" placeholder="Buscar produtos..." id="searchInput" oninput="filterProducts()" autocomplete="off">
    <span style="cursor:pointer;color:#888;font-size:22px;line-height:1;" onclick="toggleSearch()">×</span>
  </div>
</div>

<section class="hero">
  <div class="hero-overlay"></div>
  <div class="hero-content">
    <div class="hero-logo-wrap">${logoInHero}</div>
    <h1>${siteName}</h1>
    ${tagline ? `<p>${tagline}</p>` : ''}
    <div class="hero-pills" id="heroPills"></div>
  </div>
</section>

<div class="cats-wrap" id="catsWrap"></div>

<section class="products-section">
  <div class="products-header">
    <h2 id="catTitle">Todos os produtos</h2>
    <span class="products-count" id="prodCount"></span>
  </div>
  <div class="products-grid" id="productsGrid"></div>
</section>

${contactBar}

<footer class="site-footer">
  <div><strong>${siteName}</strong>${addrText ? `<br>${addrText}` : ''}</div>
  <div class="powered">Criado com <a href="https://getaura.com.br" target="_blank">Aura</a></div>
</footer>

<div class="cart-overlay" id="cartOverlay" onclick="closeCart()"></div>
<div class="cart-drawer" id="cartDrawer">
  <div class="cart-header"><span class="cart-title">Carrinho</span><div class="cart-close" onclick="closeCart()">×</div></div>
  <div class="cart-items" id="cartItems"></div>
  <div class="cart-footer" id="cartFooter" style="display:none">
    <div class="cart-summary-row"><span>Subtotal</span><span id="cartSubtotal">R$ 0,00</span></div>
    <div class="cart-summary-row"><span id="deliveryLabel">Entrega</span><span id="deliveryVal">—</span></div>
    <div class="cart-summary-row total"><span>Total</span><span id="cartTotal">R$ 0,00</span></div>
    <button class="checkout-btn" onclick="openCheckout()">Finalizar pedido →</button>
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
      <div style="flex:1;height:1px;background:var(--border);"></div>
      <div class="step"><div class="step-dot" id="dot2">2</div><div class="step-label" id="lbl2">Entrega</div></div>
      <div style="flex:1;height:1px;background:var(--border);"></div>
      <div class="step"><div class="step-dot" id="dot3">3</div><div class="step-label" id="lbl3">Pagamento</div></div>
    </div>
    <div class="checkout-body" id="checkoutBody"></div>
    <div class="checkout-foot"><button class="next-btn" id="nextBtn" onclick="checkoutNext()">Continuar</button></div>
  </div>
</div>

<div class="toast" id="toast"></div>`;
}
module.exports = buildHtmlBody;
