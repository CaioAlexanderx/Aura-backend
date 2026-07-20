// ============================================================
// AURA DOJÔ — F3c: Régua de cobrança do dojô (dojô→aluno)
//
// Camada DB-facing (espelha karateReminderRunner do Track I, mas o modelo
// é POR OFFSET EXATO, não "estágio mais avançado"): para cada offset
// configurado, seleciona as cobranças PENDING cujo (due_date + offset) =
// hoje e envia UM e-mail pt-BR ao responsável pagador (guardian) ou, na
// ausência, ao próprio aluno.
//
// Offsets em dias relativos ao vencimento: negativo = antes, 0 = no dia,
// positivo = em atraso (assunto/heading do e-mail muda conforme o sinal).
//
// IDEMPOTÊNCIA: UNIQUE(charge_id, offset_days, channel) no log — antes de
// enviar, checa se já há registro do estágio; reenviar o runner (mesmo dia
// ou depois) nunca duplica. Sem e-mail do destinatário → log 'skipped_no_email'.
//
// LINK DE PAGAMENTO: usa karate_dojo_charges.pix_payload (BR Code já
// gerado) para montar a página pública (signPixToken). Se ausente, gera via
// karateDojoBillingService.createChargePix (que salva pix_payload e, no
// caminho BaaS, NÃO recria pagamento quando já existe). Falha ao obter o
// link nunca derruba o envio — o e-mail vai sem botão.
//
// Escopo SEMPRE por dojoId. Defensivo a 42P01/42703 (migration 245
// pendente): getConfig cai no default; getLog devolve vazio; run propaga
// 42P01 (a rota devolve 503 SCHEMA_PENDING).
// ============================================================
'use strict';

const db = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');
const karateMailer = require('./karateMailer');
const { signPixToken } = require('./karatePixPublicToken');
const billingSvc = require('./karateDojoBillingService');

const env = validateRuntimeEnv();

const CHANNEL = 'email';
const DEFAULT_OFFSETS = [-3, 0, 3];
const DEFAULT_CONFIG = { enabled: false, offsets: DEFAULT_OFFSETS.slice(), send_email: true, updated_at: null };

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// ── Datas (tz-safe: componentes locais, string YYYY-MM-DD) ──
function todayStr() {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, '0');
  const d = String(n.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fmtBRL(v) {
  return karateMailer.fmtBRL(v);
}

// ── Config ──
function shapeConfig(row) {
  if (!row) return { ...DEFAULT_CONFIG, offsets: DEFAULT_OFFSETS.slice() };
  return {
    enabled: row.enabled === true,
    offsets: Array.isArray(row.offsets) && row.offsets.length ? row.offsets.map(Number) : DEFAULT_OFFSETS.slice(),
    send_email: row.send_email !== false,
    updated_at: row.updated_at || null,
  };
}

async function getConfig(dojoId) {
  try {
    const { rows } = await db.query(
      `SELECT enabled, offsets, send_email, updated_at
         FROM karate_dojo_reminder_config WHERE dojo_id = $1 LIMIT 1`,
      [dojoId]
    );
    return shapeConfig(rows[0]);
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return { ...DEFAULT_CONFIG, offsets: DEFAULT_OFFSETS.slice() };
    throw e;
  }
}

function validateConfigPayload(body) {
  const b = body || {};
  const enabled = b.enabled === true || b.enabled === 'true';
  const send_email = b.send_email === undefined || b.send_email === null ? true : !(b.send_email === false || b.send_email === 'false');

  if (!Array.isArray(b.offsets)) {
    throw svcError(422, 'VALIDATION_ERROR', 'offsets deve ser uma lista de inteiros');
  }
  const nums = b.offsets.map((n) => Number(n));
  if (nums.some((n) => !Number.isInteger(n))) {
    throw svcError(422, 'VALIDATION_ERROR', 'offsets deve conter apenas inteiros');
  }
  if (nums.some((n) => n < -15 || n > 30)) {
    throw svcError(422, 'VALIDATION_ERROR', 'cada offset deve estar entre -15 e 30');
  }
  if (nums.length < 1 || nums.length > 6) {
    throw svcError(422, 'VALIDATION_ERROR', 'offsets deve ter de 1 a 6 itens');
  }
  const uniq = Array.from(new Set(nums));
  if (uniq.length !== nums.length) {
    throw svcError(422, 'VALIDATION_ERROR', 'offsets não pode ter valores repetidos');
  }
  uniq.sort((a, z) => a - z);
  return { enabled, offsets: uniq, send_email };
}

async function putConfig(dojoId, body) {
  const data = validateConfigPayload(body);
  const { rows } = await db.query(
    `INSERT INTO karate_dojo_reminder_config (dojo_id, enabled, offsets, send_email, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (dojo_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, offsets = EXCLUDED.offsets,
       send_email = EXCLUDED.send_email, updated_at = now()
     RETURNING enabled, offsets, send_email, updated_at`,
    [dojoId, data.enabled, data.offsets, data.send_email]
  );
  return shapeConfig(rows[0]);
}

// ── Log ──
async function getLog(dojoId, { competence = null } = {}) {
  try {
    const { rows } = await db.query(
      `SELECT l.id, l.charge_id, l.offset_days AS offset, l.channel, l.status, l.recipient, l.sent_at,
              s.full_name AS student_name
         FROM karate_dojo_reminder_log l
         JOIN karate_dojo_charges c ON c.id = l.charge_id
         JOIN karate_dojo_students s ON s.id = c.student_id
        WHERE l.dojo_id = $1
          AND ($2::text IS NULL OR c.competence = $2)
        ORDER BY l.sent_at DESC
        LIMIT 200`,
      [dojoId, competence]
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        charge_id: r.charge_id,
        student_name: r.student_name || null,
        offset: r.offset != null ? Number(r.offset) : null,
        channel: r.channel || CHANNEL,
        status: r.status,
        sent_at: r.sent_at || null,
      })),
    };
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return { data: [] };
    throw e;
  }
}

