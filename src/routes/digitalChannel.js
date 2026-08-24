// ============================================================
// AURA. — Canal Digital CRUD + Storefront + Dominio + Imagens + Pix
// GET  /companies/:id/digital-channel
// PUT  /companies/:id/digital-channel
// GET  /companies/:id/digital-channel/products       (Fase 4)
// POST /companies/:id/digital-channel/request-domain
// POST /companies/:id/digital-channel/upload-image?type=logo|banner|banner_0|banner_1|banner_2
// POST /companies/:id/digital-channel/setup-pix       (legado Asaas)
//
// Migration 115: v2 redesign — accent_color, dark_mode, font_family,
// card_style, banners[] JSONB, announcement_bar.
// Migration 116: service_cards[] JSONB (4 cards na strip de benefícios).
// Migration 119: hidden_product_ids text[] + nova semantica de featured_product_ids
//                (vira ordem de destaque, nao filtra mais a vitrine). featured continua jsonb.
// Migration 120 (Fase 5 — 20/05/2026): pickup_address, pickup_eta_text,
//                delivery_eta_text, origin_zip, origin_lat, origin_lng,
//                delivery_pricing_mode (flat|distance), delivery_distance_tiers (jsonb),
//                delivery_free_above_amount.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');
const { uploadToR2, deleteFromR2 } = require('../utils/r2Storage');
const { validatePixKey } = require('../services/staticPixService');
const { geocodeCep, normalizeCep } = require('../services/cepGeocoding');
const { POLITICA_PADRAO } = require('../templates/storefrontHtml');

const ALLOWED_ICONS = ['truck','pkg','shield','sparkle','leaf','heart','star','pix','card','receipt','bag','user'];

const DEFAULT_BANNERS = [
  { kicker: '', headline: 'Bem-vindo à nossa loja', body: 'Curadoria editada, pensada pra durar.', cta: 'Ver produtos', tone: 'split', tint: 'brand', image_url: null, enabled: true },
];

const DEFAULT_SERVICE_CARDS = [
  { icon: 'truck',   title: 'Entrega rápida',      body: 'Confirmação no WhatsApp', enabled: true },
  { icon: 'pkg',     title: 'Embalagem cuidadosa', body: 'Pronta pra presentear',   enabled: true },
  { icon: 'shield',  title: 'Pagamento seguro',    body: 'Pix e demais opções',     enabled: true },
  { icon: 'sparkle', title: 'Curadoria editada',   body: 'Produtos selecionados',   enabled: true },
];

const DEFAULT_CONFIG = {
  site_name: null, tagline: '', primary_color: '#7c3aed', secondary_color: '#a78bfa',
  accent_color: '#a78bfa', dark_mode: false, font_family: 'classic', card_style: 'editorial',
  banners: DEFAULT_BANNERS, announcement_bar: '', service_cards: DEFAULT_SERVICE_CARDS,
  logo_url: null, cover_url: null, description: '', address: '', phone: '', whatsapp: '',
  instagram: '', google_maps_url: '',
  pix_key: null, pix_key_type: null, pix_holder_name: null, pix_holder_city: null,
  pay_on_delivery_enabled: false,
  business_hours: {
    seg: { open: '09:00', close: '18:00', closed: false },
    ter: { open: '09:00', close: '18:00', closed: false },
    qua: { open: '09:00', close: '18:00', closed: false },
    qui: { open: '09:00', close: '18:00', closed: false },
    sex: { open: '09:00', close: '18:00', closed: false },
    sab: { open: '09:00', close: '13:00', closed: false },
    dom: { open: null, close: null, closed: true },
  },
  featured_product_ids: [], hidden_product_ids: [], show_prices: true, show_stock: false,
  delivery_enabled: false, delivery_fee: 0, delivery_radius_km: 5,
  pickup_enabled: true,
  card_enabled: true, // Migration 121
  is_published: false, slug: null,
  custom_domain: null, custom_domain_status: 'none',
  custom_domain_plan: null, custom_domain_expires_at: null, custom_domain_price: null,
  // Fase 5 (migration 120)
  pickup_address: null, pickup_eta_text: null, delivery_eta_text: null,
  origin_zip: null, origin_lat: null, origin_lng: null,
  delivery_pricing_mode: 'flat', delivery_distance_tiers: [],
  delivery_free_above_amount: null,
};

const STOREFRONT_BASE = process.env.STOREFRONT_BASE_URL || 'https://loja.getaura.com.br';

function generateSlug(name) {
  return (name || 'loja')
    .toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

let _v2ColumnsCache = null;
async function hasV2Columns() {
  if (_v2ColumnsCache !== null) return _v2ColumnsCache;
  try {
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'digital_channel_config'
         AND column_name IN ('accent_color','dark_mode','font_family','card_style','banners','announcement_bar','service_cards')
    `);
    _v2ColumnsCache = rows.length === 7;
  } catch { _v2ColumnsCache = false; }
  return _v2ColumnsCache;
}

// Cache da existencia da coluna hidden_product_ids (migration 119).
// Toda leitura/escrita dessa coluna verifica antes — pattern
// armadilha_schema_pre_migration: o backend nao roda migrations no boot,
// entao codigo defensivo eh obrigatorio nos primeiros dias pos-deploy.
let _hiddenColumnCache = null;
async function hasHiddenColumn() {
  if (_hiddenColumnCache !== null) return _hiddenColumnCache;
  try {
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'digital_channel_config'
         AND column_name = 'hidden_product_ids'
    `);
    _hiddenColumnCache = rows.length === 1;
  } catch { _hiddenColumnCache = false; }
  return _hiddenColumnCache;
}

