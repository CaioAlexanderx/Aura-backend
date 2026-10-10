// ============================================================
// AURA. — Crediário: resumo por carnê (10/10/2026)
//
// A ficha passa a mostrar um cartão por carnê: o que foi comprado, quanto
// falta, "N de M pagas", parcelas pagas. E "Juntar carnês" precisa saber
// quanto cada carnê ainda deve. As duas coisas saem daqui, da MESMA conta —
// o que a ficha mostra como "falta" é o que a junção soma.
//
// POR QUE NÃO O SALDO DO RAZÃO POR CARNÊ
// O recebimento livre (FIFO por vencimento, sem carnê) é o uso dominante:
// 1.710 pagamentos, só 182 com carnê. O pagamento livre fica no razão com
// account_id NULO e abate parcelas de qualquer carnê. Então "débitos do carnê
// - pagamentos do carnê" não diz quanto falta: o débito fica inteiro no carnê
// e o pagamento, fora. Quem sabe quanto falta de cada carnê são as PARCELAS
// (amount_due - covered_amount), que o FIFO mantém.
//
//   falta do carnê = resto das parcelas abertas + saldo sem parcela dele
//
// SALDO SEM PARCELA
// Venda 1x no Caixa (fiado, sem data combinada) não gera parcela — só o
// débito (ledger.js, gate de 17/08/2026). O que o cliente deve "sem parcela"
// só existe no nível do CLIENTE: saldo do razão - resto de todas as parcelas
// abertas (reschedule.getUnscheduledBalance, base do "Parcelar saldo").
// Para repartir esse valor entre os carnês:
//   - só concorre carnê que NUNCA teve parcela viva (fiado puro) e o grupo
//     sem carnê;
//   - do mais NOVO para o mais antigo, cada um leva até o próprio débito
//     (menos devoluções) — o FIFO quita primeiro o que é mais antigo, então o
//     que ainda se deve é o mais recente;
//   - o grupo sem carnê fica com o que sobrar, limitado aos débitos dele.
// É uma repartição, não um lançamento: nada é gravado. A soma das fatias
// nunca passa do saldo sem parcela do cliente.
//
// Funções puras (sem banco, sem relógio) + um carregador tolerante a schema.
// ============================================================
'use strict';

