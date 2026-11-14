// ============================================================
// AURA. — Código IBGE do município pelo CEP (ViaCEP). 14/11/2026.
//
// A NF-e modelo 55 exige o código IBGE do município do destinatário
// (enderDest/cMun) e o cadastro de clientes nunca guardou esse código.
// ViaCEP devolve `ibge` junto do endereço: https://viacep.com.br/ws/<cep>/json/
//
// Mesmo padrão de services/cepGeocoding.js: fetch nativo, timeout curto,
// erro vira null (quem chama decide — a NF-e devolve 422 pedindo o
// município; nunca inventamos código). Cache em memória por CEP (24 h
// para acerto, 10 min para "CEP não existe"; falha de rede não é cacheada).
// ============================================================
'use strict';

const VIACEP_BASE = 'https://viacep.com.br/ws';
const TIMEOUT_MS = 3000;
const TTL_OK_MS = 24 * 60 * 60 * 1000;
const TTL_NAO_EXISTE_MS = 10 * 60 * 1000;
const MAX_CACHE = 5000;

const _cache = new Map(); // cep → { valor, ate }

function normalizarCep(raw) {
  const d = String(raw == null ? '' : raw).replace(/\D/g, '');
  return d.length === 8 ? d : null;
}

/**
 * @param {string} cep
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<null | { ibge, municipio, uf, logradouro, bairro, cep }>}
 */
async function ibgePeloCep(cep, opts = {}) {
  const limpo = normalizarCep(cep);
  if (!limpo) return null;
  const hit = _cache.get(limpo);
  if (hit && hit.ate > Date.now()) return hit.valor;

  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${VIACEP_BASE}/${limpo}/json/`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Aura-Backend/1.0', Accept: 'application/json' },
    });
    if (!resp || !resp.ok) return null;
    const data = await resp.json();
    let valor = null;
    if (data && !data.erro && /^\d{7}$/.test(String(data.ibge || ''))) {
      valor = {
        ibge: String(data.ibge),
        municipio: data.localidade || null,
        uf: data.uf ? String(data.uf).toUpperCase() : null,
        logradouro: data.logradouro || null,
        bairro: data.bairro || null,
        cep: limpo,
      };
    }
    if (_cache.size >= MAX_CACHE) _cache.clear();
    _cache.set(limpo, { valor, ate: Date.now() + (valor ? TTL_OK_MS : TTL_NAO_EXISTE_MS) });
    return valor;
  } catch (_) {
    return null; // timeout, rede, JSON ruim: não cacheia
  } finally {
    clearTimeout(timer);
  }
}

function _limparCache() { _cache.clear(); }

module.exports = { ibgePeloCep, normalizarCep, _limparCache };
