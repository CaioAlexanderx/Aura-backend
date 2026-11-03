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

/**
 * SQL fragment: produto visível para a empresa $cidParam.
 *
 * A REGRA ÚNICA de visibilidade de produto no grupo (BIDIRECIONAL):
 *   P visível para X se P.company_id = X
 *   OU (P.is_group_shared E group_root(P.company_id) = group_root(X)).
 *
 * Matriz vê o compartilhado da filial, filial vê o da matriz, filiais
 * irmãs se veem; empresa de fora do grupo nunca. Estoque (products.js),
 * bipe (scanner.js), venda (pdv.js) e troca (trocaV2.js) usam esta mesma
 * função: o Caixa não pode achar menos (nem mais) que o Estoque.
 *
 * Texto idêntico ao listVisibilityWhere que vivia em products.js.
 * @param {string} cidParam - placeholder do company_id de referência (ex: '$1')
 * @param {string} [prefix] - prefixo de coluna (ex: 'p.') quando a query usa alias
 */
function productVisibilityWhere(cidParam, prefix = '') {
  return `(${prefix}company_id = ${cidParam} OR (
    ${prefix}is_group_shared = true
    AND ${prefix}company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

module.exports = { companyGroupWhere, productVisibilityWhere };
