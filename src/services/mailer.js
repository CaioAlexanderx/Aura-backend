// ============================================================
// AURA. - Email Service
// Resend HTTP API (porta 443) | SMTP fallback | Dev fallback
// ============================================================

// IMPORTANT: FROM must use a verified domain in Resend.
// onboarding@resend.dev = sandbox (only sends to account owner).
// getaura.com.br is verified (DKIM + SPF + MX green).
//
// tq-72 (21/10/2026): remetente padrão deixa de ser noreply@ e passa a ser
// contato@, com Reply-To em todo envio. Ordem: MAIL_FROM > SMTP_FROM >
// padrão. Reply-To: MAIL_REPLY_TO > padrão, aplicado quando o envio não
// passa replyTo. Um envio pode trocar o remetente (opts.from), mas só para
// endereço @getaura.com.br — o único domínio verificado no Resend.
const FROM_DEFAULT = 'Caio Alexander, da Aura <contato@getaura.com.br>';
const FROM = process.env.MAIL_FROM || process.env.SMTP_FROM || FROM_DEFAULT;
const REPLY_TO_DEFAULT = 'contato@getaura.com.br';
const REPLY_TO = process.env.MAIL_REPLY_TO || REPLY_TO_DEFAULT;
const DOMINIO_DO_REMETENTE = 'getaura.com.br';
// Remetente neutro, sem o nome do Caio (tq-72). Vale para o relatório
// semanal e para todo e-mail que vai a quem NÃO é a lojista nem a equipe
// Aura: cliente final da loja online (status/confirmação do pedido) e
// atleta/dojô do portal do Karatê (código de verificação). Regra fechada
// com a Nina e o Caio: esses não levam o nome dele.
const FROM_NEUTRO = 'Aura <contato@getaura.com.br>';
// Reply-To de quem não deve responder para contato@ (a caixa do Caio):
// cliente final sem e-mail da loja e portal do Karatê.
const REPLY_TO_SEM_RESPOSTA = 'noreply@getaura.com.br';

/** E-mail simples e de uma linha só (para usar como Reply-To), ou null. */
function emailValido(v) {
  const s = v == null ? '' : String(v).trim();
  return /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/.test(s) ? s : null;
}

/**
 * Remetente de um envio: opts.from quando é um endereço @getaura.com.br
 * ("Nome <x@getaura.com.br>" ou "x@getaura.com.br"); senão o FROM padrão.
 * Recusa quebra de linha (injeção de cabeçalho) e qualquer outro domínio.
 */
function resolverRemetente(from) {
  if (from == null || from === '') return FROM;
  const s = String(from).trim();
  if (/[\r\n]/.test(s)) {
    console.warn('[mailer] opts.from recusado (quebra de linha); usando o remetente padrao');
    return FROM;
  }
  const m = s.match(/<([^<>\s]+)>\s*$/) || s.match(/^([^<>\s]+)$/);
  const endereco = m ? m[1] : '';
  const dominio = endereco.includes('@') ? endereco.split('@').pop().toLowerCase() : '';
  if (dominio !== DOMINIO_DO_REMETENTE || endereco.split('@').length !== 2 || !endereco.split('@')[0]) {
    console.warn(`[mailer] opts.from fora de @${DOMINIO_DO_REMETENTE} recusado; usando o remetente padrao`);
    return FROM;
  }
  return s;
}

/** Cabeçalhos extras: só pares string -> string, sem quebra de linha. */
function cabecalhosLimpos(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    const nome = String(k);
    const valor = String(v);
    if (!/^[A-Za-z0-9-]+$/.test(nome) || /[\r\n]/.test(valor)) continue;
    out[nome] = valor;
  }
  return Object.keys(out).length ? out : null;
}
const ICON_URL = 'https://cdn.jsdelivr.net/gh/CaioAlexanderx/aura-app@main/assets/Icon.png';
// O numero do wa.me com o 55, regra unica (tq-61).
const { numeroDoWhatsapp } = require('./whatsappDaLoja');
// Modelo único (tq-75) e links assinados de descadastro (tq-74).
const L = require('./emailLayout');
const { linkDescadastro, cabecalhosDescadastro } = require('./emailLinks');

