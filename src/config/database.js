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
// Supabase usa PgBouncer/Supavisor na frente do Postgres.
//
// max: 15  →  ANTES era 5, baixo demais para o app inteiro. Com max:5, um
//   punhado de requisicoes segurando uma conexao (ex.: parada esperando uma
//   chamada de rede externa — SEFAZ — antes de liberar o client) esgotava o
//   pool e TRAVAVA o app todo (incidente 23/06). 15 da folga ampla e segue
//   bem abaixo de max_connections=60 do Postgres.
// idleTimeoutMillis: 60000  →  conexao ociosa volta pro servidor depois de 60s.
//   ANTES era 30s; subido p/ dar margem ao keep-alive (abaixo) e evitar reciclar
//   conexao quente entre rajadas.
// connectionTimeoutMillis: 5000  →  se nao houver client livre em 5s, rejeita
//   (em vez de pendurar pra sempre).
// keepAlive: true  →  previne que conexões idle sejam derrubadas silenciosamente
//   pelo PgBouncer/firewall sem o pg perceber (causa ECONNRESET/EDBHANDLEREXITED).
// allowExitOnIdle: true  →  o processo Node sai limpo quando não há conexões ativas
//   (útil em deploys Railway para não travar o shutdown).
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 15,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  allowExitOnIdle: true,
});

// ── Timeouts de servidor por conexão ────────────────────────────────────
// Aplicados via SET no hook on('connect') — NAO como parametro de startup do
// pool, porque o Supavisor/PgBouncer pode rejeitar startup params desconhecidos
// e derrubar TODAS as conexões. Aqui o SET roda depois do connect e o erro é
// engolido (best-effort), então nunca quebra a conexão.
//   statement_timeout: mata uma query presa depois de 30s (libera o client).
//   idle_in_transaction_session_timeout: mata transação esquecida aberta.
//
// ⚠️ ISTO AQUI NÃO É A DEFESA — LEIA ANTES DE CONFIAR NELE (13/08/2026)
// Em 13/08/2026 uma transação do import de alunos ficou `idle in
// transaction` por OITO MINUTOS em produção, segurando conexão do pool e
// locks, até alguém rodar `pg_terminate_backend` na mão. Este SET estava
// aqui, com 30s, o tempo todo.
//
// A prova de que ele não estava valendo são os valores LIDOS do banco no
// dia: `idle_in_transaction_session_timeout = 0` e
// `statement_timeout = 2min`. Nenhum dos dois é o que esta linha pede.
// Explicação: com um pooler em modo TRANSACTION (Supavisor/PgBouncer, que
// é como este backend fala com o Postgres), `SET` de SESSÃO emitido FORA
// de uma transação vale no máximo para aquele ciclo — a próxima transação
// pode cair em outra conexão de servidor, com o default do banco. Um
// `SET` de sessão através de um pooler é uma promessa que o pooler não é
// obrigado a cumprir, e o `.catch()` que engole o erro faz o fracasso ser
// SILENCIOSO.
//
// AS DEFESAS QUE VALEM, em ordem:
//   1. migration 281 — `ALTER DATABASE ... SET
//      idle_in_transaction_session_timeout = '120s'`. Fica no catálogo do
//      Postgres, então TODA sessão nova nasce com ele: as conexões do
//      pooler, as de fora do pool (psql, jobs, MCP), todas. É a única que
//      não depende de ninguém lembrar de nada. O porquê do número está no
//      cabeçalho da migration.
//   2. `SET LOCAL` logo depois do BEGIN, na operação longa (hoje:
//      importStudents). `SET LOCAL` vive DENTRO da transação, que o
//      pooler é obrigado a manter na mesma conexão de servidor — é o
//      único SET que não pode ser descartado. Quem escrever uma nova
//      operação cara deve fazer o mesmo.
//   3. este hook, que continua aqui porque em conexão DIRETA (modo
//      session, sem pooler) ele funciona e não custa nada.
//
// O valor de idle_in_transaction subiu de 30s para 120s para casar com o
// da migration 281: dois limites diferentes para a mesma coisa, um deles
// invisível, é o tipo de divergência que se paga em plantão. Não é
// afrouxamento na prática — os 30s nunca chegaram a valer em produção.
// statement_timeout fica como está: não foi ele que falhou.
pool.on('connect', (client) => {
  client
    .query("SET statement_timeout TO 30000; SET idle_in_transaction_session_timeout TO 120000;")
    .catch((err) => console.warn('[db] nao foi possivel aplicar timeouts na conexao:', err.message));
});

pool.on('error', (err) => {
  // Conexões idle podem ser derrubadas pelo PgBouncer sem aviso (EDBHANDLEREXITED,
  // ECONNRESET). O pool remove a conexão morta automaticamente na próxima requisição.
  // Logamos mas NÃO derrubamos o processo — o Railway já monitora saúde do serviço.
  console.error('Erro inesperado no pool do banco:', err.message, err.code || '');
});

// ── Keep-alive: mantém >=1 conexão QUENTE ──────────────────────────────────
// O app roda no Railway (us-west) e o banco no Supabase (sa-east-1, São Paulo).
// Uma conexão QUENTE faz um SELECT em ~190ms (1 round-trip cross-region); uma
// conexão FRIA custa ~1.3s (TCP + TLS handshake + setup, tudo cruzando o
// continente). Sem tráfego por mais que o idleTimeout, a conexão é reciclada e o
// PRÓXIMO request do usuário paga o cold connect — a latência oscilava entre
// ~190ms (quente) e >1000ms (fria).
//
// Este ping leve a cada 25s (abaixo do idleTimeout de 60s) mantém pelo menos uma
// conexão recém-usada e quente no pool, então os requests reais quase sempre
// pegam uma conexão pronta. unref() para não impedir o shutdown do processo.
const KEEPALIVE_MS = 25000;
const keepAliveTimer = setInterval(() => {
  pool.query('SELECT 1').catch((err) =>
    console.warn('[db] keepalive ping falhou (nao-fatal):', err.message)
  );
}, KEEPALIVE_MS);
if (keepAliveTimer.unref) keepAliveTimer.unref();

// ── queryRetry: retry curto em erro TRANSITÓRIO de conexão ──────────────────
// O backend (Railway) e o banco (Supabase/São Paulo) cruzam regiões; um blip de
// rede pode cortar um socket em voo ("Connection terminated unexpectedly") ou
// estourar o connect ("Connection terminated due to connection timeout"). Sem
// retry esses erros chegavam crus no requireCompanyAccess (auth.js) e viravam
// 500 em TODO request — o app inteiro parecia fora do ar pela duração do blip.
// Na 2ª tentativa o pool descarta o socket morto e abre um novo.
//
// IMPORTANTE: usar SÓ em queries IDEMPOTENTES (SELECT, ou writes com ON CONFLICT
// / idempotency_key). NÃO usar dentro de transação (BEGIN/COMMIT usam
// client = pool.connect(), não este caminho) — repetir um passo de transação
// cegamente é inseguro.
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  '08000', '08001', '08003', '08004', '08006', '57P01', '57P03',
]);
function isTransientConnError(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  return /connection terminated|terminated unexpectedly|connection timeout|server closed the connection|connection error|read ECONNRESET/i
    .test(String(err.message || ''));
}
async function queryRetry(text, params, { attempts = 2, backoffMs = 200 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && isTransientConnError(err)) {
        console.warn(`[db] erro transitorio de conexao, retry ${i + 1}/${attempts - 1}:`, err.message);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

pool.queryRetry = queryRetry;
pool.isTransientConnError = isTransientConnError;

module.exports = pool;
