// ============================================================
// AURA. — Receita recorrente da Aura (13/10/2026)
//
// MRR normalizado = soma das assinaturas mensais + soma das anuais ÷ 12.
//
// A conta é feita sobre uma lista de ASSINATURAS, e quem monta a lista é uma
// "fonte" trocável:
//
//   { company_id, nome, telefone, plan, ciclo: 'monthly' | 'annual',
//     valor_contrato,   // quanto vale o ciclo inteiro (1 mês ou 12 meses)
//     meses_contrato,   // 1 ou 12
//     addons_mensal,    // acessos extras, já por mês
//     tem_cobranca }    // existe assinatura na Asaas para esta loja?
//
// Duas fontes:
//   fonteAsaas     (services/receitaAsaas.js) as assinaturas ativas na Asaas,
//                  com o valor que ela cobra de verdade. É a fonte padrão
//                  quando há ASAAS_API_KEY.
//   fonteCompanies empresas com billing_status='active' e os preços de tabela
//                  (services/billingPricing.js). É o que sobra quando a Asaas
//                  não responde — e o resultado avisa (`aviso`).
//
// calcularMrr() devolve sempre as duas somas lado a lado em `comparativo`
// ({ asaas, tabela }): é a dupla checagem da receita.
//
// Pagante sem asaas_subscription_id conta como pagante, mas o valor dele NÃO
// entra no MRR: vai para a linha "sem cobrança registrada". Somar ali era
// justamente o que fazia o método antigo dizer R$ 2.872 quando a Asaas
// recebia R$ 1.651.
// ============================================================
'use strict';

const pool = require('../config/database');
const { PLANS, getPlanValue, getSeatsValue } = require('./billingPricing');
const { getExtraSeatsMap } = require('./extraSeats');
// A regra de "não é pagante da Aura" mora em painelBlocos/_base: o MRR e os
// blocos do painel usam o mesmo fragmento SQL (card t1-11).
const { PAGA_POR_OUTRA, DOJO_SEM_ASSINATURA } = require('./painelBlocos/_base');
// 19/10/2026 (decisão do Caio): dojô não aparece nem conta na Gestão Aura,
// nem no MRR. Em 19/10 nenhum dos 116 dojôs tinha assinatura própria, então o
// MRR não muda; a regra vale para um dojô com assinatura que surja depois.
const { semDojo } = require('../utils/empresasDaGestao');
// tq-113 (26/10/2026): conta pendente (dono nunca confirmou o e-mail) sai junto.
const { semPendente } = require('../utils/contaPendente');

const PLANOS = ['essencial', 'negocio', 'expansao'];

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

// Valor de tabela de um contrato. O anual é cobrado em 12 parcelas com 2
// meses grátis: o contrato vale 12 × a parcela descontada.
function contratoDeTabela(plan, ciclo) {
  if (!PLANS[plan]) return { valor_contrato: 0, meses_contrato: ciclo === 'annual' ? 12 : 1 };
  if (ciclo === 'annual') {
    return { valor_contrato: round2(getPlanValue(plan, 'annual') * 12), meses_contrato: 12 };
  }
  return { valor_contrato: getPlanValue(plan, 'monthly'), meses_contrato: 1 };
}

