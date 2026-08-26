// ============================================================
// AURA — ONDA 5b: FILA DE ENVIO WhatsApp (Cloud API)
//
// Regras de produto:
//  - OPT-OUT SEMPRE VENCE: telefone com opted_out_at nunca recebe —
//    o enfileiramento grava 'skipped' (auditável), não envia.
//  - Texto livre SÓ dentro da janela de 24h (last_inbound_at do
//    contato); fora dela, apenas TEMPLATE aprovado. O dispatcher
//    reforça a regra na hora do envio (a janela pode fechar na fila).
//  - Retry com backoff exponencial (2^attempts min, teto 60min),
//    permanente após MAX_ATTEMPTS.
//  - Credenciais por company (companies.wa_phone_number_id/
//    wa_access_token — src/migrations/039): consultadas com guarda
//    42703; ausentes → 'skipped' SEM_CREDENCIAIS.
//  - Todo envio OK também loga em wa_messages (039) best-effort.
// ============================================================
'use strict';

const db = require('../config/database');
const wa = require('./whatsapp');

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 24 * 3600 * 1000;

// E.164 sem '+': só dígitos. BR de 10 dígitos (fixo) ou 11 com '9' na
// 3ª posição (celular DDD+9...) ganha 55. Onze dígitos SEM esse '9'
// (ex.: o número de teste da Meta, 1 555 630 9005) passam como
// internacionais — DDDs 11-19 de SP não colidem porque o celular BR
// sempre tem o 9 ali.
function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D+/g, '');
  if (!d) return null;
  if (d.length === 10) return `55${d}`;
  if (d.length === 11) return d[2] === '9' ? `55${d}` : d;
  if (d.length >= 12 && d.length <= 15) return d;
  return null;
}

const OPT_OUT_WORDS = ['sair', 'parar', 'cancelar', 'stop', 'descadastrar'];
const OPT_IN_WORDS = ['voltar', 'start', 'quero receber'];

async function getContact(companyId, phone) {
  const { rows } = await db.query(
    `-- wa:contact-get
     SELECT id, phone, opted_in_at, opted_out_at, last_inbound_at
       FROM wa_contacts WHERE company_id = $1 AND phone = $2 LIMIT 1`,
    [companyId, phone]
  );
  return rows[0] || null;
}

// Upsert disparado pelo WEBHOOK a cada mensagem recebida: abre a janela
// de 24h e processa palavras de opt-in/opt-out.
async function touchInbound(companyId, phone, textBody) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const txt = String(textBody || '').trim().toLowerCase();
  const optOut = OPT_OUT_WORDS.includes(txt);
  const optIn = !optOut && OPT_IN_WORDS.includes(txt);
  const { rows } = await db.query(
    `-- wa:contact-touch
     INSERT INTO wa_contacts (company_id, phone, last_inbound_at, opted_in_at, opted_out_at, opt_source)
     VALUES ($1, $2, NOW(), CASE WHEN $4 THEN NULL ELSE NOW() END, CASE WHEN $4 THEN NOW() ELSE NULL END, 'inbound')
     ON CONFLICT (company_id, phone) DO UPDATE SET
       last_inbound_at = NOW(),
       opted_out_at = CASE WHEN $4 THEN NOW() WHEN $3 THEN NULL ELSE wa_contacts.opted_out_at END,
       opted_in_at  = CASE WHEN $4 THEN NULL WHEN $3 THEN NOW() ELSE COALESCE(wa_contacts.opted_in_at, NOW()) END,
       updated_at = NOW()
     RETURNING id, opted_out_at`,
    [companyId, p, optIn, optOut]
  );
  return { row: rows[0] || null, opt_out: optOut, opt_in: optIn };
}

function windowOpen(contact) {
  return !!(contact && contact.last_inbound_at
    && Date.now() - new Date(contact.last_inbound_at).getTime() < WINDOW_MS);
}

