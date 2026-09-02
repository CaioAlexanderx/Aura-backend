// ============================================================
// AURA. — Template da vitrine pública v2 (ASSEMBLER)
// Exporta: buildStorefrontPage(data, slug) → string HTML
// Módulos: storefrontStyles | storefrontHtml | storefrontScript
//
// v2 (15/05/2026):
//  • passa accent_color, dark_mode, font_family ao CSS builder
//  • passa banners[] + announcement_bar + service_cards[] ao HTML builder
//  • aplica classes no <body>: sf-dark, card-style-{editorial|minimal|image-heavy}
//  • injeta JS pra auto-rotação do banner-stage
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
const { linkDeFontes } = require('./storefrontTypography');
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
    // Validado (http/https apenas) no parseBanners. O re-map copia campo
    // a campo — sem esta linha o destino do CTA morreria aqui, como ja
    // aconteceu com catalog_total.
    cta_url: b.cta_url ? escHtml(b.cta_url) : '',
    tone: b.tone || 'split',
    tint: b.tint || 'brand',
    image_url: b.image_url ? escHtml(b.image_url) : null,
    // Versao quadrada pro celular (02/09/2026). O re-map copia campo a
    // campo — sem esta linha a foto do celular morreria aqui, como o
    // cta_url quase morreu.
    image_url_mobile: b.image_url_mobile ? escHtml(b.image_url_mobile) : null,
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
    // Quantos produtos a loja TEM. O builder ja calculava e a grade ja
    // sabia usar, mas o storeData copia campo a campo — a chave parava
    // aqui e o aviso "500 de 1302" nunca aparecia.
    catalog_total: data.catalog_total,
    // A barra de categorias precisa da lista do BANCO, nao dos produtos
    // da pagina 1 — ver contarPorCategoria.
    categorias_barra: data.categorias_barra,
    categorias_arvore: data.categorias_arvore,
    // A tira sai pronta do builder; a pagina so repassa.
    tira_de_categorias: data.tira_de_categorias,
    facetas: data.facetas,
    pix_discount_pct: data.pix_discount_pct,
    // Redesign 09/2026 — os blocos da home. Copiado campo a campo como
    // tudo aqui: sem esta linha o builder calcula e a pagina nunca ve.
    home: data.home,
    // A politica de troca ja resolvida (uma fonte so): a pagina do produto
    // mostra o mesmo texto do rodape (fase 5).
    rodape_institucional: data.rodape_institucional,
  });

  // O <img> quebrado SAI do DOM (remove(), nao display:none): o CSS usa
  // .topbar-logo:has(img) pra decidir entre a caixa quadrada da inicial
  // e a caixa livre do logo, e um img invisivel ainda casaria o :has().
  // O object-fit dos dois e "contain" (no CSS): cover cortava qualquer
  // logo que nao fosse quadrado — o da Finesse e retangular, com texto.
  const logoInTopbar = logoUrl
    ? `<img src="${logoUrl}" alt="" onerror="this.remove();var s=document.getElementById('logoInitial');if(s){s.style.display='flex';}"><span id="logoInitial" style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:15px;font-weight:400;color:#fff;font-family:inherit;"></span>`
    : `<span id="logoInitial" style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-size:15px;font-weight:400;color:#fff;font-family:inherit;"></span>`;
  // (O hero antigo com logo e capa saiu na fase 3: o hero e full-bleed e a
  // capa da loja foi aposentada — decisao 4/18 de 02/09/2026.)

  // O bloco do WhatsApp e desenhado em buildHtmlBody a partir do numero.
  const contactBar = '';

  // Logo grande no rodape (220x64). Sem imagem, o nome em display.
  const logoNoRodape = logoUrl
    ? `<img src="${logoUrl}" alt="${siteName}" onerror="this.outerHTML='<span class=&quot;site-footer-nome serif&quot;>${siteName}</span>'">`
    : '';

  // Barra de anuncio: o texto da lojista, ou o que o builder compos do que
  // ela LIGOU (frete gratis, troca, Pix). Nunca uma frase inventada.
  const announcementFinal = announcementBar || escHtml(site.announcement_auto || '');

  const css    = buildStyles(primary, accent, dark, font);
  const body   = buildHtmlBody({
    siteName, tagline, logoInTopbar, logoNoRodape, contactBar,
    addrText, horarioTexto: site.horario_resumo || '', cnpjTexto: site.cnpj_formatado || '',
    announcementBar: announcementFinal, banners, serviceCards,
    isOpenNow, nextOpenText, whatsNum,
    // Formas de pagamento vem do que a lojista LIGOU, nao de lista fixa.
    pagamentos: {
      pix:  data.settings && data.settings.has_pix === true,
      card: data.settings && data.settings.has_card === true,
      na_entrega: data.settings && data.settings.pay_on_delivery_enabled === true,
    },
    politicaTroca: data.politica_troca,
    // Instagram, TikTok e Facebook do rodape — ja normalizados pelo
    // builder (services/redesSociais.js).
    redes: (data.contact && data.contact.redes) || [],
  });
  const script = buildScript(storeData, escJs(slug), API_BASE);

  const bodyClasses = [
    dark ? 'sf-dark' : 'sf-light',
    `card-style-${cardStyle}`,
    `font-${font}`,
    // Modo home (fase 3): os blocos aparecem ate a pessoa escolher
    // categoria, busca ou filtro. O JS reavalia a cada render da grade.
    'home',
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
  // O helper de rolar-ate-a-grade saiu junto com o CTA que so rolava a
  // pagina: o CTA do banner agora e um <a> com destino real (cta_url)
  // ou nao existe.
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
<link rel="stylesheet" href="${linkDeFontes(font)}">
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
