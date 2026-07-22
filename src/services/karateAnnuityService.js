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

// ── F2 da reforma da anuidade: taxa de ADESÃO (filiação) ─────────────────
// Cobrança ÚNICA, além da anuidade proporcional, quando a federação marca
// (seletor persistente, companies.karate_charges_adhesion — Migration 248)
// que o dojô paga adesão no cadastro ou na reativação. Valor em constante
// nomeada (nunca número solto no meio da rota) — ver buildAdhesionSpec().
const ADESAO_FEE_BRL = 195;

// Fallback SOMENTE quando a fee vigente não tem due_months configurado
// (deployment parcial / federação sem seed). Os valores reais de produção
// vêm de karate_annual_fees (migration 222 semeia os 3 planos de dojô +
// o plano cpf 'anual').
const DEFAULT_DUE_MONTHS = {
  anual: [5],
  semestral: [5, 11],
  trimestral: [2, 5, 8, 11],
};

const VALID_PAYMENT_METHODS = ['pix', 'dinheiro', 'transferencia', 'credito_cbkt', 'credito_exame', 'outro'];

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

// Evita acúmulo de lixo de ponto flutuante em soma/divisão de dinheiro
// (CLAUDE.md: numeric vem como string do pg, nunca acumular float solto).
// Mesmo helper/mesma técnica de karateAnnuityLedger.round2 — não importa
// de lá para não criar dependência cruzada entre o motor de GERAÇÃO
// (este arquivo) e o motor de BAIXA (karateAnnuityLedger.js).
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Extrai {year, month, day} de uma data PURA 'YYYY-MM-DD' — aceita tanto
// string quanto o objeto Date que o pg devolve para colunas `date`
// (armadilha CLAUDE.md #1: pg devolve `date` como Date; NUNCA usar
// `new Date(iso)` para reinterpretar essa string, isso volta um dia no
// fuso BR — aqui não fazemos nem uma coisa nem outra, só regex sobre os
// componentes já corretos que o pg/ISO já trazem). companies.affiliation_since
// vem como Date à meia-noite UTC (coluna `date`) — .toISOString() nela é
// seguro (não é reinterpretação de fuso, é o mesmo objeto já correto).
function parseDateParts(value) {
  if (!value) return null;
  const s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), iso: s };
}

// ── F2 — proporcional por mês restante ────────────────────────────────
// Decisão fechada com o Caio: dojô que se filia durante o ano paga
// anuidade = taxa_anual ÷ 12 × meses_restantes_até_dezembro, com o MÊS DE
// INGRESSO CONTANDO CHEIO. remainingMonths = 13 - mês (jan=1 -> 12 meses
// cheios; jul=7 -> 6; dez=12 -> 1).
function remainingMonthsFromAffiliation(affiliationMonth) {
  const month = Number(affiliationMonth);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`affiliationMonth inválido: ${affiliationMonth} (esperado inteiro 1-12)`);
  }
  return 13 - month;
}

// annualAmount: valor ANUAL cheio do plano (para dojô: fee.amount × nº de
// parcelas do plano completo — ver buildProportionalPlanSpecs; cada plano
// [anual/semestral/trimestral] tem seu próprio total anual, não é o mesmo
// número para os três). `year` é aceito no shape pedido pelo produto para
// deixar explícito de qual temporada a filiação faz parte, mas o cálculo em
// si depende só do MÊS (a regra "mês de ingresso conta cheio" é a mesma
// independente do ano da temporada).
// Arredondamento: tudo em CENTAVOS inteiros (Math.round em cada etapa) —
// nunca acumula fração de centavo em float solto. Arredonda só o resultado
// final para R$ (division by 100), nunca arredonda em etapas intermediárias.
function computeProportionalAnnuity({ annualAmount, affiliationMonth, year }) { // eslint-disable-line no-unused-vars
  const remainingMonths = remainingMonthsFromAffiliation(affiliationMonth);
  const annualCents = Math.round(round2(annualAmount) * 100);
  const proportionalCents = Math.round((annualCents * remainingMonths) / 12);
  return round2(proportionalCents / 100);
}

