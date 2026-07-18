// ============================================================
// AURA KARATÊ — F0 Canal B: serviço do LINK FIXO do portal do dojô
//
// Token opaco: crypto.randomBytes(32).toString('hex') (64 chars). No banco
// vai APENAS o hash SHA-256(segredo + token) — vazamento de dump não vaza
// links válidos (mesmo espírito do portal de roster, migrations 220/225,
// endurecido com hash conforme decisão do F0). O token em claro é devolvido
// uma única vez na criação.
//
// Segredo: KARATE_DOJO_PORTAL_TOKEN_SECRET (fallback JWT_SECRET). ⚠️ Trocar
// o segredo invalida TODOS os links emitidos (hash muda) — é o kill switch
// global; a revogação individual é revoked_at.
//
// Rotação: createLink revoga o ativo anterior do dojô antes de inserir o
// novo. São dois statements sem transação explícita (db.query direto, mesmo
// padrão dos serviços karatê testáveis com o mock do pool); se o INSERT
// falhar depois do UPDATE o dojô fica momentaneamente sem link ativo —
// basta repetir o POST.
//
// Defensivo a schema pendente (CLAUDE.md): 42P01 → erro claro com code
// SCHEMA_PENDING nas operações administrativas; resolveToken devolve null
// (o caminho público responde 401 genérico, sem vazar estado do schema).
// ============================================================
'use strict';

const crypto = require('crypto');
const db = require('../config/database');

const TOKEN_SECRET =
  process.env.KARATE_DOJO_PORTAL_TOKEN_SECRET || process.env.JWT_SECRET || '';

function hashToken(token) {
  return crypto
    .createHash('sha256')
    .update(`${TOKEN_SECRET}:${String(token || '')}`)
    .digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function asSchemaError(err) {
  if (err && err.code === '42P01') {
    const e = new Error(
      'Link do portal do dojô ainda não disponível — migration 239 (karate_dojo_portal_links) pendente.'
    );
    e.code = 'SCHEMA_PENDING';
    return e;
  }
  return err;
}

// Cria (rotacionando) o link fixo do dojô. Devolve o token em claro UMA
// única vez — quem chamou monta a URL e entrega à federação.
async function createLink({ dojoId, federationId, createdBy }) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  try {
    // Rotação: mata o link ativo anterior (histórico preservado).
    await db.query(
      `UPDATE karate_dojo_portal_links
          SET revoked_at = NOW()
        WHERE dojo_id = $1 AND revoked_at IS NULL`,
      [dojoId]
    );
    const { rows } = await db.query(
      `INSERT INTO karate_dojo_portal_links (dojo_id, federation_id, token_hash, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [dojoId, federationId, tokenHash, createdBy || null]
    );
    return { token, id: rows[0].id, created_at: rows[0].created_at };
  } catch (err) {
    throw asSchemaError(err);
  }
}

// Revoga o link ativo do dojô. true = revogou; false = não havia link ativo.
async function revokeLink({ dojoId, federationId }) {
  try {
    const { rows } = await db.query(
      `UPDATE karate_dojo_portal_links
          SET revoked_at = NOW()
        WHERE dojo_id = $1 AND federation_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [dojoId, federationId]
    );
    return rows.length > 0;
  } catch (err) {
    throw asSchemaError(err);
  }
}

// Status do link mais recente do dojô — NUNCA devolve token nem hash.
async function getLinkStatus({ dojoId, federationId }) {
  try {
    const { rows } = await db.query(
      `SELECT created_at, revoked_at
         FROM karate_dojo_portal_links
        WHERE dojo_id = $1 AND federation_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [dojoId, federationId]
    );
    if (!rows.length) return { active: false, created_at: null, revoked_at: null };
    return {
      active: !rows[0].revoked_at,
      created_at: rows[0].created_at,
      revoked_at: rows[0].revoked_at || null,
    };
  } catch (err) {
    throw asSchemaError(err);
  }
}

// Resolve token → { dojo_id, federation_id } | null. Só links ativos
// (revoked_at IS NULL). Tabela ausente (42P01) → null: o caminho público
// responde 401 genérico, sem diferenciar "não existe" de "schema pendente".
async function resolveToken(token) {
  if (!token || typeof token !== 'string' || token.trim().length < 32) return null;
  const tokenHash = hashToken(token.trim());
  try {
    const { rows } = await db.query(
      `SELECT dojo_id, federation_id
         FROM karate_dojo_portal_links
        WHERE token_hash = $1 AND revoked_at IS NULL
        LIMIT 1`,
      [tokenHash]
    );
    return rows[0] || null;
  } catch (err) {
    if (err && err.code === '42P01') return null;
    throw err;
  }
}

module.exports = {
  hashToken,
  generateToken,
  createLink,
  revokeLink,
  getLinkStatus,
  resolveToken,
};
