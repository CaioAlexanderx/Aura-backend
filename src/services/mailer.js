// ============================================================
// AURA. - Email Service
// Resend HTTP API (porta 443) | SMTP fallback | Dev fallback
// ============================================================

const FROM_DEFAULT = 'Aura. <onboarding@resend.dev>';
const FROM = process.env.SMTP_FROM || FROM_DEFAULT;
const ICON_URL = 'https://cdn.jsdelivr.net/gh/CaioAlexanderx/aura-app@main/assets/Icon.png';

// Layout padrao
function emailLayout(content) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#08090f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#08090f;padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#0f1019;border:1px solid #1e1b4b;border-radius:20px;overflow:hidden;">
        <tr><td style="height:4px;background:linear-gradient(90deg,#7c3aed,#a78bfa,#7c3aed);"></td></tr>
        <tr><td align="center" style="padding:32px 32px 0 32px;">
          <img src="${ICON_URL}" width="56" height="56" alt="Aura." style="display:block;border-radius:14px;" />
          <p style="margin:12px 0 0;font-size:22px;font-weight:800;color:#e2e8f0;letter-spacing:-0.5px;">Aura<span style="color:#7c3aed;">.</span></p>
        </td></tr>
        <tr><td style="padding:24px 32px 32px 32px;">${content}</td></tr>
        <tr><td style="padding:0 32px 28px 32px;border-top:1px solid #1e293b;">
          <p style="margin:20px 0 0;font-size:11px;color:#475569;text-align:center;line-height:18px;">
            Aura. &middot; Tecnologia para Neg&oacute;cios<br>
            <a href="https://getaura.com.br" style="color:#7c3aed;text-decoration:none;">getaura.com.br</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Resend HTTP API
