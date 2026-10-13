'use strict';
// BIPE SINTÉTICO — a cada 5 minutos faz, pelo caminho HTTP real, o que a
// lojista faz no Caixa (services/canary.js) e avisa quando para de funcionar
// (services/canaryAlerta.js). Existe porque o /health ficou verde durante o
// incidente do pooler de 28/09 com o Caixa fora do ar.
//
// Mesmo padrão dos outros jobs: setInterval por minuto (o backend não tem
// cron real), com guarda — o tick só trabalha na primeira passada de cada
// janela de 5 minutos.
//
// Trava entre réplicas: INSERT em canary_runs com started_at truncado a 5
// min e índice único. Quem insere roda; as outras desistem.
//
// Dormente por padrão: sem CANARY_COMPANY_ID / CANARY_USER_ID /
// CANARY_BARCODE o tick não consulta o banco nem faz requisição.
// Kill switch sem deploy: CANARY_ENABLED=false.
//
// Retenção: 30 dias, limpa pelo próprio job (no máximo uma vez por hora).
const db = require('../config/database');
const canary = require('../services/canary');
const alerta = require('../services/canaryAlerta');
const status = require('../services/canaryStatus');

const TICK_MS = 60 * 1000;
const JANELA_MS = 5 * 60 * 1000;
const RETENCAO_DIAS = 30;
const LIMPEZA_A_CADA_MS = 60 * 60 * 1000;
const RUNS_PARA_DECIDIR = 40;

let _interval = null;
let _running = false;
let _ultimaJanela = null;
let _limpouEm = 0;

const janelaDe = (agora) => new Date(Math.floor(agora.getTime() / JANELA_MS) * JANELA_MS);
// Dia em Brasília ('YYYY-MM-DD'), a chave de painel_alertas.
const diaBRT = (agora) => new Date(agora.getTime() - 3 * 3600000).toISOString().slice(0, 10);

// Pega a janela. true = esta instância roda.
async function pegarTrava(janela, banco = db) {
  const { rows } = await banco.query(
    `INSERT INTO canary_runs (started_at) VALUES ($1)
     ON CONFLICT (started_at) DO NOTHING
     RETURNING id`,
    [janela]
  );
  return rows.length ? rows[0].id : null;
}

// Venda sintética que ficou aberta numa execução anterior (cancelamento
// falhou): estorna antes de vender de novo, para o estoque do produto
// canário não escoar e a receita da empresa de teste não crescer.
async function recolherPendentes(cfg, deps = {}) {
  const banco = deps.db || db;
  const { rows } = await banco.query(
    `SELECT id, venda_id FROM canary_runs
      WHERE venda_pendente AND venda_id IS NOT NULL
      ORDER BY started_at DESC LIMIT 5`
  );
  if (!rows.length) return 0;
  let token;
  try { token = (deps.gerarToken || canary.gerarToken)(cfg); } catch (_) { return 0; }
  let recolhidas = 0;
  for (const r of rows) {
    const { ok } = await canary.cancelarVenda(cfg, token, r.venda_id, deps);
    if (ok) {
      await banco.query('UPDATE canary_runs SET venda_pendente = FALSE WHERE id = $1', [r.id]);
      recolhidas++;
    }
  }
  return recolhidas;
}

async function limparAntigas(agora, banco = db) {
  if (agora.getTime() - _limpouEm < LIMPEZA_A_CADA_MS) return 0;
  _limpouEm = agora.getTime();
  const { rowCount } = await banco.query(
    `DELETE FROM canary_runs WHERE started_at < $1`,
    [new Date(agora.getTime() - RETENCAO_DIAS * 86400000)]
  );
  return rowCount || 0;
}

