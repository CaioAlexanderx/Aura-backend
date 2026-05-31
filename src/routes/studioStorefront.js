// ============================================================
// AURA Studio — Storefront Publico (sem auth)
// GET  /storefront/:slug/studio/products  — lista produtos personalizaveis
// POST /storefront/:slug/studio/order     — cria pedido Studio
// GET  /storefront/:slug/studio/order/:oid — poll status do pedido
// POST /storefront/:slug/studio/upload    — upload de imagem (cliente envia foto)
//
// Nivel 1 Sub-onda D (25/05/2026)
// 25/05/2026 (Loja Digital Studio fechamento):
//   + price_delta de option/color somado ao effectivePrice
//   + revisions policy exposta em products + poll (max_revisions_included,
//     extra_revision_price, revision_policy_text)
//   + upload R2 publico pro cliente enviar foto direto da pagina
// 26/05/2026 (Verso):
//   + back_price_delta somado ao subtotal quando customization.has_back_selected
//
// Fluxo:
//  1. Cliente entra em loja.getaura.com.br/:slug/studio
//  2. Ve grid de produtos is_personalizable=true com customization_config
//  3. Toca produto -> abre configurador (fields text/image/template/color/option)
//  4. Preview SVG ao vivo via PersonalizationPreview no frontend
//  5. Envia POST com items[].customization JSONB
//  6. Backend cria digital_orders com vertical='studio',
//     studio_production_status='pending_art', e salva personalizacao
//     em digital_order_items.customization
//
// Pagamento: aceita Pix (estatico ou MP), cartao MP CheckoutPro, e
// on_delivery. Mesma logica do storefront.js — copiada aqui pra deixar
// o fluxo Studio independente e rastreavel.
//
// IMPORTANTE:
//  - Trigger fn_studio_consume_inputs_digital decrementa estoque de insumos
//    quando digital_order_items eh inserido com produto is_personalizable
//  - View studio_orders UNE digital_orders Studio + sales personalizaveis;
//    KDS de producao consome essa view
// ============================================================
'use strict';

const router              = require('express').Router();
const db                  = require('../config/database');
const notify              = require('../services/digitalOrderNotifications');
const { generatePix }     = require('../services/pixService');
const { onOrderConfirmed } = require('../services/digitalOrderConfirmation');
const { createMpPixPayment, createMpPreference } = require('../services/mpService');
const { uploadToR2 }      = require('../utils/r2Storage');

