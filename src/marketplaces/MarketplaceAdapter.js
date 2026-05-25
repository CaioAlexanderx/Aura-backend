// ============================================================
// AURA. — MarketplaceAdapter (interface base)
//
// Core Marketplace Integrations F1.A (25/05/2026)
//
// Contrato comum pros adapters de marketplaces (ML, Shopee, futuro Amazon
// /Shein/Magalu). Pra cada plataforma, um arquivo separado em
// src/marketplaces/<platform>/<Platform>Adapter.js que ESTENDE essa
// classe abstract.
//
// O `SyncEngine` (a vir) e o `webhookMarketplace` real instanciam o
// adapter via registry.getAdapter(platform). UI e logica de negocio sao
// platform-agnostic — so falam com a interface.
//
// Refs: BACKLOG_MARKETPLACE_INTEGRATIONS.md secao 2.2
// ============================================================
'use strict';

const db = require('../config/database');

class MarketplaceAdapter {
  /**
   * @param {string} platform - 'mercado_livre' | 'shopee' | etc
   */
  constructor(platform) {
    if (this.constructor === MarketplaceAdapter) {
      throw new Error('MarketplaceAdapter eh abstract — instancie um subclass concreto');
    }
    this.platform = platform;
  }

  // ─── OAuth ───────────────────────────────────────────────
  async getAuthUrl(opts) { throw new Error('getAuthUrl() not implemented'); }
  async authorize(opts)  { throw new Error('authorize() not implemented'); }
  async refreshAuth(connection) { throw new Error('refreshAuth() not implemented'); }

  async revoke(connection) {
    await db.query(
      `UPDATE marketplace_connections
          SET status = 'revogado',
              access_token = NULL,
              refresh_token = NULL,
              token_expires = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [connection.id]
    );
  }

  // ─── Catalogo (out) ───────────────────────────────────────
  async publishProduct(connection, product) { throw new Error('publishProduct() not implemented'); }
  async updatePrice(connection, externalId, price) { throw new Error('updatePrice() not implemented'); }
  async updateStock(connection, externalId, qty) { throw new Error('updateStock() not implemented'); }
  async unpublishProduct(connection, externalId) { throw new Error('unpublishProduct() not implemented'); }

  // ─── Pedidos (in) ─────────────────────────────────────────
  async fetchOrders(connection, since) { throw new Error('fetchOrders() not implemented'); }
  async fetchOrderById(connection, externalId) { throw new Error('fetchOrderById() not implemented'); }
  async updateShipmentStatus(connection, externalId, trackingCode, carrier) { throw new Error('updateShipmentStatus() not implemented'); }

  // ─── Webhook ──────────────────────────────────────────────
  verifyWebhookSignature(req) { throw new Error('verifyWebhookSignature() not implemented'); }
  async parseWebhook(payload, connection) { throw new Error('parseWebhook() not implemented'); }

  // ─── Helpers comuns (concretos) ───────────────────────────
  async saveConnection(connection) {
    const r = await db.query(
      `UPDATE marketplace_connections
          SET access_token = $1, refresh_token = $2, token_expires = $3,
              scope = $4, store_id = COALESCE($5, store_id),
              store_name = COALESCE($6, store_name),
              status = 'ativo', updated_at = NOW()
        WHERE id = $7
        RETURNING *`,
      [connection.access_token, connection.refresh_token, connection.token_expires,
       connection.scope, connection.store_id, connection.store_name, connection.id]
    );
    return r.rows[0];
  }

  async insertConnection({ companyId, accessToken, refreshToken, tokenExpires, scope, storeId, storeName }) {
    // Tenta UPDATE primeiro; se nao existe, INSERT. (UPSERT manual pra evitar
    // problema com unique constraint nomeada/sem nomeada.)
    const existing = await db.query(
      `SELECT id FROM marketplace_connections
        WHERE company_id = $1 AND platform = $2 LIMIT 1`,
      [companyId, this.platform]
    );
    if (existing.rows.length) {
      const r = await db.query(
        `UPDATE marketplace_connections
            SET access_token = $1, refresh_token = $2, token_expires = $3,
                scope = $4, store_id = $5, store_name = $6,
                status = 'ativo', updated_at = NOW()
          WHERE id = $7
          RETURNING *`,
        [accessToken, refreshToken, tokenExpires, scope || null,
         storeId || null, storeName || null, existing.rows[0].id]
      );
      return r.rows[0];
    }
    const r = await db.query(
      `INSERT INTO marketplace_connections
         (company_id, platform, access_token, refresh_token, token_expires,
          scope, store_id, store_name, status,
          sync_products, sync_orders, sync_stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ativo', true, true, true)
       RETURNING *`,
      [companyId, this.platform, accessToken, refreshToken, tokenExpires,
       scope || null, storeId || null, storeName || null]
    );
    return r.rows[0];
  }

  async logAction({ companyId, connectionId, action, status, productId, orderId, payload, response, errorMessage, durationMs }) {
    try {
      await db.query(
        `INSERT INTO marketplace_sync_log
           (company_id, connection_id, platform, action, status,
            product_id, order_id, payload, response, error_message, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
        [companyId, connectionId, this.platform, action, status || 'ok',
         productId || null, orderId || null,
         payload ? JSON.stringify(payload) : null,
         response ? JSON.stringify(response) : null,
         errorMessage || null, durationMs || null]
      );
    } catch (e) {
      console.error(`[${this.platform}] logAction error:`, e.message);
    }
  }

  async ensureFreshToken(connection) {
    if (!connection.token_expires) return connection;
    const expiresAt = new Date(connection.token_expires).getTime();
    const safetyMargin = 5 * 60 * 1000;
    if (expiresAt > Date.now() + safetyMargin) return connection;
    return await this.refreshAuth(connection);
  }
}

module.exports = MarketplaceAdapter;