async function sendViaResend(opts) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Resend API ${res.status}: ${err.message || JSON.stringify(err)}`);
  }
  const data = await res.json();
  console.log(`[mailer] Resend OK: ${data.id} to ${opts.to}`);
  return data;
}

// SMTP fallback
let _smtpTransporter = null;
function getSmtpTransporter() {
  if (_smtpTransporter) return _smtpTransporter;
  if (!process.env.SMTP_HOST) return null;
  const nodemailer = require('nodemailer');
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = port === 465 || process.env.SMTP_SECURE === 'true';
  _smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
  });
  return _smtpTransporter;
}

// Dev fallback
async function sendViaDev(opts) {
  console.log('\n[DEV] Email simulado:');
  console.log(`  To: ${opts.to}`);
  console.log(`  Subject: ${opts.subject}`);
  console.log(`  Link/Code: ${opts.text?.match(/(https?:\/\/\S+|\d{4,6})/)?.[0] || 'N/A'}`);
  return { id: 'dev-' + Date.now() };
}

// Envio unificado
async function sendMail(opts) {
  if (process.env.RESEND_API_KEY) return sendViaResend(opts);
  const smtp = getSmtpTransporter();
  if (smtp) return smtp.sendMail({ from: FROM, ...opts });
  return sendViaDev(opts);
}

// ── Template: verificacao de email ──────────────────────────
async function sendVerificationEmail(to, code, userName) {
  const firstName = userName ? userName.split(' ')[0] : '';
  const html = emailLayout(`
    <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Ol&aacute;${firstName ? ', ' + firstName : ''}!</p>
    <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 24px;">Use o c&oacute;digo abaixo para verificar seu e-mail:</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center" style="background:#1e1b4b;border:2px solid #7c3aed;border-radius:14px;padding:22px;">
        <span style="font-size:36px;font-weight:800;letter-spacing:10px;color:#c4b5fd;font-family:'Courier New',monospace;">${code}</span>
      </td></tr>
    </table>
    <p style="font-size:12px;color:#64748b;text-align:center;margin:20px 0 4px;">Este c&oacute;digo expira em <strong style="color:#94a3b8;">10 minutos</strong>.</p>
    <p style="font-size:11px;color:#475569;text-align:center;margin:0;">Se voc&ecirc; n&atilde;o solicitou, ignore este e-mail.</p>
  `);
  return sendMail({
    to, subject: `${code} - Seu codigo de verificacao Aura.`,
    text: `Seu codigo de verificacao Aura e: ${code}. Valido por 10 minutos.`, html,
  });
}

// ── Template: redefinicao de senha ──────────────────────────
async function sendPasswordResetEmail(to, resetUrl, userName) {
  const firstName = userName ? userName.split(' ')[0] : '';
  const html = emailLayout(`
    <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Ol&aacute;${firstName ? ', ' + firstName : ''}!</p>
    <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 28px;">Recebemos uma solicita&ccedil;&atilde;o para redefinir sua senha. Clique no bot&atilde;o abaixo:</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <a href="${resetUrl}" style="display:inline-block;background:#7c3aed;color:#fff;font-size:15px;font-weight:700;padding:15px 36px;border-radius:12px;text-decoration:none;">Redefinir minha senha</a>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#64748b;text-align:center;margin:24px 0 6px;">Ou copie este link:</p>
    <p style="font-size:10px;color:#7c3aed;text-align:center;word-break:break-all;margin:0 0 24px;background:#1e1b4b;padding:10px 14px;border-radius:8px;">${resetUrl}</p>
    <p style="font-size:11px;color:#64748b;margin:0;">Link expira em <strong style="color:#94a3b8;">30 minutos</strong>. Se nao solicitou, ignore.</p>
  `);
  return sendMail({
    to, subject: 'Redefina sua senha - Aura.',
    text: `Ola${firstName ? ' ' + firstName : ''}! Redefina sua senha: ${resetUrl} (valido por 30 minutos).`, html,
  });
}

// ── Template: convite de equipe ─────────────────────────────
async function sendInviteEmail(to, inviteUrl, companyName, role, inviterName) {
  const roleLabel = role || 'Colaborador';
  const company   = companyName || 'uma empresa';
  const inviter   = inviterName || 'o titular';

  const html = emailLayout(`
    <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Ol&aacute;!</p>
    <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 8px;">
      <strong style="color:#e2e8f0;">${inviter}</strong> convidou voc&ecirc; para entrar na equipe de
    </p>

    <!-- Destaque da empresa -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td align="center" style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:14px;padding:18px 24px;">
        <p style="margin:0 0 4px;font-size:20px;font-weight:800;color:#c4b5fd;">${company}</p>
        <p style="margin:0;font-size:13px;color:#7c3aed;">Funcao: <strong>${roleLabel}</strong></p>
      </td></tr>
    </table>

    <!-- CTA -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr><td align="center">
        <a href="${inviteUrl}" style="display:inline-block;background:#7c3aed;color:#fff;font-size:16px;font-weight:700;padding:16px 40px;border-radius:12px;text-decoration:none;">Aceitar convite</a>
      </td></tr>
    </table>

    <!-- Link texto -->
    <p style="font-size:11px;color:#64748b;text-align:center;margin:0 0 6px;">Ou acesse diretamente:</p>
    <p style="font-size:10px;color:#7c3aed;text-align:center;word-break:break-all;margin:0 0 24px;background:#1e1b4b;padding:10px 14px;border-radius:8px;">${inviteUrl}</p>

    <!-- Info box -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0c0d18;border-radius:10px;">
      <tr><td style="padding:14px 16px;">
        <p style="font-size:11px;color:#94a3b8;margin:0 0 4px;">
          Precisa de uma conta? Crie em segundos na pagina do convite.
        </p>
        <p style="font-size:11px;color:#64748b;margin:0 0 4px;">
          Este link expira em <strong style="color:#94a3b8;">7 dias</strong> e e de uso unico.
        </p>
        <p style="font-size:11px;color:#64748b;margin:0;">
          Se nao esperava este convite, pode ignorar este e-mail.
        </p>
      </td></tr>
    </table>
  `);

  return sendMail({
    to,
    subject: `Voce foi convidado para ${company} no Aura.`,
    text: `Ola! Voce foi convidado para a equipe de ${company} como ${roleLabel}. Acesse o link para aceitar: ${inviteUrl} (valido por 7 dias).`,
    html,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendInviteEmail };
