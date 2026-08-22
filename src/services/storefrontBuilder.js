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
      body: fallbackDesc || '', cta: 'Ver produtos',
      tone: 'split', tint: 'brand',
      image_url: fallbackCover || null, enabled: true,
    }];
  }
  return arr.slice(0, 3).map((b) => ({
    kicker:    typeof b?.kicker === 'string'    ? b.kicker    : '',
    headline:  typeof b?.headline === 'string'  ? b.headline  : '',
    body:      typeof b?.body === 'string'      ? b.body      : '',
    cta:       typeof b?.cta === 'string'       ? b.cta       : '',
    tone:      ['split','editorial','centered'].includes(b?.tone) ? b.tone : 'split',
    tint:      ['brand','accent'].includes(b?.tint) ? b.tint : 'brand',
    image_url: typeof b?.image_url === 'string' && b.image_url ? b.image_url : null,
    enabled:   b?.enabled !== false,
  })).filter((b) => b.enabled && (b.headline || b.image_url || b.body || b.kicker));
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

function parseHHMM(str) {
  if (!str || typeof str !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return h * 60 + mn;
}

function computeOpenState(businessHours) {
  const hours = parseBusinessHours(businessHours);
  if (!hours || !Object.keys(hours).length) {
    return { is_open_now: true, next_open_text: '' };
  }

  const { hour, minute, dayIndex } = getNowInSaoPaulo();
  const nowMinutes = hour * 60 + minute;

  const todayKey = WEEK_KEYS[dayIndex];
  const today = hours[todayKey];

  if (today && !today.closed) {
    const openM = parseHHMM(today.open);
    const closeM = parseHHMM(today.close);
    if (openM != null && closeM != null && nowMinutes >= openM && nowMinutes < closeM) {
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
const LIMITE_DO_PAYLOAD = 500;

async function contarProdutosDaLoja(cid) {
  const sql = `
    SELECT COUNT(*)::int AS n
    FROM products
    WHERE ${listVisibilityWhere('$1')}
      AND is_active IS NOT FALSE
  `;
  try {
    const { rows } = await db.query(sql, [cid]);
    return rows[0] ? rows[0].n : 0;
  } catch (e) {
    // Contagem e informativa: se falhar, a loja abre sem o aviso.
    return 0;
  }
}

async function fetchStorefrontProducts(cid, featuredIds, _hiddenIds) {
  const visibility = listVisibilityWhere('$1');

  if (featuredIds && featuredIds.length > 0) {
    const sql = `
      SELECT id, name, description, price, image_url, gallery_urls, category, stock_qty, created_at
      FROM products
      WHERE ${visibility}
        AND is_active IS NOT FALSE
        AND id::text = ANY($2)
      ORDER BY array_position($2, id::text)
      LIMIT ${LIMITE_DO_PAYLOAD}
    `;
    const { rows } = await db.query(sql, [cid, featuredIds]);
    return rows;
  }

  const sql = `
    SELECT id, name, description, price, image_url, gallery_urls, category, stock_qty, created_at
    FROM products
    WHERE ${visibility}
      AND is_active IS NOT FALSE
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

  const products = await fetchStorefrontProducts(cid, featuredIds, hiddenIds);
  const catalogoTotal = await contarProdutosDaLoja(cid);

  // D3: árvore + vínculo primário. Só categorias visíveis na vitrine
  // entram, e o produto só recebe categoria que esteja nesse conjunto --
  // produto compartilhado de outra empresa não pode arrastar a categoria
  // dela para o payload público desta loja.
  const categories = await fetchStorefrontCategories(cid);
  const categoryById = {};
  categories.forEach(c => { categoryById[c.id] = c; });
  const primaryLinkByProduct = await fetchPrimaryCategoryLinks(products.map(p => p.id));

  let variantsByProduct = {};
  if (products.length > 0) {
    const productIds = products.map(p => p.id);
    // 23/05/2026: inclui pv.image_url no SELECT (Migration 129).
    // Template usa pra trocar foto principal ao selecionar variante e
    // pra fallback no card da vitrine quando produto pai nao tem foto.
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
      if (!variantsByProduct[v.product_id]) variantsByProduct[v.product_id] = [];
      variantsByProduct[v.product_id].push({
        id: v.id, sku_suffix: v.sku_suffix,
        price_override: v.price_override !== null ? parseFloat(v.price_override) : null,
        stock_qty: parseFloat(v.stock_qty),
        image_url: v.image_url || null,   // 23/05/2026
        values: v.values || [],
      });
    }
  }

  const { rows: companies } = await db.query(
    `SELECT trade_name, legal_name, logo_url FROM companies WHERE id = $1`, [cid]);
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
  const { is_open_now, next_open_text } = computeOpenState(businessHours);

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
      pay_on_delivery_enabled:  payOnDeliveryEnabled,
      pickup_eta_text:   config.pickup_eta_text   || null,
      delivery_eta_text: config.delivery_eta_text || null,
      delivery_pricing_mode: config.delivery_pricing_mode || 'flat',
      delivery_free_above_amount: config.delivery_free_above_amount != null
        ? parseFloat(config.delivery_free_above_amount)
        : null,
    },
    products: products.map(p => {
      const pvariants = variantsByProduct[p.id] || [];
      const hasVariants = pvariants.length > 0;
      const inStock = hasVariants ? pvariants.some(v => v.stock_qty > 0) : p.stock_qty > 0;
      const cat = categoryById[primaryLinkByProduct[p.id]] || null;
      return {
        id: p.id, name: p.name, description: p.description,
        price: config.show_prices !== false ? parseFloat(p.price) : null,
        // `category` (texto) PERMANECE -- ver a regra em fetchStorefrontCategories.
        image_url: p.image_url,
        // S9 — carrossel de fotos (migration 290). [] quando nao ha galeria.
        gallery_urls: Array.isArray(p.gallery_urls) ? p.gallery_urls : [],
        category: p.category,
        // D3: campos ADITIVOS. null quando o produto ainda não tem
        // vínculo (catálogo pré-migração) ou quando a categoria não é
        // visível na vitrine.
        category_id:   cat ? cat.id   : null,
        category_slug: cat ? cat.slug : null,
        category_path: cat ? cat.path : null,
        stock_qty: p.stock_qty, in_stock: inStock, variants: pvariants,
      };
    }),
    total_products: products.length,
    // Quantos a loja tem de verdade — ver contarProdutosDaLoja.
    catalog_total: catalogoTotal,
    payload_limit: LIMITE_DO_PAYLOAD,
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
  buildStorefront, parseFeaturedIds, parseHiddenIds, computeOpenState,
  // Exportados em 19/08/2026 (S1) para o storefront do Studio montar a
  // MESMA arvore de categorias que a loja comum, em vez de uma segunda
  // implementacao. As duas regras que importam vivem aqui e valem para
  // os dois: so categoria com is_visible_storefront entra, e so o
  // vinculo primario sai no payload.
  fetchStorefrontCategories, fetchPrimaryCategoryLinks,
};
