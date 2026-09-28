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

// ── O INCIDENTE DE 28/09/2026 ──────────────────────────────────────────
// A casca guardada aponta para `entry-<hash>.js`. Cada deploy do app troca
// o hash e APAGA o arquivo antigo da Cloudflare; o caminho velho passa a
// responder 200 com a pagina de fallback do app (text/html, 2,8 KB). Com
// a casca guardada por 10 minutos, toda loja Studio abria em branco
// depois de todo deploy do app — sem erro visivel. A Sheid Mania ficou
// fora do ar assim. Tres camadas agora:
//
//   1. antes de confiar na casca, confere que o entry ainda e JavaScript
//      (HEAD no app, resultado guardado por VALIDACAO_MS);
//   2. cache curto (VALIDADE_MS) com stale-while-revalidate: a casca
//      guardada sai na hora e a nova e buscada em segundo plano;
//   3. a pagina se cura sozinha: se o entry falhar no navegador, ela
//      recarrega UMA vez com `?_casca=`, e o servidor busca a casca de
//      novo ignorando o cache (no maximo uma vez a cada
//      INTERVALO_FORCADA_MS, contra abuso).

/**
 * Idade a partir da qual a casca guardada e atualizada em segundo plano.
 * Quem pede nesse momento ainda recebe a guardada: custo zero por
 * requisicao, e o deploy do app chega em ~1 minuto.
 */
const VALIDADE_MS = 60 * 1000;

/** Por quanto tempo vale a conferencia de que o entry e JavaScript. */
const VALIDACAO_MS = 30 * 1000;

/** Intervalo minimo entre duas buscas forcadas por `?_casca=`. */
const INTERVALO_FORCADA_MS = 10 * 1000;

/** O caminho que identifica o bundle principal do Expo. */
const CAMINHO_DO_ENTRY = '/_expo/static/js/web/entry-';

// { html, entry, buscadaEm, validadaEm }
let _cache = null;
let _atualizando = null;  // a busca em segundo plano em andamento
let _validando = null;    // a conferencia do entry em andamento
let _ultimaForcada = 0;

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

/** O caminho do `entry-<hash>.js` que a casca carrega, ou null. */
function entryDaCasca(html) {
  const m = /(?:src|href)="(\/_expo\/static\/js\/web\/entry-[^"?#]+\.js)[^"]*"/.exec(String(html || ''));
  return m ? m[1] : null;
}

/**
 * O entry ainda existe no app como JavaScript?
 *
 * 'js' | 'nao-js' | 'erro'. 'nao-js' e o caso do incidente: o arquivo
 * sumiu e a Cloudflare responde 200 com a pagina de fallback (text/html).
 * 'erro' e nao conseguir perguntar (timeout, rede) — nao prova que a
 * casca esta quebrada, entao quem chama nao a descarta por isso.
 */
async function conferirEntry(caminho) {
  const url = HOST_DO_APP + caminho;
  try {
    let r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    if (r.status === 405 || r.status === 501) {
      // Host que nao aceita HEAD: um byte so, com range.
      r = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(3000) });
      if (r.body && typeof r.body.cancel === 'function') r.body.cancel().catch(() => {});
    }
    if (!r.ok) return 'nao-js';
    const tipo = String((r.headers && r.headers.get('content-type')) || '');
    return /javascript|ecmascript/i.test(tipo) ? 'js' : 'nao-js';
  } catch (err) {
    console.warn('[vitrineStudio] nao deu para conferir o entry:', err.message);
    return 'erro';
  }
}

/**
 * Busca a casca no app e confere o entry dela. Lanca se o app estiver
 * fora, se a casca vier sem bundle ou se o bundle dela nao for JS.
 */
