#!/usr/bin/env node
// ============================================================
// AURA. — Backfill S1.1: cifra csc_token (em claro) → csc_token_enc
// e NULLa a coluna em claro. Idempotente: pula linhas já cifradas
// ou sem token. Roda DEPOIS da migration 234.
//
// Uso:
//   CERT_MASTER_KEY=<64 hex> SUPABASE_DB_URL=postgres://... \
//     node scripts/encrypt-nfce-secrets.js [--dry-run]
//
// NUNCA loga o token (nem em claro, nem cifrado).
// ============================================================
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { hasMasterKey, encryptString, isEncrypted } = require('../src/utils/secretCrypto');

const DRY = process.argv.includes('--dry-run');

async function main() {
  if (!hasMasterKey()) {
    console.error('CERT_MASTER_KEY ausente/inválida (64 hex). Abortando.');
    process.exit(1);
  }
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('SUPABASE_DB_URL não definida. Abortando.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: dbUrl, max: 1 });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, company_id, csc_token, csc_token_enc
         FROM nfce_config
        WHERE csc_token IS NOT NULL AND csc_token <> ''`
    );
    console.log(`nfce_config com csc_token em claro: ${rows.length}`);
    let done = 0, skipped = 0;
    for (const row of rows) {
      if (row.csc_token_enc && isEncrypted(row.csc_token_enc)) {
        // Já cifrado; só limpa o claro.
        if (!DRY) {
          await client.query(
            `UPDATE nfce_config SET csc_token = NULL, updated_at = NOW() WHERE id = $1`,
            [row.id]
          );
        }
        skipped++;
        continue;
      }
      const envelope = encryptString(row.csc_token);
      if (!DRY) {
        await client.query(
          `UPDATE nfce_config
              SET csc_token_enc = $1, csc_token = NULL, updated_at = NOW()
            WHERE id = $2`,
          [envelope, row.id]
        );
      }
      done++;
      console.log(`  company ${row.company_id}: cifrado${DRY ? ' (dry-run)' : ''}`);
    }
    console.log(`Concluído. Cifrados: ${done} · já cifrados (claro limpo): ${skipped}${DRY ? ' — DRY RUN, nada gravado' : ''}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('encrypt-nfce-secrets falhou:', err.message);
  process.exit(1);
});
