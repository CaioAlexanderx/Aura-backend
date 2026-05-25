// ============================================================
// AURA. — Mercado Livre Adapter
//
// Core F1.B (25/05/2026): OAuth + publish + fetch orders + webhook.
//
// Docs: https://developers.mercadolivre.com.br/pt_br/
// OAuth2: code grant flow
//   1. GET /authorization?response_type=code&client_id=...&redirect_uri=...
//   2. Callback: ?code=XXX&state=YYY
//   3. POST /oauth/token { grant_type=authorization_code, code, client_id, client_secret, redirect_uri }
//   4. Resposta: { access_token, refresh_token, expires_in, scope, user_id }
//   5. Refresh: POST /oauth/token { grant_type=refresh_token, refresh_token, client_id, client_secret }
//
// ENV vars:
//  - ML_CLIENT_ID
//  - ML_CLIENT_SECRET
//  - ML_REDIRECT_URI (default: STOREFRONT_API_BASE_URL + /api/v1/marketplaces/mercadolivre/callback)
// ============================================================
'use strict';

const MarketplaceAdapter = require('../MarketplaceAdapter');
const { buildMercadoLivrePayload } = require('../../routes/studioMarketplaceListing');

const ML_API_BASE  = 'https://api.mercadolibre.com';
const ML_AUTH_BASE = 'https://auth.mercadolivre.com.br';

class MercadoLivreAdapter extends MarketplaceAdapter {
  constructor() {
    super('mercado_livre');
  }

  _clientId()     { return process.env.ML_CLIENT_ID; }
  _clientSecret() { return process.env.ML_CLIENT_SECRET; }
  _redirectUri()  {
    return process.env.ML_REDIRECT_URI
      || (process.env.STOREFRONT_API_BASE_URL || 'https://aura-backend-production-f805.up.railway.app')
         + '/api/v1/marketplaces/mercadolivre/callback';
  }

  _assertConfigured() {
    if (!this._clientId() || !this._clientSecret()) {
      const err = new Error('ML OAuth nao configurado. Configure ML_CLIENT_ID + ML_CLIENT_SECRET no Railway.');
      err.statusCode = 503;
      err.code = 'ML_OAUTH_NOT_CONFIGURED';
      throw err;
    }
  }