// ── Distribui `totalAmount` em `count` parcelas iguais, SEM perder/sobrar
// centavo (soma das parcelas geradas === totalAmount sempre). Todas as
// parcelas recebem o mesmo valor base (totalCents/count, arredondado para
// baixo); a ÚLTIMA parcela absorve o resto em centavos — único lugar a
// checar numa auditoria ("por que a última parcela é 1 centavo maior"),
// em vez de espalhar o resto entre parcelas aleatórias.
function distributeAmountAcrossInstallments(totalAmount, count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`count inválido em distributeAmountAcrossInstallments: ${count}`);
  }
  const totalCents = Math.round(round2(totalAmount) * 100);
  const baseCents = Math.floor(totalCents / n);
  const amounts = new Array(n).fill(baseCents);
  amounts[n - 1] = totalCents - baseCents * (n - 1); // resto vai pra última
  return amounts.map((c) => round2(c / 100));
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

// ── F2 — plano de parcelas PROPORCIONAL (dojô filiado durante o ano) ────
// Regra fechada com o Caio: quando o dojô se filiou NA temporada corrente
// (affiliationMonth/seasonYear resolvidos por quem chama a partir de
// companies.affiliation_since), CONSOLIDAMOS — calculamos o valor
// proporcional sobre o TOTAL ANUAL do plano (fee.amount × nº de parcelas
// do plano CHEIO, não confundir com o plano 'anual' de 1 parcela: um dojô
// trimestral tem seu próprio total anual = amount×4) e distribuímos esse
// total proporcional IGUALMENTE pelas parcelas do plano cujo vencimento
// ainda não passou NA DATA DE FILIAÇÃO (mesmo mês usado na fração — um só
// "relógio" para fração e corte de parcelas, decisão deliberada: evita
// dois critérios de data diferentes no mesmo cálculo, o que dificultaria
// auditoria). NÃO proporcionaliza cada parcela isoladamente (rejeitado:
// abriria espaço para a soma das parcelas divergir do total proporcional
// por causa de arredondamento em cada parcela separada).
//
// O que acontece com uma parcela cujo mês de vencimento já passou no
// momento da filiação: ela é PULADA (não é gerada) — mas o valor dela NÃO
// se perde. Como dividimos o TOTAL proporcional (já calculado sobre os
// meses restantes a partir do mês de filiação) pelo Nº de parcelas que
// sobraram (não pelo Nº de parcelas do plano completo), o valor da parcela
// pulada é absorvido igualmente pelas parcelas restantes. Essa é a opção
// mais simples de auditar: em qualquer momento, SOMA(parcelas geradas) ===
// valor proporcional total — uma única igualdade para conferir, sem
// precisar reconstruir "quanto teria sido cada parcela antes do corte".
//
// Caso-limite (plano inteiro já vencido na data de filiação — ex.: dojô
// trimestral [Fev,Mai,Ago,Nov] que se filia em Dezembro): mesmo default
// seguro do F3/buildPlanSpecs — gera 1 parcela única, due_date = último
// dia do MÊS DE FILIAÇÃO, carregando o total proporcional inteiro (que já
// é pequeno nesse caso: 1/12 do anual, dezembro só tem 1 mês restante).
function buildProportionalPlanSpecs({ plan, feeAmount, dueMonths, seasonYear, affiliationMonth, dueDateOverride }) {
  const fullPlan = buildInstallmentPlan({ plan, amount: feeAmount, dueMonths, seasonYear });
  if (!fullPlan.length) return { specs: [], dueDateAdjusted: false, proportionalTotal: 0, fullTotal: 0, remainingMonths: 0 };

  const fullTotal = round2(fullPlan.reduce((s, p) => s + Number(p.amount), 0));
  const proportionalTotal = computeProportionalAnnuity({ annualAmount: fullTotal, affiliationMonth, year: seasonYear });
  const remainingMonths = remainingMonthsFromAffiliation(affiliationMonth);

  // Corte de sobrevivência: mesmo mês de referência da fração (mês de
  // filiação) — NÃO "hoje" (esse é o corte usado por buildPlanSpecs para o
  // caso não-proporcional; aqui usamos o mês de filiação para os dois
  // cálculos ficarem no mesmo "relógio", ver comentário acima).
  const cutoff = new Date(Date.UTC(Number(seasonYear), Number(affiliationMonth) - 1, 1));
  let surviving = fullPlan.filter((p) => new Date(p.due_date + 'T23:59:59Z') >= cutoff);

  let dueDateAdjusted = false;
  if (!surviving.length) {
    const last = fullPlan[fullPlan.length - 1];
    surviving = [{ ...last, due_date: lastDayOfMonthStr(seasonYear, affiliationMonth) }];
    dueDateAdjusted = true;
  }

  const amounts = distributeAmountAcrossInstallments(proportionalTotal, surviving.length);
  let specs = surviving.map((s, idx) => ({ seq: s.seq, amount: amounts[idx], due_date: s.due_date }));

  if (dueDateOverride) {
    const first = specs[0];
    if (first.due_date !== dueDateOverride) dueDateAdjusted = true;
    specs = specs.slice();
    specs[0] = { ...first, due_date: dueDateOverride };
  }

  return { specs, dueDateAdjusted, proportionalTotal, fullTotal, remainingMonths };
}

