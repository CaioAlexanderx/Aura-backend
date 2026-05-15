// ============================================================
// AURA. — Canal Digital CRUD + Storefront + Dominio + Imagens + Pix
// GET  /companies/:id/digital-channel
// PUT  /companies/:id/digital-channel
// POST /companies/:id/digital-channel/request-domain
// POST /companies/:id/digital-channel/upload-image?type=logo|banner|banner_0|banner_1|banner_2
// POST /companies/:id/digital-channel/setup-pix       (legado Asaas)
//
// Migration 088: PUT agora aceita pix_key, pix_key_type, pix_holder_name,
// pix_holder_city — chave Pix manual do lojista, sem subconta Asaas.
// Migration 089: PUT tambem aceita pay_on_delivery_enabled.
// Migration 115: v2 redesign — accent_color, dark_mode, font_family,
// card_style, banners[] JSONB, announcement_bar. Upload aceita banner_N
// (0..2) salvando em ${cid}/canal/banner_N.${ext} e populando banners[N].image_url.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');
const { uploadToR2, deleteFromR2 } = require('../utils/r2Storage');
const { validatePixKey } = require('../services/staticPixService');

const DEFAULT_BANNERS = [
  { kicker: '', headline: 'Bem-vindo à nossa loja', body: 'Curadoria editada, pensada pra durar.', cta: 'Ver produtos', tone: 'split', tint: 'brand', image_url: null, enabled: true },
];

