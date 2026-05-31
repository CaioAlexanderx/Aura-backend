// ============================================================
// AURA. - Email Service
// Resend HTTP API (porta 443) | SMTP fallback | Dev fallback
// ============================================================

// IMPORTANT: FROM must use a verified domain in Resend.
// onboarding@resend.dev = sandbox (only sends to account owner).
// getaura.com.br is verified (DKIM + SPF + MX green).
const FROM_DEFAULT = 'Aura. <noreply@getaura.com.br>';
const FROM = process.env.SMTP_FROM || FROM_DEFAULT;
const ICON_URL = 'https://cdn.jsdelivr.net/gh/CaioAlexanderx/aura-app@main/assets/Icon.png';

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

// -- Template: verificacao de email via LINK --
async function sendVerificationLinkEmail(to, confirmUrl, userName) {
  const firstName = userName ? userName.split(' ')[0] : '';
  const html = emailLayout(`
    <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Ol&aacute;${firstName ? ', ' + firstName : ''}!</p>
    <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 28px;">Confirme seu e-mail clicando no bot&atilde;o abaixo para ativar sua conta na Aura:</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <a href="${confirmUrl}" style="display:inline-block;background:#7c3aed;color:#fff;font-size:16px;font-weight:700;padding:16px 40px;border-radius:12px;text-decoration:none;">Confirmar meu e-mail</a>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#64748b;text-align:center;margin:24px 0 6px;">Ou copie este link:</p>
    <p style="font-size:10px;color:#7c3aed;text-align:center;word-break:break-all;margin:0 0 24px;background:#1e1b4b;padding:10px 14px;border-radius:8px;">${confirmUrl}</p>
    <p style="font-size:11px;color:#64748b;margin:0;">Link v&aacute;lido por <strong style="color:#94a3b8;">1 hora</strong>. Se voc&ecirc; n&atilde;o criou uma conta, ignore este e-mail.</p>
  `);
  return sendMail({
    to,
    subject: 'Confirme seu e-mail - Aura.',
    text: `Ola${firstName ? ' ' + firstName : ''}! Confirme seu e-mail: ${confirmUrl} (valido por 1 hora).`,
    html,
  });
}

