// ============================================================
// AURA Studio - Marketplace Listing Helper + Preview + Orders + Stats
//
// S-1 (25/05): payload helper + preview
// S-2 (25/05): rotas admin de coleta de personalizacao
// S-4 (25/05): stats agregadas + tracking pos-envio
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

const PLATFORM_DEFAULTS = {
  mercado_livre: {
    handling_time_days: 7,
    listing_type_id: 'gold_special',
    condition: 'new',
    category_hint: 'MLB1430',
  },
  shopee: {
    handling_time_days: 7,
    is_pre_order: true,
    days_to_ship: 7,
  },
};

const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_DEFAULTS);

function getStudioSettings(companyRow) {
  return (companyRow && companyRow.studio_settings) || {};
}

function resolveHandlingDays(settings, platform) {
  const fromSettings = parseInt(settings.marketplace_handling_days, 10);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings;
  return PLATFORM_DEFAULTS[platform].handling_time_days;
}

function buildAutoDescription(product, settings) {
  const fields = product.customization_config && product.customization_config.fields;
  if (!Array.isArray(fields) || fields.length === 0) return product.description || product.name;
  const fieldList = fields
    .map((f) => '- ' + (f.label || f.id) + (f.required ? ' (obrigatorio)' : ''))
    .join('\n');
  const handlingDays = resolveHandlingDays(settings, 'mercado_livre');
  return [
    product.description ? product.description.trim() : '',
    '',
    'PRODUTO PERSONALIZADO sob encomenda.',
    '',
    'Voce escolhe:',
    fieldList,
    '',
    'Como funciona:',
    '1. Voce compra aqui',
    '2. A loja entra em contato para coletar a personalizacao',
    '3. Voce recebe o mockup para aprovar antes da producao',
    '4. Producao + envio em ate ' + handlingDays + ' dias uteis',
    '',
    'Suporte rapido pelo chat do marketplace.',
  ].filter(Boolean).join('\n');
}

function buildMercadoLivrePayload(product, settings) {
  const handlingDays = resolveHandlingDays(settings, 'mercado_livre');
  const stockHint = product.stock_qty != null ? Math.max(parseInt(product.stock_qty, 10) || 0, 1) : 999;
  return {
    title: (product.name || '').slice(0, 60),
    category_id: PLATFORM_DEFAULTS.mercado_livre.category_hint,
    price: parseFloat(product.price) || 0,
    currency_id: 'BRL',
    available_quantity: stockHint,
    buying_mode: 'buy_it_now',
    listing_type_id: PLATFORM_DEFAULTS.mercado_livre.listing_type_id,
    condition: PLATFORM_DEFAULTS.mercado_livre.condition,
    description: { plain_text: buildAutoDescription(product, settings) },
    sale_terms: [{ id: 'MANUFACTURING_TIME', value_name: handlingDays + ' dias' }],
    shipping: { mode: 'me2', local_pick_up: false, free_shipping: false },
    pictures: product.image_url ? [{ source: product.image_url }] : [],
    attributes: [
      { id: 'IS_HANDMADE', value_id: '242085', value_name: 'Sim' },
      { id: 'ITEM_CONDITION', value_id: '2230284', value_name: 'Novo' },
    ],
    _aura_meta: {
      vertical: 'studio',
      handling_time_days: handlingDays,
      is_personalizable: true,
      customization_field_count: ((product.customization_config || {}).fields || []).length,
    },
  };
}

function buildShopeePayload(product, settings) {
  const handlingDays = resolveHandlingDays(settings, 'shopee');
  return {
    item_name: (product.name || '').slice(0, 100),
    description: buildAutoDescription(product, settings),
    item_status: 'NORMAL',
    category_id: 0,
    brand: { brand_id: 0, original_brand_name: 'Sem marca' },
    item_dimension: { package_length: 10, package_width: 10, package_height: 10 },
    weight: 0.5,
    price_info: [{ original_price: parseFloat(product.price) || 0 }],
    stock_info: [{
      stock_type: 1,
      current_stock: product.stock_qty != null ? Math.max(parseInt(product.stock_qty, 10) || 0, 1) : 999,
    }],
    pre_order: { is_pre_order: true, days_to_ship: handlingDays },
    image: product.image_url
      ? { image_id_list: [], image_url_list: [product.image_url] }
      : { image_id_list: [], image_url_list: [] },
    _aura_meta: {
      vertical: 'studio',
      handling_time_days: handlingDays,
      is_personalizable: true,
      customization_field_count: ((product.customization_config || {}).fields || []).length,
    },
  };
}

const BUILDERS = {
  mercado_livre: buildMercadoLivrePayload,
  shopee: buildShopeePayload,
};

