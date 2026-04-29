// ============================================================
// AURA. — Storefront Público (sem auth)
// GET  /storefront/:slug       — JSON API
// GET  /storefront/:slug/page  — HTML renderizado (vitrine pública)
// POST /storefront/:slug/order — Cria pedido + gera Pix
// GET  /storefront/:slug/order/:oid — Poll status de pagamento
// ============================================================
const router              = require('express').Router();
const db                  = require('../config/database');
const notify              = require('../services/digitalOrderNotifications');
const buildStorefrontPage = require('../templates/storefrontPage');

// ============================================================
// buildStorefront — monta o objeto de dados da loja
// ============================================================
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
    },
    products: products.map(p => ({
      id:          p.id,
      name:        p.name,
      description: p.description,
      price:       config.show_prices !== false ? parseFloat(p.price) : null,
      image_url:   p.image_url,
      category:    p.category,
      stock_qty:   p.stock_qty,
      in_stock:    p.stock_qty > 0,
    })),
    total_products: products.length,
  };
}

// ============================================================
// GET /storefront/:slug — JSON API
// ============================================================
router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`,
      [req.params.slug.toLowerCase().trim()]);
    if (!rows.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    res.json(await buildStorefront(rows[0]));
  } catch (err) {
    console.error('storefront error:', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// ============================================================
// GET /storefront/:slug/page — HTML renderizado (SPA)
// ============================================================
router.get('/:slug/page', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`, [slug]);
    if (!rows.length) {
      return res.status(404).send('<!DOCTYPE html><html lang="pt-BR"><body style="font-family:sans-serif;text-align:center;padding:80px 20px"><h1>Loja não encontrada</h1><p style="color:#888">Verifique o endereço e tente novamente.</p></body></html>');
    }
    const data = await buildStorefront(rows[0]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildStorefrontPage(data, slug));
  } catch (err) {
    console.error('storefront page error:', err);
    res.status(500).send('<!DOCTYPE html><html lang="pt-BR"><body style="font-family:sans-serif;text-align:center;padding:80px 20px"><h1>Erro ao carregar loja</h1><p style="color:#888">Tente novamente em instantes.</p></body></html>');
  }
});

