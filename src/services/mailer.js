// ============================================================
// AURA. — Email Service
// Envia emails via SMTP a partir de contato@getaura.com.br
// ============================================================
const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (process.env.RESEND_API_KEY) {
    transporter = nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
    });
    return transporter;
  }

  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    return transporter;
  }

  // Dev fallback: log to console
  transporter = {
    sendMail: async (opts) => {
      console.log('\n\ud83d\udce7 [DEV] Email would be sent:');
      console.log(`   To: ${opts.to}`);
      console.log(`   Subject: ${opts.subject}`);
      console.log(`   Link/Code: ${opts.text?.match(/(https?:\/\/\S+|\d{4,6})/)?.[0] || 'N/A'}`);
      return { messageId: 'dev-' + Date.now() };
    },
  };
  return transporter;
}

const FROM = process.env.SMTP_FROM || 'Aura. <contato@getaura.com.br>';

async function sendVerificationEmail(to, code, userName) {
  const t = getTransporter();
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0a0b14; color: #e2e8f0; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-weight: 800; color: #e2e8f0;">Aura</span><span style="font-size: 28px; font-weight: 800; color: #7c3aed;">.</span>
      </div>
      <p style="font-size: 16px; color: #e2e8f0; margin-bottom: 8px;">Ol\u00e1${userName ? ', ' + userName.split(' ')[0] : ''}!</p>
      <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px;">Use o c\u00f3digo abaixo para verificar seu e-mail na Aura:</p>
      <div style="background: #1e1b4b; border: 2px solid #7c3aed; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #c4b5fd;">${code}</span>
      </div>
      <p style="font-size: 12px; color: #64748b; text-align: center;">Este c\u00f3digo expira em <strong>10 minutos</strong>.</p>
      <p style="font-size: 12px; color: #64748b; text-align: center;">Se voc\u00ea n\u00e3o solicitou este c\u00f3digo, ignore este e-mail.</p>
      <hr style="border: none; border-top: 1px solid #1e293b; margin: 24px 0;" />
      <p style="font-size: 11px; color: #475569; text-align: center;">Aura. \u00b7 Tecnologia para Neg\u00f3cios \u00b7 getaura.com.br</p>
    </div>
  `;

  return t.sendMail({
    from: FROM,
    to,
    subject: `${code} \u2014 Seu c\u00f3digo de verifica\u00e7\u00e3o Aura.`,
    text: `Seu c\u00f3digo de verifica\u00e7\u00e3o Aura \u00e9: ${code}. V\u00e1lido por 10 minutos.`,
    html,
  });
}

async function sendPasswordResetEmail(to, resetUrl, userName) {
  const t = getTransporter();
  const firstName = userName ? userName.split(' ')[0] : '';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0a0b14; color: #e2e8f0; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-weight: 800; color: #e2e8f0;">Aura</span><span style="font-size: 28px; font-weight: 800; color: #7c3aed;">.</span>
      </div>
      <p style="font-size: 16px; color: #e2e8f0; margin-bottom: 8px;">Ol\u00e1${firstName ? ', ' + firstName : ''}!</p>
      <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px;">Recebemos uma solicita\u00e7\u00e3o para redefinir sua senha. Clique no bot\u00e3o abaixo para criar uma nova senha:</p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${resetUrl}" style="display: inline-block; background: #7c3aed; color: #fff; font-size: 15px; font-weight: 700; padding: 14px 32px; border-radius: 12px; text-decoration: none;">Redefinir minha senha</a>
      </div>
      <p style="font-size: 12px; color: #64748b; text-align: center; margin-bottom: 8px;">Ou copie e cole este link no navegador:</p>
      <p style="font-size: 11px; color: #7c3aed; text-align: center; word-break: break-all; margin-bottom: 24px;">${resetUrl}</p>
      <p style="font-size: 12px; color: #64748b; text-align: center;">Este link expira em <strong>30 minutos</strong>.</p>
      <p style="font-size: 12px; color: #64748b; text-align: center;">Se voc\u00ea n\u00e3o solicitou esta altera\u00e7\u00e3o, ignore este e-mail. Sua senha continua segura.</p>
      <hr style="border: none; border-top: 1px solid #1e293b; margin: 24px 0;" />
      <p style="font-size: 11px; color: #475569; text-align: center;">Aura. \u00b7 Tecnologia para Neg\u00f3cios \u00b7 getaura.com.br</p>
    </div>
  `;

  return t.sendMail({
    from: FROM,
    to,
    subject: 'Redefina sua senha \u2014 Aura.',
    text: `Ol\u00e1${firstName ? ' ' + firstName : ''}! Clique neste link para redefinir sua senha: ${resetUrl} (v\u00e1lido por 30 minutos).`,
    html,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
