// ============================================================
// AURA. — Shopee Adapter
//
// Core F2.B (25/05/2026): OAuth + publish + fetch + webhook.
//
// Docs: https://open.shopee.com/documents
// OAuth2 signed: GET /api/v2/shop/auth_partner?partner_id=X&sign=Y&redirect=URL
//   1. Frontend abre URL — usuario autoriza no Shopee
//   2. Callback: ?code=XXX&shop_id=YYY
//   3. POST /api/v2/auth/token/get { code, partner_id, shop_id, sign, timestamp }
//   4. Resposta: { access_token, refresh_token, expire_in, request_id }
//
// ENV vars:
//  - SHOPEE_PARTNER_ID
//  - SHOPEE_PARTNER_KEY (32-char hex)
//  - SHOPEE_REDIRECT_URI (default: STOREFRONT_API_BASE + /api/v1/marketplaces/shopee/callback)
//  - SHOPEE_BASE_URL (default: https://partner.shopeemobile.com)
// ============================================================
'use strict';

const crypto = require('crypto');
const MarketplaceAdapter = require('../MarketplaceAdapter');
const { buildShopeePayload } = require('../../routes/studioMarketplaceListing');

class ShopeeAdapter extends MarketplaceAdapter {
  constructor() {
    super('shopee');
  }

  _partnerId()  { return process.env.SHOPEE_PARTNER_ID; }
  _partnerKey() { return process.env.SHOPEE_PARTNER_KEY; }
  _baseUrl()    { return process.env.SHOPEE_BASE_URL || 'https://partner.shopeemobile.com'; }
  _redirectUri() {
    return process.env.SHOPEE_REDIRECT_URI
      || (process.env.STOREFRONT_API_BASE_URL || 'https://aura-backend-production-f805.up.railway.app')
         + '/api/v1/marketplaces/shopee/callback';
  }

  _assertConfigured() {
    if (!this._partnerId() || !this._partnerKey()) {
      const err = new Error('Shopee OAuth nao configurado. Configure SHOPEE_PARTNER_ID + SHOPEE_PARTNER_KEY no Railway.');
      err.statusCode = 503;
      err.code = 'SHOPEE_OAUTH_NOT_CONFIGURED';
      throw err;
    }
  }

  // Shopee assina cada request com HMAC SHA-256 do path + timestamp + params
  _sign(path, timestamp, extra = '') {
    const baseString = `${this._partnerId()}${path}${timestamp}${extra}`;
    return crypto.createHmac('sha256', this._partnerKey()).update(baseString).digest('hex');
  }

  // ─── OAuth ───────────────────────────────────────────────
  async getAuthUrl({ companyId }) {
    this._assertConfigured();
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/shop/auth_partner';
    const sign = this._sign(path, timestamp);
    const params = new URLSearchParams({
      partner_id: this._partnerId(),
      timestamp: String(timestamp),
      sign,
      redirect: this._redirectUri(),
    });
    // State carrega companyId pra recuperar no callback
    const state = Buffer.from(JSON.stringify({ companyId, ts: Date.now() })).toString('base64url');
    return {
      authUrl: `${this._baseUrl()}${path}?${params.toString()}&state=${state}`,
      state,
    };
  }

