// ============================================================
// AURA. — Crediário: JUNTAR CARNÊS (10/10/2026)
//
// Fluxo real de loja: a cliente compra várias vezes (cada compra agora é um
// carnê) e um dia a lojista parcela tudo de uma vez. Ela marca 2+ carnês em
// aberto e define as parcelas novas (número, 1º vencimento, intervalo e,
// opcionalmente, um total diferente = desconto/acréscimo, como a renegociação).
//
// Ao confirmar, os carnês marcados viram UM carnê só:
//   - nasce o carnê destino ("Compras de 13/09 e 14/09", ou o nome informado);
//   - as parcelas ABERTAS das origens saem (canceladas) e o cronograma novo
//     entra no destino;
//   - os lançamentos do razão das origens (débitos, pagamentos, estornos com
//     account_id) passam para o destino — é o débito que liga carnê a produto,
//     então os itens de todas as compras acompanham;
//   - se o total mudou, o delta vai ao razão como na renegociação (refund =
//     desconto, debit = acréscimo);
//   - as origens fecham (status 'closed' + merged_into_account_id, migration
//     369) e saem da lista da ficha: nem abertas, nem "quitadas" enganosas.
//
// O QUE JÁ FOI PAGO (decisão)
// As parcelas PAGAS das origens MIGRAM para o destino. Motivo: o resumo do
// carnê impresso (buildCarneA4Html.summarize) sai das parcelas do carnê —
// Comprou = soma das parcelas, Já pagou = Comprou - Falta. Com as pagas no
// destino: Comprou = pagas + cronograma novo, Já pagou = pagas, Falta = o
// cronograma novo. Fecha, e o que foi pago continua visível no histórico do
// carnê que a cliente leva para casa. Se ficassem na origem fechada, o carnê
// novo diria "Comprou" só o que falta e os produtos já pagos sumiriam do papel.
//
// Parcela aberta PAGA EM PARTE: a parte paga não pode evaporar (a renegociação
// zera covered_amount ao cancelar; aqui isso tiraria dinheiro do "Já pagou").
// Ela é ENCURTADA para o que já foi pago (amount_due = covered_amount,
// status 'paid') e migra; o resto entra no cronograma novo.
//
// GRUPO SEM CARNÊ ('general') COMO ORIGEM
// Compras antigas sem carnê entram como mais uma origem, com duas diferenças:
//   - só os débitos que o grupo ainda cobra migram (regra do carnê impresso:
//     do mais novo para o mais antigo até cobrir o que falta) — senão o carnê
//     novo herdaria o histórico inteiro do cliente;
//   - pagamentos SEM carnê não migram: são o recebimento livre (FIFO), que
//     abate parcela de qualquer carnê, e parcelas já pagas do grupo ficam
//     onde estão. O histórico continua na ficha.
//
// computeMergePlan é PURO (sem banco, sem relógio) e serve preview E apply:
// o que a tela mostra é o que será gravado.
// ============================================================
'use strict';

const { round2, MAX_INSTALLMENTS_CEILING } = require('./terms');
const { computeReschedulePlan, insertLedger, reduceReceivables } = require('./reschedule');
const { NO_ACCOUNT_KEY, CENT_TOLERANCE, selectDebitsForTarget } = require('./carnePurchases');
const { classifyInstallments } = require('../../utils/buildCarneA4Html');
const carneSummary = require('./carneSummary');
const carneAuto = require('./carneAuto');
const ledger = require('./ledger');
const pool = require('../../config/database');

/** Marcador do grupo sem carnê na entrada (o mesmo das rotas vizinhas). */
const GENERAL_MARKER = 'general';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mergeError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.isMergeError = true;
  if (extra) e.extra = extra;
  return e;
}

/**
 * Normaliza a lista de origens: array ou "a,b,general". Vazio/null/'none'/
 * 'general' = grupo sem carnê. Sem repetidos, ordem de chegada.
 */
