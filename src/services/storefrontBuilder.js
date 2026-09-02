// ============================================================
// AURA. — Storefront Builder Service
// Monta o objeto de dados da loja (produtos, variantes, config)
//
// v2 (15/05/2026): expõe accent_color, dark_mode, font_family,
// card_style, banners[], announcement_bar, service_cards[] pro template novo.
// Cai em fallbacks pra empresas pré-migration 115/116.
//
// Fase 4 (18/05/2026): tentou trocar semantica de featured_product_ids
//   para "ordm de destaque" + adicionou hidden_product_ids para opt-out.
//
// Fase 4.1 (18/05/2026 — ROLLBACK): voltou ao modelo simples original.
//   featured_product_ids[] eh INCLUSION list:
//     - Vazio  => mostra TODOS os produtos ativos (default).
//     - Cheio  => mostra SO os listados, na ordem do array.
//   hidden_product_ids fica DORMENTE — parseHiddenIds segue exportado para
//   nao quebrar imports externos, mas e ignorado no storefront publico.
//
// fix (20/05/2026): variantes ordenadas por tamanho numérico ASC (menor → maior).
//   Usa split_part(sku_suffix, '/', 1) para lidar com ranges tipo "25/26".
//
// Fase 5 (20/05/2026):
//   • Expõe pickup_address, pickup_eta_text, delivery_eta_text,
//     delivery_pricing_mode, delivery_free_above_amount, business_hours
//     no payload publico (template consome).
//   • NAO expõe delivery_distance_tiers (so via /shipping-quote).
//   • Adiciona is_open_now (bool) e next_open_text (string),
//     computados em timezone America/Sao_Paulo.
//
// Fase 2 (21/05/2026):
//   • Consulta companies_payment_gateways para expor has_card (gateway MP).
//   • has_pix agora inclui gateway MP (Pix automático) além da chave estática.
//
// Migration 121 (21/05/2026):
//   • has_card respeita config.card_enabled (toggle independente das credenciais).
//     Default true — lojas existentes mantêm comportamento.
//
// (22/05/2026): expõe storefront_url — custom domain quando ativo,
//   senão https://loja.getaura.com.br/<slug>. Consumido pelo aura-app
//   (TabMeuSite) para exibir o link correto ao operador.
//
// (23/05/2026): variantes expõem image_url. Template (products.js)
//   usa primeira variante com imagem como fallback quando produto pai
//   nao tem image_url; template (product_detail.js) troca a imagem
//   principal quando o usuario seleciona uma cor com imagem propria.
//   Migration 129 adicionou product_variants.image_url.
// ============================================================
'use strict';

const db = require('../config/database');
// O rodape institucional e o MESMO nas duas lojas — ver o modulo.
const { montarRodape } = require('./rodapeInstitucional');
// A tira de categorias da home: quem entra e regra unica das duas lojas.
const { montarTira } = require('./tiraDeCategorias');
// Redesign 09/2026: os blocos da home nascem do estoque e do Caixa. As
// regras (janela, minimo, limite) moram la, nao aqui nem no template.
const { montarHome, capasDasCategorias, ehNovo } = require('./homeDaLoja');

const DEFAULT_SERVICE_CARDS = [
  { icon: 'truck',   title: 'Entrega rápida',      body: 'Confirmação no WhatsApp', enabled: true },
  { icon: 'pkg',     title: 'Embalagem cuidadosa', body: 'Pronta pra presentear',   enabled: true },
  { icon: 'shield',  title: 'Pagamento seguro',    body: 'Pix e demais opções',     enabled: true },
  { icon: 'sparkle', title: 'Curadoria editada',   body: 'Produtos selecionados',   enabled: true },
];

const ALLOWED_ICONS = ['truck','pkg','shield','sparkle','leaf','heart','star','pix','card','receipt','bag','user'];

const WEEK_KEYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const WEEK_LABELS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function parseFeaturedIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
  }
  return [];
}

function parseHiddenIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
  }
  return [];
}

