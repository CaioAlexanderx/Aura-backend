// ============================================================
// AURA. — GA4 e Meta Pixel nas lojas (04/09/2026)
//
// As colunas `ga4_measurement_id` e `meta_pixel_id` existem desde a
// migration 220 e o painel as grava (routes/digitalChannelAnalytics.js).
// Nenhuma loja as LIA: a lojista colava o ID, salvava, e o Google nunca
// via uma visita. Decisao do Caio: GA4, Pixel e SEO em toda loja gerada
// pela Aura — e o banner de cookies passa a existir por causa deles.
//
// Aqui se decide O QUE injetar. As duas lojas (HTML gerado aqui e o app)
// desenham a partir do mesmo dado; a validacao do formato mora aqui para
// as duas recusarem o mesmo lixo.
// ============================================================
'use strict';

/** G-XXXXXXXXXX — o formato do ID de fluxo do GA4. */
const GA4 = /^G-[A-Z0-9]{6,14}$/;
/** Pixel da Meta e numerico, 15 ou 16 digitos. */
const PIXEL = /^\d{15,16}$/;

function idGa4(v) {
  const s = String(v || '').trim().toUpperCase();
  return GA4.test(s) ? s : null;
}

function idPixel(v) {
  const s = String(v || '').trim();
  return PIXEL.test(s) ? s : null;
}

/**
 * Os rastreadores da loja, ja validados.
 *
 * ID fora do formato vira `null`, nao vira script: um `G-` mal copiado
 * carregaria o gtag apontando para o nada, e o console da cliente
 * encheria de erro.
 */
function rastreadoresDaLoja(config) {
  const c = config || {};
  return { ga4: idGa4(c.ga4_measurement_id), pixel: idPixel(c.meta_pixel_id) };
}

/**
 * O HTML do <head> para a loja gerada no servidor.
 *
 * So entra o que esta configurado. Loja sem rastreador nao carrega
 * script nenhum — e nem mostra banner de cookies, porque nao ha o que
 * consentir.
 */
function scriptsDoHead({ ga4, pixel }) {
  const partes = [];
  if (ga4) {
    partes.push(
      `<script async src="https://www.googletagmanager.com/gtag/js?id=${ga4}"></script>`,
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}`
      + `gtag('js',new Date());gtag('config','${ga4}',{anonymize_ip:true});</script>`
    );
  }
  if (pixel) {
    partes.push(
      `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?`
      + `n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;`
      + `n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;`
      + `t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script',`
      + `'https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixel}');fbq('track','PageView');</script>`
    );
  }
  return partes.join('\n');
}

/** Os hosts que a CSP precisa liberar para os rastreadores funcionarem. */
const HOSTS_DOS_RASTREADORES = {
  script: ['https://www.googletagmanager.com', 'https://connect.facebook.net'],
  connect: ['https://www.google-analytics.com', 'https://analytics.google.com',
            'https://www.googletagmanager.com', 'https://www.facebook.com'],
  img: ['https://www.facebook.com', 'https://www.google-analytics.com'],
};

/**
 * As metatags de SEO e de compartilhamento.
 *
 * O link da loja no WhatsApp mostra titulo, descricao e imagem so com
 * Open Graph — sem isso aparece a URL crua, que ninguem clica.
 */
function metatagsDeSeo({ titulo, descricao, url, imagem }) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const t = esc(titulo);
  const d = esc(descricao);
  const partes = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:site_name" content="${t}">`,
  ];
  if (d) partes.push(`<meta property="og:description" content="${d}">`);
  if (url) partes.push(`<link rel="canonical" href="${esc(url)}">`, `<meta property="og:url" content="${esc(url)}">`);
  if (imagem) partes.push(`<meta property="og:image" content="${esc(imagem)}">`, `<meta name="twitter:card" content="summary_large_image">`);
  else partes.push(`<meta name="twitter:card" content="summary">`);
  return partes.join('\n');
}

module.exports = {
  idGa4, idPixel, rastreadoresDaLoja, scriptsDoHead, metatagsDeSeo, HOSTS_DOS_RASTREADORES,
};
