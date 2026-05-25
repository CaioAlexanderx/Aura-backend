// ============================================================
// AURA. — Webhook stub Marketplaces (ML + Shopee)
//
// Sub-onda Studio S-3 (25/05/2026):
// Endpoints publicos (sem auth) que recebem payloads de ML/Shopee
// e criam marketplace_orders.vertical='studio' quando o produto eh
// is_personalizable. Sem signature validation real — quando o core
// ML/Shopee adapter (Fases 1-2 do BACKLOG_MARKETPLACE_INTEGRATIONS)
// for entregue:
//   - ML: verificar HMAC do x-secret-key
//   - Shopee: verificar partner_secret signature
//
// Body shape (Aura-normalizado, stub mode):
// {
//   company_id: uuid,            -- empresa destino (vem do connection_id mapping na vida real)
//   external_id: string,         -- ID do pedido no marketplace (MLB123 / SP-987)
//   customer_name, customer_doc,
//   items: [{ product_id, quantity, unit_price, product_name }],
//   total: 99.90,
//   shipping_address: {...},
//   raw: {...}                   -- payload original do marketplace (debug)
// }
//
// Pra ser substituido por handler real quando o adapter vier — esse
// arquivo entao vira um shim/teste de QA. Por enquanto e a unica forma
// de simular webhook end-to-end.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

async function createMarketplaceOrderFromStub(platform, body) {
  const { company_id, external_id, customer_name, customer_doc, items, total, shipping_address, raw } = body || {};

  if (!company_id) {
    const err = new Error('company_id obrigatorio (stub mode — sem OAuth)');
    err.statusCode = 400;
    throw err;
  }
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('items obrigatorio (>=1)');
    err.statusCode = 400;
    throw err;
  }

  // Pega connection_id ativa pra essa plataforma
  let connId = null;
  try {
    const c = await db.query(
      `SELECT id FROM marketplace_connections
        WHERE company_id = $1 AND platform = $2 AND status = 'ativo'
        ORDER BY created_at DESC LIMIT 1`,
      [company_id, platform]
    );
    connId = c.rows[0]?.id || null;
  } catch (_) {}
  if (!connId) {
    const err = new Error(`Sem conexao ativa para ${platform}. Crie uma em /marketplaces/connections antes.`);
    err.statusCode = 400;
    throw err;
  }

  // Detecta se TODOS os produtos do payload sao is_personalizable.
  // Se sim: vertical='studio'. Se nao: 'retail' (fluxo varejo padrao).
  const productIds = items.map((it) => it.product_id).filter(Boolean);
  let isStudioOrder = false;
  if (productIds.length > 0) {
    const r = await db.query(
      `SELECT id, is_personalizable FROM products
        WHERE id::text = ANY($1)
          AND company_id = $2`,
      [productIds.map(String), company_id]
    );
    const personalizable = r.rows.filter((p) => p.is_personalizable).length;
    isStudioOrder = personalizable > 0;
  }

  const stubExternalId = external_id || (`STUB-${platform}-${Date.now()}`);
  const totalNum = parseFloat(total) || items.reduce(
    (s, it) => s + (parseFloat(it.unit_price) || 0) * (parseInt(it.quantity) || 1), 0
  );

  const externalData = JSON.stringify({
    _stub: true,
    _raw: raw || null,
    created_via: 'webhook-stub',
    detected_studio: isStudioOrder,
    received_at: new Date().toISOString(),
  });

  try {
    const { rows } = await db.query(
      `INSERT INTO marketplace_orders
         (company_id, connection_id, platform, external_id, status,
          customer_name, customer_doc, shipping_address, items,
          subtotal, total, vertical, external_data)
       VALUES ($1, $2, $3, $4, 'novo',
               $5, $6, $7::jsonb, $8::jsonb,
               $9, $9, $10, $11::jsonb)
       RETURNING *`,
      [
        company_id, connId, platform, stubExternalId,
        customer_name || null, customer_doc || null,
        shipping_address ? JSON.stringify(shipping_address) : null,
        JSON.stringify(items),
        totalNum,
        isStudioOrder ? 'studio' : 'retail',
        externalData,
      ]
    );
    return { order: rows[0], detected_studio: isStudioOrder };
  } catch (err) {
    if (err.code === '23505') {
      const dupe = new Error(`external_id ${stubExternalId} ja existe pra ${platform}`);
      dupe.statusCode = 409;
      throw dupe;
    }
    throw err;
  }
}

// POST /api/v1/webhooks/mercadolivre
router.post('/mercadolivre', async (req, res) => {
  try {
    const result = await createMarketplaceOrderFromStub('mercado_livre', req.body);
    res.status(201).json({
      ok: true,
      platform: 'mercado_livre',
      ...result,
      note: 'Stub mode — sem signature validation. Core ML adapter pendente.',
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[webhook/ML stub] error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

// POST /api/v1/webhooks/shopee
router.post('/shopee', async (req, res) => {
  try {
    const result = await createMarketplaceOrderFromStub('shopee', req.body);
    res.status(201).json({
      ok: true,
      platform: 'shopee',
      ...result,
      note: 'Stub mode — sem signature validation. Core Shopee adapter pendente.',
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[webhook/Shopee stub] error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
module.exports.createMarketplaceOrderFromStub = createMarketplaceOrderFromStub;
