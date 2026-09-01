// ============================================================
// AURA. — Storefront Público (sem auth)
// GET  /storefront/:slug                     — JSON API
// GET  /storefront/:slug/page                — HTML renderizado (vitrine pública)
// GET  /storefront/:slug/shipping-quote      — Calcula frete por CEP (Fase 5b)
// POST /storefront/:slug/order               — Cria pedido (Pix, cartão, ou na entrega)
// POST /storefront/:slug/order/:oid/upload-proof — Cliente envia comprovante de Pix
// POST /storefront/:slug/order/:oid/mark-as-paid — Cliente avisa que pagou
// GET  /storefront/:slug/order/:oid          — Poll status do pedido
//
// MP Fase 2 (21/05/2026): CheckoutPro para pagamento com cartão.
// payment_method=card cria preferência MP e retorna init_point para
// redirect do cliente ao hosted checkout do MP.
//
// Patch (21/05/2026): JOIN companies pra obter trade_name; passa cpfNorm
// + company_display_name à createMpPreference.
//
// Migration 121 (21/05/2026): hasCard respeita config.card_enabled.
// Lojista pode pausar cartão sem deletar credenciais MP.
//
// Custom domain (22/05/2026): back_urls usam custom_domain quando configurado
// e active; corrigido prefixo /api/v1/ que faltava no backBase.
//
// fix (22/05/2026): notifyPaymentConfirmed chamado diretamente para on_delivery
// (pedido já nasce confirmed). notifyNewOrder removido — era no-op.
// Pix/Cartão recebem notificações apenas após confirmação via webhook MP ou approve-payment.
// ============================================================
'use strict';

const router              = require('express').Router();
const db                  = require('../config/database');
const notify              = require('../services/digitalOrderNotifications');
const buildStorefrontPage = require('../templates/storefrontPage');
const {
  buildStorefront, listVisibilityWhere,
  // A pagina 2 monta o produto com o MESMO codigo da pagina 1.
  fetchVariantesPorProduto, montarProdutoPublico,
  fetchStorefrontCategories, fetchPrimaryCategoryLinks, parseFeaturedIds,
} = require('../services/storefrontBuilder');
const { paginaDoCatalogo, facetasDoCatalogo } = require('../services/catalogoPaginado');
const { normalizarTamanho } = require('../services/tamanhosDaLoja');
const { generatePix }     = require('../services/pixService');
const { uploadToR2 }      = require('../utils/r2Storage');
const { onOrderConfirmed } = require('../services/digitalOrderConfirmation');
const { createMpPixPayment, createMpPreference } = require('../services/mpService');
const { calculateShippingQuote } = require('../services/shippingQuote');
const { COURIER, validateCourierPickup } = require('../services/courierPickup');
const lojaEvents          = require('../services/lojaEvents');

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

// listVisibilityWhere vive em services/storefrontBuilder.js e e
// importada acima. A copia local daqui era IDENTICA (conferido por
// diff) — e regra de visibilidade duplicada e como produto de outra
// empresa vaza pra loja errada quando so uma das copias e corrigida.

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

const STOREFRONT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "script-src-attr 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://cloudflareinsights.com https://viacep.com.br https://brasilapi.com.br " + STOREFRONT_API_BASE,
  "font-src 'self' data: https://fonts.gstatic.com",
  "frame-ancestors *",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

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

// ─────────────────────────────────────────────
// Catalogo paginado (23/08/2026)
//
// A loja mandava 500 produtos de uma vez e escrevia no rodape "Mais 802
// no catalogo — use a busca". Pra quem esta comprando, essa frase diz
// "nao vamos te atender". Agora a grade pagina de verdade, e o filtro de
// categoria, a busca e a ordenacao vao ao SERVIDOR — com paginacao real,
// filtrar so o que esta carregado esconderia resultado.
// ─────────────────────────────────────────────

/**
 * O rotulo que o cliente manda vira os valores GRAVADOS no banco.
 *
 * O filtro mostra "M"; o banco tem "m" e "M". Mostra "Preto"; o banco tem
 * os hex daquela familia. Traduzir aqui e o que faz o clique encontrar
 * produto — buscar o rotulo cru nao acharia nada, e o resultado vazio
 * pareceria "acabou o estoque".
 */
