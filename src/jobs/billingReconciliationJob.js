// ============================================================
// AURA. — Reconciliação diária de billing_status
//
// Por que existe: billing_status só muda via webhook do Asaas
// (webhookAsaas.js), que só mapeia eventos PAYMENT_*. Não existe
// handler pra SUBSCRIPTION_DELETED/INACTIVATED — o próprio comentário
// de topo do webhookAsaas.js já avisa: "cancelamento real vem de
// SUBSCRIPTION_DELETED/INACTIVATED", mas esse evento nunca foi
// implementado (confirmado: webhook_logs nunca registrou um evento
// SUBSCRIPTION_*). Resultado: se o cliente cancelar a assinatura
// direto no painel do Asaas sem gerar nova cobrança, billing_status
// fica 'active' pra sempre — o card "Clientes Ativos" da Gestão Aura
// nunca se corrige sozinho.
//
// Também encontramos empresas com trial vencido há dias que nunca
// transicionaram de billing_status='trial' pra outra coisa, porque
// nada reavalia trial_ends_at.
//
// Este job roda 1x/dia (~6h BRT) e:
//   1) Para toda empresa PRIMARY com asaas_subscription_id, confere o
//      status real da assinatura direto na API do Asaas. Se a
//      assinatura não existe mais (404) ou está INACTIVE/deletada,
//      marca billing_status='cancelled' e propaga pras filhas
//      (billing_owner_company_id) — mesma lógica de propagação do
//      webhookAsaas.js.
//   2) Para toda empresa com trial vencido (trial_ends_at no passado)
//      que nunca converteu, marca billing_status='overdue' (mesmo
//      bucket que PAYMENT_OVERDUE — dispara o gate de checkout no
//      app) e propaga pras filhas se for primary.
//
// Fail-safe: qualquer erro incerto (rede, 5xx, auth) na chamada ao
// Asaas é ignorado SEM mutar nada — mesmo princípio do
// reverifyPaymentWithAsaas() em webhookAsaas.js. Só confirmamos
// cancelamento com certeza (404 ou status inequívoco), nunca com uma
// suposição.
//
// Escopo deliberadamente exclui empresas de federação karatê
// (federation_id) — elas têm ciclo de billing próprio (ver
// karateBillingDueScheduler.js) e não devem ser tocadas aqui.
//
// Segue o padrão de scheduler do repo (setInterval + guarda de data),
// já que o backend não tem cron real (ver annuityReminderScheduler.js).
// Auditoria gravada em webhook_logs (provider='asaas', event=
// 'RECONCILIATION_*') pra rastrear o que o job mudou.
// ============================================================
'use strict';

const db = require('../config/database');
const { asaasRequest } = require('../services/asaasClient');

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

async function logReconciliation(companyId, event, payload) {
  await db.query(
    `INSERT INTO webhook_logs (company_id, provider, event, payload, processed_at)
     VALUES ($1, 'asaas', $2, $3, NOW())`,
    [companyId, event, JSON.stringify(payload || {})]
  ).catch(function(e) { console.error('[billingReconciliation] log falhou:', e.message); });
}

// Propaga billing_status pras empresas filhas (billing_owner_company_id),
// espelhando exatamente o que webhookAsaas.js faz quando a primary muda.
async function propagateToChildren(primaryId, newStatus) {
  const r = await db.query(
    `UPDATE companies SET billing_status=$1, updated_at=NOW()
      WHERE billing_owner_company_id=$2 AND id<>$2 AND is_active=true`,
    [newStatus, primaryId]
  );
  return r.rowCount || 0;
}

