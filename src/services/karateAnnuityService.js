// ============================================================
// AURA KARATÊ — Serviço de Anuidades por Parcelas (Fase F1)
//
// Modelo: cada anuidade (dojô OU praticante) tem um header em
// karate_dojo_annuity_history (dojo_id XOR practitioner_id) e N parcelas em
// karate_annuity_installments. O header é mantido como um ROLLUP
// denormalizado (amount = soma das parcelas, status='paid' só quando TODAS
// as parcelas estão pagas, due_date = próximo vencimento em aberto) para que
// os MUITOS consumidores legados que leem karate_dojo_annuity_history.amount/
// status diretamente (relatórios de rede, financeiro, régua) continuem
// funcionando sem reescrita completa nesta fase. Toda mutação de parcela
// DEVE chamar syncAnnuityHeaderRollup() na mesma transação.
//
// Regras de negócio (canônicas):
//   Dojô: anual 1x R$500 (Mai) / semestral 2x R$280 (Mai,Nov) /
//         trimestral 4x R$150 (Fev,Mai,Ago,Nov).
//   Praticante: só faixa-preta paga; 1x R$60 (Mai) — plano 'anual' N=1.
//   Vencimento = ÚLTIMO DIA do mês de vencimento, no ano da temporada.
//   Valores/meses vêm de karate_annual_fees (NUNCA hardcode no service —
//   os únicos números fixos aqui são o fallback DEFAULT_DUE_MONTHS, usado
//   somente quando a fee vigente não tem due_months preenchido).
//   Novo filiado no meio do ano: gera só as parcelas restantes (due_date >=
//   hoje) — ver `fromDate` em buildInstallmentPlan.
//
// Vocabulário (dois níveis, propositalmente diferentes — não confundir):
//   1) Por parcela / por anuidade individual (listagens /dojos, /cpf):
//      'pending'|'paid' é o que é PERSISTIDO. Em leitura, deriva-se:
//      'due' (não venceu) | 'overdue' (<=90d) | 'defaulting' (91-180d) |
//      'suspended' (>180d) | 'paid'. Sem nenhuma parcela: 'no_charge'.
//   2) Agregado da anuidade (views karate_dojo_standing/karate_member_standing,
//      KPIs do hub): 'paid' | 'em_dia' (nenhuma parcela vencida em aberto —
//      parcela futura NÃO conta) | 'atrasado' (>=1 parcela vencida não paga) |
//      'sem_cobranca' (neutro, sem anuidade na temporada).
// ============================================================
'use strict';

const db = require('../config/database');

const VALID_PLANS = ['anual', 'semestral', 'trimestral'];

// Fallback SOMENTE quando a fee vigente não tem due_months configurado
// (deployment parcial / federação sem seed). Os valores reais de produção
// vêm de karate_annual_fees (migration 222 semeia os 3 planos de dojô +
// o plano cpf 'anual').
const DEFAULT_DUE_MONTHS = {
  anual: [5],
  semestral: [5, 11],
  trimestral: [2, 5, 8, 11],
};

const VALID_PAYMENT_METHODS = ['pix', 'dinheiro', 'transferencia', 'credito_cbkt', 'outro'];

// ── F2 do plano de anuidades: plano DO DOJÔ (Migration 226) ──────────────
// Antes desta fase, campanha/charge sempre assumiam 'anual' quando nada
// era informado — um dojô trimestral (R$600/ano) era cobrado como anual
// (R$500), sem erro nenhum. Ordem de precedência (documentada aqui porque
// karateAnnuityCampaign.js E karateAnnuities.js /charge dependem dela):
//   1) plan explícito NESTE request (override pontual/definição inline)
//   2) companies.karate_annuity_plan (o que a federação cadastrou pro dojô)
//   3) NULL — NUNCA vira 'anual' silenciosamente. Quem chama decide o que
//      fazer com null (preview marca plano_indefinido:true; campanha/batch
//      pulam o alvo para `errors[]` com reason='plano_indefinido'; /charge
//      individual devolve 422 PLANO_INDEFINIDO).
const PLANO_INDEFINIDO_REASON = 'plano_indefinido';

function resolveDojoPlan(explicitPlan, dojoStoredPlan) {
  const e = explicitPlan && VALID_PLANS.includes(explicitPlan) ? explicitPlan : null;
  if (e) return e;
  const d = dojoStoredPlan && VALID_PLANS.includes(dojoStoredPlan) ? dojoStoredPlan : null;
  return d || null;
}

// ── Helpers de data ──────────────────────────────────────────

// Último dia do mês `month` (1-12) no ano `year`, como 'YYYY-MM-DD'.
function lastDayOfMonthStr(year, month) {
  // dia 0 do mês seguinte = último dia do mês atual (UTC, sem hora).
  const d = new Date(Date.UTC(Number(year), Number(month), 0));
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const dayMs = 1000 * 60 * 60 * 24;
  return Math.round((new Date(a) - new Date(b)) / dayMs);
}

