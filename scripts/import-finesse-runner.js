#!/usr/bin/env node
/**
 * AURA. - Import Finesse Runner
 * 
 * Pre-requisitos:
 *   1. Copiar import_vendas_finesse.sql para scripts/
 *   2. Ter DATABASE_URL ou SUPABASE_DB_URL configurado
 * 
 * Uso:
 *   cd aura-backend
 *   node scripts/import-finesse-runner.js
 * 
 * O que faz:
 *   1. Executa o SQL de importacao (6795 vendas)
 *   2. Atualiza total_sales/total_revenue das funcionarias cadastradas (Kaila, Paula, Amanda)
 *   3. Mery nao e mais funcionaria - vendas ficam com employee_name apenas
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const COMPANY_ID = 'ba768cfa-cce5-4a7b-bcc9-3279b305cb70';
const BATCH_UUID = 'c18f0267-3241-4a59-84cd-662a4e4cbf4f';

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
    // Check existing import (prevent duplicates)
    const existing = await client.query(
      'SELECT COUNT(*) AS n FROM transactions WHERE import_batch_id = $1',
      [BATCH_UUID]
    );
    if (parseInt(existing.rows[0].n) > 0) {
      console.log(`AVISO: Ja existem ${existing.rows[0].n} registros com batch ${BATCH_UUID}`);
      console.log('Para reimportar, rode primeiro:');
      console.log(`  DELETE FROM transactions WHERE import_batch_id = '${BATCH_UUID}';`);
      console.log(`  DELETE FROM import_logs WHERE batch_id = '${BATCH_UUID}';`);
      process.exit(1);
    }

    // Etapa 1: Importar vendas
    console.log('\n=== Etapa 1: Importar 6795 vendas ===');
    const sqlPath = path.join(__dirname, 'import_vendas_finesse.sql');
    if (!fs.existsSync(sqlPath)) {
      console.error(`Erro: Arquivo nao encontrado: ${sqlPath}`);
      console.error('Copie o arquivo import_vendas_finesse.sql para scripts/');
      process.exit(1);
    }
    
    const sql = fs.readFileSync(sqlPath, 'utf-8');
    const statements = sql
      .split(';\n')
      .map(s => s.trim())
      .filter(s => s.startsWith('INSERT INTO'));
    
    console.log(`Encontrados ${statements.length} INSERTs`);
    
    let totalInserted = 0;
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i] + ';';
      try {
        const res = await client.query(stmt);
        totalInserted += res.rowCount || 0;
        process.stdout.write(`\r  Lote ${i + 1}/${statements.length} - ${totalInserted} registros`);
      } catch (err) {
        console.error(`\nErro no lote ${i + 1}: ${err.message}`);
        console.error('Primeiros 200 chars:', stmt.substring(0, 200));
        throw err;
      }
    }
    console.log(`\n  Total inserido: ${totalInserted}`);

    // Etapa 2: Atualizar stats das funcionarias ativas (Kaila, Paula, Amanda)
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
    console.log('\nNota: Vendas da Mery ficam com employee_name apenas (sem employee_id)');
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
