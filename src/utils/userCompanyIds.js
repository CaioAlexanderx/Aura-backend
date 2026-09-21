// ============================================================
// AURA. — Empresas que o usuario logado alcanca (rotas /me/*)
//
// Regra unica do modo consolidado multi-CNPJ: o usuario e DONO da
// empresa (companies.owner_id) OU membro ativo dela (company_members
// com status 'active' e is_active), e a empresa esta ativa. E a mesma
// regra do getUserCompanies de meAggregates.js e do resolveDefaultContext
// do login -- o consolidado nunca soma uma empresa que o login nao
// mostraria.
//
// 19/09/2026: /me/financeiro/comparative e /me/financeiro/insights
// liam de `company_users`, tabela que nunca existiu no banco. As duas
// rotas respondiam 500 ("relation company_users does not exist") para
// todo usuario em modo consolidado.
// ============================================================
const db = require('../config/database');

/**
 * @param {string} userId  UUID do usuario logado
 * @returns {Promise<string[]>}  IDs das empresas ativas que ele alcanca
 */
async function getUserCompanyIds(userId) {
  if (!userId) return [];
  const { rows } = await db.query(
    `SELECT DISTINCT c.id
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id
        AND cm.user_id = $1
        AND cm.status = 'active'
        AND cm.is_active = true
      WHERE (c.owner_id = $1 OR cm.user_id = $1)
        AND c.is_active = true`,
    [userId]
  );
  return rows.map((r) => r.id);
}

module.exports = { getUserCompanyIds };
