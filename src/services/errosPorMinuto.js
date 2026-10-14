// ============================================================
// AURA. — Erro na ponta do lojista, por minuto (card t1-02, 14/10/2026)
//
// O /health e o bipe sintético dizem "o Caixa está de pé"; não dizem quantas
// lojistas receberam 500 ou "EMAXCONNSESSION max clients reached" nos últimos
// minutos. Este contador agrega, POR INSTÂNCIA E EM MEMÓRIA:
//
//   requisicoes      respostas enviadas (sem OPTIONS nem /health)
//   erros_5xx        respostas com status >= 500
//   emaxconnsession  erros do pooler (EMAXCONNSESSION / max clients reached)
//                    vistos numa consulta ou conexão do pool
//
// Nada escreve no banco por requisição: o caminho quente só incrementa três
// inteiros num Map. Uma vez por minuto o flush grava os minutos já FECHADOS
// em erros_por_minuto (migration 381, uma linha por minuto e instância) e,
// no máximo uma vez por hora, apaga o que passou de 7 dias.
//
// O painel (bloco Plataforma) lê os últimos 60 minutos com resumo(). Sem a
// tabela (migration pendente) tudo fica dormente e sem erro: o flush descarta
// os minutos e tenta de novo em 10 min; resumo() devolve null.
//
// Kill switch sem deploy: ERROS_POR_MINUTO=off.
// ============================================================
'use strict';

const os = require('os');

const MINUTO_MS = 60 * 1000;
const JANELA_MIN = 60;
const RETENCAO_DIAS = 7;
const LIMPEZA_A_CADA_MS = 60 * 60 * 1000;
const TABELA_AUSENTE_ESPERA_MS = 10 * MINUTO_MS;
// Minuto que falhou ao gravar é guardado para nova tentativa, até aqui.
const REPETIR_ATE_MS = 30 * MINUTO_MS;
const TZ_OFFSET_MS = 3 * 3600000; // Brasília, sem horário de verão

const INSTANCIA = String(
  process.env.RAILWAY_REPLICA_ID || process.env.RAILWAY_DEPLOYMENT_ID || `${os.hostname()}:${process.pid}`
).slice(0, 80);

const desligado = () => String(process.env.ERROS_POR_MINUTO || '').trim().toLowerCase() === 'off';

// ── contadores em memória ───────────────────────────────────────
// minuto (ms, início do minuto UTC) → { requisicoes, erros_5xx, emaxconnsession }
const minutos = new Map();

const inicioDoMinuto = (ms) => ms - (ms % MINUTO_MS);

function contadorDe(ms) {
  const chave = inicioDoMinuto(ms);
  let c = minutos.get(chave);
  if (!c) {
    c = { requisicoes: 0, erros_5xx: 0, emaxconnsession: 0 };
    minutos.set(chave, c);
  }
  return c;
}

// Uma resposta foi enviada. Caminho quente: só inteiros, sem I/O.
function registrarResposta(status, agora = Date.now()) {
  if (desligado()) return;
  const c = contadorDe(agora);
  c.requisicoes += 1;
  if (status >= 500) c.erros_5xx += 1;
}

function ehEmaxconn(err) {
  if (!err) return false;
  if (err.code === 'EMAXCONNSESSION') return true;
  return /EMAXCONNSESSION|max clients reached/i.test(String(err.message || ''));
}

// Erro de uma consulta/conexão do pool. Só conta o do pooler.
function registrarErro(err, agora = Date.now()) {
  if (desligado() || !ehEmaxconn(err)) return;
  contadorDe(agora).emaxconnsession += 1;
}

// ── observador do pool ──────────────────────────────────────────
// Quem engole o erro (requireCompanyAccess responde 500 e só dá console.error)
// nunca o repassa a um middleware: o único ponto que enxerga todos é o pool.
// pool.query/pool.connect em modo promessa passam a observar a rejeição e
// devolvem a MESMA rejeição ao chamador. Sem callback, nada muda; não há I/O.
const OBSERVADO = Symbol.for('aura.errosPorMinuto.observado');