// S-1: GET preview
router.get('/marketplace-listings/preview/:pid', async (req, res) => {
  const cid = req.params.id;
  const pid = req.params.pid;
  const platform = (req.query.platform || 'mercado_livre').toLowerCase();
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'platform invalida. Use: ' + SUPPORTED_PLATFORMS.join(', ') });
  }
  try {
    const productRes = await db.query(
      `SELECT p.id, p.name, p.description, p.price, p.stock_qty, p.image_url,
              p.is_personalizable, p.customization_config, c.studio_settings
         FROM products p
         JOIN companies c ON c.id = p.company_id
        WHERE p.id = $1 AND p.company_id = $2`,
      [pid, cid]
    );
    if (!productRes.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const product = productRes.rows[0];
    if (!product.is_personalizable) {
      return res.status(400).json({ error: 'Produto nao eh personalizavel.' });
    }
    const settings = getStudioSettings({ studio_settings: product.studio_settings });
    const payload = BUILDERS[platform](product, settings);
    res.json({
      platform, product_id: product.id, product_name: product.name,
      handling_time_days: resolveHandlingDays(settings, platform),
      payload, core_adapter_status: 'pending',
      note: 'Preview-only. Quando o core ' + platform + ' adapter estiver pronto, esse payload sera enviado.',
    });
  } catch (err) {
    console.error('[studio/marketplace-listings/preview] error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar preview do anuncio' });
  }
});

// S-1: PATCH marketplace-settings
router.patch('/marketplace-settings', async (req, res) => {
  const cid = req.params.id;
  const handlingDays = parseInt(req.body?.marketplace_handling_days, 10);
  if (!Number.isFinite(handlingDays) || handlingDays < 1 || handlingDays > 60) {
    return res.status(400).json({ error: 'marketplace_handling_days deve ser numero inteiro entre 1 e 60 (dias uteis)' });
  }
  try {
    const r = await db.query(
      `UPDATE companies
          SET studio_settings = COALESCE(studio_settings, '{}'::jsonb)
                                  || jsonb_build_object('marketplace_handling_days', $1::int),
              updated_at = NOW()
        WHERE id = $2
        RETURNING COALESCE(studio_settings, '{}'::jsonb) AS settings`,
      [handlingDays, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    res.json({ marketplace_handling_days: handlingDays, settings: r.rows[0].settings });
  } catch (err) {
    console.error('[studio/marketplace-settings PATCH] error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar marketplace_handling_days' });
  }
});

// S-2: GET marketplace-orders
router.get('/marketplace-orders', async (req, res) => {
  const cid = req.params.id;
  const pendingOnly = req.query.pending_only !== 'false';
  const platform = (req.query.platform || '').toString().trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const params = [cid];
    let where = `WHERE company_id = $1 AND vertical = 'studio'`;
    if (pendingOnly) where += ` AND customization_collected_at IS NULL`;
    if (platform && SUPPORTED_PLATFORMS.includes(platform)) {
      params.push(platform);
      where += ` AND platform = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await db.query(
      `SELECT id, platform, external_id, status, customer_name, customer_doc,
              shipping_address, items, subtotal, total, marketplace_fee,
              tracking_code, customization_collected_at, customization_data,
              studio_production_status_override, shipped_at, delivered_at,
              created_at, updated_at
         FROM marketplace_orders
         ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ orders: rows, count: rows.length, pending_only: pendingOnly, platform: platform || null });
  } catch (err) {
    console.error('[studio/marketplace-orders GET] error:', err.message);
    res.status(500).json({ error: 'Erro ao listar pedidos de marketplace' });
  }
});