  async authorize({ companyId, code, shopId }) {
    this._assertConfigured();
    if (!shopId) throw new Error('Shopee authorize: shop_id obrigatorio (vem na callback URL)');
    const t0 = Date.now();
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/auth/token/get';
    const sign = this._sign(path, timestamp);

    let tokenJson;
    try {
      const resp = await fetch(`${this._baseUrl()}${path}?partner_id=${this._partnerId()}&timestamp=${timestamp}&sign=${sign}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(this._partnerId()) }),
      });
      tokenJson = await resp.json();
      if (tokenJson.error || !tokenJson.access_token) {
        const msg = tokenJson.message || tokenJson.error || 'Erro Shopee OAuth';
        const err = new Error(`Shopee OAuth: ${msg}`);
        err.statusCode = resp.status;
        throw err;
      }
    } catch (e) {
      await this.logAction({ companyId, action: 'authorize', status: 'error', errorMessage: e.message, durationMs: Date.now() - t0 });
      throw e;
    }

    const tokenExpires = new Date(Date.now() + (tokenJson.expire_in || 14400) * 1000);
    const connection = await this.insertConnection({
      companyId,
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token,
      tokenExpires,
      scope: null, // Shopee nao retorna scope no formato OAuth padrao
      storeId: String(shopId),
      storeName: null, // pode buscar via get_shop_info depois
    });

    await this.logAction({
      companyId, connectionId: connection.id, action: 'authorize', status: 'ok',
      payload: { shop_id: shopId }, durationMs: Date.now() - t0,
    });
    return connection;
  }

  async refreshAuth(connection) {
    this._assertConfigured();
    const t0 = Date.now();
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/auth/access_token/get';
    const sign = this._sign(path, timestamp);

    let tokenJson;
    try {
      const resp = await fetch(`${this._baseUrl()}${path}?partner_id=${this._partnerId()}&timestamp=${timestamp}&sign=${sign}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          refresh_token: connection.refresh_token,
          partner_id: Number(this._partnerId()),
          shop_id: Number(connection.store_id),
        }),
      });
      tokenJson = await resp.json();
      if (tokenJson.error || !tokenJson.access_token) {
        const err = new Error(`Shopee refresh: ${tokenJson.message || tokenJson.error}`);
        err.statusCode = resp.status;
        throw err;
      }
    } catch (e) {
      await this.logAction({
        companyId: connection.company_id, connectionId: connection.id,
        action: 'refresh_token', status: 'error', errorMessage: e.message, durationMs: Date.now() - t0,
      });
      throw e;
    }

    const tokenExpires = new Date(Date.now() + (tokenJson.expire_in || 14400) * 1000);
    const saved = await this.saveConnection({
      ...connection,
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token || connection.refresh_token,
      token_expires: tokenExpires,
    });
    await this.logAction({
      companyId: connection.company_id, connectionId: connection.id,
      action: 'refresh_token', status: 'ok', durationMs: Date.now() - t0,
    });
    return saved;
  }

  // Shopee signature pra requests autenticadas (path + timestamp + access_token + shop_id)
  _signAuthed(path, timestamp, accessToken, shopId) {
    const baseString = `${this._partnerId()}${path}${timestamp}${accessToken}${shopId}`;
    return crypto.createHmac('sha256', this._partnerKey()).update(baseString).digest('hex');
  }

  async _authedRequest(connection, method, path, body) {
    const fresh = await this.ensureFreshToken(connection);
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this._signAuthed(path, timestamp, fresh.access_token, fresh.store_id);
    const url = `${this._baseUrl()}${path}?partner_id=${this._partnerId()}&timestamp=${timestamp}&access_token=${fresh.access_token}&shop_id=${fresh.store_id}&sign=${sign}`;
    const resp = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await resp.json();
    if (json.error) {
      throw new Error(`Shopee ${path}: ${json.message || json.error}`);
    }
    return json;
  }

  // ─── Catalogo ────────────────────────────────────────────
  async publishProduct(connection, product) {
    const t0 = Date.now();
    const payload = buildShopeePayload(product, product._settings || {});
    delete payload._aura_meta;
    try {
      const resp = await this._authedRequest(connection, 'POST', '/api/v2/product/add_item', payload);
      await this.logAction({
        companyId: connection.company_id, connectionId: connection.id,
        action: 'publish_product', status: 'ok', productId: product.id,
        response: { item_id: resp.response?.item_id },
        durationMs: Date.now() - t0,
      });
      return {
        external_id: String(resp.response?.item_id || ''),
        external_url: null, // Shopee nao retorna URL direta
      };
    } catch (e) {
      await this.logAction({
        companyId: connection.company_id, connectionId: connection.id,
        action: 'publish_product', status: 'error', productId: product.id,
        payload, errorMessage: e.message, durationMs: Date.now() - t0,
      });
      throw e;
    }
  }

  async updatePrice(connection, externalId, price) {
    await this._authedRequest(connection, 'POST', '/api/v2/product/update_price', {
      item_id: Number(externalId),
      price_list: [{ original_price: price }],
    });
  }

  async updateStock(connection, externalId, qty) {
    await this._authedRequest(connection, 'POST', '/api/v2/product/update_stock', {
      item_id: Number(externalId),
      stock_list: [{ stock_type: 1, normal_stock: qty }],
    });
  }

  async unpublishProduct(connection, externalId) {
    await this._authedRequest(connection, 'POST', '/api/v2/product/unlist_item', {
      item_list: [{ item_id: Number(externalId), unlist: true }],
    });
  }

  // ─── Pedidos ─────────────────────────────────────────────
  async fetchOrderById(connection, externalId) {
    const path = '/api/v2/order/get_order_detail';
    const json = await this._authedRequest(connection, 'GET', path);
    // Shopee endpoint real precisa de query params (order_sn_list, response_optional_fields)
    // — pra MVP retornamos o que veio. Implementacao plena no F1.D.
    return json;
  }

  async updateShipmentStatus(connection, externalId, trackingCode, carrier) {
    await this._authedRequest(connection, 'POST', '/api/v2/logistics/ship_order', {
      order_sn: externalId,
      pickup: { address_id: 0 },
      // tracking_number: trackingCode,
    });
    await this.logAction({
      companyId: connection.company_id, connectionId: connection.id,
      action: 'update_shipment_status', status: 'ok',
      payload: { external_id: externalId, tracking_code: trackingCode, carrier },
    });
  }

  // ─── Webhook ─────────────────────────────────────────────
  verifyWebhookSignature(req) {
    const expected = process.env.SHOPEE_PUSH_PARTNER_KEY || this._partnerKey();
    const signature = req.headers?.['authorization'];
    if (!expected || !signature) return false;
    // Shopee assina o webhook com HMAC SHA-256 do URL + body
    const url = req.originalUrl || req.url;
    const raw = req.rawBody || JSON.stringify(req.body || {});
    const computed = crypto.createHmac('sha256', expected).update(url + '|' + raw).digest('hex');
    return signature === computed;
  }

  async parseWebhook(payload, connection) {
    if (!payload || payload.code !== 3) return null; // 3 = ORDER_STATUS_UPDATE
    const orderSn = payload.data?.ordersn;
    if (!orderSn) return null;
    return await this.fetchOrderById(connection, orderSn);
  }

  async fetchOrders() { throw new Error('fetchOrders not implemented yet (pull job F2.D futuro)'); }
}

module.exports = ShopeeAdapter;
