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

const { HOSTS_DOS_RASTREADORES, metatagsDeSeo } = require('./rastreadores');

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

// ── A PREVIA DO LINK (BE-1, 25/09/2026) ────────────────────────────────
// O robo que monta a previa no WhatsApp e no Instagram NAO roda
// JavaScript: ele le o <head> que o servidor mandou e pronto. A casca do
// app sai com `<title>Aura.</title>` e nada mais, entao o "Compartilhar"
// da vitrine mandava um link sem foto e com o nome da Aura. O servidor
// escreve aqui o que o robo precisa — da peca em /p/<id>, da loja no
// resto — por requisicao, sem tocar na casca guardada (ver
// montarVitrineStudio).

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "R$ 49,90" — vazio quando nao ha preco que valha mostrar. */
function precoEmReais(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  // O Intl poe espaco inquebravel depois do "R$"; o cartao do WhatsApp
  // desenha igual, e o teste compara texto simples.
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');
}

/**
 * A descricao em uma linha curta. O cartao do WhatsApp mostra duas ou
 * tres linhas; o resto e cortado por ele no meio da palavra.
 */
function textoCurto(texto, max = 150) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const corte = t.slice(0, max - 1);
  const ultimoEspaco = corte.lastIndexOf(' ');
  return (ultimoEspaco > max * 0.6 ? corte.slice(0, ultimoEspaco) : corte).replace(/[\s,.;:·-]+$/, '') + '…';
}

/**
 * A foto da peca para a previa. A miniatura (ate 640 px, migration 317)
 * vem primeiro de proposito: o WhatsApp desiste de imagem pesada e mostra
 * o link sem foto, e 640 px ja enche o cartao grande.
 */
function fotoDaPeca(peca) {
  if (!peca) return null;
  const galeria = Array.isArray(peca.gallery_urls) ? peca.gallery_urls.filter(Boolean) : [];
  return peca.image_thumb_url || peca.thumb_url || peca.image_url || galeria[0] || null;
}

/**
 * O <head> da vitrine Studio: <title>, descricao e Open Graph.
 *
 * `loja` = { nome, tagline, logo_url, cover_url }; `peca` = a linha de
 * pecaDaVitrineStudio (ou null); `urlDaLoja` = o endereco publico
 * (storefrontBuilder.urlDaLoja). `indexar: false` para sacola, checkout e
 * paginas com token: o link de um pedido nao pode virar resultado de
 * busca.
 *
 * Tudo que vem da lojista (nome da peca, descricao, tagline) passa por
 * escape: um `"><script>` no nome da caneca nao pode sair do atributo.
 * As metatags sao as MESMAS da loja comum (metatagsDeSeo, #674).
 */
function metatagsDaVitrineStudio({ loja, peca, urlDaLoja, mostrarPreco = true, indexar = true }) {
  const l = loja || {};
  const nomeDaLoja = String(l.nome || '').trim() || 'Loja';
  const base = String(urlDaLoja || '').replace(/\/+$/, '');

  let titulo, descricao, url, imagem, tipo;
  if (peca) {
    const nome = String(peca.name || '').trim();
    titulo = nome ? `${nome} · ${nomeDaLoja}` : nomeDaLoja;
    const preco = mostrarPreco ? precoEmReais(peca.price) : '';
    const sobre = textoCurto(peca.description) || `${nome} na ${nomeDaLoja}`.trim();
    descricao = [preco, sobre].filter(Boolean).join(' · ');
    url = base ? `${base}/p/${encodeURIComponent(peca.id)}` : '';
    imagem = fotoDaPeca(peca) || l.logo_url || l.cover_url || '';
    tipo = 'product';
  } else {
    titulo = nomeDaLoja;
    descricao = textoCurto(l.tagline);
    url = base;
    imagem = l.logo_url || l.cover_url || '';
    tipo = 'website';
  }

  return [
    `<title>${escHtml(titulo)}</title>`,
    descricao ? `<meta name="description" content="${escHtml(descricao)}">` : '',
    indexar ? '' : '<meta name="robots" content="noindex">',
    metatagsDeSeo({ titulo, descricao, url, imagem, tipo, nomeDaLoja }),
  ].filter(Boolean).join('\n');
}

/**
 * Troca o <head> generico da casca pelo da loja.
 *
 * Tira o <title> e qualquer descricao, canonica ou Open Graph que a casca
 * traga: o robo le a PRIMEIRA og:image, e uma da Aura antes da nossa
 * ganharia. Os `replace` usam funcao de proposito — com texto, um `$&`
 * no nome da peca seria interpretado como padrao de substituicao.
 */
function comCabecalhoDaLoja(casca, cabecalho) {
  if (!cabecalho) return casca;
  const limpa = String(casca)
    .replace(/<meta\s+(?:property|name)="(?:og:[^"]*|twitter:[^"]*|description|robots)"[^>]*>\s*/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '');
  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(limpa)) {
    return limpa.replace(/<title[^>]*>[\s\S]*?<\/title>/i, () => cabecalho);
  }
  return limpa.replace('</head>', () => cabecalho + '</head>');
}

/**
 * A pagina da vitrine Studio para um slug.
 *
 * Devolve `null` quando o app nao responde — o chamador cai na loja
 * comum, que e gerada aqui e nao depende de ninguem. Loja no ar com a
 * vitrine antiga e melhor do que loja fora do ar.
 *
 * `cabecalho` (metatagsDaVitrineStudio) e por requisicao: entra numa
 * COPIA da casca, nunca na guardada em `_cache` — senao a proxima loja
 * (ou a proxima peca) sairia com o titulo desta.
 */
async function montarVitrineStudio(slug, cabecalho = '') {
  try {
    const casca = comCabecalhoDaLoja(apontarParaOApp(await buscarCasca()), cabecalho);
    return casca.replace('</head>', () => recadoParaOApp(slug) + '</head>');
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
  // GA4 e Pixel (04/09/2026): os hosts vem de services/rastreadores.js,
  // o mesmo lugar que decide o que injetar. Lista aqui e lista la
  // divergindo e o script carregando e a CSP bloqueando em silencio.
  const R = HOSTS_DOS_RASTREADORES;
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${HOST_DO_APP} https://cdnjs.cloudflare.com https://static.cloudflareinsights.com ${R.script.join(' ')}`,
    "script-src-attr 'unsafe-inline'",
    `style-src 'self' 'unsafe-inline' ${HOST_DO_APP} https://fonts.googleapis.com`,
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    `connect-src 'self' ${HOST_DO_APP} ${baseDaApi} https://cloudflareinsights.com https://viacep.com.br https://brasilapi.com.br https://r2.getaura.com.br https://*.r2.dev ${R.connect.join(' ')}`,
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
  // Previa do link (BE-1, 25/09/2026).
  metatagsDaVitrineStudio, comCabecalhoDaLoja, precoEmReais, textoCurto, fotoDaPeca,
  limparCache,
};
