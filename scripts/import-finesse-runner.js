#!/usr/bin/env node
/**
 * AURA. - Import Finesse Runner
 * 
 * Uso:
 *   cd aura-backend
 *   export SUPABASE_DB_URL="postgresql://postgres:SENHA@db.hawtujkztrjpvvkihowb.supabase.co:5432/postgres"
 *   node scripts/import-finesse-runner.js
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const COMPANY_ID = 'ba768cfa-cce5-4a7b-bcc9-3279b305cb70';
const BATCH_UUID = 'c18f0267-3241-4a59-84cd-662a4e4cbf4f';
const OLD_BATCH_STRING = 'import-historico-14abr-2026';

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('Erro: Defina SUPABASE_DB_URL ou DATABASE_URL');
  console.error('Exemplo: export SUPABASE_DB_URL="postgresql://postgres:SENHA@db.hawtujkztrjpvvkihowb.supabase.co:5432/postgres"');
  process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  
  try {
    // Check existing import
    const existing = await client.query(
      'SELECT COUNT(*) AS n FROM transactions WHERE import_batch_id = $1',
      [BATCH_UUID]
    );
    if (parseInt(existing.rows[0].n) > 0) {
      console.log(`AVISO: Ja existem ${existing.rows[0].n} registros com batch ${BATCH_UUID}`);
      console.log('Para reimportar, rode primeiro:');
      console.log(`  DELETE FROM transactions WHERE import_batch_id = '${BATCH_UUID}';`);
      process.exit(1);
    }

    // Etapa 1: Ler SQL — tenta varios nomes de arquivo
    console.log('\n=== Etapa 1: Importar vendas ===');
    const possibleNames = [
      'import_vendas_finesse_1.sql',
      'import_vendas_finesse.sql',
      'import_vendas_finesse_2.sql',
    ];
    
    let sqlPath = null;
    for (const name of possibleNames) {
      const candidate = path.join(__dirname, name);
      if (fs.existsSync(candidate)) {
        sqlPath = candidate;
        console.log(`  Arquivo encontrado: ${name}`);
        break;
      }
    }
    
    if (!sqlPath) {
      console.error('Erro: Nenhum arquivo SQL encontrado em scripts/');
      console.error('Procurei por:', possibleNames.join(', '));
      process.exit(1);
    }
    
    let sql = fs.readFileSync(sqlPath, 'utf-8');
    
    // Auto-fix: replace string batch ID with proper UUID
    if (sql.includes(OLD_BATCH_STRING)) {
      console.log(`  Auto-fix: substituindo '${OLD_BATCH_STRING}' por UUID '${BATCH_UUID}'`);
      sql = sql.replaceAll(`'${OLD_BATCH_STRING}'`, `'${BATCH_UUID}'`);
    }
    
    // Remove BEGIN/COMMIT
    sql = sql.replace(/^BEGIN;?\s*/im, '');
    sql = sql.replace(/\s*COMMIT;?\s*$/im, '');
    
    // Split into individual statements
    const statements = sql
      .split(/;\s*\n/)
      .map(s => s.trim())
      .filter(s => s.toUpperCase().startsWith('INSERT INTO'));
    
    console.log(`  Encontrados ${statements.length} INSERTs`);
    
    if (statements.length === 0) {
      console.error('Erro: Nenhum INSERT encontrado no arquivo SQL');
      console.error('Primeiros 500 chars do arquivo:');
      console.error(sql.substring(0, 500));
      process.exit(1);
    }
    
    let totalInserted = 0;
    let errors = 0;
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i].endsWith(';') ? statements[i] : statements[i] + ';';
      try {
        const res = await client.query(stmt);
        totalInserted += res.rowCount || 0;
        if ((i + 1) % 100 === 0 || i === statements.length - 1) {
          process.stdout.write(`\r  Progresso: ${i + 1}/${statements.length} — ${totalInserted} registros inseridos, ${errors} erros`);
        }
      } catch (err) {
        errors++;
        if (errors <= 3) {
          console.error(`\n  Erro no lote ${i + 1}: ${err.message}`);
          console.error('  SQL (200 chars):', stmt.substring(0, 200));
        }
        // Continue with next statement instead of aborting
      }
    }
    console.log(`\n  Total inserido: ${totalInserted} (${errors} erros)`);

    if (totalInserted === 0) {
      console.error('\nNenhum registro inserido. Verifique o formato do SQL.');
      process.exit(1);
    }

    // Etapa 2: Atualizar stats
    console.log('\n=== Etapa 2: Atualizar stats funcionarias ===');
    const empStats = await client.query(`
      UPDATE employees e SET
        total_sales = sub.cnt,
        total_revenue = sub.rev
      FROM (
        SELECT employee_id, COUNT(*) AS cnt, SUM(amount) AS rev
        FROM transactions
        WHERE company_id = $1 AND employee_id IS NOT NULL AND type = 'income'
        GROUP BY employee_id
      ) sub
      WHERE e.id = sub.employee_id AND e.company_id = $1
    `, [COMPANY_ID]);
    console.log(`  ${empStats.rowCount} funcionarias atualizadas`);

    // Verificacao
    console.log('\n=== Verificacao ===');
    const verify = await client.query(
      `SELECT employee_name, COUNT(*) AS vendas, ROUND(SUM(amount)::numeric, 2) AS faturamento
       FROM transactions WHERE import_batch_id = $1
       GROUP BY employee_name ORDER BY vendas DESC`,
      [BATCH_UUID]
    );
    verify.rows.forEach(r => {
      console.log(`  ${r.employee_name}: ${r.vendas} vendas, R$ ${r.faturamento}`);
    });

    const total = await client.query(
      'SELECT COUNT(*) AS n, ROUND(SUM(amount)::numeric, 2) AS total FROM transactions WHERE import_batch_id = $1',
      [BATCH_UUID]
    );
    console.log(`\nTOTAL: ${total.rows[0].n} vendas, R$ ${total.rows[0].total}`);
    console.log('Importacao concluida com sucesso!');

  } catch (err) {
    console.error('\nErro fatal:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
