// ============================================================
// AURA. — Quais empresas a Gestão Aura enxerga (19/10/2026)
//
// Decisão do Caio (19/10/2026): "Eu não quero visualizar esses dojôs, eles
// são dados exclusivamente da federação". Dojô (companies.vertical =
// 'karate_dojo') é conta que a federação cria para os seus filiados: não é
// cliente da Aura. Em 19/10 eram 116 das 171 empresas e enchiam a lista de
// clientes, o painel "Hoje", o funil de teste, a conversão, as contagens, os
// alertas e as métricas. A federação (vertical 'karate_federation') é cliente
// pagante e continua aparecendo normalmente.
//
// Regra: o filtro é pelo TIPO de conta (vertical), nunca por nome de
// federação ou de dojô. `IS DISTINCT FROM` mantém as empresas sem vertical
// (vertical NULL = varejo, a maioria).
//
// Onde vale: listas, contagens, funis, alertas e métricas das rotas /admin/*
// e do painel diário. Onde NÃO vale:
//   - rota que pede UMA empresa pelo id (/admin/clients/:cid/..., ficha do
//     painel, /admin/clients/:cid/karate): suporte continua abrindo um dojô
//     pelo id quando precisar;
//   - o produto do Karatê (painel da federação, do dojô, cobranças do dojô)
//     não usa este arquivo;
//   - nada é apagado nem alterado no banco: o dojô só deixa de ser listado e
//     contado aqui.
// Para voltar a mostrar os dojôs, troque o fragmento abaixo por 'TRUE'.
// ============================================================
'use strict';

const VERTICAL_DOJO = 'karate_dojo';

// Alias e coluna viram SQL: só identificadores simples entram.
const IDENT = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;
function ident(v, nome) {
  if (!IDENT.test(String(v))) throw new Error(`empresasDaGestao: ${nome} inválido: ${v}`);
  return v;
}

// Fragmento para uma consulta em `companies`: verdadeiro para a empresa que a
// Gestão Aura mostra e conta. semDojo('c') → c.vertical IS DISTINCT FROM ...
function semDojo(alias = null) {
  const col = alias ? `${ident(alias, 'alias')}.vertical` : 'vertical';
  return `${col} IS DISTINCT FROM '${VERTICAL_DOJO}'`;
}

// Para tabelas que só têm o company_id (vendas, produtos, clientes...):
// verdadeiro quando a linha NÃO é de um dojô. Linha sem empresa continua.
function companyIdSemDojo(coluna) {
  return `NOT EXISTS (SELECT 1 FROM companies dojo_gestao
                       WHERE dojo_gestao.id = ${ident(coluna, 'coluna')}
                         AND dojo_gestao.vertical = '${VERTICAL_DOJO}')`;
}

// Para `users`: fica de fora só quem é dono APENAS de dojô (o dono de um
// dojô que também tem uma loja continua contando como cadastro).
function usuarioSemDojo(alias = 'u') {
  const u = ident(alias, 'alias');
  return `NOT (EXISTS (SELECT 1 FROM companies dojo_gestao
                        WHERE dojo_gestao.owner_id = ${u}.id
                          AND dojo_gestao.vertical = '${VERTICAL_DOJO}')
           AND NOT EXISTS (SELECT 1 FROM companies loja_gestao
                            WHERE loja_gestao.owner_id = ${u}.id
                              AND loja_gestao.vertical IS DISTINCT FROM '${VERTICAL_DOJO}'))`;
}

module.exports = { VERTICAL_DOJO, semDojo, companyIdSemDojo, usuarioSemDojo };
