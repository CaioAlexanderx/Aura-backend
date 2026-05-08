const { Pool, types } = require('pg');
const dns = require('dns');
const { validateRuntimeEnv } = require('./env');

dns.setDefaultResultOrder('ipv4first');

const env = validateRuntimeEnv();

const connectionString = env.SUPABASE_DB_URL.replace('?family=4', '');

// ── pg type parsers ─────────────────────────────────────────────────────
// Por padrao o driver pg retorna NUMERIC/DECIMAL (oid=1700) como string
// para preservar precisao arbitraria. No nosso schema todos os NUMERIC
// sao (12,2) — cabem com folga em double precision JS — e o frontend
// quebra (.toFixed is not a function) quando recebe string.
//
// Fix global: parsear NUMERIC como float aqui no entry-point do pool.
// INT8 (oid=20) NAO mexemos pra nao quebrar IDs grandes.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

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