// Enfileira. kind 'template' (default) ou 'text' (só janela aberta —
// checada aqui E no envio). dedupeKey: idempotência (charge+offset etc.).
async function enqueue({
  companyId, toPhone, kind = 'template',
  templateName = null, templateLanguage = 'pt_BR', components = null,
  textBody = null, sourceType = null, sourceId = null, dedupeKey = null,
}) {
  const phone = normalizePhone(toPhone);
  if (!phone) return { queued: false, reason: 'TELEFONE_INVALIDO' };
  if (kind === 'template' && !templateName) return { queued: false, reason: 'TEMPLATE_OBRIGATORIO' };

  const contact = await getContact(companyId, phone);
  let status = 'pending';
  let skipReason = null;
  if (contact && contact.opted_out_at) { status = 'skipped'; skipReason = 'OPT_OUT'; }
  else if (kind === 'text' && !windowOpen(contact)) { status = 'skipped'; skipReason = 'JANELA_FECHADA'; }

  const { rows } = await db.query(
    `-- wa:outbox-enqueue
     INSERT INTO wa_outbox
       (company_id, to_phone, kind, template_name, template_language, components,
        text_body, status, skip_reason, source_type, source_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, status`,
    [companyId, phone, kind, templateName, templateLanguage,
     components ? JSON.stringify(components) : null, textBody,
     status, skipReason, sourceType, sourceId, dedupeKey]
  );
  if (!rows.length) return { queued: false, reason: 'DUPLICADO' };
  return { queued: status === 'pending', id: rows[0].id, status, reason: skipReason };
}

// O token do Graph API é cifrado em repouso (AES-256-GCM, prefixo 'v1:',
// mesmo cofre do dojoBaasCrypto) desde o A9 — é assim que o Embedded
// Signup (/whatsapp/connect) grava. Token legado em texto puro NÃO tem o
// prefixo e passa direto. Sem isso, o dispatcher mandaria o ciphertext
// como Bearer e TODO dojô conectado pelo fluxo oficial falharia no envio.
function decryptToken(stored) {
  if (!stored) return stored;
  if (!/^v1:/.test(String(stored))) return stored;
  const { decrypt } = require('./dojoBaasCrypto');
  return decrypt(stored);
}

// ── Token recusado pela Meta (migration 309) ────────────────
// A Meta recusa credencial com o código 190 ("Error validating access
// token: Session has expired..."). Quem descobre isso primeiro quase
// sempre é a FILA, não a tela: o dispatcher tenta enviar e leva o erro.
// Carimbando aqui, o status do dojô para de mentir "Conectado" mesmo
// que ninguém tenha aberto a tela de templates. (Achado no QA 26/08.)
const TOKEN_ERROR_MARKERS = [
  'error validating access token',
  'session has expired',
  'access token',
  'oauthexception',
];

function isTokenError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (/code:?\s*190/.test(msg)) return true;
  return TOKEN_ERROR_MARKERS.some((m) => msg.includes(m));
}

// Silencioso com a 309 pendente: registrar o problema não pode virar
// um segundo problema.
async function markTokenInvalid(companyId, reason) {
  try {
    await db.query(
      `UPDATE companies SET wa_token_invalid_at = NOW(), wa_token_invalid_reason = $2 WHERE id = $1`,
      [companyId, reason ? String(reason).slice(0, 500) : null]
    );
  } catch (e) {
    if (e.code !== '42703') throw e;
  }
}

async function clearTokenInvalid(companyId) {
  try {
    await db.query(
      `UPDATE companies SET wa_token_invalid_at = NULL, wa_token_invalid_reason = NULL WHERE id = $1`,
      [companyId]
    );
  } catch (e) {
    if (e.code !== '42703') throw e;
  }
}

// Credenciais da company — 42703-safe (039 fora do CI).
async function loadCreds(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:creds
       SELECT wa_phone_number_id, wa_access_token FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    const r = rows[0];
    if (!r || !r.wa_phone_number_id || !r.wa_access_token) return null;
    return { phoneNumberId: r.wa_phone_number_id, accessToken: decryptToken(r.wa_access_token) };
  } catch (e) {
    if (e.code === '42703') return null;
    throw e;
  }
}

async function markRow(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${i++}`); vals.push(v); }
  vals.push(id);
  await db.query(`UPDATE wa_outbox SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals);
}

