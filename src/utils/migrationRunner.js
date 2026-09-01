// ============================================================
// AURA. — Runner de migrations
//
// Criado: 01/09/2026
//
// ── POR QUE ISTO EXISTE ────────────────────────────────────────────────
// Até hoje o repo NÃO tinha runner. Nada em package.json, nada no boot de
// src/index.js, nada em railway.toml aplicava os .sql — eles eram rodados à
// mão no Supabase. O preço apareceu no QA de 01/09/2026: as migrations 310 e
// 311 estavam no código e NÃO no banco de produção. Ninguém errou; só não
// havia nada que garantisse o contrário.
//
// ── COMO FUNCIONA ──────────────────────────────────────────────────────
// Tabela de controle `schema_migrations` (criada pelo próprio runner — ela
// não pode ser uma migration, seria circular). Uma linha por arquivo já
// aplicado, com checksum e duração.
//
// Cada migration roda na SUA transação: BEGIN → SQL → INSERT no controle →
// COMMIT. Se o SQL quebra, ROLLBACK e o runner LANÇA — nada de "aplicada
// pela metade", nada de continuar e deixar o banco num estado que ninguém
// consegue descrever. Uma migration que falha derruba o passo de deploy.
//
// Múltiplas instâncias subindo juntas: `pg_advisory_lock` numa chave fixa. A
// segunda instância BLOQUEIA até a primeira terminar e então encontra tudo
// aplicado — não é um "quem chegar primeiro", é uma fila.
//
// ── O PERIGO, E A TRAVA CONTRA ELE ─────────────────────────────────────
// As 300+ migrations existentes JÁ FORAM aplicadas no banco de produção, à
// mão, ao longo de meses. Se o primeiro deploy com runner encontrasse
// `schema_migrations` vazia, ele tentaria rodar TODAS de novo. A maioria é
// idempotente, mas "a maioria" não é uma garantia que se leve para produção.
//
// Por isso: se o controle está vazio E o banco JÁ TEM schema (existe a
// tabela `companies`), o runner RECUSA e manda rodar o baseline. Ele não
// adivinha, não roda "só as que parecem novas", não faz nada esperto — ele
// para e diz o que fazer. O baseline (`node scripts/migrate.js baseline`)
// registra tudo como aplicado SEM executar, e a partir daí só o que for
// novo roda.
//
// Banco vazio de verdade (CI, staging recriado): sem `companies`, o runner
// aplica tudo do zero, que é o comportamento certo ali.
//
// ── ORDEM ──────────────────────────────────────────────────────────────
// Migrations moram em DOIS diretórios (`migrations/` e `src/migrations/`,
// herança) e há prefixos numéricos REPETIDOS (309 aparece três vezes). A
// chave de controle é o caminho relativo inteiro (`migrations/309_x.sql`),
// então duplicata de prefixo não colide. A ordenação é (número, diretório,
// nome) — determinística, mas entre arquivos de MESMO número ela é
// arbitrária: migration nova deve usar prefixo novo em `migrations/`.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Chave do advisory lock. Constante fixa e arbitrária: só precisa não
// colidir com outro pg_advisory_lock do sistema (não há outro hoje).
const LOCK_KEY = 4823917;

// Diretórios com migrations, em ordem de precedência para desempate.
const DIRS = ['src/migrations', 'migrations'];

// Se esta tabela existe, o banco NÃO é novo — é o banco do produto.
const SENTINELA = 'companies';

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

/** Todos os .sql, ordenados. Cada item: { key, dir, file, fullPath }. */
function discover(root = repoRoot()) {
  const out = [];
  DIRS.forEach((dir, dirRank) => {
    const abs = path.join(root, dir);
    let files = [];
    try {
      files = fs.readdirSync(abs);
    } catch (_) {
      return; // diretório não existe neste checkout
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.sql')) continue;
      const m = /^(\d+)/.exec(file);
      out.push({
        key: `${dir}/${file}`,
        dir,
        dirRank,
        file,
        num: m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER,
        fullPath: path.join(abs, file),
      });
    }
  });
  out.sort((a, b) =>
    a.num - b.num || a.dirRank - b.dirRank || a.file.localeCompare(b.file)
  );
  return out;
}

