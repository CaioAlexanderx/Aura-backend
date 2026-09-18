// ============================================================
// AURA. — E-mail de notificação de empresa específica
//
// Mockup aprovado pelo Caio em 18/09/2026. A Gestão Aura (Endomarketing)
// publica um banner para UMA empresa e pode mandá-lo também por e-mail.
// O e-mail NÃO reaproveita a peça HTML do sino: Gmail e Outlook barram
// iframe, script e imagem data:. Ele é montado aqui, no mesmo layout dos
// outros e-mails da Aura, com título, texto, botão e — opcional — um
// bloco de cobrança PIX (valor, vencimento, QR Code e copia e cola).
//
//   listRecipients(companyId)             — quem pode receber
//   buildNotificationEmail({...})         — { html, text, attachments }
//   sendNotificationEmails({...})         — envia 1 e-mail por endereço
//                                           e registra cada tentativa
//
// Um e-mail por destinatário (e não todos no mesmo "to"): um endereço
// não vê o outro, e a falha de um não derruba os demais.
//
// Registro em app_notification_emails (migration 347). Se a tabela ainda
// não existe, o e-mail sai do mesmo jeito e o registro é pulado — CLAUDE.md,
// armadilha 1.
// ============================================================
'use strict';

const QRCode = require('qrcode');
const db     = require('../config/database');
const { sendMail, emailLayout, escapeHtml } = require('./mailer');

const QR_CID = 'pix-qrcode';
const MAX_RECIPIENTS = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

// ── Destinatários ─────────────────────────────────────────────
// Dono da conta e e-mail da empresa vêm marcados; membros ativos da
// equipe entram desmarcados. Endereço repetido aparece uma vez só, com
// as origens somadas ("owner" + "company").
async function listRecipients(companyId) {
  const { rows: comp } = await db.query(
    `SELECT c.id, c.trade_name, c.legal_name, c.vertical, c.email AS company_email,
            u.email AS owner_email, u.full_name AS owner_name
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.id = $1`,
    [companyId]
  );
  if (!comp.length) return null;
  const c = comp[0];

  const { rows: members } = await db.query(
    `SELECT u.email, u.full_name
       FROM company_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.company_id = $1
        AND m.is_active = true
        AND (m.status IS NULL OR m.status = 'active')
        AND u.email IS NOT NULL`,
    [companyId]
  );

  const byEmail = new Map();
  function add(email, source, name, selected) {
    const key = normEmail(email);
    if (!EMAIL_RE.test(key)) return;
    const cur = byEmail.get(key);
    if (cur) {
      if (!cur.sources.includes(source)) cur.sources.push(source);
      cur.selected = cur.selected || selected;
      if (!cur.name && name) cur.name = name;
      return;
    }
    byEmail.set(key, { email: key, sources: [source], name: name || null, selected });
  }
  add(c.owner_email, 'owner', c.owner_name, true);
  add(c.company_email, 'company', null, true);
  for (const m of members) add(m.email, 'member', m.full_name, false);

  return {
    company: {
      id:         c.id,
      name:       c.trade_name || c.legal_name || null,
      legal_name: c.legal_name || null,
      vertical:   c.vertical || null,
    },
    recipients: Array.from(byEmail.values()),
  };
}

// ── Validação do bloco PIX ───────────────────────────────────
// Devolve { pix } normalizado ou { error }. Tudo vazio = sem bloco PIX.
function parsePix(raw) {
  if (!raw) return { pix: null };
  const code   = String(raw.code || '').trim();
  const amount = raw.amount == null || raw.amount === '' ? null : Number(raw.amount);
  const due    = String(raw.due_date || '').trim();
  if (!code && amount == null && !due) return { pix: null };

  if (!code) return { error: 'Informe o código PIX copia e cola' };
  if (!code.startsWith('000201') || code.length > 512 || /\s{2,}|[\r\n]/.test(code)) {
    return { error: 'Código PIX copia e cola inválido' };
  }
  if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
    return { error: 'Valor da cobrança inválido' };
  }
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return { error: 'Vencimento deve estar no formato AAAA-MM-DD' };
  }
  return { pix: { code, amount, dueDate: due || null } };
}