function observarPool(pool) {
  if (!pool || pool[OBSERVADO]) return false;
  for (const nome of ['query', 'connect']) {
    const original = pool[nome];
    if (typeof original !== 'function') continue;
    pool[nome] = function observado(...args) {
      const r = original.apply(this, args);
      // Modo callback (ou retorno sem then): não mexe.
      if (!r || typeof r.then !== 'function') return r;
      return r.then(undefined, (err) => {
        registrarErro(err);
        throw err;
      });
    };
  }
  pool[OBSERVADO] = true;
  return true;
}

// ── flush ───────────────────────────────────────────────────────
let tabelaAusenteAte = 0;
let limpouEm = 0;
let avisou = new Set();

function avisarUmaVez(msg) {
  if (avisou.has(msg)) return;
  avisou.add(msg);
  console.warn('[erros-por-minuto]', msg);
}

// Grava os minutos fechados (anteriores ao minuto corrente). Nunca lança.
async function flush({ db, agora = Date.now() } = {}) {
  const banco = db || require('../config/database');
  const corte = inicioDoMinuto(agora);
  const fechados = [...minutos.entries()].filter(([ms]) => ms < corte);
  if (!fechados.length) return { gravados: 0 };
  for (const [ms] of fechados) minutos.delete(ms);

  // Tabela ausente: descarta (a memória não pode crescer) e espera para tentar.
  if (agora < tabelaAusenteAte) return { gravados: 0, dormente: true };

  const linhas = fechados.map(([ms, c]) => ({
    minuto: new Date(ms).toISOString(),
    requisicoes: c.requisicoes,
    erros_5xx: c.erros_5xx,
    emaxconnsession: c.emaxconnsession,
  }));

  try {
    await banco.query(
      `INSERT INTO erros_por_minuto (minuto, instancia, requisicoes, erros_5xx, emaxconnsession)
       SELECT x.minuto, $2::text, x.requisicoes, x.erros_5xx, x.emaxconnsession
         FROM jsonb_to_recordset($1::jsonb) AS x(
           minuto timestamptz, requisicoes int, erros_5xx int, emaxconnsession int)
       ON CONFLICT (minuto, instancia) DO UPDATE SET
         requisicoes = erros_por_minuto.requisicoes + EXCLUDED.requisicoes,
         erros_5xx = erros_por_minuto.erros_5xx + EXCLUDED.erros_5xx,
         emaxconnsession = erros_por_minuto.emaxconnsession + EXCLUDED.emaxconnsession`,
      [JSON.stringify(linhas), INSTANCIA]
    );
  } catch (err) {
    if (err && err.code === '42P01') {
      tabelaAusenteAte = agora + TABELA_AUSENTE_ESPERA_MS;
      avisarUmaVez('tabela erros_por_minuto ainda não existe (migration 381): contador dormente');
      return { gravados: 0, dormente: true };
    }
    // Falha de conexão: devolve os minutos (somando ao que já entrou) para a
    // próxima tentativa, dentro do limite.
    for (const [ms, c] of fechados) {
      if (corte - ms > REPETIR_ATE_MS) continue;
      const atual = minutos.get(ms);
      if (atual) {
        atual.requisicoes += c.requisicoes;
        atual.erros_5xx += c.erros_5xx;
        atual.emaxconnsession += c.emaxconnsession;
      } else {
        minutos.set(ms, { ...c });
      }
    }
    avisarUmaVez(`flush falhou (tenta de novo no próximo minuto): ${err && err.message}`);
    return { gravados: 0, erro: true };
  }

  // Retenção de 7 dias, feita aqui, no máximo uma vez por hora.
  if (agora - limpouEm > LIMPEZA_A_CADA_MS) {
    limpouEm = agora;
    try {
      await banco.query(
        'DELETE FROM erros_por_minuto WHERE minuto < $1',
        [new Date(agora - RETENCAO_DIAS * 86400000)]
      );
    } catch (err) {
      avisarUmaVez(`limpeza falhou: ${err && err.message}`);
    }
  }
  return { gravados: linhas.length };
}