// -- Template: verificacao de email via OTP (mantido para compatibilidade) --
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
  `);
  return sendMail({
    to, subject: `${code} - Seu codigo de verificacao Aura.`,
    text: `Seu codigo de verificacao Aura e: ${code}. Valido por 10 minutos.`, html,
  });
}

// -- Template: redefinicao de senha --
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

// -- Template: convite de equipe --
async function sendInviteEmail(to, inviteUrl, companyName, role, inviterName) {
  const roleLabel = role || 'Colaborador';
  const company   = companyName || 'uma empresa';
  const inviter   = inviterName || 'o titular';
  const html = emailLayout(`
    <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Ol&aacute;!</p>
    <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 8px;">
      <strong style="color:#e2e8f0;">${inviter}</strong> convidou voc&ecirc; para entrar na equipe de
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td align="center" style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:14px;padding:18px 24px;">
        <p style="margin:0 0 4px;font-size:20px;font-weight:800;color:#c4b5fd;">${company}</p>
        <p style="margin:0;font-size:13px;color:#7c3aed;">Funcao: <strong>${roleLabel}</strong></p>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr><td align="center">
        <a href="${inviteUrl}" style="display:inline-block;background:#7c3aed;color:#fff;font-size:16px;font-weight:700;padding:16px 40px;border-radius:12px;text-decoration:none;">Aceitar convite</a>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#64748b;text-align:center;margin:0 0 6px;">Ou acesse diretamente:</p>
    <p style="font-size:10px;color:#7c3aed;text-align:center;word-break:break-all;margin:0 0 24px;background:#1e1b4b;padding:10px 14px;border-radius:8px;">${inviteUrl}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0c0d18;border-radius:10px;">
      <tr><td style="padding:14px 16px;">
        <p style="font-size:11px;color:#94a3b8;margin:0 0 4px;">Precisa de uma conta? Crie em segundos na pagina do convite.</p>
        <p style="font-size:11px;color:#64748b;margin:0 0 4px;">Este link expira em <strong style="color:#94a3b8;">7 dias</strong>.</p>
        <p style="font-size:11px;color:#64748b;margin:0;">Se nao esperava este convite, ignore.</p>
      </td></tr>
    </table>
  `);
  return sendMail({
    to,
    subject: `Voce foi convidado para ${company} no Aura.`,
    text: `Voce foi convidado para a equipe de ${company} como ${roleLabel}. Acesse: ${inviteUrl}`,
    html,
  });
}

// -- Template: confirmação de pedido Canal Digital (cliente) --
async function sendOrderConfirmationEmail(to, opts) {
  const { order_number, customer_name, total, pix_payload, pix_expires_at, delivery_type, store_name, items } = opts;
  const firstName     = customer_name ? customer_name.split(' ')[0] : '';
  const fmtR          = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
  const deliveryLabel = delivery_type === 'delivery' ? 'Entrega' : 'Retirada na loja';
  const expiresLabel  = pix_expires_at
    ? new Date(pix_expires_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : '30 min';

  const itemRows = (items || []).map(i =>
    `<tr>
      <td style="padding:6px 0;font-size:13px;color:#94a3b8;">${i.product_name} &times; ${i.quantity}</td>
      <td style="padding:6px 0;font-size:13px;color:#c4b5fd;text-align:right;">${fmtR(i.subtotal)}</td>
    </tr>`
  ).join('');

  const html = emailLayout(`
    <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Pedido recebido, ${firstName || customer_name}!</p>
    <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 20px;">
      Seu pedido <strong style="color:#e2e8f0;">#${order_number}</strong> em
      <strong style="color:#e2e8f0;">${store_name}</strong> foi recebido.
      ${pix_payload ? 'Pague via Pix para confirmar.' : ''}
    </p>
    ${itemRows ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-top:1px solid #1e293b;">
      ${itemRows}
      <tr>
        <td style="padding:10px 0 0;font-size:14px;font-weight:700;color:#e2e8f0;border-top:1px solid #1e293b;">Total</td>
        <td style="padding:10px 0 0;font-size:14px;font-weight:700;color:#7c3aed;text-align:right;border-top:1px solid #1e293b;">${fmtR(total)}</td>
      </tr>
    </table>` : `<p style="font-size:14px;font-weight:700;color:#7c3aed;margin:0 0 16px;">Total: ${fmtR(total)}</p>`}
    <p style="font-size:12px;color:#64748b;margin:0 0 16px;">Modalidade: <strong style="color:#94a3b8;">${deliveryLabel}</strong></p>
    ${pix_payload ? `
    <p style="font-size:13px;color:#94a3b8;margin:0 0 8px;font-weight:600;">🔑 Pix Copia e Cola</p>
    <p style="font-size:10px;color:#7c3aed;word-break:break-all;background:#1e1b4b;padding:12px;border-radius:8px;margin:0 0 8px;">${pix_payload}</p>
    <p style="font-size:11px;color:#64748b;margin:0 0 20px;">Expira &agrave;s <strong style="color:#94a3b8;">${expiresLabel}</strong>. Pague no app do seu banco usando copia e cola.</p>
    ` : ''}
    <p style="font-size:11px;color:#475569;margin:0;">D&uacute;vidas? Entre em contato diretamente com a loja.</p>
  `);

  return sendMail({
    to,
    subject: `Pedido #${order_number} recebido — ${pix_payload ? 'pague via Pix' : 'aguardando confirmação'}`,
    text: `Pedido #${order_number} recebido em ${store_name}. Total: ${fmtR(total)}. ${pix_payload ? 'Pix: ' + pix_payload : ''}`,
    html,
  });
}

