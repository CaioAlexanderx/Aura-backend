// ============================================================
// AURA. — Storefront Público (sem auth)
// GET /storefront/:slug — JSON API
// GET /storefront/:slug/page — HTML renderizado (vitrine publica)
// ============================================================
const router = require('express').Router();
const db     = require('../config/database');

async function buildStorefront(config) {
  const cid = config.company_id;
  let products = [];
  const featuredIds = config.featured_product_ids || [];
  if (featuredIds.length > 0) {
    const { rows } = await db.query(
      `SELECT id, name, description, price, image_url, category, stock_qty
       FROM products WHERE company_id = $1 AND id = ANY($2) AND is_active = true
       ORDER BY name`, [cid, featuredIds]);
    products = rows;
  } else {
    const { rows } = await db.query(
      `SELECT id, name, description, price, image_url, category, stock_qty
       FROM products WHERE company_id = $1 AND is_active = true
       ORDER BY created_at DESC LIMIT 50`, [cid]);
    products = rows;
  }
  const { rows: companies } = await db.query(
    `SELECT trade_name, legal_name, logo_url FROM companies WHERE id = $1`, [cid]);
  const company = companies[0] || {};
  return {
    site: {
      name: config.site_name || company.trade_name || company.legal_name || 'Loja',
      tagline: config.tagline || '', description: config.description || '',
      primary_color: config.primary_color || '#7c3aed',
      logo_url: config.logo_url || company.logo_url || null,
      cover_url: config.cover_url || null,
    },
    contact: { phone: config.phone || '', whatsapp: config.whatsapp || '', instagram: config.instagram || '', address: config.address || '' },
    business_hours: config.business_hours || {},
    settings: { show_prices: config.show_prices !== false, show_stock: config.show_stock || false },
    products: products.map(p => ({
      id: p.id, name: p.name, description: p.description,
      price: config.show_prices !== false ? parseFloat(p.price) : null,
      image_url: p.image_url, category: p.category,
      in_stock: config.show_stock ? (p.stock_qty > 0) : null,
    })),
    total_products: products.length,
  };
}

// JSON API
router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`,
      [req.params.slug.toLowerCase().trim()]);
    if (!rows.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    res.json(await buildStorefront(rows[0]));
  } catch (err) { console.error('storefront error:', err); res.status(500).json({ error: 'Erro' }); }
});

// HTML rendered page
router.get('/:slug/page', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`,
      [req.params.slug.toLowerCase().trim()]);
    if (!rows.length) return res.status(404).send('<h1>Loja nao encontrada</h1>');
    const data = await buildStorefront(rows[0]);
    const primary = data.site.primary_color || '#7c3aed';
    const fmt = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

    const productCards = data.products.map(p => {
      const img = p.image_url
        ? `<img src="${p.image_url}" alt="${p.name}" style="width:100%;height:200px;object-fit:cover;border-radius:12px 12px 0 0;">`
        : `<div style="width:100%;height:200px;background:linear-gradient(135deg,${primary}22,${primary}11);border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:center;font-size:48px;">&#128722;</div>`;
      const priceTag = p.price !== null ? `<div style="font-size:18px;font-weight:800;color:${primary};">${fmt(p.price)}</div>` : '';
      const cat = p.category ? `<span style="font-size:10px;background:${primary}15;color:${primary};padding:3px 8px;border-radius:20px;font-weight:600;">${p.category}</span>` : '';
      return `<div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);transition:transform .2s;" onmouseover="this.style.transform='translateY(-4px)'" onmouseout="this.style.transform='none'">
        ${img}
        <div style="padding:16px;">
          ${cat}
          <h3 style="margin:8px 0 4px;font-size:15px;color:#1a1a2e;">${p.name}</h3>
          ${p.description ? `<p style="font-size:12px;color:#666;margin:0 0 8px;line-height:1.4;">${p.description.substring(0,100)}${p.description.length>100?'...':''}</p>` : ''}
          ${priceTag}
        </div>
      </div>`;
    }).join('');

    const whatsappBtn = data.contact.whatsapp
      ? `<a href="https://wa.me/${data.contact.whatsapp.replace(/\D/g,'')}" target="_blank" style="display:inline-flex;align-items:center;gap:8px;background:#25D366;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;font-weight:700;font-size:14px;margin-top:16px;">&#128172; Fale conosco no WhatsApp</a>`
      : '';

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${data.site.name}</title>
  <meta name="description" content="${data.site.tagline || data.site.description || ''}">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8f7ff;color:#1a1a2e;}
    .hero{background:linear-gradient(135deg,${primary},${primary}cc);color:#fff;padding:48px 24px;text-align:center;}
    .hero h1{font-size:28px;font-weight:800;margin-bottom:8px;}
    .hero p{font-size:14px;opacity:0.9;max-width:500px;margin:0 auto;}
    .hero img{width:64px;height:64px;border-radius:16px;margin-bottom:16px;object-fit:cover;border:2px solid rgba(255,255,255,0.3);}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px;max-width:960px;margin:0 auto;padding:32px 20px;}
    .footer{text-align:center;padding:32px 20px;color:#888;font-size:12px;}
    .contact{text-align:center;padding:24px 20px;background:#fff;}
    @media(max-width:600px){.grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;padding:20px 12px;}}
  </style>
</head>
<body>
  <div class="hero">
    ${data.site.logo_url ? `<img src="${data.site.logo_url}" alt="Logo">` : ''}
    <h1>${data.site.name}</h1>
    ${data.site.tagline ? `<p>${data.site.tagline}</p>` : ''}
  </div>
  <div class="grid">${productCards}</div>
  ${(data.contact.whatsapp || data.contact.phone || data.contact.address) ? `<div class="contact">
    ${data.contact.address ? `<p style="margin-bottom:8px;color:#666;">&#128205; ${data.contact.address}</p>` : ''}
    ${data.contact.phone ? `<p style="margin-bottom:8px;color:#666;">&#128222; ${data.contact.phone}</p>` : ''}
    ${whatsappBtn}
  </div>` : ''}
  <div class="footer"><p>Powered by <strong>Aura</strong> &mdash; Gestao inteligente</p></div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('storefront page error:', err);
    res.status(500).send('<h1>Erro ao carregar loja</h1>');
  }
});

module.exports = router;
