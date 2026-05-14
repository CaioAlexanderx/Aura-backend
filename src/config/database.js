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

// ── Pool config ──────────────────────────────────────────────────────────
// Supabase usa PgBouncer em Transaction mode no endpoint :6543.
// Em Transaction mode cada query pega uma conexão do bouncer e devolve
// imediatamente — não faz sentido manter um pool grande aqui.
//
// max: 5  →  evita esgotar slots do PgBouncer (padrão Supabase: 15 direct).
// keepAlive: true  →  previne que conexões idle sejam derrubadas silenciosamente
//   pelo PgBouncer/firewall sem o pg perceber (causa ECONNRESET/EDBHANDLEREXITED).
// allowExitOnIdle: true  →  o processo Node sai limpo quando não há conexões ativas
//   (útil em deploys Railway para não travar o shutdown).
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  allowExitOnIdle: true,
});

pool.on('error', (err) => {
  // Conexões idle podem ser derrubadas pelo PgBouncer sem aviso (EDBHANDLEREXITED,
  // ECONNRESET). O pool remove a conexão morta automaticamente na próxima requisição.
  // Logamos mas NÃO derrubamos o processo — o Railway já monitora saúde do serviço.
  console.error('Erro inesperado no pool do banco:', err.message, err.code || '');
});

module.exports = pool;
