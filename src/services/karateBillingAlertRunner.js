'use strict';
// ============================================================
// Aviso interno de vencimento (T-2 dias) — Aura Karatê.
// Todo dia (via scheduler) busca federações cujo vencimento (próxima cobrança
// ou fim do trial) cai em EXATAMENTE 2 dias e dispara um e-mail para o inbox
// de operações (contato@getaura.com.br) para acompanhar o pagamento.
// Idempotência via karate_billing_alert_log (federation_id + due_date + kind).
// ============================================================
const db = require('../config/database');
const { sendRaw } = require('./karateMailer');

const OPS_INBOX = process.env.KARATE_BILLING_ALERT_TO || 'contato@getaura.com.br';
const AMOUNT_BRL = 'R$ 169,00';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function alertHtml(f) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;color:#2b2620;max-width:520px">' +
    '<h2 style="color:#a44c3e;margin:0 0 12px">Aura Karatê — vencimento em 2 dias</h2>' +
    '<p style="margin:4px 0"><strong>Federação:</strong> ' + esc(f.nome) + '</p>' +
    '<p style="margin:4px 0"><strong>Valor:</strong> ' + AMOUNT_BRL + '</p>' +
    '<p style="margin:4px 0"><strong>Vencimento:</strong> ' + esc(f.due_br) + '</p>' +
    '<p style="margin:4px 0"><strong>Status atual:</strong> ' + esc(f.billing_status || '—') + '</p>' +
    '<p style="margin:14px 0 0;color:#6a6154">Acompanhe a confirmação do pagamento no Asaas.</p>' +
    '</div>';
}

async function runDueAlerts() {
  const { rows } = await db.query(
    `SELECT id,
            COALESCE(trade_name, legal_name) AS nome,
            billing_status,
            COALESCE(next_billing_date::date, trial_ends_at::date) AS due_date,
            to_char(COALESCE(next_billing_date::date, trial_ends_at::date), 'DD/MM/YYYY') AS due_br
       FROM companies
      WHERE vertical = 'karate_federation'
        AND COALESCE(next_billing_date::date, trial_ends_at::date) = (CURRENT_DATE + INTERVAL '2 days')::date`
  );

  let sent = 0, skipped = 0, failed = 0;
  for (const f of rows) {
    // Idempotência: só envia se conseguir gravar o log (ON CONFLICT DO NOTHING).
    const ins = await db.query(
      `INSERT INTO karate_billing_alert_log (federation_id, due_date, kind)
       VALUES ($1, $2, 'due_2d') ON CONFLICT DO NOTHING RETURNING id`,
      [f.id, f.due_date]
    );
    if (!ins.rows.length) { skipped++; continue; }
    try {
      await sendRaw({
        to: OPS_INBOX,
        subject: 'Vencimento em 2 dias — ' + f.nome + ' (Aura Karatê)',
        html: alertHtml(f),
      });
      sent++;
    } catch (e) {
      failed++;
      // desfaz o log para retentar amanhã
      await db.query(
        `DELETE FROM karate_billing_alert_log WHERE federation_id=$1 AND due_date=$2 AND kind='due_2d'`,
        [f.id, f.due_date]
      ).catch(() => {});
      console.error('[karateBillingAlert] envio falhou para', f.nome, '-', e.message);
    }
  }
  return { feds: rows.length, sent, skipped, failed };
}

module.exports = { runDueAlerts };
