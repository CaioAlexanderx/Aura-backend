// ============================================================
// AURA. — Renovação da sessão (POST /auth/refresh)
//
// Criado: 09/11/2026 (incidente: o app instalado desloga)
//
// Duas regras, e só duas:
//
// 1. O /refresh só responde 401 quando o refresh token é de fato inválido,
//    expirado ou revogado, ou o usuário foi desativado. Qualquer outra falha
//    (banco fora, timeout do pooler, erro ao montar o contexto) é NOSSA e
//    sai como 503: o app trata como falha de rede e não desloga ninguém.
//    Antes, tudo caía no mesmo catch e virava 401 "Refresh token invalido".
//
// 2. App instalado (PWA, app_mode = 'standalone'): prazo DESLIZANTE. A
//    sessão vale 30 dias SEM USO, contados do último /refresh, e não 7 dias
//    contados do login. O prazo de verdade fica na linha do banco
//    (refresh_tokens.expires_at, renovado a cada /refresh); o JWT do refresh
//    deslizante carrega `sl: 1` e um exp longo (365 dias), que é só o teto.
//    Quando o teto chega perto (ou o token é o antigo, de 7 dias), o
//    /refresh devolve um refresh token NOVO e o antigo continua válido até o
//    próprio exp. Assim, uma resposta perdida (app suspenso no meio da
//    requisição) não vira logout: o app manda o antigo de novo e recebe
//    outro novo.
//
// O navegador comum não muda: 7 dias do login, sem deslizar, sem token novo.
// Sem migration: usa as colunas que refresh_tokens já tem.
//
// 09/11/2026 (mais tarde): o /refresh mantém a EMPRESA em que a pessoa
// estava. Antes ele sempre assinava o access token novo com o contexto
// padrão (resolveDefaultContext): depois de 1 h, quem tinha escolhido outra
// empresa no seletor voltava sozinho para a principal (ou o consolidado).
// Agora o app manda `company_id` no corpo (o id da empresa atual, ou 'all'
// no consolidado). O id NUNCA é assinado só porque veio no corpo: passa pela
// mesma checagem do switch-company (services/empresaComAcesso.js). Sem
// acesso (removido da empresa, empresa de outra conta, empresa inativa, id
// estranho) = contexto padrão, como antes. Sem o campo (app antigo) =
// exatamente o de antes. 'all' = contexto padrão, que para 2+ empresas já é o
// consolidado (a mesma regra do switch-company: consolidado exige 2+).
// ============================================================
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { appModeDoCabecalho } = require('../utils/appMode');

const DIA_MS = 24 * 60 * 60 * 1000;

// Navegador comum: o de sempre.
const REFRESH_TTL = '7d';
const REFRESH_TTL_MS = 7 * DIA_MS;

// App instalado.
const INATIVIDADE_STANDALONE_MS = 30 * DIA_MS;
const TETO_STANDALONE = '365d';
// Faltando menos que isto para o teto do JWT, o /refresh entrega um novo.
const RENOVAR_QUANDO_RESTAR_MS = 30 * DIA_MS;

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

/** O login/cadastro vem do app instalado? (cabeçalho X-Aura-App) */
function ehStandalone(req) {
  return appModeDoCabecalho(req && req.headers ? req.headers['x-aura-app'] : undefined) === 'standalone';
}

/**
 * Assina um refresh token. Deslizante (app instalado) ou o de 7 dias.
 * @returns {{ token: string, jti: string, expiresAt: Date, deslizante: boolean }}
 */
function assinarRefresh(payload, secret, { deslizante, agora = Date.now() } = {}) {
  const jti = crypto.randomUUID();
  if (deslizante) {
    const token = jwt.sign({ ...payload, type: 'refresh', jti, sl: 1 }, secret, { expiresIn: TETO_STANDALONE });
    return { token, jti, expiresAt: new Date(agora + INATIVIDADE_STANDALONE_MS), deslizante: true };
  }
  const token = jwt.sign({ ...payload, type: 'refresh', jti }, secret, { expiresIn: REFRESH_TTL });
  return { token, jti, expiresAt: new Date(agora + REFRESH_TTL_MS), deslizante: false };
}