// ── Metadados do dojô (branding do e-mail = o PRÓPRIO dojô) ──
async function getDojoMeta(dojoId) {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(trade_name, legal_name, name) AS name, slug, karate_logo_url, wa_phone_display
         FROM companies WHERE id = $1 LIMIT 1`,
      [dojoId]
    );
    if (!rows.length) return { name: 'Seu dojô', slug: null, karate_logo_url: null, wa_phone_display: null };
    return {
      name: rows[0].name || 'Seu dojô',
      slug: rows[0].slug || null,
      karate_logo_url: rows[0].karate_logo_url || null,
      wa_phone_display: rows[0].wa_phone_display || null,
    };
  } catch (_) {
    return { name: 'Seu dojô', slug: null, karate_logo_url: null, wa_phone_display: null };
  }
}

// Já enviado (qualquer status) este estágio? UNIQUE(charge_id, offset, channel).
async function alreadyLogged(chargeId, offset) {
  const { rows } = await db.query(
    `SELECT 1 FROM karate_dojo_reminder_log
      WHERE charge_id = $1 AND offset_days = $2 AND channel = $3 LIMIT 1`,
    [chargeId, offset, CHANNEL]
  );
  return rows.length > 0;
}

async function logSend(dojoId, chargeId, offset, status, recipient) {
  try {
    await db.query(
      `INSERT INTO karate_dojo_reminder_log (dojo_id, charge_id, offset_days, channel, status, recipient)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (charge_id, offset_days, channel) DO NOTHING`,
      [dojoId, chargeId, offset, CHANNEL, status, recipient || null]
    );
  } catch (e) {
    if (!(e && e.code === '42P01')) console.error('[karateDojoReminder] log falhou:', e.message);
  }
}

// Link público de pagamento a partir do BR Code salvo (ou gerado on-demand).
async function resolvePaymentUrl(dojoId, charge) {
  const payload = charge.pix_payload && String(charge.pix_payload).trim() ? String(charge.pix_payload) : null;
  if (payload) {
    try {
      const token = signPixToken({ amount: Number(charge.amount), referencePeriod: charge.competence, pixCode: payload });
      return `${env.APP_URL}/karate/pix/${token}`;
    } catch (_) { return null; }
  }
  // Sem BR Code salvo: gera via billing (salva pix_payload; caminho BaaS
  // não recria pagamento se já houver). Best-effort — nunca derruba o envio.
  try {
    const res = await billingSvc.createChargePix(dojoId, charge.id);
    return (res && res.public_url) || null;
  } catch (_) {
    return null;
  }
}

function subjectFor(offset, amount) {
  if (offset < 0) return `Lembrete: mensalidade de ${fmtBRL(amount)} a vencer`;
  if (offset > 0) return `Mensalidade em atraso — ${fmtBRL(amount)}`;
  return `Mensalidade vence hoje — ${fmtBRL(amount)}`;
}

function bodyFor(offset, charge, meta) {
  const venc = karateMailer.fmtDateBR(charge.due_date);
  const quando = offset < 0
    ? `vence em <strong>${venc}</strong>`
    : offset > 0
      ? `venceu em <strong>${venc}</strong> e está em atraso`
      : `vence <strong>hoje (${venc})</strong>`;
  const heading = offset < 0 ? 'Lembrete de mensalidade' : offset > 0 ? 'Mensalidade em atraso' : 'Mensalidade vence hoje';
  const bodyHtml = `
    <p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 14px;">
      Olá${charge.student_name ? ', responsável de ' + escapeHtml(charge.student_name) : ''}!
    </p>
    <p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 14px;">
      A mensalidade referente a <strong>${escapeHtml(charge.competence)}</strong> no valor de
      <strong style="color:#1c1917;">${fmtBRL(charge.amount)}</strong> ${quando}.
    </p>
    <p style="font-size:13px;color:#78716c;line-height:21px;margin:0;">
      Você pode pagar por PIX no botão abaixo. Qualquer dúvida, fale com o dojô.
    </p>`;
  return { heading, bodyHtml };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Runner de UM dojô ──
// config opcional (runAll injeta o que já leu); today opcional (testes).
async function runForDojo(dojoId, opts = {}) {
  const today = opts.today || todayStr();
  const config = opts.config || (await getConfig(dojoId));
  let sent = 0, skipped = 0, failed = 0;

  // send_email desligado: a régua não tem outro canal — nada a enviar.
  if (!config.send_email) return { sent: 0, skipped: 0, failed: 0 };

  const offsets = Array.isArray(config.offsets) && config.offsets.length ? config.offsets : DEFAULT_OFFSETS;

  // Candidatas: pending cujo (due_date + offset) = hoje, por offset.
  let candidates;
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.amount, c.competence,
              to_char(c.due_date, 'YYYY-MM-DD') AS due_date,
              c.pix_payload,
              o.offset_val,
              s.full_name AS student_name, s.email AS student_email,
              g.email AS guardian_email
         FROM unnest($2::int[]) AS o(offset_val)
         JOIN karate_dojo_charges c
           ON c.dojo_id = $1 AND c.status = 'pending'
          AND c.due_date = ($3::date - o.offset_val)
         JOIN karate_dojo_students s ON s.id = c.student_id
         LEFT JOIN karate_dojo_guardians g ON g.id = c.guardian_id
        ORDER BY c.due_date ASC, s.full_name ASC
        LIMIT 5000`,
      [dojoId, offsets, today]
    );
    candidates = rows;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return { sent, skipped, failed };
    throw e;
  }

  const meta = await getDojoMeta(dojoId);

  for (const row of candidates) {
    const offset = Number(row.offset_val);
    // Dedupe: estágio já processado (sent/failed/skipped) → não repete.
    let seen = false;
    try { seen = await alreadyLogged(row.id, offset); } catch (e) {
      if (e && e.code === '42P01') return { sent, skipped, failed };
      throw e;
    }
    if (seen) { skipped++; continue; }

    const recipient = (row.guardian_email && String(row.guardian_email).trim())
      || (row.student_email && String(row.student_email).trim()) || null;

    if (!recipient) {
      await logSend(dojoId, row.id, offset, 'skipped_no_email', null);
      skipped++;
      continue;
    }

    const paymentUrl = await resolvePaymentUrl(dojoId, row);
    const { heading, bodyHtml } = bodyFor(offset, row, meta);

    try {
      await karateMailer.sendKarateEmail(recipient, {
        subject: subjectFor(offset, row.amount),
        heading,
        bodyHtml,
        ctaUrl: paymentUrl || undefined,
        ctaLabel: paymentUrl ? 'Pagar mensalidade' : undefined,
        federationName: meta.name,
        federationSlug: meta.slug,
        federationLogoUrl: meta.karate_logo_url,
        federationWhatsapp: meta.wa_phone_display,
      });
      await logSend(dojoId, row.id, offset, 'sent', recipient);
      sent++;
    } catch (err) {
      await logSend(dojoId, row.id, offset, 'failed', recipient);
      failed++;
    }
  }

  return { sent, skipped, failed };
}