function valoresDeTamanho(bruto) {
  const pedidos = String(bruto || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!pedidos.length) return [];
  // Cada rotulo pedido cobre as variacoes de caixa que existem no banco.
  // Gerar as formas em vez de consultar evita uma ida ao banco por
  // request num filtro que muda a cada clique.
  const saida = new Set();
  for (const r of pedidos) {
    saida.add(r);
    saida.add(r.toLowerCase());
    saida.add(r.toUpperCase());
    if (normalizarTamanho(r) === 'Único') {
      for (const u of ['u', 'U', 'un', 'UN', 'uni', 'UNI', 'Único', 'unico', 'UNICO', 'Unico']) saida.add(u);
    }
  }
  return [...saida];
}

/**
 * A familia de cor pedida ("Preto") vira todos os hex daquela familia.
 *
 * Aqui NAO da pra gerar: os hex sao os que a lojista cadastrou, e so o
 * banco sabe quais existem. A consulta e a mesma das facetas, entao o
 * conjunto e coerente com o que o filtro ofereceu.
 */
async function valoresDeCor(cid, bruto, exigeFoto) {
  const pedidas = String(bruto || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!pedidas.length) return [];
  const facetas = await facetasDoCatalogo({
    cid, visibilityWhere: listVisibilityWhere('$1'), exigeFoto,
  });
  const saida = [];
  for (const f of facetas.cor || []) {
    if (pedidas.includes(String(f.familia).toLowerCase())) saida.push(...f.valores);
  }
  return saida;
}

router.get('/:slug/catalogo', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`,
      [slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const cfg = rows[0];

    const pagina = await paginaDoCatalogo({
      cid: cfg.company_id,
      visibilityWhere: listVisibilityWhere('$1'),
      offset: req.query.offset,
      limit: req.query.limit,
      categoria: req.query.cat,
      busca: req.query.q,
      ordem: req.query.ordem,
      featuredIds: parseFeaturedIds(cfg.featured_product_ids),
      // migration 308. A pagina 2 tem que obedecer a MESMA regra da
      // pagina 1, senao a grade cresce ao rolar.
      exigeFoto: cfg.require_product_image === true,
      // Os rotulos chegam normalizados ("M", "Preto") e viram os valores
      // GRAVADOS ("m","M" / os hex daquela familia) — senao o filtro
      // buscaria um texto que nao existe no banco.
      tamanhos: valoresDeTamanho(req.query.tam),
      cores: await valoresDeCor(cfg.company_id, req.query.cor,
                                cfg.require_product_image === true),
    });

    // O produto sai na MESMA forma do payload embutido. Sem isto o cartao
    // da pagina 2 renderizaria diferente do cartao da pagina 1: sem
    // `variants` o botao "+" apareceria onde deveria abrir o detalhe, e
    // sem `in_stock` produto esgotado voltaria pra grade.
    const ids = pagina.produtos.map(p => p.id);
    const [variantsByProduct, primaryLinkByProduct, categorias] = await Promise.all([
      fetchVariantesPorProduto(ids),
      fetchPrimaryCategoryLinks(ids),
      fetchStorefrontCategories(cfg.company_id),
    ]);
    const categoryById = {};
    categorias.forEach(c => { categoryById[c.id] = c; });

    res.json({
      products: pagina.produtos.map(p => montarProdutoPublico(p, {
        variantsByProduct, categoryById, primaryLinkByProduct,
        mostrarPrecos: cfg.show_prices !== false,
      })),
      total: pagina.total,
      offset: pagina.offset,
      limit: pagina.limit,
    });
  } catch (err) {
    console.error('[storefront] catalogo error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar o catalogo' });
  }
});

router.get('/:slug/page', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`, [slug]);
    if (!rows.length) {
      res.setHeader('Content-Security-Policy', STOREFRONT_CSP);
      res.removeHeader('X-Frame-Options');
      return res.status(404).send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h1>Loja não encontrada</h1><p>Verifique o link ou peça ao lojista pra publicar a loja.</p></body></html>');
    }
    const data = await buildStorefront(rows[0]);
    res.setHeader('Content-Security-Policy', STOREFRONT_CSP);
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildStorefrontPage(data, slug));
  } catch (err) {
    console.error('storefront page error:', err);
    res.status(500).send('<html><body><h1>Erro ao carregar loja</h1></body></html>');
  }
});