const { round2 } = require('./terms');
const { classifyInstallments } = require('../../utils/buildCarneA4Html');
const {
  NO_ACCOUNT_KEY, CENT_TOLERANCE, groupKey, groupTarget,
  selectDebitsForTarget, buildPurchaseLines,
} = require('./carnePurchases');
const overdueRule = require('./overdue');

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function timeOf(v) {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Carnê que não entra na lista da ficha: cancelado (ficou vazio) ou juntado em outro. */
function isHiddenAccount(acc) {
  return !!acc && (acc.status === 'cancelled' || acc.status === 'merged' || !!acc.merged_into_account_id);
}

function emptyDetail() {
  return {
    purchases: [],
    purchases_total: 0,
    total_amount: 0,
    refunded_total: 0,
    total_count: 0,
    paid_count: 0,
    paid_installments: [],
    open_remaining: 0,
    unscheduled: 0,
    remaining: 0,
  };
}

/**
 * Reparte o saldo sem parcela do cliente entre os grupos (ver cabeçalho).
 *
 * @param {object} args
 * @param {number} args.unscheduled saldo sem parcela do CLIENTE (>= 0)
 * @param {Array<{key:string, live_count:number, net_debit:number, created_at:any}>} args.groups
 * @returns {Object<string, number>} key -> fatia (só quem levou algo)
 */
function allocateUnscheduled({ unscheduled = 0, groups = [] } = {}) {
  const out = {};
  let resto = round2(Math.max(0, num(unscheduled)));
  if (resto <= CENT_TOLERANCE) return out;

  const fiados = (groups || [])
    .filter(g => g && g.key !== NO_ACCOUNT_KEY && !(g.live_count > 0) && num(g.net_debit) > CENT_TOLERANCE)
    .slice()
    .sort((a, b) => timeOf(b.created_at) - timeOf(a.created_at));

  for (const g of fiados) {
    if (resto <= CENT_TOLERANCE) break;
    const fatia = round2(Math.min(resto, num(g.net_debit)));
    out[g.key] = fatia;
    resto = round2(resto - fatia);
  }

  const semCarne = (groups || []).find(g => g && g.key === NO_ACCOUNT_KEY);
  if (semCarne && resto > CENT_TOLERANCE) {
    const fatia = round2(Math.min(resto, Math.max(0, num(semCarne.net_debit))));
    if (fatia > CENT_TOLERANCE) out[NO_ACCOUNT_KEY] = fatia;
  }
  return out;
}

/**
 * Resumo de cada grupo (carnê ou "sem carnê") do cliente.
 *
 * @param {object} args
 * @param {Array<object>} args.accounts     credit_accounts do cliente ({ id, created_at, ... })
 * @param {Array<object>} args.installments parcelas NÃO canceladas do cliente
 * @param {Array<object>} args.debits       débitos do razão (venda cancelada fora)
 * @param {Object<string, number>} [args.refundsByGroup] key -> soma de estornos
 * @param {Object<string, Array<object>>} [args.itemsBySale]
 * @param {number} [args.ledgerBalance] saldo do cliente no razão
 * @returns {Object<string, object>} key (account_id | NO_ACCOUNT_KEY) -> detalhe
 */
function summarizeCarnes({
  accounts = [], installments = [], debits = [], refundsByGroup = {}, itemsBySale = {}, ledgerBalance = 0,
} = {}) {
  const parcelasPorGrupo = {};
  for (const i of installments || []) {
    if (!i || i.status === 'cancelled') continue;
    const k = groupKey(i.account_id);
    (parcelasPorGrupo[k] = parcelasPorGrupo[k] || []).push(i);
  }
  const debitosPorGrupo = {};
  for (const d of debits || []) {
    if (!d) continue;
    const k = groupKey(d.account_id);
    (debitosPorGrupo[k] = debitosPorGrupo[k] || []).push(d);
  }

  const keys = new Set([
    ...(accounts || []).map(a => a.id),
    ...Object.keys(parcelasPorGrupo),
    ...Object.keys(debitosPorGrupo),
    NO_ACCOUNT_KEY,
  ]);
  const criadoEm = {};
  for (const a of accounts || []) criadoEm[a.id] = a.created_at;

  const out = {};
  const paraRepartir = [];
  let abertoTotal = 0;

  for (const k of keys) {
    const parcelas = parcelasPorGrupo[k] || [];
    const debitosDoGrupo = debitosPorGrupo[k] || [];
    const { paid, open } = classifyInstallments(parcelas);
    const d = emptyDetail();

    d.total_count = paid.length + open.length;
    d.paid_count = paid.length;
    d.paid_installments = paid
      .slice()
      .sort((a, b) => timeOf(a.due_date) - timeOf(b.due_date))
      .map(i => ({
        id: i.id,
        installment_number: i.installment_number,
        total_installments: i.total_installments,
        due_date: overdueRule.ymd(i.due_date),
        paid_at: i.paid_at || null,
        amount: round2(num(i.amount_due)),
      }));
    d.open_remaining = round2(open.reduce((s, i) => s + i.remaining, 0));
    d.total_amount = round2(debitosDoGrupo.reduce((s, x) => s + num(x.amount), 0));
    d.refunded_total = round2(num(refundsByGroup[k]));

    // O que foi comprado. Num carnê (por compra) são os débitos dele. No grupo
    // sem carnê vale a regra do papel (carnePurchases): do mais novo para o
    // mais antigo até cobrir o que o grupo cobra — senão a lista traria o
    // histórico inteiro do cliente.
    let escolhidos;
    if (k === NO_ACCOUNT_KEY) {
      escolhidos = null; // precisa da fatia sem parcela: resolvido abaixo
    } else {
      escolhidos = debitosDoGrupo.slice().sort((a, b) => timeOf(a.created_at) - timeOf(b.created_at));
      d.purchases = buildPurchaseLines(escolhidos, itemsBySale);
      d.purchases_total = round2(d.purchases.reduce((s, l) => s + l.amount, 0));
    }

    abertoTotal += d.open_remaining;
    paraRepartir.push({
      key: k,
      live_count: d.total_count,
      net_debit: round2(Math.max(0, d.total_amount - d.refunded_total)),
      created_at: criadoEm[k] || null,
    });
    out[k] = d;
  }

  const semParcelaDoCliente = round2(Math.max(0, num(ledgerBalance) - round2(abertoTotal)));
  const fatias = allocateUnscheduled({ unscheduled: semParcelaDoCliente, groups: paraRepartir });
  for (const k of Object.keys(out)) {
    out[k].unscheduled = round2(fatias[k] || 0);
    out[k].remaining = round2(out[k].open_remaining + out[k].unscheduled);
  }

  // Compras do grupo sem carnê (agora que a fatia sem parcela é conhecida).
  const sc = out[NO_ACCOUNT_KEY];
  const alvoSemCarne = Math.max(groupTarget(parcelasPorGrupo[NO_ACCOUNT_KEY] || []), sc.remaining);
  const escolhidosSemCarne = selectDebitsForTarget(debitosPorGrupo[NO_ACCOUNT_KEY] || [], alvoSemCarne);
  sc.purchases = buildPurchaseLines(escolhidosSemCarne, itemsBySale);
  sc.purchases_total = round2(sc.purchases.reduce((s, l) => s + l.amount, 0));

  return out;
}

// ------------------------------------------------------------
// Carregador. `q` é o pool ou um client em transação.
//   forUpdate: trava carnês e parcelas (junção). Com forUpdate o chamador
//              está em transação — qualquer erro aqui aborta a transação, e é
//              isso mesmo que a junção quer (não junta às cegas).
//   withItems: traz os itens das vendas (ficha). A junção não precisa.
// Sem forUpdate, tabela/coluna ausente (42P01/42703) vira lista vazia.
// ------------------------------------------------------------
async function loadCarneContext(q, companyId, customerId, { forUpdate = false, withItems = false } = {}) {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const tolerante = async (fn, vazio) => {
    if (forUpdate) return fn();
    try { return await fn(); } catch (e) {
      if (e.code === '42P01' || e.code === '42703') return vazio;
      throw e;
    }
  };

  // SELECT * de propósito: merged_into_account_id (migration 369) vem quando
  // existe e simplesmente não vem quando a migration ainda não rodou.
  const accounts = await tolerante(async () => (await q.query(
    `SELECT * FROM credit_accounts
      WHERE company_id = $1 AND customer_id = $2
      ORDER BY created_at ASC${lock}`,
    [companyId, customerId]
  )).rows, []);

  const installments = await tolerante(async () => (await q.query(
    `SELECT id, account_id, sale_id, installment_number, total_installments,
            amount_due, covered_amount, due_date, status, paid_at, created_at
       FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2 AND status <> 'cancelled'
      ORDER BY due_date ASC, installment_number ASC${lock}`,
    [companyId, customerId]
  )).rows, []);

  // Mesma consulta do carnê impresso (routes/print.js): venda cancelada fora.
  const debits = await tolerante(async () => (await q.query(
    `SELECT t.id, t.sale_id, t.account_id, t.amount, t.notes, t.created_at
       FROM customer_credit_transactions t
       LEFT JOIN sales s ON s.id = t.sale_id AND s.company_id = t.company_id
      WHERE t.customer_id = $2 AND t.company_id = $1 AND t.type = 'debit'
        AND COALESCE(s.status, 'active') <> 'cancelled'
      ORDER BY t.created_at DESC
      LIMIT 1000`,
    [companyId, customerId]
  )).rows, []);

  const refundRows = await tolerante(async () => (await q.query(
    `SELECT account_id, COALESCE(SUM(amount), 0) AS total
       FROM customer_credit_transactions
      WHERE company_id = $1 AND customer_id = $2 AND type = 'refund'
      GROUP BY account_id`,
    [companyId, customerId]
  )).rows, []);
  const refundsByGroup = {};
  for (const r of refundRows) refundsByGroup[groupKey(r.account_id)] = num(r.total);

  const balRows = await tolerante(async () => (await q.query(
    `SELECT COALESCE(balance, 0) AS balance
       FROM customer_credit_balances
      WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId]
  )).rows, []);
  const ledgerBalance = num(balRows[0] && balRows[0].balance);

  const itemsBySale = {};
  if (withItems) {
    const saleIds = [...new Set(debits.map(d => d.sale_id).filter(Boolean))];
    if (saleIds.length) {
      const itemRows = await tolerante(async () => (await q.query(
        `SELECT si.sale_id,
                COALESCE(si.product_name_snapshot, p.name) AS product_name,
                si.quantity, si.unit_price, si.total_price
           FROM sale_items si
           JOIN sales s ON s.id = si.sale_id AND s.company_id = $2
           LEFT JOIN products p ON p.id = si.product_id
          WHERE si.sale_id = ANY($1::uuid[])
          ORDER BY si.sale_id, si.id`,
        [saleIds, companyId]
      )).rows, []);
      for (const it of itemRows) (itemsBySale[it.sale_id] = itemsBySale[it.sale_id] || []).push(it);
    }
  }

  return { accounts, installments, debits, refundsByGroup, ledgerBalance, itemsBySale };
}

module.exports = {
  NO_ACCOUNT_KEY,
  isHiddenAccount,
  emptyDetail,
  allocateUnscheduled,
  summarizeCarnes,
  loadCarneContext,
};