function checksum(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function ensureControlTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      key         TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_ms  INTEGER,
      baseline    BOOLEAN NOT NULL DEFAULT false
    )
  `);
  await client.query(`
    COMMENT ON TABLE schema_migrations IS
      'Controle do runner (src/utils/migrationRunner.js). key = caminho relativo do .sql. baseline=true: registrada sem executar (as ~315 aplicadas a mao antes de 01/09/2026).'
  `).catch(() => {}); // COMMENT é cosmético; não vale derrubar o deploy
}

async function appliedKeys(client) {
  const { rows } = await client.query('SELECT key, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.key, r.checksum]));
}

async function bancoJaTemSchema(client) {
  const { rows } = await client.query('SELECT to_regclass($1) AS reg', [SENTINELA]);
  return rows[0] && rows[0].reg !== null;
}

/**
 * Roda tudo que falta, em ordem, cada uma na sua transação.
 *
 * @param {object} deps
 * @param {object} deps.pool     pool `pg` (ou qualquer coisa com .connect())
 * @param {string} [deps.root]   raiz do repo (para teste)
 * @param {function} [deps.log]
 * @returns {Promise<{applied:string[], skipped:number, total:number}>}
 */
async function runMigrations({ pool, root = repoRoot(), log = console.log }) {
  const client = await pool.connect();
  const result = { applied: [], skipped: 0, total: 0 };
  try {
    // statement_timeout do pool é 30s; uma migration grande passa disso.
    await client.query('SET statement_timeout TO 0').catch(() => {});
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    await ensureControlTable(client);
    const done = await appliedKeys(client);
    const all = discover(root);
    result.total = all.length;

    // A TRAVA: controle vazio + banco com schema = base que veio de antes do
    // runner. Rodar 300+ migrations nela é o desastre que este bloco evita.
    if (done.size === 0 && (await bancoJaTemSchema(client)) && all.length > 0) {
      throw new Error(
        'schema_migrations esta VAZIA mas o banco ja tem schema (tabela "' + SENTINELA + '" existe).\n' +
        'Este banco foi migrado a mao antes do runner existir. Rodar as ' + all.length +
        ' migrations de novo NAO e seguro.\n' +
        'Faca o BASELINE uma unica vez:  node scripts/migrate.js baseline\n' +
        'Ele registra as migrations atuais como aplicadas SEM executar nenhuma. Depois disso,\n' +
        'so o que for novo roda.'
      );
    }

    for (const mig of all) {
      const sql = fs.readFileSync(mig.fullPath, 'utf8');
      const sum = checksum(sql);

      if (done.has(mig.key)) {
        result.skipped++;
        if (done.get(mig.key) !== sum) {
          // Migration ja aplicada foi EDITADA. Não bloqueia o deploy (pode
          // ser um comentário), mas tem que gritar: o que rodou no banco não
          // é mais o que está no arquivo.
          log(`[migrate] AVISO: ${mig.key} mudou depois de aplicada (checksum diferente). O banco tem a versao ANTIGA.`);
        }
        continue;
      }

      const t0 = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (key, checksum, applied_ms, baseline)
           VALUES ($1, $2, $3, false)`,
          [mig.key, sum, Date.now() - t0]
        );
        await client.query('COMMIT');
        result.applied.push(mig.key);
        log(`[migrate] aplicada ${mig.key} (${Date.now() - t0}ms)`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // Falha RUIDOSA: nada de continuar para a próxima. Quem chamou
        // (scripts/migrate.js) sai com codigo != 0 e o deploy para.
        throw new Error(`migration ${mig.key} FALHOU: ${err.message}`);
      }
    }

    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/**
 * Marca TODAS as migrations existentes como aplicadas SEM executá-las.
 * É o passo único a rodar em produção antes do primeiro deploy com runner.
 * Idempotente: ON CONFLICT DO NOTHING — quem já está registrado fica.
 *
 * @returns {Promise<{marked:string[], already:number, total:number}>}
 */
async function baseline({ pool, root = repoRoot(), log = console.log }) {
  const client = await pool.connect();
  const result = { marked: [], already: 0, total: 0 };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureControlTable(client);
    const done = await appliedKeys(client);
    const all = discover(root);
    result.total = all.length;

    for (const mig of all) {
      if (done.has(mig.key)) { result.already++; continue; }
      const sum = checksum(fs.readFileSync(mig.fullPath, 'utf8'));
      await client.query(
        `INSERT INTO schema_migrations (key, checksum, applied_ms, baseline)
         VALUES ($1, $2, 0, true)
         ON CONFLICT (key) DO NOTHING`,
        [mig.key, sum]
      );
      result.marked.push(mig.key);
    }
    log(`[migrate] baseline: ${result.marked.length} registradas sem executar, ${result.already} ja estavam.`);
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** O que falta aplicar, sem tocar em nada. */
async function status({ pool, root = repoRoot() }) {
  const client = await pool.connect();
  try {
    await ensureControlTable(client);
    const done = await appliedKeys(client);
    const all = discover(root);
    return {
      total: all.length,
      applied: all.filter((m) => done.has(m.key)).map((m) => m.key),
      pending: all.filter((m) => !done.has(m.key)).map((m) => m.key),
    };
  } finally {
    client.release();
  }
}

module.exports = {
  LOCK_KEY,
  DIRS,
  SENTINELA,
  discover,
  checksum,
  runMigrations,
  baseline,
  status,
};