// Fonte atual: o cadastro (companies) + preço de tabela.
//
// 13/10/2026 (pedido da Financeiro, validado pelo Caio): três grupos de
// empresas ativas NÃO são receita da Aura e ficam fora do MRR e da linha
// "sem cobrança registrada":
//   1. conta de teste (is_sandbox) — Aura de teste, JKA Teste e os dojôs de
//      teste da JKA;
//   2. filial cujo plano é pago por outra empresa (billing_owner_company_id
//      diferente do próprio id) — a Villa Branca, cobrada na Matriz;
//   3. dojô de federação SEM assinatura própria (federation_id diferente do
//      próprio id e asaas_subscription_id nulo) — BASSAI DAI, KANO DOJO e
//      SHOBUKAN SÃO PAULO. Dojô com assinatura própria continua no MRR.
// A empresa continua existindo e usando o produto; só deixa de contar como
// pagante contábil. Para voltar a contar uma delas, mude o cadastro (tire a
// marca de teste, dê assinatura ou tire o dono da cobrança), não este filtro.
// Os grupos 2 e 3 vêm de painelBlocos/_base (PAGA_POR_OUTRA e
// DOJO_SEM_ASSINATURA), os mesmos que tiram a empresa da contagem de
// pagantes e da adoção nos blocos do painel.
async function fonteCompanies({ db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT c.id AS company_id,
            COALESCE(c.name, c.trade_name, c.legal_name) AS nome,
            COALESCE(NULLIF(u.phone, ''), c.phone) AS telefone,
            c.plan::text AS plan,
            COALESCE(c.billing_cycle, 'monthly') AS ciclo,
            (c.asaas_subscription_id IS NOT NULL) AS tem_cobranca
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.billing_status = 'active'
        AND COALESCE(c.email, '') NOT ILIKE '%@getaura.com.br'
        AND c.is_sandbox IS NOT TRUE
        AND NOT ${PAGA_POR_OUTRA}
        AND NOT ${DOJO_SEM_ASSINATURA}
        AND ${semDojo('c')} AND ${semPendente('c')}
      ORDER BY 2`
  );
  const seats = await getExtraSeatsMap(rows.map((r) => r.company_id));
  return rows.map((r) => {
    const ciclo = r.ciclo === 'annual' ? 'annual' : 'monthly';
    return {
      company_id: r.company_id,
      nome: r.nome,
      telefone: r.telefone || null,
      plan: r.plan,
      ciclo,
      ...contratoDeTabela(r.plan, ciclo),
      addons_mensal: getSeatsValue(seats.get(r.company_id) || 0),
      tem_cobranca: !!r.tem_cobranca,
    };
  });
}

// Pura: recebe as assinaturas e devolve o MRR normalizado.
function normalizarMrr(assinaturas) {
  const porPlano = {};
  for (const p of PLANOS) porPlano[p] = { clientes: 0, mensais: 0, anuais: 0, mrr: 0 };
  const cicloMap = new Map();
  const semCobranca = { clientes: 0, mrr_potencial: 0, lojas: [] };
  const linhas = [];
  let mrrPlanos = 0;
  let mrrAddons = 0;
  let comCobranca = 0;

  for (const a of assinaturas || []) {
    const meses = a.meses_contrato > 0 ? a.meses_contrato : 1;
    const mrrPlano = round2((Number(a.valor_contrato) || 0) / meses);
    const addons = round2(a.addons_mensal);
    const linha = {
      company_id: a.company_id,
      nome: a.nome,
      telefone: a.telefone || null,
      plan: a.plan,
      ciclo: a.ciclo,
      valor_contrato: round2(a.valor_contrato),
      mrr: round2(mrrPlano + addons),
      tem_cobranca: !!a.tem_cobranca,
    };
    if (a.asaas_subscription_id) linha.asaas_subscription_id = a.asaas_subscription_id;
    linhas.push(linha);

    // Pagante conta sempre; o dinheiro só quando há cobrança registrada.
    if (porPlano[a.plan]) porPlano[a.plan].clientes += 1;
    if (!a.tem_cobranca) {
      semCobranca.clientes += 1;
      semCobranca.mrr_potencial = round2(semCobranca.mrr_potencial + linha.mrr);
      semCobranca.lojas.push(linha);
      continue;
    }

    comCobranca += 1;
    mrrPlanos = round2(mrrPlanos + mrrPlano);
    mrrAddons = round2(mrrAddons + addons);
    if (porPlano[a.plan]) {
      porPlano[a.plan].mrr = round2(porPlano[a.plan].mrr + mrrPlano);
      porPlano[a.plan][a.ciclo === 'annual' ? 'anuais' : 'mensais'] += 1;
    }
    const k = `${a.plan}|${a.ciclo}`;
    const g = cicloMap.get(k) || { plan: a.plan, ciclo: a.ciclo, clientes: 0, mrr: 0 };
    g.clientes += 1;
    g.mrr = round2(g.mrr + mrrPlano);
    cicloMap.set(k, g);
  }

  return {
    mrr_total: round2(mrrPlanos + mrrAddons),
    mrr_planos: mrrPlanos,
    mrr_addons: mrrAddons,
    pagantes: linhas.length,
    com_cobranca: comCobranca,
    por_plano: porPlano,
    por_plano_ciclo: [...cicloMap.values()].sort((x, y) => y.mrr - x.mrr),
    sem_cobranca: semCobranca,
    assinaturas: linhas,
  };
}

const ROTULO_FONTE = {
  asaas: 'Asaas (assinaturas ativas, anual ÷ 12)',
  companies: 'companies + tabela de preços (anual ÷ 12)',
};

// Uma fonte devolve a lista de assinaturas ou { assinaturas, ...extras }.
const linhasDe = (r) => (Array.isArray(r) ? r : (r && r.assinaturas) || []);

// Com `fonte` explícita, usa só ela (e não consulta mais nada). Sem, tenta a
// Asaas e cai para o cadastro; o cadastro é calculado sempre, para comparar.
async function calcularMrr({ db = pool, fonte } = {}) {
  if (fonte) return normalizarMrr(linhasDe(await fonte({ db })));

  const cadastro = await fonteCompanies({ db });
  const tabela = normalizarMrr(cadastro);
  const comparativo = {
    asaas: null,
    tabela: tabela.mrr_total,
    // tudo que o cadastro chama de pagante, com ou sem cobrança registrada
    tabela_todos_pagantes: round2(tabela.mrr_total + tabela.sem_cobranca.mrr_potencial),
  };
  const semAsaas = (aviso) => ({
    ...tabela, fonte: 'companies', fonte_rotulo: ROTULO_FONTE.companies, aviso, comparativo,
    sem_empresa: [], fora_do_mrr: [], duplicadas: [],
  });

  if (!process.env.ASAAS_API_KEY) return semAsaas(null);

  let lido;
  try {
    lido = await require('./receitaAsaas').fonteAsaas({ db, cadastro });
  } catch (err) {
    console.error('[receita] Asaas não respondeu, MRR pela tabela de preços:', err.message);
    return semAsaas(`A Asaas não respondeu (${err.message}): MRR calculado pela tabela de preços.`);
  }
  const mrr = normalizarMrr(lido.assinaturas);
  comparativo.asaas = mrr.mrr_total;
  return {
    ...mrr,
    fonte: 'asaas',
    fonte_rotulo: ROTULO_FONTE.asaas,
    aviso: null,
    comparativo,
    sem_empresa: lido.sem_empresa,
    fora_do_mrr: lido.fora_do_mrr,
    duplicadas: lido.duplicadas,
  };
}

// Grava o mês corrente (reference_month = dia 1). Só mexe em clients_* e
// mrr_*: custos, margem e notas são de quem lança.
async function gravarSnapshot({ db = pool, hoje, mrr }) {
  const p = mrr.por_plano;
  await db.query(
    `INSERT INTO aura_revenue_snapshot
       (reference_month, clients_essencial, clients_negocio, clients_expansao, clients_total,
        mrr_essencial, mrr_negocio, mrr_expansao, mrr_addons, mrr_total)
     VALUES (date_trunc('month', $1::date)::date, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (reference_month) DO UPDATE SET
       clients_essencial = EXCLUDED.clients_essencial,
       clients_negocio = EXCLUDED.clients_negocio,
       clients_expansao = EXCLUDED.clients_expansao,
       clients_total = EXCLUDED.clients_total,
       mrr_essencial = EXCLUDED.mrr_essencial,
       mrr_negocio = EXCLUDED.mrr_negocio,
       mrr_expansao = EXCLUDED.mrr_expansao,
       mrr_addons = EXCLUDED.mrr_addons,
       mrr_total = EXCLUDED.mrr_total,
       updated_at = NOW()`,
    [
      hoje,
      p.essencial.clientes, p.negocio.clientes, p.expansao.clientes, mrr.pagantes,
      p.essencial.mrr, p.negocio.mrr, p.expansao.mrr, mrr.mrr_addons, mrr.mrr_total,
    ]
  );
}

module.exports = {
  PLANOS,
  ROTULO_FONTE,
  contratoDeTabela,
  fonteCompanies,
  normalizarMrr,
  calcularMrr,
  gravarSnapshot,
};
