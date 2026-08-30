// ============================================================
// AURA. — igOutbox.js
// Fila de envio de DMs do Instagram — espelho da wa_outbox (307),
// adaptada às regras do canal:
//  - Janela de 24h vem de hub_conversations.last_inbound_at (a Meta só
//    aceita resposta via API dentro de 24h do último inbound; Human
//    Agent estende p/ 7 dias APÓS handoff — fase 2, exige App Review).
//  - Modo aprovação: linha nasce 'pending_approval' e só entra na fila
//    quando um humano aprova (vira 'pending').
//  - Reforço no envio: conversa que deixou de ser da IA não envia
//    sugestão antiga da Aurinha (CONVERSA_NAO_IA).
//  - Credenciais: companies.ig_account_id + ig_access_token (061).
//    Suporta token cifrado 'v1:' (mesmo cofre do WhatsApp).
// ============================================================
'use strict';

const db = require('../config/database');
const ig = require('./instagram');
const { decryptToken, isTokenError } = require('./waOutbox');

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 24 * 3600 * 1000;

async function loadCreds(companyId) {
  try {
    const { rows } = await db.query(
      `-- ig:creds
       SELECT ig_account_id, ig_access_token FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    const r = rows[0];
    if (!r || !r.ig_account_id || !r.ig_access_token) return null;
    return { igAccountId: r.ig_account_id, accessToken: decryptToken(r.ig_access_token) };
  } catch (e) {
    if (e.code === '42703') return null;
    throw e;
  }
}

function windowOpen(lastInboundAt) {
  return !!(lastInboundAt && Date.now() - new Date(lastInboundAt).getTime() < WINDOW_MS);
}

// Enfileira uma DM. needsApproval=true → 'pending_approval' (modo piloto).
// humano=true (source 'humano') pula aprovação por definição.
async function enqueue({
  companyId, conversationId = null, toIgId, textBody,
  payload = null, sourceType = null, sourceId = null, dedupeKey = null,
  needsApproval = false,
}) {
  if (!toIgId || !textBody) return { queued: false, reason: 'DADOS_INCOMPLETOS' };
  const status = needsApproval ? 'pending_approval' : 'pending';
  const { rows } = await db.query(
    `-- ig:outbox-enqueue
     INSERT INTO ig_outbox
       (company_id, conversation_id, to_ig_id, text_body, payload, status,
        source_type, source_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, status`,
    [companyId, conversationId, toIgId, textBody,
     payload ? JSON.stringify(payload) : null, status, sourceType, sourceId, dedupeKey]
  );
  if (!rows.length) return { queued: false, reason: 'DUPLICADO' };
  return { queued: status === 'pending', id: rows[0].id, status };
}

async function markRow(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${i++}`); vals.push(v); }
  vals.push(id);
  await db.query(`UPDATE ig_outbox SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals);
}

// Processa até `limit` itens 'pending' vencidos. Chamado pelo igDispatcherJob.
async function processBatch(limit = 20) {
  const { rows } = await db.query(
    `-- ig:outbox-pick
     SELECT o.*, c.last_inbound_at AS conv_last_inbound_at, c.status AS conv_status
       FROM ig_outbox o
       LEFT JOIN hub_conversations c ON c.id = o.conversation_id
      WHERE o.status = 'pending' AND o.next_attempt_at <= NOW()
      ORDER BY o.created_at ASC LIMIT $1`,
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
      // Reforço NO ENVIO: janela pode ter fechado na fila.
      if (row.conversation_id && !windowOpen(row.conv_last_inbound_at)) {
        await markRow(row.id, { status: 'skipped', skip_reason: 'JANELA_FECHADA' });
        out.skipped++;
        continue;
      }
      // Sugestão da Aurinha para conversa que a equipe assumiu não sai —
      // o humano decide o que dizer. (Mensagens do próprio humano têm
      // source_type 'humano' e passam.)
      if (row.source_type === 'aurinha' && row.conv_status && row.conv_status !== 'ia'
          && row.conv_status !== 'precisa_humano') {
        await markRow(row.id, { status: 'skipped', skip_reason: 'CONVERSA_NAO_IA' });
        out.skipped++;
        continue;
      }

      const body = row.edited_body || row.text_body || '';
      const resp = await ig.sendText(creds.igAccountId, creds.accessToken, row.to_ig_id, body);
      const mid = (resp && resp.message_id) || null;
      await markRow(row.id, { status: 'sent', ig_message_id: mid, last_error: null });
      out.sent++;

      // Espelho em ig_messages (061) — histórico da conversa, best-effort.
      db.query(
        `INSERT INTO ig_messages (company_id, direction, ig_message_id, to_ig_id, content, status, metadata, conversation_id)
         VALUES ($1,'outbound',$2,$3,$4,'sent',$5,$6)
         ON CONFLICT (ig_message_id) DO NOTHING`,
        [row.company_id, mid, row.to_ig_id, body,
         JSON.stringify({ outbox_id: row.id, source_type: row.source_type }),
         row.conversation_id]
      ).catch(() => {});
      if (row.conversation_id) {
        db.query(
          `UPDATE hub_conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [row.conversation_id]
        ).catch(() => {});
      }
    } catch (e) {
      const attempts = (row.attempts || 0) + 1;
      const msg = String(e && e.message || e).slice(0, 500);
      if (isTokenError(e)) {
        // Credencial IG recusada: não temos ainda o carimbo ig_token_invalid_*
        // (equivalente da 309) — loga alto para aparecer no Railway.
        console.error(`[igOutbox] token IG recusado company=${row.company_id}: ${msg}`);
      }
      if (attempts >= MAX_ATTEMPTS) {
        await markRow(row.id, { status: 'failed', attempts, last_error: msg });
        out.failed++;
      } else {
        const backoffMin = Math.min(Math.pow(2, attempts), 60);
        await db.query(
          `UPDATE ig_outbox SET attempts = $1, last_error = $2,
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

// Modo aprovação: humano aprova (opcionalmente com texto editado) → 'pending'.
async function approve(companyId, outboxId, userId, editedBody = null) {
  const { rows } = await db.query(
    `UPDATE ig_outbox
        SET status = 'pending', approved_by = $3, edited_body = $4,
            next_attempt_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND status = 'pending_approval'
      RETURNING id, conversation_id`,
    [outboxId, companyId, userId, editedBody]
  );
  return rows[0] || null;
}

async function reject(companyId, outboxId, userId) {
  const { rows } = await db.query(
    `UPDATE ig_outbox
        SET status = 'rejected', approved_by = $3, updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND status = 'pending_approval'
      RETURNING id, conversation_id`,
    [outboxId, companyId, userId]
  );
  return rows[0] || null;
}

module.exports = { enqueue, processBatch, approve, reject, loadCreds, windowOpen, MAX_ATTEMPTS };