// ── Fee vigente ──────────────────────────────────────────────
// feeType: 'dojo' | 'cpf'. plan: 'anual'|'semestral'|'trimestral'|null.
async function getVigentFee(client, federationId, feeType, plan) {
  const runner = client || db;
  const { rows } = await runner.query(
    `SELECT id, amount, due_months, plan, size_tier
     FROM karate_annual_fees
     WHERE federation_id = $1 AND fee_type = $2
       AND (plan = $3 OR (plan IS NULL AND $3::text IS NULL))
       AND effective_from <= CURRENT_DATE
     ORDER BY effective_from DESC
     LIMIT 1`,
    [federationId, feeType, plan]
  );
  return rows[0] || null;
}

// ── Monta as datas/valores das parcelas de um plano ─────────
// fee: { amount, due_months } (amount = valor POR parcela, já vem assim da
// tabela de fees — ex: semestral tem amount=280, devido 2x).
// seasonYear: ano da temporada (ex: 2026).
// fromDate: se informado, pula parcelas cujo vencimento já passou (novo
// filiado no meio do ano gera só as parcelas restantes). Mantém o `seq`
// original (posição no plano completo) mesmo quando pula parcelas, para não
// perder o "parcela 3 de 4" na exibição.
function buildInstallmentPlan({ plan, amount, dueMonths, seasonYear, fromDate }) {
  const months = (Array.isArray(dueMonths) && dueMonths.length ? dueMonths : DEFAULT_DUE_MONTHS[plan] || [5])
    .slice()
    .sort((a, b) => a - b);
  const cutoff = fromDate ? new Date(fromDate) : null;
  const specs = [];
  months.forEach((m, idx) => {
    const dueDate = lastDayOfMonthStr(seasonYear, m);
    if (cutoff && new Date(dueDate + 'T23:59:59') < cutoff) return; // já venceu — não gera
    specs.push({ seq: idx + 1, amount: Number(amount), due_date: dueDate });
  });
  return specs;
}

// ── Validação do override de due_date (campanha/lote/charge individual) ──
// Formato AAAA-MM-DD, data real, e ano batendo com a temporada (year) — não
// aceita vencimento de ano diferente sem necessidade (ex.: due_date
// '2027-03-15' numa campanha year=2026 é, na prática, sempre erro de
// digitação da federação; recusamos com 422 em vez de aceitar silenciosamente).
const DUE_DATE_OVERRIDE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateDueDateOverride(dueDate, seasonYear) {
  if (dueDate === undefined || dueDate === null || String(dueDate).trim() === '') {
    return { valid: true, value: null };
  }
  if (typeof dueDate !== 'string' || !DUE_DATE_OVERRIDE_RE.test(dueDate)) {
    return { valid: false, error: 'due_date inválido — use o formato AAAA-MM-DD' };
  }
  const [y, m, d] = dueDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { valid: false, error: 'due_date inválido — data inexistente' };
  }
  if (seasonYear && y !== Number(seasonYear)) {
    return {
      valid: false,
      error: `due_date deve ser do ano da temporada (${seasonYear}) — informado ${y}`,
    };
  }
  return { valid: true, value: dueDate };
}

// ── Monta as parcelas de um alvo com os dois ajustes de vencimento
// decididos na continuação da Fase F3 (ver PR #356):
//
// 1) Default seguro quando TODAS as parcelas do plano já venceram na
//    temporada (ex.: campanha/charge rodado em julho pra plano anual que
//    vence em maio): em vez de gerar a última parcela com a data ORIGINAL
//    do plano (o que fazia a cobrança nascer já atrasada no mesmo instante
//    em que a federação a cria), gera com due_date = ÚLTIMO DIA DO MÊS
//    CORRENTE (mês de `fromDate`, ou de hoje se `fromDate` não for
//    informado) — a cobrança nasce "a vencer". `dueDateAdjusted=true`
//    sinaliza esse ajuste pra UI avisar o operador.
//
// 2) Override explícito (`dueDateOverride`, já validado por
//    validateDueDateOverride): substitui o due_date da PRIMEIRA parcela
//    gerada — única parcela em planos de 1x (anual/cpf); primeira parcela
//    em planos multi-parcela (semestral/trimestral), as demais mantêm os
//    meses do plano. `dueDateAdjusted` também fica true nesse caso (o
//    due_date final difere do natural do plano).
//
// Usado tanto pela campanha/lote (karateAnnuityCampaign.js) quanto pelo
// /charge individual (karateAnnuities.js) — MESMO motor, sem duplicar a
// lógica de data.
function buildPlanSpecs({ plan, amount, dueMonths, seasonYear, fromDate, dueDateOverride }) {
  const restantes = buildInstallmentPlan({ plan, amount, dueMonths, seasonYear, fromDate });
  let specs;
  let dueDateAdjusted = false;

  if (restantes.length) {
    specs = restantes.slice();
  } else {
    const completo = buildInstallmentPlan({ plan, amount, dueMonths, seasonYear });
    if (!completo.length) return { specs: [], dueDateAdjusted: false };
    const today = fromDate ? new Date(fromDate) : new Date();
    const safeDueDate = lastDayOfMonthStr(today.getUTCFullYear(), today.getUTCMonth() + 1);
    const last = completo[completo.length - 1];
    specs = [{ ...last, due_date: safeDueDate }];
    dueDateAdjusted = true;
  }

  if (dueDateOverride) {
    const first = specs[0];
    if (first.due_date !== dueDateOverride) dueDateAdjusted = true;
    specs = specs.slice();
    specs[0] = { ...first, due_date: dueDateOverride };
  }

  return { specs, dueDateAdjusted };
}

