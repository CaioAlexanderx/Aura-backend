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
// IDEMPOTÊNCIA (corrigida no QA de 27/07/2026): UNIQUE(charge_id,
// offset_days, channel) no log. O dedupe considera SÓ status='sent' —
// antes ele considerava QUALQUER status e um 'skipped_no_email' travava o
// estágio PARA SEMPRE: o dojô cadastrava o e-mail depois e o lembrete
// nunca mais saia (reproduzido em produção). Por isso logSend virou
// ON CONFLICT DO UPDATE: o retry sobrescreve o skip anterior.
//
// CANAIS:
//   'email'    — automático (runner/scheduler)
//   'whatsapp' — MANUAL: o backend monta a fila + a mensagem + o wa.me e o
//                sensei clica e envia. Responsável de menor quase nunca
//                tem e-mail, só telefone; sem esse canal a régua era
//                inerte para o público principal (crianças). O log é o
//                MESMO (karate_dojo_reminder_log), com channel='whatsapp'
//                — a coluna não tem CHECK constraint.
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
const CHANNEL_WHATSAPP = 'whatsapp';
const DEFAULT_OFFSETS = [-3, 0, 3];
const DEFAULT_CONFIG = { enabled: false, offsets: DEFAULT_OFFSETS.slice(), send_email: true, updated_at: null };
const WHATSAPP_QUEUE_LIMIT = 500;

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

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
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

// Já ENVIADO este estágio? Só status='sent' conta.
//
// ⚠️ REGRA QUE JÁ QUEBROU EM PRODUÇÃO: com "qualquer status" um
// 'skipped_no_email' (ou um 'failed' transitório) virava bloqueio
// permanente daquele estágio — cadastrar o e-mail depois não adiantava
// nada. Um lembrete que NÃO foi enviado não pode contar como enviado.
async function alreadyLogged(chargeId, offset, channel = CHANNEL) {
  const { rows } = await db.query(
    `SELECT 1 FROM karate_dojo_reminder_log
      WHERE charge_id = $1 AND offset_days = $2 AND channel = $3
        AND status = 'sent'
      LIMIT 1`,
    [chargeId, offset, channel]
  );
  return rows.length > 0;
}

