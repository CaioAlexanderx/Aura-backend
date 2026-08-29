// ============================================================
// AURA. — Helper de owner-scope (Multi-CNPJ Sessao 2 Onda 2.3)
//
// Decisao de produto (03/05/2026): clientes sao "do dono", nao da
// loja. Lista unica entre todos os CNPJs do mesmo owner.
// Vendedora membro so de Loja A ainda ve/edita/deleta clientes
// registrados em Loja B do mesmo dono.
//
// Justificativa: numa MEI/ME, nao tem separacao real entre lojas;
// e tudo o mesmo dono e os funcionarios trabalham para o dono,
// nao para uma loja especifica. Manter listas separadas por CNPJ
// gera duplicacao desnecessaria (Maria comprou em A e em B → dois
// cadastros) e atrita workflow operacional.
//
// Esta helper expande companyId → lista de empresas ativas do
// mesmo owner. Usada em customers.js (listing, count check do
// plan limit, PATCH, DELETE) e em meAggregates.js (/me/customers).
//
// 29/08/2026 (QA): a empresa PEDIDA entra sempre no resultado, mesmo
// que a query nao a devolva. Havia dois jeitos de ela sumir da propria
// lista: `owner_id IS NULL` (a subquery vira `WHERE owner_id = NULL`,
// que nao casa com nada) e `is_active` false/NULL. Nos dois casos a
// rota via ownerCompanyIds = [] e respondia 200 com
// `{ customers: [], total: 0 }` -- clientes que existem no banco,
// invisiveis na tela, sem nenhum erro pra rastrear. Como o usuario ja
// passou por requireCompanyAccess (que NAO olha is_active nem
// owner_id), ver os clientes da propria empresa nunca pode depender
// desses dois campos.
//
// SEGURANCA: ignora RBAC do user logado. Pra entrar em
// /companies/:id/customers, o user ja passou em requireCompanyAccess
// (e owner ou member ativo dessa empresa). A regra de produto e que
// isso ja basta pra ver TODA a lista do mesmo owner.
// ============================================================
const db = require('../config/database');

/**
 * Dado um companyId, retorna array de IDs de TODAS as empresas
 * ativas do mesmo owner (incluindo a propria companyId).
 *
 * Cache: nao tem cache aqui. Em testes com Davi (2 empresas) a
 * query custa <2ms (lookup por owner_id). Se virar gargalo, cache
 * por 30s em memoria seria suficiente.
 *
 * @param {string} companyId  UUID da empresa
 * @returns {Promise<string[]>}  Array de UUIDs (incluindo a propria)
 */
async function getOwnerScopedCompanyIds(companyId) {
  if (!companyId) return [];
  const { rows } = await db.query(
    `SELECT id FROM companies
     WHERE owner_id = (SELECT owner_id FROM companies WHERE id = $1)
       AND is_active = true`,
    [companyId]
  );
  const ids = rows.map(r => r.id);
  // A propria empresa nunca fica de fora da propria lista.
  if (!ids.includes(companyId)) ids.push(companyId);
  return ids;
}

module.exports = { getOwnerScopedCompanyIds };
