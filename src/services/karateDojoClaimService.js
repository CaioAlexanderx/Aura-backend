// ============================================================
// AURA KARATÊ — F0 Aura Dojô: claim da conta do dojô (convite ao owner real)
//
// CONTEXTO: quando a federação cadastra um dojô (POST /federation/:id/dojos,
// ver karateDojos.js), o owner criado é um usuário de SISTEMA com senha
// '!locked-system-no-login' ('Sistema Dojôs') — nenhum dojô da base
// consegue logar. O produto Aura Dojô (R$140/mês —
// billingPricing.KARATE_DOJO_MONTHLY_BRL) precisa de um owner REAL:
// a federação convida o e-mail do sensei, ele define a senha no link
// público e a company do dojô passa a ser dele.
//
// OWNERSHIP: companies.owner_id (NOT NULL). O claim faz UPDATE companies
// SET owner_id = <novo user> APENAS na company do dojô reclamado — o
// user-sistema é COMPARTILHADO entre os dojôs da federação (ver
// karateDojos.js: reusa o dono de um dojô existente), então NUNCA mexer
// nos demais dojôs nem no próprio user-sistema. Espelha auth.js/register:
// além do owner_id, garante company_members (role_label 'owner', active).
//
// TOKEN: crypto.randomBytes(32).hex — armazenado SÓ como
// SHA-256(token::segredo) (mesmo padrão de karateDojoPortalAuthService).
// TTL 7 dias. Convite novo invalida os pendentes anteriores do dojô.
//
// TRANSAÇÃO (armadilha tx-poison do CLAUDE.md): nenhum try/catch
// best-effort dentro do BEGIN — falha de regra faz ROLLBACK e retorna;
// erro inesperado faz ROLLBACK no catch externo e propaga.
//
// Senha: bcrypt.hash(password, 12) — MESMO custo/mecanismo de
// src/routes/auth.js (login compara com bcrypt.compare).
//
// Migration 240 (karate_dojo_owner_invites) — NÃO aplicada neste PR.
// As rotas tratam 42P01 (tabela ausente) de forma defensiva.
// ============================================================
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();
const CLAIM_TOKEN_SECRET = process.env.KARATE_CLAIM_TOKEN_SECRET || env.JWT_SECRET;
const INVITE_TTL_DAYS = 7;
const LOCKED_SYSTEM_PASSWORD = '!locked-system-no-login';

const hashToken = (token) =>
  crypto.createHash('sha256').update(`${token}::${CLAIM_TOKEN_SECRET}`).digest('hex');

function maskEmail(email) {
  if (!email) return null;
  const [u, d] = String(email).split('@');
  if (!d) return null;
  return `${u.slice(0, 1)}***@${d.slice(0, 1)}***`;
}

// Owner de sistema = senha travada (karateDojos.js) OU user inexistente
// (LEFT JOIN sem match — defensivo). Owner real = hash bcrypt de verdade.
function isSystemOwner(ownerPasswordHash) {
  return !ownerPasswordHash || ownerPasswordHash === LOCKED_SYSTEM_PASSWORD;
}

/**
 * createInvite — cria convite de claim para o dojô.
 * Valida: dojô pertence à federação + owner atual ainda é o user-sistema.
 * Invalida convites pendentes anteriores do mesmo dojô (expires_at=NOW()).
 * Retorna o token EM CLARO (vai só no e-mail; nunca persistido/loggado).
 */
