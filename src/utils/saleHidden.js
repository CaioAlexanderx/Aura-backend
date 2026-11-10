// ============================================================
// AURA. — sales.hidden_at (migration 439)
//
// Venda cancelada pode sair da lista de Vendas (exclusão LÓGICA: o
// registro fica no banco com hidden_at e hidden_by). O backend sobe ANTES
// da migration rodar, então as listagens perguntam se a coluna já existe —
// senão o 42703 derrubaria a tela de Vendas inteira.
//
// Cache module-level de 60s, mesmo padrão de utils/saleNumber.js.
// ============================================================

let _checkedAt = 0;
let _available = null;

/**
 * @param {{query: Function}} [conn]  pool ou client de transação
 * @returns {Promise<boolean>}
 */
async function hasSaleHiddenColumn(conn) {
  const db = conn || require('../config/database');
  const now = Date.now();
  if (_available !== null && (now - _checkedAt) < 60000) return _available;
  try {
    const r = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_name = 'sales' AND column_name = 'hidden_at'`
    );
    _available = parseInt((r && r.rows && r.rows[0] && r.rows[0].n) || '0', 10) === 1;
  } catch (e) {
    console.warn('[saleHidden] probe falhou:', e.message);
    _available = false;
  }
  _checkedAt = now;
  return _available;
}

/**
 * Condição pronta para somar ao WHERE da LISTA (nunca ao dos totais).
 * Devolve string vazia quando a coluna ainda não existe.
 *
 * @param {boolean} available  resultado de hasSaleHiddenColumn()
 * @param {string} [alias]     alias da tabela sales (default 's')
 */
function visibleInListCond(available, alias) {
  const a = alias || 's';
  return available ? ` AND ${a}.hidden_at IS NULL` : '';
}

// Exposto só para os testes: zera o cache entre casos.
function _resetCache() { _checkedAt = 0; _available = null; }

module.exports = { hasSaleHiddenColumn, visibleInListCond, _resetCache };
