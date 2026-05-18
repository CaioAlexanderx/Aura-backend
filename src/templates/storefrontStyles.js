// AURA. — CSS da vitrine pública v2 (redesign editorial)
// buildStyles(primary, accent, dark, font) → string CSS
// Aceita assinatura legada buildStyles(primary) — accent cai em color-mix,
// dark=false, font='classic'.
//
// Design tokens via CSS vars (--sf-*) inspirados no mockup Aura. Mantém todas
// as classes que parts/cart.js, checkout.js, pix.js, products.js, product_detail.js
// referenciam — só redesenha visual. Adiciona classes novas para announcement
// bar, banner carousel, 3 card styles e dark mode.
//
// v3 (18/05/2026): adiciona data-tone="image-clean" — quando o slide tem
// image_url, imagem ocupa o topo full-bleed e headline+body+CTA aparecem
// em caption band branca abaixo, sem overlay competindo com a arte.
//
// v3.1 (18/05/2026 — Fase 3 PR A): search inline na topbar —
// .topbar-search-inline expande quando .topbar.searching, sobrepondo
// .topbar-brand. Remove .search-pill / .search-bar-wrap sticky antigos
// (conflitavam com .cats-wrap no mesmo top:64px).
function buildStyles(primary, accent, dark, font) {
  primary = primary || '#7c3aed';
  accent  = accent  || primary;
  font    = font    || 'classic';

  const fontSerif = font === 'modern'
    ? `'Fraunces','Instrument Serif',Georgia,serif`
    : font === 'humanist'
      ? `'DM Sans','Inter',sans-serif`
      : `'Instrument Serif','Cormorant Garamond',Georgia,serif`;
  const fontSans = `'DM Sans','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`;
  const fontMono = `'DM Mono','SF Mono','JetBrains Mono',monospace`;

  // Light theme tokens
  const light = `
  --sf-brand:${primary};
  --sf-brand-2:color-mix(in oklab,${primary} 90%,black);
  --sf-brand-ink:color-mix(in oklab,${primary} 70%,black);
  --sf-brand-wash:color-mix(in oklab,${primary} 8%,transparent);
  --sf-brand-wash-2:color-mix(in oklab,${primary} 4%,transparent);
  --sf-accent:${accent};
  --sf-accent-wash:color-mix(in oklab,${accent} 10%,transparent);
  --sf-bg:#fbf8f3;
  --sf-bg-2:#f4efe6;
  --sf-bg-3:#eee7d9;
  --sf-bg-card:#ffffff;
  --sf-ink:#1a1612;
  --sf-ink-2:rgba(26,22,18,0.70);
  --sf-ink-3:rgba(26,22,18,0.45);
  --sf-border:color-mix(in oklab,${primary} 12%,transparent);
  --sf-border-2:color-mix(in oklab,${primary} 22%,transparent);
  --sf-shadow:0 12px 32px -8px color-mix(in oklab,${primary} 22%,transparent);
  --sf-shadow-sm:0 4px 12px -2px color-mix(in oklab,${primary} 12%,transparent);
  --sf-ph-from:color-mix(in oklab,${primary} 22%,#f0e8d8);
  --sf-ph-to:color-mix(in oklab,${accent} 16%,#ece4d4);
  `;

  // Dark theme tokens
  const darkTokens = `
  --sf-brand:${primary};
  --sf-brand-2:color-mix(in oklab,${primary} 78%,white);
  --sf-brand-ink:color-mix(in oklab,${primary} 60%,white);
  --sf-brand-wash:color-mix(in oklab,${primary} 16%,transparent);
  --sf-brand-wash-2:color-mix(in oklab,${primary} 8%,transparent);
  --sf-accent:${accent};
  --sf-accent-wash:color-mix(in oklab,${accent} 14%,transparent);
  --sf-bg:#0c0a0a;
  --sf-bg-2:#15110f;
  --sf-bg-3:#1e1815;
  --sf-bg-card:#181412;
  --sf-ink:#f6f3ee;
  --sf-ink-2:rgba(246,243,238,0.72);
  --sf-ink-3:rgba(246,243,238,0.50);
  --sf-border:color-mix(in oklab,${primary} 22%,transparent);
  --sf-border-2:color-mix(in oklab,${primary} 38%,transparent);
  --sf-shadow:0 12px 32px -8px color-mix(in oklab,${primary} 30%,transparent);
  --sf-shadow-sm:0 4px 12px -2px color-mix(in oklab,${primary} 18%,transparent);
  --sf-ph-from:color-mix(in oklab,${primary} 30%,#2a201c);
  --sf-ph-to:color-mix(in oklab,${accent} 22%,#1a1411);
  `;

  return `
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
html{scroll-behavior:smooth;}
body{font-family:${fontSans};background:var(--sf-bg);color:var(--sf-ink);min-height:100vh;overflow-x:hidden;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;}
body:not(.sf-dark){${light}}
body.sf-dark{${darkTokens}}
body::selection{background:var(--sf-brand-wash);}

/* ============================================================
   Legacy compat vars (parts/checkout.js, pix.js etc reads these)
   ============================================================ */
body{
  --primary:var(--sf-brand);
  --primary-dark:var(--sf-brand-2);
  --primary-light:var(--sf-brand-wash);
  --primary-mid:var(--sf-brand-wash-2);
  --text:var(--sf-ink);
  --text-2:var(--sf-ink-2);
  --text-3:var(--sf-ink-3);
  --bg:var(--sf-bg);
  --card-bg:var(--sf-bg-card);
  --border:var(--sf-border);
  --green:#10b981;
  --green-light:color-mix(in oklab,#10b981 16%,transparent);
  --shadow-sm:var(--sf-shadow-sm);
  --shadow-md:var(--sf-shadow);
  --shadow-lg:0 24px 60px -12px color-mix(in oklab,var(--sf-brand) 30%,transparent);
  --r:14px;
  --r-sm:10px;
}

/* ============================================================
   Type helpers
   ============================================================ */
.sf-eyebrow{font-family:${fontSans};font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--sf-ink-3);}
h1,h2,h3,h4,.serif{font-family:${fontSerif};font-weight:400;letter-spacing:-0.4px;color:var(--sf-ink);}
.mono{font-family:${fontMono};font-variant-numeric:tabular-nums;}

/* ============================================================
   Announcement bar (top strip, desktop only)
   ============================================================ */
.announcement-bar{background:var(--sf-brand-wash-2);color:var(--sf-ink-2);font-size:12px;text-align:center;padding:8px 16px;border-bottom:1px solid var(--sf-border);}
@media(max-width:600px){.announcement-bar{display:none;}}

/* ============================================================
   TOPBAR / HEADER
   ============================================================ */
.topbar{position:sticky;top:0;z-index:100;background:color-mix(in oklab,var(--sf-bg) 92%,transparent);backdrop-filter:saturate(180%) blur(12px);-webkit-backdrop-filter:saturate(180%) blur(12px);border-bottom:1px solid var(--sf-border);padding:0 20px;height:64px;display:flex;align-items:center;justify-content:space-between;gap:12px;position:sticky;}
.topbar-brand{display:flex;align-items:center;gap:12px;text-decoration:none;flex:0 1 auto;min-width:0;transition:opacity .2s ease;}
.topbar-logo{width:40px;height:40px;border-radius:10px;background:var(--sf-brand);display:flex;align-items:center;justify-content:center;font-size:17px;color:#fff;font-weight:400;font-family:${fontSerif};flex-shrink:0;overflow:hidden;box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--sf-brand) 40%,transparent);}
.topbar-logo img{width:100%;height:100%;object-fit:cover;}
.topbar-name{font-size:18px;font-weight:400;font-family:${fontSerif};letter-spacing:-0.3px;color:var(--sf-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.topbar-right{display:flex;align-items:center;gap:10px;flex-shrink:0;transition:opacity .2s ease;}

/* Search button (icon-only, na .topbar-right) */
.search-btn{position:relative;width:42px;height:42px;border-radius:999px;background:transparent;border:1px solid var(--sf-border);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s;color:var(--sf-ink);padding:0;font-family:inherit;}
.search-btn:hover{background:var(--sf-brand-wash);border-color:var(--sf-border-2);}

/* Search inline — input expandido sobrepondo o nome da loja quando .searching */
.topbar-search-inline{position:absolute;left:20px;right:20px;top:11px;height:42px;display:none;align-items:center;gap:10px;background:var(--sf-bg-card);border:1px solid var(--sf-border-2);border-radius:999px;padding:0 14px 0 16px;opacity:0;transform:translateY(-4px);transition:opacity .2s ease, transform .2s ease;z-index:2;}
.topbar-search-inline .topbar-search-icon{flex-shrink:0;opacity:.55;color:var(--sf-ink);}
.topbar-search-inline input{flex:1;border:none;outline:none;font-size:14px;color:var(--sf-ink);background:transparent;font-family:${fontSans};height:100%;min-width:0;}
.topbar-search-inline input::placeholder{color:var(--sf-ink-3);}
.topbar-search-close{flex-shrink:0;width:26px;height:26px;border-radius:999px;border:none;background:transparent;color:var(--sf-ink-2);font-size:20px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;font-family:inherit;}
.topbar-search-close:hover{background:var(--sf-brand-wash);color:var(--sf-ink);}

.topbar.searching .topbar-search-inline{display:flex;opacity:1;transform:translateY(0);}
.topbar.searching .topbar-brand,
.topbar.searching .topbar-right{opacity:0;pointer-events:none;}

.cart-btn{position:relative;width:42px;height:42px;border-radius:999px;background:transparent;border:1px solid var(--sf-border);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s;color:var(--sf-ink);}
.cart-btn:hover{background:var(--sf-brand-wash);border-color:var(--sf-border-2);}
.cart-badge{position:absolute;top:-2px;right:-2px;background:var(--sf-accent);color:#fff;width:18px;height:18px;border-radius:50%;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center;border:2px solid var(--sf-bg);font-family:${fontMono};}
.cart-badge.visible{display:flex;}

/* ============================================================
   BANNER STAGE (carrossel da home)
   ============================================================ */
.banner-stage{position:relative;width:100%;max-width:1280px;margin:20px auto;padding:0 20px;}
.banner-frame{position:relative;width:100%;height:460px;overflow:hidden;border-radius:18px;}
@media(max-width:600px){
  .banner-stage{margin:12px auto;padding:0 12px;}
  .banner-frame{height:320px;border-radius:14px;}
}
.banner-slide{position:absolute;inset:0;opacity:0;transition:opacity .9s cubic-bezier(.4,0,.2,1);pointer-events:none;}
.banner-slide.active{opacity:1;pointer-events:auto;}
.banner-slide.tint-brand{background:var(--sf-brand-wash);}
.banner-slide.tint-accent{background:var(--sf-accent-wash);}
.banner-slide-bg{position:absolute;inset:0;background-position:center;background-size:cover;background-repeat:no-repeat;}
.banner-slide-bg.with-image::after{content:'';position:absolute;inset:0;background:linear-gradient(120deg, color-mix(in oklab,var(--sf-bg) 70%,transparent) 0%, color-mix(in oklab,var(--sf-bg) 10%,transparent) 60%);}
.banner-slide-content{position:relative;z-index:2;width:100%;height:100%;display:flex;}
/* split */
.banner-slide[data-tone="split"] .banner-slide-content{flex-direction:row;}
.banner-slide[data-tone="split"] .banner-text{flex:1 1 60%;padding:40px clamp(20px,4%,56px);display:flex;flex-direction:column;justify-content:center;}
.banner-slide[data-tone="split"] .banner-art{flex:1 1 40%;position:relative;min-width:80px;}
@media(max-width:600px){
  .banner-slide[data-tone="split"] .banner-slide-content{flex-direction:column;justify-content:flex-end;}
  .banner-slide[data-tone="split"] .banner-text{padding:24px 22px 56px;}
  .banner-slide[data-tone="split"] .banner-art{display:none;}
}
/* centered */
.banner-slide[data-tone="centered"] .banner-slide-content{flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;}
.banner-slide[data-tone="centered"] .banner-text{max-width:520px;}
/* editorial */
.banner-slide[data-tone="editorial"] .banner-slide-content{padding:0;}
.banner-slide[data-tone="editorial"] .banner-editorial-word{position:absolute;left:4%;top:50%;transform:translateY(-50%);font-family:${fontSerif};font-size:clamp(72px,16vw,220px);line-height:0.9;color:var(--sf-ink);letter-spacing:-4px;font-style:italic;opacity:0.95;pointer-events:none;}
.banner-slide[data-tone="editorial"] .banner-text{position:absolute;right:32px;bottom:56px;max-width:280px;text-align:right;}
@media(max-width:600px){
  .banner-slide[data-tone="editorial"] .banner-editorial-word{display:none;}
  .banner-slide[data-tone="editorial"] .banner-text{position:relative;right:auto;bottom:auto;max-width:none;text-align:left;padding:24px 22px;}
  .banner-slide[data-tone="editorial"] .banner-slide-content{flex-direction:column;justify-content:flex-end;}
}
.banner-kicker{font-family:${fontSans};font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--sf-brand-ink);margin-bottom:14px;}
.banner-headline{font-family:${fontSerif};font-size:clamp(28px,5vw,56px);line-height:1.02;margin:0 0 14px;color:var(--sf-ink);letter-spacing:-0.8px;font-weight:400;max-width:480px;text-wrap:balance;}
.banner-body{font-size:15px;color:var(--sf-ink-2);max-width:380px;margin:0 0 22px;line-height:1.5;text-wrap:pretty;}
@media(max-width:600px){.banner-headline{font-size:32px;}.banner-body{font-size:13px;}}
.banner-cta{display:inline-flex;align-items:center;gap:8px;padding:12px 22px;border-radius:999px;background:var(--sf-brand);color:#fff;border:1px solid var(--sf-brand);font-family:${fontSans};font-weight:600;font-size:14px;cursor:pointer;letter-spacing:0.2px;transition:transform .15s ease;}
.banner-cta:hover{transform:translateY(-1px);}
.banner-art-shape{position:absolute;right:-30px;top:-10px;width:60%;height:120%;opacity:0.9;}
.banner-dots{position:absolute;left:0;right:0;bottom:16px;display:flex;justify-content:center;gap:8px;z-index:3;}
.banner-dot{width:8px;height:8px;border-radius:4px;border:none;cursor:pointer;background:color-mix(in oklab,var(--sf-ink) 30%,transparent);transition:all .4s cubic-bezier(.4,0,.2,1);padding:0;}
.banner-dot.active{width:28px;background:var(--sf-ink);}

/* ============================================================
   Image-clean banner — v3 (18/05/2026)
   Quando o slide tem image_url, imagem fica full-bleed no topo do
   slide e headline+body+CTA aparecem em caption band branca abaixo.
   Sem overlay, sem scrim, sem SVG decorativo competindo.
   ============================================================ */
.banner-slide[data-tone="image-clean"]{display:flex;flex-direction:column;background:var(--sf-bg-card);}
.banner-slide[data-tone="image-clean"] .banner-slide-bg{position:relative;inset:auto;flex:1 1 auto;min-height:0;}
.banner-slide[data-tone="image-clean"] .banner-slide-bg.with-image::after{display:none;}
.banner-slide[data-tone="image-clean"] .banner-caption-band{flex:0 0 auto;padding:18px clamp(20px,3%,32px);display:flex;align-items:center;justify-content:space-between;gap:20px;background:var(--sf-bg-card);border-top:1px solid var(--sf-border);}
.banner-slide[data-tone="image-clean"] .banner-caption-text{flex:1;min-width:0;}
.banner-slide[data-tone="image-clean"] .banner-caption-text .banner-headline{font-size:clamp(20px,2.4vw,26px);margin:0 0 4px;line-height:1.18;max-width:none;letter-spacing:-0.3px;}
.banner-slide[data-tone="image-clean"] .banner-caption-text .banner-body{font-size:13px;margin:0;max-width:560px;}
.banner-slide[data-tone="image-clean"] .banner-cta{flex-shrink:0;}
@media(max-width:600px){
  .banner-slide[data-tone="image-clean"] .banner-caption-band{flex-direction:column;align-items:flex-start;padding:14px 16px;gap:12px;}
  .banner-slide[data-tone="image-clean"] .banner-cta{align-self:flex-start;}
  .banner-slide[data-tone="image-clean"] .banner-caption-text .banner-headline{font-size:18px;}
}
/* dots no canto sup-direito da imagem (longe da caption band) quando image-clean estiver em uso */
.banner-frame:has(.banner-slide[data-tone="image-clean"]) .banner-dots{top:16px;bottom:auto;left:auto;right:16px;width:auto;justify-content:flex-end;}
.banner-frame:has(.banner-slide[data-tone="image-clean"]) .banner-dot{background:rgba(255,255,255,0.55);}
.banner-frame:has(.banner-slide[data-tone="image-clean"]) .banner-dot.active{background:#fff;}

/* ============================================================
   Legacy hero (compat com getStorefrontPage que ainda renderiza
   .hero-section quando não há banners). Mantido pra empresas
   pré-migration. Banner stage renderiza ACIMA quando banners[] existe.
   ============================================================ */
.hero-section{position:relative;background:var(--sf-bg-card);}
.hero-cover{width:100%;background-position:center;background-size:cover;background-repeat:no-repeat;background-color:var(--sf-brand);}
.hero-section.has-cover .hero-cover{height:180px;background-image:linear-gradient(135deg,var(--sf-brand) 0%,color-mix(in oklab,var(--sf-accent) 80%,var(--sf-brand)) 100%);}
.hero-section.no-cover .hero-cover{height:90px;background-image:linear-gradient(135deg,var(--sf-brand) 0%,color-mix(in oklab,var(--sf-accent) 80%,var(--sf-brand)) 100%);}
.hero-card{max-width:1280px;margin:0 auto;padding:14px 20px 18px;display:flex;gap:14px;align-items:flex-start;position:relative;}
.hero-section.has-cover .hero-card{margin-top:-26px;}
.hero-card-logo{width:64px;height:64px;border-radius:18px;background:var(--sf-brand);color:#fff;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:400;font-family:${fontSerif};flex-shrink:0;border:3px solid var(--sf-bg-card);box-shadow:var(--sf-shadow-sm);overflow:hidden;}
.hero-section.has-cover .hero-card-logo{margin-top:-26px;}
.hero-section.no-cover .hero-card-logo{width:54px;height:54px;border-radius:50%;margin-top:-30px;border-width:3px;}
.hero-card-logo img{width:100%;height:100%;object-fit:cover;}
.hero-card-info{flex:1;min-width:0;padding-top:4px;}
.hero-card-name{font-size:22px;font-weight:400;font-family:${fontSerif};letter-spacing:-0.4px;color:var(--sf-ink);line-height:1.2;margin-bottom:4px;}
.hero-card-tag{font-size:14px;color:var(--sf-ink-2);line-height:1.5;margin-bottom:10px;}
.hero-card-pills{display:flex;gap:6px;flex-wrap:wrap;}
.hero-pill{display:inline-flex;align-items:center;gap:4px;background:var(--sf-bg);border:1px solid var(--sf-border);border-radius:999px;padding:5px 11px;font-size:12px;font-weight:500;color:var(--sf-ink-2);white-space:nowrap;}
@media(max-width:480px){.hero-section.has-cover .hero-cover{height:140px;}.hero-card{padding:12px 16px 16px;gap:12px;}.hero-card-logo{width:54px;height:54px;font-size:22px;}.hero-section.has-cover .hero-card-logo{margin-top:-22px;}.hero-card-name{font-size:18px;}.hero-card-tag{font-size:12px;}}

/* ============================================================
   Editorial note (between banner and categories)
   ============================================================ */
.editorial-note{max-width:1280px;margin:0 auto;padding:60px 32px 20px;display:grid;grid-template-columns:1fr 1.4fr;gap:80px;align-items:center;}
.editorial-note h2{font-family:${fontSerif};font-size:44px;font-weight:400;font-style:italic;color:var(--sf-ink);letter-spacing:-0.6px;line-height:1.08;margin:0 0 18px;}
.editorial-note p{font-size:16px;color:var(--sf-ink-2);line-height:1.7;margin:0;max-width:560px;}
@media(max-width:760px){
  .editorial-note{padding:32px 24px 8px;grid-template-columns:1fr;gap:14px;}
  .editorial-note h2{font-size:30px;}
  .editorial-note p{font-size:14px;}
}

/* ============================================================
   Section heads
   ============================================================ */
.sf-section-head{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:28px;gap:18px;}
.sf-section-head h2{font-family:${fontSerif};font-size:30px;font-weight:400;color:var(--sf-ink);letter-spacing:-0.4px;margin:0;line-height:1.1;}
@media(max-width:600px){.sf-section-head{margin-bottom:18px;}.sf-section-head h2{font-size:22px;}}
.sf-section-head-link{color:var(--sf-ink-2);font-size:13px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;text-decoration:none;}

/* ============================================================
   Categories chip strip
   ============================================================ */
.cats-wrap{padding:12px 20px 0;display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;position:sticky;top:64px;z-index:50;background:var(--sf-bg);border-bottom:1px solid var(--sf-border);}
.cats-wrap::-webkit-scrollbar{display:none;}
.cat-chip{white-space:nowrap;padding:8px 16px;border-radius:999px;font-size:12px;font-weight:500;background:transparent;border:1px solid var(--sf-border-2);color:var(--sf-ink);cursor:pointer;transition:all .18s;flex-shrink:0;margin-bottom:10px;font-family:${fontSans};}
.cat-chip:hover{background:var(--sf-brand-wash);}
.cat-chip.active{background:var(--sf-brand-wash);border-color:var(--sf-brand);color:var(--sf-brand-ink);font-weight:600;}

/* ============================================================
   Products grid + card styles
   ============================================================ */
.products-section{padding:20px 32px;max-width:1280px;margin:0 auto;}
.products-header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:24px;gap:18px;}
.products-header h2{font-family:${fontSerif};font-size:30px;font-weight:400;letter-spacing:-0.4px;}
@media(max-width:600px){.products-section{padding:20px 16px;}.products-header h2{font-size:22px;}}
.products-count{font-size:12px;color:var(--sf-ink-3);font-family:${fontMono};}
.products-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:28px;row-gap:48px;}
@media(max-width:600px){.products-grid{grid-template-columns:repeat(2,1fr);gap:14px;row-gap:28px;}}

.product-card{cursor:pointer;display:flex;flex-direction:column;transition:transform .18s ease;background:transparent;border:none;border-radius:0;padding:0;}
.product-card:hover{transform:translateY(-2px);}
.product-img{width:100%;aspect-ratio:1/1;background:linear-gradient(135deg,var(--sf-ph-from),var(--sf-ph-to));position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;border-radius:12px;margin-bottom:16px;}
.product-img img{width:100%;height:100%;object-fit:cover;}
.product-body{padding:0;flex:1;display:flex;flex-direction:column;}
.product-cat{font-family:${fontSans};font-size:11px;color:var(--sf-ink-3);font-weight:600;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px;}
.product-name{font-family:${fontSerif};font-size:18px;font-weight:400;color:var(--sf-ink);line-height:1.2;letter-spacing:-0.3px;margin-bottom:8px;}
.product-desc{font-size:12px;color:var(--sf-ink-3);line-height:1.5;margin-bottom:12px;display:none;}
.product-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;}
.product-price{font-family:${fontMono};font-size:14px;font-weight:500;color:var(--sf-ink);}
.add-btn{background:var(--sf-brand);color:#fff;border:none;border-radius:999px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform .18s;flex-shrink:0;font-size:18px;line-height:1;}
.add-btn:hover{transform:scale(1.08);}
.qty-ctrl{display:flex;align-items:center;gap:6px;background:var(--sf-brand-wash);border-radius:999px;padding:3px;}
.qty-btn{width:28px;height:28px;border-radius:999px;background:var(--sf-brand);color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;}
.qty-num{font-size:13px;font-weight:600;color:var(--sf-brand-ink);min-width:18px;text-align:center;font-family:${fontMono};}

/* Minimal card */
body.card-style-minimal .product-img{aspect-ratio:3/4;border-radius:4px;margin-bottom:14px;}
body.card-style-minimal .product-name{font-family:${fontSans};font-size:14px;font-weight:500;letter-spacing:0;margin-bottom:0;}
body.card-style-minimal .product-cat{font-size:10px;margin-bottom:3px;}
body.card-style-minimal .product-footer{align-items:baseline;}

/* Image-heavy card */
body.card-style-image-heavy .product-card{border:1px solid var(--sf-border);border-radius:14px;overflow:hidden;background:var(--sf-bg-card);}
body.card-style-image-heavy .product-img{aspect-ratio:4/5;border-radius:0;margin-bottom:0;}
body.card-style-image-heavy .product-body{padding:14px;}
body.card-style-image-heavy .product-name{font-size:16px;margin-bottom:4px;}

/* ============================================================
   Cart drawer
   ============================================================ */
.cart-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .25s;}
.cart-overlay.open{opacity:1;pointer-events:all;}
.cart-drawer{position:fixed;top:0;right:0;bottom:0;z-index:201;width:100%;max-width:440px;background:var(--sf-bg-card);transform:translateX(100%);transition:transform .3s cubic-bezier(.25,.46,.45,.94);display:flex;flex-direction:column;box-shadow:var(--shadow-lg);}
.cart-drawer.open{transform:translateX(0);}
.cart-header{padding:20px 24px 16px;border-bottom:1px solid var(--sf-border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
.cart-title{font-family:${fontSerif};font-size:22px;font-weight:400;letter-spacing:-0.3px;}
.cart-close{width:36px;height:36px;border-radius:999px;background:transparent;border:1px solid var(--sf-border);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--sf-ink-2);font-size:18px;}
.cart-close:hover{background:var(--sf-brand-wash);color:var(--sf-ink);}
.cart-items{flex:1;overflow-y:auto;padding:16px 24px;}
.cart-item{display:flex;gap:14px;align-items:flex-start;padding:16px 0;border-bottom:1px solid var(--sf-border);}
.cart-item:last-child{border-bottom:none;}
.cart-item-img{width:80px;height:80px;border-radius:10px;background:linear-gradient(135deg,var(--sf-ph-from),var(--sf-ph-to));display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;}
.cart-item-img img{width:100%;height:100%;object-fit:cover;}
.cart-item-info{flex:1;}
.cart-item-name{font-family:${fontSerif};font-size:15px;font-weight:400;letter-spacing:-0.2px;margin-bottom:4px;line-height:1.25;}
.cart-item-price{font-family:${fontMono};font-size:12px;color:var(--sf-ink-3);}
.cart-item-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;}
.cart-item-total{font-family:${fontMono};font-size:14px;font-weight:500;color:var(--sf-ink);}
.cart-footer{padding:20px 24px 28px;border-top:1px solid var(--sf-border);flex-shrink:0;background:var(--sf-bg-2);}
.cart-summary-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--sf-ink-2);margin-bottom:8px;font-family:${fontMono};}
.cart-summary-row.total{font-family:${fontSerif};font-size:20px;font-weight:400;color:var(--sf-ink);margin-bottom:18px;letterSpacing:-0.3px;}
.cart-summary-row.total span:last-child{font-family:${fontMono};}
.checkout-btn{width:100%;padding:16px;background:var(--sf-brand);color:#fff;border:none;border-radius:999px;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;font-family:${fontSans};letter-spacing:0.2px;}
.checkout-btn:hover{background:var(--sf-brand-2);}

/* ============================================================
   Checkout
   ============================================================ */
.checkout-overlay{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.5);display:none;align-items:flex-end;justify-content:center;}
.checkout-overlay.open{display:flex;}
@media(min-width:600px){.checkout-overlay{align-items:center;}}
.checkout-sheet{width:100%;max-width:520px;max-height:92vh;background:var(--sf-bg-card);border-radius:20px 20px 0 0;overflow:hidden;display:flex;flex-direction:column;animation:slideUp .3s ease;}
@media(min-width:600px){.checkout-sheet{border-radius:20px;}}
@keyframes slideUp{from{transform:translateY(40px);opacity:0;}to{transform:translateY(0);opacity:1;}}
.checkout-head{padding:22px 24px 16px;border-bottom:1px solid var(--sf-border);display:flex;align-items:center;gap:12px;flex-shrink:0;}
.checkout-back{width:34px;height:34px;border-radius:999px;border:1px solid var(--sf-border);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;color:var(--sf-ink-2);}
.checkout-head-info{flex:1;}
.checkout-title{font-family:${fontSerif};font-size:22px;font-weight:400;letter-spacing:-0.3px;}
.checkout-subtitle{font-size:12px;color:var(--sf-ink-3);margin-top:2px;}
.steps-bar{padding:14px 24px;display:flex;align-items:center;justify-content:center;gap:10px;border-bottom:1px solid var(--sf-border);flex-shrink:0;}
.step{display:flex;flex-direction:column;align-items:center;gap:4px;}
.step-dot{width:22px;height:22px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:transparent;border:1px solid var(--sf-border-2);color:var(--sf-ink-3);transition:all .2s;font-family:${fontMono};}
.step-dot.done{background:var(--sf-brand);border-color:var(--sf-brand);color:#fff;}
.step-dot.active{background:var(--sf-brand-wash);border-color:var(--sf-brand);color:var(--sf-brand-ink);}
.step-label{font-size:11px;font-weight:500;color:var(--sf-ink-3);}
.step-label.active{color:var(--sf-ink);font-weight:600;}
.checkout-body{flex:1;overflow-y:auto;padding:20px 24px;}
.field-group{margin-bottom:16px;}
.field-label{font-family:${fontSans};font-size:11px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase;color:var(--sf-ink-3);margin-bottom:6px;display:block;}
.field-input{width:100%;padding:12px 14px;border:1px solid var(--sf-border-2);border-radius:10px;font-size:14px;color:var(--sf-ink);background:var(--sf-bg-card);outline:none;transition:border-color .18s;font-family:${fontSans};}
.field-input:focus{border-color:var(--sf-brand);background:var(--sf-bg-card);}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.delivery-opts{display:flex;flex-direction:column;gap:10px;margin-bottom:18px;}
.delivery-opt{display:flex;align-items:center;gap:14px;padding:16px 18px;border-radius:12px;border:1px solid var(--sf-border-2);background:transparent;cursor:pointer;transition:all .18s;}
.delivery-opt.active{border-color:var(--sf-brand);background:var(--sf-brand-wash);}
.delivery-opt-radio{width:18px;height:18px;border-radius:999px;border:2px solid var(--sf-border-2);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.delivery-opt.active .delivery-opt-radio{border-color:var(--sf-brand);background:var(--sf-brand);}
.delivery-opt.active .delivery-opt-radio::after{content:'';width:6px;height:6px;background:#fff;border-radius:999px;}
.delivery-opt-icon{font-size:22px;flex-shrink:0;}
.delivery-opt-info{flex:1;}
.delivery-opt-name{font-size:14px;font-weight:600;}
.delivery-opt-detail{font-size:12px;color:var(--sf-ink-2);margin-top:2px;}
.delivery-opt-price{font-family:${fontMono};font-size:14px;font-weight:500;color:var(--sf-ink);flex-shrink:0;}

/* Pix */
.pix-box{background:var(--sf-brand-wash-2);border:1px solid var(--sf-border);border-radius:14px;padding:22px;text-align:center;}
.pix-qr{width:170px;height:170px;margin:0 auto 16px;background:#fff;border-radius:12px;border:1px solid var(--sf-border);display:flex;align-items:center;justify-content:center;overflow:hidden;padding:6px;}
.pix-key-box{background:var(--sf-bg-card);border:1px solid var(--sf-border);border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;}
.pix-key{font-size:11px;font-weight:500;color:var(--sf-ink);font-family:${fontMono};word-break:break-all;text-align:left;}
.pix-copy{font-size:12px;font-weight:600;color:var(--sf-brand-ink);cursor:pointer;white-space:nowrap;flex-shrink:0;}
.pix-timer{display:inline-flex;align-items:center;gap:5px;background:var(--sf-brand-wash);color:var(--sf-brand-ink);font-size:12px;font-weight:700;padding:6px 14px;border-radius:999px;margin-top:14px;font-family:${fontMono};}

.order-summary{background:var(--sf-bg-2);border:1px solid var(--sf-border);border-radius:14px;padding:16px;margin-bottom:18px;}
.summary-row{display:flex;justify-content:space-between;font-size:13px;color:var(--sf-ink-2);margin-bottom:6px;font-family:${fontMono};}
.summary-row.total{font-family:${fontSerif};font-size:18px;font-weight:400;color:var(--sf-ink);border-top:1px solid var(--sf-border);padding-top:10px;margin-top:6px;letter-spacing:-0.2px;}
.summary-row.total span:last-child{font-family:${fontMono};}
.checkout-foot{padding:18px 24px 26px;border-top:1px solid var(--sf-border);flex-shrink:0;}
.next-btn{width:100%;padding:16px;background:var(--sf-brand);color:#fff;border:none;border-radius:999px;font-size:15px;font-weight:600;cursor:pointer;transition:background .18s;display:flex;align-items:center;justify-content:center;gap:8px;font-family:${fontSans};letter-spacing:0.2px;}
.next-btn:hover{background:var(--sf-brand-2);}
.next-btn:disabled{background:var(--sf-border);color:var(--sf-ink-3);cursor:not-allowed;}
.next-btn.green{background:#10b981;}
.next-btn.green:hover{background:#059669;}

/* Confirm */
.confirm-screen{text-align:center;padding:48px 24px;}
.confirm-icon{width:84px;height:84px;border-radius:999px;background:var(--sf-brand-wash);display:flex;align-items:center;justify-content:center;font-size:38px;margin:0 auto 24px;animation:popIn .4s ease;color:var(--sf-brand);}
.confirm-icon::before{content:'';position:absolute;inset:-10px;border-radius:999px;border:1px dashed var(--sf-border-2);}
@keyframes popIn{from{transform:scale(.5);opacity:0;}to{transform:scale(1);opacity:1;}}
.confirm-title{font-family:${fontSerif};font-size:34px;font-weight:400;font-style:italic;color:var(--sf-ink);letter-spacing:-0.6px;margin-bottom:14px;line-height:1.05;}
.confirm-desc{font-size:15px;color:var(--sf-ink-2);line-height:1.6;max-width:380px;margin:0 auto 24px;}
.whats-btn{display:inline-flex;align-items:center;gap:8px;background:#25D366;color:#fff;padding:14px 28px;border-radius:999px;font-size:14px;font-weight:600;text-decoration:none;border:none;cursor:pointer;font-family:${fontSans};}

/* Contact bar (footer area) */
.contact-bar{background:var(--sf-bg-card);border-top:1px solid var(--sf-border);padding:24px 20px;text-align:center;}
.contact-bar p{font-size:13px;color:var(--sf-ink-3);margin-bottom:14px;font-family:${fontSans};}
.whatsapp-cta{display:inline-flex;align-items:center;gap:8px;background:#25D366;color:#fff;padding:12px 26px;border-radius:999px;font-size:14px;font-weight:600;text-decoration:none;font-family:${fontSans};}

/* ============================================================
   Quote ribbon (press blurb)
   ============================================================ */
.quote-ribbon{margin:96px auto 0;max-width:1280px;padding:64px 80px;border-top:1px solid var(--sf-border);border-bottom:1px solid var(--sf-border);text-align:center;background:var(--sf-brand-wash-2);}
.quote-ribbon blockquote{font-family:${fontSerif};font-style:italic;font-size:32px;line-height:1.25;color:var(--sf-ink);margin:0 auto;max-width:760px;letter-spacing:-0.4px;font-weight:400;}
.quote-ribbon .quote-source{margin-top:18px;font-family:${fontSans};font-size:12px;color:var(--sf-ink-3);letter-spacing:1.2px;text-transform:uppercase;}
@media(max-width:760px){.quote-ribbon{margin:56px 16px 0;padding:36px 22px;}.quote-ribbon blockquote{font-size:22px;}}

/* ============================================================
   Service strip (4 cards: frete, embalagem, segurança, avaliação)
   ============================================================ */
.service-strip{max-width:1280px;margin:0 auto;padding:56px 32px 0;display:grid;grid-template-columns:repeat(4,1fr);gap:24px;}
@media(max-width:760px){.service-strip{padding:32px 16px 0;grid-template-columns:repeat(2,1fr);gap:14px;}}
.service-card{padding:18px;border-radius:12px;border:1px solid var(--sf-border);background:var(--sf-bg-card);display:flex;flex-direction:column;gap:10px;}
.service-card-icon{width:38px;height:38px;border-radius:10px;background:var(--sf-brand-wash);display:flex;align-items:center;justify-content:center;color:var(--sf-brand-ink);font-size:20px;}
.service-card-title{font-size:14px;font-weight:600;color:var(--sf-ink);}
.service-card-body{font-size:12px;color:var(--sf-ink-2);margin-top:2px;}

/* ============================================================
   Footer
   ============================================================ */
.site-footer{background:var(--sf-bg-2);border-top:1px solid var(--sf-border);margin-top:60px;color:var(--sf-ink-2);font-size:13px;line-height:1.6;}
.site-footer-inner{max-width:1280px;margin:0 auto;padding:56px 32px 24px;}
.site-footer-cols{display:grid;grid-template-columns:1.4fr repeat(4,1fr);gap:40px;margin-bottom:48px;}
@media(max-width:760px){.site-footer-cols{grid-template-columns:1fr 1fr;gap:24px;}}
.site-footer h4{font-family:${fontSans};font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--sf-ink-3);margin-bottom:14px;}
.site-footer ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:9px;}
.site-footer li{font-size:13px;color:var(--sf-ink-2);cursor:pointer;}
.site-footer-bottom{border-top:1px solid var(--sf-border);padding-top:22px;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--sf-ink-3);}
.powered{display:inline-flex;align-items:center;gap:6px;}
.powered .brand{font-family:${fontSerif};font-size:14px;color:var(--sf-ink-2);}
.powered .brand-dot{color:${primary};}

/* ============================================================
   Toast
   ============================================================ */
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--sf-ink);color:var(--sf-bg-card);padding:12px 22px;border-radius:999px;font-size:13px;font-weight:500;z-index:999;transition:transform .3s ease;pointer-events:none;white-space:nowrap;font-family:${fontSans};}
.toast.show{transform:translateX(-50%) translateY(0);}
@keyframes pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.2);}}
.pulse{animation:pulse .3s ease;}
`;
}
module.exports = buildStyles;