function validateCpfCnpj(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 11) return validateCpf(d) ? d : false;
  if (d.length === 14) return validateCnpj(d) ? d : false;
  return false;
}
function validateCpf(d) {
  if (/^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(d[i]) * (10 - i);
  let r = (s * 10) % 11; if (r === 10) r = 0;
  if (r !== parseInt(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(d[i]) * (11 - i);
  r = (s * 10) % 11; if (r === 10) r = 0;
  return r === parseInt(d[10]);
}
function validateCnpj(d) {
  if (/^(\d)\1{13}$/.test(d)) return false;
  const w1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  const w2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
  let s = 0;
  for (let i = 0; i < 12; i++) s += parseInt(d[i]) * w1[i];
  let r = s % 11; r = r < 2 ? 0 : 11 - r;
  if (r !== parseInt(d[12])) return false;
  s = 0;
  for (let i = 0; i < 13; i++) s += parseInt(d[i]) * w2[i];
  r = s % 11; r = r < 2 ? 0 : 11 - r;
  return r === parseInt(d[13]);
}

// Visibility canonica de products (alinhada com storefrontBuilder/storefront.js)
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

// ────────────────────────────────────────────────────────────
// computeChoicesDelta — soma price_delta de campos do tipo
// 'option' / 'color' baseado nos valores selecionados em
// `customization`. Inclusivo: aceita value scalar ou array.
//
// Exemplo cfg.fields[i].config.choices = [
//   { value: 'p', label: 'Pequeno', price_delta: 0 },
//   { value: 'g', label: 'Grande',  price_delta: 5.00 }
// ]
// Se customization[fieldId] === 'g' → soma 5.00
// ────────────────────────────────────────────────────────────
function computeChoicesDelta(cfg, customization) {
  if (!cfg || !Array.isArray(cfg.fields) || !customization) return 0;
  let delta = 0;
  for (const f of cfg.fields) {
    if (f.type !== 'option' && f.type !== 'color') continue;
    const choices = f.config?.choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const selected = customization[f.id];
    if (selected == null) continue;
    // Suporta scalar ou array (multi-select futuro)
    const sels = Array.isArray(selected) ? selected : [selected];
    for (const s of sels) {
      const c = choices.find(ch => ch.value === s || ch.label === s);
      if (c && typeof c.price_delta === 'number' && !isNaN(c.price_delta)) {
        delta += c.price_delta;
      }
    }
  }
  return delta;
}

// ────────────────────────────────────────────────────────────
// computeBackDelta — retorna o valor cobrado pelo verso quando
// o cliente marca `customization.has_back_selected = true` E o
// produto tem cfg.has_back=true E cfg.back_charge_enabled=true.
// Retorna 0 em qualquer outro cenário (backwards-compatible).
// ────────────────────────────────────────────────────────────
function computeBackDelta(cfg, customization) {
  if (!cfg || cfg.has_back !== true) return 0;
  if (cfg.back_charge_enabled !== true) return 0;
  if (!customization || customization.has_back_selected !== true) return 0;
  const v = cfg.back_price_delta;
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return 0;
  return v;
}

// CORS publico — mesma config do storefront.js
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const STOREFRONT_API_BASE = process.env.STOREFRONT_API_BASE_URL
  || 'https://aura-backend-production-f805.up.railway.app';

// Limites de upload (cliente envia foto pra personalizar)
const UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // 15MB
const UPLOAD_ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

// ────────────────────────────────────────────────────────────
// GET /storefront/:slug/studio/products
// Lista produtos da loja onde is_personalizable=true, com
// customization_config + templates vinculados + estimativa SLA.
// + revisions policy (max_revisions_included, extra_revision_price,
//   revision_policy_text) pra cliente ver antes de comprar.
// ────────────────────────────────────────────────────────────
router.get('/:slug/studio/products', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const { rows: configs } = await db.query(
      `SELECT dcc.*, COALESCE(c.trade_name, c.legal_name) AS company_display_name,
              COALESCE(c.studio_settings, '{}'::jsonb) AS studio_settings
         FROM digital_channel_config dcc
         JOIN companies c ON c.id = dcc.company_id
        WHERE dcc.slug = $1 AND dcc.is_published = true`,
      [slug]
    );
    if (!configs.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const config = configs[0];
    const cid = config.company_id;
    const ss = config.studio_settings || {};

    // Lista produtos personalizaveis (respeita visibility canonica)
    const visibility = listVisibilityWhere('$1');
    const { rows: products } = await db.query(
      `SELECT id, name, description, price, image_url, category, stock_qty,
              customization_config
         FROM products
        WHERE ${visibility}
          AND is_active IS NOT FALSE
          AND is_personalizable = true
          AND customization_config IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 200`,
      [cid]
    );

    // Revisions policy — exposta sempre (default null/0 = sem limite/preco)
    const revisions = {
      max_included: ss.max_revisions_included != null
        ? parseInt(ss.max_revisions_included) : 0,
      extra_price: ss.extra_revision_price != null
        ? parseFloat(ss.extra_revision_price) : 0,
      policy_text: ss.revision_policy_text || null,
    };

    if (!products.length) {
      return res.json({
        site: {
          name: config.site_name || configs[0].company_display_name,
          primary_color: config.primary_color || '#1E3A8A',
          accent_color: config.accent_color || '#EC4899',
          logo_url: config.logo_url || null,
        },
        products: [],
        sla: { sla_base_days: 3, queue_qty: 0, total_estimate_days: 3 },
        revisions,
        total_products: 0,
      });
    }

    // Pra cada produto, templates vinculados (specificos + globais)
    const productIds = products.map(p => p.id);
    let templatesByProduct = {};
    try {
      const { rows: tplRows } = await db.query(
        `SELECT pt.product_id, t.id, t.name, t.description,
                t.image_url, t.thumb_url, t.tags,
                tc.name AS category_name
           FROM studio_product_templates pt
           JOIN studio_templates t ON t.id = pt.template_id
           LEFT JOIN studio_template_categories tc ON tc.id = t.category_id
          WHERE pt.company_id = $1
            AND (pt.product_id = ANY($2::uuid[]) OR pt.product_id IS NULL)
            AND t.is_active = true
          ORDER BY pt.sort_order, t.use_count DESC
          LIMIT 500`,
        [cid, productIds]
      );
      for (const r of tplRows) {
        const pid = r.product_id || '__global__';
        if (!templatesByProduct[pid]) templatesByProduct[pid] = [];
        templatesByProduct[pid].push({
          id: r.id, name: r.name, description: r.description,
          image_url: r.image_url, thumb_url: r.thumb_url,
          tags: r.tags || [], category_name: r.category_name || null,
        });
      }
    } catch (_) { /* tabela pode nao existir em deploy antigo */ }

    // SLA estimate dinamico: base + ceil(fila / capacidade)
    const slaBaseDays = ss.default_sla_days != null ? parseInt(ss.default_sla_days) : 3;
    const capacity = Math.max(
      ss.production_capacity_per_day != null ? parseInt(ss.production_capacity_per_day) : 10,
      1
    );

    let queueQty = 0;
    try {
      const qRes = await db.query(
        `SELECT COUNT(*)::int AS qty
           FROM digital_orders
          WHERE company_id = $1 AND vertical = 'studio'
            AND studio_production_status IN ('pending_art', 'approved', 'in_production')`,
        [cid]
      );
      queueQty = parseInt(qRes.rows[0]?.qty || 0);
    } catch (_) {}

    const queueDays = Math.ceil(queueQty / capacity);
    const slaTotal = slaBaseDays + queueDays;

    // Detecta gateway de pagamento (Pix MP, Pix estatico, Cartao)
    let hasMpGateway = false;
    try {
      const { rows: gws } = await db.query(
        `SELECT id FROM companies_payment_gateways WHERE company_id = $1 AND gateway = 'mercadopago' LIMIT 1`,
        [cid]
      );
      hasMpGateway = gws.length > 0;
    } catch (_) {}
    const hasStaticPix = !!(config.pix_key && String(config.pix_key).trim());
    const hasPix = hasStaticPix || hasMpGateway;
    const cardEnabled = config.card_enabled !== false;
    const hasCard = hasMpGateway && cardEnabled;
    const hasOnDelivery = !!config.pay_on_delivery_enabled;

    res.json({
      site: {
        name: config.site_name || configs[0].company_display_name,
        tagline: config.tagline || '',
        primary_color: config.primary_color || '#1E3A8A',
        accent_color: config.accent_color || '#EC4899',
        logo_url: config.logo_url || null,
        cover_url: config.cover_url || null,
      },
      products: products.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description || null,
        price: parseFloat(p.price),
        image_url: p.image_url || null,
        category: p.category || null,
        stock_qty: p.stock_qty,
        customization_config: p.customization_config,
        templates: [
          ...(templatesByProduct[p.id] || []),
          ...(templatesByProduct.__global__ || []),
        ],
      })),
      sla: {
        sla_base_days: slaBaseDays,
        queue_qty: queueQty,
        capacity_per_day: capacity,
        queue_added_days: queueDays,
        total_estimate_days: slaTotal,
      },
      revisions,
      payment: {
        has_pix: hasPix,
        has_card: hasCard,
        pay_on_delivery_enabled: hasOnDelivery,
      },
      total_products: products.length,
    });
  } catch (err) {
    console.error('[studio-storefront] products error:', err);
    res.status(500).json({ error: 'Erro ao listar produtos personalizaveis' });
  }
});

