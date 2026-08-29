// ============================================================
// AURA. — sales.sale_number (migration 310)
//
// O numero sequencial da venda por empresa. O backend sobe ANTES da
// migration rodar (CLAUDE.md, armadilha 1), entao toda listagem que
// seleciona colunas EXPLICITAMENTE precisa perguntar se a coluna ja
// existe — senao o 42703 derruba a tela de Vendas inteira por causa de
// um campo cosmetico.
//
// Quem faz `SELECT s.*` / `RETURNING *` (POST /pdv/sale,
// GET /pdv/sale/:saleId) nao precisa de nada disto: a coluna aparece
// sozinha quando existir.
//
// Cache module-level de 60s, mesmo padrao de hasExchangeCols em
// pdv.js / employeesRanking.js.
// ============================================================

let _checkedAt = 0;
let _available = null;

/**
 * @param {{query: Function}} [conn]  pool ou client de transacao
 * @returns {Promise<boolean>}
 */
async function hasSaleNumberColumn(conn) {
  const db = conn || require('../config/database');
  const now = Date.now();
  if (_available !== null && (now - _checkedAt) < 60000) return _available;
  try {
    const r = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_name = 'sales' AND column_name = 'sale_number'`
    );
    _available = parseInt(r.rows[0]?.n || '0', 10) === 1;
  } catch (e) {
    console.warn('[saleNumber] probe falhou:', e.message);
    _available = false;
  }
  _checkedAt = now;
  return _available;
}

/**
 * Fragmento de SELECT pronto pra concatenar. Devolve NULL::int com o
 * mesmo alias quando a coluna ainda nao existe, pra forma do JSON nao
 * mudar entre deploy e migration.
 *
 * @param {boolean} available  resultado de hasSaleNumberColumn()
 * @param {string} [alias]     alias da tabela sales na query (default 's')
 */
function saleNumberSelect(available, alias) {
  const a = alias || 's';
  return available ? `${a}.sale_number` : 'NULL::int AS sale_number';
}

// Exposto so pros testes: zera o cache entre casos.
function _resetCache() { _checkedAt = 0; _available = null; }

module.exports = { hasSaleNumberColumn, saleNumberSelect, _resetCache };