// Cache da existencia das colunas Fase 5 (migration 120). Defensivo:
// se a migration nao rodou, o UPDATE Fase 5 vira no-op silencioso.
let _fase5ColumnsCache = null;
async function hasFase5Columns() {
  if (_fase5ColumnsCache !== null) return _fase5ColumnsCache;
  try {
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'digital_channel_config'
         AND column_name IN ('pickup_address','pickup_eta_text','delivery_eta_text','origin_zip','origin_lat','origin_lng','delivery_pricing_mode','delivery_distance_tiers','delivery_free_above_amount')
    `);
    _fase5ColumnsCache = rows.length === 9;
  } catch { _fase5ColumnsCache = false; }
  return _fase5ColumnsCache;
}

// Visibility canonica de products (alinhada com storefrontBuilder/products.js)
function listVisibilityWhere(cidParam) {
  return `(company_id = ${cidParam} OR (
    is_group_shared = true
    AND company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(`SELECT * FROM digital_channel_config WHERE company_id = $1`, [cid]);
    if (!rows.length) {
      const { rows: companies } = await db.query(
        `SELECT legal_name, trade_name, phone FROM companies WHERE id = $1`, [cid]
      );
      const co = companies[0] || {};
      return res.json({
        ...DEFAULT_CONFIG,
        site_name: co.trade_name || co.legal_name || null,
        phone: co.phone || '',
        exists: false,
        storefront_url: null,
        politica_troca_padrao: POLITICA_PADRAO,
      });
    }
    const config = rows[0];
    res.json({
      ...config,
      accent_color: config.accent_color || config.secondary_color || DEFAULT_CONFIG.accent_color,
      dark_mode: config.dark_mode ?? false,
      font_family: config.font_family || 'classic',
      card_style: config.card_style || 'editorial',
      banners: Array.isArray(config.banners) && config.banners.length ? config.banners : DEFAULT_BANNERS,
      service_cards: Array.isArray(config.service_cards) && config.service_cards.length ? config.service_cards : DEFAULT_SERVICE_CARDS,
      announcement_bar: config.announcement_bar || '',
      business_hours: config.business_hours || DEFAULT_CONFIG.business_hours,
      featured_product_ids: config.featured_product_ids || [],
      hidden_product_ids: config.hidden_product_ids || [],
      // Fase 5 (migration 120) — fallback null/default quando colunas inexistem
      pickup_address:        config.pickup_address ?? null,
      pickup_eta_text:       config.pickup_eta_text ?? null,
      delivery_eta_text:     config.delivery_eta_text ?? null,
      origin_zip:            config.origin_zip ?? null,
      origin_lat:            config.origin_lat != null ? parseFloat(config.origin_lat) : null,
      origin_lng:            config.origin_lng != null ? parseFloat(config.origin_lng) : null,
      delivery_pricing_mode: config.delivery_pricing_mode || 'flat',
      delivery_distance_tiers: Array.isArray(config.delivery_distance_tiers)
        ? config.delivery_distance_tiers
        : (typeof config.delivery_distance_tiers === 'string'
            ? (() => { try { const p = JSON.parse(config.delivery_distance_tiers); return Array.isArray(p) ? p : []; } catch { return []; } })()
            : []),
      delivery_free_above_amount: config.delivery_free_above_amount != null
        ? parseFloat(config.delivery_free_above_amount)
        : null,
      exists: true,
      // O texto padrao vem do MESMO lugar que a loja usa. O painel
      // pre-preenche o campo com ele; se duplicassemos no app, uma
      // correcao no texto passaria a valer na loja e nao no painel — e a
      // lojista leria uma politica e publicaria outra.
      politica_troca: config.politica_troca ?? null,
      politica_troca_padrao: POLITICA_PADRAO,
      storefront_url: config.slug ? `${STOREFRONT_BASE}/${config.slug}` : null,
      domain_pricing: { '1year': 80, '2years': 152 },
    });
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return res.json({ ...DEFAULT_CONFIG, exists: false, storefront_url: null });
    }
    console.error('digital channel get error:', err);
    res.status(500).json({ error: 'Erro ao buscar configuracao do canal digital' });
  }
});

// Normaliza qualquer formato (text[], jsonb array, ja-parseado) pra array
// de strings JS. Espelha parseFeaturedIds do storefrontBuilder.
function toStringIdArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(String) : []; }
    catch { return []; }
  }
  return [];
}

// ============================================================
// GET /companies/:id/digital-channel/products
// Lista produtos ativos da empresa COM estado de featured/hidden,
// para a aba Vitrine do admin marcar/desmarcar. (Fase 4)
// ============================================================
router.get('/products', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  try {
    // carrega config atual pra saber featured/hidden
    let featuredIds = [];
    let hiddenIds = [];
    try {
      const hasHidden = await hasHiddenColumn();
      const cols = hasHidden
        ? 'featured_product_ids, hidden_product_ids'
        : 'featured_product_ids';
      const { rows: cfgRows } = await db.query(
        `SELECT ${cols} FROM digital_channel_config WHERE company_id = $1`,
        [cid]
      );
      if (cfgRows.length) {
        featuredIds = toStringIdArray(cfgRows[0].featured_product_ids);
        if (hasHidden) {
          hiddenIds = toStringIdArray(cfgRows[0].hidden_product_ids);
        }
      }
    } catch (e) {
      // 42703 = coluna inexistente — trata como nenhum featured/hidden
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }

    const featuredSet = new Set(featuredIds);
    const hiddenSet   = new Set(hiddenIds);

    const visibility = listVisibilityWhere('$1');
    const { rows: products } = await db.query(
      `SELECT id, name, description, price, image_url, category, stock_qty, created_at
       FROM products
       WHERE ${visibility} AND is_active IS NOT FALSE
       ORDER BY created_at DESC
       LIMIT 1000`,
      [cid]
    );

    const payload = products.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: parseFloat(p.price),
      image_url: p.image_url,
      category: p.category,
      stock_qty: p.stock_qty,
      is_featured: featuredSet.has(String(p.id)),
      is_hidden:   hiddenSet.has(String(p.id)),
      featured_order: featuredSet.has(String(p.id))
        ? featuredIds.indexOf(String(p.id))
        : null,
    }));

    res.json({
      products: payload,
      featured_product_ids: featuredIds,
      hidden_product_ids: hiddenIds,
      total: payload.length,
    });
  } catch (err) {
    console.error('digital channel products error:', err);
    res.status(500).json({ error: 'Erro ao listar produtos do canal digital' });
  }
});