// ────────────────────────────────────────────────────────────
// Validacao de customization vs customization_config do produto
// ────────────────────────────────────────────────────────────
function validateCustomizationValues(config, values) {
  if (!config || typeof config !== 'object') return null; // produto nao personalizavel
  if (!values || typeof values !== 'object') {
    return 'customization obrigatoria';
  }
  if (!Array.isArray(config.fields)) return null;
  for (const f of config.fields) {
    if (f.required) {
      const v = values[f.id];
      if (v == null || (typeof v === 'string' && !v.trim())) {
        return `campo "${f.label || f.id}" obrigatorio`;
      }
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// POST /storefront/:slug/studio/upload
// Upload publico de imagem (cliente envia foto direto da pagina).
// Sem auth — protegido por slug + tamanho/tipo + key isolada por company.
// Body: { content_base64, content_type, filename? }
// ────────────────────────────────────────────────────────────
router.post('/:slug/studio/upload', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const { content_base64, content_type, filename } = req.body || {};

    if (!content_base64 || typeof content_base64 !== 'string') {
      return res.status(400).json({ error: 'content_base64 obrigatorio' });
    }
    if (!content_type || !UPLOAD_ALLOWED_TYPES.has(String(content_type).toLowerCase())) {
      return res.status(400).json({
        error: 'content_type invalido. Aceitos: ' + Array.from(UPLOAD_ALLOWED_TYPES).join(', ')
      });
    }

    // Resolve cid pelo slug
    const { rows: configs } = await db.query(
      `SELECT company_id FROM digital_channel_config
        WHERE slug = $1 AND is_published = true LIMIT 1`,
      [slug]
    );
    if (!configs.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const cid = configs[0].company_id;

    // Decodifica base64 + valida tamanho
    let buf;
    try {
      // Aceita data URL (data:image/png;base64,...) ou base64 puro
      const b64 = content_base64.includes(',')
        ? content_base64.split(',')[1]
        : content_base64;
      buf = Buffer.from(b64, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'content_base64 invalido' });
    }
    if (buf.length === 0) {
      return res.status(400).json({ error: 'arquivo vazio' });
    }
    if (buf.length > UPLOAD_MAX_BYTES) {
      return res.status(413).json({
        error: `arquivo muito grande (max ${UPLOAD_MAX_BYTES / (1024*1024)}MB)`
      });
    }

    // Key isolada por company pra evitar colisao entre lojas
    const ext = String(content_type).split('/').pop().replace('jpeg', 'jpg');
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 10);
    const key = `studio/storefront/${cid}/${ts}-${rand}.${ext}`;

    const r = await uploadToR2(key, buf, content_type);
    if (!r?.success) {
      console.error('[studio-storefront/upload] uploadToR2 falhou', r);
      return res.status(500).json({ error: 'Erro ao salvar arquivo' });
    }

    res.json({
      ok: true,
      url: r.url,
      key: r.key,
      content_type,
      size_bytes: buf.length,
    });
  } catch (err) {
    console.error('[studio-storefront/upload] error:', err);
    res.status(500).json({ error: 'Erro ao processar upload' });
  }
});

