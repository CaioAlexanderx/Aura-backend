// ============================================================
// AURA KARATÊ — Fase F4: orquestrador do e-mail de cobrança de anuidade
// (template editável + blocos automáticos de modalidades/PIX/wa.me).
//
// Usado por TRÊS chamadores:
//   1. POST .../installments/:id/send-email       (karateAnnuityBilling.js)
//   2. POST .../annuities/send-email-batch        (karateAnnuityBilling.js)
//   3. karateReminderRunner (régua automática), SÓ quando a federação
//      configurou subject_template/body_template — do contrário a régua
//      continua usando karateMailer.sendKarateAnnuityReminderEmail (texto
//      fixo), comportamento 100% preservado.
//
// Contrato de "blocos fora do texto editável" (ver spec F4): o texto
// editável (subject_template/body_template) pode referenciar {{planos}} e
// {{pix_copia_cola}} como variáveis de texto simples, MAS o mailer SEMPRE
// monta, adicionalmente, um bloco HTML estruturado equivalente
// (modalidadesHtml/pixHtml) logo abaixo do corpo — independente de o
// texto ter usado a variável ou não. O botão wa.me continua condicional a
// companies.wa_phone_display (layout() compartilhado do karateMailer).
//
// Ausência de e-mail NUNCA é erro aqui — quem chama decide se vira
// "skipped" (rota) ou é simplesmente pulado (régua, que já filtra por
// dojo_email IS NOT NULL antes de chamar).
// ============================================================
'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const { validateRuntimeEnv } = require('../config/env');
const db = require('../config/database');
const mailer = require('./karateMailer');
const tpl = require('./karateReminderTemplate');
const annuitySvc = require('./karateAnnuityService');
const { createPixCharge } = require('./karatePaymentProvider');
const { signPixToken } = require('./karatePixPublicToken');

const env = validateRuntimeEnv();

