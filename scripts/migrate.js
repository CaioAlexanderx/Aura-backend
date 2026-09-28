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

const CONN = process.env.MIGRATE_DB_URL || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

/**
 * A URL que o runner usa: a do pooler do Supabase em modo TRANSAÇÃO.
 *
 * Incidente de 28/09/2026: o app no ar ocupa até 15 conexões no pooler em
 * modo SESSÃO (porta 5432, pool_size 15). Com ele cheio, o runner recebia
 * "EMAXCONNSESSION max clients reached in session mode" e o deploy parava
 * — três deploys seguidos falharam. A porta 6543 do mesmo pooler é o modo
 * transação: o cliente espera na fila em vez de ser recusado, e o runner
 * (src/utils/migrationRunner.js) só usa estado de transação.
 *
 * MIGRATE_DB_URL, se definida, vale como está (sem troca de porta).
 */
function urlDoRunner(url, { explicita = false } = {}) {
  const limpa = String(url).replace('?family=4', '');
  if (explicita) return limpa;
  try {
    const u = new URL(limpa);
    if (/\.pooler\.supabase\.com$/i.test(u.hostname) && (u.port === '5432' || u.port === '')) {
      u.port = '6543';
      return u.toString();
    }
  } catch (_) { /* URL fora do padrão: usa como veio */ }
  return limpa;
}

const TENTATIVAS_DE_CONEXAO = 6;
const ESPERA_ENTRE_TENTATIVAS_MS = 10000;

/** Conecta com algumas tentativas: o pooler pode estar momentaneamente cheio. */
async function conectarComTentativas(pool, { tentativas = TENTATIVAS_DE_CONEXAO, esperaMs = ESPERA_ENTRE_TENTATIVAS_MS, log = console.log } = {}) {
  let ultimo;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const c = await pool.connect();
      c.release();
      return;
    } catch (err) {
      ultimo = err;
      log(`[migrate] conexao ${i}/${tentativas} falhou: ${err.message}`);
      if (i < tentativas) await new Promise((r) => setTimeout(r, esperaMs));
    }
  }
  throw ultimo;
}

async function main() {
  const cmd = (process.argv[2] || 'up').toLowerCase();

  if (!CONN) {
    console.error('[migrate] SUPABASE_DB_URL (ou DATABASE_URL) nao definida.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: urlDoRunner(CONN, { explicita: !!process.env.MIGRATE_DB_URL }),
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 15000,
  });

  try {
    await conectarComTentativas(pool);
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

if (require.main === module) main().catch((err) => {
  console.error('\n[migrate] FALHOU:\n' + err.message + '\n');
  process.exit(1);
});

module.exports = { urlDoRunner, conectarComTentativas };