function parseBanners(raw, fallbackCover, fallbackTagline, fallbackDesc) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch {}
  }
  if (!arr.length && (fallbackCover || fallbackTagline)) {
    arr = [{
      kicker: '', headline: fallbackTagline || 'Bem-vindo à nossa loja',
      // Sem CTA no banner de fallback: os produtos estao logo abaixo e
      // um botao que rola 200px e ruido fingindo utilidade. CTA so
      // quando a lojista escreve um, no banner dela.
      body: fallbackDesc || '', cta: '',
      tone: 'split', tint: 'brand',
      image_url: fallbackCover || null, enabled: true,
    }];
  }
  return arr.slice(0, 3).map((b) => ({
    kicker:    typeof b?.kicker === 'string'    ? b.kicker    : '',
    headline:  typeof b?.headline === 'string'  ? b.headline  : '',
    body:      typeof b?.body === 'string'      ? b.body      : '',
    cta:       typeof b?.cta === 'string'       ? b.cta       : '',
    // CTA so com destino de verdade. "Ver produtos" que rola 200px ate a
    // grade que ja esta na tela e ruido fingindo utilidade — o mesmo
    // motivo do fallback acima, e ele vale pro banner escrito tambem.
    // Quando o painel mandar cta_url, o CTA vira link; sem destino, o
    // template nao desenha botao nenhum. So http(s): javascript: e
    // afins nao passam.
    // Redesign 09/2026: alem de http(s), o CTA pode apontar pra uma
    // categoria DA PROPRIA loja, no formato `#cat=/caminho`. E o destino
    // que o design pede ("Ver a colecao" -> Vestidos) e a loja resolve
    // sem sair da pagina — a sacola, que vive no navegador, sobrevive.
    cta_url:   destinoDoCta(b?.cta_url),
    tone:      ['split','editorial','centered'].includes(b?.tone) ? b.tone : 'split',
    tint:      ['brand','accent'].includes(b?.tint) ? b.tint : 'brand',
    image_url: typeof b?.image_url === 'string' && b.image_url ? b.image_url : null,
    enabled:   b?.enabled !== false,
  })).filter((b) => b.enabled && (b.headline || b.image_url || b.body || b.kicker));
}

/**
 * O que conta como destino de CTA: http(s) ou categoria da loja.
 *
 * `#cat=/vestidos` e o unico formato interno aceito — o caminho e o
 * `path` da arvore, o mesmo que a tira e a barra usam pra filtrar. Tudo
 * que nao for isso nem http(s) (javascript:, data:, caminho solto) vira
 * vazio, e sem destino o template nao desenha botao nenhum.
 */
function destinoDoCta(raw) {
  const u = typeof raw === 'string' ? raw.trim() : '';
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (/^#cat=\/[a-z0-9][a-z0-9\-\/]*$/i.test(u)) return u;
  return '';
}

function parseServiceCards(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch {}
  }
  if (!arr.length) arr = DEFAULT_SERVICE_CARDS;
  return arr.slice(0, 4).map((c) => ({
    icon:    ALLOWED_ICONS.includes(c?.icon) ? c.icon : 'sparkle',
    title:   typeof c?.title === 'string' ? c.title : '',
    body:    typeof c?.body  === 'string' ? c.body  : '',
    enabled: c?.enabled !== false,
  })).filter((c) => c.enabled && (c.title || c.body));
}

function parseBusinessHours(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') return {};
  return obj;
}

function getNowInSaoPaulo() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayIndex = dayMap[map.weekday] ?? 0;
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(map.minute, 10);
  return { hour, minute, dayIndex };
}

/**
 * "HH:MM" em minutos desde a meia-noite. Estrito: 24:00 nao passa.
 *
 * Chegou a aceitar 24:00 como "fim do dia", pra loja 24h fechar depois
 * do ultimo minuto. Era a pergunta errada: 24h nao e um intervalo que
 * por acaso cobre o dia, e um ESTADO — ver always_open logo abaixo.
 * Horario invalido volta a ser so horario invalido.
 */
