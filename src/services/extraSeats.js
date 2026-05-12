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
// e falhar de novo em cada request — uma vez detectada a ausencia,
// pula direto pro default ate o restart do process.
//
// Quando a migration for aplicada, Railway eventualmente reinicia
// (deploy novo ou restart manual) e o cache reseta — proximo
// request detecta a coluna e passa a usa-la.
// ============================================================

const pool = require('../config/database');

// Flag em memoria. null = nao testado, true = coluna existe,
// false = nao existe (cache de falha 42P01).
let _columnExistsCache = null;

/**
 * Retorna Map<companyId, extra_seats_granted_count> para a lista informada.
 * Se a coluna nao existe (pre-migration), retorna Map vazio — caller usa
 * default 0 pra cada cliente.
 *
 * @param {string[]} companyIds — array de UUIDs
 * @returns {Promise<Map<string, number>>}
 */
async function getExtraSeatsMap(companyIds) {
  if (_columnExistsCache === false) return new Map();
  if (!Array.isArray(companyIds) || companyIds.length === 0) return new Map();

  try {
    const { rows } = await pool.query(
      'SELECT id, COALESCE(extra_seats_granted, 0) AS extra_seats_granted FROM companies WHERE id = ANY($1::uuid[])',
      [companyIds]
    );
    _columnExistsCache = true;
    const map = new Map();
    for (const r of rows) {
      map.set(r.id, parseInt(r.extra_seats_granted, 10) || 0);
    }
    return map;
  } catch (err) {
    if (err.code === '42703') {
      // Coluna nao existe — migration 110 ainda nao aplicada.
      // Log uma vez (cache vira false e nao vamos mais tentar) e devolve vazio.
      console.warn('[extraSeats] companies.extra_seats_granted ainda nao existe (migration 110 pendente). Defaulting to 0.');
      _columnExistsCache = false;
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
    _columnExistsCache = true;
    return { previous, current: count };
  } catch (err) {
    if (err.code === '42703') {
      _columnExistsCache = false;
      const e = new Error('Coluna companies.extra_seats_granted ainda nao existe. Rode a migration 110 no Supabase Console antes de usar essa feature.');
      e.code = 'MIGRATION_PENDING';
      e.status = 503;
      throw e;
    }
    throw err;
  }
}

/**
 * Reseta o cache. Util pra testes; em producao reseta apenas no restart.
 */
function _resetCache() {
  _columnExistsCache = null;
}

module.exports = {
  getExtraSeatsMap,
  getExtraSeatsForCompany,
  setExtraSeatsForCompany,
  _resetCache,
};
