// ============================================================
// AURA KARATÊ — E-mails (Track I · DESIGN-30)
// Envia via Resend (mesmo provider do mailer core), porém ISOLADO do
// src/services/mailer.js para não arriscar os e-mails transacionais.
//
// sendKarateEmail(to, opts) é a INTERFACE genérica que Track J (certificados)
// e Track L (relatórios) reusam. O layout aplica a paleta Shoji claro
// aprovada em DESIGN-30: papel #f4f1ea, card branco, vermelho #b02a2a.
//
// Campos do layout compartilhado (via opts):
//   federationName      — nome textual da federação (fallback "Federação")
//   federationLogoUrl   — companies.karate_logo_url; cai para ícone Aura se ausente
//   federationWhatsapp  — companies.wa_phone_display; bloco wa.me só se presente
//   ctaUrl              — URL do botão CTA; omitido = sem botão
//   ctaLabel            — rótulo do botão (default "Abrir")
// ============================================================
'use strict';

const FROM = process.env.KARATE_SMTP_FROM || process.env.SMTP_FROM || 'Aura Karatê <noreply@getaura.com.br>';
// Domínio verificado no Resend p/ envio das federações (qualquer local-part vale).
const MAIL_DOMAIN = process.env.KARATE_MAIL_DOMAIN || 'getaura.com.br';

// Remetente POR FEDERAÇÃO: "<Nome> <slug@dominio>" (ex.: "FPKT <fpkt@getaura.com.br>").
// Retorna null se não houver slug utilizável — cai no FROM global (noreply).
function federationFrom(name, slug) {
  const local = String(slug == null ? '' : slug).toLowerCase().trim().replace(/[^a-z0-9._-]/g, '');
  if (!local) return null;
  const display = String(name == null ? '' : name).replace(/["<>\r\n]/g, '').trim() || local.toUpperCase();
  return `${display} <${local}@${MAIL_DOMAIN}>`;
}

// Resolve o from: explícito (opts.from) > por federação (slug) > global.
function resolveFrom(opts) {
  const o = opts || {};
  return o.from || federationFrom(o.federationName, o.federationSlug) || FROM;
}
const ICON_URL = 'https://cdn.jsdelivr.net/gh/CaioAlexanderx/aura-app@main/assets/Icon.png';

// Envio cru via Resend. Sem chave (dev), loga e segue — não quebra a régua.
async function sendRaw(opts) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[karateMailer] (dev) e-mail simulado -> ${opts.to}: ${opts.subject}`);
    return { id: 'dev-' + Date.now() };
  }
  const payload = {
    from: resolveFrom(opts),
    to: Array.isArray(opts.to) ? opts.to : [opts.to],
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  };
  // Reply-to = e-mail da federação, se cadastrado (companies.email) — Fase
  // F4. Ausente = Resend usa o `from` como reply-to (comportamento padrão).
  if (opts.replyTo) payload.reply_to = opts.replyTo;

  // Anexos inline (cid) — hoje só o QR do PIX de exibição (Fase F4/PIX).
  // Cada item: { filename, content (base64), content_type, content_id }.
  // Resend referencia via <img src="cid:<content_id>"> no HTML (ver
  // karateBillingMailer.js). Nunca lança se ausente/vazio.
  if (Array.isArray(opts.attachments) && opts.attachments.length) {
    payload.attachments = opts.attachments;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Resend API ${res.status}: ${err.message || JSON.stringify(err)}`);
  }
  const data = await res.json();
  console.log(`[karateMailer] Resend OK: ${data.id} to ${opts.to}`);
  return data;
}

