// ============================================================
// AURA Studio - Marketplace Listing Helper + Preview + Orders
//
// Sub-onda Marketplaces S-1 (25/05/2026): payload helper + preview
// Sub-onda Marketplaces S-2 (25/05/2026): rotas admin pra coletar
//   personalizacao de pedidos vindos de ML/Shopee.
//
// Esse modulo expoe:
//  S-1:
//   - buildMercadoLivrePayload(product, settings) -> payload pronto pro ML adapter
//   - buildShopeePayload(product, settings) -> payload pronto pro Shopee adapter
//   - GET /studio/marketplace-listings/preview/:pid?platform=mercado_livre|shopee
//   - PATCH /studio/marketplace-settings { marketplace_handling_days }
//  S-2:
//   - GET /studio/marketplace-orders?pending_only=true&platform=mercado_livre
//     lista marketplace_orders WHERE vertical='studio'
//   - PATCH /studio/marketplace-orders/:oid/customization
//     salva customization_data JSONB + customization_collected_at=NOW
//   - POST /studio/marketplace-orders/_stub_create (dev-only)
//     cria linha manual de marketplace_orders pra testar fluxo
//     ENQUANTO o core ML/Shopee adapter (Fases 1-2) nao envia webhooks reais
//
// 25/05/2026 - registrado em projeto_studio_marketplaces_S0_S1_25mai2026
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

// ============================================================
// GET /companies/:id/studio/marketplace-listings/preview/:pid (S-1)
// ============================================================
router.get('/marketplace-listings/preview/:pid', async (req, res) => {
  const cid = req.params.id;
  const pid = req.params.pid;
  const platform = (req.query.platform || 'mercado_livre').toLowerCase();

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return res.status(400).json({
      error: 'platform invalida. Use: ' + SUPPORTED_PLATFORMS.join(', '),
    });
  }

  try {
    const productRes = await db.query(
      `SELECT p.id, p.name, p.description, p.price, p.stock_qty, p.image_url,
              p.is_personalizable, p.customization_config,
              c.studio_settings
         FROM products p
         JOIN companies c ON c.id = p.company_id
        WHERE p.id = $1 AND p.company_id = $2`,
      [pid, cid]
    );
    if (!productRes.rows.length) {
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }
    const product = productRes.rows[0];
    if (!product.is_personalizable) {
      return res.status(400).json({
        error: 'Produto nao eh personalizavel. Use o fluxo de marketplace varejo (BACKLOG_MARKETPLACE_INTEGRATIONS).',
      });
    }

    const settings = getStudioSettings({ studio_settings: product.studio_settings });
    const payload = BUILDERS[platform](product, settings);

    res.json({
      platform,
      product_id: product.id,
      product_name: product.name,
      handling_time_days: resolveHandlingDays(settings, platform),
      payload,
      core_adapter_status: 'pending',
      note: 'Preview-only. Quando o core ' + platform + ' adapter estiver pronto, esse payload sera enviado em POST /items (ML) ou add_item (Shopee).',
    });
  } catch (err) {
    console.error('[studio/marketplace-listings/preview] error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar preview do anuncio' });
  }
});

// ============================================================
// PATCH /companies/:id/studio/marketplace-settings (S-1)
// ============================================================
router.patch('/marketplace-settings', async (req, res) => {
  const cid = req.params.id;
  const handlingDaysRaw = req.body && req.body.marketplace_handling_days;
  const handlingDays = parseInt(handlingDaysRaw, 10);
  if (!Number.isFinite(handlingDays) || handlingDays < 1 || handlingDays > 60) {
    return res.status(400).json({
      error: 'marketplace_handling_days deve ser numero inteiro entre 1 e 60 (dias uteis)',
    });
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
    res.json({
      marketplace_handling_days: handlingDays,
      settings: r.rows[0].settings,
    });
  } catch (err) {
    console.error('[studio/marketplace-settings PATCH] error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar marketplace_handling_days' });
  }
});

// ════════════════════════════════════════════════════════════
// S-2 (25/05/2026): rotas admin pra pedidos de marketplace Studio
// ════════════════════════════════════════════════════════════

