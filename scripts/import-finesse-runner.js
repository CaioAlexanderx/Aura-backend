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
 *   1. Cadastra Mery como funcionaria (se nao existir)
 *   2. Executa o SQL de importacao (6795 vendas)
 *   3. Vincula employee_id da Mery nos lancamentos dela
 *   4. Atualiza total_sales/total_revenue de todos os employees
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const COMPANY_ID = 'ba768cfa-cce5-4a7b-bcc9-3279b305cb70';
const USER_ID = '48b6ae04-f83b-4840-a7ad-298a2ae89e56';
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
    // Step 1: Check existing import
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

    // Step 2: Register Mery as employee
    console.log('\n=== Etapa 1: Cadastrar Mery ===');
    const meryCheck = await client.query(
      'SELECT id FROM employees WHERE company_id = $1 AND name ILIKE $2',
      [COMPANY_ID, '%mery%']
    );
    
    let meryId;
    if (meryCheck.rows.length > 0) {
      meryId = meryCheck.rows[0].id;
      console.log(`Mery ja cadastrada: ${meryId}`);
    } else {
      const insert = await client.query(
        `INSERT INTO employees (company_id, name, role, role_title, cpf, admission_date, base_salary, salary, status)
         VALUES ($1, 'Mery', 'vendedora', 'Vendedora', '00000000000', '2025-03-01', 0, 0, 'active')
         RETURNING id`,
        [COMPANY_ID]
      );
      meryId = insert.rows[0].id;
      console.log(`Mery cadastrada: ${meryId}`);
    }

    // Step 3: Run the SQL import
    console.log('\n=== Etapa 2: Importar vendas ===');
    const sqlPath = path.join(__dirname, 'import_vendas_finesse.sql');
    if (!fs.existsSync(sqlPath)) {
      console.error(`Erro: Arquivo nao encontrado: ${sqlPath}`);
      console.error('Copie o arquivo import_vendas_finesse.sql para scripts/');
      process.exit(1);
    }
    
    const sql = fs.readFileSync(sqlPath, 'utf-8');
    
    // Extract individual INSERT statements and run them
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

    // Step 4: Link Mery's employee_id
    console.log('\n=== Etapa 3: Vincular Mery ===');
    const updateMery = await client.query(
      `UPDATE transactions 
       SET employee_id = $1 
       WHERE import_batch_id = $2 AND employee_name = 'Mery' AND employee_id IS NULL`,
      [meryId, BATCH_UUID]
    );
    console.log(`  ${updateMery.rowCount} lancamentos da Mery vinculados`);

    // Step 5: Update employee stats
    console.log('\n=== Etapa 4: Atualizar stats ===');
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
    console.log(`  ${empStats.rowCount} funcionarios atualizados`);

    // Verification
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
    console.log('\nImportacao concluida com sucesso!');

  } catch (err) {
    console.error('\nErro fatal:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
