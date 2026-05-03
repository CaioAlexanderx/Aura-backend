// ============================================================
// AURA. — Storefront Público (sem auth)
// GET  /storefront/:slug                     — JSON API
// GET  /storefront/:slug/page                — HTML renderizado (vitrine pública)
// POST /storefront/:slug/order               — Cria pedido (Pix manual ou na entrega)
// POST /storefront/:slug/order/:oid/upload-proof — Cliente envia comprovante de Pix
// POST /storefront/:slug/order/:oid/mark-as-paid — Cliente avisa que pagou
// GET  /storefront/:slug/order/:oid          — Poll status do pedido
// ============================================================
'use strict';

const router              = require('express').Router();
const db                  = require('../config/database');
const notify              = require('../services/digitalOrderNotifications');
const buildStorefrontPage = require('../templates/storefrontPage');
const { buildStorefront } = require('../services/storefrontBuilder');
const { generatePix }     = require('../services/pixService');
const { uploadToR2 }      = require('../utils/r2Storage');
const { onOrderConfirmed } = require('../services/digitalOrderConfirmation');

// ============================================================
// CORS aberto pra vitrine publica
// ─────────────────────────────────────────────────────────────
// Vitrine pode ser servida em QUALQUER dominio: dominio dedicado da
// loja (loja.getaura.com.br), custom domain do lojista, embed em
// iframe, etc. O CORS global do app.js so aceita ALLOWED_ORIGINS, o
// que bloqueia esses casos. Como vitrine eh publica e nao usa cookies
// (binomio slug+order_id eh o secret), e seguro abrir CORS aqui.
//
// Importante: este middleware roda DEPOIS do cors() global do app.js.
// Sobrescrevemos o header Access-Control-Allow-Origin manualmente
// (cors() global nao seta nada quando origin nao esta na whitelist).
// Tambem respondemos OPTIONS diretamente pra preflight passar.
// ============================================================
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
  res.setHeader('Access-Control-Max-Age', '600');
  // Sem Allow-Credentials: incompatible com origin '*' e nao precisamos
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// API_BASE: URL do backend usada pelos fetches da vitrine (mesmo valor de
// templates/storefrontPage.js). Precisa estar em connect-src do CSP, senao
// o browser bloqueia fetch cross-origin (vitrine pode ser servida em
// dominio diferente do backend, ex: loja.getaura.com.br via Cloudflare).
const STOREFRONT_API_BASE = process.env.STOREFRONT_API_BASE_URL
  || 'https://aura-backend-production-f805.up.railway.app';