function parseHHMM(str) {
  if (!str || typeof str !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return h * 60 + mn;
}

/**
 * A loja esta aberta agora?
 *
 * @param businessHours mapa dia -> { open, close, closed }.
 * @param alwaysOpen loja 24h (migration 310). Curto-circuita tudo: e um
 *   ESTADO declarado, nao um intervalo que por acaso cobre o dia. A
 *   tentativa de expressar 24h como 00:00–23:59 deixava a loja Fechada
 *   no ultimo minuto de todo dia; como 00:00–24:00, o parse rejeitava e
 *   ela ficava Fechada o dia INTEIRO. Aconteceu em producao (29/08/2026).
 * @param agora opcional, so pra teste: { hour, minute, dayIndex }. Sem
 *   ele usa o relogio de Sao Paulo. Existe porque a unica forma de
 *   verificar "aberta as 23:59" era recortar a funcao com regex do
 *   arquivo — e o recorte trazia junto os `require` do modulo.
 */
function computeOpenState(businessHours, alwaysOpen, agora) {
  if (alwaysOpen === true) return { is_open_now: true, next_open_text: '' };
  const hours = parseBusinessHours(businessHours);
  if (!hours || !Object.keys(hours).length) {
    return { is_open_now: true, next_open_text: '' };
  }

  const { hour, minute, dayIndex } = agora || getNowInSaoPaulo();
  const nowMinutes = hour * 60 + minute;

  const todayKey = WEEK_KEYS[dayIndex];
  const today = hours[todayKey];

  if (today && !today.closed) {
    const openM = parseHHMM(today.open);
    const closeM = parseHHMM(today.close);
    // Dia marcado como aberto mas com horario ilegivel: erro de
    // cadastro, nao fechamento. Antes caia direto no laco de baixo e a
    // loja anunciava "Fechada, abre amanha" o dia todo — sem erro, sem
    // sinal, e a lojista so descobre pela venda que nao veio. Entre
    // errar pra aberta e errar pra fechada, aberta custa menos.
    if (openM == null || closeM == null) {
      console.error('[storefront] horario ilegivel em', todayKey, today);
      return { is_open_now: true, next_open_text: '' };
    }
    if (nowMinutes >= openM && nowMinutes < closeM) {
      return { is_open_now: true, next_open_text: '' };
    }
  }

  for (let i = 0; i < 7; i++) {
    const checkIdx = (dayIndex + i) % 7;
    const key = WEEK_KEYS[checkIdx];
    const day = hours[key];
    if (!day || day.closed) continue;
    const openM = parseHHMM(day.open);
    if (openM == null) continue;
    if (i === 0 && nowMinutes < openM) {
      return {
        is_open_now: false,
        next_open_text: `Abre hoje às ${day.open}`,
      };
    }
    if (i > 0) {
      const label = WEEK_LABELS[checkIdx];
      const prefix = i === 1 ? 'Abre amanhã' : `Abre ${label}`;
      return {
        is_open_now: false,
        next_open_text: `${prefix} às ${day.open}`,
      };
    }
  }

  return { is_open_now: false, next_open_text: '' };
}

/** 12.345.678/0001-90 — ou '' quando o CNPJ nao tem 14 digitos. */
function formatarCnpj(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length !== 14) return '';
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function reais(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const inteiro = Math.floor(n);
  return 'R$ ' + (n === inteiro ? String(inteiro) : n.toFixed(2).replace('.', ','));
}

/**
 * A barra de anuncio quando a lojista nao escreveu uma.
 *
 * Composta SO do que ela ligou: frete gratis acima de X (entrega ligada e
 * valor cadastrado), troca em ate 7 dias (e lei — art. 49 do CDC — e vale
 * pra toda loja) e o desconto do Pix (migration 309). O design trazia
 * "Frete gratis acima de R$ 299 · 5% off no Pix" fixo; decisao 16 de
 * 02/09/2026: texto comercial nasce da configuracao ou nao existe.
 */
function anuncioAutomatico({ delivery_enabled, delivery_free_above_amount, pix_discount_pct }) {
  const partes = [];
  const piso = Number(delivery_free_above_amount);
  if (delivery_enabled === true && Number.isFinite(piso) && piso > 0) {
    partes.push('Frete grátis acima de ' + reais(piso));
  }
  partes.push('Troca em até 7 dias');
  const pix = Number(pix_discount_pct);
  if (Number.isFinite(pix) && pix > 0) {
    partes.push((Number.isInteger(pix) ? String(pix) : String(pix).replace('.', ',')) + '% off no Pix');
  }
  return partes.join(' · ');
}

const DIA_CURTO = { dom: 'Dom', seg: 'Seg', ter: 'Ter', qua: 'Qua', qui: 'Qui', sex: 'Sex', sab: 'Sáb' };
const ORDEM_SEMANA = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];

function horaCurta(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return '';
  const h = String(parseInt(m[1], 10));
  return m[2] === '00' ? h + 'h' : h + 'h' + m[2];
}

/**
 * "Seg a sáb, 9h às 18h" — o horario num rodape, nao numa tabela.
 *
 * Agrupa dias CONSECUTIVOS com o mesmo horario; grupos diferentes viram
 * "Seg a sex, 9h às 18h · Sáb, 9h às 13h". 24h vira "Aberta 24 horas".
 * Sem horario cadastrado, ''. Horario ilegivel e ignorado (nao inventa).
 */