async function buscarCascaNova() {
  const r = await fetch(HOST_DO_APP + '/', {
    headers: { Accept: 'text/html', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('app respondeu ' + r.status);

  const html = await r.text();
  // Casca sem bundle nao renderiza nada: melhor falhar aqui, e cair na
  // loja comum, do que servir uma pagina em branco.
  if (!/_expo\/static\/js/.test(html)) throw new Error('casca do app sem bundle');

  const entry = entryDaCasca(html);
  const agora = Date.now();
  if (entry) {
    const estado = await conferirEntry(entry);
    if (estado === 'nao-js') throw new Error('entry da casca nova nao e JavaScript: ' + entry);
  }
  return { html, entry, buscadaEm: agora, validadaEm: agora };
}

/**
 * Troca a casca guardada por uma nova. Se a busca falhar e houver uma
 * guardada, fica com ela (melhor que nada) e registra no log.
 */
async function renovarCasca(motivo) {
  try {
    _cache = await buscarCascaNova();
    return _cache.html;
  } catch (err) {
    if (!_cache) throw err;
    console.warn(`[vitrineStudio] casca nova indisponivel (${motivo}); servindo a guardada:`, err.message);
    return _cache.html;
  }
}

/** Atualizacao em segundo plano, uma de cada vez. Nunca rejeita. */
function atualizarEmSegundoPlano() {
  if (_atualizando) return _atualizando;
  _atualizando = renovarCasca('stale-while-revalidate')
    .catch((err) => { console.warn('[vitrineStudio] atualizacao da casca falhou:', err.message); })
    .finally(() => { _atualizando = null; });
  return _atualizando;
}

/**
 * Confere o entry da casca guardada (no maximo uma vez a cada
 * VALIDACAO_MS, e uma conferencia por vez). Entry que deixou de ser JS
 * derruba o cache e a casca e buscada de novo na hora.
 */
async function validarCascaGuardada() {
  if (_validando) return _validando;
  const guardada = _cache;
  _validando = (async () => {
    if (!guardada.entry) { guardada.validadaEm = Date.now(); return; }
    const estado = await conferirEntry(guardada.entry);
    guardada.validadaEm = Date.now();
    if (estado !== 'nao-js') return;
    console.warn('[vitrineStudio] entry da casca guardada sumiu do app:', guardada.entry);
    await renovarCasca('entry antigo');
  })().finally(() => { _validando = null; });
  return _validando;
}

/**
 * A casca do app. Lanca so quando nao ha casca nenhuma para servir.
 *
 * `forcar` (a pagina pedindo socorro com `?_casca=`): busca de novo
 * ignorando o cache, no maximo uma vez a cada INTERVALO_FORCADA_MS para
 * o parametro nao virar um jeito de martelar o app. Dentro do intervalo,
 * segue o caminho normal — que ja pega a casca que a forcada anterior
 * trouxe.
 */
async function buscarCasca({ forcar = false } = {}) {
  const agora = Date.now();
  if (forcar && agora - _ultimaForcada >= INTERVALO_FORCADA_MS) {
    _ultimaForcada = agora;
    return renovarCasca('forcada pela pagina');
  }

  if (!_cache) return renovarCasca('sem casca guardada');

  if (agora - _cache.validadaEm >= VALIDACAO_MS) await validarCascaGuardada();

  if (Date.now() - _cache.buscadaEm >= VALIDADE_MS) atualizarEmSegundoPlano();
  return _cache.html;
}

/**
 * A autocura no navegador (camada 3).
 *
 * Se o entry nao carregar — o arquivo sumiu, a Cloudflare devolveu HTML
 * e o `nosniff` barrou, ou ele nem chegou a rodar — a pagina recarrega
 * UMA vez com `?_casca=<agora>`, e o servidor busca a casca nova. O
 * `sessionStorage` impede o laco: se falhar de novo, fica como esta.
 * Carregou bem, a marca sai, para o proximo deploy poder se curar
 * tambem. Sem sessionStorage (aba anonima antiga), nao recarrega: sem
 * trava, nao ha como garantir que nao entra em laco.
 *
 * Os sinais: o `error` do proprio <script> (capturado no window, porque
 * erro de recurso nao borbulha); um `error` global cujo `filename` e o
 * entry, antes de o bundle subir; e, no `load`, o `__r` do Metro ausente
 * — o entry define `__r` na primeira linha, entao sem ele o bundle nao
 * rodou (erro cross-origin chega sem `filename`, este e o sinal que
 * sobra).
 *
 * O `_casca` sai da barra de endereco antes do bundle rodar, para o
 * roteador do app nunca ve-lo. Cabe na CSP da vitrine: script inline, e
 * `'unsafe-inline'` ja esta em script-src.
 */
function scriptDeAutocura() {
  const entry = JSON.stringify(CAMINHO_DO_ENTRY);
  return '<script>(function(){'
    + "var K='aura_casca_recarregada',E=" + entry + ',foi=false;'
    + "try{var u=new URL(location.href);if(u.searchParams.has('_casca')){u.searchParams.delete('_casca');"
    + "history.replaceState(history.state,'',u.pathname+u.search+u.hash);}}catch(e){}"
    + 'function subiu(){return typeof window.__r==="function";}'
    + 'function falhou(){if(foi)return;foi=true;'
    + 'try{if(sessionStorage.getItem(K))return;sessionStorage.setItem(K,String(Date.now()));}catch(e){return;}'
    + "var n=new URL(location.href);n.searchParams.set('_casca',String(Date.now()));location.replace(n.href);}"
    + "window.addEventListener('error',function(ev){var t=ev&&ev.target;"
    + "if(t&&t.tagName==='SCRIPT'){if(String(t.src||'').indexOf(E)!==-1)falhou();return;}"
    + "if(!subiu()&&String((ev&&ev.filename)||'').indexOf(E)!==-1)falhou();},true);"
    + "window.addEventListener('load',function(){if(!subiu()){falhou();return;}"
    + 'try{sessionStorage.removeItem(K);}catch(e){}});'
    + '})();</script>';
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
async function montarVitrineStudio(slug, cabecalho = '', { forcarCasca = false } = {}) {
  try {
    const casca = comCabecalhoDaLoja(apontarParaOApp(await buscarCasca({ forcar: forcarCasca })), cabecalho);
    return casca.replace('</head>', () => recadoParaOApp(slug) + scriptDeAutocura() + '</head>');
  } catch (err) {
    console.warn('[vitrineStudio] casca indisponivel:', err.message);
    return null;
  }
}

/**
 * CSP da vitrine Studio.
 *
 * Mais larga que a da loja comum porque o app carrega o proprio bundle
 * de outro dominio nosso, o three.js do cdnjs (o motor 3D da caneca), os
 * loaders do three no jsdelivr (a camiseta em GLB) e as fontes do Google. Cada entrada esta aqui por um motivo; nao ha
 * curinga em script-src.
 */
/**
 * three.js r128 no jsdelivr: GLTFLoader e DRACOLoader (a camiseta 3D) e o
 * decoder Draco em examples/js/libs/draco/ (o .js e o .wasm chegam por
 * fetch, dai tambem em connect-src). So o pacote e a versao que o viewer
 * usa: o jsdelivr serve qualquer pacote do npm, e liberar o host inteiro
 * em script-src seria abrir a porta para script de terceiros (QA 28/09).
 * O 'wasm-unsafe-eval' e o que deixa o decoder .wasm compilar; nao libera
 * eval de JavaScript.
 */
const THREE_DO_JSDELIVR = 'https://cdn.jsdelivr.net/npm/three@0.128.0/';

function cspDaVitrineStudio(baseDaApi) {
  // GA4 e Pixel (04/09/2026): os hosts vem de services/rastreadores.js,
  // o mesmo lugar que decide o que injetar. Lista aqui e lista la
  // divergindo e o script carregando e a CSP bloqueando em silencio.
  const R = HOSTS_DOS_RASTREADORES;
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${HOST_DO_APP} https://cdnjs.cloudflare.com ${THREE_DO_JSDELIVR} 'wasm-unsafe-eval' https://static.cloudflareinsights.com ${R.script.join(' ')}`,
    "script-src-attr 'unsafe-inline'",
    // O decoder Draco roda num Worker criado de um blob: (DRACOLoader do
    // r128). Sem worker-src, o navegador cai em script-src, que nao tem
    // blob:, e o GLB comprimido nao abre.
    "worker-src 'self' blob:",
    `style-src 'self' 'unsafe-inline' ${HOST_DO_APP} https://fonts.googleapis.com`,
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    `connect-src 'self' ${HOST_DO_APP} ${baseDaApi} https://cloudflareinsights.com https://viacep.com.br https://brasilapi.com.br https://r2.getaura.com.br https://*.r2.dev ${THREE_DO_JSDELIVR} ${R.connect.join(' ')}`,
    `font-src 'self' data: ${HOST_DO_APP} https://fonts.gstatic.com`,
    "frame-ancestors *",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** So para teste: esquece a casca guardada e o limite da busca forcada. */
function limparCache() {
  _cache = null; _atualizando = null; _validando = null; _ultimaForcada = 0;
}

/** So para teste: espera a atualizacao em segundo plano terminar. */
function _esperarAtualizacao() { return _atualizando || Promise.resolve(); }

module.exports = {
  HOST_DO_APP,
  ehLojaStudio,
  apontarParaOApp,
  recadoParaOApp,
  montarVitrineStudio,
  cspDaVitrineStudio,
  THREE_DO_JSDELIVR,
  // Previa do link (BE-1, 25/09/2026).
  metatagsDaVitrineStudio, comCabecalhoDaLoja, precoEmReais, textoCurto, fotoDaPeca,
  // Casca sem bundle velho (incidente de 28/09/2026).
  buscarCasca, entryDaCasca, conferirEntry, scriptDeAutocura,
  VALIDADE_MS, VALIDACAO_MS, INTERVALO_FORCADA_MS, CAMINHO_DO_ENTRY,
  limparCache, _esperarAtualizacao,
};