// ── F2 — parcela de ADESÃO (kind='filiacao') ─────────────────────────────
// Pura (sem DB) — quem chama já resolveu `alreadyHasAdhesionInstallment`
// via query (guarda de unicidade, ver comentário na rota /charge: nunca
// duas parcelas 'filiacao' abertas para o mesmo dojô — reativar um dojô
// que já tem parcela de adesão (paga ou não) NÃO duplica). `dueDate` =
// data de filiação (affiliationSince); se o dojô não tem affiliation_since
// cadastrado, quem chama passa `fallbackDueDate` (data do lançamento).
function buildAdhesionSpec({ chargesAdhesion, alreadyHasAdhesionInstallment, affiliationSince, fallbackDueDate }) {
  if (!chargesAdhesion || alreadyHasAdhesionInstallment) return null;
  const dueDate = affiliationSince || fallbackDueDate;
  return { seq: 0, amount: ADESAO_FEE_BRL, due_date: dueDate, kind: 'filiacao' };
}

// ── Cria as linhas de parcela para um header já existente ───
// `s.kind` opcional por spec (default 'anuidade', mesmo default da coluna
// — migration 247). Specs de adesão (buildAdhesionSpec) trazem
// kind:'filiacao' explícito.
async function createInstallmentsForAnnuity(client, { annuityId, federationId, specs }) {
  const inserted = [];
  for (const s of specs) {
    const { rows } = await client.query(
      `INSERT INTO karate_annuity_installments
         (annuity_id, federation_id, seq, amount, due_date, status, kind)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       ON CONFLICT (annuity_id, seq) DO NOTHING
       RETURNING *`,
      [annuityId, federationId, s.seq, s.amount, s.due_date, s.kind || 'anuidade']
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
  // F2: parcela de adesão (kind='filiacao') é avulsa — não entra na
  // numeração "(seq/N)" das parcelas de anuidade nem herda a descrição
  // "Anuidade ..." (evita confundir a taxa de adesão com uma parcela da
  // anuidade no extrato financeiro). category/reference_type continuam os
  // mesmos da anuidade (annuity_dojo/karate_dojo) — F2 não introduz uma
  // categoria nova em `transactions`; a distinção fica no
  // karate_annuity_installments.kind, fonte de verdade auditável.
  const annuityCount = installments.filter((i) => i.kind !== 'filiacao').length;
  for (const inst of installments) {
    const idempotencyKey = transactionIdempotencyKey(inst.annuity_id, inst.seq);
    const isAdhesion = inst.kind === 'filiacao';
    const label = !isAdhesion && annuityCount > 1 ? ` (${inst.seq}/${annuityCount})` : '';
    const description = isAdhesion
      ? `Taxa de adesão ${kind === 'cpf' ? '' : 'dojô '}${refName}`
      : `Anuidade ${kind === 'cpf' ? '' : 'dojô '}${refName} — ${referencePeriod}${label}`;
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
        description,
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

// F3 da reforma da anuidade: paid_total somava só parcelas status='paid'
// pelo valor CHEIO — binário, pré-amount_paid (migration 247). Com baixa
// parcial (applyAnnuityPayment, status='partial'), isso subestimava o
// valor recebido (uma parcela de R$500 com R$300 pagos contava R$0).
// Agora soma amount_paid de TODAS as parcelas (paga, parcial ou pendente
// — pendente contribui 0 naturalmente). `i.amount_paid` pode vir ausente
// (undefined) se o caller não SELECTou a coluna (ou migration 247 ainda
// não aplicada) — nesse caso cai pro binário antigo como fallback seguro,
// nunca lança.
function computeTotals(installments) {
  const total = (installments || []).reduce((s, i) => s + Number(i.amount), 0);
  const paidTotal = (installments || [])
    .reduce((s, i) => {
      const amountPaid = i.amount_paid != null ? Number(i.amount_paid) : (i.status === 'paid' ? Number(i.amount) : 0);
      return s + amountPaid;
    }, 0);
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

// ── dojo_status (filtro de ativo/inativo do DOJÔ) ──────────────────────
// Decisão de produto (Caio, 21/07/2026): "nao temos acao, nao podemos
// cobrar e controlar os inativos. Logo, precisamos sempre ter essa visao
// segmentada [...] o mesmo para indicadores e numeros absolutos, sempre
// ativos primeiro." Compartilhado aqui entre GET /annuities/dojos
// (karateAnnuities.js) e GET /annuities/summary (karateAnnuitySummary.js)
// para garantir que lista e KPIs usem SEMPRE o mesmo criterio -- se
// divergirem, o topo do hub mostra um numero e a lista mostra outro (bug
// ja visto neste produto). NAO confundir com `customers.is_active`
// (praticante) -- este filtro e sobre `companies.is_active` (dojo).
//
// Valores aceitos: 'active' (default) | 'inactive' | 'all'.
const DOJO_STATUS_VALUES = ['active', 'inactive', 'all'];

// Faz o parse do query param `dojo_status`. Retorna null se o valor
// informado for invalido (caller decide como reportar -- normalmente 422).
// String vazia/ausente => default 'active'.
function parseDojoStatus(raw) {
  const v = (raw !== undefined && raw !== null && String(raw).trim() !== '')
    ? String(raw).trim()
    : 'active';
  return DOJO_STATUS_VALUES.includes(v) ? v : null;
}

// Converte o valor ja parseado de dojo_status no array usado no SQL
// (`c.is_active = ANY($N::boolean[])`, ou NULL pra "sem filtro" = 'all').
function dojoStatusToIsActiveValues(dojoStatus) {
  if (dojoStatus === 'all') return null;
  if (dojoStatus === 'inactive') return [false];
  return [true]; // 'active' (default)
}

module.exports = {
  VALID_PLANS,
  PLANO_INDEFINIDO_REASON,
  ADESAO_FEE_BRL,
  resolveDojoPlan,
  createTransactionsForInstallments,
  DEFAULT_DUE_MONTHS,
  VALID_PAYMENT_METHODS,
  lastDayOfMonthStr,
  getVigentFee,
  buildInstallmentPlan,
  buildPlanSpecs,
  buildProportionalPlanSpecs,
  buildAdhesionSpec,
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
  round2,
  parseDateParts,
  remainingMonthsFromAffiliation,
  computeProportionalAnnuity,
  distributeAmountAcrossInstallments,
  DOJO_STATUS_VALUES,
  parseDojoStatus,
  dojoStatusToIsActiveValues,
};
