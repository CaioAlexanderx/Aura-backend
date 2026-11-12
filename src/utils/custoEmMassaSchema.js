// ============================================================
// AURA. — Preencher custos em massa: a migration 448 ja rodou?
//
// O backend sobe ANTES da migration (preDeploy), entao as rotas de
// /products/cost-fills perguntam se as tabelas existem: sem elas
// respondem 503 MIGRATION_PENDING (e o app esconde o atalho).
//
// Mesmo padrao de utils/conferenciaSchema.js: cache module-level de 60s.
// ============================================================
'use strict';

let _checkedAt = 0;
let _available = null;

/**
 * @param {{query: Function}} [conn]  pool ou client de transacao
 * @returns {Promise<boolean>}
 */
async function hasCustoEmMassaSchema(conn) {
  const db = conn || require('../config/database');
  const now = Date.now();
  if (_available !== null && (now - _checkedAt) < 60000) return _available;
  try {
    const r = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'product_cost_fills' AND column_name = 'undo_deadline')
            OR (table_name = 'product_cost_fill_items' AND column_name = 'stock_count_item_ids'))`
    );
    _available = parseInt((r && r.rows && r.rows[0] && r.rows[0].n) || '0', 10) === 2;
  } catch (e) {
    console.warn('[custoEmMassaSchema] probe falhou:', e.message);
    _available = false;
  }
  _checkedAt = now;
  return _available;
}

// Exposto so para os testes: zera o cache entre casos.
function _resetCache() { _checkedAt = 0; _available = null; }

module.exports = { hasCustoEmMassaSchema, _resetCache };
