// ============================================================
// AURA. — Cliente HTTP minimo do Asaas
//
// 15/06/2026: extraido de billing.js (identico) pra ser reutilizado
// pela sincronizacao de assinatura (seatSubscription.js) sem duplicar
// credenciais/erro handling.
//
// 19/07/2026 (F3b Aura Dojô / BaaS): adicionado asaasRequest() — variante
// que aceita uma apiKey POR CHAMADA (pra falar com a SUBCONTA do dojô, não
// só com a conta-mãe) e resolve a base sandbox via env ASAAS_ENV. O legado
// asaas()/ASAAS_URL segue INTOCADO (compat com billing.js/seatSubscription).
// ============================================================

const ASAAS_URL = process.env.ASAAS_URL || 'https://api.asaas.com/v3';
const ASAAS_KEY = process.env.ASAAS_API_KEY;

async function asaas(method, path, body) {
  if (!ASAAS_KEY) throw new Error('ASAAS_API_KEY nao configurada');
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_KEY },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(ASAAS_URL + path, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.errors?.[0]?.description || 'Asaas error ' + resp.status);
  return data;
}

// Base resolvida dinamicamente: ASAAS_URL explicito tem prioridade; senão
// sandbox quando ASAAS_ENV=sandbox; senão produção. Lido a cada chamada
// (não cacheado) pra facilitar teste/homologação.
function resolveAsaasBaseUrl() {
  if (process.env.ASAAS_URL) return process.env.ASAAS_URL;
  if (String(process.env.ASAAS_ENV || '').trim().toLowerCase() === 'sandbox') {
    return 'https://sandbox.asaas.com/api/v3';
  }
  return 'https://api.asaas.com/v3';
}

// Variante genérica: apiKey por chamada (subconta do dojô no BaaS) com
// fallback pra ASAAS_API_KEY (conta-mãe). Erros carregam asaasStatus/
// asaasBody pra diagnóstico. NUNCA loga a apiKey.
async function asaasRequest(method, path, body, apiKey) {
  const key = apiKey || process.env.ASAAS_API_KEY || ASAAS_KEY;
  if (!key) throw new Error('ASAAS_API_KEY nao configurada');
  const base = resolveAsaasBaseUrl();
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'access_token': key },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(base + path, opts);
  let data = {};
  try { data = await resp.json(); } catch (_) { data = {}; }
  if (!resp.ok) {
    const desc = (data && data.errors && data.errors[0] && data.errors[0].description) || ('Asaas error ' + resp.status);
    const err = new Error(desc);
    err.asaasStatus = resp.status;
    err.asaasBody = data;
    throw err;
  }
  return data;
}

module.exports = { asaas, asaasRequest, resolveAsaasBaseUrl, ASAAS_URL };