// LEGADO (escuro). Os e-mails à lojista e ao cliente saíram daqui para o
// modelo único (services/emailLayout.js, tq-75). Ficam neste layout só os
// avisos internos (canário, resumo da madrugada, conta self-service), os
// banners da Gestão Aura por e-mail e o fim de desconto, que não estavam no
// escopo do tq-75.
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
  const headers = cabecalhosLimpos(opts.headers);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: resolverRemetente(opts.from),
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      reply_to: opts.replyTo || REPLY_TO,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      ...(headers ? { headers } : {}),
      // Imagem no corpo (cid): { filename, content: Buffer, cid, contentType }
      // vira o formato do Resend (base64 + content_id + content_type). O
      // SMTP (nodemailer) já entende { filename, content, cid, contentType }.
      // 18/09/2026: sem content_type o QR do e-mail de notificação chegou
      // como imagem quebrada — o cliente não trata o anexo como imagem.
      // Mesmo formato do karateBillingMailer, que já funcionava.
      ...(opts.attachments && opts.attachments.length ? {
        attachments: opts.attachments.map((a) => ({
          filename:     a.filename,
          content:      Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
          content_id:   a.cid,
          ...(a.contentType ? { content_type: a.contentType } : {}),
        })),
      } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Resend API ${res.status}: ${err.message || JSON.stringify(err)}`);
  }
  const data = await res.json();
  // Sem o e-mail do destinatário no log: o id do envio basta para achar no Resend.
  console.log(`[mailer] Resend OK: id=${data && data.id}`);
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
  const id = 'dev-' + Date.now();
  console.log('\n[DEV] Email simulado:');
  // Sem o e-mail do destinatário no log (tq-72): o id do envio no lugar.
  console.log(`  Id: ${id}`);
  console.log(`  Subject: ${opts.subject}`);
  console.log(`  Link/Code: ${opts.text?.match(/(https?:\/\/\S+|\d{4,6})/)?.[0] || 'N/A'}`);
  return { id };
}

// Registro de envio (tq-74): ligado no boot por services/emailLog
// (ligarRegistroNoMailer). Sem ele (testes, scripts), nada é gravado.
let _registroDeEnvio = null;
function definirRegistroDeEnvio(fn) {
  _registroDeEnvio = typeof fn === 'function' ? fn : null;
}
function registrar(opts, status, resultado, erro) {
  if (!_registroDeEnvio || opts._registrado) return;
  try {
    Promise.resolve(_registroDeEnvio({
      tipo: opts.tipo || 'outro', companyId: opts.companyId || null, userId: opts.userId || null,
      to: opts.to, subject: opts.subject, status,
      resendId: (resultado && resultado.id) || null, erro: erro ? erro.message : null,
    })).catch(() => {});
  } catch (_) { /* registro nunca derruba o envio */ }
}

async function enviarPeloCanal(opts) {
  if (process.env.RESEND_API_KEY) return sendViaResend(opts);
  const smtp = getSmtpTransporter();
  if (smtp) {
    const headers = cabecalhosLimpos(opts.headers);
    const { headers: _ignorado, tipo: _t, companyId: _c, userId: _u, _registrado: _r, ...resto } = opts;
    const info = await smtp.sendMail({
      ...resto,
      from: resolverRemetente(opts.from),
      replyTo: opts.replyTo || REPLY_TO,
      ...(headers ? { headers } : {}),
    });
    return { ...info, id: (info && (info.id || info.messageId)) || null };
  }
  return sendViaDev(opts);
}

// Envio unificado.
// opts: { to, subject, html, text, attachments?, from?, replyTo?, headers?,
//         tipo?, companyId?, userId? }  (os três últimos só vão ao email_log)
// Devolve o resultado do provedor com `id` sempre preenchido quando o
// provedor deu um (Resend: id; SMTP: messageId; dev: dev-<timestamp>), para
// quem chama gravar (report_deliveries.resend_id, notification_emails...).
async function sendMail(opts) {
  try {
    const r = await enviarPeloCanal(opts);
    registrar(opts, 'sent', r, null);
    return r;
  } catch (err) {
    registrar(opts, 'failed', null, err);
    throw err;
  }
}

// ============================================================
// tq-75 (24/10/2026): os e-mails abaixo saem do modelo único
// (services/emailLayout.js). Variantes: aura-transacional (verificação,
// senha, convite, pedido novo à lojista, relatório), loja (status do pedido
// ao cliente final) e portal (código do portal do Karatê). Links, assuntos
// e destinatários continuam os mesmos.
// ============================================================

// Botão principal no corpo (o layout também tem o slot de botão; este é
// para quando o botão fica no meio do texto, antes do link copiável).
function botaoSimples(rotulo, url) {
  const href = L.urlSegura(url);
  if (!href) return '';
  return `<a class="a-btn" href="${L.esc(href)}" style="display:inline-block;background:${L.COR.violeta};color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:13px 22px;border-radius:10px;">${L.esc(rotulo)}</a>`;
}

// -- Template: verificacao de email via LINK (+ codigo OTP opcional) --
// Task Sign Up 03/08: quando otpCode vem preenchido, o e-mail traz tambem
// o codigo de 6 digitos digitavel no app — caminho paralelo ao link.
async function sendVerificationLinkEmail(to, confirmUrl, userName, otpCode) {
  const firstName = L.primeiroNome(userName);
  const codigo = otpCode ? L.caixa(
    `<p class="a-ink2" style="margin:0 0 6px;color:${L.COR.tinta2};font-size:12.5px;text-align:center;">ou digite este código na tela de confirmação:</p>` +
    `<p class="a-ink" style="margin:0;color:${L.COR.tinta};font-size:28px;font-weight:800;letter-spacing:8px;text-align:center;font-family:'Courier New',monospace;">${L.esc(otpCode)}</p>`
  ) : '';
  const corpo = [
    L.p(`Olá${firstName ? ', ' + firstName : ''}!`),
    L.p('Confirme seu e-mail clicando no botão abaixo para ativar sua conta na Aura.'),
    `<div style="margin:0 0 16px;">${botaoSimples('Confirmar meu e-mail', confirmUrl)}</div>`,
    codigo,
    L.nota('Ou copie este link:'),
    L.nota(`<span style="word-break:break-all;">${L.esc(confirmUrl)}</span>`),
    L.nota('Link e código válidos por <strong>1 hora</strong>. Se você não criou uma conta, ignore este e-mail.'),
  ].join('\n');
  const html = L.montarEmail({
    variante: 'aura-transacional',
    assunto: 'Confirme seu e-mail - Aura.',
    previa: 'Falta um clique para ativar sua conta na Aura',
    corpo,
    whatsapp: { mensagem: 'Oi! Preciso de ajuda para confirmar meu e-mail na Aura.' },
  });
  return sendMail({
    to,
    subject: 'Confirme seu e-mail - Aura.',
    text: `Ola${firstName ? ' ' + firstName : ''}! Confirme seu e-mail: ${confirmUrl}${otpCode ? ` — ou use o codigo ${otpCode} na tela de confirmacao` : ''} (validos por 1 hora).`,
    html,
    tipo: 'verificacao_email',
  });
}

// -- Template: verificacao de email via OTP (portal do Karatê) --
// Variante "portal" (Nina, 21/10): marca do portal, sem assinatura e sem o
// WhatsApp da Aura. `portal` (opcional): { nome, logoUrl } da federação;
// sem ele, "Portal de acesso".
async function sendVerificationEmail(to, code, userName, portal = {}) {
  const firstName = L.primeiroNome(userName);
  const nomePortal = (portal && portal.nome) || 'Portal de acesso';
  const corpo = [
    L.p(`Olá${firstName ? ', ' + firstName : ''}!`),
    L.p('Use o código abaixo para verificar seu e-mail:'),
    L.caixa(`<p class="a-ink" style="margin:0;color:${L.COR.tinta};font-size:32px;font-weight:800;letter-spacing:10px;text-align:center;font-family:'Courier New',monospace;">${L.esc(code)}</p>`),
    L.nota('Este código expira em <strong>10 minutos</strong>. Se você não pediu, ignore este e-mail.'),
  ].join('\n');
  const html = L.montarEmail({
    variante: 'portal',
    assunto: `${code} - Seu codigo de verificacao`,
    previa: 'Seu código de verificação',
    corpo,
    marca: { nome: nomePortal, logoUrl: portal && portal.logoUrl },
    rodape: `${L.esc(nomePortal)} · código de acesso enviado a pedido de quem entrou no portal.`,
  });
  // Só o portal do Karatê usa (atleta e dojô): remetente neutro e resposta
  // para noreply@, nunca para contato@ (tq-72).
  return sendMail({
    from: FROM_NEUTRO,
    replyTo: REPLY_TO_SEM_RESPOSTA,
    to, subject: `${code} - Seu codigo de verificacao Aura.`,
    text: `Seu codigo de verificacao Aura e: ${code}. Valido por 10 minutos.`, html,
    tipo: 'verificacao_portal',
  });
}

// -- Template: redefinicao de senha --
async function sendPasswordResetEmail(to, resetUrl, userName) {
  const firstName = L.primeiroNome(userName);
  const corpo = [
    L.p(`Olá${firstName ? ', ' + firstName : ''}!`),
    L.p('Recebemos um pedido para redefinir a sua senha. Clique no botão abaixo:'),
    `<div style="margin:0 0 16px;">${botaoSimples('Redefinir minha senha', resetUrl)}</div>`,
    L.nota('Ou copie este link:'),
    L.nota(`<span style="word-break:break-all;">${L.esc(resetUrl)}</span>`),
    L.nota('O link expira em <strong>30 minutos</strong>. Se você não pediu, ignore este e-mail: a senha continua a mesma.'),
  ].join('\n');
  const html = L.montarEmail({
    variante: 'aura-transacional',
    assunto: 'Redefina sua senha - Aura.',
    previa: 'O link vale por 30 minutos',
    corpo,
    whatsapp: { mensagem: 'Oi! Preciso de ajuda para entrar na minha conta da Aura.' },
  });
  return sendMail({
    to, subject: 'Redefina sua senha - Aura.',
    text: `Ola${firstName ? ' ' + firstName : ''}! Redefina sua senha: ${resetUrl} (valido por 30 minutos).`, html,
    tipo: 'redefinicao_senha',
  });
}

// -- Template: convite de equipe --
async function sendInviteEmail(to, inviteUrl, companyName, role, inviterName) {
  const roleLabel = role || 'Colaborador';
  const company   = companyName || 'uma empresa';
  const inviter   = inviterName || 'o titular';
  const corpo = [
    L.p('Olá!'),
    L.pHtml(`<strong>${L.esc(inviter)}</strong> convidou você para entrar na equipe de`),
    L.caixa(
      `<p class="a-ink" style="margin:0 0 4px;color:${L.COR.tinta};font-size:19px;font-weight:800;text-align:center;">${L.esc(company)}</p>` +
      `<p class="a-ink2" style="margin:0;color:${L.COR.tinta2};font-size:13px;text-align:center;">Função: <strong>${L.esc(roleLabel)}</strong></p>`
    ),
    `<div style="margin:0 0 16px;">${botaoSimples('Aceitar convite', inviteUrl)}</div>`,
    L.nota('Ou acesse diretamente:'),
    L.nota(`<span style="word-break:break-all;">${L.esc(inviteUrl)}</span>`),
    L.nota('Precisa de uma conta? Crie em segundos na página do convite. Este link expira em <strong>7 dias</strong>. Se não esperava este convite, ignore.'),
  ].join('\n');
  const html = L.montarEmail({
    variante: 'aura-transacional',
    assunto: `Voce foi convidado para ${company} no Aura.`,
    previa: `Convite para a equipe de ${company}`,
    corpo,
    whatsapp: { mensagem: `Oi! Recebi um convite para a equipe de ${company} na Aura e preciso de ajuda.` },
  });
  return sendMail({
    to,
    subject: `Voce foi convidado para ${company} no Aura.`,
    text: `Voce foi convidado para a equipe de ${company} como ${roleLabel}. Acesse: ${inviteUrl}`,
    html,
    tipo: 'convite_equipe',
  });
}

// (24/10/2026, tq-75) sendOrderConfirmationEmail saiu: não tinha chamador.

// -- Template: atualização de status do pedido Canal Digital (cliente) --
// Variante "loja" (Nina, 21/10): vai ao CLIENTE FINAL — marca e WhatsApp
// da própria loja, rodapé "Enviado pela Aura para {loja}", sem o nome do
// Caio e sem o WhatsApp da Aura.
// `link` (opcional, Fase 2 da vitrine Studio): { url, rotulo } — o botao
// que leva a cliente de volta ao pedido. So entra quando quem chama tem um
// endereco absoluto https (sem aspas nem <>); sem ele, sem botão.
// `store_email` (tq-72): e-mail da loja (companies.email), vira o Reply-To
// para a resposta do cliente final ir à loja, e não à Aura.
// `store_whatsapp` / `store_logo_url` (tq-75): da vitrine da loja
// (digital_channel_config), opcionais.
async function sendOrderStatusEmail(to, { order_number, customer_name, status, store_name, link, store_email, store_whatsapp, store_logo_url }) {
  const firstName = L.primeiroNome(customer_name) || customer_name || '';
  const STATUS_INFO = {
    confirmed: { emoji: '✅', label: 'Confirmado',    msg: 'Pagamento confirmado! Seu pedido está sendo preparado.' },
    preparing: { emoji: '👨‍🍳', label: 'Em preparo',    msg: 'Estamos preparando seu pedido agora.' },
    ready:     { emoji: '📦', label: 'Pronto!',       msg: 'Seu pedido está pronto! Pode retirar ou aguardar a entrega.' },
    delivered: { emoji: '🚀', label: 'Entregue',      msg: 'Pedido entregue! Obrigado pela preferência.' },
    cancelled: { emoji: '❌', label: 'Cancelado',    msg: 'Seu pedido foi cancelado. Em caso de dúvidas, contate a loja.' },
  };
  const info = STATUS_INFO[status] || { emoji: '📋', label: status, msg: 'Status do seu pedido foi atualizado.' };

  const linkValido = !!(link && typeof link.url === 'string' && /^https:\/\//.test(link.url));
  const loja = store_name || 'a loja';

  const corpo = [
    L.p(`Olá${firstName ? ', ' + firstName : ''}!`),
    L.pHtml(`Atualização do seu pedido <strong>#${L.esc(order_number)}</strong> em <strong>${L.esc(loja)}</strong>:`),
    L.caixa(
      `<p style="margin:0 0 6px;font-size:34px;text-align:center;">${info.emoji}</p>` +
      `<p class="a-ink" style="margin:0 0 6px;color:${L.COR.tinta};font-size:18px;font-weight:800;text-align:center;">${L.esc(info.label)}</p>` +
      `<p class="a-ink2" style="margin:0;color:${L.COR.tinta2};font-size:13.5px;text-align:center;">${L.esc(info.msg)}</p>`
    ),
    L.nota('Em caso de dúvidas, fale com a loja diretamente.'),
  ].join('\n');

  const html = L.montarEmail({
    variante: 'loja',
    assunto: `Pedido #${order_number}: ${info.label}`,
    previa: `${info.label} · pedido #${order_number} em ${loja}`,
    corpo,
    botao: linkValido ? { rotulo: link.rotulo || 'Ver meu pedido', url: link.url } : null,
    whatsapp: store_whatsapp ? { numero: store_whatsapp, mensagem: `Oi! Sobre o meu pedido #${order_number}.` } : false,
    marca: { nome: loja, logoUrl: store_logo_url },
  });

  // Vai ao cliente final da loja: remetente neutro e resposta para a loja
  // (tq-72). Sem e-mail da loja, noreply@ — nunca contato@.
  return sendMail({
    from: FROM_NEUTRO,
    replyTo: emailValido(store_email) || REPLY_TO_SEM_RESPOSTA,
    to,
    subject: `${info.emoji} Pedido #${order_number}: ${info.label}`,
    text: `Pedido #${order_number} em ${store_name}: ${info.label}. ${info.msg}`
      + (linkValido ? `\n\n${link.rotulo || 'Ver meu pedido'}: ${link.url}` : ''),
    html,
    tipo: 'pedido_status_cliente',
  });
}

