// ============================================================
// AURA. — Mercado Pago por OAuth (tq-94, 29/10/2026)
//
// A lojista toca em "Conectar com Mercado Pago", entra na conta dela e
// autoriza a aplicação da Aura. O Mercado Pago devolve um `code` na URL de
// retorno; trocamos por access_token + refresh_token + public_key + user_id
// e guardamos cifrado em companies_payment_gateways (services/mpGateway.js).
//
// Este arquivo só fala com o Mercado Pago e assina o `state`. Banco fica no
// mpGateway.js; rotas em routes/paymentGateways.js e routes/mpOAuthCallback.js.
//
// ── ENV ────────────────────────────────────────────────────────────────
//   MP_CLIENT_ID       — App ID da aplicação da Aura no painel do Mercado Pago
//   MP_CLIENT_SECRET   — Client secret da mesma aplicação
//   MP_WEBHOOK_SECRET  — assinatura secreta dos webhooks da aplicação (tq-95)
//   MP_REDIRECT_URI    — opcional; padrão <STOREFRONT_API_BASE_URL>/api/v1/mp/oauth/callback
//   CERT_MASTER_KEY    — chave AES-256-GCM já usada nos segredos fiscais
//                        (utils/secretCrypto). Sem ela não guardamos token.
// Sem MP_CLIENT_ID, MP_CLIENT_SECRET ou CERT_MASTER_KEY o OAuth fica
// desligado: o app não mostra o botão e as rotas respondem 503.
//
// ── STATE (contra CSRF) ────────────────────────────────────────────────
// base64url(JSON{ c: company_id, u: user_id, s: sandbox, r: caminho de volta,
// e: expiração (s), n: nonce }) + "." + HMAC-SHA256 base64url. A chave do
// HMAC deriva do MP_CLIENT_SECRET, que nunca sai do servidor. Vale 10 min.
// O `code` do Mercado Pago é de uso único, então repetir o retorno não
// grava nada duas vezes.
// ============================================================
'use strict';

const crypto = require('crypto');
const { hasMasterKey } = require('../utils/secretCrypto');
const { enderecoDaApi } = require('../config/enderecoDaApi');

const MP_AUTH_BASE = 'https://auth.mercadopago.com.br';
const MP_API_BASE  = 'https://api.mercadopago.com';
const STATE_TTL_S  = 10 * 60;
const HTTP_TIMEOUT_MS = 10000;

function clientId()      { return String(process.env.MP_CLIENT_ID || '').trim(); }
function clientSecret()  { return String(process.env.MP_CLIENT_SECRET || '').trim(); }
function webhookSecret() { return String(process.env.MP_WEBHOOK_SECRET || '').trim(); }

function redirectUri() {
  const explicita = String(process.env.MP_REDIRECT_URI || '').trim();
  if (explicita) return explicita;
  return enderecoDaApi() + '/api/v1/mp/oauth/callback';
}

/** true quando dá para conectar por OAuth (credenciais da aplicação + chave de cifra). */
function oauthDisponivel() {
  return !!(clientId() && clientSecret() && hasMasterKey());
}

// ── state assinado ──────────────────────────────────────────────────────

