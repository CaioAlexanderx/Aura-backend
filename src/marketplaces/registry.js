// ============================================================
// AURA. — Marketplace Adapter Registry
//
// Core F1.A (25/05/2026): registry factory pra adapters.
// Usado por: routes/marketplace, webhookMarketplace, SyncEngine.
// ============================================================
'use strict';

const MercadoLivreAdapter = require('./mercadolivre/MercadoLivreAdapter');
const ShopeeAdapter       = require('./shopee/ShopeeAdapter');

const ADAPTERS = {
  mercado_livre: new MercadoLivreAdapter(),
  shopee:        new ShopeeAdapter(),
};

const SUPPORTED_PLATFORMS = Object.keys(ADAPTERS);

/**
 * @param {string} platform - 'mercado_livre' | 'shopee'
 * @returns {MarketplaceAdapter}
 */
function getAdapter(platform) {
  const adapter = ADAPTERS[platform];
  if (!adapter) {
    throw new Error(`Marketplace platform desconhecida: ${platform}. Suportadas: ${SUPPORTED_PLATFORMS.join(', ')}`);
  }
  return adapter;
}

module.exports = {
  getAdapter,
  SUPPORTED_PLATFORMS,
  ADAPTERS,
};
