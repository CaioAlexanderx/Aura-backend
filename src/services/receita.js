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
// Hoje a fonte é fonteCompanies: empresas com billing_status='active' e os
// preços de tabela (services/billingPricing.js). Quando a leitura das
// assinaturas da Asaas existir, ela entra como outra fonte devolvendo o mesmo
// formato — calcularMrr({ fonte }) — e o job não muda.
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

async function calcularMrr({ db = pool, fonte = fonteCompanies } = {}) {
  return normalizarMrr(await fonte({ db }));
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
  contratoDeTabela,
  fonteCompanies,
  normalizarMrr,
  calcularMrr,
  gravarSnapshot,
};