async function createInvite({ federationId, dojoId, email, createdBy }) {
  const dojoRes = await db.query(
    `SELECT c.id, c.owner_id,
            COALESCE(c.name, c.trade_name, c.legal_name) AS dojo_name,
            COALESCE(f.name, f.trade_name, f.legal_name) AS federation_name,
            f.slug AS federation_slug,
            u.password_hash AS owner_password_hash
       FROM companies c
       JOIN companies f ON f.id = c.federation_id
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.id = $1 AND c.federation_id = $2 AND c.vertical = 'karate_dojo'
      LIMIT 1`,
    [dojoId, federationId]
  );
  if (!dojoRes.rows.length) {
    return { ok: false, http: 404, code: 'NOT_FOUND', error: 'Dojô não encontrado nesta federação' };
  }
  const dojo = dojoRes.rows[0];
  if (!isSystemOwner(dojo.owner_password_hash)) {
    return { ok: false, http: 409, code: 'DOJO_JA_RECLAMADO', error: 'Este dojô já tem um responsável com conta própria' };
  }

  // Convite novo invalida os pendentes anteriores do MESMO dojô.
  await db.query(
    `UPDATE karate_dojo_owner_invites
        SET expires_at = NOW()
      WHERE dojo_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [dojoId]
  );

  const token = crypto.randomBytes(32).toString('hex');
  const ins = await db.query(
    `INSERT INTO karate_dojo_owner_invites
       (dojo_id, federation_id, email, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${INVITE_TTL_DAYS} days', $5)
     RETURNING id, expires_at`,
    [dojoId, federationId, String(email).toLowerCase().trim(), hashToken(token), createdBy || null]
  );

  return {
    ok: true,
    token, // sai SÓ no e-mail do sensei — nunca na resposta da API da federação
    invite_id: ins.rows[0].id,
    expires_at: ins.rows[0].expires_at,
    dojo_name: dojo.dojo_name,
    federation_name: dojo.federation_name,
    federation_slug: dojo.federation_slug,
  };
}

/**
 * verifyToken — valida o token do link público e devolve os dados mínimos
 * para a tela de claim (nome do dojô/federação + e-mail mascarado).
 * Nunca devolve o e-mail em claro nem o token/hash.
 */
async function verifyToken(token) {
  const r = await db.query(
    `SELECT i.id, i.email, i.expires_at, i.used_at,
            COALESCE(d.name, d.trade_name, d.legal_name) AS dojo_name,
            COALESCE(f.name, f.trade_name, f.legal_name) AS federation_name,
            u.password_hash AS owner_password_hash
       FROM karate_dojo_owner_invites i
       JOIN companies d ON d.id = i.dojo_id
       JOIN companies f ON f.id = i.federation_id
       LEFT JOIN users u ON u.id = d.owner_id
      WHERE i.token_hash = $1
      LIMIT 1`,
    [hashToken(String(token || '').trim())]
  );
  if (!r.rows.length) {
    return { ok: false, http: 404, code: 'CONVITE_INVALIDO', error: 'Convite inválido ou expirado' };
  }
  const inv = r.rows[0];
  if (inv.used_at) {
    return { ok: false, http: 409, code: 'CLAIM_JA_REALIZADO', error: 'Este convite já foi utilizado. Faça login normalmente.' };
  }
  if (!isSystemOwner(inv.owner_password_hash)) {
    return { ok: false, http: 409, code: 'DOJO_JA_RECLAMADO', error: 'Este dojô já tem um responsável com conta própria' };
  }
  if (new Date(inv.expires_at) <= new Date()) {
    return { ok: false, http: 410, code: 'CONVITE_EXPIRADO', error: 'Convite expirado. Peça um novo à federação.' };
  }
  return {
    ok: true,
    dojoName: inv.dojo_name,
    federationName: inv.federation_name,
    email: maskEmail(inv.email),
  };
}

/**
 * completeClaim — executa o claim em TRANSAÇÃO:
 *  (a) usa o user existente do e-mail do convite, ou cria user real
 *      (bcrypt 12, mesmo mecanismo de auth.js);
 *  (b) troca o ownership da company do dojô (companies.owner_id) do
 *      user-sistema para o user real + garante company_members 'owner';
 *  (c) marca used_at no convite.
 * Idempotente: token já usado → 409 CLAIM_JA_REALIZADO.
 */
async function completeClaim({ token, name, password }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `SELECT i.id, i.dojo_id, i.email, i.expires_at, i.used_at,
              d.owner_id AS current_owner_id,
              u.password_hash AS owner_password_hash
         FROM karate_dojo_owner_invites i
         JOIN companies d ON d.id = i.dojo_id
         LEFT JOIN users u ON u.id = d.owner_id
        WHERE i.token_hash = $1
        LIMIT 1
        FOR UPDATE OF i`,
      [hashToken(String(token || '').trim())]
    );
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, http: 404, code: 'CONVITE_INVALIDO', error: 'Convite inválido ou expirado' };
    }
    const inv = r.rows[0];
    if (inv.used_at) {
      await client.query('ROLLBACK');
      return { ok: false, http: 409, code: 'CLAIM_JA_REALIZADO', error: 'Este convite já foi utilizado. Faça login normalmente.' };
    }
    if (!isSystemOwner(inv.owner_password_hash)) {
      await client.query('ROLLBACK');
      return { ok: false, http: 409, code: 'DOJO_JA_RECLAMADO', error: 'Este dojô já tem um responsável com conta própria' };
    }
    if (new Date(inv.expires_at) <= new Date()) {
      await client.query('ROLLBACK');
      return { ok: false, http: 410, code: 'CONVITE_EXPIRADO', error: 'Convite expirado. Peça um novo à federação.' };
    }

    // (a) user do e-mail do convite: usa se existir; senão cria real.
    const emailNorm = String(inv.email).toLowerCase().trim();
    const existing = await client.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [emailNorm]
    );
    let userId;
    let createdUser = false;
    if (existing.rows.length) {
      // Conta já existe: NÃO sobrescreve a senha dela — o sensei loga com a
      // senha que já tem (ou usa o reset de senha normal).
      userId = existing.rows[0].id;
    } else {
      const passwordHash = await bcrypt.hash(String(password), 12); // = auth.js
      const isStaff = emailNorm.endsWith('@getaura.com.br');
      const created = await client.query(
        `INSERT INTO users (full_name, email, password_hash, role, is_staff)
         VALUES ($1, $2, $3, 'client', $4)
         RETURNING id`,
        [String(name).trim(), emailNorm, passwordHash, isStaff]
      );
      userId = created.rows[0].id;
      createdUser = true;
    }

    // (b) troca o ownership SÓ da company deste dojô (user-sistema é
    // compartilhado entre os dojôs da federação — nunca tocar nos demais).
    await client.query(
      `UPDATE companies SET owner_id = $1, updated_at = NOW() WHERE id = $2`,
      [userId, inv.dojo_id]
    );

    // Espelha auth.js/register: owner também ganha entry em company_members
    // (resolveDefaultContext usa owner_id OR company_members — redundância
    // intencional, mesma do cadastro normal).
    const member = await client.query(
      `SELECT id FROM company_members WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
      [inv.dojo_id, userId]
    );
    if (!member.rows.length) {
      await client.query(
        `INSERT INTO company_members (company_id, user_id, role_label, status, is_active)
         VALUES ($1, $2, 'owner', 'active', true)`,
        [inv.dojo_id, userId]
      );
    }

    // (c) marca o convite como usado.
    await client.query(
      `UPDATE karate_dojo_owner_invites SET used_at = NOW() WHERE id = $1`,
      [inv.id]
    );

    await client.query('COMMIT');
    return { ok: true, user_id: userId, dojo_id: inv.dojo_id, created_user: createdUser };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão já caiu */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  createInvite,
  verifyToken,
  completeClaim,
  hashToken,
  maskEmail,
  isSystemOwner,
  LOCKED_SYSTEM_PASSWORD,
  INVITE_TTL_DAYS,
};