const DEFAULT_CONFIG = {
  site_name: null, tagline: '', primary_color: '#7c3aed', secondary_color: '#a78bfa',
  accent_color: '#a78bfa', dark_mode: false, font_family: 'classic', card_style: 'editorial',
  banners: DEFAULT_BANNERS, announcement_bar: '',
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
  featured_product_ids: [], show_prices: true, show_stock: false,
  delivery_enabled: false, delivery_fee: 0, delivery_radius_km: 5,
  pickup_enabled: true, is_published: false, slug: null,
  custom_domain: null, custom_domain_status: 'none',
  custom_domain_plan: null, custom_domain_expires_at: null, custom_domain_price: null,
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

// Schema-pre-migration safety (armadilha_schema_pre_migration):
// boot do Railway pode pegar deploy parcial — fingers/cache pra colunas v2.
let _v2ColumnsCache = null;
async function hasV2Columns() {
  if (_v2ColumnsCache !== null) return _v2ColumnsCache;
  try {
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'digital_channel_config'
         AND column_name IN ('accent_color','dark_mode','font_family','card_style','banners','announcement_bar')
    `);
    _v2ColumnsCache = rows.length === 6;
  } catch { _v2ColumnsCache = false; }
  return _v2ColumnsCache;
}

// GET /companies/:id/digital-channel
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
      });
    }
    const config = rows[0];
    res.json({
      ...config,
      // v2 defaults aplicados em runtime (não quebram leituras pré-migration)
      accent_color: config.accent_color || config.secondary_color || DEFAULT_CONFIG.accent_color,
      dark_mode: config.dark_mode ?? false,
      font_family: config.font_family || 'classic',
      card_style: config.card_style || 'editorial',
      banners: Array.isArray(config.banners) && config.banners.length ? config.banners : DEFAULT_BANNERS,
      announcement_bar: config.announcement_bar || '',
      business_hours: config.business_hours || DEFAULT_CONFIG.business_hours,
      featured_product_ids: config.featured_product_ids || [],
      exists: true,
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

// Validador defensivo de banners (rejeita payloads malformados sem 500)
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

// PUT /companies/:id/digital-channel
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
  } = req.body;

  // Validações leves
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

  let slug = req.body.slug || null;
  if (!slug && site_name) {
    slug = generateSlug(site_name);
    const { rows: existing } = await db.query(
      `SELECT slug FROM digital_channel_config WHERE slug = $1 AND company_id != $2`, [slug, cid]
    );
    if (existing.length > 0) slug = slug + '-' + Date.now().toString(36).slice(-4);
  }

  const v2 = await hasV2Columns();

  try {
    if (v2) {
      const { rows } = await db.query(`
        INSERT INTO digital_channel_config (
          company_id, site_name, tagline, primary_color, secondary_color,
          accent_color, dark_mode, font_family, card_style, announcement_bar, banners,
          logo_url, cover_url, description, address, phone, whatsapp,
          instagram, google_maps_url, business_hours, featured_product_ids,
          show_prices, show_stock, delivery_enabled, delivery_fee,
          delivery_radius_km, pickup_enabled, is_published, slug,
          pix_key, pix_key_type, pix_holder_name, pix_holder_city,
          pay_on_delivery_enabled
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, COALESCE($7, false), COALESCE($8, 'classic'), COALESCE($9, 'editorial'), $10, COALESCE($11::jsonb, '[]'::jsonb),
          $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
          $22, $23, $24, $25, $26, $27, $28, $29,
          $30, $31, $32, $33, COALESCE($34, false)
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
          logo_url = COALESCE($12, digital_channel_config.logo_url),
          cover_url = COALESCE($13, digital_channel_config.cover_url),
          description = COALESCE($14, digital_channel_config.description),
          address = COALESCE($15, digital_channel_config.address),
          phone = COALESCE($16, digital_channel_config.phone),
          whatsapp = COALESCE($17, digital_channel_config.whatsapp),
          instagram = COALESCE($18, digital_channel_config.instagram),
          google_maps_url = COALESCE($19, digital_channel_config.google_maps_url),
          business_hours = COALESCE($20, digital_channel_config.business_hours),
          featured_product_ids = COALESCE($21, digital_channel_config.featured_product_ids),
          show_prices = COALESCE($22, digital_channel_config.show_prices),
          show_stock = COALESCE($23, digital_channel_config.show_stock),
          delivery_enabled = COALESCE($24, digital_channel_config.delivery_enabled),
          delivery_fee = COALESCE($25, digital_channel_config.delivery_fee),
          delivery_radius_km = COALESCE($26, digital_channel_config.delivery_radius_km),
          pickup_enabled = COALESCE($27, digital_channel_config.pickup_enabled),
          is_published = COALESCE($28, digital_channel_config.is_published),
          slug = COALESCE($29, digital_channel_config.slug),
          pix_key = COALESCE($30, digital_channel_config.pix_key),
          pix_key_type = COALESCE($31, digital_channel_config.pix_key_type),
          pix_holder_name = COALESCE($32, digital_channel_config.pix_holder_name),
          pix_holder_city = COALESCE($33, digital_channel_config.pix_holder_city),
          pay_on_delivery_enabled = COALESCE($34, digital_channel_config.pay_on_delivery_enabled),
          updated_at = NOW()
        RETURNING *
      `, [
        cid, site_name || null, tagline || null, primary_color || null,
        secondary_color || null, accent_color || null,
        dark_mode === undefined ? null : dark_mode,
        font_family || null, card_style || null,
        announcement_bar === undefined ? null : (announcement_bar || ''),
        banners !== undefined ? JSON.stringify(banners) : null,
        logo_url || null, cover_url || null,
        description || null, address || null, phone || null, whatsapp || null,
        instagram || null, google_maps_url || null,
        business_hours ? JSON.stringify(business_hours) : null,
        featured_product_ids ? JSON.stringify(featured_product_ids) : null,
        show_prices ?? null, show_stock ?? null, delivery_enabled ?? null,
        delivery_fee ?? null, delivery_radius_km ?? null,
        pickup_enabled ?? null, is_published ?? null, slug,
        pix_key || null, pix_key_type || null, pix_holder_name || null, pix_holder_city || null,
        pay_on_delivery_enabled ?? null,
      ]);

      return res.json({
        config: rows[0],
        saved: true,
        storefront_url: rows[0].slug ? `${STOREFRONT_BASE}/${rows[0].slug}` : null,
      });
    }

    // Fallback pré-migration 115: salva sem campos v2 (loja antiga)
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
      featured_product_ids ? JSON.stringify(featured_product_ids) : null,
      show_prices ?? null, show_stock ?? null, delivery_enabled ?? null,
      delivery_fee ?? null, delivery_radius_km ?? null,
      pickup_enabled ?? null, is_published ?? null, slug,
      pix_key || null, pix_key_type || null, pix_holder_name || null, pix_holder_city || null,
      pay_on_delivery_enabled ?? null,
    ]);

    res.json({
      config: rows[0],
      saved: true,
      storefront_url: rows[0].slug ? `${STOREFRONT_BASE}/${rows[0].slug}` : null,
    });
  } catch (err) {
    if (err.code === '23505' && err.constraint?.includes('slug')) {
      return res.status(409).json({ error: 'Esse slug ja esta em uso. Escolha outro nome.' });
    }
    console.error('digital channel save error:', err);
    res.status(500).json({ error: 'Erro ao salvar configuracao do canal digital' });
  }
});

// POST /companies/:id/digital-channel/request-domain
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
        custom_domain = $1,
        custom_domain_status = 'pending_dns',
        custom_domain_plan = $2,
        custom_domain_price = $3,
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

// POST /companies/:id/digital-channel/upload-image?type=logo|banner|banner_0|banner_1|banner_2
// banner_N (N=0..2) salva em ${cid}/canal/banner_N.${ext} e popula banners[N].image_url
// banner (legado/cover) continua salvando em cover_url.
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
  if (!content) {
    return res.status(400).json({ error: 'content (base64) obrigatorio' });
  }

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
    // banner_N: atualizar banners[N].image_url. JSONB jsonb_set é seguro.
    const v2 = await hasV2Columns();
    if (!v2) {
      return res.status(409).json({ error: 'Schema v2 ainda não aplicado. Aguarde a migração.' });
    }
    // Garante row existente
    await db.query(`
      INSERT INTO digital_channel_config (company_id) VALUES ($1)
      ON CONFLICT (company_id) DO NOTHING
    `, [cid]);
    // Garante array com pelo menos N+1 entradas
    await db.query(`
      UPDATE digital_channel_config SET banners = (
        CASE
          WHEN jsonb_array_length(banners) > $2 THEN banners
          ELSE banners || jsonb_build_array(jsonb_build_object('kicker','','headline','','body','','cta','','tone','split','tint','brand','image_url',null,'enabled',true))
        END
      ) WHERE company_id = $1
    `, [cid, bannerIdx]);
    // Loop defensivo (pode precisar de várias iterações até cobrir N)
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

// DELETE /companies/:id/digital-channel/upload-image?type=logo|banner|banner_N
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

// ============================================================
// POST /companies/:id/digital-channel/setup-pix  (LEGADO via Asaas)
// Mantido pra retrocompat com lojistas que ja tem subconta. Novos
// fluxos usam pix_key direto via PUT /digital-channel.
// ============================================================
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

  const ASAAS_BASE = (process.env.ASAAS_API_URL || 'https://api.asaas.com/api/v3')
    .replace(/\/api\/v3\/?$/, '');
  const ASAAS_MASTER_KEY = process.env.ASAAS_API_KEY;

  if (!ASAAS_MASTER_KEY) {
    console.error('[setup-pix] ASAAS_API_KEY nao configurada no servidor');
    return res.status(503).json({ error: 'Integracao Pix nao configurada no servidor. Contate o suporte.' });
  }

  try {
    const cleanCpfCnpj = cpf_cnpj.replace(/\D/g, '');
    const cleanPhone   = mobile_phone.replace(/\D/g, '');

    const resp = await fetch(`${ASAAS_BASE}/v3/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': ASAAS_MASTER_KEY,
        'User-Agent': 'Aura-Backend/1.0',
      },
      body: JSON.stringify({
        name, email, loginEmail: email,
        cpfCnpj: cleanCpfCnpj, mobilePhone: cleanPhone,
        companyType: company_type, birthDate: birth_date || undefined,
        incomeValue: 1000, address: 'Rua Principal', addressNumber: '1',
        province: 'Centro', postalCode: '01310100',
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[setup-pix] Asaas error:', JSON.stringify(data));
      const errMsg = (data.errors && data.errors[0] && data.errors[0].description)
        || data.message || 'Erro ao criar conta de pagamentos';
      return res.status(400).json({ error: errMsg });
    }

    const subcontaId    = data.walletId || data.id;
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
