// ============================================================
// AURA. — Desconto por varios meses na assinatura (11/09/2026)
//
// Pedido comercial: "R$ 50 de desconto nas 3 primeiras mensalidades do
// plano Negocio". Ate aqui o cupom so valia na 1a mensalidade (ver
// checkoutCoupon.js) justamente para nao existir estado a restaurar. Um
// desconto de varios meses nao tem como fugir disso, entao o estado vive
// aqui, declarado, em subscription_discounts (migration 326):
//
//   1. /billing/subscribe cria a assinatura no Asaas JA com o valor
//      descontado e grava a linha (status 'active').
//   2. jobs/subscriptionDiscountJob.js devolve o valor cheio depois que a
//      ultima mensalidade com desconto foi GERADA no Asaas (status
//      'restored') e avisa o cliente antes da 1a cobranca cheia.
//   3. Trocar de plano ou cancelar durante o desconto perde o que faltava
//      (status 'lost') — regra comercial combinada em 11/09.
//
// Por que "gerada" e nao "paga": o Asaas cria cada cobranca da assinatura
// ~40 dias antes do vencimento, e mudar o valor da assinatura (sem
// updatePendingPayments) so afeta as cobrancas que ainda nao existem. O
// valor cheio tem que voltar DEPOIS que a ultima com desconto nasceu e
// ANTES que a primeira cheia nasca — uma janela de ~30 dias. Contar por
// pagamento deixaria quem atrasa esticar o desconto.
//
// O webhook do Asaas nao ajuda aqui: em 11/09/2026 so chegavam
// PAYMENT_RECEIVED e PAYMENT_DELETED (nenhum PAYMENT_CREATED), por isso a
// rotina consulta o Asaas em vez de esperar evento.
// ============================================================

// Tudo que vence antes de (1a cheia - 10 dias) e mensalidade com desconto.
// A distancia entre duas mensalidades e 28-31 dias, e o Asaas pode empurrar
// o vencimento de fim de mes em 1-3 dias; 10 dias separa as duas com folga.
const SLOT_MARGIN_DAYS = 10;

function money(v) {
  return Math.round(Number(v) * 100) / 100;
}