// ============================================================
// POST /storefront/:slug/order — Criar pedido + gerar Pix
// ============================================================
router.post('/:slug/order', async (req, res) => {
  const slug = req.params.slug.toLowerCase().trim();
  const {
    customer_name, customer_phone, customer_email,
    delivery_type, delivery_address, notes, items,
  } = req.body;

  if (!customer_name || !customer_phone) {
    return res.status(400).json({ error: 'Nome e telefone são obrigatórios' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos 1 item no pedido' });
  }

  try {
    const { rows: configs } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`, [slug]);
    if (!configs.length) return res.status(404).json({ error: 'Loja não encontrada' });
    const config = configs[0];
    const cid = config.company_id;

    const dtype = delivery_type || 'pickup';
    if (dtype === 'delivery' && !config.delivery_enabled) {
      return res.status(400).json({ error: 'Entrega não disponível nesta loja' });
    }
    if (dtype === 'pickup' && config.pickup_enabled === false) {
      return res.status(400).json({ error: 'Retirada não disponível nesta loja' });
    }
    if (dtype === 'delivery' && !delivery_address) {
      return res.status(400).json({ error: 'Endereço de entrega é obrigatório' });
    }

    const productIds = items.map(i => i.product_id);
    const { rows: products } = await db.query(
      `SELECT id, name, price, stock_qty, image_url, is_active
       FROM products WHERE id = ANY($1) AND company_id = $2`, [productIds, cid]);
    const productMap = Object.fromEntries(products.map(p => [p.id, p]));

    const orderItems = [];
    let subtotal = 0;

    for (const item of items) {
      const p = productMap[item.product_id];
      if (!p)           return res.status(400).json({ error: `Produto ${item.product_id} não encontrado` });
      if (!p.is_active) return res.status(400).json({ error: `Produto "${p.name}" não está disponível` });
      if (p.stock_qty < item.quantity) {
        return res.status(400).json({
          error: `Estoque insuficiente para "${p.name}". Disponível: ${p.stock_qty}`,
        });
      }
      const itemSubtotal = parseFloat(p.price) * item.quantity;
      subtotal += itemSubtotal;
      orderItems.push({
        product_id:    p.id,
        product_name:  p.name,
        product_image: p.image_url,
        unit_price:    parseFloat(p.price),
        quantity:      item.quantity,
        subtotal:      itemSubtotal,
      });
    }

    const delivery_fee = dtype === 'delivery' ? (parseFloat(config.delivery_fee) || 0) : 0;
    const total = subtotal + delivery_fee;

    const client = await db.connect();
    let order;
    try {
      await client.query('BEGIN');
      const { rows: [newOrder] } = await client.query(`
        INSERT INTO digital_orders (
          company_id, order_number, customer_name, customer_phone, customer_email,
          delivery_type, delivery_address, delivery_fee, subtotal, total,
          status, payment_status, notes
        ) VALUES (
          $1, next_digital_order_number($1), $2, $3, $4,
          $5, $6, $7, $8, $9,
          'pending_payment', 'pending', $10
        ) RETURNING *
      `, [
        cid, customer_name, customer_phone, customer_email || null,
        dtype, delivery_address || null, delivery_fee, subtotal, total, notes || null,
      ]);
      order = newOrder;
      for (const item of orderItems) {
        await client.query(`
          INSERT INTO digital_order_items
            (order_id, product_id, product_name, product_image, unit_price, quantity, subtotal)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [order.id, item.product_id, item.product_name, item.product_image,
            item.unit_price, item.quantity, item.subtotal]);
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    const pixData = await generatePix({ order, company_id: cid, total });

    if (pixData) {
      await db.query(`
        UPDATE digital_orders SET
          asaas_payment_id     = $1,
          asaas_pix_qrcode     = $2,
          asaas_pix_payload    = $3,
          asaas_pix_expires_at = $4
        WHERE id = $5
      `, [pixData.payment_id, pixData.qrcode, pixData.payload, pixData.expires_at, order.id]);
    }

    notify.notifyNewOrder({
      order,
      total,
      pix_payload: pixData?.payload || null,
      config,
    }).catch(err => console.error('[notify] new order error:', err.message));

    res.status(201).json({
      order_id:     order.id,
      order_number: order.order_number,
      total,
      pix: pixData ? {
        qrcode:     pixData.qrcode,
        payload:    pixData.payload,
        expires_at: pixData.expires_at,
      } : null,
    });
  } catch (err) {
    console.error('create order error:', err);
    res.status(500).json({ error: 'Erro ao criar pedido' });
  }
});

// ============================================================
// GET /storefront/:slug/order/:oid — Poll público de status
// ============================================================
router.get('/:slug/order/:oid', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, order_number, status, payment_status, total, delivery_type,
             asaas_pix_expires_at, confirmed_at, delivered_at
      FROM digital_orders WHERE id = $1
    `, [req.params.oid]);
    if (!rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('order poll error:', err);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

// ============================================================
// Helpers de geração de Pix
// ============================================================

async function generatePix({ order, company_id, total }) {
  const { rows } = await db.query(
    `SELECT asaas_subconta_id, asaas_subconta_token FROM companies WHERE id = $1`, [company_id]);
  const co = rows[0];
  if (co && co.asaas_subconta_id && co.asaas_subconta_token) {
    return generateAsaasPix({ order, company: co, total });
  }
  return generateMockPix({ order, total });
}

async function generateAsaasPix({ order, company, total }) {
  const ASAAS_BASE = process.env.ASAAS_API_URL || 'https://api.asaas.com/api/v3';
  const dueDate    = new Date(Date.now() + 30 * 60 * 1000);
  const dueDateStr = dueDate.toISOString().split('T')[0];
  try {
    const payResp = await fetch(`${ASAAS_BASE}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'access_token': company.asaas_subconta_token },
      body: JSON.stringify({
        billingType:       'PIX',
        customer:          company.asaas_subconta_id,
        value:             total,
        dueDate:           dueDateStr,
        description:       `Pedido ${order.order_number}`,
        externalReference: `digital-order-${order.id}`,
      }),
    });
    const payData = await payResp.json();
    if (!payResp.ok) {
      console.warn('[PIX] Asaas payment error, usando mock:', JSON.stringify(payData));
      return generateMockPix({ order, total });
    }
    const qrResp = await fetch(`${ASAAS_BASE}/payments/${payData.id}/pixQrCode`, {
      headers: { 'access_token': company.asaas_subconta_token },
    });
    const qrData = await qrResp.json();
    return {
      payment_id: payData.id,
      qrcode:     qrData.encodedImage || null,
      payload:    qrData.payload      || null,
      expires_at: dueDate.toISOString(),
    };
  } catch (err) {
    console.warn('[PIX] Asaas call falhou, usando mock:', err.message);
    return generateMockPix({ order, total });
  }
}

function generateMockPix({ order, total }) {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const ref       = order.order_number.replace('-', '').slice(0, 10).padEnd(10, '0');
  const amt       = Number(total).toFixed(2);
  const payload   = [
    '000201',
    '26580014br.gov.bcb.pix',
    `0136mock-${order.id.slice(0, 22)}`,
    '520400005303986',
    `5406${amt}`,
    '5802BR',
    '5920AURA NEGOCIO DIGITAL',
    '6009SAO PAULO',
    `6214051006${ref}`,
    '6304MOCK',
  ].join('');
  return { payment_id: `mock-${order.id}`, qrcode: null, payload, expires_at: expiresAt.toISOString() };
}

module.exports = router;