function sanitizeBanners(input) {
  if (!Array.isArray(input)) return null;
  return input.slice(0, 3).map((b) => ({
    kicker:    typeof b?.kicker === 'string'    ? b.kicker.slice(0, 80)    : '',
    headline:  typeof b?.headline === 'string'  ? b.headline.slice(0, 200) : '',
    body:      typeof b?.body === 'string'      ? b.body.slice(0, 500)     : '',
    cta:       typeof b?.cta === 'string'       ? b.cta.slice(0, 60)       : '',
    tone:      ['split','editorial','centered'].includes(b?.tone) ? b.tone : 'split',
    tint:      ['brand','accent'].includes(b?.tint) ? b.tint : 'brand',
    image_url: typeof b?.image_url === 'string' && b.image_url.startsWith('http') ? b.image_url : null,
    enabled:   b?.enabled !== false,
  }));
}

function sanitizeServiceCards(input) {
  if (!Array.isArray(input)) return null;
  return input.slice(0, 4).map((c) => ({
    icon:    ALLOWED_ICONS.includes(c?.icon) ? c.icon : 'sparkle',
    title:   typeof c?.title === 'string' ? c.title.slice(0, 60) : '',
    body:    typeof c?.body  === 'string' ? c.body.slice(0, 120) : '',
    enabled: c?.enabled !== false,
  }));
}