function resumoDeHorario(businessHours, alwaysOpen) {
  if (alwaysOpen === true) return 'Aberta 24 horas';
  const h = parseBusinessHours(businessHours);
  if (!h || !Object.keys(h).length) return '';
  const grupos = [];
  for (const dia of ORDEM_SEMANA) {
    const d = h[dia];
    if (!d || d.closed) continue;
    const abre = horaCurta(d.open), fecha = horaCurta(d.close);
    if (!abre || !fecha) continue;
    const faixa = abre + ' às ' + fecha;
    const ultimo = grupos[grupos.length - 1];
    const idx = ORDEM_SEMANA.indexOf(dia);
    if (ultimo && ultimo.faixa === faixa && ultimo.fimIdx === idx - 1) {
      ultimo.fim = dia; ultimo.fimIdx = idx;
    } else {
      grupos.push({ inicio: dia, fim: dia, fimIdx: idx, faixa });
    }
  }
  if (!grupos.length) return '';
  return grupos.map((g) => {
    const dias = g.inicio === g.fim ? DIA_CURTO[g.inicio] : DIA_CURTO[g.inicio] + ' a ' + DIA_CURTO[g.fim].toLowerCase();
    return dias + ', ' + g.faixa;
  }).join(' · ');
}

function listVisibilityWhere(cidParam) {
  return `(company_id = ${cidParam} OR (
    is_group_shared = true
    AND company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

/**
 * Quantos produtos a loja TEM, nao quantos couberam no payload.
 *
 * O `LIMIT 500` abaixo e uma decisao de peso de pagina, nao de catalogo: a
 * Finesse tem 1302 produtos e a pagina ja sai com 419 KB nos 500. O
 * problema nao era o teto — era o silencio. Sem esta contagem a loja
 * afirmava "500 produtos" e 802 sumiam sem aviso, para a lojista e para a
 * cliente.
 */
// A pagina nasce com UMA pagina de produtos, nao com o catalogo. Antes
// eram 500 (419 KB na Finesse) pra desenhar 24. O resto chega pela rota
// /storefront/:slug/catalogo conforme a cliente navega.
const { POR_PAGINA, EM_ESTOQUE, filtroDeFoto, contarPorCategoria, arvoreDeCategorias, facetasDoCatalogo, faixaDePreco } = require('./catalogoPaginado');
const LIMITE_DO_PAYLOAD = POR_PAGINA;

async function contarProdutosDaLoja(cid, exigeFoto) {
  const sql = `
    SELECT COUNT(*)::int AS n
    FROM products
    WHERE ${listVisibilityWhere('$1')}
      AND is_active IS NOT FALSE
      AND ${EM_ESTOQUE}
      AND ${filtroDeFoto(exigeFoto)}
  `;
  try {
    const { rows } = await db.query(sql, [cid]);
    return rows[0] ? rows[0].n : 0;
  } catch (e) {
    // Contagem e informativa: se falhar, a loja abre sem o aviso.
    return 0;
  }
}

/**
 * Variantes de um lote de produtos, no formato do payload publico.
 *
 * Extraido de buildStorefront em 23/08/2026 para a rota paginada usar a
 * MESMA montagem. Sem isso, a grade paginada receberia produto sem
 * `variants` e sem `in_stock`, e o cartao renderizaria diferente do
 * cartao da primeira pagina — que veio do payload embutido.
 */
async function fetchVariantesPorProduto(productIds) {
  const porProduto = {};
  if (!productIds || productIds.length === 0) return porProduto;

  // 23/05/2026: inclui pv.image_url no SELECT (Migration 129).
  const { rows: variantRows } = await db.query(`
    SELECT pv.id, pv.product_id, pv.sku_suffix,
           pv.price_override, pv.stock_qty, pv.is_active, pv.image_url,
           COALESCE(
             json_agg(
               json_build_object('attribute', pvv.attribute_name, 'value', pvv.value)
               ORDER BY pvv.attribute_name
             ) FILTER (WHERE pvv.id IS NOT NULL),
             '[]'::json
           ) AS values
    FROM product_variants pv
    LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
    WHERE pv.product_id = ANY($1::uuid[]) AND pv.is_active = true
    GROUP BY pv.id
    ORDER BY
      CAST(NULLIF(regexp_replace(split_part(pv.sku_suffix, '/', 1), '[^0-9]', '', 'g'), '') AS numeric) NULLS LAST,
      pv.sku_suffix ASC
  `, [productIds]);

  for (const v of variantRows) {
    if (!porProduto[v.product_id]) porProduto[v.product_id] = [];
    porProduto[v.product_id].push({
      id: v.id, sku_suffix: v.sku_suffix,
      price_override: v.price_override !== null ? parseFloat(v.price_override) : null,
      stock_qty: parseFloat(v.stock_qty),
      image_url: v.image_url || null,
      values: v.values || [],
    });
  }
  return porProduto;
}

/** Uma linha de produto no formato do payload publico. */
function montarProdutoPublico(p, { variantsByProduct, categoryById, primaryLinkByProduct, mostrarPrecos }) {
  const pvariants = variantsByProduct[p.id] || [];
  const hasVariants = pvariants.length > 0;
  const inStock = hasVariants ? pvariants.some(v => v.stock_qty > 0) : p.stock_qty > 0;
  const cat = categoryById[primaryLinkByProduct[p.id]] || null;
  return {
    id: p.id, name: p.name, description: p.description,
    price: mostrarPrecos ? parseFloat(p.price) : null,
    image_url: p.image_url,
    gallery_urls: Array.isArray(p.gallery_urls) ? p.gallery_urls : [],
    category: p.category,
    // Migration 305 — ficha tecnica. NULL quando a lojista nao preencheu,
    // e ai a secao simplesmente nao aparece na loja.
    material: p.material || null,
    medidas:  p.medidas  || null,
    cuidados: p.cuidados || null,
    category_id:   cat ? cat.id   : null,
    category_slug: cat ? cat.slug : null,
    category_path: cat ? cat.path : null,
    // Redesign 09/2026 — selo NOVO. Decidido por peca, a partir do
    // cadastro, na regra de homeDaLoja (14 dias). A vitrine Studio le a
    // mesma funcao.
    is_new: ehNovo(p.created_at),
    stock_qty: p.stock_qty, in_stock: inStock, variants: pvariants,
  };
}

async function fetchStorefrontProducts(cid, featuredIds, _hiddenIds, exigeFoto) {
  const visibility = listVisibilityWhere('$1');
  // migration 308. Entra nos DOIS caminhos abaixo — o curado e o normal.
  // Aplicar so num deles faria a loja com destaques ignorar a regra.
  const comFoto = filtroDeFoto(exigeFoto);

  if (featuredIds && featuredIds.length > 0) {
    const sql = `
      SELECT id, name, description, price, image_url, gallery_urls, category, stock_qty, created_at,
             material, medidas, cuidados
      FROM products
      WHERE ${visibility}
        AND is_active IS NOT FALSE
        AND ${EM_ESTOQUE}
        AND ${comFoto}
        AND id::text = ANY($2)
      ORDER BY array_position($2, id::text)
      LIMIT ${LIMITE_DO_PAYLOAD}
    `;
    const { rows } = await db.query(sql, [cid, featuredIds]);
    return rows;
  }

  const sql = `
    SELECT id, name, description, price, image_url, gallery_urls, category, stock_qty, created_at,
           material, medidas, cuidados
    FROM products
    WHERE ${visibility}
      AND is_active IS NOT FALSE
      AND ${EM_ESTOQUE}
      AND ${comFoto}
    ORDER BY created_at DESC
    LIMIT ${LIMITE_DO_PAYLOAD}
  `;
  const { rows } = await db.query(sql, [cid]);
  return rows;
}

// ── D3 (18/08/2026): taxonomia no payload público ────────────
//
// REGRA INEGOCIÁVEL: ADICIONA, NUNCA REMOVE. O campo `category` (texto)
// continua em cada produto pelo mesmo princípio do dual-write da
// migration 259 -- consumidor que lê o payload hoje (template da
// vitrine, integração externa, app) não pode quebrar. Depreciação só
// quando a lista de leitores estiver vazia.
//
// Só categorias com is_visible_storefront entram: a árvore interna do
// lojista não é necessariamente a navegação que ele quer pública.
//
// O `slug` sai no payload de propósito -- é a semente das URLs
// canônicas por categoria da fase de vitrine.
//
// Defensivo: sem as migrations 257/258 (42P01/42703) devolve vazio e o
// payload sai idêntico ao de antes (CLAUDE.md, armadilhas 1 e 10).

async function fetchStorefrontCategories(cid) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, slug, path, depth, parent_id, sort_order
         FROM product_categories
        WHERE company_id = $1
          AND type = 'product'
          AND is_visible_storefront IS NOT FALSE
        ORDER BY depth, sort_order NULLS LAST, name`,
      [cid]
    );
    return rows;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return [];
    throw e;
  }
}