/** Grava a linha do refresh token. Lança em erro de banco (quem chama decide). */
async function gravarRefresh(db, { userId, token, expiresAt, req, appMode }) {
  const base = [userId, hashToken(token), expiresAt, req.ip, ((req.headers && req.headers['user-agent']) || '').substring(0, 200)];
  try {
    await db.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent, app_mode) VALUES ($1, $2, $3, $4, $5, $6)', [...base, appMode]);
  } catch (err) {
    // 42703 = coluna app_mode ainda não existe: grava do jeito antigo.
    if (err && err.code === '42703') {
      await db.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)', base);
      return;
    }
    throw err;
  }
}

class FalhaDoServidor extends Error {
  constructor(etapa, causa) { super('refresh: falha em ' + etapa); this.etapa = etapa; this.causa = causa; }
}

async function etapa(nome, fn) {
  try { return await fn(); } catch (err) { throw new FalhaDoServidor(nome, err); }
}

const r401 = (error, code) => ({ status: 401, body: { error, code }, limparCookie: true });

/**
 * O que o app pediu no corpo: 'all' (consolidado), um id, ou null (nada).
 * Mesmos valores que o switch-company aceita para o consolidado.
 */
function lerEmpresaPedida(valor) {
  if (valor === 'all' || valor === '*') return 'all';
  if (typeof valor === 'string' && valor.trim()) return valor.trim();
  return null;
}

/**
 * Contexto do access token novo. Empresa pedida e com acesso = ela; qualquer
 * outro caso = o padrão de sempre.
 */
async function escolherContexto(p, userId) {
  const pedida = lerEmpresaPedida(p.empresaPedida);
  if (pedida && pedida !== 'all' && typeof p.buscarEmpresaComAcesso === 'function') {
    // Erro de banco aqui é 503 (etapa), nunca "cai no padrão": cair no padrão
    // por um timeout seria o mesmo pulo de empresa que este código evita.
    const empresa = await etapa('empresa_escolhida', () => p.buscarEmpresaComAcesso(userId, pedida));
    if (empresa) {
      return { primary: empresa, consolidated: false, effectivePlan: empresa.plan || 'essencial' };
    }
  }
  return etapa('contexto', () => p.resolveDefaultContext(userId));
}

/**
 * Lógica do POST /auth/refresh, sem Express (testável com um db falso).
 *
 * @param {object} p
 * @param {string} p.token            refresh token recebido
 * @param {object} p.req              { headers, ip }
 * @param {object} p.db               { query(sql, params) }
 * @param {string} p.secret           JWT_SECRET
 * @param {Function} p.resolveDefaultContext  (userId) => ctx
 * @param {Function} p.resolveKarateContext   (company) => karateCtx
 * @param {Function} p.signAccessToken        (payload) => string
 * @param {string}  [p.empresaPedida]  req.body.company_id: id da empresa atual ou 'all'
 * @param {Function} [p.buscarEmpresaComAcesso] (userId, companyId) => empresa|null
 * @param {number} [p.agora]          Date.now() (testes)
 * @returns {Promise<{ status: number, body: object, novoRefresh?: string, limparCookie?: boolean }>}
 */