// Sanitiza array de UUIDs/IDs de produto. Retorna [] se input nao for array.
// Mantem strings nao-vazias unicas (preserva ordem do array original).
function sanitizeProductIdArray(input) {
  if (!Array.isArray(input)) return null;
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Fase 5: sanitiza array de tiers de distancia.
// Schema esperado: [{ max_km: number>0, fee: number>=0 }]
// Retorna array ordenado por max_km ASC, max 3 items.
// null indica input invalido (nao-array); [] e valido (significa "sem tiers").
function sanitizeDistanceTiers(input) {
  if (!Array.isArray(input)) return null;
  const cleaned = [];
  for (const raw of input.slice(0, 3)) {
    if (!raw || typeof raw !== 'object') continue;
    const max_km = parseFloat(raw.max_km);
    const fee    = parseFloat(raw.fee);
    if (!Number.isFinite(max_km) || max_km <= 0) continue;
    if (!Number.isFinite(fee) || fee < 0) continue;
    cleaned.push({ max_km, fee });
  }
  cleaned.sort((a, b) => a.max_km - b.max_km);
  return cleaned;
}

router.put('/', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const {
    site_name, tagline, primary_color, secondary_color, accent_color,
    dark_mode, font_family, card_style, announcement_bar,
    logo_url, cover_url, description, address, phone, whatsapp,
    instagram, google_maps_url, business_hours, featured_product_ids,
    show_prices, show_stock, delivery_enabled, delivery_fee,
    delivery_radius_km, pickup_enabled, is_published,
    pix_key, pix_key_type, pix_holder_name, pix_holder_city,
    pay_on_delivery_enabled,
    card_enabled,
    card_max_installments,
    politica_troca,
    // Fase 5
    pickup_address, pickup_eta_text, delivery_eta_text,
    origin_zip, delivery_pricing_mode, delivery_distance_tiers,
    delivery_free_above_amount,
  } = req.body;

  if (pix_key && String(pix_key).trim()) {
    const v = validatePixKey(pix_key, pix_key_type);
    if (!v.valid) return res.status(400).json({ error: 'Chave Pix invalida: ' + v.error });
  }
  if (font_family && !['classic','modern','humanist'].includes(font_family)) {
    return res.status(400).json({ error: 'font_family deve ser classic|modern|humanist' });
  }
  if (card_style && !['editorial','minimal','image-heavy'].includes(card_style)) {
    return res.status(400).json({ error: 'card_style deve ser editorial|minimal|image-heavy' });
  }

  const banners = req.body.banners !== undefined ? sanitizeBanners(req.body.banners) : undefined;
  if (req.body.banners !== undefined && banners === null) {
    return res.status(400).json({ error: 'banners deve ser um array' });
  }
  const serviceCards = req.body.service_cards !== undefined ? sanitizeServiceCards(req.body.service_cards) : undefined;
  if (req.body.service_cards !== undefined && serviceCards === null) {
    return res.status(400).json({ error: 'service_cards deve ser um array' });
  }

  // Fase 4: featured_product_ids e hidden_product_ids — sanitizar para
  // array de strings. featured_product_ids persiste como JSONB (column type
  // legado, nao mudou); hidden_product_ids persiste como text[] (migration 119).
  let featuredProductIdsSan;
  if (featured_product_ids !== undefined) {
    featuredProductIdsSan = sanitizeProductIdArray(featured_product_ids);
    if (featuredProductIdsSan === null) {
      return res.status(400).json({ error: 'featured_product_ids deve ser um array' });
    }
  }
  let hiddenProductIdsSan;
  if (req.body.hidden_product_ids !== undefined) {
    hiddenProductIdsSan = sanitizeProductIdArray(req.body.hidden_product_ids);
    if (hiddenProductIdsSan === null) {
      return res.status(400).json({ error: 'hidden_product_ids deve ser um array' });
    }
  }

  // ============================================================
  // Fase 5 (migration 120): sanitiza campos novos de entrega
  // ============================================================
  let pickupAddressSan;
  if (pickup_address !== undefined) {
    pickupAddressSan = pickup_address === null
      ? null
      : (typeof pickup_address === 'string' ? pickup_address.trim().slice(0, 500) : '');
  }
  let pickupEtaSan;
  if (pickup_eta_text !== undefined) {
    pickupEtaSan = pickup_eta_text === null
      ? null
      : (typeof pickup_eta_text === 'string' ? pickup_eta_text.trim().slice(0, 100) : '');
  }
  let deliveryEtaSan;
  if (delivery_eta_text !== undefined) {
    deliveryEtaSan = delivery_eta_text === null
      ? null
      : (typeof delivery_eta_text === 'string' ? delivery_eta_text.trim().slice(0, 100) : '');
  }

  // origin_zip: 8 digitos (rejeita formato invalido com 400)
  let originZipSan;
  if (origin_zip !== undefined) {
    if (origin_zip === null || origin_zip === '') {
      originZipSan = null;
    } else {
      const norm = normalizeCep(origin_zip);
      if (!norm) {
        return res.status(400).json({ error: 'origin_zip deve ter 8 digitos' });
      }
      originZipSan = norm;
    }
  }

  // delivery_pricing_mode: 'flat' | 'distance'
  let pricingModeSan;
  if (delivery_pricing_mode !== undefined) {
    if (!['flat', 'distance'].includes(delivery_pricing_mode)) {
      return res.status(400).json({ error: 'delivery_pricing_mode deve ser flat ou distance' });
    }
    pricingModeSan = delivery_pricing_mode;
  }

  // delivery_distance_tiers: array de { max_km, fee }, max 3 items
  let tiersSan;
  if (delivery_distance_tiers !== undefined) {
    tiersSan = sanitizeDistanceTiers(delivery_distance_tiers);
    if (tiersSan === null) {
      return res.status(400).json({ error: 'delivery_distance_tiers deve ser um array' });
    }
  }

  // delivery_free_above_amount: number>=0 ou null
  let freeAboveSan;
  if (delivery_free_above_amount !== undefined) {
    if (delivery_free_above_amount === null || delivery_free_above_amount === '') {
      freeAboveSan = null;
    } else {
      const n = parseFloat(delivery_free_above_amount);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: 'delivery_free_above_amount deve ser numero >= 0' });
      }
      freeAboveSan = n;
    }
  }

  let slug = req.body.slug || null;
  if (!slug && site_name) {
    slug = generateSlug(site_name);
    const { rows: existing } = await db.query(
      `SELECT slug FROM digital_channel_config WHERE slug = $1 AND company_id != $2`, [slug, cid]
    );
    if (existing.length > 0) slug = slug + '-' + Date.now().toString(36).slice(-4);
  }

  const v2 = await hasV2Columns();
  const hasHidden = await hasHiddenColumn();
  const hasFase5 = await hasFase5Columns();

  // Parametros:
  //  - featured: JSON.stringify (column jsonb, mantem o formato historico)
  //  - hidden:   array JS direto (column text[] via migration 119);
  //              pg-node serializa JS array como Postgres text[].
  const featuredJsonParam = featuredProductIdsSan !== undefined
    ? JSON.stringify(featuredProductIdsSan)
    : null;
  const hiddenArrParam = hiddenProductIdsSan !== undefined
    ? hiddenProductIdsSan
    : null;

  try {
    let savedConfig;
    if (v2) {
      // Monta INSERT/UPSERT com hidden_product_ids opcional: se a coluna
      // existe, incluimos no SQL ($36); senao, ignoramos (a UI pode estar
      // adiantada e mandar o campo antes da migration 119 rodar em prod).
      const hiddenInsertCol     = hasHidden ? ', hidden_product_ids' : '';
      const hiddenInsertVal     = hasHidden ? ', COALESCE($36::text[], \'{}\')' : '';
      const hiddenUpdateClause  = hasHidden
        ? ', hidden_product_ids = COALESCE($36::text[], digital_channel_config.hidden_product_ids)'
        : '';

      const params = [
        cid, site_name || null, tagline || null, primary_color || null,
        secondary_color || null, accent_color || null,
        dark_mode === undefined ? null : dark_mode,
        font_family || null, card_style || null,
        announcement_bar === undefined ? null : (announcement_bar || ''),
        banners !== undefined ? JSON.stringify(banners) : null,
        serviceCards !== undefined ? JSON.stringify(serviceCards) : null,
        logo_url || null, cover_url || null,
        description || null, address || null, phone || null, whatsapp || null,
        instagram || null, google_maps_url || null,
        business_hours ? JSON.stringify(business_hours) : null,
        featuredJsonParam,
        show_prices ?? null, show_stock ?? null, delivery_enabled ?? null,
        delivery_fee ?? null, delivery_radius_km ?? null,
        pickup_enabled ?? null, is_published ?? null, slug,
        pix_key || null, pix_key_type || null, pix_holder_name || null, pix_holder_city || null,
        pay_on_delivery_enabled ?? null,
      ];
      if (hasHidden) params.push(hiddenArrParam);

      const { rows } = await db.query(`
        INSERT INTO digital_channel_config (
          company_id, site_name, tagline, primary_color, secondary_color,
          accent_color, dark_mode, font_family, card_style, announcement_bar, banners, service_cards,
          logo_url, cover_url, description, address, phone, whatsapp,
          instagram, google_maps_url, business_hours, featured_product_ids,
          show_prices, show_stock, delivery_enabled, delivery_fee,
          delivery_radius_km, pickup_enabled, is_published, slug,
          pix_key, pix_key_type, pix_holder_name, pix_holder_city,
          pay_on_delivery_enabled${hiddenInsertCol}
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, COALESCE($7, false), COALESCE($8, 'classic'), COALESCE($9, 'editorial'), $10,
          COALESCE($11::jsonb, '[]'::jsonb), COALESCE($12::jsonb, '[]'::jsonb),
          $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
          $23, $24, $25, $26, $27, $28, $29, $30,
          $31, $32, $33, $34, COALESCE($35, false)${hiddenInsertVal}
        )
        ON CONFLICT (company_id) DO UPDATE SET
          site_name = COALESCE($2, digital_channel_config.site_name),
          tagline = COALESCE($3, digital_channel_config.tagline),
          primary_color = COALESCE($4, digital_channel_config.primary_color),
          secondary_color = COALESCE($5, digital_channel_config.secondary_color),
          accent_color = COALESCE($6, digital_channel_config.accent_color),
          dark_mode = COALESCE($7, digital_channel_config.dark_mode),
          font_family = COALESCE($8, digital_channel_config.font_family),
          card_style = COALESCE($9, digital_channel_config.card_style),
          announcement_bar = COALESCE($10, digital_channel_config.announcement_bar),
          banners = COALESCE($11::jsonb, digital_channel_config.banners),
          service_cards = COALESCE($12::jsonb, digital_channel_config.service_cards),
          logo_url = COALESCE($13, digital_channel_config.logo_url),
          cover_url = COALESCE($14, digital_channel_config.cover_url),
          description = COALESCE($15, digital_channel_config.description),
          address = COALESCE($16, digital_channel_config.address),
          phone = COALESCE($17, digital_channel_config.phone),
          whatsapp = COALESCE($18, digital_channel_config.whatsapp),
          instagram = COALESCE($19, digital_channel_config.instagram),
          google_maps_url = COALESCE($20, digital_channel_config.google_maps_url),
          business_hours = COALESCE($21, digital_channel_config.business_hours),
          featured_product_ids = COALESCE($22, digital_channel_config.featured_product_ids),
          show_prices = COALESCE($23, digital_channel_config.show_prices),
          show_stock = COALESCE($24, digital_channel_config.show_stock),
          delivery_enabled = COALESCE($25, digital_channel_config.delivery_enabled),
          delivery_fee = COALESCE($26, digital_channel_config.delivery_fee),
          delivery_radius_km = COALESCE($27, digital_channel_config.delivery_radius_km),
          pickup_enabled = COALESCE($28, digital_channel_config.pickup_enabled),
          is_published = COALESCE($29, digital_channel_config.is_published),
          slug = COALESCE($30, digital_channel_config.slug),
          pix_key = COALESCE($31, digital_channel_config.pix_key),
          pix_key_type = COALESCE($32, digital_channel_config.pix_key_type),
          pix_holder_name = COALESCE($33, digital_channel_config.pix_holder_name),
          pix_holder_city = COALESCE($34, digital_channel_config.pix_holder_city),
          pay_on_delivery_enabled = COALESCE($35, digital_channel_config.pay_on_delivery_enabled)${hiddenUpdateClause},
          updated_at = NOW()
        RETURNING *
      `, params);

      savedConfig = rows[0];
    } else {
      // Fallback pré-migration 115/116
      const { rows } = await db.query(`
        INSERT INTO digital_channel_config (
          company_id, site_name, tagline, primary_color, secondary_color,
          logo_url, cover_url, description, address, phone, whatsapp,
          instagram, google_maps_url, business_hours, featured_product_ids,
          show_prices, show_stock, delivery_enabled, delivery_fee,
          delivery_radius_km, pickup_enabled, is_published, slug,
          pix_key, pix_key_type, pix_holder_name, pix_holder_city,
          pay_on_delivery_enabled
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
          $24, $25, $26, $27, COALESCE($28, false)
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
          slug = COALESCE($23, digital_channel_config.slug),
          pix_key = COALESCE($24, digital_channel_config.pix_key),
          pix_key_type = COALESCE($25, digital_channel_config.pix_key_type),
          pix_holder_name = COALESCE($26, digital_channel_config.pix_holder_name),
          pix_holder_city = COALESCE($27, digital_channel_config.pix_holder_city),
          pay_on_delivery_enabled = COALESCE($28, digital_channel_config.pay_on_delivery_enabled),
          updated_at = NOW()
        RETURNING *
      `, [
        cid, site_name || null, tagline || null, primary_color || null,
        secondary_color || null, logo_url || null, cover_url || null,
        description || null, address || null, phone || null, whatsapp || null,
        instagram || null, google_maps_url || null,
        business_hours ? JSON.stringify(business_hours) : null,
        featuredJsonParam,
        show_prices ?? null, show_stock ?? null, delivery_enabled ?? null,
        delivery_fee ?? null, delivery_radius_km ?? null,
        pickup_enabled ?? null, is_published ?? null, slug,
        pix_key || null, pix_key_type || null, pix_holder_name || null, pix_holder_city || null,
        pay_on_delivery_enabled ?? null,
      ]);

      savedConfig = rows[0];
    }

    // ============================================================
    // Fase 5 (migration 120): UPDATE separado pros campos novos.
    // Defensivo — se a migration nao rodou, hasFase5 e false e
    // pulamos o UPDATE silenciosamente.
    //
    // Geocoding: se origin_zip mudou (ou foi setado), chama BrasilAPI v2
    // e atualiza origin_lat/lng. Erro de geocoding NAO bloqueia o save
    // (lat/lng ficam null se a API falhar).
    // ============================================================
    if (hasFase5) {
      const fase5Sets = [];
      const fase5Params = [];
      let pIdx = 1;
      function pushSet(col, val) {
        fase5Params.push(val);
        fase5Sets.push(`${col} = $${pIdx++}`);
      }

      if (pickupAddressSan !== undefined) pushSet('pickup_address', pickupAddressSan);
      if (pickupEtaSan !== undefined) pushSet('pickup_eta_text', pickupEtaSan);
      if (deliveryEtaSan !== undefined) pushSet('delivery_eta_text', deliveryEtaSan);
      if (pricingModeSan !== undefined) pushSet('delivery_pricing_mode', pricingModeSan);
      if (tiersSan !== undefined) {
        fase5Params.push(JSON.stringify(tiersSan));
        fase5Sets.push(`delivery_distance_tiers = $${pIdx++}::jsonb`);
      }
      if (freeAboveSan !== undefined) pushSet('delivery_free_above_amount', freeAboveSan);

      // Geocoding so quando origin_zip foi explicitamente passado E mudou
      if (originZipSan !== undefined) {
        const prevZip = savedConfig.origin_zip || null;
        pushSet('origin_zip', originZipSan);

        const zipChanged = originZipSan !== prevZip;
        if (zipChanged) {
          let lat = null, lng = null;
          if (originZipSan) {
            try {
              const geo = await geocodeCep(originZipSan);
              if (geo) { lat = geo.lat; lng = geo.lng; }
            } catch (geoErr) {
              console.error('[canal-fase5] geocode error:', geoErr.message);
              // Nao bloqueia — lat/lng ficam null
            }
          }
          pushSet('origin_lat', lat);
          pushSet('origin_lng', lng);
        }
      }

      if (fase5Sets.length > 0) {
        fase5Params.push(cid);
        try {
          const { rows: updated } = await db.query(
            `UPDATE digital_channel_config
             SET ${fase5Sets.join(', ')}, updated_at = NOW()
             WHERE company_id = $${pIdx}
             RETURNING *`,
            fase5Params
          );
          if (updated.length) savedConfig = updated[0];
        } catch (e) {
          // 42703 = coluna inexistente, invalida cache pra re-checar
          if (e.code === '42703') {
            _fase5ColumnsCache = null;
            console.error('[canal-fase5] schema mismatch, ignoring fase5 fields:', e.message);
          } else {
            throw e;
          }
        }
      }
    }

    // ============================================================
    // Migration 121 (21/05/2026): card_enabled toggle.
    // Separate UPDATE pra não mexer no UPSERT principal — mesma estratégia
    // da Fase 5. Defensivo: ignora silenciosamente se a migration 121 não
    // rodou (42703).
    // ============================================================
    if (card_enabled !== undefined) {
      try {
        const cardEnabledBool = !!card_enabled;
        const { rows: updated } = await db.query(
          `UPDATE digital_channel_config
             SET card_enabled = $1, updated_at = NOW()
           WHERE company_id = $2
           RETURNING *`,
          [cardEnabledBool, cid]
        );
        if (updated.length) savedConfig = updated[0];
      } catch (e) {
        if (e.code === '42703') {
          console.error('[canal-card-enabled] coluna card_enabled inexistente — skip:', e.message);
        } else {
          throw e;
        }
      }
    }

    // ============================================================
    // Migration 301: teto de parcelas no cartao, declarado pela lojista.
    // UPDATE separado pelo mesmo motivo do card_enabled — nao mexer no
    // UPSERT principal e sobreviver a base sem a migration (42703).
    // ============================================================
    // Migration 306 — politica de troca do rodape. UPDATE separado pelo
    // mesmo motivo dos outros: nao mexer no UPSERT principal e sobreviver
    // a base sem a migration (42703).
    if (politica_troca !== undefined) {
      // String vazia LIMPA e faz o template voltar ao texto padrao — e
      // assim que ela desfaz uma edicao sem precisar recopiar o padrao.
      const texto = (politica_troca && String(politica_troca).trim())
        ? String(politica_troca).trim().slice(0, 1200)
        : null;
      try {
        const { rows: updated } = await db.query(
          `UPDATE digital_channel_config
             SET politica_troca = $1, updated_at = NOW()
           WHERE company_id = $2
           RETURNING *`,
          [texto, cid]
        );
        if (updated.length) savedConfig = updated[0];
      } catch (e) {
        if (e.code === '42703') {
          console.error('[canal-politica] coluna politica_troca inexistente — skip:', e.message);
        } else {
          throw e;
        }
      }
    }

    if (card_max_installments !== undefined) {
      // null/0/"" limpam o campo: e assim que a lojista desliga o
      // parcelamento sem precisar de um toggle separado.
      const bruto = parseInt(card_max_installments, 10);
      const teto = Number.isFinite(bruto) && bruto >= 2 ? Math.min(bruto, 12) : null;
      try {
        const { rows: updated } = await db.query(
          `UPDATE digital_channel_config
             SET card_max_installments = $1, updated_at = NOW()
           WHERE company_id = $2
           RETURNING *`,
          [teto, cid]
        );
        if (updated.length) savedConfig = updated[0];
      } catch (e) {
        if (e.code === '42703') {
          console.error('[canal-parcelas] coluna card_max_installments inexistente — skip:', e.message);
        } else {
          throw e;
        }
      }
    }

    return res.json({
      config: savedConfig,
      saved: true,
      storefront_url: savedConfig.slug ? `${STOREFRONT_BASE}/${savedConfig.slug}` : null,
    });
  } catch (err) {
    if (err.code === '23505' && err.constraint?.includes('slug')) {
      return res.status(409).json({ error: 'Esse slug ja esta em uso. Escolha outro nome.' });
    }
    // 42703 = coluna inexistente. Pode acontecer se hidden_product_ids
    // foi setado mas migration 119 ainda nao rodou. Invalida cache pra
    // re-checar no proximo request e responde 503 sugerindo retry.
    if (err.code === '42703' && err.message?.includes('hidden_product_ids')) {
      _hiddenColumnCache = false;
      return res.status(503).json({
        error: 'Schema da Fase 4 ainda nao aplicado. Aguarde alguns minutos e tente novamente.'
      });
    }
    console.error('digital channel save error:', err);
    res.status(500).json({ error: 'Erro ao salvar configuracao do canal digital' });
  }
});

