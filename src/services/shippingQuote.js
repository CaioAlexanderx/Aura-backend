// ============================================================
// AURA. — Shipping Quote service (Fase 5b)
// Calcula o frete de uma entrega dado:
//   - config da loja (digital_channel_config row)
//   - CEP do cliente (8 digitos)
//   - subtotal do carrinho (pra checar frete gratis)
//
// Retorna um objeto com shape:
//   { fee: number|null, eta: string|null, mode: string, currency: 'BRL',
//     free_shipping?: bool, distance_km?: number, tier_max_km?: number,
//     error?: string, alert?: string }
//
// Reusado pelo endpoint publico GET /storefront/:slug/shipping-quote
// e pela validacao server-side em POST /storefront/:slug/order.
// ============================================================
'use strict';

const { geocodeCep, haversineKm, normalizeCep } = require('./cepGeocoding');

function parseTiers(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
    catch { return []; }
  }
  return [];
}

/**
 * @param {object} config - row de digital_channel_config
 * @param {string} cep    - CEP do cliente (qualquer formato)
 * @param {number} subtotal - subtotal do carrinho (pre-frete)
 * @returns {Promise<object>} quote
 */
async function calculateShippingQuote(config, cep, subtotal) {
  const clean = normalizeCep(cep);
  if (!clean) {
    return {
      fee: null,
      eta: null,
      mode: 'invalid',
      currency: 'BRL',
      error: 'CEP invalido (8 digitos)',
    };
  }

  const sub = parseFloat(subtotal) || 0;
  const deliveryEta = config.delivery_eta_text || null;
  const flatFee = parseFloat(config.delivery_fee) || 0;
  const freeAbove = config.delivery_free_above_amount != null
    ? parseFloat(config.delivery_free_above_amount)
    : null;

  // 1) Frete gratis
  if (freeAbove != null && sub >= freeAbove) {
    return {
      fee: 0,
      eta: deliveryEta,
      mode: 'free',
      currency: 'BRL',
      free_shipping: true,
    };
  }

  const pricingMode = config.delivery_pricing_mode || 'flat';

  // 2) Modo flat
  if (pricingMode !== 'distance') {
    return {
      fee: flatFee,
      eta: deliveryEta,
      mode: 'flat',
      currency: 'BRL',
    };
  }

  // 3) Modo distance
  const tiers = parseTiers(config.delivery_distance_tiers);
  const originLat = config.origin_lat != null ? parseFloat(config.origin_lat) : null;
  const originLng = config.origin_lng != null ? parseFloat(config.origin_lng) : null;

  // Sem geo da origem ou sem tiers -> fallback flat com alerta
  if (originLat == null || originLng == null || tiers.length === 0) {
    return {
      fee: flatFee,
      eta: deliveryEta,
      mode: 'flat-fallback',
      currency: 'BRL',
      alert: tiers.length === 0
        ? 'Loja sem faixas de distancia configuradas, usando taxa fixa.'
        : 'Loja sem CEP de origem geolocalizado, usando taxa fixa.',
    };
  }

  // Geocode CEP cliente
  const customerGeo = await geocodeCep(clean);
  if (!customerGeo) {
    // CEP do cliente sem geo no BrasilAPI -> fallback flat
    return {
      fee: flatFee,
      eta: deliveryEta,
      mode: 'flat-fallback',
      currency: 'BRL',
      alert: 'CEP do cliente nao geolocalizado, usando taxa fixa.',
    };
  }

  const distanceKm = haversineKm(originLat, originLng, customerGeo.lat, customerGeo.lng);
  const distRounded = Math.round(distanceKm * 10) / 10;

  // tiers ja ordenado por max_km ASC (sanitizeDistanceTiers ordena no save)
  // mas reordenamos defensivamente caso venha sujo de uma loja antiga
  const sortedTiers = [...tiers].sort((a, b) =>
    (parseFloat(a.max_km) || 0) - (parseFloat(b.max_km) || 0)
  );

  const matched = sortedTiers.find(t => {
    const maxKm = parseFloat(t.max_km);
    return Number.isFinite(maxKm) && maxKm >= distanceKm;
  });

  if (!matched) {
    return {
      fee: null,
      eta: null,
      mode: 'distance',
      currency: 'BRL',
      distance_km: distRounded,
      error: 'Fora da area de entrega',
    };
  }

  return {
    fee: parseFloat(matched.fee) || 0,
    eta: deliveryEta,
    mode: 'distance',
    currency: 'BRL',
    distance_km: distRounded,
    tier_max_km: parseFloat(matched.max_km),
  };
}

module.exports = { calculateShippingQuote };
