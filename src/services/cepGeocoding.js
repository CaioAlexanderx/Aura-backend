// ============================================================
// AURA. — CEP Geocoding service (BrasilAPI v2)
// Fase 5b (20/05/2026): geocodifica CEP via BrasilAPI v2.
// Retorna { lat, lng } quando o CEP tem coordenadas no BrasilAPI,
// null caso contrario. Erros (timeout/rede/404) viram null silenciosos
// pra nao bloquear o fluxo de save/quote.
//
// Tambem exporta haversineKm(lat1,lng1,lat2,lng2) pra calculo de
// distancia entre dois pontos (raio da Terra = 6371 km).
// ============================================================
'use strict';

const BRASILAPI_BASE = 'https://brasilapi.com.br/api/cep/v2';
const TIMEOUT_MS = 3000;

function normalizeCep(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  return d.length === 8 ? d : null;
}

/**
 * Geocodifica um CEP via BrasilAPI v2.
 * @param {string} cep - CEP em qualquer formato (com ou sem hifen)
 * @returns {Promise<{lat:number,lng:number}|null>}
 */
async function geocodeCep(cep) {
  const clean = normalizeCep(cep);
  if (!clean) return null;

  // AbortController pra timeout em fetch nativo (Node 18+)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${BRASILAPI_BASE}/${clean}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Aura-Backend/1.0' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const lat = data?.location?.coordinates?.latitude;
    const lng = data?.location?.coordinates?.longitude;
    if (lat == null || lng == null) return null;
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
    return { lat: latNum, lng: lngNum };
  } catch (err) {
    // Timeout, rede, JSON malformado — todos viram null
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Distancia haversine em km entre dois pontos (lat/lng decimais).
 * Raio da Terra = 6371 km.
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = { geocodeCep, haversineKm, normalizeCep };
