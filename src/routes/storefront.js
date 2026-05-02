// ============================================================
// AURA. — Storefront Público (sem auth)
// GET  /storefront/:slug       — JSON API
// GET  /storefront/:slug/page  — HTML renderizado (vitrine pública)
// POST /storefront/:slug/order — Cria pedido + gera Pix
// GET  /storefront/:slug/order/:oid — Poll status de pagamento
// ============================================================
'use strict';

const router              = require('express').Router();
const db                  = require('../config/database');
const notify              = require('../services/digitalOrderNotifications');
const buildStorefrontPage = require('../templates/storefrontPage');
const { buildStorefront } = require('../services/storefrontBuilder');
const { generatePix }     = require('../services/pixService');

// CSP relaxado para a vitrine publica (usa scripts inline e imagens R2)
const STOREFRONT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "script-src-attr 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://r2.getaura.com.br https://pub-f21f233f50d1412abc93a05bbdffd0d3.r2.dev",
  "connect-src 'self' https://cloudflareinsights.com",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

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
      return res.status(404).send('<html><body><h1>Loja nao encontrada</h1></body></html>');
    }
    const data = await buildStorefront(rows[0]);
    res.setHeader('Content-Security-Policy', STOREFRONT_CSP);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildStorefrontPage(data, slug));
  } catch (err) {
    console.error('storefront page error:', err);
    res.status(500).send('<html><body><h1>Erro ao carregar loja</h1></body></html>');
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
    return res.status(400).json({ error: 'Nome e telefone sao obrigatorios' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos 1 item no pedido' });
  }

  try {
    const { rows: configs } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`, [slug]);
    if (!configs.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const config = configs[0];
    const cid = config.company_id;

    const dtype = delivery_type || 'pickup';
    if (dtype === 'delivery' && !config.delivery_enabled) {
      return res.status(400).json({ error: 'Entrega nao disponivel nesta loja' });
    }
    if (dtype === 'pickup' && config.pickup_enabled === false) {
      return res.status(400).json({ error: 'Retirada nao disponivel nesta loja' });
    }
    if (dtype === 'delivery' && !delivery_address) {
      return res.status(400).json({ error: 'Endereco de entrega e obrigatorio' });
    }

    const productIds = items.map(i => i.product_id);
    const { rows: products } = await db.query(
      `SELECT id, name, price, stock_qty, image_url, is_active
       FROM products WHERE id::text = ANY($1) AND company_id = $2`,
      [productIds.map(String), cid]);
    const productMap = Object.fromEntries(products.map(p => [p.id, p]));

    const variantIds = items.map(i => i.variant_id).filter(Boolean);
    let variantMap = {};
    if (variantIds.length > 0) {
      const { rows: varRows } = await db.query(`
        SELECT pv.id, pv.product_id, pv.price_override, pv.stock_qty, pv.is_active,
               COALESCE(string_agg(pvv.attribute_name || ': ' || pvv.value, ' / ' ORDER BY pvv.attribute_name), '') AS label
        FROM product_variants pv
        LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
        WHERE pv.id = ANY($1::uuid[])
        GROUP BY pv.id
      `, [variantIds]);
      variantMap = Object.fromEntries(varRows.map(v => [v.id, v]));
    }

    const { rows: variantCountRows } = await db.query(`
      SELECT product_id, COUNT(*) AS cnt
      FROM product_variants
      WHERE product_id = ANY($1::uuid[]) AND is_active = true
      GROUP BY product_id
    `, [productIds]);
    const productHasVariants = Object.fromEntries(
      variantCountRows.map(r => [r.product_id, parseInt(r.cnt) > 0])
    );

    const orderItems = [];
    let subtotal = 0;

    for (const item of items) {
      const p = productMap[item.product_id];
      if (!p) return res.status(400).json({ error: `Produto ${item.product_id} nao encontrado` });
      if (p.is_active === false) return res.status(400).json({ error: `Produto "${p.name}" nao esta disponivel` });

      let effectivePrice = parseFloat(p.price);
      let variantId      = item.variant_id || null;
      let variantLabel   = null;

      if (productHasVariants[p.id]) {
        if (!variantId) {
          return res.status(400).json({ error: `Selecione uma variante para "${p.name}"` });
        }
        const variant = variantMap[variantId];
        if (!variant || variant.product_id !== p.id) {
          return res.status(400).json({ error: `Variante invalida para "${p.name}"` });
        }
        if (variant.is_active === false) {
          return res.status(400).json({ error: `Variante de "${p.name}" nao esta disponivel` });
        }
        if (variant.stock_qty < item.quantity) {
          return res.status(400).json({
            error: `Estoque insuficiente para "${p.name}" (${variant.label}). Disponivel: ${variant.stock_qty}`,
          });
        }
        if (variant.price_override !== null) effectivePrice = parseFloat(variant.price_override);
        variantLabel = variant.label;
      } else {
        variantId = null;
        if (p.stock_qty < item.quantity) {
          return res.status(400).json({
            error: `Estoque insuficiente para "${p.name}". Disponivel: ${p.stock_qty}`,
          });
        }
      }

      const itemSubtotal = effectivePrice * item.quantity;
      subtotal += itemSubtotal;
      orderItems.push({
        product_id:    p.id,
        product_name:  p.name + (variantLabel ? ` (${variantLabel})` : ''),
        product_image: p.image_url,
        unit_price:    effectivePrice,
        quantity:      item.quantity,
        subtotal:      itemSubtotal,
        variant_id:    variantId,
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
            (order_id, product_id, product_name, product_image, unit_price, quantity, subtotal, variant_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [order.id, item.product_id, item.product_name, item.product_image,
            item.unit_price, item.quantity, item.subtotal, item.variant_id || null]);
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
      pix_payload: pixData ? pixData.payload : null,
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
// GET /storefront/:slug/order/:oid — Poll publico de status
// ============================================================
router.get('/:slug/order/:oid', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, order_number, status, payment_status, total, delivery_type,
             asaas_pix_expires_at, confirmed_at, delivered_at
      FROM digital_orders WHERE id = $1
    `, [req.params.oid]);
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('order poll error:', err);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

module.exports = router;