router.get('/:slug/shipping-quote', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`,
      [slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const config = rows[0];

    if (!config.delivery_enabled) {
      return res.status(400).json({ error: 'Loja nao faz entregas' });
    }

    const cep = String(req.query.cep || '').trim();
    if (!cep) return res.status(400).json({ error: 'cep obrigatorio' });

    const subtotal = parseFloat(req.query.subtotal) || 0;
    if (subtotal < 0) {
      return res.status(400).json({ error: 'subtotal invalido' });
    }

    const quote = await calculateShippingQuote(config, cep, subtotal);
    res.json(quote);
  } catch (err) {
    console.error('shipping-quote error:', err);
    res.status(500).json({ error: 'Erro ao calcular frete' });
  }
});

router.post('/:slug/order', async (req, res) => {
  const slug = req.params.slug.toLowerCase().trim();
  const {
    customer_name, customer_phone, customer_email,
    delivery_type, delivery_address, notes, items,
    payment_method,
    request_nfce, customer_cpf_cnpj,
    address_zip, address_street, address_number, address_complement,
    address_neighborhood, address_city, address_state,
    expected_delivery_fee,
  } = req.body;

  if (!customer_name || !customer_phone) {
    return res.status(400).json({ error: 'Nome e telefone sao obrigatorios' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos 1 item no pedido' });
  }

  try {
    // Patch (21/05/2026): JOIN companies pra obter trade_name (statement_descriptor MP).
    const { rows: configs } = await db.query(
      `SELECT dcc.*, COALESCE(c.trade_name, c.legal_name) AS company_display_name
       FROM digital_channel_config dcc
       JOIN companies c ON c.id = dcc.company_id
       WHERE dcc.slug = $1 AND dcc.is_published = true`, [slug]);
    if (!configs.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const config = configs[0];
    const cid = config.company_id;

    // MP Fase 1 (20/05/2026): detecta gateway MP da empresa
    let mpGateway = null;
    try {
      const { rows: gws } = await db.query(
        `SELECT access_token, public_key FROM companies_payment_gateways WHERE company_id = $1 AND gateway = 'mercadopago' LIMIT 1`,
        [cid]
      );
      mpGateway = gws[0] || null;
    } catch (_) { /* tabela pode não existir em deployment antigo */ }
    const hasMpGateway = !!mpGateway;
    // Migration 121 (21/05/2026): hasCard respeita card_enabled toggle.
    // Default true quando coluna não existe (pré-migration) ou não foi setada.
    const cardEnabled = config.card_enabled !== false;
    const hasCard = hasMpGateway && cardEnabled;

    const dtype = delivery_type || 'pickup';
    if (dtype === 'delivery' && !config.delivery_enabled) {
      return res.status(400).json({ error: 'Entrega nao disponivel nesta loja' });
    }
    if (dtype === 'pickup' && config.pickup_enabled === false) {
      return res.status(400).json({ error: 'Retirada nao disponivel nesta loja' });
    }
    if (dtype === 'delivery' && !delivery_address && !address_street) {
      return res.status(400).json({ error: 'Endereco de entrega e obrigatorio' });
    }

    // Retirada por app (migration 288): o cliente contrata Uber/99 e diz
    // quem vai buscar. Nao pede endereco — o pacote sai do balcao — e nao
    // cobra frete, porque quem paga o app e o cliente. A validacao mora em
    // services/courierPickup.js, compartilhada com o storefront do Studio.
    let courierData = null;
    if (dtype === COURIER) {
      const r = validateCourierPickup(config, req.body);
      if (r.error) return res.status(400).json({ error: r.error });
      courierData = r;
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

    if (dtype === 'delivery' && address_street) {
      const required = { address_zip, address_street, address_number, address_neighborhood, address_city, address_state };
      const missing = Object.entries(required).filter(([_, v]) => !v || !String(v).trim()).map(([k]) => k);
      if (missing.length) {
        return res.status(400).json({ error: 'Endereco incompleto. Faltam: ' + missing.join(', ') });
      }
      if (!/^\d{8}$/.test(String(address_zip).replace(/\D/g, ''))) {
        return res.status(400).json({ error: 'CEP invalido (8 digitos)' });
      }
      if (!/^[A-Z]{2}$/.test(String(address_state).toUpperCase())) {
        return res.status(400).json({ error: 'UF invalida (2 letras)' });
      }
    }

    const hasPix = !!(config.pix_key && String(config.pix_key).trim()) || hasMpGateway;
    const hasOnDelivery = !!config.pay_on_delivery_enabled;
    let pmethod = (payment_method || '').toLowerCase().trim();
    if (!pmethod) {
      pmethod = hasPix ? 'pix' : (hasCard ? 'card' : (hasOnDelivery ? 'on_delivery' : null));
    }
    if (!pmethod) {
      // 01/09/2026 — dinheiro parado na mesa: o cliente CHEGOU no checkout e
      // foi barrado porque a loja não tem Pix, cartão nem pagar-na-entrega.
      // Não há pedido para linkar (ele não chega a existir — é justamente
      // esse o ponto), então a dedupe_key é por empresa e por DIA: repetir o
      // aviso a cada tentativa transformaria uma configuração faltando em
      // enxurrada de sino.
      const hoje = new Date().toISOString().slice(0, 10);
      lojaEvents.emit('loja_sem_pagamento_configurado', { company_id: cid },
        { dedupeSuffix: `${cid}:${hoje}` });
      return res.status(400).json({ error: 'Esta loja nao aceita pagamentos no momento' });
    }
    if (pmethod !== 'pix' && pmethod !== 'on_delivery' && pmethod !== 'card') {
      return res.status(400).json({ error: 'payment_method invalido. Use pix, card ou on_delivery' });
    }
    if (pmethod === 'pix' && !hasPix) {
      return res.status(400).json({ error: 'Esta loja nao aceita Pix' });
    }
    if (pmethod === 'card' && !hasCard) {
      // Mensagem distinta quando gateway existe mas está pausado vs não configurado
      const msg = hasMpGateway
        ? 'Pagamento com cartão está temporariamente desativado pela loja. Use Pix ou pague na entrega.'
        : 'Esta loja nao aceita pagamento com cartao';
      return res.status(400).json({ error: msg });
    }
    if (pmethod === 'on_delivery' && !hasOnDelivery) {
      return res.status(400).json({ error: 'Esta loja nao aceita pagamento na entrega' });
    }

    const productIds = items.map(i => i.product_id);
    const { rows: products } = await db.query(
      `SELECT id, name, price, stock_qty, image_url, is_active
       FROM products
       WHERE id::text = ANY($1) AND ${listVisibilityWhere('$2')}`,
      [productIds.map(String), cid]
    );
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

    let delivery_fee = 0;
    let shippingMeta = null;
    if (dtype === 'delivery') {
      if (address_zip) {
        const cleanZip = String(address_zip).replace(/\D/g, '');
        const quote = await calculateShippingQuote(config, cleanZip, subtotal);
        shippingMeta = quote;
        if (quote.error && quote.fee == null) {
          return res.status(400).json({
            error: quote.error,
            distance_km: quote.distance_km,
          });
        }
        delivery_fee = parseFloat(quote.fee) || 0;

        if (expected_delivery_fee != null && expected_delivery_fee !== '') {
          const expected = parseFloat(expected_delivery_fee);
          if (Number.isFinite(expected) && Math.abs(expected - delivery_fee) > 0.01) {
            return res.status(409).json({
              error: 'Valor de frete desatualizado. Atualize a pagina e tente de novo.',
              server_fee: delivery_fee,
              client_fee: expected,
            });
          }
        }
      } else {
        delivery_fee = parseFloat(config.delivery_fee) || 0;
      }
    }
    const total = subtotal + delivery_fee;

    const initialStatus = pmethod === 'on_delivery' ? 'confirmed' : 'pending_payment';
    const initialPaymentStatus = 'pending';

    const client = await db.connect();
    let order;
    try {
      await client.query('BEGIN');
      let composedAddress = delivery_address || null;
      if (dtype === 'delivery' && !composedAddress && address_street) {
        composedAddress = `${address_street}, ${address_number}` +
          (address_complement ? ` (${address_complement})` : '') +
          ` - ${address_neighborhood}, ${address_city}/${String(address_state).toUpperCase()}` +
          ` - CEP ${String(address_zip).replace(/\D/g, '')}`;
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
          courier_name, courier_plate
        ) VALUES (
          $1, next_digital_order_number($1), $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13,
          CASE WHEN $10 = 'confirmed' THEN NOW() ELSE NULL END,
          $14, $15,
          $16, $17, $18, $19,
          $20, $21, $22,
          $23, $24
        ) RETURNING *
      `, [
        cid, customer_name, customer_phone, customer_email || null,
        dtype, composedAddress, delivery_fee, subtotal, total,
        initialStatus, initialPaymentStatus, pmethod, notes || null,
        cpfNorm || null, !!request_nfce,
        address_zip ? String(address_zip).replace(/\D/g, '') : null,
        address_street || null, address_number || null, address_complement || null,
        address_neighborhood || null, address_city || null,
        address_state ? String(address_state).toUpperCase() : null,
        courierData ? courierData.courier_name : null,
        courierData ? courierData.courier_plate : null,
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
            description:   `Pedido #${order.order_number}`,
          });
          await db.query(
            `UPDATE digital_orders SET mp_payment_id = $1, updated_at = NOW() WHERE id = $2`,
            [pixData.payment_id, order.id]
          );
        } catch (mpErr) {
          console.error('[storefront] MP Pix error, fallback to static Pix:', mpErr.message);
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

    // Custom domain (22/05/2026): usa custom_domain como base da back_url quando configurado.
    // Fix: prefixo /api/v1/ estava faltando no fallback Railway.
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
        console.error('[storefront] MP Preference error:', mpErr.message);
        return res.status(500).json({ error: 'Erro ao criar preferencia de pagamento. Tente novamente.' });
      }
    }

    // on_delivery: pedido nasce confirmed → notifica lojista + cliente imediatamente.
    // Pix/Cartão: sem notificações aqui — webhook MP ou approve-payment chamam notifyPaymentConfirmed.
    if (initialStatus === 'confirmed') {
      onOrderConfirmed(order.id)
        .catch(err => console.error('[storefront] onOrderConfirmed error:', err.message));
      notify.notifyPaymentConfirmed({ order })
        .catch(err => console.error('[storefront] notifyPaymentConfirmed error:', err.message));
    }

    // Eventos duráveis no sino da lojista. 'loja_pedido_novo' já existia como
    // feed de 24h em /notifications — agora vira linha que só some quando
    // alguém lê. O de portador nasce aqui porque courier_name é preenchido no
    // checkout pelo CLIENTE e por nenhum fluxo depois: o aviso é "confira nome
    // e placa antes de entregar", não "o pacote saiu".
    lojaEvents.emit('loja_pedido_novo', order);
    if (courierData) lojaEvents.emit('loja_pedido_saiu_entrega', order);

    res.status(201).json({
      order_id:       order.id,
      order_number:   order.order_number,
      total,
      delivery_fee,
      subtotal,
      status:         initialStatus,
      payment_method: pmethod,
      shipping:       shippingMeta,
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
    console.error('create order error:', err);
    res.status(500).json({ error: 'Erro ao criar pedido' });
  }
});

router.post('/:slug/order/:oid/upload-proof', async (req, res) => {
  const slug = req.params.slug.toLowerCase().trim();
  const { oid } = req.params;
  const { content, content_type } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content (base64) obrigatorio' });
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
      UPDATE digital_orders SET payment_proof_url = $1, payment_proof_uploaded_at = NOW(), updated_at = NOW() WHERE id = $2
    `, [url, oid]);
    res.json({ payment_proof_url: url, key: result.key });

    // Comprovante EXIGE conferência humana e até 01/09/2026 não avisava
    // ninguém: o comprovante ficava no pedido esperando alguém abrir a aba.
    lojaEvents.emit('loja_comprovante_enviado', order);
  } catch (err) {
    console.error('[storefront] upload-proof error:', err.message);
    res.status(500).json({ error: 'Erro ao enviar comprovante' });
  }
});

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
      return res.status(409).json({ error: `Pedido nao pode ser marcado (status atual: ${order.status})` });
    }
    await db.query(`UPDATE digital_orders SET status = 'awaiting_approval', updated_at = NOW() WHERE id = $1`, [oid]);
    res.json({ status: 'awaiting_approval', message: 'Aguardando confirmacao do lojista. Voce sera avisado por WhatsApp.' });
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
