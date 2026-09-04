// ============================================================
// AURA. — A vitrine Studio servida em loja.getaura.com.br/<slug>
//
// ── O PROBLEMA ─────────────────────────────────────────────────────────
// A mesma empresa tinha duas lojas em dois enderecos:
//
//   loja.getaura.com.br/sheid-mania              → loja comum (HTML daqui)
//   app.getaura.com.br/cardapio/studio/sheid-mania → vitrine Studio (Expo)
//
// A lojista divulgava o primeiro — e o painel copiava esse — enquanto a
// vitrine de personalizados, a que ela vende, vivia no segundo. Fora que
// "cardapio" num endereco de loja de canecas parece restaurante, e
// `app.` e o host do PAINEL, nao de uma loja publica.
//
// ── A DECISAO (04/09/2026, com o Caio) ─────────────────────────────────
// Empresa em modo Studio tem UMA loja. `loja.getaura.com.br/<slug>` passa
// a servir a vitrine Studio para ela; a loja comum deixa de existir nesse
// endereco. Para todas as outras empresas nada muda — o interruptor e
// `companies.pdv_settings->>'studio_enabled'`.
//
// ── COMO ───────────────────────────────────────────────────────────────
// A vitrine e um app Expo exportado como uma pagina so (SPA): um HTML
// curto que carrega um bundle. Este modulo busca esse HTML uma vez,
// aponta o bundle para o host onde ele mora de verdade e devolve a
// pagina. O navegador continua em loja.getaura.com.br e o roteador do
// app le o proprio caminho — por isso o app precisa de uma rota que
// case com `/<slug>` na raiz.
//
// NAO se copia o bundle para ca: ele muda a cada deploy do app, e uma
// copia seria a vitrine de ontem servida na loja de hoje.
// ============================================================
'use strict';

/** Onde o app Expo esta publicado de verdade. */
const HOST_DO_APP = process.env.STUDIO_APP_ORIGIN || 'https://app.getaura.com.br';

/**
 * Por quanto tempo a casca fica em memoria.
 *
 * Curto de proposito: e o unico caminho pelo qual um deploy do app chega
 * a quem abre a loja. Dez minutos e o atraso maximo entre publicar o app
 * e a loja servir a versao nova.
 */
const VALIDADE_MS = 10 * 60 * 1000;

let _cache = null; // { html, expiraEm }

/** Empresa em modo Studio? O mesmo interruptor que o painel usa. */
function ehLojaStudio(company) {
  const s = company && company.pdv_settings;
  if (!s || typeof s !== 'object') return false;
  return s.studio_enabled === true || s.studio_enabled === 'true';
}

/**
 * Aponta os caminhos do Expo para o host onde eles existem.
 *
 * A casca vem com `src="/_expo/static/js/web/entry-<hash>.js"`. Servida
 * daqui, esse caminho e 404: o bundle mora no app. Reescrever e o passo
 * que faz a pagina funcionar sob outro dominio.
 *
 * So mexe em `/_expo/` e `/assets/`: um replace solto em `/` quebraria
 * qualquer href da propria pagina.
 */
function apontarParaOApp(html) {
  return String(html)
    .replace(/(src|href)="\/(_expo|assets)\//g, `$1="${HOST_DO_APP}/$2/`);
}

/**
 * O recado para o app, antes do bundle carregar.
 *
 * A vitrine passa a existir em dois enderecos com caminhos diferentes
 * (`/<slug>` aqui, `/cardapio/studio/<slug>` no app). Em vez de o app
 * adivinhar, a pagina diz qual loja abrir e por qual endereco publico —
 * o segundo serve para os links que a vitrine gera (compartilhar,
 * voltar para a home) nao pularem de dominio no meio da compra.
 */
function recadoParaOApp(slug) {
  const seguro = JSON.stringify(String(slug));
  return `<script>window.__AURA_VITRINE__={slug:${seguro},base:"/"};</script>`;
}

/** Busca a casca do app, com cache curto. Lanca se o app estiver fora. */
async function buscarCasca() {
  if (_cache && _cache.expiraEm > Date.now()) return _cache.html;

  const r = await fetch(HOST_DO_APP + '/', {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('app respondeu ' + r.status);

  const html = await r.text();
  // Casca sem bundle nao renderiza nada: melhor falhar aqui, e cair na
  // loja comum, do que servir uma pagina em branco.
  if (!/_expo\/static\/js/.test(html)) throw new Error('casca do app sem bundle');

  _cache = { html, expiraEm: Date.now() + VALIDADE_MS };
  return html;
}

/**
 * A pagina da vitrine Studio para um slug.
 *
 * Devolve `null` quando o app nao responde — o chamador cai na loja
 * comum, que e gerada aqui e nao depende de ninguem. Loja no ar com a
 * vitrine antiga e melhor do que loja fora do ar.
 */
async function montarVitrineStudio(slug) {
  try {
    const casca = apontarParaOApp(await buscarCasca());
    return casca.replace('</head>', recadoParaOApp(slug) + '</head>');
  } catch (err) {
    console.warn('[vitrineStudio] casca indisponivel:', err.message);
    return null;
  }
}

/**
 * CSP da vitrine Studio.
 *
 * Mais larga que a da loja comum porque o app carrega o proprio bundle
 * de outro dominio nosso, o three.js do cdnjs (o motor 3D da caneca) e
 * as fontes do Google. Cada entrada esta aqui por um motivo; nao ha
 * curinga em script-src.
 */
function cspDaVitrineStudio(baseDaApi) {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${HOST_DO_APP} https://cdnjs.cloudflare.com https://static.cloudflareinsights.com`,
    "script-src-attr 'unsafe-inline'",
    `style-src 'self' 'unsafe-inline' ${HOST_DO_APP} https://fonts.googleapis.com`,
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    `connect-src 'self' ${HOST_DO_APP} ${baseDaApi} https://cloudflareinsights.com https://viacep.com.br https://brasilapi.com.br https://r2.getaura.com.br https://*.r2.dev`,
    `font-src 'self' data: ${HOST_DO_APP} https://fonts.gstatic.com`,
    "frame-ancestors *",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** So para teste: esquece a casca guardada. */
function limparCache() { _cache = null; }

module.exports = {
  HOST_DO_APP,
  ehLojaStudio,
  apontarParaOApp,
  recadoParaOApp,
  montarVitrineStudio,
  cspDaVitrineStudio,
  limparCache,
};