function parseIso(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

// Mesmo dia N meses depois. Dia que nao existe no mes de destino (31/01 + 1)
// cai no ultimo dia do mes, que e o que o Asaas faz com a recorrencia.
function addMonthsIso(iso, months) {
  const base = parseIso(iso);
  const day = base.getUTCDate();
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toIso(target);
}

function addDaysToIso(iso, days) {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

function daysBetween(fromIso, toIsoDate) {
  return Math.round((parseIso(toIsoDate) - parseIso(fromIso)) / 86400000);
}

// Data de hoje no fuso de Brasilia (o Asaas trabalha com datas BRT).
function todayBrt(now = Date.now()) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}

function slotBoundary(firstFullDueDate) {
  return addDaysToIso(firstFullDueDate, -SLOT_MARGIN_DAYS);
}

// ── Tabela pronta? ────────────────────────────────────────────
// O backend sobe antes da migration. Um cupom de varios meses SEM a tabela
// criaria uma assinatura descontada para sempre (nada devolveria o valor
// cheio), entao o checkout recusa o cupom enquanto a tabela nao existir.
// So o "sim" e cacheado: depois que a migration sobe, para de consultar.
let _tableReady = false;

async function discountTableReady(db) {
  if (_tableReady) return true;
  try {
    await db.query('SELECT 1 FROM subscription_discounts LIMIT 0');
    _tableReady = true;
    return true;
  } catch (err) {
    if (err.code === '42P01') return false;
    throw err;
  }
}

function _resetTableReadyCache() {
  _tableReady = false;
}

/**
 * Grava o desconto em andamento logo depois que a assinatura nasceu.
 * Nunca lanca: a cobranca ja aconteceu. Se falhar, o log diz exatamente o que
 * reconciliar a mao (a assinatura ficaria descontada sem ninguem devolver).
 */
async function startDiscount(db, data) {
  try {
    const { rows } = await db.query(
      `INSERT INTO subscription_discounts
         (company_id, user_id, code_id, code, asaas_subscription_id, billing_type,
          discount_amount, months, charged_upfront, first_full_due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        data.companyId,
        data.userId || null,
        data.codeId || null,
        data.code,
        data.subscriptionId,
        data.billingType || null,
        money(data.discountAmount),
        data.months,
        data.chargedUpfront || 0,
        data.firstFullDueDate,
      ]
    );
    return rows[0] ? rows[0].id : null;
  } catch (err) {
    console.error('[DISCOUNT] RECONCILIAR A MAO — desconto nao registrado. company=' + data.companyId +
      ' subscription=' + data.subscriptionId + ' cupom=' + data.code + ' abatimento=' + data.discountAmount +
      ' meses=' + data.months + ' 1a cheia=' + data.firstFullDueDate + ' erro=' + err.message);
    return null;
  }
}

/**
 * Troca de plano ou cancelamento: o desconto que faltava se perde.
 * Um desconto 'restored' cuja 1a cheia ja venceu esta CONCLUIDO, nao perdido —
 * fica como esta (e o caso de quem assina o anual depois dos 3 meses).
 */
async function loseDiscount(db, companyId, reason) {
  try {
    const { rowCount } = await db.query(
      `UPDATE subscription_discounts
          SET status = 'lost', ended_reason = $2, updated_at = NOW()
        WHERE company_id = $1
          AND (status = 'active' OR (status = 'restored' AND first_full_due_date > CURRENT_DATE))`,
      [companyId, reason]
    );
    return rowCount || 0;
  } catch (err) {
    if (err.code !== '42P01') console.error('[DISCOUNT] loseDiscount falhou:', err.message);
    return 0;
  }
}

/**
 * Desconto que ainda vale para a assinatura atual (active, ou restored com
 * mensalidade descontada por vencer). null quando nao ha.
 */
async function findDiscountInEffect(db, companyId, subscriptionId) {
  if (!subscriptionId) return null;
  try {
    const { rows } = await db.query(
      `SELECT id, code, status, discount_amount, months, charged_upfront,
              to_char(first_full_due_date, 'YYYY-MM-DD') AS first_full_due_date
         FROM subscription_discounts
        WHERE company_id = $1
          AND asaas_subscription_id = $2
          AND status IN ('active', 'restored')
          AND first_full_due_date > CURRENT_DATE
        ORDER BY created_at DESC
        LIMIT 1`,
      [companyId, subscriptionId]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code !== '42P01') console.error('[DISCOUNT] findDiscountInEffect falhou:', err.message);
    return null;
  }
}

/**
 * Para quem recalcula o valor da assinatura (acesso extra, multi-CNPJ).
 * Sem isso, conceder um acesso extra no 2o mes gravaria o valor de tabela e
 * apagaria o desconto em silencio.
 *
 *   discountAmount         abater do valor recalculado (so enquanto 'active')
 *   updatePendingPayments  false durante o desconto: as cobrancas ja geradas
 *                          ficam como estao. Com true, uma mensalidade com
 *                          desconto ainda por vencer subiria pro valor cheio.
 */
async function getSyncAdjustment(db, companyId, subscriptionId) {
  const row = await findDiscountInEffect(db, companyId, subscriptionId);
  if (!row) return { discountAmount: 0, updatePendingPayments: true };
  return {
    discountAmount: row.status === 'active' ? money(row.discount_amount) : 0,
    updatePendingPayments: false,
  };
}

module.exports = {
  SLOT_MARGIN_DAYS,
  money,
  addMonthsIso,
  addDaysToIso,
  daysBetween,
  todayBrt,
  slotBoundary,
  discountTableReady,
  startDiscount,
  loseDiscount,
  findDiscountInEffect,
  getSyncAdjustment,
  _resetTableReadyCache,
};
