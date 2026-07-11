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

// Retorna metadados da federação necessários ao layout DESIGN-30:
//   name             — COALESCE(trade_name, legal_name) ou "Federação"
//   karate_logo_url  — URL da logo (companies.karate_logo_url); null se ausente
//   wa_phone_display — número WhatsApp (companies.wa_phone_display); null se ausente
async function getFederationMeta(fedId) {
  try {
    const { rows } = await db.query(
      `SELECT
         COALESCE(trade_name, legal_name) AS name,
         slug,
         karate_logo_url,
         wa_phone_display
       FROM companies
       WHERE id = $1
       LIMIT 1`,
      [fedId]
    );
    if (!rows.length) return { name: 'Federação', slug: null, karate_logo_url: null, wa_phone_display: null };
    return {
      name:             rows[0].name             || 'Federação',
      slug:             rows[0].slug             || null,
      karate_logo_url:  rows[0].karate_logo_url  || null,
      wa_phone_display: rows[0].wa_phone_display  || null,
    };
  } catch (_) {
    return { name: 'Federação', karate_logo_url: null, wa_phone_display: null };
  }
}

// Fase F1: fonte agora é PARCELA (karate_annuity_installments), não mais o
// header — dojô E praticante (CPF), cada linha é UMA parcela em aberto.
// `a.id` (usado como annuity_id no log/idempotência) passa a ser o id da
// PARCELA. Fallback defensivo (42703/42P01, migration 222 ausente): volta
// pro comportamento antigo (header de dojô, 1 linha por anuidade).
// ⚠️ A régua continua OFF por padrão (gate é karate_reminder_config.enabled,
// não tocado aqui) — esta troca de fonte não ativa nada sozinha.
async function getOpenAnnuities(federationId) {
  try {
    const { rows } = await db.query(
      `SELECT i.id, i.federation_id, i.due_date, i.paid_at, i.status, i.amount,
              h.reference_period, h.dojo_id, 'dojo' AS kind,
              COALESCE(d.trade_name, d.legal_name) AS recipient_name,
              d.email AS recipient_email
         FROM karate_annuity_installments i
         JOIN karate_dojo_annuity_history h ON h.id = i.annuity_id
         JOIN companies d ON d.id = h.dojo_id
        WHERE i.federation_id = $1
          AND h.dojo_id IS NOT NULL
          AND i.paid_at IS NULL
          AND i.status <> 'paid'
          AND i.due_date IS NOT NULL

       UNION ALL

       SELECT i.id, i.federation_id, i.due_date, i.paid_at, i.status, i.amount,
              h.reference_period, h.dojo_id, 'cpf' AS kind,
              cu.name AS recipient_name,
              cu.email AS recipient_email
         FROM karate_annuity_installments i
         JOIN karate_dojo_annuity_history h ON h.id = i.annuity_id
         JOIN customers cu ON cu.id = h.practitioner_id
        WHERE i.federation_id = $1
          AND h.practitioner_id IS NOT NULL
          AND i.paid_at IS NULL
          AND i.status <> 'paid'
          AND i.due_date IS NOT NULL`,
      [federationId]
    );
    return rows.map((r) => ({
      id: r.id,
      dojo_id: r.dojo_id,
      federation_id: r.federation_id,
      due_date: r.due_date,
      paid_at: r.paid_at,
      status: r.status,
      amount: r.amount,
      reference_period: r.reference_period,
      dojo_name: r.recipient_name,
      dojo_email: r.recipient_email,
      kind: r.kind,
    }));
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') throw e;
    // Fallback legado: migration 222 ainda não aplicada.
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
    return rows.map((r) => ({ ...r, kind: 'dojo' }));
  }
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

  // Busca metadados da federação (nome + logo + WhatsApp) uma vez por lote.
  const fedMeta = await getFederationMeta(fedId);

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
        dojoName:           a.dojo_name,
        amount:             a.amount,
        dueDate:            a.due_date,
        referencePeriod:    a.reference_period,
        ruleCode:           due.code,
        offset:             due.offset,
        // ── DESIGN-30: metadados da federação ──────────────
        federationName:     fedMeta.name,
        federationSlug:     fedMeta.slug,
        federationLogoUrl:  fedMeta.karate_logo_url,   // companies.karate_logo_url
        federationWhatsapp: fedMeta.wa_phone_display,   // companies.wa_phone_display
        // ctaUrl: página de pagamento Pix do dojô.
        // A rota backend POST /financial/annuities/dojos/:dojoId/pix existe,
        // mas não há página frontend pública de pagamento Pix para o dojô ainda.
        // Quando essa página for criada (Track ?), passar a URL aqui:
        //   ctaUrl: `https://app.getaura.com.br/karate/pagar/${a.id}` (exemplo)
        // Por ora, ctaUrl fica undefined → nenhum botão é renderizado.
        ctaUrl: undefined,
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