// -- Template: atualização de status do pedido Canal Digital (cliente) --
async function sendOrderStatusEmail(to, { order_number, customer_name, status, store_name }) {
  const firstName = customer_name ? customer_name.split(' ')[0] : '';
  const STATUS_INFO = {
    confirmed: { emoji: '✅', label: 'Confirmado',    msg: 'Pagamento confirmado! Seu pedido está sendo preparado.' },
    preparing: { emoji: '👨‍🍳', label: 'Em preparo',    msg: 'Estamos preparando seu pedido agora.' },
    ready:     { emoji: '📦', label: 'Pronto!',       msg: 'Seu pedido está pronto! Pode retirar ou aguardar a entrega.' },
    delivered: { emoji: '🚀', label: 'Entregue',      msg: 'Pedido entregue! Obrigado pela preferência.' },
    cancelled: { emoji: '❌', label: 'Cancelado',    msg: 'Seu pedido foi cancelado. Em caso de dúvidas, contate a loja.' },
  };
  const info = STATUS_INFO[status] || { emoji: '📋', label: status, msg: 'Status do seu pedido foi atualizado.' };

  const html = emailLayout(`
    <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Ol&aacute;, ${firstName || customer_name}!</p>
    <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 20px;">
      Atualiza&ccedil;&atilde;o do seu pedido <strong style="color:#e2e8f0;">#${order_number}</strong>
      em <strong style="color:#e2e8f0;">${store_name}</strong>:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td align="center" style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:14px;padding:24px;">
        <p style="margin:0 0 8px;font-size:40px;">${info.emoji}</p>
        <p style="margin:0 0 8px;font-size:18px;font-weight:800;color:#c4b5fd;">${info.label}</p>
        <p style="margin:0;font-size:13px;color:#94a3b8;">${info.msg}</p>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#475569;margin:0;">Em caso de d&uacute;vidas, entre em contato com a loja diretamente.</p>
  `);

  return sendMail({
    to,
    subject: `${info.emoji} Pedido #${order_number}: ${info.label}`,
    text: `Pedido #${order_number} em ${store_name}: ${info.label}. ${info.msg}`,
    html,
  });
}

// -- Template: novo pedido confirmado (lojista) --
// Enviado ao lojista após pagamento confirmado (Pix, Cartão ou Na Entrega).
async function sendOwnerNewOrderEmail(to, opts) {
  const { order_number, customer_name, customer_phone, total, delivery_type, store_name, payment_method } = opts;
  const fmtR = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
  const deliveryLabel = delivery_type === 'delivery' ? '🚚 Entrega' : '🏪 Retirada na loja';
  const paymentLabel  = payment_method === 'pix' ? 'Pix' :
                        payment_method === 'card' ? 'Cart&atilde;o' : 'Na entrega';

  const phone = customer_phone ? customer_phone.replace(/\D/g, '') : null;
  const whatsappLink = phone
    ? `<a href="https://wa.me/55${phone}" style="color:#7c3aed;text-decoration:none;">Chamar no WhatsApp</a>`
    : '';

  const html = emailLayout(`
    <p style="font-size:15px;color:#e2e8f0;margin:0 0 4px;">📦 Novo pedido confirmado!</p>
    <p style="font-size:13px;color:#94a3b8;margin:0 0 20px;">
      Um novo pedido chegou na sua loja <strong style="color:#e2e8f0;">${store_name}</strong>.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0c0d18;border:1px solid #1e293b;border-radius:14px;margin:0 0 20px;">
      <tr>
        <td style="padding:18px 20px;">
          <p style="margin:0 0 12px;font-size:20px;font-weight:800;color:#c4b5fd;">Pedido #${order_number}</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:5px 0;font-size:12px;color:#64748b;width:100px;">Cliente</td>
              <td style="padding:5px 0;font-size:13px;color:#e2e8f0;font-weight:600;">${customer_name}</td>
            </tr>
            <tr>
              <td style="padding:5px 0;font-size:12px;color:#64748b;">Total</td>
              <td style="padding:5px 0;font-size:15px;color:#7c3aed;font-weight:700;">${fmtR(total)}</td>
            </tr>
            <tr>
              <td style="padding:5px 0;font-size:12px;color:#64748b;">Modalidade</td>
              <td style="padding:5px 0;font-size:13px;color:#e2e8f0;">${deliveryLabel}</td>
            </tr>
            <tr>
              <td style="padding:5px 0;font-size:12px;color:#64748b;">Pagamento</td>
              <td style="padding:5px 0;font-size:13px;color:#34d399;font-weight:600;">${paymentLabel} ✓</td>
            </tr>
            ${phone ? `<tr>
              <td style="padding:5px 0;font-size:12px;color:#64748b;">Contato</td>
              <td style="padding:5px 0;font-size:13px;color:#e2e8f0;">${whatsappLink}</td>
            </tr>` : ''}
          </table>
        </td>
      </tr>
    </table>

    <p style="font-size:12px;color:#64748b;text-align:center;margin:0;">
      Acesse o app Aura para gerenciar o pedido e avanc&oacute; o status conforme o andamento.
    </p>
  `);

  return sendMail({
    to,
    subject: `📦 Pedido #${order_number} confirmado — ${store_name}`,
    text: `Novo pedido #${order_number} confirmado em ${store_name}. Cliente: ${customer_name}. Total: ${fmtR(total)}. Pagamento: ${paymentLabel}. Acesse o app Aura para gerenciar.`,
    html,
  });
}