// ── Layout DESIGN-30 (Shoji claro) ───────────────────────────
// Paleta: papel #f4f1ea · card #fff · borda #e6e0d4 · vermelho #b02a2a
// Estrutura em table, CSS 100% inline, max-width 480 px.
//
// opts:
//   federationName      — nome da federação (texto)
//   federationLogoUrl   — URL da logo (companies.karate_logo_url); opcional
//   federationWhatsapp  — número WA (companies.wa_phone_display); opcional
function layout(content, opts) {
  const o = opts || {};
  const fed = o.federationName || 'Federação';

  // ── Header: identidade Shoji do e-mail = logo (se houver) + NOME DA
  // FEDERAÇÃO em destaque (serifada), com o filete vermelho no topo do
  // card como acento — não o ícone genérico da Aura. Antes o header
  // sempre mostrava um ícone (o da federação OU o da Aura) + "Aura
  // Karatê" em negrito, com o nome da federação pequeno embaixo — a
  // hierarquia estava invertida (marca do produto > marca do cliente).
  //
  // Degradação obrigatória (karate_logo_url nulo/inacessível): cai para
  // SÓ o nome — sem ícone de fallback. Muitos clientes de e-mail bloqueiam
  // imagem por padrão; por isso o <img>, quando existe, sempre leva `alt`
  // com o nome da federação e dimensões fixas (não desaba o layout se a
  // imagem não carregar).
  const logoBlock = o.federationLogoUrl
    ? `<img src="${_esc(o.federationLogoUrl)}" width="56" height="56"
           alt="${_esc(fed)}"
           style="display:block;margin:0 auto 12px;border-radius:14px;object-fit:contain;background:#f4f1ea;" />`
    : '';
  const headerBlock = `${logoBlock}
    <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:20px;
              font-weight:700;color:#1c1917;letter-spacing:0.2px;">${_esc(fed)}</p>`;

  // ── Footer: wa.me só quando número disponível ────────────
  const waBlock = o.federationWhatsapp
    ? `<tr><td align="center" style="padding:0 32px 18px 32px;">
        <a href="https://wa.me/${_digitsOnly(o.federationWhatsapp)}"
           style="display:inline-block;font-size:12px;font-weight:700;color:#25d366;text-decoration:none;border:1px solid #25d366;border-radius:8px;padding:7px 18px;">
          &#128222;&nbsp;Falar com a federação
        </a>
      </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aura Karatê</title></head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f4f1ea;padding:40px 16px;">
    <tr><td align="center">

      <!-- Card principal -->
      <table width="480" cellpadding="0" cellspacing="0" border="0"
             style="max-width:480px;width:100%;background:#ffffff;
                    border:1px solid #e6e0d4;border-radius:18px;overflow:hidden;">

        <!-- Barra vermelha topo -->
        <tr><td height="4" style="background:#b02a2a;font-size:0;line-height:0;">&nbsp;</td></tr>

        <!-- Header: logo (opcional) + nome da federação em destaque -->
        <tr><td align="center" style="padding:28px 32px 0 32px;">
          ${headerBlock}
        </td></tr>

        <!-- Divisor sutil -->
        <tr><td style="padding:20px 32px 0 32px;">
          <div style="height:1px;background:#f0ebe3;"></div>
        </td></tr>

        <!-- Corpo do e-mail -->
        <tr><td style="padding:22px 32px 28px 32px;">${content}</td></tr>

        <!-- Botão wa.me (condicional) -->
        ${waBlock}

        <!-- Rodapé -->
        <tr><td style="padding:0 32px 24px 32px;border-top:1px solid #eee7da;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center" style="padding-top:18px;">
              <!-- Wordmark Aura Karatê minimalista -->
              <img src="${ICON_URL}" width="22" height="22" alt=""
                   style="display:inline-block;vertical-align:middle;border-radius:5px;opacity:0.55;" />
              <span style="font-size:11px;color:#a8a29e;vertical-align:middle;margin-left:6px;">
                Aura Karatê &middot;
                <a href="https://getaura.com.br"
                   style="color:#b02a2a;text-decoration:none;">getaura.com.br</a>
              </span>
            </td></tr>
          </table>
        </td></tr>

      </table>
      <!-- /Card -->

    </td></tr>
  </table>
</body>
</html>`;
}

