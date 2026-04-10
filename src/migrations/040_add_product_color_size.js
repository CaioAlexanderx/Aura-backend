// 040_add_product_color_size.js
// Adiciona colunas color (hex) e size (tamanho) a tabela de produtos
const db = require('../config/database');

async function up() {
  await db.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS color VARCHAR(7) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS size  VARCHAR(100) DEFAULT NULL;
  `);
  console.log('[migration 040] color e size adicionados a products');
}

async function down() {
  await db.query(`
    ALTER TABLE products
      DROP COLUMN IF EXISTS color,
      DROP COLUMN IF EXISTS size;
  `);
  console.log('[migration 040] rollback: color e size removidos de products');
}

module.exports = { up, down };