// ============================================================
// GET /companies/:id/studio/marketplace-orders
// Query:
//  ?pending_only=true (default true) — apenas customization_collected_at IS NULL
//  ?platform=mercado_livre|shopee
//  ?limit=50 (max 200)
// Devolve marketplace_orders WHERE vertical='studio' + dados pra UI.
// ============================================================
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
              created_at, updated_at
         FROM marketplace_orders
         ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );

    res.json({
      orders: rows,
      count: rows.length,
      pending_only: pendingOnly,
      platform: platform || null,
    });
  } catch (err) {
    console.error('[studio/marketplace-orders GET] error:', err.message);
    res.status(500).json({ error: 'Erro ao listar pedidos de marketplace' });
  }
});

// ============================================================
// PATCH /companies/:id/studio/marketplace-orders/:oid/customization
// Body: { customization: {...JSONB pelos fields do produto...} }
// Salva customization_data + customization_collected_at=NOW.
// Pos-condicao: pedido pode avancar pra producao normal (KDS).
// ============================================================
router.patch('/marketplace-orders/:oid/customization', async (req, res) => {
  const cid = req.params.id;
  const oid = req.params.oid;
  const customization = req.body && req.body.customization;

  if (!customization || typeof customization !== 'object') {
    return res.status(400).json({ error: 'customization (objeto JSON) obrigatorio' });
  }

  try {
    const { rows } = await db.query(
      `UPDATE marketplace_orders
          SET customization_data = $1::jsonb,
              customization_collected_at = NOW(),
              updated_at = NOW()
        WHERE id = $2
          AND company_id = $3
          AND vertical = 'studio'
        RETURNING id, customization_collected_at, customization_data, status`,
      [JSON.stringify(customization), oid, cid]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Pedido de marketplace nao encontrado (ou nao e Studio)' });
    }
    res.json({
      ok: true,
      order_id: rows[0].id,
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

// ============================================================
// POST /companies/:id/studio/marketplace-orders/_stub_create
// DEV-ONLY: cria manualmente um marketplace_order com vertical='studio'
// pra testar o fluxo de coleta enquanto o core ML/Shopee nao envia
// webhooks reais. Quando o core estiver pronto, essa rota fica
// deprecated mas continua util pra QA.
//
// Body:
//  {
//    platform: 'mercado_livre' | 'shopee',
//    external_id: 'MLB123456789' (default 'STUB-<timestamp>'),
//    customer_name: 'Joao da Silva',
//    customer_doc: '12345678901',
//    items: [{ product_id, quantity, unit_price, product_name }],
//    total: 99.90,
//    connection_id: uuid (opcional — se nao tiver, pega primeira ativa)
//  }
// ============================================================
router.post('/marketplace-orders/_stub_create', async (req, res) => {
  const cid = req.params.id;
  const {
    platform, external_id, customer_name, customer_doc, items, total, connection_id,
  } = req.body || {};

  if (!platform || !SUPPORTED_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'platform invalida. Use: ' + SUPPORTED_PLATFORMS.join(', ') });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items obrigatorio' });
  }

  try {
    // Pega connection_id: usa o fornecido OU primeira conexao ativa da empresa pra essa plataforma
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
        error: 'Sem conexao ativa para ' + platform + '. Crie uma em POST /marketplaces/connections antes (mesmo stub).',
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
       VALUES ($1, $2, $3, $4, 'novo',
               $5, $6, $7::jsonb, $8, $8,
               'studio', $9::jsonb)
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
      return res.status(409).json({ error: 'external_id ja existe nessa plataforma. Use outro.' });
    }
    console.error('[studio/marketplace-orders stub] error:', err.message);
    res.status(500).json({ error: 'Erro ao criar pedido stub' });
  }
});

// Exports para uso interno do core adapter (quando vier)
module.exports = router;
module.exports.buildMercadoLivrePayload = buildMercadoLivrePayload;
module.exports.buildShopeePayload = buildShopeePayload;
module.exports.PLATFORM_DEFAULTS = PLATFORM_DEFAULTS;
