// ============================================================
// AURA KARATÊ — Serviço do Portal do Dojô (Canal B / link fixo)
//
// Credencial de acesso do dojô SEM Aura: um LINK FIXO não-expirável que a
// federação envia ao sensei (WhatsApp/e-mail). Quem tem o link entra — até a
// federação revogar. Escopo restrito (consulta + pagar anuidade) é imposto
// pelas ROTAS dojô-facing, não aqui.
//
// SEGURANÇA: o token só existe em claro no instante da emissão/rotação (é
// devolvido UMA vez para a federação copiar no link). Persistimos apenas o
// hash sha256 + um prefixo curto p/ exibição mascarada — mesmo padrão do
// sync_token de karate_dojo_connections.
// ============================================================
'use strict';

const db = require('../config/database');
const { generateSyncToken, hashToken, maskToken } = require('./karateSyncService');

// ── Emite (ou rotaciona) a credencial de um dojô ────────────
// UPSERT por dojo_id: se já existir credencial, rotaciona (novo hash) e
// reativa. Devolve o token em CLARO (uma única vez) + o prefixo mascarado.
async function issuePortalToken(federationId, dojoId, issuedBy) {
  const { token, hash, prefix } = generateSyncToken();
  const { rows } = await db.query(
    `INSERT INTO karate_dojo_portal_access
       (federation_id, dojo_id, token_hash, token_prefix, status, issued_by, rotated_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $5, NOW(), NOW(), NOW())
     ON CONFLICT (dojo_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash,
           token_prefix = EXCLUDED.token_prefix,
           status = 'active',
           issued_by = EXCLUDED.issued_by,
           rotated_at = NOW(),
           updated_at = NOW()
     RETURNING id, token_prefix, status, rotated_at`,
    [federationId, dojoId, hash, prefix, issuedBy || null]
  );
  return { token, masked: maskToken(prefix), access: rows[0] };
}

// ── Revoga a credencial de um dojô (mata o link atual) ──────
async function revokePortalToken(federationId, dojoId) {
  const { rowCount } = await db.query(
    `UPDATE karate_dojo_portal_access
       SET status = 'revoked', token_hash = NULL, updated_at = NOW()
     WHERE dojo_id = $1 AND federation_id = $2 AND status = 'active'`,
    [dojoId, federationId]
  );
  return rowCount > 0;
}

// ── Status da credencial (p/ a federação ver, sem expor o token) ──
async function getPortalAccess(federationId, dojoId) {
  const { rows } = await db.query(
    `SELECT id, status, token_prefix, rotated_at, last_access_at, created_at
       FROM karate_dojo_portal_access
      WHERE dojo_id = $1 AND federation_id = $2
      LIMIT 1`,
    [dojoId, federationId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    status: r.status,
    token_masked: r.status === 'active' ? maskToken(r.token_prefix) : null,
    rotated_at: r.rotated_at || null,
    last_access_at: r.last_access_at || null,
    created_at: r.created_at,
  };
}

// ── Resolve o token apresentado → contexto do dojô (Guard B) ──
// Devolve { dojo_id, federation_id } se o token casar uma credencial ativa;
// null caso contrário. Atualiza last_access_at (best-effort, não bloqueia).
async function resolveDojoByToken(presentedToken) {
  if (!presentedToken || typeof presentedToken !== 'string') return null;
  const hash = hashToken(presentedToken);
  const { rows } = await db.query(
    `SELECT id, dojo_id, federation_id
       FROM karate_dojo_portal_access
      WHERE token_hash = $1 AND status = 'active'
      LIMIT 1`,
    [hash]
  );
  if (!rows.length) return null;
  const r = rows[0];
  // best-effort: marca o último acesso sem bloquear o request
  db.query(
    `UPDATE karate_dojo_portal_access SET last_access_at = NOW() WHERE id = $1`,
    [r.id]
  ).catch(() => {});
  return { dojo_id: r.dojo_id, federation_id: r.federation_id };
}

module.exports = {
  issuePortalToken,
  revokePortalToken,
  getPortalAccess,
  resolveDojoByToken,
};