// ── Cria as linhas de parcela para um header já existente ───
async function createInstallmentsForAnnuity(client, { annuityId, federationId, specs }) {
  const inserted = [];
  for (const s of specs) {
    const { rows } = await client.query(
      `INSERT INTO karate_annuity_installments
         (annuity_id, federation_id, seq, amount, due_date, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (annuity_id, seq) DO NOTHING
       RETURNING *`,
      [annuityId, federationId, s.seq, s.amount, s.due_date]
    );
    if (rows.length) inserted.push(rows[0]);
  }
  return inserted;
}

// ── Cria (ou reaproveita, via idempotency_key) a transaction financeira de
// cada parcela e amarra installment.transaction_id a ela. Extraído de
// karateAnnuities.js (charge dojô/CPF) na Fase F3 para ser reusado também
// pela campanha/lote (karateAnnuityCampaign.js) — MESMO motor de geração,
// sem duplicar a lógica de criação de transaction+idempotency_key.
async function createTransactionsForInstallments(client, {
  federationId, kind, refId, refName, referencePeriod, installments,
}) {
  const category = categoryForKind(kind);
  const referenceType = kind === 'cpf' ? 'customer' : 'karate_dojo';
  for (const inst of installments) {
    const idempotencyKey = transactionIdempotencyKey(inst.annuity_id, inst.seq);
    const label = installments.length > 1 ? ` (${inst.seq}/${installments.length})` : '';
    const txRes = await client.query(
      `INSERT INTO transactions
         (company_id, type, category, amount, status, due_date,
          description, idempotency_key, reference_type, reference_id,
          federation_id, created_at, updated_at)
       VALUES ($1, 'income', $2, $3, 'pending', $4,
               $5, $6, $7, $8,
               $9, NOW(), NOW())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        federationId, category, inst.amount, inst.due_date,
        `Anuidade ${kind === 'cpf' ? '' : 'dojô '}${refName} — ${referencePeriod}${label}`,
        idempotencyKey, referenceType, refId, federationId,
      ]
    );
    let txId = txRes.rows[0]?.id;
    if (!txId) {
      const ex = await client.query(`SELECT id FROM transactions WHERE idempotency_key = $1`, [idempotencyKey]);
      txId = ex.rows[0]?.id;
    }
    await client.query(`UPDATE karate_annuity_installments SET transaction_id = $1 WHERE id = $2`, [txId, inst.id]);
    inst.transaction_id = txId;
  }
  return installments;
}

async function getInstallments(client, annuityId) {
  const runner = client || db;
  const { rows } = await runner.query(
    `SELECT * FROM karate_annuity_installments WHERE annuity_id = $1 ORDER BY seq ASC`,
    [annuityId]
  );
  return rows;
}

// ── Status derivado por parcela (leitura, nunca persistido) ─
function deriveInstallmentStatus(installment) {
  if (!installment) return 'no_charge';
  if (installment.status === 'paid') return 'paid';
  if (!installment.due_date) return 'due';
  const daysUntilDue = daysBetween(installment.due_date, new Date());
  if (daysUntilDue > 0) return 'due';
  const daysOverdue = Math.abs(daysUntilDue);
  if (daysOverdue <= 90) return 'overdue';
  if (daysOverdue <= 180) return 'defaulting';
  return 'suspended';
}

// ── Status da anuidade p/ listagens (/dojos, /cpf) — mantém o vocabulário
// legado (paid|due|overdue|defaulting|suspended|no_charge) que o front já
// consome, agora computado sobre as parcelas.
function computeAnnuityListStatus(installments) {
  if (!installments || !installments.length) return 'no_charge';
  const allPaid = installments.every((i) => i.status === 'paid');
  if (allPaid) return 'paid';
  const order = { suspended: 0, defaulting: 1, overdue: 2, due: 3 };
  const worst = installments
    .filter((i) => i.status !== 'paid')
    .map((i) => deriveInstallmentStatus(i))
    .sort((a, b) => order[a] - order[b])[0];
  return worst || 'due';
}

// ── Agregado (views/KPIs do hub) — paid|em_dia|atrasado|sem_cobranca.
// Parcela futura NUNCA torna ninguém atrasado.
function computeAggregateFinanceiro(installments) {
  if (!installments || !installments.length) return 'sem_cobranca';
  const allPaid = installments.every((i) => i.status === 'paid');
  if (allPaid) return 'paid';
  const now = new Date();
  const hasOverdueOpen = installments.some(
    (i) => i.status !== 'paid' && i.due_date && new Date(i.due_date) <= now
  );
  return hasOverdueOpen ? 'atrasado' : 'em_dia';
}

function computeTotals(installments) {
  const total = (installments || []).reduce((s, i) => s + Number(i.amount), 0);
  const paidTotal = (installments || [])
    .filter((i) => i.status === 'paid')
    .reduce((s, i) => s + Number(i.amount), 0);
  return {
    total: Number(total.toFixed(2)),
    paid_total: Number(paidTotal.toFixed(2)),
  };
}

// ── Mantém o header (karate_dojo_annuity_history) sincronizado como rollup
// das parcelas — amount=soma, status='paid' só quando tudo pago, due_date =
// próximo vencimento em aberto. Chamar SEMPRE após criar/pagar/editar/void
// de parcela, na MESMA transação (client).
async function syncAnnuityHeaderRollup(client, annuityId) {
  const installments = await getInstallments(client, annuityId);
  if (!installments.length) return null;

  const { total } = computeTotals(installments);
  const allPaid = installments.every((i) => i.status === 'paid');
  const unpaid = installments.filter((i) => i.status !== 'paid');

  let nextDueDate = null;
  if (unpaid.length) {
    nextDueDate = unpaid.reduce((earliest, i) => {
      if (!i.due_date) return earliest;
      if (!earliest) return i.due_date;
      return new Date(i.due_date) < new Date(earliest) ? i.due_date : earliest;
    }, null);
  } else {
    nextDueDate = installments[installments.length - 1].due_date;
  }

  let paidAt = null;
  let lastPaymentMethod = null;
  let lastTransactionId = null;
  if (allPaid) {
    const paidSorted = installments
      .filter((i) => i.paid_at)
      .sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at));
    paidAt = paidSorted[0]?.paid_at || null;
    lastPaymentMethod = paidSorted[0]?.payment_method || null;
    lastTransactionId = paidSorted[0]?.transaction_id || installments[installments.length - 1].transaction_id;
  } else {
    // Aponta para a próxima parcela em aberto (o que a UI legada mais precisa).
    const next = unpaid.reduce((earliest, i) => {
      if (!earliest) return i;
      if (!i.due_date) return earliest;
      if (!earliest.due_date) return i;
      return new Date(i.due_date) < new Date(earliest.due_date) ? i : earliest;
    }, null);
    lastTransactionId = next?.transaction_id || null;
  }

  const { rows } = await client.query(
    `UPDATE karate_dojo_annuity_history
        SET amount = $1,
            status = $2,
            due_date = $3,
            paid_at = $4,
            payment_method = COALESCE($5, payment_method),
            transaction_id = COALESCE($6, transaction_id),
            updated_at = NOW()
      WHERE id = $7
      RETURNING *`,
    [total, allPaid ? 'paid' : 'pending', nextDueDate, paidAt, lastPaymentMethod, lastTransactionId, annuityId]
  );
  return rows[0] || null;
}

function transactionIdempotencyKey(annuityId, seq) {
  return `annuity-${annuityId}-p${seq}`;
}

function categoryForKind(kind) {
  return kind === 'cpf' ? 'annuity_cpf' : 'annuity_dojo';
}

module.exports = {
  VALID_PLANS,
  PLANO_INDEFINIDO_REASON,
  resolveDojoPlan,
  createTransactionsForInstallments,
  DEFAULT_DUE_MONTHS,
  VALID_PAYMENT_METHODS,
  lastDayOfMonthStr,
  getVigentFee,
  buildInstallmentPlan,
  buildPlanSpecs,
  validateDueDateOverride,
  createInstallmentsForAnnuity,
  getInstallments,
  deriveInstallmentStatus,
  computeAnnuityListStatus,
  computeAggregateFinanceiro,
  computeTotals,
  syncAnnuityHeaderRollup,
  transactionIdempotencyKey,
  categoryForKind,
};
