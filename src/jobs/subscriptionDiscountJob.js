// ============================================================
// AURA. — Job: fim do desconto por varios meses na assinatura
//
// Criado: 11/09/2026 (ver services/subscriptionDiscount.js)
//
// Dois trabalhos por desconto em andamento:
//
//   1. DEVOLVER O VALOR CHEIO. Assim que a ultima mensalidade com desconto
//      aparece no Asaas, a assinatura volta ao valor cheio SEM
//      updatePendingPayments — as cobrancas com desconto ja geradas ficam
//      como estao, a proxima nasce cheia. Rede de seguranca: 5 dias antes da
//      fronteira devolve de qualquer jeito. Se a rotina ficou parada e a
//      primeira cheia ja nasceu com desconto, ela e corrigida so se faltarem
//      10 dias ou mais para vencer (antes do aviso); mais perto que isso o
//      cliente fica com o desconto a mais — melhor do que mudar o valor de uma
//      cobranca que ele ja pode ter visto.
//
//   2. AVISAR O CLIENTE. E-mail 5 dias antes da primeira mensalidade cheia,
//      entre 9h e 20h de Brasilia, uma vez so. So depois do valor devolvido:
//      o e-mail promete um valor, entao ele tem que ser verdade.
//
// Idempotencia: a devolucao e travada por restore_claimed_at (expira em 30
// min) e lembra o valor alvo (restore_target_value), entao duas rodadas nunca
// somam o desconto duas vezes; o aviso e travado por notice_sent_at gravado
// ANTES do envio (no maximo um e-mail; se o envio falha, a trava e desfeita).
//
// Mesmo padrao dos outros jobs (setInterval + init/stop, tick injetavel).
// ============================================================
'use strict';

const {
  money,
  addDaysToIso,
  daysBetween,
  todayBrt,
  slotBoundary,
} = require('../services/subscriptionDiscount');

const BATCH = 200;
const INTERVALO_MS = 6 * 60 * 60 * 1000; // 6h: a janela para agir e de ~30 dias
const NOTICE_DAYS = 5;
const NOTICE_HOUR_FROM = 9;
const NOTICE_HOUR_TO = 20;
// Antes disso nao ha o que olhar no Asaas. A primeira cheia nasce no maximo
// 40 dias antes do vencimento (~30 dias antes da fronteira); 60 dias da uma
// janela de ~30 dias para agir mesmo com a rotina parada alguns dias.
const LOOK_FROM_DAYS_BEFORE_BOUNDARY = 60;
const RESTORE_SAFETY_DAYS = 5;
const FIX_PAYMENT_MIN_DAYS = 10;

const PLAN_LABELS = { essencial: 'Essencial', negocio: 'Negócio', expansao: 'Expansão' };