// -- Template: relatório semanal automático --
async function sendWeeklyReport(company, kpis, reportUrl) {
  function fmtR(v) {
    const n = Math.round(v * 100) / 100;
    const [int, dec] = n.toFixed(2).split('.');
    return 'R$&nbsp;' + int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (dec === '00' ? '' : ',' + dec);
  }

  const url = reportUrl || 'https://app.getaura.com.br';

  const html = emailLayout(`
    <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Seu relat&oacute;rio semanal chegou!</p>
    <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 20px;">
      Aqui est&aacute; o resumo de desempenho de <strong style="color:#e2e8f0;">${company.name}</strong> nesta semana.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #1e293b;">
          <span style="font-size:11px;color:#64748b;letter-spacing:0.8px;text-transform:uppercase;">Receita</span>
          <p style="margin:4px 0 0;font-size:20px;font-weight:700;color:#c4b5fd;">${fmtR(kpis.revenue)}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #1e293b;">
          <span style="font-size:11px;color:#64748b;letter-spacing:0.8px;text-transform:uppercase;">Vendas</span>
          <p style="margin:4px 0 0;font-size:20px;font-weight:700;color:#e2e8f0;">${kpis.sales}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #1e293b;">
          <span style="font-size:11px;color:#64748b;letter-spacing:0.8px;text-transform:uppercase;">Ticket m&eacute;dio</span>
          <p style="margin:4px 0 0;font-size:20px;font-weight:700;color:#e2e8f0;">${fmtR(kpis.avg_ticket)}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 0;">
          <span style="font-size:11px;color:#64748b;letter-spacing:0.8px;text-transform:uppercase;">Sa&uacute;de do neg&oacute;cio</span>
          <p style="margin:4px 0 0;font-size:20px;font-weight:700;color:${kpis.health_score >= 70 ? '#34d399' : kpis.health_score >= 40 ? '#fbbf24' : '#f87171'};">${kpis.health_score}<span style="font-size:13px;color:#64748b;">/100</span></p>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr><td align="center">
        <a href="${url}" style="display:inline-block;background:#7c3aed;color:#fff;font-size:14px;font-weight:700;padding:14px 32px;border-radius:12px;text-decoration:none;">Ver relat&oacute;rio completo &rarr;</a>
      </td></tr>
    </table>

    <p style="font-size:11px;color:#475569;text-align:center;margin:0;">
      Relat&oacute;rio gerado automaticamente toda segunda-feira &agrave;s 8h.<br>
      O link expira em 30 dias.
    </p>
  `);

  return sendMail({
    to: company.email,
    subject: `Relatório semanal — ${company.name}`,
    text: `Aura. — Relatorio semanal de ${company.name}. Receita: R$ ${kpis.revenue} | Vendas: ${kpis.sales} | Ticket medio: R$ ${kpis.avg_ticket} | Saude: ${kpis.health_score}/100\n\nVer relatorio completo: ${url}`,
    html,
  });
}

module.exports = {
  sendVerificationEmail,
  sendVerificationLinkEmail,
  sendPasswordResetEmail,
  sendInviteEmail,
  sendOrderConfirmationEmail,
  sendOrderStatusEmail,
  sendOwnerNewOrderEmail,
  sendWeeklyReport,
};