router.post('/request-domain', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { domain, plan } = req.body;
  if (!domain || !domain.includes('.')) {
    return res.status(400).json({ error: 'Informe um dominio valido (ex: meunegocio.com.br)' });
  }
  if (!['1year', '2years'].includes(plan)) {
    return res.status(400).json({ error: 'Plano deve ser 1year ou 2years' });
  }
  const pricing = { '1year': 80, '2years': 152 };
  const cleanDomain = domain.toLowerCase().trim();
  try {
    const { rows: existing } = await db.query(
      `SELECT company_id FROM digital_channel_config WHERE custom_domain = $1`, [cleanDomain]
    );
    if (existing.length > 0 && existing[0].company_id !== cid) {
      return res.status(409).json({ error: 'Este dominio ja esta em uso por outra empresa.' });
    }
    await db.query(`
      UPDATE digital_channel_config SET
        custom_domain = $1, custom_domain_status = 'pending_dns',
        custom_domain_plan = $2, custom_domain_price = $3,
        custom_domain_expires_at = NOW() + INTERVAL '${plan === '2years' ? '2 years' : '1 year'}',
        updated_at = NOW()
      WHERE company_id = $4
    `, [cleanDomain, plan, pricing[plan], cid]);
    res.json({
      domain: cleanDomain, plan, price: pricing[plan], status: 'pending_dns',
      message: 'Solicitacao de dominio registrada. A equipe Aura vai configurar o DNS em ate 48h uteis.',
    });
  } catch (err) {
    console.error('request-domain error:', err);
    res.status(500).json({ error: 'Erro ao solicitar dominio' });
  }
});