// ── leitura (bloco Plataforma) ──────────────────────────────────
const hhmmBRT = (ms) => {
  const d = new Date(ms - TZ_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const num = (v) => Number(v) || 0;

// Últimos 60 minutos FECHADOS (o minuto corrente ainda está em memória).
// null: tabela ausente, contador desligado ou nenhuma linha na janela — o
// bloco sai como antes. Falha de leitura NÃO lança: devolve null.
async function resumo({ db, agora = new Date() } = {}) {
  if (desligado()) return null;
  const banco = db || require('../config/database');
  const fim = inicioDoMinuto(agora.getTime());
  const ini = fim - JANELA_MIN * MINUTO_MS;

  let rows;
  try {
    ({ rows } = await banco.query(
      `SELECT minuto,
              SUM(requisicoes) AS requisicoes,
              SUM(erros_5xx) AS erros_5xx,
              SUM(emaxconnsession) AS emaxconnsession
         FROM erros_por_minuto
        WHERE minuto >= $1 AND minuto < $2
        GROUP BY minuto
        ORDER BY minuto`,
      [new Date(ini), new Date(fim)]
    ));
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703')) return null;
    throw err;
  }
  if (!rows || !rows.length) return null;

  const porMinuto = new Map(rows.map((r) => [inicioDoMinuto(new Date(r.minuto).getTime()), r]));
  const serie = [];
  let requisicoes = 0;
  let erros5xx = 0;
  let emaxconn = 0;
  for (let ms = ini; ms < fim; ms += MINUTO_MS) {
    const r = porMinuto.get(ms);
    const p = {
      rotulo: hhmmBRT(ms),
      minuto: new Date(ms).toISOString(),
      requisicoes: r ? num(r.requisicoes) : 0,
      valor: r ? num(r.erros_5xx) : 0,
      emaxconnsession: r ? num(r.emaxconnsession) : 0,
    };
    requisicoes += p.requisicoes;
    erros5xx += p.valor;
    emaxconn += p.emaxconnsession;
    serie.push(p);
  }

  return {
    ativo: true,
    janela_min: JANELA_MIN,
    de: new Date(ini).toISOString(),
    ate: new Date(fim).toISOString(),
    requisicoes,
    erros_5xx: erros5xx,
    emaxconnsession: emaxconn,
    pct_5xx: requisicoes ? Math.round((erros5xx / requisicoes) * 10000) / 100 : null,
    minutos_com_dados: rows.length,
    serie_60m: serie,
  };
}

// ── ciclo de vida ───────────────────────────────────────────────
let timer = null;

// Liga o flush por minuto e o observador do pool. Idempotente. Dormente em
// teste e com o kill switch (não cria timer nem mexe no pool).
function iniciar({ pool } = {}) {
  if (timer || desligado() || process.env.NODE_ENV === 'test') return false;
  const banco = pool || require('../config/database');
  observarPool(banco);
  timer = setInterval(() => { flush({ db: banco }).catch(() => {}); }, MINUTO_MS);
  if (timer.unref) timer.unref();
  return true;
}

function parar() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Só para teste: zera o estado do módulo.
function _reiniciar() {
  minutos.clear();
  tabelaAusenteAte = 0;
  limpouEm = 0;
  avisou = new Set();
  parar();
}

module.exports = {
  INSTANCIA, JANELA_MIN, RETENCAO_DIAS, MINUTO_MS,
  registrarResposta, registrarErro, ehEmaxconn, observarPool,
  flush, resumo, iniciar, parar, _reiniciar, _minutos: minutos,
};
