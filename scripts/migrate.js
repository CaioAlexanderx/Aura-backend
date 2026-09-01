#!/usr/bin/env node
// ============================================================
// AURA. — CLI do runner de migrations
//
// Criado: 01/09/2026
//
//   node scripts/migrate.js up        aplica o que falta (padrão)
//   node scripts/migrate.js status    lista aplicadas x pendentes
//   node scripts/migrate.js baseline  registra as atuais SEM executar
//
// Este é o passo de deploy (railway.toml → preDeployCommand). Sai com
// código != 0 quando algo falha, o que FAZ O DEPLOY PARAR — que é o ponto:
// subir código que depende de uma coluna que não existe no banco foi
// exatamente o problema de 310/311.
//
// PRODUÇÃO, PASSO ÚNICO ANTES DO PRIMEIRO DEPLOY COM RUNNER:
//   SUPABASE_DB_URL=... node scripts/migrate.js baseline
// As ~315 migrations já aplicadas à mão passam a constar como aplicadas e
// nenhuma delas roda de novo. Sem esse passo o `up` RECUSA e explica.
//
// Usa um Pool próprio (não src/config/database) de propósito: aquele valida
// o env do app inteiro (JWT_SECRET, ALLOWED_ORIGINS) e liga keep-alive; um
// passo de deploy que só fala com o banco não deve depender disso.
// ============================================================
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const runner = require('../src/utils/migrationRunner');

const CONN = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

async function main() {
  const cmd = (process.argv[2] || 'up').toLowerCase();

  if (!CONN) {
    console.error('[migrate] SUPABASE_DB_URL (ou DATABASE_URL) nao definida.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: CONN.replace('?family=4', ''),
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  try {
    if (cmd === 'status') {
      const s = await runner.status({ pool });
      console.log(`[migrate] ${s.applied.length}/${s.total} aplicadas.`);
      if (s.pending.length) {
        console.log('[migrate] pendentes:');
        s.pending.forEach((k) => console.log('  - ' + k));
      } else {
        console.log('[migrate] nada pendente.');
      }
      return;
    }

    if (cmd === 'baseline') {
      await runner.baseline({ pool });
      return;
    }

    if (cmd !== 'up') {
      console.error(`[migrate] comando desconhecido: ${cmd} (use up | status | baseline)`);
      process.exit(1);
    }

    const r = await runner.runMigrations({ pool });
    console.log(`[migrate] ok — ${r.applied.length} aplicada(s), ${r.skipped} ja estavam, ${r.total} no total.`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('\n[migrate] FALHOU:\n' + err.message + '\n');
  process.exit(1);
});
