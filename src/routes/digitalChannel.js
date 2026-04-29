// ============================================================
// AURA. — Canal Digital CRUD + Storefront + Dominio + Imagens + Pix
// GET  /companies/:id/digital-channel
// PUT  /companies/:id/digital-channel
// POST /companies/:id/digital-channel/request-domain
// POST /companies/:id/digital-channel/upload-image?type=logo|banner
// POST /companies/:id/digital-channel/setup-pix
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');
const { uploadToR2, deleteFromR2 } = require('../utils/r2Storage');

const DEFAULT_CONFIG = {
  site_name: null, tagline: '', primary_color: '#7c3aed', secondary_color: '#a78bfa',
  logo_url: null, cover_url: null, description: '', address: '', phone: '', whatsapp: '',
  instagram: '', google_maps_url: '',
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

function generateSlug(name) {
  return (name || 'loja')
    .toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
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
    const baseUrl = process.env.APP_URL || 'https://getaura.com.br';
    res.json({
      ...config,
      business_hours: config.business_hours || DEFAULT_CONFIG.business_hours,
      featured_product_ids: config.featured_product_ids || [],
      exists: true,
      storefront_url: config.slug ? `${baseUrl}/loja/${config.slug}` : null,
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

// PUT /companies/:id/digital-channel
router.put('/', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const {
    site_name, tagline, primary_color, secondary_color,
    logo_url, cover_url, description, address, phone, whatsapp,
    instagram, google_maps_url, business_hours, featured_product_ids,
    show_prices, show_stock, delivery_enabled, delivery_fee,
    delivery_radius_km, pickup_enabled, is_published,
  } = req.body;

  let slug = req.body.slug || null;
  if (!slug && site_name) {
    slug = generateSlug(site_name);
    const { rows: existing } = await db.query(
      `SELECT slug FROM digital_channel_config WHERE slug = $1 AND company_id != $2`, [slug, cid]
    );
    if (existing.length > 0) slug = slug + '-' + Date.now().toString(36).slice(-4);
  }

  try {
    const { rows } = await db.query(`
      INSERT INTO digital_channel_config (
        company_id, site_name, tagline, primary_color, secondary_color,
        logo_url, cover_url, description, address, phone, whatsapp,
        instagram, google_maps_url, business_hours, featured_product_ids,
        show_prices, show_stock, delivery_enabled, delivery_fee,
        delivery_radius_km, pickup_enabled, is_published, slug
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
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
    ]);

    const baseUrl = process.env.APP_URL || 'https://getaura.com.br';
    res.json({
      config: rows[0],
      saved: true,
      storefront_url: rows[0].slug ? `${baseUrl}/loja/${rows[0].slug}` : null,
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

// POST /companies/:id/digital-channel/upload-image?type=logo|banner
router.post('/upload-image', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { type } = req.query;
  const { content, content_type } = req.body;

  if (!['logo', 'banner'].includes(type)) {
    return res.status(400).json({ error: 'type deve ser "logo" ou "banner"' });
  }
  if (!content) {
    return res.status(400).json({ error: 'content (base64) obrigatorio' });
  }

  try {
    const mime = content_type || 'image/jpeg';
    const ext  = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const field = type === 'logo' ? 'logo_url' : 'cover_url';
    const key = `${cid}/canal/${type}.${ext}`;

    const result = await uploadToR2(key, content, mime);
    if (!result.success) {
      console.error('[canal-upload] R2 error:', result.error);
      return res.status(500).json({ error: 'Erro no upload da imagem' });
    }

    const url = result.mock ? result.url : `${result.url}?v=${Date.now()}`;

    await db.query(`
      INSERT INTO digital_channel_config (company_id, ${field})
      VALUES ($1, $2)
      ON CONFLICT (company_id) DO UPDATE SET ${field} = $2, updated_at = NOW()
    `, [cid, url]);

    res.json({ [field]: url, key: result.key });
  } catch (err) {
    console.error('[canal-upload] error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar imagem' });
  }
});

// DELETE /companies/:id/digital-channel/upload-image?type=logo|banner
router.delete('/upload-image', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { type } = req.query;

  if (!['logo', 'banner'].includes(type)) {
    return res.status(400).json({ error: 'type deve ser "logo" ou "banner"' });
  }

  const field = type === 'logo' ? 'logo_url' : 'cover_url';

  try {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      try { await deleteFromR2(`${cid}/canal/${type}.${ext}`); } catch (_) {}
    }
    await db.query(
      `UPDATE digital_channel_config SET ${field} = NULL, updated_at = NOW() WHERE company_id = $1`,
      [cid]
    );
    res.json({ deleted: true, field });
  } catch (err) {
    console.error('[canal-upload] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover imagem' });
  }
});

// ============================================================
// POST /companies/:id/digital-channel/setup-pix
// Cria subconta Asaas automaticamente — cliente so preenche dados basicos
// ============================================================
router.post('/setup-pix', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { name, email, cpf_cnpj, mobile_phone, company_type = 'MEI' } = req.body;

  if (!name || !email || !cpf_cnpj || !mobile_phone) {
    return res.status(400).json({ error: 'Nome, e-mail, CPF/CNPJ e celular sao obrigatorios' });
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
        name,
        email,
        loginEmail: email,
        cpfCnpj:    cleanCpfCnpj,
        mobilePhone: cleanPhone,
        companyType: company_type,
        incomeValue: 1000,
        address:     'Rua Principal',
        addressNumber: '1',
        province:    'Centro',
        postalCode:  '01310100',
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

    console.log('[setup-pix] Subconta Asaas criada para empresa', cid);
    res.json({ success: true, message: 'Pix ativado com sucesso! Ja pode receber pagamentos.' });

  } catch (err) {
    console.error('[setup-pix] error:', err.message);
    res.status(500).json({ error: 'Erro ao ativar Pix. Tente novamente.' });
  }
});

module.exports = router;
