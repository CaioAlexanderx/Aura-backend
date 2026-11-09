// ============================================================
// AURA. — "Esta pessoa ainda tem acesso a esta empresa?"
//
// Criado: 09/11/2026 (defeito: depois de 1 h a empresa escolhida volta
// sozinha para a principal ou para o consolidado).
//
// Uma checagem só, usada por quem assina um access token com uma empresa
// escolhida pela pessoa:
//   · POST /auth/switch-company (authSwitchCompany.js), que já fazia esta
//     consulta inline;
//   · POST /auth/refresh (refreshDeSessao.js), que agora mantém a empresa
//     em que a pessoa estava em vez de voltar para a padrão.
//
// Regra (a mesma de sempre do switch-company): empresa ativa e a pessoa é
// dona (owner_id) ou membro ativo (company_members status 'active' e
// is_active). Staff NÃO tem atalho aqui: is_staff só vai para o token; o
// acesso à empresa segue a mesma regra de qualquer conta.
// ============================================================
'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O id tem cara de uuid? (companies.id é uuid; outro formato dá 22P02 no Postgres) */
function pareceIdDeEmpresa(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

// $1 = company_id, $2 = user_id (a ordem de sempre do switch-company).
// Colunas: as que o switch-company devolve + as que o contexto do karatê usa
// (vertical, federation_id) + member_role no formato do resolveDefaultContext.
const SQL_EMPRESA_COM_ACESSO = `SELECT
         c.id, c.legal_name, c.trade_name, c.plan, c.cnpj,
         c.vertical_active, c.vertical, c.federation_id,
         c.is_primary, c.module_overrides,
         c.billing_status, c.trial_ends_at, c.ai_enabled, c.ai_consent_at,
         c.logo_url, c.onboarding_step, c.access_code_used, c.segment,
         c.is_sandbox,
         CASE
           WHEN c.owner_id = $2 THEN 'owner'
           ELSE cm.role_label
         END AS role,
         CASE
           WHEN c.owner_id = $2 THEN 'owner'
           ELSE COALESCE(cm.role_label, 'member')
         END AS member_role
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
       WHERE c.id = $1
         AND c.is_active = true
         AND (c.owner_id = $2 OR cm.user_id = $2)
       LIMIT 1`;

/**
 * A empresa, se a pessoa ainda tem acesso a ela; senão null.
 * Id que não é uuid = null sem ir ao banco. Erro de banco: lança (quem
 * chama decide; o /refresh responde 503, nunca troca de empresa por isso).
 *
 * @param {{ query: Function }} conn
 * @param {string} userId
 * @param {string} companyId
 * @returns {Promise<object|null>}
 */
async function buscarEmpresaComAcesso(conn, userId, companyId) {
  if (!userId || !pareceIdDeEmpresa(companyId)) return null;
  const { rows } = await conn.query(SQL_EMPRESA_COM_ACESSO, [companyId, userId]);
  return rows[0] || null;
}

module.exports = { buscarEmpresaComAcesso, pareceIdDeEmpresa, SQL_EMPRESA_COM_ACESSO };