// Escapa caracteres HTML perigosos em strings interpoladas no template.
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Remove tudo que não é dígito (para montar a URL wa.me).
function _digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function fmtBRL(v) {
  const n = Number(v || 0);
  return 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function fmtDateBR(d) {
  try { return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
  catch (_) { return String(d); }
}

// ── Interface genérica karatê (Track J e L reusam) ───────────
// Monta heading + corpo + CTA e delega ao layout() compartilhado.
//
// opts:
//   subject, heading, bodyHtml, text    — conteúdo do e-mail
//   ctaUrl, ctaLabel                    — botão (omitir = sem botão)
//   federationName                      — nome da federação
//   federationLogoUrl                   — companies.karate_logo_url
//   federationWhatsapp                  — companies.wa_phone_display
//   from                                — remetente override
async function sendKarateEmail(to, opts) {
  const o = opts || {};

  const cta = o.ctaUrl
    ? `<table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="margin:22px 0 6px;">
        <tr><td align="center">
          <a href="${_esc(o.ctaUrl)}"
             style="display:inline-block;background:#b02a2a;color:#ffffff;
                    font-size:14px;font-weight:700;padding:13px 32px;
                    border-radius:10px;text-decoration:none;
                    letter-spacing:0.2px;">
            ${_esc(o.ctaLabel || 'Abrir')}
          </a>
        </td></tr>
      </table>`
    : '';

  const heading = o.heading
    ? `<p style="font-size:17px;font-weight:800;color:#1c1917;margin:0 0 12px;
                 line-height:24px;">${_esc(o.heading)}</p>`
    : '';

  const body = `${heading}${o.bodyHtml || ''}${cta}`;

  const html = layout(body, {
    federationName:    o.federationName,
    federationLogoUrl: o.federationLogoUrl,
    federationWhatsapp: o.federationWhatsapp,
  });

  return sendRaw({
    to,
    from: o.from,
    federationName: o.federationName,
    federationSlug: o.federationSlug,
    subject: o.subject,
    html,
    text: o.text || _stripHtml(`${o.heading || ''} ${o.bodyHtml || ''} ${o.ctaUrl || ''}`),
  });
}

function _stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Template: lembrete/cobrança de anuidade de dojô ──────────
// Chamado pelo karateReminderRunner com:
//   { dojoName, amount, dueDate, referencePeriod, ruleCode, offset,
//     federationName, federationLogoUrl, federationWhatsapp, ctaUrl }
//
// ctaUrl: URL da página de pagamento Pix do dojô, passada pelo runner
// (data.ctaUrl). Se ausente, nenhum botão é renderizado.
async function sendKarateAnnuityReminderEmail(to, data) {
  const d = data || {};
  const overdue = (d.offset || 0) > 0;
  const heading = overdue ? 'Anuidade vencida' : 'Lembrete de anuidade';
  const quando = overdue
    ? `venceu em <strong>${fmtDateBR(d.dueDate)}</strong>`
    : `vence em <strong>${fmtDateBR(d.dueDate)}</strong>`;
  const periodo = d.referencePeriod ? ` referente a ${d.referencePeriod}` : '';

  const bodyHtml = `
    <p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 14px;">
      Olá${d.dojoName ? ', ' + _esc(d.dojoName) : ''}!
    </p>
    <p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 14px;">
      A anuidade${periodo} no valor de
      <strong style="color:#1c1917;">${fmtBRL(d.amount)}</strong>
      ${quando}.
    </p>
    <p style="font-size:13px;color:#78716c;line-height:21px;margin:0;">
      Para manter o dojô em dia com a federação, realize o pagamento
      e registre o comprovante assim que possível.
    </p>`;

  return sendKarateEmail(to, {
    subject: overdue
      ? `Anuidade vencida — ${fmtBRL(d.amount)}`
      : `Lembrete: anuidade de ${fmtBRL(d.amount)} a vencer`,
    heading,
    bodyHtml,
    ctaUrl:   d.ctaUrl   || undefined,
    ctaLabel: d.ctaLabel || (d.ctaUrl ? 'Pagar anuidade' : undefined),
    federationName:     d.federationName,
    federationSlug:     d.federationSlug,
    federationLogoUrl:  d.federationLogoUrl,
    federationWhatsapp: d.federationWhatsapp,
  });
}


// ── Template: e-mail de cobrança/lembrete de anuidade (Fase F4) ─────
// Diferente de sendKarateAnnuityReminderEmail (texto fixo, usado pela
// régua quando a federação NÃO customizou o template): esta função recebe
// subject/bodyHtml JÁ RENDERIZADOS (karateReminderTemplate.renderTemplate,
// com escape de HTML aplicado a todo valor injetado) mais os blocos
// estruturados (modalidades + PIX copia-e-cola), montados FORA do texto
// editável pelo próprio mailer — ver karateBillingMailer.js. O botão
// wa.me continua vindo do layout() compartilhado (condicional a
// federationWhatsapp), sem duplicar aqui.
async function sendKarateAnnuityBillingEmail(to, opts) {
  const o = opts || {};
  const body = `${o.bodyHtml || ''}${o.modalidadesHtml || ''}${o.pixHtml || ''}`;
  const html = layout(body, {
    federationName:     o.federationName,
    federationLogoUrl:  o.federationLogoUrl,
    federationWhatsapp: o.federationWhatsapp,
  });
  return sendRaw({
    to,
    from: o.from,
    replyTo: o.replyTo,
    federationName: o.federationName,
    federationSlug: o.federationSlug,
    subject: o.subject,
    html,
    text: o.text || _stripHtml(`${o.subject || ''} ${o.bodyHtml || ''}`),
    // QR do PIX de exibição, anexado inline (cid) — ver buildPixQrAttachment
    // em karateBillingMailer.js. Ausente = e-mail segue sem o anexo (nunca
    // bloqueia o envio da cobrança).
    attachments: o.attachments,
  });
}

module.exports = {
  sendRaw,
  federationFrom,
  layout,
  sendKarateEmail,
  sendKarateAnnuityReminderEmail,
  sendKarateAnnuityBillingEmail,
  fmtBRL,
  fmtDateBR,
};
