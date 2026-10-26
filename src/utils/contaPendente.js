// ============================================================
// AURA. — Conta pendente: quem nunca confirmou o e-mail (tq-113, 26/10/2026)
//
// Decisão do Caio (26/10/2026, opção B): a conta continua sendo criada na
// etapa 3 do cadastro, antes da confirmação do e-mail (nada muda na tela de
// cadastro nem no fluxo do tq-69). O que muda: enquanto o dono não confirma
// o e-mail, a empresa NÃO é cliente para a Aura. Ela sai das listas e
// contagens da Gestão Aura (painel, clientes, funil, métricas, receita), da
// régua de e-mails e dos jobs que miram contas em teste. Depois de 7 dias
// sem confirmar, o job services/limpezaPendentes.js desativa a empresa
// (is_active=false, nunca DELETE); se a pessoa confirmar depois, a empresa
// volta (routes/verification.js -> limpezaPendentes.reativarAoConfirmar).
//
// DEFINIÇÃO ÚNICA de "pendente" (todo lugar usa esta, em SQL ou em JS):
//   o DONO da empresa (companies.owner_id)
//     - tem users.email_verified diferente de true (false ou nulo: o login
//       trata os dois como "não confirmado");
//     - não é is_staff;
//     - não é conta interna (e-mail do dono ou da empresa @getaura.com.br);
//   e a empresa não é de demonstração/teste (companies.is_sandbox).
// Empresa sem dono (owner_id nulo) não é pendente.
//
// Para os usuários (tabela users), "pendente" é o usuário dono de pelo
// menos uma empresa pendente: membro convidado que não confirmou o e-mail
// não é dono e não entra aqui.
//
// Para voltar atrás sem reverter o PR: troque o retorno de sqlContaPendente
// por 'FALSE' (e ehContaPendente por `return false`). Todas as listas,
// contagens e e-mails voltam a incluir as contas pendentes de uma vez.
// ============================================================
'use strict';

const DOMINIO_INTERNO = '@getaura.com.br';

// Alias e coluna viram SQL: só identificadores simples entram.
const IDENT = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;
function ident(v, nome) {
  if (!IDENT.test(String(v))) throw new Error(`contaPendente: ${nome} inválido: ${v}`);
  return v;
}

/**
 * Fragmento SQL VERDADEIRO quando a empresa (alias de `companies`) está
 * pendente. Sem alias, usa o nome da tabela (`companies.owner_id`), para as
 * consultas `FROM companies` sem alias.
 *   sqlContaPendente('c') -> (c.is_sandbox IS NOT TRUE AND ... EXISTS (...))
 */
function sqlContaPendente(alias = 'companies') {
  const c = ident(alias, 'alias');
  return `(${c}.is_sandbox IS NOT TRUE`
    + ` AND lower(COALESCE(${c}.email, '')) NOT LIKE '%${DOMINIO_INTERNO}'`
    + ` AND EXISTS (SELECT 1 FROM users pend_dono`
    + ` WHERE pend_dono.id = ${c}.owner_id`
    + ` AND pend_dono.email_verified IS NOT TRUE`
    + ` AND pend_dono.is_staff IS NOT TRUE`
    + ` AND lower(COALESCE(pend_dono.email, '')) NOT LIKE '%${DOMINIO_INTERNO}'))`;
}

/** Verdadeiro para a empresa que NÃO está pendente (a que conta). */
function semPendente(alias = 'companies') {
  return `NOT ${sqlContaPendente(alias)}`;
}

/**
 * Para tabelas que só têm o company_id (vendas, produtos, clientes...):
 * verdadeiro quando a linha NÃO é de empresa pendente. Linha sem empresa
 * continua.
 */
function companyIdSemPendente(coluna) {
  return `NOT EXISTS (SELECT 1 FROM companies pend_empresa`
    + ` WHERE pend_empresa.id = ${ident(coluna, 'coluna')}`
    + ` AND ${sqlContaPendente('pend_empresa')})`;
}

/** Para `users`: verdadeiro quando o usuário é dono de empresa pendente. */
function usuarioPendente(alias = 'u') {
  const u = ident(alias, 'alias');
  return `EXISTS (SELECT 1 FROM companies pend_empresa`
    + ` WHERE pend_empresa.owner_id = ${u}.id`
    + ` AND ${sqlContaPendente('pend_empresa')})`;
}

function usuarioSemPendente(alias = 'u') {
  return `NOT ${usuarioPendente(alias)}`;
}

const interno = (email) => String(email || '').trim().toLowerCase().endsWith(DOMINIO_INTERNO);

/**
 * A mesma regra em JS, para quem já leu a linha. Campos:
 *   email_verified, is_staff, owner_email (users) e
 *   company_email, is_sandbox (companies).
 * Sem dono na linha (owner_id null e sem email_verified lido) não é pendente:
 * passe `tem_dono: false` quando a empresa não tem dono.
 */
function ehContaPendente(r) {
  if (!r || r.tem_dono === false) return false;
  if (r.is_sandbox === true) return false;
  if (r.is_staff === true) return false;
  if (interno(r.owner_email) || interno(r.company_email)) return false;
  return r.email_verified !== true;
}

module.exports = {
  DOMINIO_INTERNO,
  sqlContaPendente,
  semPendente,
  companyIdSemPendente,
  usuarioPendente,
  usuarioSemPendente,
  ehContaPendente,
};
