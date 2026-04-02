// ============================================================
// AURA. — BE-REV-05: Canal Digital CRUD
// GET  /companies/:id/digital-channel
// PUT  /companies/:id/digital-channel
// Stores mini-site config: name, colors, logo, featured products, hours
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');

const DEFAULT_CONFIG = {
  site_name: null,
  tagline: '',
  primary_color: '#7c3aed',
  secondary_color: '#a78bfa',
  logo_url: null,
  cover_url: null,
  description: '',
  address: '',
  phone: '',
  whatsapp: '',
  instagram: '',
  google_maps_url: '',
  business_hours: {
    seg: { open: '09:00', close: '18:00', closed: false },
    ter: { open: '09:00', close: '18:00', closed: false },
    qua: { open: '09:00', close: '18:00', closed: false },
    qui: { open: '09:00', close: '18:00', closed: false },
    sex: { open: '09:00', close: '18:00', closed: false },
    sab: { open: '09:00', close: '13:00', closed: false },
    dom: { open: null, close: null, closed: true },
  },
  featured_product_ids: [],
  show_prices: true,
  show_stock: false,
  delivery_enabled: false,
  delivery_fee: 0,
  delivery_radius_km: 5,
  pickup_enabled: true,
  is_published: false,
};

// GET /companies/:id/digital-channel
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE company_id = $1`, [cid]
    );

    if (!rows.length) {
      // Return defaults merged with company info
      const { rows: companies } = await db.query(
        `SELECT name, trade_name, phone, address_city, address_state FROM companies WHERE id = $1`, [cid]
      );
      const co = companies[0] || {};
      return res.json({
        ...DEFAULT_CONFIG,
        site_name: co.trade_name || co.name || null,
        phone: co.phone || '',
        address: co.address_city ? `${co.address_city}/${co.address_state}` : '',
        exists: false,
      });
    }

    const config = rows[0];
    res.json({
      ...config,
      business_hours: config.business_hours || DEFAULT_CONFIG.business_hours,
      featured_product_ids: config.featured_product_ids || [],
      exists: true,
    });
  } catch (err) {
    // Graceful fallback if table doesn't exist yet
    if (err.message?.includes('does not exist')) {
      return res.json({ ...DEFAULT_CONFIG, exists: false });
    }
    console.error('digital channel get error:', err);
    res.status(500).json({ error: 'Erro ao buscar configuracao do canal digital' });
  }
});

// PUT /companies/:id/digital-channel
router.put('/', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const {
    site_name, tagline, primary_color, secondary_color,
    logo_url, cover_url, description, address, phone, whatsapp,
    instagram, google_maps_url, business_hours, featured_product_ids,
    show_prices, show_stock, delivery_enabled, delivery_fee,
    delivery_radius_km, pickup_enabled, is_published,
  } = req.body;

  try {
    const { rows } = await db.query(`
      INSERT INTO digital_channel_config (
        company_id, site_name, tagline, primary_color, secondary_color,
        logo_url, cover_url, description, address, phone, whatsapp,
        instagram, google_maps_url, business_hours, featured_product_ids,
        show_prices, show_stock, delivery_enabled, delivery_fee,
        delivery_radius_km, pickup_enabled, is_published
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22
      )
      ON CONFLICT (company_id) DO UPDATE SET
        site_name = COALESCE($2, digital_channel_config.site_name),
        tagline = COALESCE($3, digital_channel_config.tagline),
        primary_color = COALESCE($4, digital_channel_config.primary_color),
        secondary_color = COALESCE($5, digital_channel_config.secondary_color),
        logo_url = COALESCE($6, digital_channel_config.logo_url),
        cover_url = COALESCE($7, digital_channel_config.cover_url),
        description = COALESCE($8, digital_channel_config.description),
        address = COALESCE($9, digital_channel_config.address),
        phone = COALESCE($10, digital_channel_config.phone),
        whatsapp = COALESCE($11, digital_channel_config.whatsapp),
        instagram = COALESCE($12, digital_channel_config.instagram),
        google_maps_url = COALESCE($13, digital_channel_config.google_maps_url),
        business_hours = COALESCE($14, digital_channel_config.business_hours),
        featured_product_ids = COALESCE($15, digital_channel_config.featured_product_ids),
        show_prices = COALESCE($16, digital_channel_config.show_prices),
        show_stock = COALESCE($17, digital_channel_config.show_stock),
        delivery_enabled = COALESCE($18, digital_channel_config.delivery_enabled),
        delivery_fee = COALESCE($19, digital_channel_config.delivery_fee),
        delivery_radius_km = COALESCE($20, digital_channel_config.delivery_radius_km),
        pickup_enabled = COALESCE($21, digital_channel_config.pickup_enabled),
        is_published = COALESCE($22, digital_channel_config.is_published),
        updated_at = NOW()
      RETURNING *
    `, [
      cid, site_name || null, tagline || null, primary_color || null,
      secondary_color || null, logo_url || null, cover_url || null,
      description || null, address || null, phone || null, whatsapp || null,
      instagram || null, google_maps_url || null,
      business_hours ? JSON.stringify(business_hours) : null,
      featured_product_ids ? JSON.stringify(featured_product_ids) : null,
      show_prices ?? null, show_stock ?? null, delivery_enabled ?? null,
      delivery_fee ?? null, delivery_radius_km ?? null,
      pickup_enabled ?? null, is_published ?? null,
    ]);

    res.json({ config: rows[0], saved: true });
  } catch (err) {
    console.error('digital channel save error:', err);
    res.status(500).json({ error: 'Erro ao salvar configuracao do canal digital' });
  }
});

module.exports = router;