function stateKey() {
  return crypto.createHmac('sha256', clientSecret()).update('aura-mp-oauth-state-v1').digest();
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

/** Caminho de volta dentro do app: relativo, sem esquema nem host. */
function caminhoSeguro(r) {
  if (typeof r !== 'string') return null;
  const v = r.trim();
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\') || v.length > 200) return null;
  if (/[\s<>"']/.test(v)) return null;
  return v;
}

function signState({ companyId, userId, sandbox = false, returnPath = null, now = Date.now() }) {
  const payload = {
    c: String(companyId),
    u: userId ? String(userId) : null,
    s: sandbox ? 1 : 0,
    r: caminhoSeguro(returnPath),
    e: Math.floor(now / 1000) + STATE_TTL_S,
    n: crypto.randomBytes(12).toString('base64url'),
  };
  const body = b64url(JSON.stringify(payload));
  const sig  = b64url(crypto.createHmac('sha256', stateKey()).update(body).digest());
  return `${body}.${sig}`;
}

/** Devolve { companyId, userId, sandbox, returnPath } ou lança Error com .code. */
function verifyState(state, { now = Date.now() } = {}) {
  const fail = (code) => { const e = new Error('state inválido: ' + code); e.code = code; throw e; };
  if (typeof state !== 'string' || state.length > 2048) fail('formato');
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail('formato');
  const [body, sig] = parts;
  const esperado = crypto.createHmac('sha256', stateKey()).update(body).digest();
  let recebido;
  try { recebido = Buffer.from(sig, 'base64url'); } catch (_) { fail('assinatura'); }
  if (recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) fail('assinatura');
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { fail('formato'); }
  if (!p || !p.c || !p.e) fail('formato');
  if (Math.floor(now / 1000) > Number(p.e)) fail('expirado');
  return { companyId: String(p.c), userId: p.u || null, sandbox: p.s === 1, returnPath: caminhoSeguro(p.r) };
}

// ── URLs e chamadas ao Mercado Pago ─────────────────────────────────────

function buildAuthUrl({ state }) {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    platform_id: 'mp',
    state,
    redirect_uri: redirectUri(),
  });
  return `${MP_AUTH_BASE}/authorization?${params.toString()}`;
}

async function mpFetch(path, { method = 'GET', token, body } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const resp = await fetch(MP_API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  let json = null;
  try { json = await resp.json(); } catch (_) { json = null; }
  return { status: resp.status, ok: resp.ok, json };
}

/** Erro do token com o motivo do Mercado Pago (sem ecoar token nem segredo). */
function tokenError(status, json) {
  const motivo = (json && (json.error || json.message)) || 'erro';
  const e = new Error(`MP oauth/token ${status}: ${motivo}`);
  e.status = status;
  e.mpError = json && json.error ? String(json.error) : null;
  // invalid_grant = autorização retirada, refresh vencido ou já usado.
  e.revogado = e.mpError === 'invalid_grant' || status === 401;
  return e;
}

function normalizarToken(json) {
  if (!json || !json.access_token) throw new Error('MP oauth/token: resposta sem access_token');
  const expiresIn = Number(json.expires_in) || 15552000; // 180 dias
  return {
    access_token:  String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : null,
    public_key:    json.public_key ? String(json.public_key) : null,
    user_id:       json.user_id != null ? String(json.user_id) : null,
    live_mode:     json.live_mode !== false,
    expires_at:    new Date(Date.now() + expiresIn * 1000),
  };
}

async function exchangeCode({ code, sandbox = false }) {
  const body = {
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: redirectUri(),
  };
  if (sandbox) body.test_token = 'true';
  const r = await mpFetch('/oauth/token', { method: 'POST', body });
  if (!r.ok) throw tokenError(r.status, r.json);
  return normalizarToken(r.json);
}

async function refreshToken({ refreshToken: rt }) {
  const r = await mpFetch('/oauth/token', {
    method: 'POST',
    body: {
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
      refresh_token: String(rt),
    },
  });
  if (!r.ok) throw tokenError(r.status, r.json);
  return normalizarToken(r.json);
}

/**
 * GET /users/me — nome da conta para "Conectado como" e checagem diária.
 * @returns {{ ok:boolean, status:number, nickname:string|null, id:string|null }}
 */
async function getUserMe({ accessToken }) {
  const r = await mpFetch('/users/me', { token: accessToken });
  if (!r.ok) return { ok: false, status: r.status, nickname: null, id: null };
  const j = r.json || {};
  const nome = j.nickname || [j.first_name, j.last_name].filter(Boolean).join(' ') || null;
  return { ok: true, status: r.status, nickname: nome ? String(nome).slice(0, 120) : null, id: j.id != null ? String(j.id) : null };
}

module.exports = {
  MP_AUTH_BASE, MP_API_BASE, STATE_TTL_S,
  clientId, clientSecret, webhookSecret, redirectUri, oauthDisponivel,
  signState, verifyState, caminhoSeguro, buildAuthUrl,
  exchangeCode, refreshToken, getUserMe,
};
