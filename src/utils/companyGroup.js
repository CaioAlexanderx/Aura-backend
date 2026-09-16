// ============================================================
// AURA. — Visibilidade de grupo economico (billing group), Fase 1
// fornecedores (16/09/2026)
//
// src/routes/products.js já tem essa lógica (visibilityWhere/
// listVisibilityWhere), mas SEMPRE combinada com a condição extra
// `is_group_shared = true` — produto é opt-in por linha. `suppliers`
// não tem esse opt-in (ver migration 342, decisão b): dentro do MESMO
// grupo (matriz + filiais do mesmo billing_owner_company_id), o
// fornecedor é visível pra qualquer empresa do grupo, sem flag por
// linha. Por isso este helper existe separado, em vez de reexportar o
// de products.js.
//
// group_root(empresa) = billing_owner_company_id se subsidiária,
// senão a própria empresa. Empresa standalone (sem grupo) tem
// group_root = ela mesma, então a query degrada pro caso single-company
// automaticamente.
// ============================================================
'use strict';

/**
 * SQL fragment: "<prefix>company_id IN (empresas do mesmo grupo de $cidParam)".
 * @param {string} cidParam - placeholder do company_id de referência (ex: '$1')
 * @param {string} [prefix] - prefixo de coluna (ex: 's.') quando a query usa alias
 */
function companyGroupWhere(cidParam, prefix = '') {
  return `${prefix}company_id IN (
    SELECT id FROM companies
    WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
      SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
      FROM companies WHERE id = ${cidParam}
    )
  )`;
}

module.exports = { companyGroupWhere };
