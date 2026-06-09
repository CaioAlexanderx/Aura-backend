// ============================================================
// AURA KARATÊ — E-mails (Track I)
// Envia via Resend (mesmo provider do mailer core), porém ISOLADO do
// src/services/mailer.js para não arriscar os e-mails transacionais
// (verificação, reset de senha, pedidos). Mesmo RESEND_API_KEY e domínio
// verificado (getaura.com.br).
//
// sendKarateEmail(...) é a INTERFACE que Track J (certificados) e Track L
// (relatórios) reusam. O layout abaixo é um DEFAULT funcional (Shoji claro)
// até a DESIGN-30 aprovada — ver BRIEF_DESIGN_30_EMAILS_KARATE.md.
// ============================================================
'use strict';

const FROM = process.env.KARATE_SMTP_FROM || process.env.SMTP_FROM || 'Aura Karatê <noreply@getaura.com.br>';
const ICON_URL = 'https://cdn.jsdelivr.net/gh/CaioAlexanderx/aura-app@main/assets/Icon.png';

// Envio cru via Resend. Sem chave (dev), loga e segue — não quebra a régua.
async function sendRaw(opts) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[karateMailer] (dev) e-mail simulado -> ${opts.to}: ${opts.subject}`);
    return { id: 'dev-' + Date.now() };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: opts.from || FROM,
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
  console.log(`[karateMailer] Resend OK: ${data.id} to ${opts.to}`);
  return data;
}

// Layout default (Shoji claro). DESIGN-30 substitui depois.
function layout(content, opts) {
  const fed = (opts && opts.federationName) || 'Federação';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border:1px solid #e6e0d4;border-radius:18px;overflow:hidden;">
        <tr><td style="height:4px;background:#b02a2a;"></td></tr>
        <tr><td align="center" style="padding:28px 32px 0 32px;">
          <img src="${ICON_URL}" width="48" height="48" alt="Aura Karatê" style="display:block;border-radius:12px;" />
          <p style="margin:10px 0 0;font-size:13px;font-weight:800;color:#1c1917;letter-spacing:0.3px;">Aura Karatê</p>
          <p style="margin:2px 0 0;font-size:11px;color:#78716c;">${fed}</p>
        </td></tr>
        <tr><td style="padding:22px 32px 30px 32px;">${content}</td></tr>
        <tr><td style="padding:0 32px 26px 32px;border-top:1px solid #eee7da;">
          <p style="margin:18px 0 0;font-size:11px;color:#a8a29e;text-align:center;line-height:18px;">
            Enviado por Aura Karatê &middot; <a href="https://getaura.com.br" style="color:#b02a2a;text-decoration:none;">getaura.com.br</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function fmtBRL(v) {
  const n = Number(v || 0);
  return 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.').replace(/\.(\d{2})$/, ',$1').replace(/,(\d{3})/g, '.$1');
}
function fmtDateBR(d) {
  try { return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
  catch (_) { return String(d); }
}

// Interface genérica karatê (J e L reusam). Monta heading + corpo + CTA.
async function sendKarateEmail(to, opts) {
  const o = opts || {};
  const cta = o.ctaUrl
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;"><tr><td align="center">
        <a href="${o.ctaUrl}" style="display:inline-block;background:#b02a2a;color:#fff;font-size:14px;font-weight:700;padding:13px 30px;border-radius:10px;text-decoration:none;">${o.ctaLabel || 'Abrir'}</a>
      </td></tr></table>`
    : '';
  const heading = o.heading
    ? `<p style="font-size:16px;font-weight:800;color:#1c1917;margin:0 0 10px;">${o.heading}</p>`
    : '';
  const html = layout(`${heading}${o.bodyHtml || ''}${cta}`, { federationName: o.federationName });
  return sendRaw({ to, from: o.from, subject: o.subject, html, text: o.text || stripHtml(`${o.heading || ''} ${o.bodyHtml || ''} ${o.ctaUrl || ''}`) });
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Template: lembrete/cobrança de anuidade de dojô (régua).
async function sendKarateAnnuityReminderEmail(to, data) {
  const d = data || {};
  const overdue = (d.offset || 0) > 0;
  const heading = overdue ? 'Anuidade vencida' : 'Lembrete de anuidade';
  const quando = overdue
    ? `venceu em <strong>${fmtDateBR(d.dueDate)}</strong>`
    : `vence em <strong>${fmtDateBR(d.dueDate)}</strong>`;
  const periodo = d.referencePeriod ? ` referente a ${d.referencePeriod}` : '';
  const bodyHtml = `
    <p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 14px;">Olá${d.dojoName ? ', ' + d.dojoName : ''}!</p>
    <p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 14px;">
      A anuidade${periodo} no valor de <strong>${fmtBRL(d.amount)}</strong> ${quando}.
    </p>
    <p style="font-size:13px;color:#78716c;line-height:21px;margin:0;">
      Para manter o dojô em dia com a federação, faça o pagamento e registre o comprovante.
    </p>`;
  return sendKarateEmail(to, {
    subject: overdue
      ? `Anuidade vencida — ${fmtBRL(d.amount)}`
      : `Lembrete: anuidade de ${fmtBRL(d.amount)} a vencer`,
    heading,
    bodyHtml,
    ctaLabel: d.ctaUrl ? (d.ctaLabel || 'Ver anuidade') : undefined,
    ctaUrl: d.ctaUrl,
    federationName: d.federationName,
  });
}

module.exports = {
  sendRaw,
  layout,
  sendKarateEmail,
  sendKarateAnnuityReminderEmail,
  fmtBRL,
  fmtDateBR,
};
