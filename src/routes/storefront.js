// ============================================================
// AURA. — Storefront Público (sem auth)
// GET /storefront/:slug — retorna config + produtos publicados
// GET /storefront/domain/:domain — lookup por domínio customizado
// ============================================================
const router = require('express').Router();
const db     = require('../config/database');

// Helper: build storefront response
async function buildStorefront(config) {
  const cid = config.company_id;

  // Fetch published products
  let products = [];
  const featuredIds = config.featured_product_ids || [];
  if (featuredIds.length > 0) {
    const { rows } = await db.query(
      `SELECT id, name, description, price, image_url, category, stock_qty
       FROM products WHERE company_id = $1 AND id = ANY($2) AND is_active = true
       ORDER BY name`, [cid, featuredIds]
    );
    products = rows;
  } else {
    // If no featured products selected, show all active products (limit 50)
    const { rows } = await db.query(
      `SELECT id, name, description, price, image_url, category, stock_qty
       FROM products WHERE company_id = $1 AND is_active = true
       ORDER BY created_at DESC LIMIT 50`, [cid]
    );
    products = rows;
  }

  // Fetch company info
  const { rows: companies } = await db.query(
    `SELECT trade_name, legal_name, logo_url FROM companies WHERE id = $1`, [cid]
  );
  const company = companies[0] || {};

  return {
    site: {
      name: config.site_name || company.trade_name || company.legal_name || 'Loja',
      tagline: config.tagline || '',
      description: config.description || '',
      primary_color: config.primary_color || '#7c3aed',
      secondary_color: config.secondary_color || '#a78bfa',
      logo_url: config.logo_url || company.logo_url || null,
      cover_url: config.cover_url || null,
    },
    contact: {
      phone: config.phone || '',
      whatsapp: config.whatsapp || '',
      instagram: config.instagram || '',
      address: config.address || '',
      google_maps_url: config.google_maps_url || '',
    },
    business_hours: config.business_hours || {},
    settings: {
      show_prices: config.show_prices !== false,
      show_stock: config.show_stock || false,
      delivery_enabled: config.delivery_enabled || false,
      pickup_enabled: config.pickup_enabled !== false,
    },
    products: products.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: config.show_prices !== false ? parseFloat(p.price) : null,
      image_url: p.image_url,
      category: p.category,
      in_stock: config.show_stock ? (p.stock_qty > 0) : null,
    })),
    total_products: products.length,
    custom_domain: config.custom_domain || null,
  };
}

// GET /storefront/:slug
router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`,
      [req.params.slug.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Loja não encontrada' });
    const storefront = await buildStorefront(rows[0]);
    res.json(storefront);
  } catch (err) {
    console.error('storefront slug error:', err);
    res.status(500).json({ error: 'Erro ao carregar loja' });
  }
});

// GET /storefront/domain/:domain
router.get('/domain/:domain', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config
       WHERE custom_domain = $1 AND is_published = true AND custom_domain_status = 'active'`,
      [req.params.domain.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Domínio não encontrado' });
    const storefront = await buildStorefront(rows[0]);
    res.json(storefront);
  } catch (err) {
    console.error('storefront domain error:', err);
    res.status(500).json({ error: 'Erro ao carregar loja' });
  }
});

module.exports = router;