// ────────────────────────────────────────────────────────────
// POST /storefront/:slug/studio/order
// Cria pedido Studio (digital_orders + digital_order_items
//  com customization JSONB). Marca vertical='studio' e
//  studio_production_status='pending_art' automaticamente.
//
// effectivePrice = product.price + soma(price_delta das choices
//   selecionadas em customization.option/color) + back_delta
//   (quando customization.has_back_selected e cfg.back_charge_enabled)
// ────────────────────────────────────────────────────────────
router.post('/:slug/studio/order', async (req, res) => {
  const slug = req.params.slug.toLowerCase().trim();
  const {
    customer_name, customer_phone, customer_email,
    delivery_type, delivery_address, notes, items,
    payment_method,
    request_nfce, customer_cpf_cnpj,
    address_zip, address_street, address_number, address_complement,
    address_neighborhood, address_city, address_state,
  } = req.body;

  if (!customer_name || !customer_phone) {
    return res.status(400).json({ error: 'Nome e telefone sao obrigatorios' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos 1 item no pedido' });
  }

  try {
    const { rows: configs } = await db.query(
      `SELECT dcc.*, COALESCE(c.trade_name, c.legal_name) AS company_display_name
         FROM digital_channel_config dcc
         JOIN companies c ON c.id = dcc.company_id
        WHERE dcc.slug = $1 AND dcc.is_published = true`, [slug]);
    if (!configs.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const config = configs[0];
    const cid = config.company_id;

    // MP gateway
    let mpGateway = null;
    try {
      const { rows: gws } = await db.query(
        `SELECT access_token, public_key FROM companies_payment_gateways WHERE company_id = $1 AND gateway = 'mercadopago' LIMIT 1`,
        [cid]
      );
      mpGateway = gws[0] || null;
    } catch (_) {}
    const hasMpGateway = !!mpGateway;
    const cardEnabled = config.card_enabled !== false;
    const hasCard = hasMpGateway && cardEnabled;
    const hasStaticPix = !!(config.pix_key && String(config.pix_key).trim());
    const hasPix = hasStaticPix || hasMpGateway;
    const hasOnDelivery = !!config.pay_on_delivery_enabled;

    const dtype = delivery_type || 'pickup';
    if (dtype === 'delivery' && !config.delivery_enabled) {
      return res.status(400).json({ error: 'Entrega nao disponivel nesta loja' });
    }
    if (dtype === 'pickup' && config.pickup_enabled === false) {
      return res.status(400).json({ error: 'Retirada nao disponivel nesta loja' });
    }

    let cpfNorm = null;
    if (request_nfce || customer_cpf_cnpj) {
      cpfNorm = validateCpfCnpj(customer_cpf_cnpj);
      if (cpfNorm === false) {
        return res.status(400).json({ error: 'CPF/CNPJ invalido' });
      }
      if (request_nfce && !cpfNorm) {
        return res.status(400).json({ error: 'CPF/CNPJ obrigatorio quando solicitar NFCe' });
      }
    }

    let pmethod = (payment_method || '').toLowerCase().trim();
    if (!pmethod) {
      pmethod = hasPix ? 'pix' : (hasCard ? 'card' : (hasOnDelivery ? 'on_delivery' : null));
    }
    if (!pmethod) {
      return res.status(400).json({ error: 'Esta loja nao aceita pagamentos no momento' });
    }
    if (!['pix', 'card', 'on_delivery'].includes(pmethod)) {
      return res.status(400).json({ error: 'payment_method invalido. Use pix, card ou on_delivery' });
    }
    if (pmethod === 'pix' && !hasPix) {
      return res.status(400).json({ error: 'Esta loja nao aceita Pix' });
    }
    if (pmethod === 'card' && !hasCard) {
      return res.status(400).json({ error: 'Esta loja nao aceita cartao' });
    }
    if (pmethod === 'on_delivery' && !hasOnDelivery) {
      return res.status(400).json({ error: 'Esta loja nao aceita pagamento na entrega' });
    }

    // Busca produtos + valida que todos sao personalizaveis
    const productIds = items.map(i => i.product_id);
    const { rows: products } = await db.query(
      `SELECT id, name, price, stock_qty, image_url, is_active,
              is_personalizable, customization_config
         FROM products
        WHERE id::text = ANY($1) AND ${listVisibilityWhere('$2')}`,
      [productIds.map(String), cid]
    );
    const productMap = Object.fromEntries(products.map(p => [p.id, p]));

    const orderItems = [];
    let subtotal = 0;
    let hasStudioItem = false;
    let totalBackDeltaAdded = 0; // rastreabilidade pro log

    for (const item of items) {
      const p = productMap[item.product_id];
      if (!p) return res.status(400).json({ error: `Produto ${item.product_id} nao encontrado` });
      if (p.is_active === false) return res.status(400).json({ error: `Produto "${p.name}" nao esta disponivel` });
      if (!p.is_personalizable) {
        return res.status(400).json({ error: `Produto "${p.name}" nao e personalizavel — use /storefront/:slug/order` });
      }

      const qty = parseInt(item.quantity) || 1;
      if (qty < 1) return res.status(400).json({ error: `Quantidade invalida para "${p.name}"` });

      // Valida customization values vs config (campos required)
      const cfg = p.customization_config;
      const valErr = validateCustomizationValues(cfg, item.customization);
      if (valErr) {
        return res.status(400).json({ error: `Personalizacao de "${p.name}": ${valErr}` });
      }

      // Aplica price_delta das choices selecionadas (option/color)
      const basePrice = parseFloat(p.price);
      const choicesDelta = computeChoicesDelta(cfg, item.customization);

      // Verso (frente/verso) — soma back_price_delta quando cliente marcou
      const backDelta = computeBackDelta(cfg, item.customization);
      if (backDelta > 0) {
        const itemBackTotal = backDelta * qty;
        totalBackDeltaAdded += itemBackTotal;
        console.log(`[studio/storefront/order] back delta aplicado em "${p.name}": R$${backDelta.toFixed(2)} x ${qty} = R$${itemBackTotal.toFixed(2)}`);
      }

      const effectivePrice = basePrice + choicesDelta + backDelta;
      const itemSubtotal = effectivePrice * qty;
      subtotal += itemSubtotal;
      hasStudioItem = true;

      orderItems.push({
        product_id:    p.id,
        product_name:  p.name,
        product_image: p.image_url,
        unit_price:    effectivePrice,
        quantity:      qty,
        subtotal:      itemSubtotal,
        customization: item.customization || null,
        // metadata auxiliar (nao persistida — so resposta)
        _base_price: basePrice,
        _choices_delta: choicesDelta,
        _back_delta: backDelta,
      });
    }

    if (!hasStudioItem) {
      return res.status(400).json({ error: 'Pedido Studio precisa de ao menos 1 produto personalizavel' });
    }

    if (totalBackDeltaAdded > 0) {
      console.log(`[studio/storefront/order] total back_delta somado ao subtotal: R$${totalBackDeltaAdded.toFixed(2)}`);
    }

    // Frete: Studio cobra delivery_fee fixo (sem distancia complexa por enquanto;
    // tier por distancia esta em config mas nao expomos no Studio MVP)
    let delivery_fee = 0;
    if (dtype === 'delivery') {
      delivery_fee = parseFloat(config.delivery_fee) || 0;
    }
    const total = subtotal + delivery_fee;

    // Pedido Studio nasce sempre como pending_payment (Pix/cartao) ou
    // confirmed (on_delivery). studio_production_status='pending_art'.
    const initialStatus = pmethod === 'on_delivery' ? 'confirmed' : 'pending_payment';

    const client = await db.connect();
    let order;
    try {
      await client.query('BEGIN');
      let composedAddress = delivery_address || null;
      if (dtype === 'delivery' && !composedAddress && address_street) {
        composedAddress = `${address_street}, ${address_number}` +
          (address_complement ? ` (${address_complement})` : '') +
          ` - ${address_neighborhood}, ${address_city}/${String(address_state || '').toUpperCase()}` +
          (address_zip ? ` - CEP ${String(address_zip).replace(/\D/g, '')}` : '');
      }

      const { rows: [newOrder] } = await client.query(`
        INSERT INTO digital_orders (
          company_id, order_number, customer_name, customer_phone, customer_email,
          delivery_type, delivery_address, delivery_fee, subtotal, total,
          status, payment_status, payment_method, notes,
          confirmed_at,
          customer_cpf_cnpj, nfce_requested,
          address_zip, address_street, address_number, address_complement,
          address_neighborhood, address_city, address_state,
          vertical, studio_production_status
        ) VALUES (
          $1, next_digital_order_number($1), $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, 'pending', $11, $12,
          CASE WHEN $10 = 'confirmed' THEN NOW() ELSE NULL END,
          $13, $14,
          $15, $16, $17, $18,
          $19, $20, $21,
          'studio', 'pending_art'
        ) RETURNING *
      `, [
        cid, customer_name, customer_phone, customer_email || null,
        dtype, composedAddress, delivery_fee, subtotal, total,
        initialStatus, pmethod, notes || null,
        cpfNorm || null, !!request_nfce,
        address_zip ? String(address_zip).replace(/\D/g, '') : null,
        address_street || null, address_number || null, address_complement || null,
        address_neighborhood || null, address_city || null,
        address_state ? String(address_state).toUpperCase() : null,
      ]);
      order = newOrder;

      for (const item of orderItems) {
        await client.query(`
          INSERT INTO digital_order_items
            (order_id, product_id, product_name, product_image, unit_price, quantity, subtotal, customization)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `, [order.id, item.product_id, item.product_name, item.product_image,
            item.unit_price, item.quantity, item.subtotal,
            item.customization ? JSON.stringify(item.customization) : null]);
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // Pagamento Pix / Cartao (mesma logica do storefront.js principal)
    let pixData = null;
    if (pmethod === 'pix') {
      if (hasMpGateway) {
        try {
          pixData = await createMpPixPayment({
            accessToken:   mpGateway.access_token,
            total,
            orderId:       order.id,
            orderNumber:   order.order_number,
            customerEmail: customer_email || null,
            description:   `Pedido Studio #${order.order_number}`,
          });
          await db.query(
            `UPDATE digital_orders SET mp_payment_id = $1, updated_at = NOW() WHERE id = $2`,
            [pixData.payment_id, order.id]
          );
        } catch (mpErr) {
          console.error('[studio-storefront] MP Pix error, fallback static:', mpErr.message);
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
      } else {
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
    }

    let cardData = null;
    if (pmethod === 'card') {
      try {
        const hasCustomDomain = config.custom_domain && config.custom_domain_status === 'active';
        const backBase = hasCustomDomain
          ? `https://${config.custom_domain}`
          : `${STOREFRONT_API_BASE}/api/v1/storefront/${slug}/page`;
        cardData = await createMpPreference({
          accessToken:     mpGateway.access_token,
          orderId:         order.id,
          orderNumber:     order.order_number,
          orderItems,
          customerEmail:   customer_email || null,
          payerCpf:        cpfNorm || null,
          storeName:       config.company_display_name || null,
          notificationUrl: `${STOREFRONT_API_BASE}/api/v1/webhooks/mp`,
          backUrlSuccess:  `${backBase}?order_id=${order.id}&payment=approved`,
          backUrlFailure:  `${backBase}?order_id=${order.id}&payment=failed`,
          backUrlPending:  `${backBase}?order_id=${order.id}&payment=pending`,
        });
      } catch (mpErr) {
        console.error('[studio-storefront] MP Preference error:', mpErr.message);
        return res.status(500).json({ error: 'Erro ao criar preferencia de pagamento. Tente novamente.' });
      }
    }

    // on_delivery: pedido confirmed -> notifica imediatamente
    if (initialStatus === 'confirmed') {
      onOrderConfirmed(order.id)
        .catch(err => console.error('[studio-storefront] onOrderConfirmed error:', err.message));
      notify.notifyPaymentConfirmed({ order })
        .catch(err => console.error('[studio-storefront] notifyPaymentConfirmed error:', err.message));
    }

    res.status(201).json({
      order_id:       order.id,
      order_number:   order.order_number,
      total,
      delivery_fee,
      subtotal,
      status:         initialStatus,
      payment_method: pmethod,
      studio_production_status: 'pending_art',
      pix: pixData ? {
        qrcode:     pixData.qrcode,
        payload:    pixData.payload,
        expires_at: pixData.expires_at,
        mode:       pixData.mode || null,
      } : null,
      card: cardData ? {
        init_point:    cardData.init_point,
        preference_id: cardData.preference_id,
      } : null,
    });
  } catch (err) {
    console.error('[studio-storefront] create order error:', err);
    res.status(500).json({ error: 'Erro ao criar pedido Studio' });
  }
});

// ────────────────────────────────────────────────────────────
// GET /storefront/:slug/studio/order/:oid
// Poll de status do pedido Studio (cliente acompanha).
// Inclui revisions policy pra cliente ver no estagio "sent".
// ────────────────────────────────────────────────────────────
router.get('/:slug/studio/order/:oid', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method,
             o.total, o.delivery_type, o.studio_production_status,
             o.asaas_pix_expires_at, o.confirmed_at, o.delivered_at, o.cancelled_at,
             COALESCE(c.studio_settings, '{}'::jsonb) AS studio_settings,
             COALESCE(c.trade_name, c.legal_name) AS shop_name
        FROM digital_orders o
        JOIN digital_channel_config dcc ON dcc.company_id = o.company_id
        JOIN companies c ON c.id = o.company_id
       WHERE o.id = $1 AND dcc.slug = $2 AND o.vertical = 'studio'
    `, [req.params.oid, req.params.slug.toLowerCase().trim()]);
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const row = rows[0];
    const ss = row.studio_settings || {};
    const { studio_settings, ...rest } = row;
    res.json({
      ...rest,
      revisions: {
        max_included: ss.max_revisions_included != null
          ? parseInt(ss.max_revisions_included) : 0,
        extra_price: ss.extra_revision_price != null
          ? parseFloat(ss.extra_revision_price) : 0,
        policy_text: ss.revision_policy_text || null,
      },
      sla_days: ss.default_sla_days != null ? parseInt(ss.default_sla_days) : 3,
      shop_wa_phone: ss.approval_wa_phone || null,
    });
  } catch (err) {
    console.error('[studio-storefront] poll error:', err);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

module.exports = router;