router.post('/upload-image', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { type } = req.query;
  const { content, content_type } = req.body;
  const bannerMatch = /^banner_([0-2])$/.exec(type || '');
  const isBannerN = !!bannerMatch;
  const bannerIdx = isBannerN ? parseInt(bannerMatch[1], 10) : -1;
  const isLogo = type === 'logo';
  const isCover = type === 'banner';
  if (!isLogo && !isCover && !isBannerN) {
    return res.status(400).json({ error: 'type deve ser logo|banner|banner_0|banner_1|banner_2' });
  }
  if (!content) return res.status(400).json({ error: 'content (base64) obrigatorio' });
  try {
    const mime = content_type || 'image/jpeg';
    const ext  = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const keyName = isLogo ? 'logo' : isCover ? 'banner' : `banner_${bannerIdx}`;
    const key = `${cid}/canal/${keyName}.${ext}`;
    const result = await uploadToR2(key, content, mime);
    if (!result.success) {
      console.error('[canal-upload] R2 error:', result.error);
      return res.status(500).json({ error: 'Erro no upload da imagem' });
    }
    const url = result.mock ? result.url : `${result.url}?v=${Date.now()}`;
    if (isLogo) {
      await db.query(`
        INSERT INTO digital_channel_config (company_id, logo_url) VALUES ($1, $2)
        ON CONFLICT (company_id) DO UPDATE SET logo_url = $2, updated_at = NOW()
      `, [cid, url]);
      return res.json({ logo_url: url, key: result.key });
    }
    if (isCover) {
      await db.query(`
        INSERT INTO digital_channel_config (company_id, cover_url) VALUES ($1, $2)
        ON CONFLICT (company_id) DO UPDATE SET cover_url = $2, updated_at = NOW()
      `, [cid, url]);
      return res.json({ cover_url: url, key: result.key });
    }
    const v2 = await hasV2Columns();
    if (!v2) return res.status(409).json({ error: 'Schema v2 ainda não aplicado. Aguarde a migração.' });
    await db.query(`
      INSERT INTO digital_channel_config (company_id) VALUES ($1)
      ON CONFLICT (company_id) DO NOTHING
    `, [cid]);
    await db.query(`
      UPDATE digital_channel_config SET banners = (
        CASE WHEN jsonb_array_length(banners) > $2 THEN banners
        ELSE banners || jsonb_build_array(jsonb_build_object('kicker','','headline','','body','','cta','','tone','split','tint','brand','image_url',null,'enabled',true))
        END
      ) WHERE company_id = $1
    `, [cid, bannerIdx]);
    for (let i = 0; i < 3; i++) {
      const { rows } = await db.query(`SELECT jsonb_array_length(banners) AS n FROM digital_channel_config WHERE company_id = $1`, [cid]);
      if (rows[0]?.n > bannerIdx) break;
      await db.query(`
        UPDATE digital_channel_config SET banners = banners ||
          jsonb_build_array(jsonb_build_object('kicker','','headline','','body','','cta','','tone','split','tint','brand','image_url',null,'enabled',true))
        WHERE company_id = $1
      `, [cid]);
    }
    await db.query(`
      UPDATE digital_channel_config
         SET banners = jsonb_set(banners, ARRAY[$2::text, 'image_url'], to_jsonb($3::text), true),
             updated_at = NOW()
       WHERE company_id = $1
    `, [cid, String(bannerIdx), url]);
    return res.json({ banner_index: bannerIdx, image_url: url, key: result.key });
  } catch (err) {
    console.error('[canal-upload] error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar imagem' });
  }
});