// Vínculo PRIMÁRIO de cada produto. Secundárias ficam de fora do payload
// v1: navegação por faceta é da fase de vitrine, e mandar todos os
// vínculos agora inflaria o payload sem consumidor.
async function fetchPrimaryCategoryLinks(productIds) {
  if (!productIds.length) return {};
  try {
    const { rows } = await db.query(
      `SELECT product_id, category_id
         FROM product_category_links
        WHERE product_id = ANY($1::uuid[]) AND is_primary`,
      [productIds]
    );
    const map = {};
    rows.forEach(r => { map[r.product_id] = r.category_id; });
    return map;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return {};
    throw e;
  }
}

async function buildStorefront(config) {
  const cid = config.company_id;
  const featuredIds = parseFeaturedIds(config.featured_product_ids);
  const hiddenIds   = parseHiddenIds(config.hidden_product_ids);

  // migration 308 — a lojista pode pedir que so pecas com foto
  // aparecam. O valor vem do SELECT * da rota; base sem a migration
  // devolve undefined, que filtroDeFoto trata como desligado.
  const exigeFoto = config.require_product_image === true;

  const products = await fetchStorefrontProducts(cid, featuredIds, hiddenIds, exigeFoto);
  const catalogoTotal = await contarProdutosDaLoja(cid, exigeFoto);
  // Barra de categorias: vem do BANCO, nao dos produtos carregados. Ver
  // contarPorCategoria — com paginacao de 24, derivar da pagina mostrava
  // so as categorias que caiam nela.
  // A barra prefere a ARVORE. So cai no texto plano quando a loja nao
  // tem arvore povoada — hoje 4 das lojas em producao tem, e as outras
  // nao podem parar de funcionar por causa disso.
  let categoriasComTotal = [];
  let arvoreBarra = [];
  try {
    arvoreBarra = await arvoreDeCategorias({ cid, visibilityWhere: listVisibilityWhere('$1'), exigeFoto });
  } catch (e) { arvoreBarra = []; }
  // Facetas de tamanho e cor. Vem do banco inteiro, nao da pagina 1: com
  // paginacao de 24, derivar dos produtos carregados daria um filtro que
  // muda de opcoes conforme a pessoa navega.
  let facetas = {};
  try {
    facetas = await facetasDoCatalogo({ cid, visibilityWhere: listVisibilityWhere('$1'), exigeFoto });
  } catch (e) {
    // Ver o catch de facetasDoCatalogo: silencio aqui ja escondeu dois
    // bugs de SQL em producao.
    console.error('[storefront] facetas indisponiveis:', e.message);
    facetas = {};
  }

  if (!arvoreBarra.length) {
    try {
      categoriasComTotal = await contarPorCategoria({ cid, visibilityWhere: listVisibilityWhere('$1'), exigeFoto });
    } catch (e) { categoriasComTotal = []; }
  }

  // D3: árvore + vínculo primário. Só categorias visíveis na vitrine
  // entram, e o produto só recebe categoria que esteja nesse conjunto --
  // produto compartilhado de outra empresa não pode arrastar a categoria
  // dela para o payload público desta loja.
  // Faixa de preco (redesign 09/2026): a pagina de categoria desenha as
  // faixas a partir do menor e do maior preco da loja. null = sem filtro.
  facetas.preco = await faixaDePreco({ cid, visibilityWhere: listVisibilityWhere('$1'), exigeFoto });

  const categories = await fetchStorefrontCategories(cid);
  const categoryById = {};
  categories.forEach(c => { categoryById[c.id] = c; });
  const primaryLinkByProduct = await fetchPrimaryCategoryLinks(products.map(p => p.id));

  // Blocos da home (redesign 09/2026). As linhas vem cruas do servico e
  // passam por montarProdutoPublico com os MESMOS mapas da grade — o
  // cartao de "Mais vendidos" e o cartao da pagina 2 sao o mesmo cartao.
  // Os produtos dos blocos podem nao estar na pagina 1, entao as
  // variantes deles sao buscadas junto.
  const mostrarPrecos = config.show_prices !== false;
  const homeBruta = await montarHome({
    cid, visibilityWhere: listVisibilityWhere('$1'), exigeFoto,
  });
  const idsDaHome = []
    .concat(homeBruta.mais_vendidos, homeBruta.ultimas_unidades, homeBruta.novidades)
    .map(p => p.id);
  const idsComVariante = Array.from(new Set(products.map(p => p.id).concat(idsDaHome)));
  const variantsByProduct = await fetchVariantesPorProduto(idsComVariante);
  const linksDaHome = await fetchPrimaryCategoryLinks(idsDaHome);

  const mapear = (p) => montarProdutoPublico(p, {
    variantsByProduct, categoryById,
    primaryLinkByProduct: Object.assign({}, linksDaHome, primaryLinkByProduct),
    mostrarPrecos,
  });
  const home = {
    mais_vendidos:    homeBruta.mais_vendidos.map(p => Object.assign(mapear(p), { vendidos: p.vendidos })),
    ultimas_unidades: homeBruta.ultimas_unidades.map(p => Object.assign(mapear(p), { restam: p.restam })),
    novidades:        homeBruta.novidades.map(mapear),
  };

  // Capa das categorias de topo: banner da lojista, ou a foto da peca
  // mais vendida da subarvore. A tira ja saia pronta; ganha `capa_url` e
  // continua mandando `banner_url` pra quem ja le.
  const tira = montarTira(arvoreBarra);
  if (tira.length) {
    let capas = {};
    try {
      capas = await capasDasCategorias({ cid, visibilityWhere: listVisibilityWhere('$1'), exigeFoto });
    } catch (e) {
      console.error('[home] capas de categoria falharam (' + e.code + '):', e.message);
    }
    for (const c of tira) {
      c.capa_url = c.banner_url || capas[c.caminho] || null;
      c.capa_origem = c.banner_url ? 'banner' : (capas[c.caminho] ? 'produto' : null);
    }
  }

  const { rows: companies } = await db.query(
    `SELECT trade_name, legal_name, logo_url, cnpj FROM companies WHERE id = $1`, [cid]);
  const company = companies[0] || {};

  // Fase 2 (21/05/2026): detecta gateway MP para expor has_card e corrigir has_pix
  let hasMpGateway = false;
  try {
    const { rows: gws } = await db.query(
      `SELECT id FROM companies_payment_gateways WHERE company_id = $1 AND gateway = 'mercadopago' LIMIT 1`,
      [cid]
    );
    hasMpGateway = gws.length > 0;
  } catch (_) { /* tabela pode não existir em deployment antigo */ }

  const hasStaticPix = !!(config.pix_key && String(config.pix_key).trim());
  const hasPix = hasStaticPix || hasMpGateway;
  // Migration 121: card_enabled toggle (default true se coluna não existe)
  const cardEnabled = config.card_enabled !== false;
  const payOnDeliveryEnabled = !!config.pay_on_delivery_enabled;

  const banners = parseBanners(config.banners, config.cover_url, config.tagline, config.description);
  const serviceCards = parseServiceCards(config.service_cards);

  const businessHours = parseBusinessHours(config.business_hours);
  // always_open chega undefined enquanto a migration 310 nao rodou; o
  // `=== true` la dentro trata isso como "nao e 24h", que e o padrao.
  const alwaysOpen = config.always_open === true;
  const { is_open_now, next_open_text } = computeOpenState(businessHours, alwaysOpen);

  return {
    site: {
      name:          config.site_name || company.trade_name || company.legal_name || 'Loja',
      tagline:       config.tagline       || '',
      description:   config.description   || '',
      primary_color: config.primary_color || '#7c3aed',
      accent_color:  config.accent_color  || config.secondary_color || '#a78bfa',
      dark_mode:     !!config.dark_mode,
      font_family:   config.font_family   || 'classic',
      card_style:    config.card_style    || 'editorial',
      announcement_bar: config.announcement_bar || '',
      logo_url:      config.logo_url  || company.logo_url || null,
      cover_url:     config.cover_url || null,
      // Redesign 09/2026: o rodape em tres colunas mostra o CNPJ ao lado
      // do copyright, como todo e-commerce. Vem de companies, ja lido.
      cnpj:          company.cnpj || null,
      cnpj_formatado: formatarCnpj(company.cnpj),
      // Barra de anuncio composta do que a lojista LIGOU (fase 3). So
      // vale quando ela nao escreveu a dela. '' = sem barra.
      announcement_auto: anuncioAutomatico({
        delivery_enabled: config.delivery_enabled || false,
        delivery_free_above_amount: config.delivery_free_above_amount,
        pix_discount_pct: Number(config.pix_discount_pct) || 0,
      }),
      // "Seg a sáb, 9h às 18h" pro rodape. '' quando nao ha horario.
      horario_resumo: resumoDeHorario(businessHours, alwaysOpen),
      banners,
      service_cards: serviceCards,
      is_open_now,
      next_open_text,
    },
    contact: {
      phone:     config.phone     || '',
      whatsapp:  config.whatsapp  || '',
      instagram: config.instagram || '',
      address:   config.address   || '',
      pickup_address: config.pickup_address || null,
    },
    business_hours: businessHours,
    // Quem desenha a grade de horarios precisa saber que ela nao vale:
    // com always_open, business_hours fica no banco mas nao decide nada.
    always_open: alwaysOpen,
    settings: {
      show_prices:      config.show_prices !== false,
      show_stock:       config.show_stock  || false,
      pickup_enabled:   config.pickup_enabled   !== false,
      delivery_enabled: config.delivery_enabled || false,
      // migration 288 — retirada por app (cliente contrata Uber/99).
      // Default false: a modalidade so aparece depois que a lojista liga.
      courier_pickup_enabled: config.courier_pickup_enabled === true,
      delivery_fee:     parseFloat(config.delivery_fee) || 0,
      has_pix:                  hasPix,
      // Migration 121: has_card respeita card_enabled toggle
      has_card:                 hasMpGateway && cardEnabled,
      // Migration 301 — teto de parcelas declarado pela lojista. Sem
      // cartao nao ha o que parcelar, entao o campo so sai com has_card.
      card_max_installments: (hasMpGateway && cardEnabled)
        ? (config.card_max_installments || null)
        : null,
      pay_on_delivery_enabled:  payOnDeliveryEnabled,
      pickup_eta_text:   config.pickup_eta_text   || null,
      delivery_eta_text: config.delivery_eta_text || null,
      delivery_pricing_mode: config.delivery_pricing_mode || 'flat',
      delivery_free_above_amount: config.delivery_free_above_amount != null
        ? parseFloat(config.delivery_free_above_amount)
        : null,
    },
    products: products.map(p => montarProdutoPublico(p, {
      variantsByProduct, categoryById, primaryLinkByProduct,
      mostrarPrecos,
    })),
    // Redesign 09/2026 — os blocos da home, ja no formato de produto da
    // grade: { mais_vendidos[], ultimas_unidades[] (com `restam`),
    // novidades[] (com `is_new`) }. Lista vazia = o bloco nao aparece.
    home,
    total_products: products.length,
    // Quantos a loja tem de verdade — ver contarProdutosDaLoja.
    catalog_total: catalogoTotal,
    payload_limit: LIMITE_DO_PAYLOAD,
    // [{ nome, total }] — ver contarPorCategoria.
    categorias_barra: categoriasComTotal,
    // [] quando a loja nao tem arvore — o cliente decide qual usar.
    categorias_arvore: arvoreBarra,
    // Tira de categorias da home: so o primeiro nivel, e so a partir de
    // tres. Vazia = a loja nao desenha nada, sem precisar saber do
    // limiar. Ver services/tiraDeCategorias.js.
    tira_de_categorias: tira,
    facetas,
    // Migration 309. 0 = nao mostra nada no cartao.
    pix_discount_pct: Number(config.pix_discount_pct) || 0,
    // Migration 306 — politica de troca do rodape. NULL faz o template
    // usar o texto padrao.
    politica_troca: config.politica_troca || null,
    // Rodape institucional JA RESOLVIDO. A vitrine Studio nao remonta a
    // lista de formas nem repete o texto padrao: se repetisse, uma
    // correcao no texto valeria numa loja e nao na outra.
    rodape_institucional: montarRodape({
      has_pix: hasPix,
      has_card: hasMpGateway && cardEnabled,
      pay_on_delivery_enabled: payOnDeliveryEnabled,
    }, config.politica_troca),
    // D3: lista FLAT com parent_id -- o cliente deriva a hierarquia, mesmo
    // formato que o GET /product-categories já usa (contrato §10). Vazia
    // em base sem as migrations 257/258.
    categories: categories.map(c => ({
      id: c.id, name: c.name, slug: c.slug,
      path: c.path, depth: c.depth, parent_id: c.parent_id,
    })),
    // URL canônica da loja — custom domain quando ativo, senão loja.getaura.com.br/slug.
    // Consumida pelo aura-app (TabMeuSite) para exibir o link correto ao operador.
    storefront_url: (config.custom_domain && config.custom_domain_status === 'active')
      ? `https://${config.custom_domain}`
      : `https://loja.getaura.com.br/${config.slug}`,
  };
}

