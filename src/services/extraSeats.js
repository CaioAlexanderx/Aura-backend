// ============================================================
// AURA. — Helper defensivo pra companies.extra_seats_granted
//
// 12/05/2026: a coluna extra_seats_granted veio na migration 110
// mas Aura-backend nao tem auto-runner — migrations sao aplicadas
// manualmente no Supabase. Janela entre push do codigo e aplicacao
// da migration: qualquer SELECT/UPDATE da coluna explode 42703
// (undefined_column) e cascateia (Gestao Aura mostra 0 clientes,
// /members/* fallback retorna essencial pra todos).
//
// Solucao: helper que tenta a query e captura 42703 silenciosamente,
// retornando default 0. Cache module-level flag pra evitar tentar
// e falhar de novo em cada request.
//
// 12/05/2026 (tarde): cache TIME-BASED. Antes era permanente — se
// virasse false uma vez, ficava false ate restart. Bug: cliente
// aplicou migration via MCP sem restart, cache continuou false e
// backend continuou devolvendo 0 mesmo com a coluna existindo.
// Agora cache de "ausente" expira em 60s e a query e re-tentada
// automaticamente. Cache de "existe" nao expira (uma vez true,
// fica true ate restart).
// ============================================================

const pool = require('../config/database');

// Estado do cache:
//   null = nao testado, ainda vai tentar
//   true = coluna existe (cache permanente ate restart)
//   false = coluna nao existe (cache temporario, expira em CACHE_MISS_TTL)
let _columnExistsCache = null;
let _columnMissingAt = 0; // timestamp da ultima vez que detectou ausencia
const CACHE_MISS_TTL_MS = 60 * 1000; // 60s — retentar apos esse tempo

function _isCacheStale() {
  return _columnExistsCache === false && (Date.now() - _columnMissingAt) >= CACHE_MISS_TTL_MS;
}

function _markColumnMissing() {
  _columnExistsCache = false;
  _columnMissingAt = Date.now();
}

function _markColumnExists() {
  _columnExistsCache = true;
  _columnMissingAt = 0;
}

/**
 * Retorna Map<companyId, extra_seats_granted_count> para a lista informada.
 * Se a coluna nao existe (pre-migration), retorna Map vazio — caller usa
 * default 0 pra cada cliente. Cache expira em 60s pra detectar quando a
 * migration roda sem precisar de restart.
 *
 * @param {string[]} companyIds — array de UUIDs
 * @returns {Promise<Map<string, number>>}
 */
async function getExtraSeatsMap(companyIds) {
  // Pula query se cache diz que coluna nao existe E ainda esta fresco
  if (_columnExistsCache === false && !_isCacheStale()) return new Map();
  if (!Array.isArray(companyIds) || companyIds.length === 0) return new Map();

  try {
    const { rows } = await pool.query(
      'SELECT id, COALESCE(extra_seats_granted, 0) AS extra_seats_granted FROM companies WHERE id = ANY($1::uuid[])',
      [companyIds]
    );
    _markColumnExists();
    const map = new Map();
    for (const r of rows) {
      map.set(r.id, parseInt(r.extra_seats_granted, 10) || 0);
    }
    return map;
  } catch (err) {
    if (err.code === '42703') {
      console.warn('[extraSeats] companies.extra_seats_granted ainda nao existe (migration 110 pendente). Tentando de novo em 60s.');
      _markColumnMissing();
      return new Map();
    }
    throw err;
  }
}

/**
 * Mesma logica acima mas pra uma empresa so. Atalho.
 */
async function getExtraSeatsForCompany(companyId) {
  const map = await getExtraSeatsMap([companyId]);
  return map.get(companyId) || 0;
}

/**
 * Faz UPDATE na coluna. Lanca 503-like se coluna ausente (pra
 * Gestao Aura nao silenciar bug de migration).
 *
 * @param {string} companyId
 * @param {number} count
 * @returns {Promise<{previous: number, current: number}>}
 */
async function setExtraSeatsForCompany(companyId, count) {
  try {
    const { rows: before } = await pool.query(
      'SELECT COALESCE(extra_seats_granted, 0) AS extra_seats_granted FROM companies WHERE id = $1',
      [companyId]
    );
    const previous = parseInt(before[0]?.extra_seats_granted, 10) || 0;
    await pool.query(
      'UPDATE companies SET extra_seats_granted = $1, updated_at = NOW() WHERE id = $2',
      [count, companyId]
    );
    _markColumnExists();
    return { previous, current: count };
  } catch (err) {
    if (err.code === '42703') {
      _markColumnMissing();
      const e = new Error('Coluna companies.extra_seats_granted ainda nao existe. Rode a migration 110 no Supabase Console antes de usar essa feature.');
      e.code = 'MIGRATION_PENDING';
      e.status = 503;
      throw e;
    }
    throw err;
  }
}

/**
 * Reseta o cache manualmente. Util pra testes; em producao o cache
 * de "ausente" ja expira em 60s automaticamente.
 */
function _resetCache() {
  _columnExistsCache = null;
  _columnMissingAt = 0;
}

module.exports = {
  getExtraSeatsMap,
  getExtraSeatsForCompany,
  setExtraSeatsForCompany,
  _resetCache,
};
