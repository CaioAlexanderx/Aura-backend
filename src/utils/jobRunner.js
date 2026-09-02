// ============================================================
// AURA. — Runner de jobs de uma vez so
//
// Criado: 02/09/2026 (miniaturas do acervo de fotos)
//
// ── O QUE E ────────────────────────────────────────────────────────────
// Um job e um script em `jobs/NNN_nome.js` que exporta `run({ pool, log })`
// e devolve `{ concluido: boolean, ... }`. Roda em segundo plano, DEPOIS
// que o servidor subiu (src/server.js), e quando devolve concluido=true
// entra em `jobs_run` (migration 317) e nunca mais roda.
//
// ── POR QUE NAO E UMA MIGRATION ────────────────────────────────────────
// O runner de migrations roda no preDeployCommand e BLOQUEIA o deploy —
// certo pra um ALTER TABLE, errado pra baixar, redimensionar e subir de
// volta centenas de fotos do R2. Um job pode levar minutos, pode falhar
// numa foto e seguir nas outras, e pode terminar na proxima subida.
//
// ── REGRAS ─────────────────────────────────────────────────────────────
// - `pg_try_advisory_lock`: duas instancias subindo juntas nao rodam o
//   mesmo job em paralelo; a segunda simplesmente desiste (a primeira
//   termina, e na proxima subida nada esta pendente).
// - Sem `jobs_run` (migration 317 ainda nao aplicada), o runner sai em
//   silencio: o boot do app nunca depende dele.
// - Erro num job e logado e o proximo job roda; nada aqui derruba o
//   servidor. `concluido=false` deixa o job pendente pra proxima subida.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const LOCK_KEY = 4823918; // diferente do runner de migrations (4823917)
const DIR_PADRAO = path.join(__dirname, '..', '..', 'jobs');

function listarJobs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d+_.+\.js$/.test(f))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * Roda os jobs pendentes, em ordem.
 * @returns {Promise<{pulado?:string, rodados:Array<{key:string, resultado:any}>}>}
 */
async function rodarJobs({ pool, dir, log } = {}) {
  dir = dir || DIR_PADRAO;
  log = log || ((m) => console.log('[jobs] ' + m));
  const rodados = [];
  const arquivos = listarJobs(dir);
  if (!arquivos.length) return { rodados };

  const client = await pool.connect();
  try {
    const { rows: lock } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!lock[0] || !lock[0].ok) {
      log('outra instancia esta rodando os jobs; esta desiste');
      return { pulado: 'lock', rodados };
    }
    try {
      let feitos;
      try {
        feitos = (await client.query('SELECT key FROM jobs_run')).rows.map((r) => r.key);
      } catch (e) {
        if (e.code === '42P01') { log('jobs_run nao existe ainda (migration 317); nada a fazer'); return { pulado: 'sem_tabela', rodados }; }
        throw e;
      }
      for (const arquivo of arquivos) {
        if (feitos.includes(arquivo)) continue;
        log(`job ${arquivo}: comecando`);
        const inicio = Date.now();
        let resultado;
        try {
          const job = require(path.join(dir, arquivo));
          resultado = await job.run({ pool, log: (m) => log(`job ${arquivo}: ${m}`) });
        } catch (e) {
          resultado = { concluido: false, erro: e.message };
          log(`job ${arquivo}: FALHOU — ${e.message}`);
        }
        const segundos = Math.round((Date.now() - inicio) / 1000);
        if (resultado && resultado.concluido) {
          await client.query(
            'INSERT INTO jobs_run (key, resumo) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
            [arquivo, JSON.stringify({ ...resultado, segundos })],
          );
          log(`job ${arquivo}: concluido em ${segundos}s ${JSON.stringify(resultado)}`);
        } else {
          log(`job ${arquivo}: fica pendente pra proxima subida (${segundos}s) ${JSON.stringify(resultado)}`);
        }
        rodados.push({ key: arquivo, resultado });
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
  return { rodados };
}

/**
 * Agenda a rodada pra depois do boot. Nunca lanca: o servidor ja esta
 * no ar e um job quebrado e problema do log, nao do app.
 */
function agendarJobs({ pool, atrasoMs, log } = {}) {
  const atraso = atrasoMs == null ? 20000 : atrasoMs;
  const t = setTimeout(() => {
    rodarJobs({ pool, log }).catch((e) => console.error('[jobs] rodada falhou:', e.message));
  }, atraso);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

module.exports = { rodarJobs, agendarJobs, listarJobs, LOCK_KEY };