router.delete('/upload-image', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { type } = req.query;
  const bannerMatch = /^banner_([0-2])$/.exec(type || '');
  const isBannerN = !!bannerMatch;
  const bannerIdx = isBannerN ? parseInt(bannerMatch[1], 10) : -1;
  const isLogo = type === 'logo';
  const isCover = type === 'banner';
  if (!isLogo && !isCover && !isBannerN) {
    return res.status(400).json({ error: 'type deve ser logo|banner|banner_0|banner_1|banner_2' });
  }
  try {
    const keyName = isLogo ? 'logo' : isCover ? 'banner' : `banner_${bannerIdx}`;
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      try { await deleteFromR2(`${cid}/canal/${keyName}.${ext}`); } catch (_) {}
    }
    if (isLogo) {
      await db.query(`UPDATE digital_channel_config SET logo_url = NULL, updated_at = NOW() WHERE company_id = $1`, [cid]);
      return res.json({ deleted: true, field: 'logo_url' });
    }
    if (isCover) {
      await db.query(`UPDATE digital_channel_config SET cover_url = NULL, updated_at = NOW() WHERE company_id = $1`, [cid]);
      return res.json({ deleted: true, field: 'cover_url' });
    }
    const v2 = await hasV2Columns();
    if (v2) {
      await db.query(`
        UPDATE digital_channel_config
           SET banners = CASE
             WHEN jsonb_array_length(banners) > $2
               THEN jsonb_set(banners, ARRAY[$2::text, 'image_url'], 'null'::jsonb, false)
             ELSE banners
           END,
             updated_at = NOW()
         WHERE company_id = $1
      `, [cid, String(bannerIdx)]);
    }
    res.json({ deleted: true, banner_index: bannerIdx });
  } catch (err) {
    console.error('[canal-upload] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover imagem' });
  }
});