function fmtBRL(v) {
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// http(s) apenas — link do botão vai para a caixa de entrada do cliente.
function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

// ── Montagem ─────────────────────────────────────────────────
async function buildNotificationEmail({ title, body, ctaLabel, ctaUrl, pix }) {
  const url = safeUrl(ctaUrl);
  const bodyHtml = body
    ? `<p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 18px;">${escapeHtml(body).replace(/\n/g, '<br>')}</p>`
    : '';

  let pixHtml = '';
  const attachments = [];
  if (pix) {
    const facts = [];
    if (pix.amount != null) facts.push(['Valor', fmtBRL(pix.amount)]);
    if (pix.dueDate)        facts.push(['Vencimento', fmtDate(pix.dueDate)]);
    const factCells = facts.map(([lbl, val], i) => `
          ${i > 0 ? '<td style="width:10px;"></td>' : ''}
          <td style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:12px;padding:12px 14px;">
            <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">${lbl}</p>
            <p style="margin:4px 0 0;font-size:20px;font-weight:800;color:#c4b5fd;">${escapeHtml(val)}</p>
          </td>`).join('');

    const png = await QRCode.toBuffer(pix.code, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 400 });
    attachments.push({ filename: 'pix-qrcode.png', content: png, cid: QR_CID });

    pixHtml = `
    ${facts.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;"><tr>${factCells}
    </tr></table>` : ''}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;"><tr><td align="center">
      <table cellpadding="0" cellspacing="0"><tr><td style="background:#ffffff;border-radius:16px;padding:12px;">
        <img src="cid:${QR_CID}" width="200" height="200" alt="QR Code PIX" style="display:block;" />
      </td></tr></table>
      <p style="margin:10px 0 0;font-size:12px;color:#94a3b8;">Abra o app do banco, escolha <strong style="color:#e2e8f0;">Pagar com PIX</strong> e escaneie.</p>
    </td></tr></table>
    <p style="margin:0 0 6px;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">PIX copia e cola</p>
    <p style="margin:0 0 20px;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:18px;color:#e2e8f0;background:#1a1a28;border:1px dashed #4c1d95;border-radius:10px;padding:10px 12px;word-break:break-all;">${escapeHtml(pix.code)}</p>`;
  }

  const ctaHtml = ctaLabel && url ? `
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <a href="${escapeHtml(url)}" style="display:inline-block;background:#7c3aed;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:12px;">${escapeHtml(ctaLabel)}</a>
    </td></tr></table>` : '';

  const html = emailLayout(`
    <p style="font-size:18px;font-weight:800;color:#e2e8f0;margin:0 0 8px;">${escapeHtml(title)}</p>
    ${bodyHtml}${pixHtml}${ctaHtml}
    <p style="font-size:11px;color:#64748b;margin:20px 0 0;text-align:center;">D&uacute;vidas? <a href="mailto:contato@getaura.com.br" style="color:#7c3aed;text-decoration:none;">contato@getaura.com.br</a></p>
  `);

  const text = [
    title,
    body || '',
    pix && pix.amount != null ? `Valor: ${fmtBRL(pix.amount)}` : '',
    pix && pix.dueDate ? `Vencimento: ${fmtDate(pix.dueDate)}` : '',
    pix ? `PIX copia e cola: ${pix.code}` : '',
    ctaLabel && url ? `${ctaLabel}: ${url}` : '',
    'Dúvidas: contato@getaura.com.br',
  ].filter(Boolean).join('\n\n');

  return { html, text, attachments };
}

// ── Envio + registro ─────────────────────────────────────────
let _logTableMissing = false;

async function logAttempt(row) {
  if (_logTableMissing) return;
  try {
    await db.query(
      `INSERT INTO app_notification_emails
         (notification_id, company_id, recipient, subject, status, provider_id, error, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.notificationId, row.companyId, row.recipient, row.subject,
       row.status, row.providerId || null, row.error || null, row.sentBy || null]
    );
  } catch (err) {
    if (err.code === '42P01') {
      _logTableMissing = true;
      console.error('[notificationEmail] migration 347 ausente: envio sem registro');
      return;
    }
    console.error('[notificationEmail] falha ao registrar envio:', err.message);
  }
}

async function sendNotificationEmails({ notification, recipients, subject, pix, sentBy }) {
  const email = await buildNotificationEmail({
    title:    notification.title,
    body:     notification.body,
    ctaLabel: notification.cta_label,
    ctaUrl:   notification.cta_url,
    pix,
  });

  const sent = [];
  const failed = [];
  for (const to of recipients) {
    try {
      const r = await sendMail({ to, subject, html: email.html, text: email.text, attachments: email.attachments });
      const providerId = (r && (r.id || r.messageId)) || null;
      sent.push({ email: to, provider_id: providerId });
      await logAttempt({ notificationId: notification.id, companyId: notification.target_company_id,
        recipient: to, subject, status: 'sent', providerId, sentBy });
    } catch (err) {
      console.error('[notificationEmail] envio falhou para um destinatário:', err.message);
      failed.push({ email: to, error: err.message });
      await logAttempt({ notificationId: notification.id, companyId: notification.target_company_id,
        recipient: to, subject, status: 'failed', error: String(err.message).slice(0, 500), sentBy });
    }
  }
  return { sent, failed };
}

module.exports = {
  listRecipients,
  parsePix,
  buildNotificationEmail,
  sendNotificationEmails,
  normEmail,
  MAX_RECIPIENTS,
  _resetForTests() { _logTableMissing = false; },
};
