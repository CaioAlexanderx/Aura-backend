// ============================================================
// AURA. — Storefront Builder Service
// Monta o objeto de dados da loja (produtos, variantes, config)
//
// v2 (15/05/2026): expõe accent_color, dark_mode, font_family,
// card_style, banners[], announcement_bar, service_cards[] pro template novo.
// Cai em fallbacks pra empresas pré-migration 115/116.
//
// Fase 4 (18/05/2026): tentou trocar semantica de featured_product_ids
//   para "ordem de destaque" + adicionou hidden_product_ids para opt-out.
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

function parseFeaturedIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
  }
  return [];
}

// Mantido por back-compat (quem importa o módulo ainda consegue parsear o campo
// se quiser). Mas o storefront NÃO usa mais hidden_product_ids — coluna dormente.
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
  // Backfill: array vazio cai nos defaults (pra lojas pré-migration 116)
  if (!arr.length) arr = DEFAULT_SERVICE_CARDS;
  return arr.slice(0, 4).map((c) => ({
    icon:    ALLOWED_ICONS.includes(c?.icon) ? c.icon : 'sparkle',
    title:   typeof c?.title === 'string' ? c.title : '',
    body:    typeof c?.body  === 'string' ? c.body  : '',
    enabled: c?.enabled !== false,
  })).filter((c) => c.enabled && (c.title || c.body));
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

// Fase 4.1 (rollback): featured_product_ids volta a ser INCLUSION list.
//   - featuredIds.length === 0  => SELECT todos os produtos ativos,
//                                  ORDER BY created_at DESC, LIMIT 500.
//   - featuredIds.length > 0    => SELECT apenas os IDs em featured,
//                                  ORDER BY array_position(featured, id::text).
//   hiddenIds e IGNORADO (back-compat na assinatura).
async function fetchStorefrontProducts(cid, featuredIds, _hiddenIds) {
  const visibility = listVisibilityWhere('$1');

  if (featuredIds && featuredIds.length > 0) {
    // Modo curadoria: somente IDs em featured_product_ids, na ordem do array.
    const sql = `
      SELECT id, name, description, price, image_url, category, stock_qty, created_at
      FROM products
      WHERE ${visibility}
        AND is_active IS NOT FALSE
        AND id::text = ANY($2)
      ORDER BY array_position($2, id::text)
      LIMIT 500
    `;
    const { rows } = await db.query(sql, [cid, featuredIds]);
    return rows;
  }

  // Modo padrão: todos os produtos ativos, mais recentes primeiro.
  const sql = `
    SELECT id, name, description, price, image_url, category, stock_qty, created_at
    FROM products
    WHERE ${visibility}
      AND is_active IS NOT FALSE
    ORDER BY created_at DESC
    LIMIT 500
  `;
  const { rows } = await db.query(sql, [cid]);
  return rows;
}

async function buildStorefront(config) {
  const cid = config.company_id;
  const featuredIds = parseFeaturedIds(config.featured_product_ids);
  const hiddenIds   = parseHiddenIds(config.hidden_product_ids);

  // hiddenIds ignorado no rollback Fase 4.1 — argumento mantido por back-compat
  const products = await fetchStorefrontProducts(cid, featuredIds, hiddenIds);

  let variantsByProduct = {};
  if (products.length > 0) {
    const productIds = products.map(p => p.id);
    const { rows: variantRows } = await db.query(`
      SELECT pv.id, pv.product_id, pv.sku_suffix,
             pv.price_override, pv.stock_qty, pv.is_active,
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
        values: v.values || [],
      });
    }
  }

  const { rows: companies } = await db.query(
    `SELECT trade_name, legal_name, logo_url FROM companies WHERE id = $1`, [cid]);
  const company = companies[0] || {};

  const hasPix = !!(config.pix_key && String(config.pix_key).trim());
  const payOnDeliveryEnabled = !!config.pay_on_delivery_enabled;

  const banners = parseBanners(config.banners, config.cover_url, config.tagline, config.description);
  const serviceCards = parseServiceCards(config.service_cards);

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
    },
    contact: {
      phone:     config.phone     || '',
      whatsapp:  config.whatsapp  || '',
      instagram: config.instagram || '',
      address:   config.address   || '',
    },
    business_hours: config.business_hours || {},
    settings: {
      show_prices:      config.show_prices !== false,
      show_stock:       config.show_stock  || false,
      pickup_enabled:   config.pickup_enabled   !== false,
      delivery_enabled: config.delivery_enabled || false,
      delivery_fee:     parseFloat(config.delivery_fee) || 0,
      has_pix:                  hasPix,
      pay_on_delivery_enabled:  payOnDeliveryEnabled,
    },
    products: products.map(p => {
      const pvariants = variantsByProduct[p.id] || [];
      const hasVariants = pvariants.length > 0;
      const inStock = hasVariants ? pvariants.some(v => v.stock_qty > 0) : p.stock_qty > 0;
      return {
        id: p.id, name: p.name, description: p.description,
        price: config.show_prices !== false ? parseFloat(p.price) : null,
        image_url: p.image_url, category: p.category,
        stock_qty: p.stock_qty, in_stock: inStock, variants: pvariants,
      };
    }),
    total_products: products.length,
  };
}

module.exports = { buildStorefront, parseFeaturedIds, parseHiddenIds };
