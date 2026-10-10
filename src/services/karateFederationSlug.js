// ============================================================
// AURA KARATÊ — resolução do slug PÚBLICO da federação
//
// As rotas públicas (/karate/:slug/...) recebem slug ou UUID. O slug pode
// morar em dois lugares:
//   1) digital_channel_config.slug — canal digital configurado;
//   2) companies.slug (vertical karate_federation) — o slug que o
//      GET /federation/:id/identity devolve ao app.
// Antes só (1) era consultado: federação sem canal digital (ex.: JKA
// Teste, companies.slug='jka-teste') respondia 404 "Federação não
// encontrada" para o próprio slug que o app compartilha.
//
// resolveFederationId(slugOrId) → company_id | null
// ============================================================
'use strict';

const db = require('../config/database');

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

async function resolveFederationId(slugOrId) {
  const key = String(slugOrId || '');
  if (!key) return null;
  const r = await db.query(
    `SELECT company_id FROM digital_channel_config WHERE slug = $1 LIMIT 1`,
    [key]
  );
  if (r.rows.length) return r.rows[0].company_id;
  if (UUID_RE.test(key)) return key;
  // Fallback: slug da própria federação (companies.slug). 42703 = coluna
  // ausente neste ambiente → comportamento de antes (não encontrada).
  try {
    const c = await db.query(
      `SELECT id FROM companies WHERE slug = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [key]
    );
    return c.rows.length ? c.rows[0].id : null;
  } catch (e) {
    if (e.code === '42703') return null;
    throw e;
  }
}

module.exports = { resolveFederationId };
