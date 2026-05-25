// ============================================================
// AURA Studio - Marketplace Listing Helper + Preview
//
// Sub-onda Marketplaces S-1 (25/05/2026)
//
// Quando o core ML adapter (Fases 1-2 do BACKLOG_MARKETPLACE_INTEGRATIONS)
// chamar adapter.publishProduct(product), a Aura precisa montar um payload
// DIFERENTE pra produto personalizavel:
//   - handling_time estendido (precisa coletar personalizacao + produzir)
//   - descricao automatica explicando que e personalizado
//   - is_pre_order=true (Shopee) / listing_type_id=gold_special (ML)
//
// Esse modulo expoe:
//   - buildMercadoLivrePayload(product, settings) -> payload pronto pro ML adapter
//   - buildShopeePayload(product, settings) -> payload pronto pro Shopee adapter
//   - GET /studio/marketplace-listings/preview/:pid?platform=mercado_livre|shopee
//     mostra o payload que SERIA enviado (sem publicar de fato — core adapter
//     ainda nao existe). UI usa isso pra preview no admin.
//
// 25/05/2026 - registrado em projeto_studio_nivel1_DE_25mai2026
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

const PLATFORM_DEFAULTS = {
  mercado_livre: {
    handling_time_days: 7,    // base + producao + despacho
    listing_type_id: 'gold_special',
    condition: 'new',
    category_hint: 'MLB1430',   // Itens personalizados (placeholder — categoria real vem do category_predictor)
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

// ============================================================
// MERCADO LIVRE — payload do POST /items
// Docs: https://developers.mercadolivre.com.br/pt_br/itens-e-buscas
// ============================================================
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
    sale_terms: [
      {
        id: 'MANUFACTURING_TIME',
        value_name: handlingDays + ' dias',
      },
    ],
    shipping: {
      mode: 'me2',
      local_pick_up: false,
      free_shipping: false,
    },
    pictures: product.image_url ? [{ source: product.image_url }] : [],
    attributes: [
      {
        id: 'IS_HANDMADE',
        value_id: '242085',
        value_name: 'Sim',
      },
      {
        id: 'ITEM_CONDITION',
        value_id: '2230284',
        value_name: 'Novo',
      },
    ],
    _aura_meta: {
      vertical: 'studio',
      handling_time_days: handlingDays,
      is_personalizable: true,
      customization_field_count: ((product.customization_config || {}).fields || []).length,
    },
  };
}

// ============================================================
// SHOPEE — payload do POST /api/v2/product/add_item
// Docs: https://open.shopee.com/documents/v2/v2.product.add_item
// ============================================================
function buildShopeePayload(product, settings) {
  const handlingDays = resolveHandlingDays(settings, 'shopee');
  return {
    item_name: (product.name || '').slice(0, 100),
    description: buildAutoDescription(product, settings),
    item_status: 'NORMAL',
    category_id: 0, // a definir via category_recommend
    brand: { brand_id: 0, original_brand_name: 'Sem marca' },
    item_dimension: { package_length: 10, package_width: 10, package_height: 10 },
    weight: 0.5,
    price_info: [{ original_price: parseFloat(product.price) || 0 }],
    stock_info: [{
      stock_type: 1,
      current_stock: product.stock_qty != null ? Math.max(parseInt(product.stock_qty, 10) || 0, 1) : 999,
    }],
    pre_order: {
      is_pre_order: true,
      days_to_ship: handlingDays,
    },
    image: product.image_url ? { image_id_list: [], image_url_list: [product.image_url] } : { image_id_list: [], image_url_list: [] },
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
// GET /companies/:id/studio/marketplace-listings/preview/:pid
// Query: ?platform=mercado_livre (default) | shopee
// Devolve o payload Studio-aware que o adapter enviara quando o
// core ML/Shopee estiver pronto. Util pra preview no admin
// (e pra debugging do mapeamento).
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
      core_adapter_status: 'pending', // Fase 1-2 do BACKLOG_MARKETPLACE_INTEGRATIONS ainda nao foi implementada
      note: 'Preview-only. Quando o core ' + platform + ' adapter estiver pronto, esse payload sera enviado em POST /items (ML) ou add_item (Shopee).',
    });
  } catch (err) {
    console.error('[studio/marketplace-listings/preview] error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar preview do anuncio' });
  }
});

// ============================================================
// PATCH /companies/:id/studio/marketplace-settings
// Atualiza apenas marketplace_handling_days em studio_settings JSONB.
// Isolado aqui pra evitar mexer na whitelist ALLOWED_STUDIO_SETTINGS
// do studio.js (32kb). Quando o admin de Studio Marketplaces (S-4)
// ganhar tela dedicada, ela usa essa rota.
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

// Exports para uso interno do core adapter (quando vier)
module.exports = router;
module.exports.buildMercadoLivrePayload = buildMercadoLivrePayload;
module.exports.buildShopeePayload = buildShopeePayload;
module.exports.PLATFORM_DEFAULTS = PLATFORM_DEFAULTS;
