#!/usr/bin/env node
/**
 * AURA. - Import Finesse Runner v3
 * 
 * Executa o SQL inteiro de uma vez (suporta multi-row INSERT)
 * 
 * Uso:
 *   cd aura-backend
 *   export SUPABASE_DB_URL="postgresql://postgres.hawtujkztrjpvvkihowb:SENHA@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"
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
  console.error('Exemplo: export SUPABASE_DB_URL="postgresql://postgres.hawtujkztrjpvvkihowb:SENHA@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"');
  process.exit(1);
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 120000, // 2 min timeout for large imports
});

async function run() {
  const client = await pool.connect();
  
  try {
    // Check existing import
    const existing = await client.query(
      'SELECT COUNT(*) AS n FROM transactions WHERE import_batch_id = $1',
      [BATCH_UUID]
    );
    if (parseInt(existing.rows[0].n) > 0) {
      console.log('AVISO: Ja existem ' + existing.rows[0].n + ' registros com batch ' + BATCH_UUID);
      console.log('Para reimportar, rode:');
      console.log("  DELETE FROM transactions WHERE import_batch_id = '" + BATCH_UUID + "';");
      process.exit(1);
    }

    // Count before
    const before = await client.query(
      'SELECT COUNT(*) AS n FROM transactions WHERE company_id = $1',
      [COMPANY_ID]
    );
    console.log('Transacoes antes: ' + before.rows[0].n);

    // Find SQL file
    console.log('\n=== Etapa 1: Carregar SQL ===');
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
        console.log('Arquivo: ' + name);
        break;
      }
    }
    
    if (!sqlPath) {
      console.error('Erro: Nenhum arquivo SQL encontrado');
      process.exit(1);
    }
    
    let sql = fs.readFileSync(sqlPath, 'utf-8');
    console.log('Tamanho: ' + (sql.length / 1024).toFixed(0) + ' KB');
    
    // Auto-fix batch ID
    if (sql.includes(OLD_BATCH_STRING)) {
      console.log('Auto-fix: substituindo batch string por UUID');
      sql = sql.replaceAll("'" + OLD_BATCH_STRING + "'", "'" + BATCH_UUID + "'");
    }
    
    // Remove BEGIN/COMMIT wrappers
    sql = sql.replace(/^\s*BEGIN\s*;?\s*/i, '');
    sql = sql.replace(/\s*COMMIT\s*;?\s*$/i, '');
    sql = sql.trim();
    
    // Remove trailing semicolon if present (pg handles it)
    if (sql.endsWith(';')) {
      sql = sql.slice(0, -1).trim();
    }

    // Debug: show first and last 200 chars
    console.log('\nPrimeiros 200 chars:');
    console.log(sql.substring(0, 200));
    console.log('\nUltimos 200 chars:');
    console.log(sql.substring(sql.length - 200));
    
    // Count approximate VALUES rows
    const valuesCount = (sql.match(/\),\s*\(/g) || []).length + 1;
    console.log('\nVALUES aproximados: ' + valuesCount + ' linhas');

    // Execute entire SQL as one statement
    console.log('\n=== Etapa 2: Executando INSERT ===');
    console.log('Aguarde... (pode demorar 30-60 segundos)');
    
    const result = await client.query(sql);
    console.log('Rows inseridas: ' + (result.rowCount || 0));

    // Count after
    const after = await client.query(
      'SELECT COUNT(*) AS n FROM transactions WHERE company_id = $1',
      [COMPANY_ID]
    );
    const inserted = parseInt(after.rows[0].n) - parseInt(before.rows[0].n);
    console.log('Transacoes depois: ' + after.rows[0].n + ' (+ ' + inserted + ' novas)');

    // Update employee stats
    console.log('\n=== Etapa 3: Atualizar stats funcionarias ===');
    const empStats = await client.query(
      "UPDATE employees e SET total_sales = sub.cnt, total_revenue = sub.rev FROM (SELECT employee_id, COUNT(*) AS cnt, SUM(amount) AS rev FROM transactions WHERE company_id = $1 AND employee_id IS NOT NULL AND type = 'income' GROUP BY employee_id) sub WHERE e.id = sub.employee_id AND e.company_id = $1",
      [COMPANY_ID]
    );
    console.log(empStats.rowCount + ' funcionarias atualizadas');

    // Verification
    console.log('\n=== Verificacao ===');
    const verify = await client.query(
      "SELECT COALESCE(employee_name, '(sem nome)') AS vendedora, COUNT(*) AS vendas, ROUND(SUM(amount)::numeric, 2) AS faturamento FROM transactions WHERE company_id = $1 AND import_batch_id = $2 GROUP BY employee_name ORDER BY vendas DESC",
      [COMPANY_ID, BATCH_UUID]
    );
    
    if (verify.rows.length === 0) {
      // Maybe batch_id wasn't in the SQL — check all recent
      console.log('(batch_id nao encontrado, verificando total geral)');
      const verifyAll = await client.query(
        "SELECT COALESCE(employee_name, '(sem nome)') AS vendedora, COUNT(*) AS vendas, ROUND(SUM(amount)::numeric, 2) AS faturamento FROM transactions WHERE company_id = $1 AND type = 'income' GROUP BY employee_name ORDER BY vendas DESC",
        [COMPANY_ID]
      );
      verifyAll.rows.forEach(function(r) {
        console.log('  ' + r.vendedora + ': ' + r.vendas + ' vendas, R$ ' + r.faturamento);
      });
    } else {
      verify.rows.forEach(function(r) {
        console.log('  ' + r.vendedora + ': ' + r.vendas + ' vendas, R$ ' + r.faturamento);
      });
    }

    const total = await client.query(
      "SELECT COUNT(*) AS n, ROUND(SUM(amount)::numeric, 2) AS total FROM transactions WHERE company_id = $1 AND type = 'income'",
      [COMPANY_ID]
    );
    console.log('\nTOTAL GERAL: ' + total.rows[0].n + ' vendas, R$ ' + total.rows[0].total);
    console.log('Importacao concluida!');

  } catch (err) {
    console.error('\nErro:', err.message);
    if (err.message.includes('column')) {
      console.error('\nDica: O SQL pode referenciar colunas que nao existem na tabela.');
      console.error('Verifique as colunas do INSERT vs a tabela transactions.');
    }
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
