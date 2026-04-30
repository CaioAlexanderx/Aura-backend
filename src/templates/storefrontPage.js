// ============================================================
// AURA. — Template da vitrine pública (SPA embutido)
// Exporta: buildStorefrontPage(data, slug) → string HTML
// ============================================================
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escJs(s)   { return String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/[\n\r]/g,' '); }

function buildStorefrontPage(data, slug) {
  const primary  = data.site.primary_color || '#7c3aed';
  const siteName = escHtml(data.site.name);
  const tagline  = escHtml(data.site.tagline || data.site.description || '');
  const logoUrl  = data.site.logo_url  ? escHtml(data.site.logo_url)  : '';
  const coverUrl = data.site.cover_url ? escHtml(data.site.cover_url) : '';
  const whatsNum = (data.contact.whatsapp || '').replace(/\D/g, '');
  const addrText = escHtml(data.contact.address || '');

  const heroStyle = coverUrl
    ? `background:url('${coverUrl}') center/cover no-repeat; background-color:${primary};`
    : `background:linear-gradient(135deg,${primary} 0%,${primary}cc 100%);`;

  const storeData = JSON.stringify({
    slug,
    site:     data.site,
    contact:  data.contact,
    settings: data.settings,
    products: data.products,
  });

  const logoInTopbar = logoUrl
    ? `<img src="${logoUrl}" alt="" onerror="this.style.display='none';var s=document.getElementById('logoInitial');if(s){s.style.display='flex';}"><span id="logoInitial" style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#fff;"></span>`
    : `<span id="logoInitial" style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#fff;"></span>`;
  const logoInHero = logoUrl
    ? `<img src="${logoUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:16px;" onerror="this.style.display='none';var s=document.getElementById('heroInitial');if(s){s.style.display='flex';}"><span id="heroInitial" style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#fff;"></span>`
    : `<span id="heroInitial" style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#fff;"></span>`;

  const contactBar = whatsNum ? `
<div class="contact-bar">
  <p>Dúvidas? Fale conosco!</p>
  <a class="whatsapp-cta" href="https://wa.me/${whatsNum}" target="_blank">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.122 1.533 5.85L0 24l6.335-1.524A11.94 11.94 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.852 0-3.587-.5-5.088-1.375l-.362-.215-3.762.905.947-3.674-.237-.376A9.969 9.969 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
    Chamar no WhatsApp
  </a>
</div>` : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${siteName}</title>
<meta name="description" content="${tagline}">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
:root{--primary:${primary};--primary-dark:${primary};--primary-light:rgba(124,58,237,.1);--primary-mid:rgba(124,58,237,.07);--text:#1a1a2e;--text-2:#4a4a6a;--text-3:#888;--bg:#fafafa;--card-bg:#fff;--border:#e8e8f0;--green:#10b981;--green-light:#d1fae5;--shadow-md:0 4px 20px rgba(0,0,0,.10);--shadow-lg:0 12px 40px rgba(0,0,0,.16);--r:14px;--r-sm:10px;}
html{scroll-behavior:smooth;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden;}
.topbar{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:0 20px;height:60px;display:flex;align-items:center;justify-content:space-between;gap:12px;}
.topbar-brand{display:flex;align-items:center;gap:10px;text-decoration:none;}
.topbar-logo{width:36px;height:36px;border-radius:10px;background:var(--primary);display:flex;align-items:center;justify-content:center;font-size:15px;color:#fff;font-weight:800;flex-shrink:0;overflow:hidden;}
.topbar-logo img{width:100%;height:100%;object-fit:cover;}
.topbar-name{font-size:16px;font-weight:800;color:var(--text);}
.topbar-right{display:flex;align-items:center;gap:10px;}
.search-pill{display:flex;align-items:center;gap:8px;background:var(--bg);border:1.5px solid var(--border);border-radius:24px;padding:7px 14px;font-size:13px;color:var(--text-3);cursor:pointer;transition:border-color .2s;min-width:130px;}
.search-pill:hover{border-color:var(--primary);}
.cart-btn{position:relative;width:42px;height:42px;border-radius:12px;background:var(--primary-mid);border:1.5px solid transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s;color:var(--primary);}
.cart-btn:hover{background:var(--primary-light);border-color:var(--primary);}
.cart-badge{position:absolute;top:-4px;right:-4px;background:var(--primary);color:#fff;width:18px;height:18px;border-radius:50%;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center;border:2px solid #fff;}
.cart-badge.visible{display:flex;}
.hero{position:relative;${heroStyle}color:#fff;padding:48px 20px 40px;text-align:center;overflow:hidden;}
.hero-overlay{position:absolute;inset:0;${coverUrl?'background:linear-gradient(135deg,rgba(0,0,0,.35),rgba(0,0,0,.45));':'background:linear-gradient(135deg,rgba(0,0,0,.08),rgba(0,0,0,.18));'}pointer-events:none;}
.hero-content{position:relative;z-index:1;max-width:520px;margin:0 auto;}
.hero-logo-wrap{width:72px;height:72px;border-radius:18px;background:rgba(255,255,255,.2);border:2px solid rgba(255,255,255,.35);margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:26px;overflow:hidden;backdrop-filter:blur(4px);}
.hero-logo-wrap img{width:100%;height:100%;object-fit:cover;border-radius:16px;}
.hero h1{font-size:28px;font-weight:800;margin-bottom:8px;line-height:1.2;}
.hero p{font-size:14px;opacity:.9;line-height:1.6;max-width:380px;margin:0 auto 20px;}
.hero-pills{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}
.hero-pill{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.28);border-radius:20px;padding:5px 14px;font-size:12px;font-weight:600;backdrop-filter:blur(4px);}
.cats-wrap{padding:12px 20px 0;display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;position:sticky;top:60px;z-index:50;background:var(--bg);border-bottom:1px solid var(--border);}
.cats-wrap::-webkit-scrollbar{display:none;}
.cat-chip{white-space:nowrap;padding:7px 16px;border-radius:20px;font-size:12px;font-weight:600;background:#fff;border:1.5px solid var(--border);color:var(--text-2);cursor:pointer;transition:all .18s;flex-shrink:0;margin-bottom:10px;}
.cat-chip:hover{border-color:var(--primary);color:var(--primary);}
.cat-chip.active{background:var(--primary);border-color:var(--primary);color:#fff;}
.search-bar-wrap{padding:10px 20px;display:none;position:sticky;top:60px;z-index:49;background:var(--bg);}
.search-bar-wrap.open{display:block;}
.search-bar{display:flex;align-items:center;gap:10px;background:#fff;border:1.5px solid var(--border);border-radius:12px;padding:10px 14px;}
.search-bar input{flex:1;border:none;outline:none;font-size:14px;color:var(--text);background:transparent;}
.products-section{padding:20px;max-width:960px;margin:0 auto;}
.products-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}
.products-header h2{font-size:16px;font-weight:700;}
.products-count{font-size:12px;color:var(--text-3);}
.products-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;}
.product-card{background:var(--card-bg);border-radius:var(--r);border:1.5px solid var(--border);overflow:hidden;transition:transform .2s,box-shadow .2s;cursor:pointer;display:flex;flex-direction:column;}
.product-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-md);border-color:var(--primary);}
.product-img{width:100%;aspect-ratio:1;background:var(--primary-light);position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;}
.product-img img{width:100%;height:100%;object-fit:cover;}
.product-body{padding:12px;flex:1;display:flex;flex-direction:column;}
.product-cat{font-size:10px;color:var(--primary);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
.product-name{font-size:13px;font-weight:700;color:var(--text);line-height:1.35;margin-bottom:4px;}
.product-desc{font-size:11px;color:var(--text-3);line-height:1.45;margin-bottom:10px;flex:1;}
.product-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;}
.product-price{font-size:16px;font-weight:800;color:var(--text);}
.add-btn{background:var(--primary);color:#fff;border:none;border-radius:var(--r-sm);width:34px;height:34px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .18s;flex-shrink:0;font-size:20px;line-height:1;}
.add-btn:hover{background:var(--primary-dark);transform:scale(1.08);}
.qty-ctrl{display:flex;align-items:center;gap:6px;background:var(--primary-light);border-radius:10px;padding:3px;}
.qty-btn{width:28px;height:28px;border-radius:8px;background:var(--primary);color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;}
.qty-num{font-size:13px;font-weight:700;color:var(--primary);min-width:18px;text-align:center;}
.cart-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .25s;}
.cart-overlay.open{opacity:1;pointer-events:all;}
.cart-drawer{position:fixed;top:0;right:0;bottom:0;z-index:201;width:100%;max-width:400px;background:#fff;transform:translateX(100%);transition:transform .3s cubic-bezier(.25,.46,.45,.94);display:flex;flex-direction:column;box-shadow:var(--shadow-lg);}
.cart-drawer.open{transform:translateX(0);}
.cart-header{padding:20px 20px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
.cart-title{font-size:17px;font-weight:800;}
.cart-close{width:36px;height:36px;border-radius:10px;background:var(--bg);border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text-2);font-size:18px;}
.cart-close:hover{background:var(--primary-light);border-color:var(--primary);color:var(--primary);}
.cart-items{flex:1;overflow-y:auto;padding:16px 20px;}
.cart-item{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--border);}
.cart-item:last-child{border-bottom:none;}
.cart-item-img{width:52px;height:52px;border-radius:10px;background:var(--primary-light);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;}
.cart-item-img img{width:100%;height:100%;object-fit:cover;}
.cart-item-info{flex:1;}
.cart-item-name{font-size:13px;font-weight:700;margin-bottom:2px;}
.cart-item-price{font-size:12px;color:var(--text-3);}
.cart-item-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;}
.cart-item-total{font-size:14px;font-weight:800;color:var(--primary);}
.cart-footer{padding:16px 20px 24px;border-top:1px solid var(--border);flex-shrink:0;}
.cart-summary-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--text-2);margin-bottom:8px;}
.cart-summary-row.total{font-size:17px;font-weight:800;color:var(--text);margin-bottom:14px;}
.checkout-btn{width:100%;padding:15px;background:var(--primary);color:#fff;border:none;border-radius:var(--r);font-size:15px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;}
.checkout-btn:hover{background:var(--primary-dark);}
.checkout-overlay{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.5);display:none;align-items:flex-end;justify-content:center;}
.checkout-overlay.open{display:flex;}
@media(min-width:600px){.checkout-overlay{align-items:center;}}
.checkout-sheet{width:100%;max-width:480px;max-height:90vh;background:#fff;border-radius:20px 20px 0 0;overflow:hidden;display:flex;flex-direction:column;animation:slideUp .3s ease;}
@media(min-width:600px){.checkout-sheet{border-radius:20px;}}
@keyframes slideUp{from{transform:translateY(40px);opacity:0;}to{transform:translateY(0);opacity:1;}}
.checkout-head{padding:20px 20px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0;}
.checkout-back{width:34px;height:34px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;color:var(--text-2);}
.checkout-head-info{flex:1;}
.checkout-title{font-size:17px;font-weight:800;}
.checkout-subtitle{font-size:12px;color:var(--text-3);margin-top:1px;}
.steps-bar{padding:14px 20px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border);flex-shrink:0;}
.step{display:flex;flex-direction:column;align-items:center;gap:4px;}
.step-dot{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:var(--border);color:var(--text-3);transition:all .2s;}
.step-dot.done{background:var(--green);color:#fff;}
.step-dot.active{background:var(--primary);color:#fff;box-shadow:0 0 0 4px var(--primary-light);}
.step-label{font-size:10px;font-weight:600;color:var(--text-3);}
.step-label.active{color:var(--primary);}
.checkout-body{flex:1;overflow-y:auto;padding:20px;}
.field-group{margin-bottom:16px;}
.field-label{font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:6px;display:block;}
.field-input{width:100%;padding:11px 14px;border:1.5px solid var(--border);border-radius:var(--r-sm);font-size:14px;color:var(--text);background:var(--bg);outline:none;transition:border-color .18s;}
.field-input:focus{border-color:var(--primary);background:#fff;}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.delivery-opts{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;}
.delivery-opt{display:flex;align-items:center;gap:12px;padding:14px;border-radius:var(--r);border:1.5px solid var(--border);background:#fff;cursor:pointer;transition:all .18s;}
.delivery-opt.active{border-color:var(--primary);background:var(--primary-light);}
.delivery-opt-radio{width:18px;height:18px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.delivery-opt.active .delivery-opt-radio{border-color:var(--primary);background:var(--primary);}
.delivery-opt.active .delivery-opt-radio::after{content:'';width:6px;height:6px;background:#fff;border-radius:50%;}
.delivery-opt-icon{font-size:22px;flex-shrink:0;}
.delivery-opt-info{flex:1;}
.delivery-opt-name{font-size:13px;font-weight:700;}
.delivery-opt-detail{font-size:11px;color:var(--text-3);margin-top:2px;}
.delivery-opt-price{font-size:13px;font-weight:700;color:var(--primary);flex-shrink:0;}
.pix-box{background:var(--bg);border:1.5px solid var(--border);border-radius:var(--r);padding:20px;text-align:center;}
.pix-qr{width:170px;height:170px;margin:0 auto 16px;background:#fff;border-radius:12px;border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;overflow:hidden;}
.pix-key-box{background:#fff;border:1.5px solid var(--border);border-radius:var(--r-sm);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;}
.pix-key{font-size:11px;font-weight:600;color:var(--text);font-family:monospace;word-break:break-all;text-align:left;}
.pix-copy{font-size:12px;font-weight:700;color:var(--primary);cursor:pointer;white-space:nowrap;flex-shrink:0;}
.pix-timer{display:inline-flex;align-items:center;gap:5px;background:var(--primary-light);color:var(--primary);font-size:12px;font-weight:700;padding:5px 12px;border-radius:20px;margin-top:12px;}
.order-summary{background:var(--bg);border:1.5px solid var(--border);border-radius:var(--r);padding:14px;margin-bottom:16px;}
.summary-row{display:flex;justify-content:space-between;font-size:12px;color:var(--text-2);margin-bottom:6px;}
.summary-row.total{font-size:15px;font-weight:800;color:var(--text);border-top:1px solid var(--border);padding-top:8px;margin-top:4px;}
.checkout-foot{padding:16px 20px 24px;border-top:1px solid var(--border);flex-shrink:0;}
.next-btn{width:100%;padding:15px;background:var(--primary);color:#fff;border:none;border-radius:var(--r);font-size:15px;font-weight:700;cursor:pointer;transition:background .18s;display:flex;align-items:center;justify-content:center;gap:8px;}
.next-btn:hover{background:var(--primary-dark);}
.next-btn:disabled{background:var(--border);color:var(--text-3);cursor:not-allowed;}
.next-btn.green{background:var(--green);}
.next-btn.green:hover{background:#059669;}
.confirm-screen{text-align:center;padding:40px 20px;}
.confirm-icon{width:72px;height:72px;border-radius:50%;background:var(--green-light);display:flex;align-items:center;justify-content:center;font-size:36px;margin:0 auto 20px;animation:popIn .4s ease;}
@keyframes popIn{from{transform:scale(.5);opacity:0;}to{transform:scale(1);opacity:1;}}
.confirm-title{font-size:22px;font-weight:800;margin-bottom:8px;}
.confirm-desc{font-size:13px;color:var(--text-2);line-height:1.6;max-width:300px;margin:0 auto 20px;}
.whats-btn{display:inline-flex;align-items:center;gap:8px;background:#25D366;color:#fff;padding:12px 24px;border-radius:var(--r);font-size:14px;font-weight:700;text-decoration:none;border:none;cursor:pointer;}
.contact-bar{background:#fff;border-top:1px solid var(--border);padding:20px;text-align:center;}
.contact-bar p{font-size:12px;color:var(--text-3);margin-bottom:12px;}
.whatsapp-cta{display:inline-flex;align-items:center;gap:8px;background:#25D366;color:#fff;padding:11px 22px;border-radius:var(--r);font-size:14px;font-weight:700;text-decoration:none;}
.site-footer{background:var(--text);color:rgba(255,255,255,.6);padding:28px 20px;text-align:center;font-size:12px;line-height:1.8;margin-top:40px;}
.site-footer strong{color:rgba(255,255,255,.8);}
.powered{margin-top:8px;font-size:11px;}
.powered a{color:var(--primary);font-weight:700;text-decoration:none;}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--text);color:#fff;padding:10px 20px;border-radius:24px;font-size:13px;font-weight:600;z-index:999;transition:transform .3s ease;pointer-events:none;white-space:nowrap;}
.toast.show{transform:translateX(-50%) translateY(0);}
@keyframes pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.2);}}
.pulse{animation:pulse .3s ease;}
@media(max-width:480px){.topbar-name{font-size:14px;}.search-pill span{display:none;}.hero h1{font-size:22px;}.products-grid{grid-template-columns:repeat(2,1fr);gap:10px;}}
</style>
</head>
<body>

<header class="topbar">
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

<div class="toast" id="toast"></div>

<script>
var __S = ${storeData};
var SLUG = '${escJs(slug)}';
var PRODUCTS = __S.products || [];
var SETTINGS = __S.settings || {};
var CONTACT  = __S.contact  || {};
var SITE     = __S.site     || {};
var PROD_MAP = {};
PRODUCTS.forEach(function(p){ PROD_MAP[p.id] = p; });

(function(){
  var p=SITE.primary_color||'#7c3aed';
  var r=parseInt(p.slice(1,3),16),g=parseInt(p.slice(3,5),16),b=parseInt(p.slice(5,7),16);
  function dim(x){return Math.max(0,Math.round(x*.82)).toString(16).padStart(2,'0');}
  var dk='#'+dim(r)+dim(g)+dim(b);
  var root=document.documentElement;
  root.style.setProperty('--primary',p);
  root.style.setProperty('--primary-dark',dk);
  root.style.setProperty('--primary-light','rgba('+r+','+g+','+b+',.1)');
  root.style.setProperty('--primary-mid','rgba('+r+','+g+','+b+',.07)');
  var li=document.getElementById('logoInitial'); if(li) li.textContent=(SITE.name||'L')[0].toUpperCase();
  var hi=document.getElementById('heroInitial'); if(hi) hi.textContent=(SITE.name||'L')[0].toUpperCase();
})();

(function(){
  var pills=[];
  if(CONTACT.address) pills.push('📍 '+CONTACT.address.split(',')[0]);
  if(SETTINGS.delivery_enabled) pills.push('🚚 Entrega disponível');
  if(SETTINGS.pickup_enabled!==false) pills.push('🏪 Retirada no local');
  var w=document.getElementById('heroPills');
  if(w) w.innerHTML=pills.map(function(p){return '<span class="hero-pill">'+p+'</span>';}).join('');
})();

var ALL_CATS=['Todos'];
PRODUCTS.forEach(function(p){if(p.category&&ALL_CATS.indexOf(p.category)===-1)ALL_CATS.push(p.category);});
(function(){
  var w=document.getElementById('catsWrap'); if(!w) return;
  w.innerHTML=ALL_CATS.map(function(c,i){return '<div class="cat-chip'+(i===0?' active':'')+'\" data-ci="'+i+'">'+esc(c)+'</div>';}).join('');
  w.querySelectorAll('.cat-chip').forEach(function(chip){
    chip.addEventListener('click',function(){filterCat(ALL_CATS[parseInt(chip.dataset.ci)],chip);});
  });
})();

var cart={},currentCat='Todos',searchTerm='';
var checkoutStep=1,selectedDelivery=SETTINGS.pickup_enabled!==false?'pickup':'delivery';
var customerData={},currentOrder=null,pollInterval=null,timerInterval=null;

function fmt(v){return 'R$ '+Number(v).toFixed(2).replace('.',',');}
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}

function renderProducts(){
  var grid=document.getElementById('productsGrid'); if(!grid) return;
  var filtered=PRODUCTS.filter(function(p){
    var mc=currentCat==='Todos'||p.category===currentCat;
    var ms=!searchTerm||(p.name||'').toLowerCase().indexOf(searchTerm.toLowerCase())>=0||(p.description||'').toLowerCase().indexOf(searchTerm.toLowerCase())>=0;
    return mc&&ms&&p.in_stock;
  });
  document.getElementById('prodCount').textContent=filtered.length+' produto'+(filtered.length!==1?'s':'');
  if(!filtered.length){
    grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:60px 0;color:var(--text-3);"><div style="font-size:40px;margin-bottom:12px;">🔍</div><div style="font-size:15px;font-weight:700;">Nenhum produto encontrado</div></div>';
    return;
  }
  grid.innerHTML=filtered.map(function(p){
    var qty=cart[p.id]?cart[p.id].qty:0;
    var imgH=p.image_url?'<img src="'+esc(p.image_url)+'" alt="" style="width:100%;height:100%;object-fit:cover;">'
      :'<div style="font-size:32px;font-weight:800;color:var(--primary);">'+esc((p.name||'?')[0].toUpperCase())+'</div>';
    var priceH=(SETTINGS.show_prices!==false&&p.price!=null)?'<div class="product-price">'+fmt(p.price)+'</div>':'';
    var actionH=qty>0
      ?'<div class="qty-ctrl"><button class="qty-btn" onclick="event.stopPropagation();changeQty(\\''+p.id+'\\',-1)">−</button><span class="qty-num">'+qty+'</span><button class="qty-btn" onclick="event.stopPropagation();changeQty(\\''+p.id+'\\',1)">+</button></div>'
      :'<button class="add-btn" onclick="event.stopPropagation();addToCart(\\''+p.id+'\\')">+</button>';
    return '<div class="product-card" onclick="showDetail(\\''+p.id+'\\')"><div class="product-img">'+imgH+'</div><div class="product-body">'
      +(p.category?'<div class="product-cat">'+esc(p.category)+'</div>':'')
      +'<div class="product-name">'+esc(p.name)+'</div>'
      +(p.description?'<div class="product-desc">'+esc((p.description||'').substring(0,80))+((p.description||'').length>80?'...':'')+'</div>':'')
      +'<div class="product-footer"><div>'+priceH+'</div>'+actionH+'</div></div></div>';
  }).join('');
}

function addToCart(id){
  var p=PROD_MAP[id]; if(!p) return;
  if(!cart[id]) cart[id]={id:p.id,name:p.name,price:p.price,image_url:p.image_url,qty:0};
  cart[id].qty++;
  updateCartUI();renderProducts();
  var b=document.getElementById('cartBadge');b.classList.add('pulse');setTimeout(function(){b.classList.remove('pulse');},300);
  showToast(esc(p.name)+' adicionado!');
}
function changeQty(id,d){if(!cart[id])return;cart[id].qty+=d;if(cart[id].qty<=0)delete cart[id];updateCartUI();renderProducts();}
function getCount(){return Object.values(cart).reduce(function(s,i){return s+i.qty;},0);}
function getSubtotal(){return Object.values(cart).reduce(function(s,i){return s+i.price*i.qty;},0);}
function getFee(){return selectedDelivery==='delivery'?parseFloat(SETTINGS.delivery_fee)||0:0;}

function updateCartUI(){
  var count=getCount(),sub=getSubtotal(),fee=getFee();
  var badge=document.getElementById('cartBadge');
  badge.textContent=count;badge.classList.toggle('visible',count>0);
  var items=document.getElementById('cartItems'),footer=document.getElementById('cartFooter');
  if(!count){
    items.innerHTML='<div style="text-align:center;padding:60px 20px;"><div style="font-size:52px;margin-bottom:12px;">🛒</div><div style="font-size:15px;font-weight:700;color:var(--text-2);">Carrinho vazio</div></div>';
    footer.style.display='none';return;
  }
  items.innerHTML=Object.values(cart).map(function(i){
    var img=i.image_url?'<img src="'+esc(i.image_url)+'" alt="">':'<span style="font-size:22px;">🛍️</span>';
    return '<div class="cart-item"><div class="cart-item-img">'+img+'</div>'
      +'<div class="cart-item-info"><div class="cart-item-name">'+esc(i.name)+'</div><div class="cart-item-price">'+fmt(i.price)+' × '+i.qty+'</div></div>'
      +'<div class="cart-item-right"><div class="cart-item-total">'+fmt(i.price*i.qty)+'</div>'
      +'<div class="qty-ctrl" style="background:var(--bg);"><button class="qty-btn" style="width:24px;height:24px;font-size:14px;" onclick="changeQty(\\''+i.id+'\\',-1)">−</button>'
      +'<span class="qty-num">'+i.qty+'</span>'
      +'<button class="qty-btn" style="width:24px;height:24px;font-size:14px;" onclick="changeQty(\\''+i.id+'\\',1)">+</button></div></div></div>';
  }).join('');
  document.getElementById('cartSubtotal').textContent=fmt(sub);
  document.getElementById('deliveryLabel').textContent=selectedDelivery==='delivery'?'Entrega':'Retirada';
  document.getElementById('deliveryVal').textContent=fee?fmt(fee):'Grátis';
  document.getElementById('cartTotal').textContent=fmt(sub+fee);
  footer.style.display='block';
}

function openCart(){document.getElementById('cartOverlay').classList.add('open');document.getElementById('cartDrawer').classList.add('open');document.body.style.overflow='hidden';}
function closeCart(){document.getElementById('cartOverlay').classList.remove('open');document.getElementById('cartDrawer').classList.remove('open');document.body.style.overflow='';}
function filterCat(cat,el){currentCat=cat;document.querySelectorAll('.cat-chip').forEach(function(c){c.classList.remove('active');});el.classList.add('active');document.getElementById('catTitle').textContent=cat==='Todos'?'Todos os produtos':cat;renderProducts();}
var searchOpen=false;
function toggleSearch(){searchOpen=!searchOpen;var bar=document.getElementById('searchBar');bar.classList.toggle('open',searchOpen);if(searchOpen)document.getElementById('searchInput').focus();else{document.getElementById('searchInput').value='';searchTerm='';renderProducts();}}
function filterProducts(){searchTerm=document.getElementById('searchInput').value;renderProducts();}

function openCheckout(){closeCart();checkoutStep=1;selectedDelivery=SETTINGS.pickup_enabled!==false?'pickup':'delivery';renderCheckoutStep();document.getElementById('checkoutOverlay').classList.add('open');document.body.style.overflow='hidden';}
function closeCheckout(){clearInterval(pollInterval);clearInterval(timerInterval);document.getElementById('checkoutOverlay').classList.remove('open');document.body.style.overflow='';}
function checkoutBack(){if(checkoutStep>1&&checkoutStep<3){checkoutStep--;renderCheckoutStep();}else closeCheckout();}

function checkoutNext(){
  if(checkoutStep===1){
    var name=document.getElementById('inp_name')?document.getElementById('inp_name').value.trim():'';
    var phone=document.getElementById('inp_phone')?document.getElementById('inp_phone').value.trim():'';
    var email=document.getElementById('inp_email')?document.getElementById('inp_email').value.trim():'';
    if(!name||!phone){showToast('Preencha nome e telefone');return;}
    customerData={name:name,phone:phone,email:email||null};checkoutStep=2;renderCheckoutStep();
  }else if(checkoutStep===2){
    if(selectedDelivery==='delivery'){
      var addr=document.getElementById('inp_addr')?document.getElementById('inp_addr').value.trim():'';
      if(!addr){showToast('Informe o endereço de entrega');return;}
      var bairro=document.getElementById('inp_bairro')?document.getElementById('inp_bairro').value.trim():'';
      customerData.delivery_address=addr+(bairro?', '+bairro:'');
    }
    submitOrder();
  }else if(checkoutStep===3){showToast('Aguardando confirmação do pagamento...');}
}

function renderCheckoutStep(){
  var titles=['Seus dados','Entrega','Pagamento'],subs=['Etapa 1 de 3','Etapa 2 de 3','Etapa 3 de 3'],s=checkoutStep;
  document.getElementById('checkoutTitle').textContent=titles[s-1];
  document.getElementById('checkoutSub').textContent=subs[s-1];
  [1,2,3].forEach(function(i){
    var dot=document.getElementById('dot'+i),lbl=document.getElementById('lbl'+i);
    dot.className='step-dot';lbl.className='step-label';
    if(i<s){dot.classList.add('done');dot.textContent='✓';}
    else if(i===s){dot.classList.add('active');dot.textContent=i;lbl.classList.add('active');}
    else dot.textContent=i;
  });
  var btn=document.getElementById('nextBtn');
  btn.disabled=false;btn.className='next-btn'+(s===3?' green':'');
  btn.textContent=s===1?'Continuar':s===2?'Ir para pagamento':'Já paguei ✓';
  var sub=getSubtotal(),fee=getFee(),body=document.getElementById('checkoutBody');
  if(s===1){
    body.innerHTML='<div class="order-summary">'
      +Object.values(cart).map(function(i){return '<div class="summary-row"><span>'+esc(i.name)+' ×'+i.qty+'</span><span>'+fmt(i.price*i.qty)+'</span></div>';}).join('')
      +'<div class="summary-row total"><span>Total estimado</span><span>'+fmt(sub)+'</span></div></div>'
      +'<div class="field-group"><label class="field-label">Nome completo *</label><input class="field-input" type="text" id="inp_name" placeholder="Maria da Silva" value="'+(customerData.name||'')+'"></div>'
      +'<div class="field-row"><div class="field-group"><label class="field-label">WhatsApp *</label><input class="field-input" type="tel" id="inp_phone" placeholder="(12) 99999-0000" value="'+(customerData.phone||'')+'"></div>'
      +'<div class="field-group"><label class="field-label">E-mail</label><input class="field-input" type="email" id="inp_email" placeholder="opcional" value="'+(customerData.email||'')+'"></div></div>';
  }else if(s===2){
    var pickupOk=SETTINGS.pickup_enabled!==false,deliveryOk=SETTINGS.delivery_enabled===true,fee2=parseFloat(SETTINGS.delivery_fee)||0;
    var addrHtml=selectedDelivery==='delivery'
      ?'<div class="field-group"><label class="field-label">Endereço *</label><input class="field-input" type="text" id="inp_addr" placeholder="Rua, número, complemento"></div>'
       +'<div class="field-group"><label class="field-label">Bairro</label><input class="field-input" type="text" id="inp_bairro" placeholder="Bairro"></div>'
      :'';
    body.innerHTML='<p style="font-size:12px;color:var(--text-3);margin-bottom:16px;">Como deseja receber?</p>'
      +'<div class="delivery-opts">'
      +(pickupOk?'<div class="delivery-opt'+(selectedDelivery==="pickup"?" active":"")+'\" id="opt_pickup"><div class="delivery-opt-radio"></div><div class="delivery-opt-icon">🏪</div><div class="delivery-opt-info"><div class="delivery-opt-name">Retirada no local</div><div class="delivery-opt-detail">'+(CONTACT.address||'Na loja')+'</div></div><div class="delivery-opt-price">Grátis</div></div>':'')
      +(deliveryOk?'<div class="delivery-opt'+(selectedDelivery==="delivery"?" active":"")+'\" id="opt_delivery"><div class="delivery-opt-radio"></div><div class="delivery-opt-icon">🚚</div><div class="delivery-opt-info"><div class="delivery-opt-name">Entrega a domicílio</div><div class="delivery-opt-detail">Conforme disponibilidade</div></div><div class="delivery-opt-price">'+(fee2?fmt(fee2):'Grátis')+'</div></div>':'')
      +'</div>'+addrHtml
      +'<div class="order-summary"><div class="summary-row"><span>Subtotal</span><span>'+fmt(sub)+'</span></div>'
      +'<div class="summary-row"><span>Entrega</span><span>'+(fee?fmt(fee):'Grátis')+'</span></div>'
      +'<div class="summary-row total"><span>Total</span><span>'+fmt(sub+fee)+'</span></div></div>';
    var op=document.getElementById('opt_pickup'),od=document.getElementById('opt_delivery');
    if(op) op.addEventListener('click',function(){selectDelivery('pickup');});
    if(od) od.addEventListener('click',function(){selectDelivery('delivery');});
  }else if(s===3&&currentOrder){
    var pix=currentOrder.pix,total=currentOrder.total;
    var qrH=pix&&pix.qrcode?'<img src="data:image/png;base64,'+pix.qrcode+'" style="width:160px;height:160px;border-radius:8px;" alt="QR Pix">':'<div style="font-size:12px;color:var(--text-3);padding:20px;line-height:1.6;">Escaneie pelo app do banco<br>ou use o código abaixo</div>';
    var payload=pix&&pix.payload?pix.payload:'Indisponível';
    body.innerHTML='<div class="pix-box">'
      +'<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:16px;"><span style="background:#32BCAD;border-radius:8px;padding:4px 12px;color:#fff;font-size:12px;font-weight:800;letter-spacing:.5px;">PIX</span><span style="font-size:12px;color:var(--text-3);">Pedido #'+esc(currentOrder.order_number)+'</span></div>'
      +'<div class="pix-qr">'+qrH+'</div>'
      +'<div style="font-size:26px;font-weight:800;color:var(--text);margin-bottom:4px;">'+fmt(total)+'</div>'
      +'<div style="font-size:11px;color:var(--text-3);margin-bottom:14px;">Copie o código e pague no app do banco</div>'
      +'<div class="pix-key-box"><span class="pix-key" id="pixPayload">'+esc(payload)+'</span><span class="pix-copy" id="pixCopyBtn">Copiar código</span></div>'
      +'<div style="font-size:12px;color:var(--text-3);line-height:1.6;">App do banco → Pix → Pagar com código</div>'
      +'<div class="pix-timer">⏱ Expira em <span id="timer">15:00</span></div></div>'
      +'<div style="margin-top:14px;background:var(--green-light);border-radius:var(--r);padding:14px;font-size:12px;color:#065f46;display:flex;gap:10px;"><span style="flex-shrink:0;">✅</span><div><strong>Confirmação automática</strong><br>Após o pagamento, você recebe notificação e o pedido entra em preparo.</div></div>';
    document.getElementById('pixCopyBtn').addEventListener('click',copyPix);
    startTimer(pix&&pix.expires_at?pix.expires_at:null);
    startPolling();
  }
}

function selectDelivery(type){
  selectedDelivery=type;
  var op=document.getElementById('opt_pickup'),od=document.getElementById('opt_delivery');
  if(op) op.classList.toggle('active',type==='pickup');
  if(od) od.classList.toggle('active',type==='delivery');
  var fee=getFee(),sub=getSubtotal();
  updateCartUI();
  document.querySelectorAll('.summary-row').forEach(function(r){
    var spans=r.querySelectorAll('span');
    if(spans[0]&&spans[0].textContent==='Entrega') spans[1].textContent=fee?fmt(fee):'Grátis';
    if(r.classList.contains('total')&&spans[0]&&spans[0].textContent==='Total') spans[1].textContent=fmt(sub+fee);
  });
  var hasAddr=!!document.getElementById('inp_addr');
  if(type==='delivery'&&!hasAddr){
    var opts=document.querySelector('.delivery-opts');
    if(opts) opts.insertAdjacentHTML('afterend','<div class="field-group"><label class="field-label">Endereço *</label><input class="field-input" type="text" id="inp_addr" placeholder="Rua, número, complemento"></div><div class="field-group"><label class="field-label">Bairro</label><input class="field-input" type="text" id="inp_bairro" placeholder="Bairro"></div>');
  }else if(type==='pickup'&&hasAddr){
    ['inp_addr','inp_bairro'].forEach(function(id){var el=document.getElementById(id);if(el&&el.parentElement)el.parentElement.remove();});
  }
}

function submitOrder(){
  var btn=document.getElementById('nextBtn');
  btn.disabled=true;btn.textContent='Criando pedido...';
  var items=Object.values(cart).map(function(i){return{product_id:i.id,quantity:i.qty};});
  var body={customer_name:customerData.name,customer_phone:customerData.phone,customer_email:customerData.email||null,delivery_type:selectedDelivery,delivery_address:customerData.delivery_address||null,items:items};
  fetch('/storefront/'+SLUG+'/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
  .then(function(res){
    if(!res.ok){showToast(res.data.error||'Erro ao criar pedido');btn.disabled=false;btn.textContent='Ir para pagamento';return;}
    currentOrder=res.data;checkoutStep=3;renderCheckoutStep();
  })
  .catch(function(){showToast('Erro de conexão. Tente novamente.');btn.disabled=false;btn.textContent='Ir para pagamento';});
}

function copyPix(){
  var el=document.getElementById('pixPayload');if(!el)return;
  if(navigator.clipboard)navigator.clipboard.writeText(el.textContent).catch(function(){});
  var btn=document.getElementById('pixCopyBtn');
  if(btn){btn.textContent='✓ Copiado!';btn.style.color='var(--green)';setTimeout(function(){btn.textContent='Copiar código';btn.style.color='';},2000);}
  showToast('Código Pix copiado!');
}

function startTimer(expiresAt){
  clearInterval(timerInterval);
  var secs=expiresAt?Math.max(0,Math.round((new Date(expiresAt)-Date.now())/1000)):15*60;
  timerInterval=setInterval(function(){
    var m=Math.floor(secs/60),s=secs%60;
    var el=document.getElementById('timer');if(el)el.textContent=m+':'+String(s).padStart(2,'0');
    if(--secs<0)clearInterval(timerInterval);
  },1000);
}

function startPolling(){
  clearInterval(pollInterval);if(!currentOrder)return;
  pollInterval=setInterval(function(){
    fetch('/storefront/'+SLUG+'/order/'+currentOrder.order_id)
    .then(function(r){return r.json();})
    .then(function(o){
      if(o.payment_status==='paid'||['confirmed','preparing','ready','delivered'].indexOf(o.status)>=0){
        clearInterval(pollInterval);clearInterval(timerInterval);showConfirmation(o);
      }
    }).catch(function(){});
  },3000);
}

function showConfirmation(order){
  clearInterval(pollInterval);clearInterval(timerInterval);
  closeCheckout();cart={};updateCartUI();renderProducts();
  var wnum=(CONTACT.whatsapp||'').replace(/\D/g,'');
  var wBtn=wnum?'<a class="whats-btn" href="https://wa.me/'+wnum+'" target="_blank">💬 Acompanhar no WhatsApp</a>':'';
  var ov=document.createElement('div');
  ov.className='checkout-overlay open';
  ov.innerHTML='<div class="checkout-sheet"><div class="checkout-head"><div class="checkout-head-info" style="margin-left:46px;"><div class="checkout-title">Pedido confirmado!</div></div><div class="cart-close" onclick="this.closest(\\'checkout-overlay\\').remove();document.body.style.overflow=\\'\\';"> ×</div></div><div class="checkout-body"><div class="confirm-screen"><div class="confirm-icon">✅</div><div class="confirm-title">Pagamento recebido!</div><div class="confirm-desc">Pedido <strong>#'+esc(order.order_number||'')+'</strong> confirmado. Em breve você recebe atualizações.</div>'+wBtn+'</div></div></div>';
  document.body.appendChild(ov);
  document.body.style.overflow='hidden';
}

function showDetail(id){
  var p=PROD_MAP[id];if(!p)return;
  var qty=cart[id]?cart[id].qty:0;
  var imgH=p.image_url?'<img src="'+esc(p.image_url)+'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:var(--r);">'
    :'<div style="font-size:64px;font-weight:800;color:var(--primary);">'+esc((p.name||'?')[0].toUpperCase())+'</div>';
  var ov=document.createElement('div');ov.className='checkout-overlay open';
  ov.innerHTML='<div class="checkout-sheet" style="max-width:420px;"><div class="checkout-head"><div class="checkout-back" id="dClose">←</div><div class="checkout-head-info"><div class="checkout-title">'+esc(p.name)+'</div><div class="checkout-subtitle">'+(p.category||'Produto')+'</div></div><div class="cart-close" id="dCloseX">×</div></div><div class="checkout-body"><div style="width:100%;aspect-ratio:1;background:var(--primary-light);border-radius:var(--r);display:flex;align-items:center;justify-content:center;overflow:hidden;margin-bottom:20px;">'+imgH+'</div>'+(p.price!=null&&SETTINGS.show_prices!==false?'<div style="font-size:24px;font-weight:800;color:var(--primary);margin-bottom:8px;">'+fmt(p.price)+'</div>':'')+(p.description?'<p style="font-size:13px;color:var(--text-2);line-height:1.6;">'+esc(p.description)+'</p>':'')+'</div><div class="checkout-foot"><button class="next-btn'+(qty>0?' green':'')+'\" id="dAddBtn">'+(qty>0?'✓ No carrinho ('+qty+')':'+ Adicionar ao carrinho')+'</button></div></div>';
  document.body.appendChild(ov);document.body.style.overflow='hidden';
  function close(){ov.remove();document.body.style.overflow='';}
  ov.querySelector('#dClose').addEventListener('click',close);
  ov.querySelector('#dCloseX').addEventListener('click',close);
  ov.querySelector('#dAddBtn').addEventListener('click',function(){addToCart(id);this.textContent='✓ Adicionado';this.className='next-btn green';setTimeout(close,700);});
}

var toastT;
function showToast(msg){clearTimeout(toastT);var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');toastT=setTimeout(function(){t.classList.remove('show');},2400);}

updateCartUI();
renderProducts();
</script>
</body>
</html>`;
}

module.exports = buildStorefrontPage;