function normalizeAccountIds(raw) {
  let lista = raw;
  if (typeof raw === 'string') lista = raw.split(',');
  if (!Array.isArray(lista)) return [];
  const out = [];
  for (const item of lista) {
    const s = item == null ? GENERAL_MARKER : String(item).trim();
    if (s === '') continue;
    const low = s.toLowerCase();
    const id = (low === GENERAL_MARKER || low === 'none' || low === 'null') ? GENERAL_MARKER : low;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Nome padrão do carnê destino a partir dos dias das origens.
 *   1 dia   -> "Compras de 13/09"
 *   2 dias  -> "Compras de 13/09 e 14/09"
 *   3 dias  -> "Compras de 13/09, 14/09 e 15/09"
 *   4+ dias -> "Compras de 13/09 a 20/09"
 * Com o grupo sem carnê entre as origens: sufixo " e anteriores".
 * @param {Array<{key:string, date:any}>} origins
 */
function mergedCarneName(origins) {
  const reais = (origins || []).filter(o => o && o.key !== NO_ACCOUNT_KEY);
  const temSemCarne = (origins || []).some(o => o && o.key === NO_ACCOUNT_KEY);
  const tempo = (v) => {
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const dias = [];
  for (const o of reais.slice().sort((a, b) => tempo(a.date) - tempo(b.date))) {
    const dia = carneAuto.carneDayLabel(o.date);
    if (!dias.includes(dia)) dias.push(dia);
  }
  let nome;
  if (dias.length === 0) nome = 'Compras anteriores';
  else if (dias.length === 1) nome = `Compras de ${dias[0]}`;
  else if (dias.length === 2) nome = `Compras de ${dias[0]} e ${dias[1]}`;
  else if (dias.length === 3) nome = `Compras de ${dias[0]}, ${dias[1]} e ${dias[2]}`;
  else nome = `Compras de ${dias[0]} a ${dias[dias.length - 1]}`;
  if (temSemCarne && dias.length > 0) nome += ' e anteriores';
  return nome;
}

/**
 * Motor PURO da junção.
 *
 * @param {object} args
 * @param {Array<{key:string, account_id:string|null, name:string, open_remaining:number,
 *                unscheduled:number, date:any}>} args.origins
 * @param {number|null} [args.total] total novo (null = soma das origens)
 * @param {number} args.installments
 * @param {string|null} [args.firstDueDate] 'AAAA-MM-DD'
 * @param {string} [args.periodUnit] 'day' | 'week' | 'month'
 * @param {number} [args.periodCount]
 * @param {string|null} [args.name] nome escolhido pela lojista
 * @param {string[]} [args.existingNames] nomes de carnês abertos que NÃO estão
 *        sendo juntados (para o nome não colidir)
 */
function computeMergePlan({
  origins = [], total = null, installments = 1, firstDueDate = null,
  periodUnit = 'month', periodCount = 1, name = null, existingNames = [],
} = {}) {
  const linhas = (origins || []).map(o => {
    const aberto = round2(Math.max(0, Number(o.open_remaining) || 0));
    const semParcela = round2(Math.max(0, Number(o.unscheduled) || 0));
    return {
      account_id: o.key === NO_ACCOUNT_KEY ? null : (o.account_id || o.key),
      name: o.name,
      open_remaining: aberto,
      unscheduled: semParcela,
      remaining: round2(aberto + semParcela),
    };
  });
  const base = round2(linhas.reduce((s, l) => s + l.remaining, 0));

  // Mesma distribuição da renegociação (floor por parcela, resto na última).
  const plano = computeReschedulePlan({
    openRemaining: base, total, installments, firstDueDate, periodUnit, periodCount,
  });

  const escolhido = String(name || '').trim();
  const nome = carneAuto.dedupeCarneName(escolhido || mergedCarneName(origins), existingNames);

  return {
    name: nome,
    origins: linhas,
    open_remaining: plano.open_remaining,
    target_total: plano.target_total,
    delta: plano.delta,
    installments_count: plano.installments_count,
    schedule: plano.schedule,
  };
}

/**
 * Valida as origens contra o que está no banco e devolve a entrada do motor.
 * Usado por preview e apply — as mesmas recusas nos dois.
 *
 * @param {object} ctx retorno de carneSummary.loadCarneContext
 * @param {Array|string} rawIds origens pedidas
 */
function resolveOrigins(ctx, rawIds) {
  const ids = normalizeAccountIds(rawIds);
  if (ids.length < 2) {
    throw mergeError(400, 'MERGE_NEEDS_TWO', 'Escolha pelo menos dois carnes para juntar.');
  }

  const detail = carneSummary.summarizeCarnes(ctx);
  const porId = {};
  for (const a of ctx.accounts || []) porId[String(a.id).toLowerCase()] = a;

  // Dia de cada carnê: a compra mais antiga dele (débito); sem débito, a criação.
  const primeiraCompra = {};
  for (const d of ctx.debits || []) {
    const k = d.account_id || NO_ACCOUNT_KEY;
    const t = new Date(d.created_at).getTime();
    if (Number.isFinite(t) && (primeiraCompra[k] === undefined || t < primeiraCompra[k])) primeiraCompra[k] = t;
  }

  const origins = [];
  for (const id of ids) {
    if (id === GENERAL_MARKER) {
      const d = detail[NO_ACCOUNT_KEY] || carneSummary.emptyDetail();
      origins.push({
        key: NO_ACCOUNT_KEY, account_id: null, name: 'Compras anteriores',
        open_remaining: d.open_remaining, unscheduled: d.unscheduled, date: null,
      });
      continue;
    }
    const acc = UUID_RE.test(id) ? porId[id] : null;
    // Carnê de outro cliente ou de outra empresa não está no contexto (que já
    // vem filtrado por empresa + cliente): mesmo 404, sem distinguir os casos.
    if (!acc) {
      throw mergeError(404, 'CREDIT_ACCOUNT_NOT_FOUND', 'Carne nao encontrado para este cliente.', { account_id: id });
    }
    if (acc.status !== 'open' || carneSummary.isHiddenAccount(acc)) {
      throw mergeError(409, 'CREDIT_ACCOUNT_CLOSED',
        `O carne "${acc.name}" ja foi fechado e nao pode ser juntado.`, { account_id: acc.id });
    }
    const d = detail[acc.id] || carneSummary.emptyDetail();
    origins.push({
      key: acc.id, account_id: acc.id, name: acc.name,
      open_remaining: d.open_remaining, unscheduled: d.unscheduled,
      date: primeiraCompra[acc.id] !== undefined ? new Date(primeiraCompra[acc.id]) : acc.created_at,
    });
  }

  const base = round2(origins.reduce((s, o) => s + o.open_remaining + o.unscheduled, 0));
  if (base <= CENT_TOLERANCE) {
    throw mergeError(422, 'NOTHING_OPEN', 'Os carnes escolhidos nao tem nada em aberto para juntar.');
  }

  const juntando = new Set(origins.map(o => o.key));
  const existingNames = (ctx.accounts || [])
    .filter(a => a.status === 'open' && !carneSummary.isHiddenAccount(a) && !juntando.has(a.id))
    .map(a => a.name);

  return { origins, existingNames, detail };
}

/** Valida os parâmetros do parcelamento. Lança mergeError 400. */
function validateTerms({ installments, total, firstDueDate }) {
  const n = parseInt(installments, 10);
  if (!Number.isFinite(n) || n < 1 || n > MAX_INSTALLMENTS_CEILING) {
    throw mergeError(400, 'INVALID_INSTALLMENTS', `installments deve ser entre 1 e ${MAX_INSTALLMENTS_CEILING}`);
  }
  if (total != null && (!Number.isFinite(Number(total)) || Number(total) <= 0)) {
    throw mergeError(400, 'INVALID_TOTAL', 'total invalido (deve ser maior que zero)');
  }
  if (firstDueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(firstDueDate))) {
    throw mergeError(400, 'INVALID_FIRST_DUE_DATE', 'first_due_date invalido (use AAAA-MM-DD)');
  }
  return n;
}

// merged_into_account_id / merged_at (migration 369). Sondado FORA da
// transação: um 42703 dentro dela abortaria a junção inteira. Só o "sim" fica
// em cache para sempre; o "não" vale 60 s (migration aplicada com o backend no
// ar entra sem restart).
let _mergedColOk = false;
let _mergedColCheckedAt = 0;
async function hasMergedCols() {
  if (_mergedColOk) return true;
  if (Date.now() - _mergedColCheckedAt < 60000) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'credit_accounts'
          AND column_name = 'merged_into_account_id'`
    );
    _mergedColOk = rows.length > 0;
  } catch (_) { _mergedColOk = false; }
  _mergedColCheckedAt = Date.now();
  return _mergedColOk;
}

/** Só leitura: o plano que o apply gravaria agora. */
async function previewMerge(q, { companyId, customerId, accountIds, total = null, installments, firstDueDate = null, periodUnit = 'month', periodCount = 1, name = null }) {
  const n = validateTerms({ installments, total, firstDueDate });
  const ctx = await carneSummary.loadCarneContext(q, companyId, customerId, {});
  const { origins, existingNames } = resolveOrigins(ctx, accountIds);
  return computeMergePlan({
    origins, total, installments: n, firstDueDate, periodUnit, periodCount, name, existingNames,
  });
}

/**
 * Aplica a junção. Chamar DENTRO de uma transação (client já em BEGIN).
 * Erros de validação saem como mergeError (status/code) — quem chamou faz
 * ROLLBACK e responde.
 */
async function applyMerge(client, {
  companyId, customerId, accountIds, total = null, installments,
  firstDueDate = null, periodUnit = 'month', periodCount = 1, name = null, createdBy = null,
}) {
  const n = validateTerms({ installments, total, firstDueDate });
  const comColunas = await hasMergedCols();

  // 1. Trava carnês e parcelas do cliente e valida as origens.
  const ctx = await carneSummary.loadCarneContext(client, companyId, customerId, { forUpdate: true });
  const { origins, existingNames } = resolveOrigins(ctx, accountIds);

  // 2. Plano puro (preview === apply).
  const plan = computeMergePlan({
    origins, total, installments: n, firstDueDate, periodUnit, periodCount, name, existingNames,
  });

  const originIds = origins.filter(o => o.key !== NO_ACCOUNT_KEY).map(o => o.account_id);
  const includeGeneral = origins.some(o => o.key === NO_ACCOUNT_KEY);
  const chaves = new Set(origins.map(o => o.key));

  // 3. Carnê destino.
  const { rows: destRows } = await client.query(
    `INSERT INTO credit_accounts (company_id, customer_id, name, status)
     VALUES ($1, $2, $3, 'open') RETURNING id, name`,
    [companyId, customerId, plan.name]
  );
  const dest = { id: destRows[0].id, name: destRows[0].name || plan.name };

  // 4. Parcelas das origens: abertas saem, pagas migram, paga em parte encurta.
  const cancelar = [];   // abertas sem nada pago
  const encurtar = [];   // abertas com parte paga -> viram 'paid' no destino
  const migrarPagas = []; // pagas de carnê real
  let cobertoSemCarne = 0;
  for (const inst of ctx.installments) {
    const k = inst.account_id || NO_ACCOUNT_KEY;
    if (!chaves.has(k)) continue;
    const { paid, open } = classifyInstallments([inst]);
    if (open.length) {
      const coberto = round2(Number(inst.covered_amount) || 0);
      if (coberto > CENT_TOLERANCE) {
        encurtar.push(inst.id);
        if (k === NO_ACCOUNT_KEY) cobertoSemCarne = round2(cobertoSemCarne + coberto);
      } else {
        cancelar.push(inst.id);
      }
    } else if (paid.length && k !== NO_ACCOUNT_KEY) {
      migrarPagas.push(inst.id);
    }
  }

  if (cancelar.length) {
    await client.query(
      `UPDATE credit_installments
          SET status = 'cancelled', covered_amount = 0, updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND company_id = $2`,
      [cancelar, companyId]
    );
  }
  if (encurtar.length) {
    await client.query(
      `UPDATE credit_installments
          SET amount_due = covered_amount, status = 'paid',
              paid_at = COALESCE(paid_at, updated_at, NOW()),
              account_id = $3, updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND company_id = $2`,
      [encurtar, companyId, dest.id]
    );
  }
  if (migrarPagas.length) {
    await client.query(
      `UPDATE credit_installments
          SET account_id = $3, updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND company_id = $2`,
      [migrarPagas, companyId, dest.id]
    );
  }

  // 5. Cronograma novo no destino (sale_id nulo: não é venda nova).
  const appliedIds = [];
  for (const slot of plan.schedule) {
    const { rows } = await client.query(
      `INSERT INTO credit_installments
         (company_id, sale_id, customer_id, installment_number, total_installments,
          amount_due, due_date, status, covered_amount, account_id)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', 0, $7)
       RETURNING id`,
      [companyId, customerId, slot.number, plan.installments_count, slot.amount_due, slot.due_date, dest.id]
    );
    appliedIds.push(rows[0].id);
  }

  // 6. Razão: tudo o que tinha account_id de uma origem passa ao destino.
  if (originIds.length) {
    await client.query(
      `UPDATE customer_credit_transactions
          SET account_id = $4
        WHERE company_id = $1 AND customer_id = $2 AND account_id = ANY($3::uuid[])`,
      [companyId, customerId, originIds, dest.id]
    );
  }
  let movedGeneralDebitIds = [];
  if (includeGeneral) {
    const o = origins.find(x => x.key === NO_ACCOUNT_KEY);
    const alvo = round2(o.open_remaining + o.unscheduled + cobertoSemCarne);
    const semCarne = (ctx.debits || []).filter(d => !d.account_id);
    movedGeneralDebitIds = selectDebitsForTarget(semCarne, alvo).map(d => d.id);
    if (movedGeneralDebitIds.length) {
      await client.query(
        `UPDATE customer_credit_transactions
            SET account_id = $4
          WHERE company_id = $1 AND customer_id = $2 AND id = ANY($3::uuid[])
            AND account_id IS NULL AND type = 'debit'`,
        [companyId, customerId, movedGeneralDebitIds, dest.id]
      );
    }
  }

  // 7. Total mudou -> delta no razão, igual à renegociação.
  let adjustment = null;
  if (plan.delta < -CENT_TOLERANCE) {
    const desconto = round2(-plan.delta);
    await insertLedger(client, {
      companyId, customerId, accountId: dest.id, createdBy,
      type: 'refund', amount: desconto, paymentMethod: 'crediario_ajuste',
      notes: 'Juncao de carnes - desconto no saldo',
    });
    await reduceReceivables(client, companyId, customerId, desconto);
    adjustment = { type: 'discount', amount: desconto };
  } else if (plan.delta > CENT_TOLERANCE) {
    const acrescimo = round2(plan.delta);
    await insertLedger(client, {
      companyId, customerId, accountId: dest.id, createdBy,
      type: 'debit', amount: acrescimo, paymentMethod: null,
      notes: 'Juncao de carnes - acrescimo no saldo',
    });
    adjustment = { type: 'surcharge', amount: acrescimo };
  }

  // 8. Fecha as origens, apontando para o destino.
  if (originIds.length) {
    if (comColunas) {
      await client.query(
        `UPDATE credit_accounts
            SET status = 'closed', merged_into_account_id = $3, merged_at = NOW(), updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND company_id = $2`,
        [originIds, companyId, dest.id]
      );
    } else {
      // Migration 369 pendente: sem a coluna não há como apontar o destino.
      // 'merged' (em vez de 'closed') tira a origem da ficha do mesmo jeito.
      await client.query(
        `UPDATE credit_accounts
            SET status = 'merged', updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND company_id = $2`,
        [originIds, companyId]
      );
    }
  }

  // 9. credit_used + saldo novo (a junção sem delta não muda o saldo).
  await carneAuto.withSavepoint(client, 'merge_credit_used', async () => {
    await ledger._updateCreditUsed(client, companyId, customerId);
  });
  const { rows: balRows } = await client.query(
    `SELECT balance FROM customer_credit_balances WHERE customer_id = $1 AND company_id = $2`,
    [customerId, companyId]
  );

  return {
    ...plan,
    account: dest,
    merged_account_ids: originIds,
    included_general: includeGeneral,
    cancelled_installment_ids: cancelar,
    shortened_installment_ids: encurtar,
    moved_paid_installment_ids: migrarPagas,
    applied_installment_ids: appliedIds,
    moved_general_debit_ids: movedGeneralDebitIds,
    adjustment,
    new_balance: parseFloat(balRows[0]?.balance || 0),
  };
}

module.exports = {
  GENERAL_MARKER,
  normalizeAccountIds,
  mergedCarneName,
  computeMergePlan,
  resolveOrigins,
  validateTerms,
  previewMerge,
  applyMerge,
  hasMergedCols,
};