// -- Template: novo pedido confirmado (lojista) --
// Enviado ao lojista após pagamento confirmado (Pix, Cartão ou Na Entrega).
// Vai hoje a TODOS os company_members com e-mail (getOwnerEmails), sem
// filtro de papel: mudar isso é decisão de produto (tq-88), não do layout.
async function sendOwnerNewOrderEmail(to, opts) {
  const { order_number, customer_name, customer_phone, total, delivery_type, store_name, payment_method, aguardando_pagamento } = opts;
  // Pix manual (10/09/2026): o pedido chega ANTES do dinheiro, e quem
  // confere e a lojista. Mesmo resumo, outro titulo e outra instrucao.
  const aguardando = aguardando_pagamento === true;
  const fmtR = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
  const deliveryLabel = delivery_type === 'delivery' ? '🚚 Entrega' : '🏪 Retirada na loja';
  const paymentLabel  = payment_method === 'pix' ? 'Pix' :
                        payment_method === 'card' ? 'Cartão' : 'Na entrega';

  // tq-61: a regra unica do wa.me (services/whatsappDaLoja.js). Antes o
  // 55 entrava sempre, e quem digitava "+55 ..." no checkout virava 5555.
  const phone = numeroDoWhatsapp(customer_phone);
  const contato = phone
    ? `<a class="a-link" href="https://wa.me/${phone}" style="color:${L.COR.violeta};text-decoration:none;">Chamar no WhatsApp</a>`
    : null;

  const linha = (rot, valHtml) => valHtml == null ? '' :
    `<tr><td class="a-ink2" style="padding:5px 0;color:${L.COR.tinta2};font-size:12.5px;width:100px;">${rot}</td>` +
    `<td class="a-ink" style="padding:5px 0;color:${L.COR.tinta};font-size:13.5px;font-weight:600;">${valHtml}</td></tr>`;
  const corpo = [
    L.p(aguardando ? '📦 Pedido novo — confira o Pix' : '📦 Novo pedido confirmado!', 'font-weight:700;'),
    L.pHtml(`Um novo pedido chegou na sua loja <strong>${L.esc(store_name)}</strong>.`),
    L.caixa(
      `<p class="a-ink" style="margin:0 0 10px;color:${L.COR.tinta};font-size:19px;font-weight:800;">Pedido #${L.esc(order_number)}</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
      linha('Cliente', L.esc(customer_name)) +
      linha('Total', `<span style="color:${L.COR.violeta};">${fmtR(total)}</span>`) +
      linha('Modalidade', deliveryLabel) +
      linha('Pagamento', `${paymentLabel} ${aguardando ? '· aguardando' : '✓'}`) +
      linha('Contato', contato) +
      `</table>`
    ),
    L.nota(aguardando
      ? 'Quando o Pix cair na sua conta, confirme o pagamento no app Aura para liberar o pedido.'
      : 'Acesse o app Aura para gerenciar o pedido e avançar o status conforme o andamento.'),
  ].join('\n');

  const assunto = aguardando
    ? `📦 Pedido #${order_number} recebido — confira o Pix — ${store_name}`
    : `📦 Pedido #${order_number} confirmado — ${store_name}`;
  const html = L.montarEmail({
    variante: 'aura-transacional',
    assunto,
    previa: `${customer_name} · ${fmtR(total)} · ${paymentLabel}`,
    corpo,
    whatsapp: { mensagem: `Oi! Preciso de ajuda com o pedido #${order_number} da loja online.` },
  });

  return sendMail({
    to,
    subject: assunto,
    text: aguardando
      ? `Pedido #${order_number} recebido em ${store_name}, aguardando o Pix. Cliente: ${customer_name}. Total: ${fmtR(total)}. Quando o Pix cair, confirme o pagamento no app Aura.`
      : `Novo pedido #${order_number} confirmado em ${store_name}. Cliente: ${customer_name}. Total: ${fmtR(total)}. Pagamento: ${paymentLabel}. Acesse o app Aura para gerenciar.`,
    html,
    tipo: 'pedido_novo_lojista',
  });
}

// -- Template: relatório semanal automático --
// tq-74: link "Parar de receber" no rodapé e cabeçalhos List-Unsubscribe /
// List-Unsubscribe-Post (RFC 8058) — só quando `company.id` vem (é dele o
// token). `opts.grupo`: relatório consolidado do dono (multi-CNPJ); o
// descadastro desliga o grupo inteiro, que recebia este mesmo e-mail.
async function sendWeeklyReport(company, kpis, reportUrl, opts = {}) {
  function fmtR(v) {
    const n = Math.round(v * 100) / 100;
    const [int, dec] = n.toFixed(2).split('.');
    return 'R$&nbsp;' + int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (dec === '00' ? '' : ',' + dec);
  }

  const url = reportUrl || 'https://app.getaura.com.br';
  const descadastro = company && company.id
    ? linkDescadastro(company.id, 'relatorio', { grupo: !!opts.grupo })
    : null;

  const corSaude = kpis.health_score >= 70 ? '#15803d' : kpis.health_score >= 40 ? '#b7791f' : '#c0392b';
  const kpi = (rot, val, cor) =>
    `<tr><td class="a-line" style="padding:10px 0;border-bottom:1px solid ${L.COR.linha};">` +
    `<span class="a-ink2" style="font-size:11px;color:${L.COR.tinta2};letter-spacing:.07em;text-transform:uppercase;font-weight:700;">${rot}</span>` +
    `<p class="${cor ? '' : 'a-ink'}" style="margin:4px 0 0;font-size:20px;font-weight:700;color:${cor || L.COR.tinta};">${val}</p></td></tr>`;
  const corpo = [
    L.p('Seu relatório semanal chegou!', 'font-weight:700;'),
    L.pHtml(`Aqui está o resumo de desempenho de <strong>${L.esc(company.name)}</strong> nesta semana.`),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">` +
      kpi('Receita', fmtR(kpis.revenue)) +
      kpi('Vendas', L.esc(kpis.sales)) +
      kpi('Ticket médio', fmtR(kpis.avg_ticket)) +
      kpi('Saúde do negócio', `${L.esc(kpis.health_score)}<span style="font-size:13px;color:${L.COR.tinta2};">/100</span>`, corSaude) +
    `</table>`,
  ].join('\n');

  const rodape = 'Você recebe este resumo toda segunda, às 8h. O link do relatório expira em 30 dias.' +
    (descadastro ? ` <a class="a-link" href="${L.esc(descadastro)}" style="color:${L.COR.violeta};">Parar de receber</a>` : '') +
    ' · Aura. Tecnologia para negócios';

  const html = L.montarEmail({
    variante: 'aura-transacional',
    assunto: `Relatório semanal — ${company.name}`,
    previa: 'Receita, vendas, ticket médio e a saúde do negócio na semana',
    corpo,
    botao: { rotulo: 'Ver relatório completo', url },
    whatsapp: { mensagem: `Oi, Caio! Recebi o relatório semanal da ${company.name}.` },
    assinatura: false,
    rodape,
  });

  return sendMail({
    from: FROM_NEUTRO,
    to: company.email,
    subject: `Relatório semanal — ${company.name}`,
    text: `Aura. — Relatorio semanal de ${company.name}. Receita: R$ ${kpis.revenue} | Vendas: ${kpis.sales} | Ticket medio: R$ ${kpis.avg_ticket} | Saude: ${kpis.health_score}/100\n\nVer relatorio completo: ${url}`
      + (descadastro ? `\n\nParar de receber: ${descadastro}` : ''),
    html,
    headers: cabecalhosDescadastro(descadastro),
    tipo: 'relatorio_semanal',
    companyId: (company && company.id) || null,
  });
}

// Notificacao interna (CS/comercial) quando uma conta self-service e criada,
// pra follow-up rapido. Destino: env CS_NOTIFY_EMAIL (default contato@getaura.com.br).
async function sendSelfServeSignupNotification(info) {
  const to = process.env.CS_NOTIFY_EMAIL || 'contato@getaura.com.br';
  const row = (label, value) => value
    ? `<tr><td style="padding:6px 14px 6px 0;color:#8a8aa0;font-size:13px;white-space:nowrap;">${label}</td><td style="padding:6px 0;color:#fff;font-size:14px;">${value}</td></tr>`
    : '';
  const content = `
    <h2 style="color:#a78bfa;margin:0 0 6px;font-size:20px;">Nova conta self-service 🎉</h2>
    <p style="color:#8a8aa0;font-size:13px;margin:0 0 18px;line-height:1.5;">Trial de ${info.trialDays || 7} dias no plano ${info.plan || 'negocio'}. Bom momento pra um follow-up de CS.</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
      ${row('Nome', info.name)}
      ${row('Empresa', info.companyName)}
      ${row('E-mail', info.email)}
      ${row('Telefone', info.phone)}
      ${row('CNPJ', info.cnpj)}
      ${row('CPF (sem CNPJ)', info.cpf)}
      ${row('Plano', info.plan)}
      ${row('Trial até', info.trialEndsAt)}
    </table>`;
  return sendMail({
    to,
    subject: `Nova conta self-service: ${info.companyName || info.email}`,
    html: emailLayout(content),
    text: `Nova conta self-service\nNome: ${info.name || '-'}\nEmpresa: ${info.companyName || '-'}\nE-mail: ${info.email || '-'}\nTelefone: ${info.phone || '-'}\nCNPJ: ${info.cnpj || '-'}${info.cpf ? '\nCPF (sem CNPJ): ' + info.cpf : ''}\nPlano: ${info.plan || '-'}\nTrial ate: ${info.trialEndsAt || '-'}`,
  });
}

// -- Template: fim do desconto por varios meses (jobs/subscriptionDiscountJob) --
// Vai 5 dias antes da primeira mensalidade cheia. So e enviado depois que a
// assinatura ja voltou ao valor cheio no Asaas, entao o valor dito aqui e o
// que sera cobrado.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendDiscountEndingEmail(to, opts) {
  const { firstName, companyName, planName, months, discountedValue, fullValue, dueDate } = opts;
  const fmtR = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
  const [y, m, d] = String(dueDate).slice(0, 10).split('-');
  const dueLabel = `${d}/${m}/${y}`;
  const plan = escapeHtml(planName);
  const company = companyName ? ` de <strong style="color:#e2e8f0;">${escapeHtml(companyName)}</strong>` : '';

  const html = emailLayout(`
    <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Ol&aacute;${firstName ? ', ' + escapeHtml(firstName) : ''}!</p>
    <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 20px;">
      As ${months} mensalidades com desconto do plano <strong style="color:#e2e8f0;">${plan}</strong>${company} chegaram ao fim.
      A partir de <strong style="color:#e2e8f0;">${dueLabel}</strong>, sua mensalidade volta ao valor normal:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr><td align="center" style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:14px;padding:20px;">
        <p style="margin:0 0 6px;font-size:13px;color:#64748b;text-decoration:line-through;">${fmtR(discountedValue)} por m&ecirc;s</p>
        <p style="margin:0;font-size:24px;font-weight:800;color:#c4b5fd;">${fmtR(fullValue)} <span style="font-size:13px;font-weight:600;color:#94a3b8;">por m&ecirc;s</span></p>
      </td></tr>
    </table>
    <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 16px;">
      Voc&ecirc; n&atilde;o precisa fazer nada: a cobran&ccedil;a continua na mesma forma de pagamento de hoje.
    </p>
    <p style="font-size:11px;color:#64748b;margin:0;">D&uacute;vidas? Fale com a gente em
      <a href="mailto:contato@getaura.com.br" style="color:#7c3aed;text-decoration:none;">contato@getaura.com.br</a>.</p>
  `);

  return sendMail({
    to,
    subject: `Seu desconto terminou: a mensalidade volta a ${fmtR(fullValue)} em ${dueLabel}`,
    text: `Ola${firstName ? ' ' + firstName : ''}! As ${months} mensalidades com desconto do plano ${planName} chegaram ao fim. ` +
      `A partir de ${dueLabel}, sua mensalidade volta ao valor normal de ${fmtR(fullValue)} (antes ${fmtR(discountedValue)}). ` +
      `Voce nao precisa fazer nada. Duvidas: contato@getaura.com.br`,
    html,
  });
}

module.exports = {
  sendMail,
  definirRegistroDeEnvio,
  emailLayout,
  escapeHtml,
  sendDiscountEndingEmail,
  sendVerificationEmail,
  sendVerificationLinkEmail,
  sendPasswordResetEmail,
  sendInviteEmail,
  sendOrderStatusEmail,
  sendOwnerNewOrderEmail,
  sendWeeklyReport,
  sendSelfServeSignupNotification,
};
