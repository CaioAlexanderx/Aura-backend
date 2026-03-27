const { Pool } = require('pg');
const dns = require('dns');
const { validateRuntimeEnv } = require('./env');

dns.setDefaultResultOrder('ipv4first');

const env = validateRuntimeEnv();

const connectionString = env.SUPABASE_DB_URL.replace('?family=4', '');

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Erro inesperado no pool do banco:', err.message);
});

module.exports = pool;