async function processarRefresh(p) {
  const agora = p.agora || Date.now();
  const { db } = p;

  // 1. O token em si. Só aqui nasce o 401 de "token ruim".
  let decoded;
  try {
    decoded = jwt.verify(p.token, p.secret);
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') return r401('Refresh token expirado', 'REFRESH_EXPIRED');
    return r401('Refresh token invalido', 'REFRESH_INVALID');
  }
  if (!decoded || decoded.type !== 'refresh') return { status: 400, body: { error: 'Token nao e refresh' } };

  try {
    // 2. A linha do banco: revogado e (no deslizante) o prazo de inatividade.
    const tokenHash = hashToken(p.token);
    const { rows } = await etapa('refresh_tokens', () => db.query(
      'SELECT id, revoked, expires_at, app_mode FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2',
      [tokenHash, decoded.id],
    ));
    const linha = rows[0] || null;
    if (linha && linha.revoked) return r401('Refresh token revogado', 'REFRESH_REVOKED');

    const jaDeslizante = decoded.sl === 1;
    if (jaDeslizante && linha && linha.expires_at && new Date(linha.expires_at).getTime() <= agora) {
      return r401('Sessao expirada por inatividade', 'REFRESH_EXPIRED');
    }
    // Token antigo (7 dias) de quem está no app instalado: passa a deslizar.
    const deslizante = jaDeslizante || (linha && linha.app_mode === 'standalone') || ehStandalone(p.req);

    // 3. O usuário. Desativado = 401 legítimo.
    const { rows: uRows } = await etapa('users', () => db.query(
      'SELECT id, role, is_staff FROM users WHERE id = $1 AND is_active = true',
      [decoded.id],
    ));
    if (!uRows.length) return r401('Usuario desativado', 'USER_INACTIVE');
    const user = uRows[0];

    // 4. Contexto e access token novo.
    const ctx = await escolherContexto(p, user.id);
    const karateCtx = ctx.consolidated
      ? { federation_id: null, karate_role: null, dojo_id: null }
      : await etapa('contexto_karate', () => p.resolveKarateContext(ctx.primary));
    const token = await etapa('assinatura', () => p.signAccessToken({
      id: user.id,
      role: user.role,
      plan: ctx.effectivePlan,
      company: ctx.consolidated ? null : (ctx.primary ? ctx.primary.id : null),
      is_staff: user.is_staff || false,
      consolidated_view: ctx.consolidated,
      federation_id: karateCtx.federation_id,
      karate_role: karateCtx.karate_role,
      dojo_id: karateCtx.dojo_id,
    }));
    // current_company_id: a empresa do token novo (null no consolidado). O
    // app compara com a que tem guardada: diferente = a pessoa perdeu o
    // acesso à escolhida e o servidor caiu no padrão.
    const body = {
      token,
      token_expires_in: '1h',
      consolidated_view: ctx.consolidated,
      current_company_id: ctx.consolidated ? null : (ctx.primary ? ctx.primary.id : null),
    };
    if (!deslizante) return { status: 200, body };

    // 5. Deslizante: renova o prazo. Falha aqui não derruba a resposta: o
    //    access token já está pronto e o prazo antigo ainda vale.
    const restaMs = (decoded.exp ? decoded.exp * 1000 : 0) - agora;
    if (jaDeslizante && restaMs > RENOVAR_QUANDO_RESTAR_MS) {
      const novoPrazo = new Date(agora + INATIVIDADE_STANDALONE_MS);
      try {
        if (linha) {
          await db.query('UPDATE refresh_tokens SET expires_at = $1 WHERE id = $2', [novoPrazo, linha.id]);
        } else {
          // Linha que não chegou a ser gravada no login: grava agora.
          await gravarRefresh(db, { userId: user.id, token: p.token, expiresAt: novoPrazo, req: p.req, appMode: 'standalone' });
        }
      } catch (err) {
        console.warn('[refresh] prazo deslizante nao renovado:', err && err.message);
      }
      return { status: 200, body: { ...body, refresh_expires_at: novoPrazo.toISOString() } };
    }

    // Teto perto, ou token antigo de 7 dias: refresh token novo. O antigo
    // NÃO é revogado (vale até o exp dele), então perder esta resposta não
    // desloga ninguém.
    try {
      const novo = assinarRefresh({ id: user.id }, p.secret, { deslizante: true, agora });
      await gravarRefresh(db, { userId: user.id, token: novo.token, expiresAt: novo.expiresAt, req: p.req, appMode: 'standalone' });
      return {
        status: 200,
        body: { ...body, refresh_token: novo.token, refresh_expires_at: novo.expiresAt.toISOString() },
        novoRefresh: novo.token,
      };
    } catch (err) {
      console.warn('[refresh] refresh token novo nao gravado; segue com o atual:', err && err.message);
      return { status: 200, body };
    }
  } catch (err) {
    if (err instanceof FalhaDoServidor) {
      console.error('[refresh] ' + err.message + ':', err.causa && (err.causa.message || err.causa));
      return { status: 503, body: { error: 'Nao foi possivel renovar a sessao agora. Tente de novo.', code: 'REFRESH_UNAVAILABLE' } };
    }
    console.error('[refresh] erro inesperado:', err);
    return { status: 503, body: { error: 'Nao foi possivel renovar a sessao agora. Tente de novo.', code: 'REFRESH_UNAVAILABLE' } };
  }
}

module.exports = {
  processarRefresh,
  lerEmpresaPedida,
  assinarRefresh,
  gravarRefresh,
  ehStandalone,
  hashToken,
  REFRESH_TTL,
  REFRESH_TTL_MS,
  INATIVIDADE_STANDALONE_MS,
  TETO_STANDALONE,
  RENOVAR_QUANDO_RESTAR_MS,
};