router.post('/setup-pix', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { name, email, cpf_cnpj, mobile_phone, company_type = 'MEI', birth_date } = req.body;
  if (!name || !email || !cpf_cnpj || !mobile_phone) {
    return res.status(400).json({ error: 'Nome, e-mail, CPF/CNPJ e celular sao obrigatorios' });
  }
  if ((company_type === 'INDIVIDUAL' || company_type === 'MEI') && !birth_date) {
    return res.status(400).json({ error: 'Data de nascimento e obrigatoria para CPF/MEI' });
  }
  if (birth_date && !/^\d{4}-\d{2}-\d{2}$/.test(birth_date)) {
    return res.status(400).json({ error: 'Data de nascimento deve estar no formato AAAA-MM-DD' });
  }
  const ASAAS_BASE = (process.env.ASAAS_API_URL || 'https://api.asaas.com/api/v3').replace(/\/api\/v3\/?$/, '');
  const ASAAS_MASTER_KEY = process.env.ASAAS_API_KEY;
  if (!ASAAS_MASTER_KEY) {
    return res.status(503).json({ error: 'Integracao Pix nao configurada no servidor. Contate o suporte.' });
  }
  try {
    const cleanCpfCnpj = cpf_cnpj.replace(/\D/g, '');
    const cleanPhone   = mobile_phone.replace(/\D/g, '');
    const resp = await fetch(`${ASAAS_BASE}/v3/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_MASTER_KEY, 'User-Agent': 'Aura-Backend/1.0' },
      body: JSON.stringify({
        name, email, loginEmail: email, cpfCnpj: cleanCpfCnpj, mobilePhone: cleanPhone,
        companyType: company_type, birthDate: birth_date || undefined,
        incomeValue: 1000, address: 'Rua Principal', addressNumber: '1', province: 'Centro', postalCode: '01310100',
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const errMsg = (data.errors && data.errors[0] && data.errors[0].description) || data.message || 'Erro ao criar conta de pagamentos';
      return res.status(400).json({ error: errMsg });
    }
    const subcontaId = data.walletId || data.id;
    const subcontaToken = data.apiKey;
    await db.query(
      `UPDATE companies SET asaas_subconta_id = $1, asaas_subconta_token = $2, updated_at = NOW() WHERE id = $3`,
      [subcontaId, subcontaToken, cid]
    );
    res.json({ success: true, message: 'Pix ativado com sucesso! Ja pode receber pagamentos.' });
  } catch (err) {
    console.error('[setup-pix] error:', err.message);
    res.status(500).json({ error: 'Erro ao ativar Pix. Tente novamente.' });
  }
});

module.exports = router;