// S-2: PATCH customization
router.patch('/marketplace-orders/:oid/customization', async (req, res) => {
  const cid = req.params.id;
  const oid = req.params.oid;
  const customization = req.body?.customization;
  if (!customization || typeof customization !== 'object') {
    return res.status(400).json({ error: 'customization (objeto JSON) obrigatorio' });
  }
  try {
    const { rows } = await db.query(
      `UPDATE marketplace_orders
          SET customization_data = $1::jsonb,
              customization_collected_at = NOW(),
              updated_at = NOW()
        WHERE id = $2 AND company_id = $3 AND vertical = 'studio'
        RETURNING id, customization_collected_at, customization_data, status`,
      [JSON.stringify(customization), oid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    res.json({
      ok: true, order_id: rows[0].id,
      customization_collected_at: rows[0].customization_collected_at,
      customization_data: rows[0].customization_data,
      next_step: 'pending_art',
      message: 'Personalizacao salva. Pedido pode avancar pra producao no KDS Studio.',
    });
  } catch (err) {
    console.error('[studio/marketplace-orders PATCH] error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar personalizacao' });
  }
});

// S-4 (25/05): PATCH tracking + status=enviado
router.patch('/marketplace-orders/:oid/tracking', async (req, res) => {
  const cid = req.params.id;
  const oid = req.params.oid;
  const trackingCode = (req.body?.tracking_code || '').toString().trim();
  if (!trackingCode || trackingCode.length < 3) {
    return res.status(400).json({ error: 'tracking_code obrigatorio (>=3 chars)' });
  }
  try {
    const { rows } = await db.query(
      `UPDATE marketplace_orders
          SET tracking_code = $1,
              status = 'enviado',
              shipped_at = NOW(),
              studio_production_status_override = 'ready',
              updated_at = NOW()
        WHERE id = $2 AND company_id = $3 AND vertical = 'studio'
        RETURNING id, tracking_code, status, shipped_at`,
      [trackingCode, oid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    res.json({
      ok: true,
      ...rows[0],
      message: 'Codigo de rastreio salvo. Status atualizado pra enviado.',
      core_adapter_status: 'pending',
      note: 'Aviso de envio NAO foi enviado pro marketplace (core adapter pendente). Faca isso manualmente pelo painel ML/Shopee tambem.',
    });
  } catch (err) {
    console.error('[studio/marketplace-orders tracking] error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar tracking' });
  }
});

// S-2: stub create
router.post('/marketplace-orders/_stub_create', async (req, res) => {
  const cid = req.params.id;
  const { platform, external_id, customer_name, customer_doc, items, total, connection_id } = req.body || {};
  if (!platform || !SUPPORTED_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'platform invalida. Use: ' + SUPPORTED_PLATFORMS.join(', ') });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items obrigatorio' });
  }
  try {
    let connId = connection_id || null;
    if (!connId) {
      const c = await db.query(
        `SELECT id FROM marketplace_connections
          WHERE company_id = $1 AND platform = $2 AND status = 'ativo'
          ORDER BY created_at DESC LIMIT 1`,
        [cid, platform]
      );
      connId = c.rows[0]?.id || null;
    }
    if (!connId) {
      return res.status(400).json({
        error: 'Sem conexao ativa para ' + platform + '. Crie uma em POST /marketplaces/connections antes.',
      });
    }
    const stubExternalId = external_id || ('STUB-' + Date.now());
    const totalNum = parseFloat(total) || items.reduce(
      (s, it) => s + (parseFloat(it.unit_price) || 0) * (parseInt(it.quantity) || 1), 0
    );
    const { rows } = await db.query(
      `INSERT INTO marketplace_orders
         (company_id, connection_id, platform, external_id, status,
          customer_name, customer_doc, items, subtotal, total,
          vertical, external_data)
       VALUES ($1, $2, $3, $4, 'novo', $5, $6, $7::jsonb, $8, $8, 'studio', $9::jsonb)
       RETURNING *`,
      [
        cid, connId, platform, stubExternalId,
        customer_name || null, customer_doc || null,
        JSON.stringify(items), totalNum,
        JSON.stringify({ _stub: true, created_via: 'studio/marketplace-orders/_stub_create' }),
      ]
    );
    res.status(201).json({ order: rows[0], stub: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'external_id ja existe nessa plataforma.' });
    }
    console.error('[studio/marketplace-orders stub] error:', err.message);
    res.status(500).json({ error: 'Erro ao criar pedido stub' });
  }
});

// S-4 (25/05): GET /marketplace/stats — agregadas pro Hub
router.get('/marketplace/stats', async (req, res) => {
  const cid = req.params.id;
  try {
    const overall = await db.query(
      `SELECT
          COUNT(*) FILTER (WHERE customization_collected_at IS NULL)::int AS pending,
          COUNT(*) FILTER (
            WHERE customization_collected_at IS NOT NULL
              AND customization_collected_at::date = CURRENT_DATE
          )::int AS collected_today,
          COUNT(*) FILTER (
            WHERE customization_collected_at IS NULL
              AND created_at < NOW() - INTERVAL '24 hours'
          )::int AS overdue,
          COUNT(*) FILTER (WHERE status = 'enviado')::int AS shipped_count,
          COUNT(*) FILTER (WHERE status = 'entregue')::int AS delivered_count,
          COUNT(*)::int AS total_orders,
          ROUND(AVG(total)::numeric, 2) AS avg_ticket,
          COALESCE(SUM(total), 0)::numeric(12,2) AS gmv_total
        FROM marketplace_orders
        WHERE company_id = $1 AND vertical = 'studio'`,
      [cid]
    );
    const byPlatform = await db.query(
      `SELECT
          platform,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE customization_collected_at IS NULL)::int AS pending,
          COALESCE(SUM(total), 0)::numeric(12,2) AS gmv
        FROM marketplace_orders
        WHERE company_id = $1 AND vertical = 'studio'
        GROUP BY platform
        ORDER BY platform`,
      [cid]
    );
    res.json({
      ...overall.rows[0],
      by_platform: byPlatform.rows,
      computed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[studio/marketplace/stats] error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular stats marketplace' });
  }
});

module.exports = router;
module.exports.buildMercadoLivrePayload = buildMercadoLivrePayload;
module.exports.buildShopeePayload = buildShopeePayload;
module.exports.PLATFORM_DEFAULTS = PLATFORM_DEFAULTS;
