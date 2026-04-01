// ============================================================
// AURA. — Email Service
// Envia emails via SMTP a partir de contato@getaura.com.br
//
// Configurar no Railway:
//   SMTP_HOST=smtp.gmail.com (ou Resend/SendGrid)
//   SMTP_PORT=587
//   SMTP_USER=contato@getaura.com.br
//   SMTP_PASS=app-password
//   SMTP_FROM=Aura. <contato@getaura.com.br>
//
// Alternativa recomendada: Resend (grátis até 100/dia)
//   RESEND_API_KEY=re_xxxx
// ============================================================
const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  // Resend (recomendado — grátis, fácil, suporta domínio custom)
  if (process.env.RESEND_API_KEY) {
    transporter = nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: {
        user: 'resend',
        pass: process.env.RESEND_API_KEY,
      },
    });
    return transporter;
  }

  // SMTP genérico (Gmail, Outlook, etc.)
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    return transporter;
  }

  // Dev fallback: log to console
  transporter = {
    sendMail: async (opts) => {
      console.log('\n📧 [DEV] Email would be sent:');
      console.log(`   To: ${opts.to}`);
      console.log(`   Subject: ${opts.subject}`);
      console.log(`   Code: ${opts.text?.match(/\d{4,6}/)?.[0] || 'N/A'}`);
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

  return t.sendMail({
    from: FROM,
    to,
    subject: `${code} — Seu código de verificação Aura.`,
    text: `Seu código de verificação Aura é: ${code}. Válido por 10 minutos.`,
    html,
  });
}

module.exports = { sendVerificationEmail };
