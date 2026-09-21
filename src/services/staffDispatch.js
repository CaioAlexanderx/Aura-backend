// ============================================================
// AURA. — Pedidos de disparo preparados para aprovação (migration 348)
//
// O Claude grava o pedido (status awaiting_approval); a equipe aprova ou
// recusa no painel. Este módulo NUNCA executa sozinho: approve() só roda
// dentro da rota autenticada, com o usuário de equipe que clicou.
//
//   listRequests()          — aguardando + últimos decididos, com prévia
//   approve(id, user)       — reserva atômica e executa pelo caminho do painel
//   reject(id, user)        — recusa sem executar
//
// Ações (lista branca):
//   notification_email — e-mail de banner de empresa específica
//                        (notificationEmail.sendBannerEmail)
// ============================================================
'use strict';

const db = require('../config/database');
const { sendBannerEmail, listRecipients } = require('./notificationEmail');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTIONS = {
  notification_email: {
    // O que o painel mostra antes de aprovar: banner, empresa, para quem,
    // assunto e o PIX. Destinatários resolvidos como no envio.
    async preview(p) {
      if (!UUID_RE.test(String(p.notification_id || ''))) return { error: 'Banner inválido' };
      const { rows } = await db.query(
        `SELECT id, title, target_company_id, is_active, expires_at FROM app_notifications WHERE id = $1`,
        [p.notification_id]
      );
      if (!rows.length) return { error: 'Banner não encontrado' };
      const n = rows[0];
      const data = n.target_company_id ? await listRecipients(n.target_company_id) : null;
      const known = data ? data.recipients : [];
      const recipients = p.recipients == null
        ? known.filter((r) => r.selected).map((r) => r.email)
        : p.recipients;
      return {
        banner:     { id: n.id, title: n.title, is_active: n.is_active, expires_at: n.expires_at },
        company:    data ? data.company : null,
        recipients,
        subject:    String(p.subject || '').trim() || n.title,
        pix:        p.pix || null,
      };
    },
    async run(p, user) {
      const r = await sendBannerEmail({
        notificationId: p.notification_id,
        recipients:     p.recipients == null ? null : p.recipients,
        subject:        p.subject,
        pix:            p.pix,
        sentBy:         user.id,
      });
      return { ok: r.status === 200, result: { http_status: r.status, ...r.body } };
    },
  },
};

function actionOf(name) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
}

async function listRequests() {
  const { rows } = await db.query(
    `SELECT r.*, u.full_name AS decided_by_name
       FROM staff_dispatch_requests r
       LEFT JOIN users u ON u.id = r.decided_by
      WHERE r.status IN ('awaiting_approval', 'processing')
         OR r.created_at > NOW() - INTERVAL '14 days'
      ORDER BY (r.status = 'awaiting_approval') DESC, r.created_at DESC
      LIMIT 50`
  );
  const out = [];
  for (const r of rows) {
    const a = actionOf(r.action);
    let preview = null;
    if (a && r.status === 'awaiting_approval') {
      try { preview = await a.preview(r.payload || {}); }
      catch (e) { preview = { error: 'Prévia indisponível: ' + e.message }; }
    }
    out.push({
      id: r.id, action: r.action, note: r.note, status: r.status,
      requested_via: r.requested_via, created_at: r.created_at, expires_at: r.expires_at,
      expired: r.status === 'awaiting_approval' && new Date(r.expires_at).getTime() < Date.now(),
      decided_by_name: r.decided_by_name || null, decided_at: r.decided_at,
      result: r.result, error: r.error, preview,
    });
  }
  return out;
}

async function finish(id, status, result, error) {
  await db.query(
    `UPDATE staff_dispatch_requests SET status = $2, result = $3, error = $4 WHERE id = $1`,
    [id, status, result ? JSON.stringify(result) : null, error || null]
  );
}

// Reserva atômica: só um clique (ou uma aba) executa o pedido.
async function approve(id, user) {
  if (!UUID_RE.test(String(id || ''))) return { status: 400, body: { error: 'Pedido inválido' } };
  const { rows } = await db.query(
    `UPDATE staff_dispatch_requests
        SET status = 'processing', decided_by = $2, decided_at = NOW()
      WHERE id = $1 AND status = 'awaiting_approval' AND expires_at > NOW()
     RETURNING *`,
    [id, user.id]
  );
  if (!rows.length) {
    const { rows: cur } = await db.query(`SELECT status, expires_at FROM staff_dispatch_requests WHERE id = $1`, [id]);
    if (!cur.length) return { status: 404, body: { error: 'Pedido não encontrado' } };
    if (cur[0].status === 'awaiting_approval') return { status: 409, body: { error: 'Pedido expirado', code: 'PEDIDO_EXPIRADO' } };
    return { status: 409, body: { error: 'Pedido já decidido', code: 'PEDIDO_JA_DECIDIDO', current_status: cur[0].status } };
  }
  const row = rows[0];
  const a = actionOf(row.action);
  if (!a) {
    await finish(row.id, 'failed', null, 'ACAO_DESCONHECIDA: ' + row.action);
    return { status: 400, body: { error: 'Ação desconhecida', code: 'ACAO_DESCONHECIDA' } };
  }
  try {
    const r = await a.run(row.payload || {}, user);
    await finish(row.id, r.ok ? 'done' : 'failed', r.result, r.ok ? null : (r.result && r.result.error) || 'falhou');
    return { status: r.ok ? 200 : 422, body: { status: r.ok ? 'done' : 'failed', result: r.result } };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    await finish(row.id, 'failed', null, msg).catch(() => {});
    return { status: 500, body: { status: 'failed', error: msg } };
  }
}

async function reject(id, user) {
  if (!UUID_RE.test(String(id || ''))) return { status: 400, body: { error: 'Pedido inválido' } };
  const { rows } = await db.query(
    `UPDATE staff_dispatch_requests
        SET status = 'rejected', decided_by = $2, decided_at = NOW()
      WHERE id = $1 AND status = 'awaiting_approval'
     RETURNING id`,
    [id, user.id]
  );
  if (!rows.length) return { status: 409, body: { error: 'Pedido não está aguardando aprovação', code: 'PEDIDO_JA_DECIDIDO' } };
  return { status: 200, body: { status: 'rejected' } };
}

module.exports = { listRequests, approve, reject, ACTIONS };
