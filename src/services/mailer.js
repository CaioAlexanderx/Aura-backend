// ============================================================
// AURA. — Email Service
// Resend: HTTP API (porta 443, nunca bloqueada)
// Fallback: SMTP via nodemailer | Dev: console.log
// ============================================================

const FROM_DEFAULT = 'Aura. <onboarding@resend.dev>';
const FROM = process.env.SMTP_FROM || FROM_DEFAULT;

// ── Resend HTTP API (preferred — no SMTP ports needed) ──────
async function sendViaResend(opts) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
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
  console.log(`[mailer] Resend OK: ${data.id} → ${opts.to}`);
  return data;
}

// ── SMTP fallback (nodemailer) ──────────────────────────────
let _smtpTransporter = null;
function getSmtpTransporter() {
  if (_smtpTransporter) return _smtpTransporter;
  if (!process.env.SMTP_HOST) return null;

  const nodemailer = require('nodemailer');
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = port === 465 || process.env.SMTP_SECURE === 'true';
  _smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });
  console.log(`[mailer] SMTP configured: ${process.env.SMTP_HOST}:${port}`);
  return _smtpTransporter;
}

// ── Dev fallback ────────────────────────────────────────────
async function sendViaDev(opts) {
  console.log('\n📧 [DEV] Email would be sent:');
  console.log(`   To: ${opts.to}`);
  console.log(`   Subject: ${opts.subject}`);
  console.log(`   Link/Code: ${opts.text?.match(/(https?:\/\/\S+|\d{4,6})/)?.[0] || 'N/A'}`);
  return { id: 'dev-' + Date.now() };
}

// ── Unified send ────────────────────────────────────────────
async function sendMail(opts) {
  // 1. Try Resend HTTP API first (always works on cloud hosts)
  if (process.env.RESEND_API_KEY) {
    return sendViaResend(opts);
  }

  // 2. Try SMTP
  const smtp = getSmtpTransporter();
  if (smtp) {
    return smtp.sendMail({ from: FROM, ...opts });
  }

  // 3. Dev fallback
  return sendViaDev(opts);
}

// ── Email templates ─────────────────────────────────────────

async function sendVerificationEmail(to, code, userName) {
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0a0b14; color: #e2e8f0; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-weight: 800; color: #e2e8f0;">Aura</span><span style="font-size: 28px; font-weight: 800; color: #7c3aed;">.</span>
      </div>
      <p style="font-size: 16px; color: #e2e8f0; margin-bottom: 8px;">Olá${userName ? ', ' + userName.split(' ')[0] : ''}!</p>
      <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px;">Use o código abaixo para verificar seu e-mail na Aura:</p>
      <div style="background: #1e1b4b; border: 2px solid #7c3aed; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #c4b5fd;">${code}</span>
      </div>
      <p style="font-size: 12px; color: #64748b; text-align: center;">Este código expira em <strong>10 minutos</strong>.</p>
      <p style="font-size: 12px; color: #64748b; text-align: center;">Se você não solicitou este código, ignore este e-mail.</p>
      <hr style="border: none; border-top: 1px solid #1e293b; margin: 24px 0;" />
      <p style="font-size: 11px; color: #475569; text-align: center;">Aura. · Tecnologia para Negócios · getaura.com.br</p>
    </div>
  `;

  return sendMail({
    to,
    subject: `${code} — Seu código de verificação Aura.`,
    text: `Seu código de verificação Aura é: ${code}. Válido por 10 minutos.`,
    html,
  });
}

async function sendPasswordResetEmail(to, resetUrl, userName) {
  const firstName = userName ? userName.split(' ')[0] : '';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0a0b14; color: #e2e8f0; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-weight: 800; color: #e2e8f0;">Aura</span><span style="font-size: 28px; font-weight: 800; color: #7c3aed;">.</span>
      </div>
      <p style="font-size: 16px; color: #e2e8f0; margin-bottom: 8px;">Olá${firstName ? ', ' + firstName : ''}!</p>
      <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px;">Recebemos uma solicitação para redefinir sua senha. Clique no botão abaixo para criar uma nova senha:</p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${resetUrl}" style="display: inline-block; background: #7c3aed; color: #fff; font-size: 15px; font-weight: 700; padding: 14px 32px; border-radius: 12px; text-decoration: none;">Redefinir minha senha</a>
      </div>
      <p style="font-size: 12px; color: #64748b; text-align: center; margin-bottom: 8px;">Ou copie e cole este link no navegador:</p>
      <p style="font-size: 11px; color: #7c3aed; text-align: center; word-break: break-all; margin-bottom: 24px;">${resetUrl}</p>
      <p style="font-size: 12px; color: #64748b; text-align: center;">Este link expira em <strong>30 minutos</strong>.</p>
      <p style="font-size: 12px; color: #64748b; text-align: center;">Se você não solicitou esta alteração, ignore este e-mail. Sua senha continua segura.</p>
      <hr style="border: none; border-top: 1px solid #1e293b; margin: 24px 0;" />
      <p style="font-size: 11px; color: #475569; text-align: center;">Aura. · Tecnologia para Negócios · getaura.com.br</p>
    </div>
  `;

  return sendMail({
    to,
    subject: 'Redefina sua senha — Aura.',
    text: `Olá${firstName ? ' ' + firstName : ''}! Clique neste link para redefinir sua senha: ${resetUrl} (válido por 30 minutos).`,
    html,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