// Depois de gravar o resultado: decide e-mail e painel.
async function tratarAlertas({ runId, agora, banco = db, mailer, env = process.env }) {
  const { rows: runs } = await banco.query(
    `SELECT id, started_at, ok, alerta, erro, passos, duracao_ms
       FROM canary_runs WHERE ok IS NOT NULL
      ORDER BY started_at DESC LIMIT ${RUNS_PARA_DECIDIR}`
  );
  if (!runs.length) return null;
  const atual = runs[0];
  const dia = diaBRT(agora);

  // Painel: de pé enquanto durar a queda, regravado a cada execução.
  if (!atual.ok) {
    const a = status.alertaDeRuns(runs, agora);
    if (a) await alerta.gravarNoPainel(banco, { dia, alerta: a });
  } else if (runs[1] && !runs[1].ok) {
    await alerta.limparDoPainel(banco, { dia });
  }

  const decisao = alerta.decidir(runs, agora);
  if (!decisao) return null;
  try {
    const tipo = await alerta.avisar({ decisao, runs, mailer, env });
    await banco.query('UPDATE canary_runs SET alerta = $1 WHERE id = $2', [tipo, runId]);
    console.log(`[canary] alerta "${tipo}" enviado para ${alerta.destinatario(env)}`);
    return tipo;
  } catch (e) {
    // Sem e-mail: não grava `alerta`, a próxima execução tenta de novo.
    console.error('[canary] e-mail de alerta falhou:', e.message);
    return null;
  }
}

async function tick(deps = {}) {
  const cfg = deps.cfg !== undefined ? deps.cfg : canary.configuracao();
  if (!cfg) return null; // dormente
  if (_running) return null; // nunca sobrepor ticks

  const agora = deps.agora || new Date();
  const janela = janelaDe(agora);
  if (_ultimaJanela === janela.getTime()) return null; // uma tentativa por janela
  _ultimaJanela = janela.getTime();

  const banco = deps.db || db;
  _running = true;
  try {
    const runId = await pegarTrava(janela, banco);
    if (runId === null) return null; // outra réplica pegou a janela

    try { await recolherPendentes(cfg, { ...deps, db: banco }); } catch (e) {
      console.error('[canary] recolher pendentes falhou:', e.message);
    }

    let r;
    try {
      r = await (deps.executar || canary.executar)(cfg, deps);
    } catch (e) {
      // executar() não deveria lançar; se lançar, é falha do próprio canário.
      r = { ok: false, passos: [], duracao_ms: 0, erro: `canário: ${e.message}`, venda_id: null, venda_pendente: false };
    }

    await banco.query(
      `UPDATE canary_runs
          SET finished_at = NOW(), ok = $2, passos = $3::jsonb, duracao_ms = $4,
              erro = $5, venda_id = $6, venda_pendente = $7
        WHERE id = $1`,
      [runId, r.ok, JSON.stringify(r.passos), r.duracao_ms, r.erro ? String(r.erro).slice(0, 2000) : null,
        r.venda_id, r.venda_pendente]
    );
    if (!r.ok) console.warn(`[canary] FALHA em ${r.duracao_ms}ms — ${r.erro}`);

    await tratarAlertas({ runId, agora, banco, mailer: deps.mailer, env: deps.env });
    await limparAntigas(agora, banco);
    return r;
  } catch (e) {
    // 42P01/42703 = migration 378 pendente: dormente, sem barulho por tick.
    if (e && e.code !== '42P01' && e.code !== '42703') console.error('[canary] tick error:', e.message);
    return null;
  } finally {
    _running = false;
  }
}

function initCanaryJob() {
  if (_interval) return;
  if (String(process.env.CANARY_ENABLED || 'true').trim().toLowerCase() === 'false') {
    console.log('[canary] desabilitado por CANARY_ENABLED=false');
    return;
  }
  if (!canary.configuracao()) {
    console.log('[canary] dormente — defina CANARY_COMPANY_ID, CANARY_USER_ID e CANARY_BARCODE para ligar');
  }
  _interval = setInterval(tick, TICK_MS);
  if (_interval.unref) _interval.unref();
  console.log('[canary] iniciado — bipe sintético a cada 5 min');
}
function stopCanaryJob() { if (_interval) { clearInterval(_interval); _interval = null; } }

// Só para testes.
function _resetForTests() { _running = false; _ultimaJanela = null; _limpouEm = 0; }

module.exports = {
  initCanaryJob, stopCanaryJob, tick, pegarTrava, recolherPendentes, limparAntigas, tratarAlertas,
  janelaDe, diaBRT, _resetForTests,
  TICK_MS, JANELA_MS, RETENCAO_DIAS,
};
