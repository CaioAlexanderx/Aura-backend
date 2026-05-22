// ============================================================
// AURA. — Template da vitrine pública v2 (ASSEMBLER)
// Exporta: buildStorefrontPage(data, slug) → string HTML
// Módulos: storefrontStyles | storefrontHtml | storefrontScript
//
// v2 (15/05/2026):
//  • passa accent_color, dark_mode, font_family ao CSS builder
//  • passa banners[] + announcement_bar + service_cards[] ao HTML builder
//  • aplica classes no <body>: sf-dark, card-style-{editorial|minimal|image-heavy}
//  • injeta JS pra auto-rotação do banner-stage e scrollToProducts
//
// v3 (18/05/2026 — Fase 3 PR A):
//  • banner_rotation_seconds (3–15s, default 7s) lido de site.banner_rotation_seconds
//  • touchstart/touchend no stage pausa rotação (espelha mouseenter/leave)
//
// Fase 5 (20/05/2026):
//  • passa is_open_now + next_open_text pro buildHtmlBody (badge topbar)
//
// (22/05/2026):
//  • favicon: injeta <link rel="icon"> com logo_url quando disponível
// ============================================================
const buildStyles   = require('./storefrontStyles');
const buildHtmlBody = require('./storefrontHtml');
const buildScript   = require('./storefrontScript');

const API_BASE = process.env.STOREFRONT_API_BASE_URL
  || 'https://aura-backend-production-f805.up.railway.app';

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escJs(s)   { return String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/[\n\r]/g,' '); }

function buildStorefrontPage(data, slug) {
  const site = data.site || {};
  const primary  = site.primary_color || '#7c3aed';
  const accent   = site.accent_color  || primary;
  const dark     = !!site.dark_mode;
  const font     = site.font_family   || 'classic';
  const cardStyle = site.card_style   || 'editorial';
  const siteName = escHtml(site.name);
  const tagline  = escHtml(site.tagline || site.description || '');
  const logoUrl  = site.logo_url  ? escHtml(site.logo_url)  : '';
  const coverUrl = site.cover_url ? escHtml(site.cover_url) : '';
  const announcementBar = site.announcement_bar ? escHtml(site.announcement_bar) : '';
  const whatsNum = (data.contact?.whatsapp || '').replace(/\D/g, '');
  const addrText = escHtml(data.contact?.address || '');

  // Fase 5: open state. Quando o builder nao computou (config sem
  // business_hours), is_open_now vem undefined e o template skipa o badge.
  const isOpenNow = (typeof site.is_open_now === 'boolean') ? site.is_open_now : undefined;
  const nextOpenText = site.next_open_text || '';

  // Banner rotation — site.banner_rotation_seconds em [3, 15], default 7s.
  // Valores fora do range ou inválidos caem no default. Convertemos pra ms
  // pra passar pro setInterval no script inline.
  const rotSec = parseInt(site.banner_rotation_seconds, 10);
  const rotateMs = (Number.isFinite(rotSec) && rotSec >= 3 && rotSec <= 15)
    ? rotSec * 1000
    : 7000;

  // banners e service_cards — escape de XSS reforçado
  const banners = (site.banners || []).map((b) => ({
    kicker: escHtml(b.kicker || ''),
    headline: escHtml(b.headline || ''),
    body: escHtml(b.body || ''),
    cta: escHtml(b.cta || ''),
    tone: b.tone || 'split',
    tint: b.tint || 'brand',
    image_url: b.image_url ? escHtml(b.image_url) : null,
  }));
  const serviceCards = (site.service_cards || []).map((c) => ({
    icon: c.icon || 'sparkle',
    title: escHtml(c.title || ''),
    body: escHtml(c.body || ''),
  }));

  const storeData = JSON.stringify({
    slug,
    site:     site,
    contact:  data.contact,
    settings: data.settings,
    products: data.products,
  });

  const logoInTopbar = logoUrl
    ? `<img src="${logoUrl}" alt="" onerror="this.style.display='none';var s=document.getElementById('logoInitial');if(s){s.style.display='flex';}"><span id="logoInitial" style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:15px;font-weight:400;color:#fff;font-family:inherit;"></span>`
    : `<span id="logoInitial" style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-size:15px;font-weight:400;color:#fff;font-family:inherit;"></span>`;
  const logoInHero = logoUrl
    ? `<img src="${logoUrl}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';var s=document.getElementById('heroInitial');if(s){s.style.display='flex';}"><span id="heroInitial" style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:26px;font-weight:400;color:#fff;font-family:inherit;"></span>`
    : `<span id="heroInitial" style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-size:26px;font-weight:400;color:#fff;font-family:inherit;"></span>`;

  const contactBar = whatsNum ? `
<div class="contact-bar">
  <p>Dúvidas? Fale conosco direto no WhatsApp.</p>
  <a class="whatsapp-cta" href="https://wa.me/${whatsNum}" target="_blank">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.122 1.533 5.85L0 24l6.335-1.524A11.94 11.94 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.852 0-3.587-.5-5.088-1.375l-.362-.215-3.762.905.947-3.674-.237-.376A9.969 9.969 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
    Chamar no WhatsApp
  </a>
</div>` : '';

  const css    = buildStyles(primary, accent, dark, font);
  const body   = buildHtmlBody({
    siteName, tagline, logoInTopbar, logoInHero, contactBar,
    addrText, coverUrl, announcementBar, banners, serviceCards,
    isOpenNow, nextOpenText,
  });
  const script = buildScript(storeData, escJs(slug), API_BASE);

  const bodyClasses = [
    dark ? 'sf-dark' : 'sf-light',
    `card-style-${cardStyle}`,
    `font-${font}`,
  ].join(' ');

  const inlineHelpers = `
<script>
(function(){
  var ROTATE_MS = ${rotateMs};
  var slides = document.querySelectorAll('#bannerStage .banner-slide');
  var dots = document.querySelectorAll('#bannerDots .banner-dot');
  var idx = 0, timer = null, paused = false;
  function show(n){
    idx = (n + slides.length) % slides.length;
    slides.forEach(function(el, i){ el.classList.toggle('active', i===idx); });
    dots.forEach(function(el, i){ el.classList.toggle('active', i===idx); });
  }
  window.goBanner = function(n){ show(n); restart(); };
  function tick(){ if (!paused) show(idx + 1); }
  function restart(){ if (timer) clearInterval(timer); timer = setInterval(tick, ROTATE_MS); }
  var stage = document.getElementById('bannerStage');
  if (stage && slides.length > 1){
    stage.addEventListener('mouseenter', function(){ paused = true; });
    stage.addEventListener('mouseleave', function(){ paused = false; });
    // Touch: pausa enquanto o usuário interage (swipe/tap) e retoma ao soltar.
    stage.addEventListener('touchstart', function(){ paused = true; }, { passive: true });
    stage.addEventListener('touchend',   function(){ paused = false; }, { passive: true });
    stage.addEventListener('touchcancel',function(){ paused = false; }, { passive: true });
    restart();
  }
  window.scrollToProducts = function(){
    var el = document.getElementById('productsAnchor');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
})();
</script>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${siteName}</title>
<meta name="description" content="${tagline}">
${logoUrl ? `<link rel="icon" href="${logoUrl}" type="image/png">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=Fraunces:opsz,wght,ital@9..144,400;9..144,500;9..144,600;9..144,400,1&family=DM+Mono:wght@400;500&display=swap">
<style>
${css}
</style>
</head>
<body class="${bodyClasses}">

${body}

${script}
${inlineHelpers}
</body>
</html>`;
}

module.exports = buildStorefrontPage;