// Processa até `limit` itens pendentes vencidos. Chamado pelo
// waDispatcherJob e pelo POST /whatsapp/test-send (envio imediato).
async function processBatch(limit = 20) {
  const { rows } = await db.query(
    `-- wa:outbox-pick
     SELECT * FROM wa_outbox
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );
  const out = { picked: rows.length, sent: 0, skipped: 0, retried: 0, failed: 0 };

  for (const row of rows) {
    try {
      const creds = await loadCreds(row.company_id);
      if (!creds) {
        await markRow(row.id, { status: 'skipped', skip_reason: 'SEM_CREDENCIAIS' });
        out.skipped++;
        continue;
      }
      // Reforço das regras NO ENVIO (estado pode ter mudado na fila).
      const contact = await getContact(row.company_id, row.to_phone);
      if (contact && contact.opted_out_at) {
        await markRow(row.id, { status: 'skipped', skip_reason: 'OPT_OUT' });
        out.skipped++;
        continue;
      }
      if (row.kind === 'text' && !windowOpen(contact)) {
        await markRow(row.id, { status: 'skipped', skip_reason: 'JANELA_FECHADA' });
        out.skipped++;
        continue;
      }

      let resp;
      if (row.kind === 'template') {
        resp = await wa.sendTemplate(
          creds.phoneNumberId, creds.accessToken, row.to_phone,
          row.template_name, row.template_language || 'pt_BR',
          row.components || undefined
        );
      } else {
        resp = await wa.sendText(creds.phoneNumberId, creds.accessToken, row.to_phone, row.text_body || '');
      }
      const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id || null;
      await markRow(row.id, { status: 'sent', wa_message_id: wamid, last_error: null });
      out.sent++;

      // Log espelho em wa_messages (039) — best-effort.
      db.query(
        `INSERT INTO wa_messages (company_id, direction, wa_message_id, to_phone, template_name, content, status, metadata)
         VALUES ($1,'outbound',$2,$3,$4,$5,'sent',$6)`,
        [row.company_id, wamid, row.to_phone, row.template_name,
         row.text_body || `[template ${row.template_name}]`,
         JSON.stringify({ outbox_id: row.id, source_type: row.source_type, source_id: row.source_id })]
      ).catch(() => {});
    } catch (e) {
      const attempts = (row.attempts || 0) + 1;
      const msg = String(e && e.message || e).slice(0, 500);
      // Credencial recusada não é falha transitória: carimba a company
      // para o status parar de dizer "Conectado" (o retry continua —
      // reconectar limpa a marca e a mensagem sai na próxima tentativa).
      if (isTokenError(e)) await markTokenInvalid(row.company_id, msg);
      if (attempts >= MAX_ATTEMPTS) {
        await markRow(row.id, { status: 'failed', attempts, last_error: msg });
        out.failed++;
      } else {
        const backoffMin = Math.min(Math.pow(2, attempts), 60);
        await db.query(
          `UPDATE wa_outbox SET attempts = $1, last_error = $2,
                  next_attempt_at = NOW() + ($3 || ' minutes')::interval, updated_at = NOW()
            WHERE id = $4`,
          [attempts, msg, String(backoffMin), row.id]
        );
        out.retried++;
      }
    }
  }
  return out;
}

// Webhook: status da Meta (sent→delivered→read / failed) casa por wamid.
async function applyStatusUpdate(companyId, wamid, status, errorText) {
  if (!wamid) return;
  const allowed = ['sent', 'delivered', 'read', 'failed'];
  if (!allowed.includes(status)) return;
  await db.query(
    `-- wa:outbox-status
     UPDATE wa_outbox SET status = $1, last_error = COALESCE($2, last_error), updated_at = NOW()
      WHERE wa_message_id = $3 AND company_id = $4
        AND status IN ('sent','delivered')`,
    [status, errorText || null, wamid, companyId]
  );
}

// Webhook: aprovação/rejeição de template (message_template_status_update).
async function applyTemplateStatus(companyId, { name, language, status, metaTemplateId }) {
  if (!name || !status) return;
  await db.query(
    `-- wa:template-status
     INSERT INTO wa_templates (company_id, name, language, status, meta_template_id, last_status_at)
     VALUES ($1,$2,COALESCE($3,'pt_BR'),$4,$5,NOW())
     ON CONFLICT (company_id, name, language) DO UPDATE SET
       status = EXCLUDED.status,
       meta_template_id = COALESCE(EXCLUDED.meta_template_id, wa_templates.meta_template_id),
       last_status_at = NOW(), updated_at = NOW()`,
    [companyId, name, language || 'pt_BR', status, metaTemplateId || null]
  );
}

module.exports = {
  normalizePhone, touchInbound, windowOpen, getContact, decryptToken,
  isTokenError, markTokenInvalid, clearTokenInvalid,
  enqueue, processBatch, applyStatusUpdate, applyTemplateStatus,
  MAX_ATTEMPTS,
};
