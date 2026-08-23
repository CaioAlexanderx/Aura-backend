// ============================================================
// AURA KARATÊ — P2.1: serviço do TOKEN DE MESA do mesário
//
// A dor real do Paulista 2026: mesários operam SEM conta Aura, trocam de
// koto ao longo do dia (lanche/pausa) e a federação precisa de controle
// total. O token de mesa dá acesso "fora do shell": um link opaco por
// CONVOCAÇÃO (linha de karate_competition_officials), escopado sempre ao
// area_id ATUAL da convocação — mover o mesário de koto move o acesso
// junto, sem reemitir link.
//
// Token: crypto.randomBytes(32).toString('hex') (64 chars). No banco vai
// APENAS o hash SHA-256(segredo + token) — mesmo espírito do link fixo do
// portal do dojô (karateDojoPortalLinkService, migration 239). O token em
// claro é devolvido UMA única vez na emissão.
//
// Segredo: KARATE_MESA_TOKEN_SECRET (fallback JWT_SECRET). ⚠️ Trocar o
// segredo invalida TODOS os tokens de mesa (kill switch global); a
// revogação individual é mesa_token_revoked_at.
//
// Defensivo a schema pendente (CLAUDE.md): 42703/42P01 → SCHEMA_PENDING
// nas operações administrativas; resolveToken devolve null (o caminho
// público responde 401 genérico, sem vazar estado do schema).
// ============================================================
'use strict';

const crypto = require('crypto');
const db = require('../config/database');

const TOKEN_SECRET =
  process.env.KARATE_MESA_TOKEN_SECRET || process.env.JWT_SECRET || '';

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
  if (err && (err.code === '42P01' || err.code === '42703')) {
    const e = new Error(
      'Token de mesa ainda não disponível — migration 302 (mesa_token em karate_competition_officials) pendente.'
    );
    e.code = 'SCHEMA_PENDING';
    e.status = 503;
    return e;
  }
  return err;
}

// Emite (rotacionando) o token de mesa de UMA convocação. Escopo triplo:
// a linha precisa pertencer à competição E a competição à federação —
// nada de emitir token para convocação alheia. Devolve o token em claro
// UMA única vez; null se a convocação não existe no escopo.
async function issueToken({ federationId, competitionId, rowId }) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  try {
    const { rows } = await db.query(
      `-- mesa:issue
       UPDATE karate_competition_officials co
          SET mesa_token_hash = $1,
              mesa_token_created_at = NOW(),
              mesa_token_revoked_at = NULL
         FROM karate_competitions c, karate_officials o
        WHERE co.id = $2
          AND c.id = co.competition_id AND c.id = $3
          AND c.federation_id = $4
          AND o.id = co.official_id
        RETURNING co.id, co.mesa_token_created_at AS created_at, o.name AS official_name`,
      [tokenHash, rowId, competitionId, federationId]
    );
    if (!rows.length) return null;
    return {
      token,
      id: rows[0].id,
      created_at: rows[0].created_at,
      official_name: rows[0].official_name,
    };
  } catch (err) {
    throw asSchemaError(err);
  }
}

// Revoga o token ativo da convocação. true = revogou; false = não havia.
async function revokeToken({ federationId, competitionId, rowId }) {
  try {
    const { rows } = await db.query(
      `-- mesa:revoke
       UPDATE karate_competition_officials co
          SET mesa_token_revoked_at = NOW()
         FROM karate_competitions c
        WHERE co.id = $1
          AND c.id = co.competition_id AND c.id = $2
          AND c.federation_id = $3
          AND co.mesa_token_hash IS NOT NULL
          AND co.mesa_token_revoked_at IS NULL
        RETURNING co.id`,
      [rowId, competitionId, federationId]
    );
    return rows.length > 0;
  } catch (err) {
    throw asSchemaError(err);
  }
}

// Resolve token → contexto COMPLETO da mesa | null. O area_id vem SEMPRE
// da linha atual (não do momento da emissão): trocar o mesário de koto
// atualiza o escopo no request seguinte. Tabela/coluna ausente → null
// (caminho público responde 401 genérico).
async function resolveToken(token) {
  if (!token || typeof token !== 'string' || token.trim().length < 32) return null;
  const tokenHash = hashToken(token.trim());
  try {
    const { rows } = await db.query(
      `-- mesa:resolve
       SELECT co.id            AS competition_official_id,
              co.area_id, co.status, co.is_chief,
              o.id             AS official_id,
              o.name           AS official_name,
              o.role           AS official_role,
              a.name           AS area_name,
              a.sort_order     AS area_sort_order,
              c.id             AS competition_id,
              c.name           AS competition_name,
              c.status         AS competition_status,
              c.event_date, c.location,
              c.federation_id
         FROM karate_competition_officials co
         JOIN karate_officials o    ON o.id = co.official_id
         JOIN karate_competitions c ON c.id = co.competition_id
         LEFT JOIN karate_competition_areas a ON a.id = co.area_id
        WHERE co.mesa_token_hash = $1
          AND co.mesa_token_revoked_at IS NULL
        LIMIT 1`,
      [tokenHash]
    );
    return rows[0] || null;
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703')) return null;
    throw err;
  }
}

// Status do token da convocação — NUNCA devolve token nem hash.
// (para a escala da federação mostrar "link ativo desde ...")
async function getTokenStatus({ federationId, competitionId, rowId }) {
  try {
    const { rows } = await db.query(
      `-- mesa:status
       SELECT co.mesa_token_created_at AS created_at,
              co.mesa_token_revoked_at AS revoked_at,
              (co.mesa_token_hash IS NOT NULL AND co.mesa_token_revoked_at IS NULL) AS active
         FROM karate_competition_officials co
         JOIN karate_competitions c ON c.id = co.competition_id
        WHERE co.id = $1 AND c.id = $2 AND c.federation_id = $3
        LIMIT 1`,
      [rowId, competitionId, federationId]
    );
    if (!rows.length) return null;
    return {
      active: !!rows[0].active,
      created_at: rows[0].created_at || null,
      revoked_at: rows[0].revoked_at || null,
    };
  } catch (err) {
    throw asSchemaError(err);
  }
}

module.exports = {
  hashToken,
  generateToken,
  issueToken,
  revokeToken,
  resolveToken,
  getTokenStatus,
};