module.exports = {
  // parseHHMM so e exportado pra teste: ver __tests__/horario24h.test.js.
  // computeOpenState ja saia daqui embaixo.
  parseHHMM,
  buildStorefront, parseFeaturedIds, parseHiddenIds, computeOpenState,
  // Exportado pra teste: o formato interno `#cat=/caminho` e contrato
  // com o painel (aura-app, destinoDoCta.ts).
  destinoDoCta,
  // Fase 3: barra de anuncio composta, horario do rodape, CNPJ.
  anuncioAutomatico, resumoDeHorario, formatarCnpj,
  // Exportados em 19/08/2026 (S1) para o storefront do Studio montar a
  // MESMA arvore de categorias que a loja comum, em vez de uma segunda
  // implementacao. As duas regras que importam vivem aqui e valem para
  // os dois: so categoria com is_visible_storefront entra, e so o
  // vinculo primario sai no payload.
  fetchStorefrontCategories, fetchPrimaryCategoryLinks,
  // A regra de visibilidade mora AQUI e e exportada em vez de
  // reimplementada: duas versoes da mesma regra e como produto de outra
  // empresa vaza para a loja errada.
  listVisibilityWhere,
  LIMITE_DO_PAYLOAD,
  // Usados pela rota paginada, pra grade nao montar produto de um
  // jeito diferente do payload embutido.
  fetchVariantesPorProduto, montarProdutoPublico,
  // So pra teste: a regra "CTA apenas com destino http(s) de verdade"
  // vive no parse, e o teste precisa exercita-la sem subir banco.
  parseBanners,
};