function sameMoney(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

// A descricao da assinatura carrega o cupom ("Aura Negocio — cupom X: ...").
// Depois do desconto as cobrancas novas nao podem continuar dizendo isso.
function stripCouponFromDescription(description) {
  if (!description) return undefined;
  return String(description).split(' — cupom ')[0];
}

async function listSubscriptionPayments(asaas, subscriptionId) {
  const data = await asaas('GET', '/subscriptions/' + subscriptionId + '/payments?limit=100');
  return (data && Array.isArray(data.data)) ? data.data : [];
}

async function markLost(db, id, reason) {
  await db.query(
    `UPDATE subscription_discounts
        SET status = 'lost', ended_reason = $2, restore_claimed_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status IN ('active', 'restored')`,
    [id, reason]
  );
}

async function restoreFullValue({ db, asaas, row, payments, today, summary }) {
  const boundary = slotBoundary(row.first_full_due_date);
  const inSubscription = row.months - row.charged_upfront;
  const discountedSlots = payments.filter((p) => p.dueDate < boundary);
  const fullSlots = payments.filter((p) => p.dueDate >= boundary);

  const lastDiscountedExists = discountedSlots.length >= inSubscription;
  const safety = today >= addDaysToIso(boundary, -RESTORE_SAFETY_DAYS);
  if (!lastDiscountedExists && !safety && fullSlots.length === 0) return 'waiting';

  const sub = await asaas('GET', '/subscriptions/' + row.asaas_subscription_id);
  if (!sub || sub.deleted || (sub.status && sub.status !== 'ACTIVE')) {
    await markLost(db, row.id, 'subscription_gone');
    summary.lost++;
    return 'lost';
  }

  const discount = money(row.discount_amount);
  const alreadyApplied = row.restore_target_value != null && sameMoney(sub.value, row.restore_target_value);
  const target = alreadyApplied ? money(row.restore_target_value) : money(sub.value + discount);
  const discountedValue = money(target - discount);

  const { rows: claimed } = await db.query(
    `UPDATE subscription_discounts
        SET restore_claimed_at = NOW(), restore_target_value = $2, updated_at = NOW()
      WHERE id = $1
        AND status = 'active'
        AND (restore_claimed_at IS NULL OR restore_claimed_at < NOW() - INTERVAL '30 minutes')
    RETURNING id`,
    [row.id, target]
  );
  if (!claimed.length) return 'claimed_elsewhere';

  if (!alreadyApplied) {
    try {
      const body = { value: target, updatePendingPayments: false };
      const description = stripCouponFromDescription(sub.description);
      if (description) body.description = description;
      await asaas('PUT', '/subscriptions/' + row.asaas_subscription_id, body);
    } catch (err) {
      await db.query(
        `UPDATE subscription_discounts
            SET restore_claimed_at = NULL, restore_target_value = NULL, updated_at = NOW()
          WHERE id = $1`,
        [row.id]
      );
      throw err;
    }
  }

  for (const p of fullSlots) {
    if (p.status !== 'PENDING' || !sameMoney(p.value, discountedValue)) continue;
    const daysLeft = daysBetween(today, p.dueDate);
    if (daysLeft < FIX_PAYMENT_MIN_DAYS) {
      console.warn('[discountJob] cobranca ' + p.id + ' (vence ' + p.dueDate + ') nasceu com desconto e vence em ' +
        daysLeft + ' dias — fica com desconto. company=' + row.company_id);
      continue;
    }
    try {
      await asaas('PUT', '/payments/' + p.id, { value: target });
      p.value = target;
      summary.fixedPayments++;
    } catch (err) {
      console.error('[discountJob] nao corrigiu a cobranca ' + p.id + ': ' + err.message);
    }
  }

  await db.query(
    `UPDATE subscription_discounts
        SET status = 'restored', ended_reason = 'restored', restored_at = NOW(),
            restore_claimed_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [row.id]
  );
  summary.restored++;
  console.log('[discountJob] valor cheio devolvido: company=' + row.company_id + ' subscription=' +
    row.asaas_subscription_id + ' ' + discountedValue + ' -> ' + target);
  return 'restored';
}

async function skipNotice({ db, row, summary, why }) {
  await db.query(
    `UPDATE subscription_discounts
        SET notice_sent_at = NOW(), notice_skipped = true, updated_at = NOW()
      WHERE id = $1 AND notice_sent_at IS NULL`,
    [row.id]
  );
  summary.noticeSkipped++;
  console.warn('[discountJob] aviso pulado: company=' + row.company_id + ' (' + why + ')');
}

async function sendNotice({ db, asaas, mailer, row, payments, today, summary }) {
  // A data prevista pode diferir 1-3 dias da real (fim de mes); so vale buscar
  // a real quando estiver perto.
  const predictedDaysLeft = daysBetween(today, row.first_full_due_date);
  if (predictedDaysLeft > NOTICE_DAYS + 3) return;
  if (predictedDaysLeft < -3) {
    return skipNotice({ db, row, summary, why: '1a cheia ja venceu em ' + row.first_full_due_date });
  }
  if (!row.recipient_email) return skipNotice({ db, row, summary, why: 'sem e-mail' });

  const list = payments || await listSubscriptionPayments(asaas, row.asaas_subscription_id);
  const boundary = slotBoundary(row.first_full_due_date);
  const firstFull = list
    .filter((p) => p.dueDate >= boundary)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0];
  const dueDate = firstFull ? firstFull.dueDate : row.first_full_due_date;
  const daysLeft = daysBetween(today, dueDate);

  // Rotina ficou parada ate depois do vencimento: aviso atrasado so confunde.
  if (daysLeft < 0) return skipNotice({ db, row, summary, why: '1a cheia ja venceu em ' + dueDate });
  if (daysLeft > NOTICE_DAYS) return;

  let fullValue = firstFull ? money(firstFull.value) : null;
  if (fullValue === null) {
    const sub = await asaas('GET', '/subscriptions/' + row.asaas_subscription_id);
    fullValue = money(sub.value);
  }

  const { rows: claimed } = await db.query(
    `UPDATE subscription_discounts
        SET notice_sent_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND notice_sent_at IS NULL
    RETURNING id`,
    [row.id]
  );
  if (!claimed.length) return;

  try {
    await mailer.sendDiscountEndingEmail(row.recipient_email, {
      firstName: row.recipient_name ? String(row.recipient_name).trim().split(/\s+/)[0] : '',
      companyName: row.company_name,
      planName: PLAN_LABELS[row.plan] || row.plan,
      months: row.months,
      discountedValue: money(fullValue - money(row.discount_amount)),
      fullValue,
      dueDate,
    });
    summary.noticed++;
  } catch (err) {
    await db.query(
      'UPDATE subscription_discounts SET notice_sent_at = NULL, updated_at = NOW() WHERE id = $1',
      [row.id]
    );
    throw err;
  }
}

/**
 * Um ciclo. @param deps {{ db, asaas, mailer, now? }} — injetavel p/ teste.
 */
async function tickSubscriptionDiscounts({ db, asaas, mailer, now = Date.now() }) {
  const today = todayBrt(now);
  const hourBrt = new Date(now - 3 * 3600000).getUTCHours();
  const noticeWindow = hourBrt >= NOTICE_HOUR_FROM && hourBrt < NOTICE_HOUR_TO;
  const summary = { scanned: 0, restored: 0, fixedPayments: 0, lost: 0, noticed: 0, noticeSkipped: 0, failed: 0 };

  const { rows } = await db.query(
    `SELECT d.id, d.company_id, d.code, d.asaas_subscription_id, d.status,
            d.discount_amount, d.months, d.charged_upfront, d.restore_target_value,
            to_char(d.first_full_due_date, 'YYYY-MM-DD') AS first_full_due_date,
            c.asaas_subscription_id AS company_subscription_id,
            c.plan,
            COALESCE(c.trade_name, c.legal_name) AS company_name,
            COALESCE(NULLIF(u.email, ''), NULLIF(c.email, '')) AS recipient_email,
            u.full_name AS recipient_name
       FROM subscription_discounts d
       JOIN companies c ON c.id = d.company_id
       LEFT JOIN users u ON u.id = d.user_id
      WHERE d.status = 'active' OR (d.status = 'restored' AND d.notice_sent_at IS NULL)
      ORDER BY d.first_full_due_date
      LIMIT $1`,
    [BATCH]
  );

  for (const row of rows) {
    summary.scanned++;
    try {
      // Trocou de assinatura por um caminho que nao passou pelo /subscribe
      // nem pelo /cancel (painel do Asaas, suporte): o desconto nao a segue.
      // Um desconto 'restored' cuja 1a cheia ja venceu esta concluido, nao
      // perdido: segue para o aviso, que se pula sozinho por data.
      const concluded = row.status === 'restored' && row.first_full_due_date <= today;
      if (row.company_subscription_id !== row.asaas_subscription_id && !concluded) {
        await markLost(db, row.id, 'subscription_changed');
        summary.lost++;
        continue;
      }

      let status = row.status;
      let payments = null;

      if (status === 'active') {
        const boundary = slotBoundary(row.first_full_due_date);
        if (today < addDaysToIso(boundary, -LOOK_FROM_DAYS_BEFORE_BOUNDARY)) continue;
        payments = await listSubscriptionPayments(asaas, row.asaas_subscription_id);
        const outcome = await restoreFullValue({ db, asaas, row, payments, today, summary });
        if (outcome !== 'restored') continue;
        status = 'restored';
      }

      if (status === 'restored' && noticeWindow) {
        await sendNotice({ db, asaas, mailer, row, payments, today, summary });
      }
    } catch (err) {
      summary.failed++;
      console.error('[discountJob] company=' + row.company_id + ' desconto=' + row.id + ': ' + err.message);
    }
  }

  return summary;
}

let _interval = null;
let _running = false;

function runOnce() {
  if (_running) return;
  _running = true;
  const db = require('../config/database');
  const { asaas } = require('../services/asaasClient');
  const mailer = require('../services/mailer');
  tickSubscriptionDiscounts({ db, asaas, mailer })
    .then((s) => {
      if (s.restored || s.lost || s.noticed || s.noticeSkipped || s.failed || s.fixedPayments) {
        console.log('[discountJob] ' + JSON.stringify(s));
      }
    })
    .catch((e) => {
      // 42P01: migration 326 ainda nao aplicada — nada a fazer.
      if (e.code !== '42P01') console.error('[discountJob] tick crash:', e.message);
    })
    .finally(() => { _running = false; });
}

function initSubscriptionDiscountJob() {
  if (_interval) return;
  _interval = setInterval(runOnce, INTERVALO_MS);
  if (_interval.unref) _interval.unref();
  // Primeira rodada logo depois do boot, sem esperar 6h a cada deploy.
  const first = setTimeout(runOnce, 2 * 60 * 1000);
  if (first.unref) first.unref();
  console.log('[discountJob] iniciado — fim do desconto por varios meses (a cada 6h)');
}

function stopSubscriptionDiscountJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initSubscriptionDiscountJob,
  stopSubscriptionDiscountJob,
  tickSubscriptionDiscounts,
  stripCouponFromDescription,
  NOTICE_DAYS,
  FIX_PAYMENT_MIN_DAYS,
  RESTORE_SAFETY_DAYS,
  INTERVALO_MS,
};
