// ============================================================
// AURA. — Painel da Gestão Aura: job diário das 06h BRT (13/10/2026)
//
// Recalcula health score, MRR do mês, os blocos do painel e os alertas
// (services/painelDiario.js). Antes disso tudo dependia de POST manual: o
// snapshot de receita tinha 1 linha de abril e o health score estava parado
// desde 25/04.
//
// Mesmo padrão do reportScheduler: tick por minuto. A diferença é a trava:
// pode haver mais de uma instância na Railway, então "já rodou hoje" não
// pode morar só na memória do processo. Quem consegue inserir a linha do dia
// em painel_runs é quem roda; as outras desistem.
//
// 06h é o piso, não a janela: se o processo subir depois das 06h (deploy,
// queda) e o dia ainda não tiver rodado, roda no primeiro tick. E uma
// execução que morreu no meio (linha sem finished_at há mais de 30 min) pode
// ser assumida por outra — sem isso, um deploy às 06h01 deixaria o painel
// sem número até o dia seguinte.
//
// Kill switch: PAINEL_DIARIO_ENABLED=false.
// ============================================================
'use strict';

const db = require('../config/database');
const { rodarPainelDiario } = require('../services/painelDiario');

const HORA_BRT = 6;
const ABANDONO_MIN = 30;

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

// Tenta pegar a trava do dia. true = esta instância roda.
async function pegarTrava(dia, deps = {}) {
  const banco = deps.db || db;
  const { rows } = await banco.query(
    `INSERT INTO painel_runs (dia, started_at)
     VALUES ($1::date, NOW())
     ON CONFLICT (dia) DO UPDATE SET started_at = NOW(), erro = NULL
       WHERE painel_runs.finished_at IS NULL
         AND painel_runs.started_at < NOW() - make_interval(mins => ${ABANDONO_MIN})
     RETURNING dia`,
    [dia]
  );
  return rows.length > 0;
}

// Um ciclo com trava. @returns o resultado de rodarPainelDiario, ou null se
// outra instância já rodou (ou está rodando) o dia.
async function executarDia(dia, deps = {}) {
  const banco = deps.db || db;
  const rodar = deps.rodar || rodarPainelDiario;

  if (!(await pegarTrava(dia, deps))) return null;

  const inicio = Date.now();
  let resultado = null;
  let erro = null;
  try {
    resultado = await rodar({ hoje: dia, db: banco });
    if (resultado.erros && resultado.erros.length) {
      erro = resultado.erros.map((e) => `${e.etapa}: ${e.erro}`).join(' | ').slice(0, 2000);
    }
  } catch (err) {
    erro = String(err && err.message ? err.message : err).slice(0, 2000);
  }

  await banco.query(
    `UPDATE painel_runs
        SET finished_at = NOW(), ok = $2, erro = $3, duracao_ms = $4
      WHERE dia = $1::date`,
    [dia, !erro, erro, Date.now() - inicio]
  );

  if (erro) console.error(`[painelDiario] ${dia} terminou com erro: ${erro}`);
  else console.log(`[painelDiario] ${dia} calculado em ${Date.now() - inicio}ms — ${resultado.blocos.length} blocos, ${resultado.alertas} alertas`);
  return resultado;
}

let _lastDate = null;
let _naoAntesDe = 0;
let _avisouSemTabela = false;

// A trava é de outra instância: ela já terminou o dia?
async function diaTerminou(dia, deps = {}) {
  const { rows } = await (deps.db || db).query(
    'SELECT (finished_at IS NOT NULL) AS terminou FROM painel_runs WHERE dia = $1::date',
    [dia]
  );
  return !!(rows[0] && rows[0].terminou);
}

// Decide se este tick dispara. Devolve a Promise da execução (ou null) para
// o teste poder aguardar.
function tick(deps = {}) {
  if (process.env.PAINEL_DIARIO_ENABLED === 'false') return null;
  const now = deps.now || nowBRT();
  const agoraMs = deps.agoraMs || Date.now();
  const dateStr = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < HORA_BRT || _lastDate === dateStr || agoraMs < _naoAntesDe) return null;

  // Marca antes de disparar: o tick do minuto seguinte não dispara de novo
  // enquanto este ainda está rodando.
  _lastDate = dateStr;
  return executarDia(dateStr, deps).then(async (resultado) => {
    if (resultado === null && !(await diaTerminou(dateStr, deps))) {
      // Outra instância está no meio do dia. Se ela morrer, a linha fica sem
      // finished_at e esta assume depois do prazo de abandono — por isso
      // volta a olhar em 10 minutos em vez de dar o dia por feito.
      _lastDate = null;
      _naoAntesDe = agoraMs + 10 * 60 * 1000;
    }
    return resultado;
  }).catch((err) => {
    if (err && err.code === '42P01') {
      // painel_runs ainda não existe (migration 370 pendente): tenta de novo
      // no próximo tick em vez de perder o dia.
      _lastDate = null;
      if (!_avisouSemTabela) {
        _avisouSemTabela = true;
        console.warn('[painelDiario] painel_runs ainda não existe (migration 370 pendente).');
      }
      return null;
    }
    console.error('[painelDiario] crash:', err && err.message);
    return null;
  });
}

let _interval = null;

function initPainelDiarioScheduler() {
  if (_interval) return;
  _interval = setInterval(tick, 60 * 1000);
  console.log('[painelDiario] iniciado — recalcula o painel da Gestão Aura todo dia a partir das 06h BRT');
}

function stopPainelDiarioScheduler() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

// Só para testes.
function _resetForTests() {
  _lastDate = null;
  _naoAntesDe = 0;
  _avisouSemTabela = false;
}

module.exports = {
  HORA_BRT,
  ABANDONO_MIN,
  pegarTrava,
  executarDia,
  tick,
  initPainelDiarioScheduler,
  stopPainelDiarioScheduler,
  _resetForTests,
};