// CSP relaxado para a vitrine publica (usa scripts inline e imagens R2 + QR via api.qrserver.com)
const STOREFRONT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "script-src-attr 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://r2.getaura.com.br https://pub-f21f233f50d1412abc93a05bbdffd0d3.r2.dev https://api.qrserver.com",
  "connect-src 'self' https://cloudflareinsights.com " + STOREFRONT_API_BASE,
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
// POST /storefront/:slug/order — Criar pedido (Pix manual ou na entrega)
// ============================================================
router.post('/:slug/order', async (req, res) => {
  const slug = req.params.slug.toLowerCase().trim();
  const {
    customer_name, customer_phone, customer_email,
    delivery_type, delivery_address, notes, items,
    payment_method,
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

    // ── Validacao do metodo de pagamento ──────────────────────
    const hasPix = !!(config.pix_key && String(config.pix_key).trim());
    const hasOnDelivery = !!config.pay_on_delivery_enabled;
    let pmethod = (payment_method || '').toLowerCase().trim();
    if (!pmethod) {
      // Default: pix se loja tem; senao on_delivery; senao erro
      pmethod = hasPix ? 'pix' : (hasOnDelivery ? 'on_delivery' : null);
    }
    if (!pmethod) {
      return res.status(400).json({ error: 'Esta loja nao aceita pagamentos no momento' });
    }
    if (pmethod !== 'pix' && pmethod !== 'on_delivery') {
      return res.status(400).json({ error: 'payment_method invalido. Use pix ou on_delivery' });
    }
    if (pmethod === 'pix' && !hasPix) {
      return res.status(400).json({ error: 'Esta loja nao aceita Pix' });
    }
    if (pmethod === 'on_delivery' && !hasOnDelivery) {
      return res.status(400).json({ error: 'Esta loja nao aceita pagamento na entrega' });
    }

    // ── Carrega produtos + variantes ──────────────────────────
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

    // ── Status inicial conforme metodo ────────────────────────
    // pix         → pending_payment (cliente paga e marca; lojista aprova)
    // on_delivery → confirmed       (lojista cobra direto na entrega)
    const initialStatus = pmethod === 'on_delivery' ? 'confirmed' : 'pending_payment';
    const initialPaymentStatus = 'pending'; // ambos comecam pending; on_delivery so confirma na entrega

    const client = await db.connect();
    let order;
    try {
      await client.query('BEGIN');
      const { rows: [newOrder] } = await client.query(`
        INSERT INTO digital_orders (
          company_id, order_number, customer_name, customer_phone, customer_email,
          delivery_type, delivery_address, delivery_fee, subtotal, total,
          status, payment_status, payment_method, notes,
          confirmed_at
        ) VALUES (
          $1, next_digital_order_number($1), $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13,
          CASE WHEN $10 = 'confirmed' THEN NOW() ELSE NULL END
        ) RETURNING *
      `, [
        cid, customer_name, customer_phone, customer_email || null,
        dtype, delivery_address || null, delivery_fee, subtotal, total,
        initialStatus, initialPaymentStatus, pmethod, notes || null,
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

    // ── Gera Pix apenas se metodo=pix ─────────────────────────
    let pixData = null;
    if (pmethod === 'pix') {
      pixData = await generatePix({ order, company_id: cid, total });
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
    }

    notify.notifyNewOrder({
      order,
      total,
      pix_payload: pixData ? pixData.payload : null,
      config,
    }).catch(err => console.error('[notify] new order error:', err.message));

    // Pedido on_delivery ja eh criado como 'confirmed' — dispara hook de
    // confirmacao (estoque + cliente + financeiro). Pix manual nao chama aqui:
    // ele dispara em routes/digitalOrders.js approve-payment quando lojista
    // aprova. Fire-and-forget; idempotente via flags em digital_orders.
    if (initialStatus === 'confirmed') {
      onOrderConfirmed(order.id)
        .catch(err => console.error('[storefront] onOrderConfirmed error:', err.message));
    }

    res.status(201).json({
      order_id:       order.id,
      order_number:   order.order_number,
      total,
      status:         initialStatus,
      payment_method: pmethod,
      pix: pixData ? {
        qrcode:     pixData.qrcode,
        payload:    pixData.payload,
        expires_at: pixData.expires_at,
        mode:       pixData.mode || null,
      } : null,
    });
  } catch (err) {
    console.error('create order error:', err);
    res.status(500).json({ error: 'Erro ao criar pedido' });
  }
});

// ============================================================
// POST /storefront/:slug/order/:oid/upload-proof
// Cliente envia comprovante (base64 + content_type). Sem auth — protegido
// pelo binomio (slug, order_id) que so quem fez o pedido conhece.
// ============================================================
router.post('/:slug/order/:oid/upload-proof', async (req, res) => {
  const slug = req.params.slug.toLowerCase().trim();
  const { oid } = req.params;
  const { content, content_type } = req.body || {};

  if (!content) {
    return res.status(400).json({ error: 'content (base64) obrigatorio' });
  }

  try {
    const { rows } = await db.query(`
      SELECT o.id, o.company_id, o.status, o.payment_method
      FROM digital_orders o
      JOIN digital_channel_config dcc ON dcc.company_id = o.company_id
      WHERE o.id = $1 AND dcc.slug = $2
    `, [oid, slug]);
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const order = rows[0];

    if (order.payment_method !== 'pix') {
      return res.status(400).json({ error: 'Comprovante so se aplica a pagamentos Pix' });
    }
    if (order.status === 'cancelled' || order.status === 'delivered') {
      return res.status(409).json({ error: `Pedido ja finalizado (${order.status})` });
    }

    const mime = (content_type || 'image/jpeg').toLowerCase();
    let ext = 'jpg';
    if (mime.includes('png')) ext = 'png';
    else if (mime.includes('webp')) ext = 'webp';
    else if (mime.includes('pdf')) ext = 'pdf';

    const key = `${order.company_id}/orders/${oid}/proof.${ext}`;
    const result = await uploadToR2(key, content, mime);
    if (!result.success) {
      console.error('[storefront] upload-proof R2 error:', result.error);
      return res.status(500).json({ error: 'Erro ao salvar comprovante' });
    }
    const url = result.mock ? result.url : `${result.url}?v=${Date.now()}`;

    await db.query(`
      UPDATE digital_orders SET
        payment_proof_url = $1,
        payment_proof_uploaded_at = NOW(),
        updated_at = NOW()
      WHERE id = $2
    `, [url, oid]);

    res.json({ payment_proof_url: url, key: result.key });
  } catch (err) {
    console.error('[storefront] upload-proof error:', err.message);
    res.status(500).json({ error: 'Erro ao enviar comprovante' });
  }
});

// ============================================================
// POST /storefront/:slug/order/:oid/mark-as-paid
// Cliente avisa que pagou Pix. Status pending_payment → awaiting_approval.
// Lojista ve o pedido em TabPedidos pra aprovar/rejeitar.
// ============================================================
router.post('/:slug/order/:oid/mark-as-paid', async (req, res) => {
  const slug = req.params.slug.toLowerCase().trim();
  const { oid } = req.params;

  try {
    const { rows } = await db.query(`
      SELECT o.id, o.status, o.company_id, o.customer_name, o.order_number, o.payment_method
      FROM digital_orders o
      JOIN digital_channel_config dcc ON dcc.company_id = o.company_id
      WHERE o.id = $1 AND dcc.slug = $2
    `, [oid, slug]);
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const order = rows[0];

    if (order.payment_method !== 'pix') {
      return res.status(400).json({ error: 'Apenas pedidos Pix precisam ser marcados como pagos' });
    }
    if (order.status === 'awaiting_approval') {
      return res.json({ status: 'awaiting_approval', message: 'Ja registrado.' });
    }
    if (order.status !== 'pending_payment') {
      return res.status(409).json({
        error: `Pedido nao pode ser marcado (status atual: ${order.status})`,
      });
    }

    await db.query(`
      UPDATE digital_orders SET
        status = 'awaiting_approval',
        updated_at = NOW()
      WHERE id = $1
    `, [oid]);

    res.json({
      status: 'awaiting_approval',
      message: 'Aguardando confirmacao do lojista. Voce sera avisado por WhatsApp.',
    });

    // Notifica lojista (fire-and-forget, tolera funcao ausente)
    if (typeof notify.notifyPaymentMarkedByCustomer === 'function') {
      notify.notifyPaymentMarkedByCustomer({ order })
        .catch(err => console.error('[notify] mark-as-paid error:', err.message));
    } else if (typeof notify.notifyStatusChange === 'function') {
      notify.notifyStatusChange({ ...order, status: 'awaiting_approval' })
        .catch(err => console.error('[notify] status change error:', err.message));
    }
  } catch (err) {
    console.error('[storefront] mark-as-paid error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar pedido como pago' });
  }
});

// ============================================================
// GET /storefront/:slug/order/:oid — Poll publico de status
// ============================================================
router.get('/:slug/order/:oid', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, order_number, status, payment_status, payment_method, total, delivery_type,
             asaas_pix_expires_at, payment_proof_url, payment_proof_uploaded_at,
             confirmed_at, delivered_at, cancelled_at
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