const MONTH_ABBR = ['', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function planLabel(plan) {
  return plan === 'anual' ? 'Anual' : plan === 'semestral' ? 'Semestral' : plan === 'trimestral' ? 'Trimestral' : plan;
}

function dueMonthsText(months) {
  if (!Array.isArray(months) || !months.length) return '';
  return months.map((m) => MONTH_ABBR[m] || m).join(', ');
}

// Busca os planos vigentes (karate_annual_fees) de um `kind` ('dojo'|'cpf')
// — dojô tem até 3 planos (anual/semestral/trimestral); CPF só 'anual'.
// Retorna [{ plan, label, amount, amountText, months }] (nunca lança —
// fee ausente só é omitida da lista, não quebra o e-mail).
async function getVigentPlans(client, federationId, kind) {
  const runner = client || db;
  const plans = kind === 'dojo' ? annuitySvc.VALID_PLANS : ['anual'];
  const out = [];
  for (const plan of plans) {
    const fee = await annuitySvc.getVigentFee(runner, federationId, kind === 'dojo' ? 'dojo' : 'cpf', plan);
    if (!fee) continue;
    out.push({
      plan,
      label: kind === 'dojo' ? planLabel(plan) : 'Praticante (faixa-preta)',
      amount: parseFloat(fee.amount),
      amountText: mailer.fmtBRL(fee.amount),
      months: fee.due_months || [],
    });
  }
  return out;
}

function planosToText(plans) {
  return plans
    .map((p) => `${p.label} — ${p.amountText}${p.months.length ? ` (${dueMonthsText(p.months)})` : ''}`)
    .join(' · ');
}

function buildModalidadesHtml(plans) {
  if (!plans || !plans.length) return '';
  const rows = plans
    .map(
      (p) => `<tr>
        <td style="padding:5px 0;font-size:12px;color:#44403c;">${tpl.escapeHtml(p.label)}${p.months.length ? ` <span style="color:#a8a29e;">(${tpl.escapeHtml(dueMonthsText(p.months))})</span>` : ''}</td>
        <td style="padding:5px 0;font-size:12px;color:#1c1917;font-weight:700;text-align:right;">${tpl.escapeHtml(p.amountText)}</td>
      </tr>`
    )
    .join('');
  return `<div style="margin-top:18px;padding-top:16px;border-top:1px solid #f0ebe3;">
    <p style="margin:0 0 8px;font-size:12px;font-weight:800;color:#1c1917;text-transform:uppercase;letter-spacing:0.3px;">Modalidades vigentes</p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
  </div>`;
}

// opts: { qrCid, publicUrl } — ambos opcionais, cada bloco só aparece se
// o respectivo dado existir (QR pode falhar na geração; publicUrl só
// existe quando há pixCode pra assinar o token). O copia-e-cola em si
// SEMPRE aparece quando há pixCode — é o fallback que funciona em
// qualquer cliente de e-mail, mesmo sem imagem e sem abrir link nenhum.
function buildPixHtml(pixCode, opts) {
  if (!pixCode) return '';
  const o = opts || {};

  // QR inline (cid) — só quando a geração funcionou (getPixQrAttachment
  // nunca lança; ausência aqui só significa "sem QR neste envio").
  const qrBlock = o.qrCid
    ? `<div style="text-align:center;margin-bottom:12px;">
        <img src="cid:${tpl.escapeHtml(o.qrCid)}" width="160" height="160" alt="QR code do PIX"
             style="display:inline-block;border-radius:8px;background:#ffffff;padding:6px;border:1px solid #e6e0d4;" />
      </div>`
    : '';

  // Botão "Ver QR e copiar" — leva pra página pública (sem login, sem dado
  // pessoal: só valor/competência/código, ver karatePixPublicToken.js).
  // E-mail não executa JavaScript — um botão "copiar" de verdade só existe
  // fora do e-mail; aqui é só um link.
  const linkBlock = o.publicUrl
    ? `<div style="text-align:center;margin-top:12px;">
        <a href="${tpl.escapeHtml(o.publicUrl)}"
           style="display:inline-block;background:#b02a2a;color:#ffffff;font-size:12px;font-weight:700;
                  padding:9px 18px;border-radius:8px;text-decoration:none;letter-spacing:0.2px;">
          Ver QR grande e copiar o código
        </a>
      </div>`
    : '';

  return `<div style="margin-top:18px;padding:14px;background:#f7f5f0;border:1px solid #e6e0d4;border-radius:10px;">
    ${qrBlock}
    <p style="margin:0 0 8px;font-size:12px;font-weight:800;color:#1c1917;text-transform:uppercase;letter-spacing:0.3px;">PIX copia e cola</p>
    <p style="margin:0;font-size:11px;color:#44403c;line-height:16px;word-break:break-all;font-family:'SF Mono',Consolas,monospace;">${tpl.escapeHtml(pixCode)}</p>
    ${linkBlock}
  </div>`;
}

// Gera o PNG do QR do BR Code como anexo INLINE (content_id/cid) do
// Resend — não faz fetch de imagem externa (mais confiável que uma URL:
// o QR viaja dentro do próprio e-mail). Nunca lança: falha na geração do
// QR não pode derrubar o envio da cobrança, o e-mail só segue sem essa
// imagem (o copia-e-cola continua presente de qualquer forma).
async function getPixQrAttachment(pixCode) {
  if (!pixCode) return null;
  try {
    const buf = await QRCode.toBuffer(pixCode, { type: 'png', width: 320, margin: 1, errorCorrectionLevel: 'M' });
    const cid = 'pix-qr-' + crypto.randomBytes(6).toString('hex');
    return {
      cid,
      attachment: {
        filename: 'pix-qrcode.png',
        content: buf.toString('base64'),
        content_type: 'image/png',
        content_id: cid,
      },
    };
  } catch (e) {
    console.warn('[karateBillingMailer] QR do PIX falhou (e-mail segue sem QR):', e.message);
    return null;
  }
}

// URL da página pública de pagamento (front, sem login) — token stateless
// assinado com o próprio BR Code (ver karatePixPublicToken.js). Nunca
// lança; sem pixCode não há o que assinar.
function buildPublicPixUrl({ amount, referencePeriod, pixCode }) {
  if (!pixCode) return null;
  try {
    const token = signPixToken({ amount, referencePeriod, pixCode });
    return `${env.APP_URL}/karate/pix/${token}`;
  } catch (e) {
    console.warn('[karateBillingMailer] geração do link público do PIX falhou:', e.message);
    return null;
  }
}

// Gera um BR Code PIX SÓ para exibição no e-mail (não persiste
// karate_payment_intents — evita poluir a tabela a cada envio/reenvio de
// e-mail, inclusive em lote). Nunca lança: falha na geração do PIX não
// pode derrubar o envio do e-mail de cobrança.
async function getDisplayPixCode({ federationId, amount, description }) {
  try {
    const txid = ('EM' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 20);
    const r = await createPixCharge({ federationId, amount, txid, description });
    return r.payload || null;
  } catch (e) {
    console.warn('[karateBillingMailer] PIX de exibição falhou (e-mail segue sem o bloco):', e.message);
    return null;
  }
}

// ── Orquestrador principal ───────────────────────────────────────────
// data: { to, kind: 'dojo'|'cpf', nome, amount, dueDate, referencePeriod,
//         federationId, federationMeta: { name, slug, karate_logo_url, wa_phone_display },
//         subjectTemplate, bodyTemplate }  (templates: já resolvidos —
//         custom OU default; ver resolveTemplates abaixo)
// Retorna { id } do provider (Resend) — lança em caso de falha de envio
// (quem chama decide como registrar o erro).
async function sendBillingEmail(client, data) {
  const d = data || {};
  const runner = client || db;

  const vars = {
    nome: d.nome || '',
    competencia: d.referencePeriod || '',
    valor: mailer.fmtBRL(d.amount),
    vencimento: mailer.fmtDateBR(d.dueDate),
  };

  const plans = await getVigentPlans(runner, d.federationId, d.kind);
  vars.planos = planosToText(plans);

  const pixCode = await getDisplayPixCode({
    federationId: d.federationId,
    amount: d.amount,
    description: `Anuidade ${d.kind === 'cpf' ? '' : 'dojô '}${d.nome} — ${d.referencePeriod}`,
  });
  vars.pix_copia_cola = pixCode || '';

  // QR inline (cid) + link da página pública — ambos derivados do MESMO
  // pixCode acima, nenhum dos dois bloqueia o envio se falhar (ver
  // comentários de getPixQrAttachment/buildPublicPixUrl).
  const qrAttachment = await getPixQrAttachment(pixCode);
  const publicPixUrl = buildPublicPixUrl({ amount: d.amount, referencePeriod: d.referencePeriod, pixCode });

  const subject = tpl.renderTemplate(d.subjectTemplate || tpl.DEFAULT_SUBJECT_TEMPLATE, vars);
  const bodyRendered = tpl.renderTemplate(d.bodyTemplate || tpl.DEFAULT_BODY_TEMPLATE, vars);
  const bodyHtml = tpl.textToHtmlParagraphs(bodyRendered);

  const fedMeta = d.federationMeta || {};
  const res = await mailer.sendKarateAnnuityBillingEmail(d.to, {
    subject,
    bodyHtml,
    modalidadesHtml: buildModalidadesHtml(plans),
    pixHtml: buildPixHtml(pixCode, { qrCid: qrAttachment && qrAttachment.cid, publicUrl: publicPixUrl }),
    attachments: qrAttachment ? [qrAttachment.attachment] : undefined,
    federationName:     fedMeta.name,
    federationSlug:     fedMeta.slug,
    federationLogoUrl:  fedMeta.karate_logo_url,
    federationWhatsapp: fedMeta.wa_phone_display,
    replyTo:             fedMeta.email || undefined,
  });
  return res;
}

// Resolve os templates efetivos de uma config de régua: usa
// subject_template/body_template SE presentes e não-vazios; senão default.
function resolveTemplates(cfg) {
  const c = cfg || {};
  const subjectTemplate = (c.subject_template && String(c.subject_template).trim()) || tpl.DEFAULT_SUBJECT_TEMPLATE;
  const bodyTemplate = (c.body_template && String(c.body_template).trim()) || tpl.DEFAULT_BODY_TEMPLATE;
  return { subjectTemplate, bodyTemplate };
}


// Metadados da federação necessários ao layout do e-mail (nome, slug pro
// remetente, logo, WhatsApp). Mesma fonte que karateReminderRunner usa
// (companies.slug/karate_logo_url/wa_phone_display) — reimplementada aqui
// para não criar acoplamento entre os dois módulos.
async function getFederationMeta(client, fedId) {
  const runner = client || db;
  try {
    const { rows } = await runner.query(
      `SELECT COALESCE(trade_name, legal_name) AS name, slug, karate_logo_url, wa_phone_display, email
       FROM companies WHERE id = $1 LIMIT 1`,
      [fedId]
    );
    if (!rows.length) return { name: 'Federação', slug: null, karate_logo_url: null, wa_phone_display: null, email: null };
    return {
      name:             rows[0].name             || 'Federação',
      slug:             rows[0].slug             || null,
      karate_logo_url:  rows[0].karate_logo_url  || null,
      wa_phone_display: rows[0].wa_phone_display || null,
      email:            rows[0].email            || null,
    };
  } catch (_) {
    return { name: 'Federação', slug: null, karate_logo_url: null, wa_phone_display: null, email: null };
  }
}

module.exports = {
  getVigentPlans,
  planosToText,
  buildModalidadesHtml,
  buildPixHtml,
  getPixQrAttachment,
  buildPublicPixUrl,
  getDisplayPixCode,
  sendBillingEmail,
  getFederationMeta,
  resolveTemplates,
};
