// ============================================================
// AURA. — Template da vitrine pública (ASSEMBLER)
// Exporta: buildStorefrontPage(data, slug) → string HTML
// Módulos: storefrontStyles | storefrontHtml | storefrontScript
// ============================================================
const buildStyles   = require('./storefrontStyles');
const buildHtmlBody = require('./storefrontHtml');
const buildScript   = require('./storefrontScript');

// API_BASE: URL absoluta do backend Aura. Default produção (Railway).
// Pode ser sobrescrito por env var STOREFRONT_API_BASE_URL.
// Necessário porque a vitrine pode ser servida em domínio diferente do
// backend (ex: loja.getaura.com.br via Cloudflare). Sem URL absoluta,
// fetches relativos do JS da vitrine batem no domínio errado e dão 404.
const API_BASE = process.env.STOREFRONT_API_BASE_URL
  || 'https://aura-backend-production-f805.up.railway.app';

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
    ? `<img src="${logoUrl}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';var s=document.getElementById('heroInitial');if(s){s.style.display='flex';}"><span id="heroInitial" style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#fff;"></span>`
    : `<span id="heroInitial" style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#fff;"></span>`;

  const contactBar = whatsNum ? `
<div class="contact-bar">
  <p>Dúvidas? Fale conosco!</p>
  <a class="whatsapp-cta" href="https://wa.me/${whatsNum}" target="_blank">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.122 1.533 5.85L0 24l6.335-1.524A11.94 11.94 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.852 0-3.587-.5-5.088-1.375l-.362-.215-3.762.905.947-3.674-.237-.376A9.969 9.969 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
    Chamar no WhatsApp
  </a>
</div>` : '';

  const css    = buildStyles(primary);
  const body   = buildHtmlBody({ siteName, tagline, logoInTopbar, logoInHero, contactBar, addrText, coverUrl });
  const script = buildScript(storeData, escJs(slug), API_BASE);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${siteName}</title>
<meta name="description" content="${tagline}">
<style>
${css}
</style>
</head>
<body>

${body}

${script}
</body>
</html>`;
}

module.exports = buildStorefrontPage;
