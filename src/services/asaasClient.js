// ============================================================
// AURA. — Cliente HTTP minimo do Asaas
//
// 15/06/2026: extraido de billing.js (identico) pra ser reutilizado
// pela sincronizacao de assinatura (seatSubscription.js) sem duplicar
// credenciais/erro handling.
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

module.exports = { asaas, ASAAS_URL };