  // ─── OAuth ───────────────────────────────────────────────
  async getAuthUrl({ companyId, redirectUri }) {
    this._assertConfigured();
    const state = Buffer.from(JSON.stringify({ companyId, ts: Date.now() })).toString('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this._clientId(),
      redirect_uri: redirectUri || this._redirectUri(),
      state,
    });
    return {
      authUrl: `${ML_AUTH_BASE}/authorization?${params.toString()}`,
      state,
    };
  }

  async authorize({ companyId, code, redirectUri }) {
    this._assertConfigured();
    const t0 = Date.now();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this._clientId(),
      client_secret: this._clientSecret(),
      code,
      redirect_uri: redirectUri || this._redirectUri(),
    });
    let tokenJson;
    try {
      const resp = await fetch(`${ML_API_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      tokenJson = await resp.json();
      if (!resp.ok) {
        const msg = tokenJson.message || tokenJson.error_description || tokenJson.error || 'Erro OAuth ML';
        const err = new Error(`ML OAuth: ${msg}`);
        err.statusCode = resp.status;
        throw err;
      }
    } catch (e) {
      await this.logAction({ companyId, action: 'authorize', status: 'error', errorMessage: e.message, durationMs: Date.now() - t0 });
      throw e;
    }

    // tokenJson: { access_token, token_type, expires_in, refresh_token, scope, user_id }
    const tokenExpires = new Date(Date.now() + (tokenJson.expires_in || 21600) * 1000);

    // Buscar dados do usuario pra storeId/storeName
    let storeId = String(tokenJson.user_id || '');
    let storeName = null;
    try {
      const userResp = await fetch(`${ML_API_BASE}/users/me`, {
        headers: { authorization: `Bearer ${tokenJson.access_token}` },
      });
      if (userResp.ok) {
        const u = await userResp.json();
        storeName = u.nickname || u.first_name || null;
      }
    } catch (_) { /* nao bloqueia */ }

    const connection = await this.insertConnection({
      companyId,
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token,
      tokenExpires,
      scope: tokenJson.scope || null,
      storeId, storeName,
    });

    await this.logAction({
      companyId, connectionId: connection.id, action: 'authorize', status: 'ok',
      payload: { scope: tokenJson.scope, user_id: tokenJson.user_id },
      durationMs: Date.now() - t0,
    });
    return connection;
  }

  async refreshAuth(connection) {
    this._assertConfigured();
    const t0 = Date.now();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this._clientId(),
      client_secret: this._clientSecret(),
      refresh_token: connection.refresh_token,
    });
    let tokenJson;
    try {
      const resp = await fetch(`${ML_API_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      tokenJson = await resp.json();
      if (!resp.ok) {
        const err = new Error(`ML refresh: ${tokenJson.message || tokenJson.error || 'erro desconhecido'}`);
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

    const tokenExpires = new Date(Date.now() + (tokenJson.expires_in || 21600) * 1000);
    const saved = await this.saveConnection({
      ...connection,
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token || connection.refresh_token,
      token_expires: tokenExpires,
      scope: tokenJson.scope || connection.scope,
    });
    await this.logAction({
      companyId: connection.company_id, connectionId: connection.id,
      action: 'refresh_token', status: 'ok', durationMs: Date.now() - t0,
    });
    return saved;
  }

  // ─── Catalogo ────────────────────────────────────────────
  async publishProduct(connection, product) {
    const fresh = await this.ensureFreshToken(connection);
    const t0 = Date.now();
    // Payload Studio-aware vem do helper ja existente (S-1)
    const payload = buildMercadoLivrePayload(product, product._settings || {});
    delete payload._aura_meta; // ML nao aceita campos custom

    let respJson;
    try {
      const resp = await fetch(`${ML_API_BASE}/items?access_token=${fresh.access_token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      respJson = await resp.json();
      if (!resp.ok) {
        const msg = respJson.message || respJson.error || 'erro desconhecido';
        const cause = respJson.cause ? JSON.stringify(respJson.cause).slice(0, 200) : '';
        const err = new Error(`ML publishProduct: ${msg}${cause ? ` (${cause})` : ''}`);
        err.statusCode = resp.status;
        throw err;
      }
    } catch (e) {
      await this.logAction({
        companyId: connection.company_id, connectionId: connection.id,
        action: 'publish_product', status: 'error', productId: product.id,
        payload, errorMessage: e.message, durationMs: Date.now() - t0,
      });
      throw e;
    }

    await this.logAction({
      companyId: connection.company_id, connectionId: connection.id,
      action: 'publish_product', status: 'ok', productId: product.id,
      response: { id: respJson.id, permalink: respJson.permalink },
      durationMs: Date.now() - t0,
    });
    return {
      external_id: respJson.id,
      external_url: respJson.permalink || null,
    };
  }

  async updatePrice(connection, externalId, price) {
    const fresh = await this.ensureFreshToken(connection);
    const resp = await fetch(`${ML_API_BASE}/items/${externalId}?access_token=${fresh.access_token}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ price }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`ML updatePrice: ${err.message || resp.status}`);
    }
  }

  async updateStock(connection, externalId, qty) {
    const fresh = await this.ensureFreshToken(connection);
    const resp = await fetch(`${ML_API_BASE}/items/${externalId}?access_token=${fresh.access_token}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ available_quantity: qty }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`ML updateStock: ${err.message || resp.status}`);
    }
  }

  async unpublishProduct(connection, externalId) {
    const fresh = await this.ensureFreshToken(connection);
    const resp = await fetch(`${ML_API_BASE}/items/${externalId}?access_token=${fresh.access_token}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    });
    if (!resp.ok) throw new Error(`ML unpublishProduct: ${resp.status}`);
  }

  // ─── Pedidos ─────────────────────────────────────────────
  async fetchOrderById(connection, externalId) {
    const fresh = await this.ensureFreshToken(connection);
    const resp = await fetch(`${ML_API_BASE}/orders/${externalId}?access_token=${fresh.access_token}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`ML fetchOrderById: ${err.message || resp.status}`);
    }
    return await resp.json();
  }

  async updateShipmentStatus(connection, externalId, trackingCode, carrier) {
    // ML: shipment fica em pedido.shipping.id. Pra atualizar tracking,
    // a logica real depende do modo (me1 vs me2). Pra MVP retornamos
    // sucesso silencioso — lojista marca no painel ML tambem.
    await this.logAction({
      companyId: connection.company_id, connectionId: connection.id,
      action: 'update_shipment_status', status: 'ok',
      payload: { external_id: externalId, tracking_code: trackingCode, carrier },
    });
    return { warning: 'ML me2 gerencia tracking automaticamente; manual nao suportado pelo MVP.' };
  }

  // ─── Webhook ─────────────────────────────────────────────
  verifyWebhookSignature(req) {
    // ML usa secret_key em query string no webhook (configurado no app dev).
    // Implementacao real requer assinatura HMAC custom — pra MVP aceita
    // tudo e loga warning.
    const expected = process.env.ML_WEBHOOK_SECRET;
    if (!expected) return true;
    return req.query?.secret === expected || req.headers?.['x-ml-secret'] === expected;
  }

  async parseWebhook(payload, connection) {
    // ML webhook payload: { topic: 'orders_v2', resource: '/orders/123456' }
    if (!payload || payload.topic !== 'orders_v2') {
      return null; // Ignora notificacoes que nao sao de pedido
    }
    const match = /\/orders\/(\d+)/.exec(payload.resource || '');
    if (!match) return null;
    const orderId = match[1];
    return await this.fetchOrderById(connection, orderId);
  }

  async fetchOrders() { throw new Error('fetchOrders not implemented yet (pull job F1.D futuro)'); }
}

module.exports = MercadoLivreAdapter;