// ── Runner GLOBAL (todos os dojôs com enabled=true) — disparado pelo
// scheduler (src/jobs/dojoReminderScheduler.js), mesmo mecanismo do Track I. ──
async function getEnabledConfigs() {
  try {
    const { rows } = await db.query(
      `SELECT dojo_id, offsets, send_email
         FROM karate_dojo_reminder_config
        WHERE enabled = true AND send_email = true`
    );
    return rows;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return [];
    throw e;
  }
}

async function runAll(today) {
  const cfgs = await getEnabledConfigs();
  const agg = { dojos: cfgs.length, sent: 0, skipped: 0, failed: 0 };
  for (const cfg of cfgs) {
    try {
      const config = shapeConfig({ enabled: true, offsets: cfg.offsets, send_email: cfg.send_email, updated_at: null });
      const r = await runForDojo(cfg.dojo_id, { today, config });
      agg.sent += r.sent; agg.skipped += r.skipped; agg.failed += r.failed;
    } catch (e) {
      console.error('[karateDojoReminder] dojô', cfg.dojo_id, 'falhou:', e.message);
    }
  }
  return agg;
}

module.exports = {
  DEFAULT_OFFSETS,
  DEFAULT_CONFIG,
  getConfig,
  putConfig,
  validateConfigPayload,
  getLog,
  runForDojo,
  runAll,
  getEnabledConfigs,
};
