// ============================================================
// AURA. — Storefront Builder Service
// Monta o objeto de dados da loja (produtos, variantes, config)
//
// v2 (15/05/2026): expõe accent_color, dark_mode, font_family,
// card_style, banners[], announcement_bar, service_cards[] pro template novo.
// Cai em fallbacks pra empresas pré-migration 115/116.
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

async function buildStorefront(config) {
  const cid = config.company_id;
  let products = [];
  const featuredIds = parseFeaturedIds(config.featured_product_ids);

  if (featuredIds.length > 0) {
    const { rows } = await db.query(
      `SELECT id, name, description, price, image_url, category, stock_qty
       FROM products
       WHERE ${listVisibilityWhere('$1')} AND id::text = ANY($2) AND is_active IS NOT FALSE
       ORDER BY name`,
      [cid, featuredIds]
    );
    products = rows;
  } else {
    const { rows } = await db.query(
      `SELECT id, name, description, price, image_url, category, stock_qty
       FROM products
       WHERE ${listVisibilityWhere('$1')} AND is_active IS NOT FALSE
       ORDER BY created_at DESC LIMIT 50`,
      [cid]
    );
    products = rows;
  }

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
      ORDER BY pv.created_at
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

module.exports = { buildStorefront, parseFeaturedIds };
