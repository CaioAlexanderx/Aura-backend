// ============================================================
// AURA. — Links assinados dos e-mails (tq-74/tq-77, 24/10/2026)
//
// Dois links públicos saem nos e-mails e não podem ser forjados:
//   - descadastro (tq-74): /emails/descadastro/<token> — o token diz a
//     empresa e o tipo de e-mail; quem tem o link desliga aquele tipo.
//   - QR do Pix (tq-77): /emails/pix-qr/<token>.png — o token carrega o
//     copia e cola; a rota só desenha o QR (o Gmail não mostra imagem em
//     data: e anexo cid está fora, regra 8).
//
// Token = base64url(JSON) + '.' + base64url(HMAC-SHA256). Sem validade: o
// link de descadastro precisa funcionar meses depois (RFC 8058) e o QR é só
// a imagem de um texto que já está no corpo do e-mail.
//
// Segredo: EMAIL_LINK_SECRET, senão JWT_SECRET (sempre presente no
// servidor). Sem nenhum dos dois só em teste/dev há um segredo fixo; em
// produção os links não saem (assinar devolve null) em vez de sair com
// segredo previsível.
// ============================================================
'use strict';

const crypto = require('crypto');

const API_URL_PADRAO = 'https://aura-backend-production-f805.up.railway.app/api/v1';

function segredo(env = process.env) {
  const s = env.EMAIL_LINK_SECRET || env.JWT_SECRET;
  if (s) return String(s);
  if (env.NODE_ENV === 'production') return null;
  return 'aura-email-link-dev';
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function assinar(dados, env = process.env) {
  const s = segredo(env);
  if (!s) return null;
  const corpo = b64(JSON.stringify(dados));
  const mac = crypto.createHmac('sha256', s).update(corpo).digest('base64url');
  return `${corpo}.${mac}`;
}

function ler(token, env = process.env) {
  const s = segredo(env);
  if (!s || typeof token !== 'string' || token.length > 2048) return null;
  const partes = token.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
  const esperado = crypto.createHmac('sha256', s).update(partes[0]).digest('base64url');
  const a = Buffer.from(partes[1]);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const dados = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
    return dados && typeof dados === 'object' ? dados : null;
  } catch (_) {
    return null;
  }
}

function apiUrl(env = process.env) {
  return String(env.API_URL || API_URL_PADRAO).replace(/\/+$/, '');
}

// ── Descadastro ────────────────────────────────────────────────

/** Token de descadastro: empresa + tipo (+ grupo do dono, no consolidado). */
function tokenDescadastro(companyId, tipo, { grupo = false } = {}, env = process.env) {
  if (!companyId || !tipo) return null;
  return assinar({ k: 'd', c: String(companyId), t: String(tipo), g: grupo ? 1 : 0 }, env);
}

function lerTokenDescadastro(token, env = process.env) {
  const d = ler(token, env);
  if (!d || d.k !== 'd' || !d.c || !d.t) return null;
  return { companyId: d.c, tipo: d.t, grupo: d.g === 1 };
}

function linkDescadastro(companyId, tipo, opts = {}, env = process.env) {
  const t = tokenDescadastro(companyId, tipo, opts, env);
  return t ? `${apiUrl(env)}/emails/descadastro/${t}` : null;
}

/** Cabeçalhos do RFC 2369 + RFC 8058 (descadastro de um clique). */
function cabecalhosDescadastro(link) {
  if (!link) return null;
  return {
    'List-Unsubscribe': `<${link}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// ── QR do Pix ──────────────────────────────────────────────────

const PIX_MAX = 600;

function linkQrDoPix(copiaECola, env = process.env) {
  const codigo = String(copiaECola || '').trim();
  if (!codigo || codigo.length > PIX_MAX) return null;
  const t = assinar({ k: 'q', p: codigo }, env);
  return t ? `${apiUrl(env)}/emails/pix-qr/${t}.png` : null;
}

function lerTokenQr(token, env = process.env) {
  const d = ler(String(token || '').replace(/\.png$/i, ''), env);
  if (!d || d.k !== 'q' || typeof d.p !== 'string' || !d.p || d.p.length > PIX_MAX) return null;
  return d.p;
}

module.exports = {
  assinar,
  ler,
  apiUrl,
  tokenDescadastro,
  lerTokenDescadastro,
  linkDescadastro,
  cabecalhosDescadastro,
  linkQrDoPix,
  lerTokenQr,
};
