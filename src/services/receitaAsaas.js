// ============================================================
// AURA. — Fonte Asaas do MRR (13/10/2026)
//
// fonteAsaas() lê as assinaturas ATIVAS na Asaas e devolve as mesmas linhas
// que fonteCompanies (services/receita.js), só que com o valor que a Asaas
// cobra de verdade em vez do preço de tabela. É a dupla checagem: em 13/10 a
// tabela dizia R$ 2.872 e a Asaas cobrava cerca de R$ 1.651.
//
// Cada assinatura procura a loja dela por, nesta ordem:
//   1. companies.asaas_subscription_id = assinatura.id
//   2. companies.id = assinatura.externalReference (o checkout grava o id da
//      empresa ali — services/asaasCustomer.js, routes/billing.js)
//   3. companies.asaas_customer_id = assinatura.customer
//
// Nada some:
//   assinaturas  entram no MRR as de loja com billing_status 'active'; e os
//                pagantes do cadastro SEM assinatura ativa na Asaas entram com
//                tem_cobranca=false (linha "sem cobrança registrada").
//   sem_empresa  assinatura ativa na Asaas que não achou loja nenhuma.
//   fora_do_mrr  assinatura de loja que não é pagante hoje (trial com cartão
//                salvo, vencida, cancelada) ou de conta interna.
//   duplicadas   lojas com mais de uma assinatura ativa (as duas somam: a
//                Asaas está cobrando as duas).
//
// O valor da assinatura na Asaas já inclui os acessos extras
// (services/seatSubscription.js), por isso addons_mensal vem 0: somar de novo
// contaria duas vezes.
// ============================================================
'use strict';

const pool = require('../config/database');
const cliente = require('./asaasClient');
const { NOME, TELEFONE } = require('./painelBlocos/_base');
const { MESES_DO_CICLO, listarAssinaturasAtivas } = require('./asaasAssinaturas');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// O plano anual da Aura é cobrado em 12 parcelas mensais: na Asaas é uma
// assinatura MONTHLY. O contrato é descrito no ciclo comercial da loja
// (12 × a parcela, 12 meses) para a linha bater com contratoDeTabela; o MRR
// (valor_contrato ÷ meses_contrato) é o mesmo de qualquer jeito.
function contratoDaAssinatura(sub, cicloDaLoja) {
  const meses = MESES_DO_CICLO[sub.cycle] || 1;
  const valor = Number(sub.value) || 0;
  if (meses >= 12) return { ciclo: 'annual', valor_contrato: round2(valor), meses_contrato: meses };
  if (cicloDaLoja === 'annual') {
    return { ciclo: 'annual', valor_contrato: round2((valor / meses) * 12), meses_contrato: 12 };
  }
  return { ciclo: 'monthly', valor_contrato: round2(valor), meses_contrato: meses };
}

async function empresasDasAssinaturas(db, subs) {
  const ids = subs.map((s) => s.id).filter(Boolean);
  const clientes = [...new Set(subs.map((s) => s.customer).filter(Boolean))];
  const refs = [...new Set(subs.map((s) => s.externalReference).filter((r) => UUID.test(r || '')))];
  if (!ids.length && !clientes.length && !refs.length) return [];
  const { rows } = await db.query(
    `SELECT c.id AS company_id,
            ${NOME} AS nome,
            ${TELEFONE} AS telefone,
            c.plan::text AS plan,
            COALESCE(c.billing_cycle, 'monthly') AS ciclo,
            c.billing_status::text AS status,
            c.asaas_subscription_id,
            c.asaas_customer_id,
            COALESCE(c.is_primary, false) AS is_primary,
            (COALESCE(c.email, '') ILIKE '%@getaura.com.br') AS interna
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.asaas_subscription_id = ANY($1::text[])
         OR c.asaas_customer_id = ANY($2::text[])
         OR c.id::text = ANY($3::text[])`,
    [ids, clientes, refs]
  );
  return rows || [];
}

// `cadastro` é o resultado de fonteCompanies, quando quem chama já tem.
async function fonteAsaas({ db = pool, asaas = cliente.asaas, cadastro } = {}) {
  const subs = await listarAssinaturasAtivas(asaas);
  const empresas = await empresasDasAssinaturas(db, subs);
  const pagantes = cadastro || await require('./receita').fonteCompanies({ db });

  const porAssinatura = new Map();
  const porId = new Map();
  const porCliente = new Map();
  for (const e of empresas) {
    if (e.asaas_subscription_id) porAssinatura.set(e.asaas_subscription_id, e);
    porId.set(String(e.company_id).toLowerCase(), e);
    if (!e.asaas_customer_id) continue;
    // Grupo multi-CNPJ pode repetir o cliente: vale a principal, depois a ativa.
    const atual = porCliente.get(e.asaas_customer_id);
    const peso = (x) => (x.is_primary ? 2 : 0) + (x.status === 'active' ? 1 : 0);
    if (!atual || peso(e) > peso(atual)) porCliente.set(e.asaas_customer_id, e);
  }

  const assinaturas = [];
  const semEmpresa = [];
  const foraDoMrr = [];
  const vezes = new Map();

  for (const s of subs) {
    const e = porAssinatura.get(s.id)
      || (UUID.test(s.externalReference || '') ? porId.get(s.externalReference.toLowerCase()) : null)
      || porCliente.get(s.customer)
      || null;
    const contrato = contratoDaAssinatura(s, e ? e.ciclo : null);
    const mrr = round2(contrato.valor_contrato / contrato.meses_contrato);
    const daAsaas = {
      asaas_subscription_id: s.id,
      asaas_customer_id: s.customer || null,
      descricao: s.description || null,
      ciclo_asaas: s.cycle || null,
      valor: round2(s.value),
      mrr,
      proximo_vencimento: s.nextDueDate || null,
    };

    if (!e) { semEmpresa.push(daAsaas); continue; }
    const loja = { company_id: e.company_id, nome: e.nome, telefone: e.telefone || null };
    if (e.interna || e.status !== 'active') {
      foraDoMrr.push({ ...loja, ...daAsaas, motivo: e.interna ? 'conta interna' : `loja ${e.status}` });
      continue;
    }
    vezes.set(e.company_id, (vezes.get(e.company_id) || 0) + 1);
    assinaturas.push({
      ...loja,
      plan: e.plan,
      ...contrato,
      addons_mensal: 0,
      tem_cobranca: true,
      asaas_subscription_id: s.id,
    });
  }

  // Pagante do cadastro sem assinatura ativa na Asaas: continua contando como
  // pagante, com o valor de tabela na linha "sem cobrança registrada".
  for (const p of pagantes) {
    if (!vezes.has(p.company_id)) assinaturas.push({ ...p, tem_cobranca: false });
  }

  const duplicadas = assinaturas
    .filter((a) => a.tem_cobranca && vezes.get(a.company_id) > 1)
    .map((a) => ({ company_id: a.company_id, nome: a.nome, asaas_subscription_id: a.asaas_subscription_id }));

  return { assinaturas, sem_empresa: semEmpresa, fora_do_mrr: foraDoMrr, duplicadas };
}

module.exports = { fonteAsaas, contratoDaAssinatura };