// DO UPDATE (e não DO NOTHING): o log é o ESTADO ATUAL do estágio, não um
// histórico imutável. Sem isso o retry depois de um 'skipped_no_email'
// enviaria o e-mail mas deixaria a linha antiga — e o próximo run voltaria
// a pular.
async function logSend(dojoId, chargeId, offset, status, recipient, channel = CHANNEL) {
  try {
    await db.query(
      `INSERT INTO karate_dojo_reminder_log (dojo_id, charge_id, offset_days, channel, status, recipient)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (charge_id, offset_days, channel) DO UPDATE SET
         status = EXCLUDED.status,
         recipient = EXCLUDED.recipient,
         sent_at = now()`,
      [dojoId, chargeId, offset, channel, status, recipient || null]
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
//
// CONTADORES: skipped_no_email e skipped_sent são separados porque o front
// rotulava TODO skip como "sem e-mail" — mentira quando o skip era dedupe.
// `skipped` continua existindo como SOMA para não quebrar quem já consome.
async function runForDojo(dojoId, opts = {}) {
  const today = opts.today || todayStr();
  const config = opts.config || (await getConfig(dojoId));
  let sent = 0, skippedNoEmail = 0, skippedSent = 0, failed = 0;
  const result = () => ({
    sent,
    skipped_no_email: skippedNoEmail,
    skipped_sent: skippedSent,
    failed,
    skipped: skippedNoEmail + skippedSent,
  });

  // send_email desligado: o canal automático da régua é o e-mail (o
  // WhatsApp é fila manual, disparada pelo sensei) — nada a enviar.
  if (!config.send_email) return result();

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
    if (e && (e.code === '42P01' || e.code === '42703')) return result();
    throw e;
  }

  const meta = await getDojoMeta(dojoId);

  for (const row of candidates) {
    const offset = Number(row.offset_val);
    // Dedupe: só um envio EFETIVO (status='sent') bloqueia o estágio.
    let seen = false;
    try { seen = await alreadyLogged(row.id, offset); } catch (e) {
      if (e && e.code === '42P01') return result();
      throw e;
    }
    if (seen) { skippedSent++; continue; }

    const recipient = (row.guardian_email && String(row.guardian_email).trim())
      || (row.student_email && String(row.student_email).trim()) || null;

    if (!recipient) {
      await logSend(dojoId, row.id, offset, 'skipped_no_email', null);
      skippedNoEmail++;
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

  return result();
}

// ============================================================
// CANAL WHATSAPP — fila MANUAL (decisão do Caio, QA 27/07/2026)
//
// Não existe envio automático por WhatsApp aqui: o backend só monta a
// fila (quem cobrar hoje, por qual offset), o TEXTO pronto em pt-BR e o
// link wa.me — exatamente o padrão que a cobrança do crediário já usa. O
// sensei clica, o WhatsApp dele abre com a mensagem e ele envia; depois o
// front confirma com POST .../whatsapp-sent para o log parar de sugerir
// a mesma cobrança.
// ============================================================

function onlyDigits(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

// Devolve o telefone em dígitos SEM o 55 (o wa.me recebe 55 + isso).
// Fora de 10–11 dígitos → null (número imprestável não entra na fila).
function normalizeBrPhone(raw) {
  let d = onlyDigits(raw);
  if (!d) return null;
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return null;
  return d;
}

// Texto pt-BR pronto, no tom do produto (o sensei manda para a família).
// Varia pelo SINAL do offset, igual ao e-mail.
function whatsappMessage(offset, charge, meta, paymentUrl) {
  const venc = karateMailer.fmtDateBR(charge.due_date);
  const valor = fmtBRL(charge.amount);
  const aluno = charge.student_name ? ` do(a) ${charge.student_name}` : '';
  const dojo = meta && meta.name ? meta.name : 'o dojô';

  let linha;
  if (offset < 0) {
    linha = `A mensalidade${aluno} referente a ${charge.competence}, no valor de ${valor}, vence em ${venc}.`;
  } else if (offset > 0) {
    linha = `A mensalidade${aluno} referente a ${charge.competence}, no valor de ${valor}, venceu em ${venc} e está em aberto.`;
  } else {
    linha = `A mensalidade${aluno} referente a ${charge.competence}, no valor de ${valor}, vence hoje (${venc}).`;
  }

  const partes = [`Olá! Aqui é ${dojo}.`, linha];
  if (paymentUrl) partes.push(`Para pagar por PIX é só abrir este link: ${paymentUrl}`);
  partes.push('Qualquer dúvida é só responder por aqui. Oss!');
  return partes.join('\n\n');
}

function waUrl(phoneDigits, message) {
  return `https://wa.me/55${phoneDigits}?text=${encodeURIComponent(message)}`;
}

// GET da fila. Mesma seleção por offset do runner (pending cujo
// due_date + offset = date), mas só quem TEM telefone.
async function whatsappQueue(dojoId, { date = null, config = null } = {}) {
  const day = date != null && String(date).trim() !== '' ? String(date).trim() : todayStr();
  if (!isValidDateStr(day)) {
    throw svcError(422, 'VALIDATION_ERROR', 'date deve estar no formato YYYY-MM-DD');
  }

  const cfg = config || (await getConfig(dojoId));
  const offsets = Array.isArray(cfg.offsets) && cfg.offsets.length ? cfg.offsets : DEFAULT_OFFSETS;

  let rows;
  try {
    const res = await db.query(
      `SELECT c.id, c.amount, c.competence,
              to_char(c.due_date, 'YYYY-MM-DD') AS due_date,
              c.pix_payload,
              o.offset_val,
              s.full_name AS student_name, s.phone AS student_phone,
              g.full_name AS guardian_name, g.phone AS guardian_phone,
              EXISTS (
                SELECT 1 FROM karate_dojo_reminder_log l
                 WHERE l.charge_id = c.id
                   AND l.offset_days = o.offset_val
                   AND l.channel = $4
                   AND l.status = 'sent'
              ) AS already_sent
         FROM unnest($2::int[]) AS o(offset_val)
         JOIN karate_dojo_charges c
           ON c.dojo_id = $1 AND c.status = 'pending'
          AND c.due_date = ($3::date - o.offset_val)
         JOIN karate_dojo_students s ON s.id = c.student_id
         LEFT JOIN karate_dojo_guardians g ON g.id = c.guardian_id
        ORDER BY c.due_date ASC, s.full_name ASC
        LIMIT ${WHATSAPP_QUEUE_LIMIT}`,
      [dojoId, offsets, day, CHANNEL_WHATSAPP]
    );
    rows = res.rows;
  } catch (e) {
    // Migration 243/245 pendente → fila vazia, nunca 500.
    if (e && (e.code === '42P01' || e.code === '42703')) {
      return { date: day, data: [], count: 0, schema_pending: true };
    }
    throw e;
  }

  const meta = await getDojoMeta(dojoId);
  const data = [];

  for (const row of rows) {
    const phone = normalizeBrPhone(row.guardian_phone) || normalizeBrPhone(row.student_phone);
    if (!phone) continue; // sem telefone não há o que enfileirar

    const offset = Number(row.offset_val);
    // Best-effort: link é conforto, não requisito — falha nunca derruba a
    // listagem (a mensagem simplesmente vai sem link).
    let paymentUrl = null;
    try {
      paymentUrl = await resolvePaymentUrl(dojoId, row);
    } catch (_) {
      paymentUrl = null;
    }

    const message = whatsappMessage(offset, row, meta, paymentUrl);
    data.push({
      charge_id: row.id,
      offset,
      student_name: row.student_name || null,
      recipient_name: row.guardian_name || row.student_name || null,
      phone,
      amount: row.amount != null ? Number(row.amount) : null,
      due_date: row.due_date,
      competence: row.competence,
      payment_url: paymentUrl,
      message,
      wa_url: waUrl(phone, message),
      already_sent: row.already_sent === true,
    });
  }

  return { date: day, data, count: data.length };
}

// Confirmação manual do envio. IDEMPOTENTE: chamar duas vezes devolve 200
// nas duas (ON CONFLICT DO UPDATE) — clicar de novo não é erro.
async function markWhatsappSent(dojoId, chargeId, offsetRaw) {
  const offset = Number(offsetRaw);
  if (!Number.isInteger(offset)) {
    throw svcError(422, 'VALIDATION_ERROR', 'offset deve ser um inteiro');
  }

  // Escopo: a cobrança TEM que ser do dojô do guard (nunca do body).
  const { rows } = await db.query(
    `SELECT c.id, s.phone AS student_phone, g.phone AS guardian_phone
       FROM karate_dojo_charges c
       JOIN karate_dojo_students s ON s.id = c.student_id
       LEFT JOIN karate_dojo_guardians g ON g.id = c.guardian_id
      WHERE c.id = $1 AND c.dojo_id = $2
      LIMIT 1`,
    [chargeId, dojoId]
  );
  if (!rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Cobrança não encontrada neste dojô');
  }

  const row = rows[0];
  const phone = normalizeBrPhone(row.guardian_phone) || normalizeBrPhone(row.student_phone) || null;

  await logSend(dojoId, chargeId, offset, 'sent', phone, CHANNEL_WHATSAPP);

  return {
    ok: true,
    charge_id: chargeId,
    offset,
    channel: CHANNEL_WHATSAPP,
    status: 'sent',
    recipient: phone,
  };
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
  const agg = { dojos: cfgs.length, sent: 0, skipped_no_email: 0, skipped_sent: 0, failed: 0, skipped: 0 };
  for (const cfg of cfgs) {
    try {
      const config = shapeConfig({ enabled: true, offsets: cfg.offsets, send_email: cfg.send_email, updated_at: null });
      const r = await runForDojo(cfg.dojo_id, { today, config });
      agg.sent += r.sent;
      agg.skipped_no_email += r.skipped_no_email;
      agg.skipped_sent += r.skipped_sent;
      agg.failed += r.failed;
      agg.skipped += r.skipped;
    } catch (e) {
      console.error('[karateDojoReminder] dojô', cfg.dojo_id, 'falhou:', e.message);
    }
  }
  return agg;
}

module.exports = {
  DEFAULT_OFFSETS,
  DEFAULT_CONFIG,
  CHANNEL,
  CHANNEL_WHATSAPP,
  getConfig,
  putConfig,
  validateConfigPayload,
  getLog,
  runForDojo,
  runAll,
  getEnabledConfigs,
  // canal WhatsApp (fila manual)
  whatsappQueue,
  markWhatsappSent,
  whatsappMessage,
  normalizeBrPhone,
};