// ── 1. Reconciliar assinaturas reais no Asaas ──────────────────
async function reconcileSubscriptions() {
  const { rows } = await db.query(
    `SELECT id, billing_status, asaas_subscription_id
       FROM companies
      WHERE is_active=true AND is_primary=true
        AND (federation_id IS NULL OR federation_id = id)
        AND asaas_subscription_id IS NOT NULL
        AND billing_status IN ('active','overdue','pending')`
  );

  let checked = 0, cancelled = 0, skipped = 0;
  for (const c of rows) {
    checked++;
    let sub;
    try {
      sub = await asaasRequest('GET', '/subscriptions/' + encodeURIComponent(c.asaas_subscription_id));
    } catch (err) {
      if (err.asaasStatus === 404) {
        // Assinatura não existe mais no Asaas -> cancelamento real que nenhum
        // webhook jamais reportou (SUBSCRIPTION_DELETED não é tratado).
        await db.query(
          `UPDATE companies SET billing_status='cancelled', updated_at=NOW() WHERE id=$1`,
          [c.id]
        );
        const propagated = await propagateToChildren(c.id, 'cancelled');
        await logReconciliation(c.id, 'RECONCILIATION_SUBSCRIPTION_NOT_FOUND', {
          previous_status: c.billing_status, asaas_subscription_id: c.asaas_subscription_id,
          propagated_to_children: propagated,
        });
        console.log('[billingReconciliation] company ' + c.id + ' assinatura ' + c.asaas_subscription_id +
          ' não encontrada no Asaas (404) — billing_status: ' + c.billing_status +
          ' -> cancelled (propagado pra ' + propagated + ' filhas)');
        cancelled++;
      } else {
        // Erro incerto (rede, 5xx, auth) -> NUNCA muta. Só loga.
        skipped++;
        console.error('[billingReconciliation] falha ao reverificar company ' + c.id +
          ' (mantendo status atual): ' + err.message);
      }
      continue;
    }

    const inactive = sub && (sub.deleted === true || sub.status === 'INACTIVE');
    if (inactive && c.billing_status !== 'cancelled') {
      await db.query(
        `UPDATE companies SET billing_status='cancelled', updated_at=NOW() WHERE id=$1`,
        [c.id]
      );
      const propagated = await propagateToChildren(c.id, 'cancelled');
      await logReconciliation(c.id, 'RECONCILIATION_SUBSCRIPTION_INACTIVE', {
        previous_status: c.billing_status, asaas_subscription_id: c.asaas_subscription_id,
        asaas_status: sub.status, propagated_to_children: propagated,
      });
      console.log('[billingReconciliation] company ' + c.id + ' assinatura ' + c.asaas_subscription_id +
        ' inativa/deletada no Asaas — billing_status: ' + c.billing_status +
        ' -> cancelled (propagado pra ' + propagated + ' filhas)');
      cancelled++;
    }
  }
  return { checked, cancelled, skipped };
}

// ── 2. Trials vencidos que nunca converteram ───────────────────
async function reconcileExpiredTrials() {
  const { rows } = await db.query(
    `SELECT id, trade_name, legal_name, is_primary, trial_ends_at
       FROM companies
      WHERE is_active=true AND billing_status='trial'
        AND (federation_id IS NULL OR federation_id = id)
        AND trial_ends_at IS NOT NULL AND trial_ends_at < NOW()`
  );

  let updated = 0;
  for (const c of rows) {
    await db.query(
      `UPDATE companies SET billing_status='overdue', updated_at=NOW() WHERE id=$1`,
      [c.id]
    );
    let propagated = 0;
    if (c.is_primary) propagated = await propagateToChildren(c.id, 'overdue');
    await logReconciliation(c.id, 'RECONCILIATION_TRIAL_EXPIRED', {
      trial_ends_at: c.trial_ends_at, propagated_to_children: propagated,
    });
    console.log('[billingReconciliation] company ' + c.id + ' (' + (c.trade_name || c.legal_name) +
      ') trial vencido em ' + c.trial_ends_at + ' — billing_status: trial -> overdue' +
      (propagated ? ' (propagado pra ' + propagated + ' filhas)' : ''));
    updated++;
  }
  return { updated };
}

async function triggerBillingReconciliation() {
  console.log('[billingReconciliation] iniciando reconciliação diária...');
  const start = Date.now();
  try {
    const subs = await reconcileSubscriptions();
    const trials = await reconcileExpiredTrials();
    const result = Object.assign({}, subs, trials, { ms: Date.now() - start });
    console.log('[billingReconciliation] concluído em ' + result.ms + 'ms — ' +
      'assinaturas checadas=' + result.checked + ' canceladas=' + result.cancelled +
      ' puladas(erro)=' + result.skipped + ' trials vencidos corrigidos=' + result.updated);
    return result;
  } catch (e) {
    console.error('[billingReconciliation] fatal:', e.message);
    return null;
  }
}

let _lastDate = null;

function tick() {
  const now = nowBRT();
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes();
  const dateStr = now.toISOString().slice(0, 10);
  if (hour === 6 && min < 5 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    triggerBillingReconciliation().catch(function(e) { console.error('[billingReconciliation] crash:', e.message); });
  }
}

let _interval = null;

function initBillingReconciliationJob() {
  if (_interval) return;
  _interval = setInterval(tick, 60 * 1000);
  console.log('[billingReconciliation] scheduler iniciado — diário 6h BRT (reconciliação de billing_status)');
}

function stopBillingReconciliationJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initBillingReconciliationJob,
  stopBillingReconciliationJob,
  triggerBillingReconciliation,
};
