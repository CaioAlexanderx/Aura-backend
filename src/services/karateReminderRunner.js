// ============================================================
// AURA KARATÊ — Runner da régua de anuidade (Track I)
// Camada DB-facing: lê config (opt-in), busca anuidades de dojô em aberto,
// consulta o motor puro (karateReminderEngine) e envia o lembrete via
// karateMailer, gravando no log (idempotência via índice único).
//
// Defensivo (armadilha_schema_pre_migration): tabelas 174/175 podem não existir
// em deploy parcial — trata 42P01 como "sem dados" e segue.
// ============================================================
'use strict';

const db = require('../config/database');
const karateMailer = require('./karateMailer');
const { computeReminder, DEFAULT_OFFSETS } = require('./karateReminderEngine');

// Federações com régua ligada. Defensivo a 42P01.
async function getEnabledConfigs() {
  try {
    const { rows } = await db.query(
      `SELECT federation_id, channel, offsets_days
         FROM karate_reminder_config
        WHERE enabled = true`
    );
    return rows;
  } catch (e) {
    if (e.code === '42P01') return [];
    throw e;
  }
}

async function getFederationName(fedId) {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(trade_name, legal_name) AS name FROM companies WHERE id = $1`, [fedId]);
    return rows[0]?.name || 'Federação';
  } catch (_) { return 'Federação'; }
}

// Anuidades de dojô em aberto (não pagas, com vencimento) de uma federação.
async function getOpenAnnuities(federationId) {
  const { rows } = await db.query(
    `SELECT a.id, a.dojo_id, a.federation_id, a.due_date, a.paid_at, a.status,
            a.amount, a.reference_period,
            COALESCE(d.trade_name, d.legal_name) AS dojo_name,
            d.email AS dojo_email
       FROM karate_dojo_annuity_history a
       JOIN companies d ON d.id = a.dojo_id
      WHERE a.federation_id = $1
        AND a.paid_at IS NULL
        AND a.status <> 'paid'
        AND a.due_date IS NOT NULL`,
    [federationId]
  );
  return rows;
}

async function getSentCodes(annuityId, channel) {
  try {
    const { rows } = await db.query(
      `SELECT rule_code FROM karate_reminder_log
        WHERE annuity_id = $1 AND channel = $2 AND status = 'sent'`,
      [annuityId, channel]
    );
    return rows.map((r) => r.rule_code);
  } catch (e) {
    if (e.code === '42P01') return [];
    throw e;
  }
}

async function logSend(entry) {
  try {
    await db.query(
      `INSERT INTO karate_reminder_log
         (federation_id, annuity_id, dojo_id, channel, recipient, rule_code, status, provider_id, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [entry.federationId, entry.annuityId, entry.dojoId || null, entry.channel,
       entry.recipient || null, entry.ruleCode, entry.status, entry.providerId || null, entry.error || null]
    );
  } catch (e) {
    if (e.code !== '42P01') console.error('[karateReminder] log falhou:', e.message);
  }
}

// Processa uma federação. cfg = { federation_id, channel, offsets_days }.
// today opcional (ISO) para testes/disparo retroativo controlado.
async function runForFederation(cfg, today) {
  const fedId = cfg.federation_id;
  const channel = cfg.channel || 'email';
  const offsets = (Array.isArray(cfg.offsets_days) && cfg.offsets_days.length)
    ? cfg.offsets_days : DEFAULT_OFFSETS;
  let sent = 0, skipped = 0, failed = 0;

  let annuities = [];
  try {
    annuities = await getOpenAnnuities(fedId);
  } catch (e) {
    if (e.code === '42P01') return { sent, skipped, failed, total: 0 };
    throw e;
  }
  if (!annuities.length) return { sent, skipped, failed, total: 0 };

  const federationName = await getFederationName(fedId);

  for (const a of annuities) {
    const sentCodes = await getSentCodes(a.id, channel);
    const due = computeReminder({
      dueDate: a.due_date, today, paidAt: a.paid_at, status: a.status, offsets, sentCodes,
    });
    if (!due) { skipped++; continue; }

    // Canal WhatsApp/wa.me fica para a fase de automação (F4). Aqui: e-mail.
    if (channel !== 'email') { skipped++; continue; }

    const recipient = a.dojo_email;
    if (!recipient) {
      await logSend({ federationId: fedId, annuityId: a.id, dojoId: a.dojo_id, channel,
        recipient: null, ruleCode: due.code, status: 'failed', error: 'sem e-mail do dojô' });
      failed++; continue;
    }
    try {
      const res = await karateMailer.sendKarateAnnuityReminderEmail(recipient, {
        dojoName: a.dojo_name, amount: a.amount, dueDate: a.due_date,
        referencePeriod: a.reference_period, ruleCode: due.code, offset: due.offset,
        federationName,
      });
      await logSend({ federationId: fedId, annuityId: a.id, dojoId: a.dojo_id, channel,
        recipient, ruleCode: due.code, status: 'sent', providerId: res && res.id });
      sent++;
    } catch (err) {
      await logSend({ federationId: fedId, annuityId: a.id, dojoId: a.dojo_id, channel,
        recipient, ruleCode: due.code, status: 'failed', error: err.message });
      failed++;
    }
  }
  return { sent, skipped, failed, total: annuities.length };
}

// Roda todas as federações com régua ligada. today opcional (testes).
async function runAll(today) {
  const cfgs = await getEnabledConfigs();
  const agg = { feds: cfgs.length, sent: 0, skipped: 0, failed: 0 };
  for (const cfg of cfgs) {
    try {
      const r = await runForFederation(cfg, today);
      agg.sent += r.sent; agg.skipped += r.skipped; agg.failed += r.failed;
    } catch (e) {
      console.error('[karateReminder] federação', cfg.federation_id, 'falhou:', e.message);
    }
  }
  return agg;
}

module.exports = { runAll, runForFederation, getEnabledConfigs, getOpenAnnuities };
