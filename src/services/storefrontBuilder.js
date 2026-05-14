// ============================================================
// AURA. — Storefront Builder Service
// Monta o objeto de dados da loja (produtos, variantes, config)
//
// FIX (14/05/2026): queries de produtos usavam company_id=$1 direto,
// bloqueando produtos is_group_shared do outro CNPJ do grupo.
// Agora usa listVisibilityWhere bidirecional idêntico ao products.js.
// ============================================================
'use strict';

const db = require('../config/database');

function parseFeaturedIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
  }
  return [];
}

// Mesma lógica de products.js — bidirecional via group_root.
// cidParam é o placeholder posicional já montado (ex: '$1').
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

  // Busca variantes de todos os produtos
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
        id:             v.id,
        sku_suffix:     v.sku_suffix,
        price_override: v.price_override !== null ? parseFloat(v.price_override) : null,
        stock_qty:      parseFloat(v.stock_qty),
        values:         v.values || [],
      });
    }
  }

  const { rows: companies } = await db.query(
    `SELECT trade_name, legal_name, logo_url FROM companies WHERE id = $1`, [cid]);
  const company = companies[0] || {};

  const hasPix = !!(config.pix_key && String(config.pix_key).trim());
  const payOnDeliveryEnabled = !!config.pay_on_delivery_enabled;

  return {
    site: {
      name:          config.site_name || company.trade_name || company.legal_name || 'Loja',
      tagline:       config.tagline       || '',
      description:   config.description   || '',
      primary_color: config.primary_color || '#7c3aed',
      logo_url:      config.logo_url  || company.logo_url || null,
      cover_url:     config.cover_url || null,
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
      const inStock = hasVariants
        ? pvariants.some(v => v.stock_qty > 0)
        : p.stock_qty > 0;
      return {
        id:          p.id,
        name:        p.name,
        description: p.description,
        price:       config.show_prices !== false ? parseFloat(p.price) : null,
        image_url:   p.image_url,
        category:    p.category,
        stock_qty:   p.stock_qty,
        in_stock:    inStock,
        variants:    pvariants,
      };
    }),
    total_products: products.length,
  };
}

module.exports = { buildStorefront, parseFeaturedIds };
