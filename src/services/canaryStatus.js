// ============================================================
// AURA. — Bipe sintético: o que o painel e o alerta leem (13/10/2026)
//
// Resume canary_runs: último resultado, há quanto tempo, disponibilidade nas
// últimas 24h e a série por hora. Também diz se a plataforma está "caída"
// (duas execuções seguidas falhando) — a mesma regra que dispara o e-mail
// (services/canaryAlerta.js), para o painel e o aviso nunca discordarem.
//
// Fonte ausente (migration 378 pendente) = sem execuções, nunca erro: o
// backend sobe antes da migration (CLAUDE.md, armadilha 1).
// ============================================================
'use strict';

const pool = require('../config/database');
const { configuracao } = require('./canary');
// A mesma regra do e-mail (canaryAlerta): painel e aviso nunca discordam.
const { FALHAS_PARA_ALERTAR } = require('./canaryAlerta');

const JANELA_HORAS = 24;
const TZ_OFFSET_MS = 3 * 3600000; // Brasília, sem horário de verão

async function ler(db, sql, params) {
  try {
    const { rows } = await db.query(sql, params);
    return rows || [];
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return [];
    throw e;
  }
}

const passoFalho = (passos) => {
  const p = Array.isArray(passos) ? passos.find((x) => x && x.ok === false) : null;
  return p ? p.passo : null;
};

// Execuções seguidas falhando, da mais recente para trás. `runs` vem do mais
// novo para o mais antigo.
function falhasSeguidas(runs) {
  let n = 0;
  for (const r of runs) {
    if (r.ok) break;
    n++;
  }
  return n;
}

const horaBRT = (ts) => new Date(new Date(ts).getTime() - TZ_OFFSET_MS).toISOString().slice(0, 13);

function pct(ok, total) {
  return total ? Math.round((ok / total) * 1000) / 10 : null;
}

// Série por hora (BRT): % de execuções ok em cada uma das últimas 24 horas.
function serieDeHoras(runs, agora) {
  const porHora = new Map();
  for (const r of runs) {
    const h = horaBRT(r.started_at);
    const g = porHora.get(h) || { ok: 0, total: 0 };
    g.total++;
    if (r.ok) g.ok++;
    porHora.set(h, g);
  }
  const pontos = [];
  const fim = Math.floor((agora.getTime() - TZ_OFFSET_MS) / 3600000) * 3600000;
  for (let i = JANELA_HORAS - 1; i >= 0; i--) {
    const t = new Date(fim - i * 3600000);
    const chave = t.toISOString().slice(0, 13);
    const g = porHora.get(chave);
    pontos.push({
      rotulo: `${String(t.getUTCHours()).padStart(2, '0')}h`,
      hora: `${chave}:00`,
      valor: g ? pct(g.ok, g.total) : null,
      execucoes: g ? g.total : 0,
    });
  }
  return pontos;
}

// null quando o canário está dormente (sem envs ou kill switch) — o painel
// então não mostra nada, em vez de mostrar um histórico parado.
async function resumo({ db = pool, agora = new Date(), cfg = configuracao() } = {}) {
  if (!cfg) return null;

  const desde = new Date(agora.getTime() - JANELA_HORAS * 3600000);
  let runs = await ler(
    db,
    `SELECT started_at, ok, duracao_ms, erro, passos
       FROM canary_runs
      WHERE ok IS NOT NULL AND started_at >= $1
      ORDER BY started_at DESC`,
    [desde]
  );
  let ultimo = runs[0] || null;
  if (!ultimo) {
    [ultimo] = await ler(
      db,
      `SELECT started_at, ok, duracao_ms, erro, passos
         FROM canary_runs WHERE ok IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
      []
    );
    ultimo = ultimo || null;
  }

  const total = runs.length;
  const ok = runs.filter((r) => r.ok).length;
  const seguidas = falhasSeguidas(runs);
  const caido = seguidas >= FALHAS_PARA_ALERTAR;
  const desdeQuando = seguidas > 0 ? runs[seguidas - 1].started_at : null;

  return {
    ativo: true,
    ultimo: ultimo ? {
      quando: new Date(ultimo.started_at).toISOString(),
      ok: !!ultimo.ok,
      duracao_ms: ultimo.duracao_ms === null || ultimo.duracao_ms === undefined ? null : Number(ultimo.duracao_ms),
      erro: ultimo.erro || null,
      passo_falho: passoFalho(ultimo.passos),
      passos: (Array.isArray(ultimo.passos) ? ultimo.passos : []).map((p) => ({ passo: p.passo, ok: !!p.ok, ms: p.ms })),
    } : null,
    ha_minutos: ultimo ? Math.max(0, Math.round((agora.getTime() - new Date(ultimo.started_at).getTime()) / 60000)) : null,
    caido,
    falhas_seguidas: seguidas,
    desde: desdeQuando ? new Date(desdeQuando).toISOString() : null,
    disponibilidade_24h: { execucoes: total, ok, pct: pct(ok, total) },
    serie_24h: serieDeHoras(runs, agora),
  };
}

// Alerta do painel (tipo plataforma_caida), no formato de painelAlertas.
function montarAlerta({ erro, passos, desde, seguidas }, agora) {
  const min = desde ? Math.max(0, Math.round((agora.getTime() - new Date(desde).getTime()) / 60000)) : null;
  const falho = (passos || []).find((p) => p && p.ok === false);
  return {
    tipo: 'plataforma_caida',
    chave: 'canary',
    company_id: null,
    titulo: `Caixa fora do ar: bipe sintético falhando${min === null ? '' : ` há ${min} min`}`,
    detalhe: `${erro || 'sem detalhe'}${falho && falho.ms ? ` · ${falho.ms} ms` : ''} · ${seguidas} execuções seguidas`,
    verbo: 'Ver',
    bloco: 'plataforma',
  };
}

// Do resumo do painel; null quando está tudo bem.
function alertaDoPainel(r, agora = new Date()) {
  if (!r || !r.caido || !r.ultimo) return null;
  return montarAlerta({ erro: r.ultimo.erro, passos: r.ultimo.passos, desde: r.desde, seguidas: r.falhas_seguidas }, agora);
}

// Das execuções cruas (da mais nova para a mais antiga), sem nova consulta.
function alertaDeRuns(runs, agora = new Date()) {
  const seguidas = falhasSeguidas(runs);
  if (seguidas < FALHAS_PARA_ALERTAR) return null;
  return montarAlerta({
    erro: runs[0].erro, passos: runs[0].passos, desde: runs[seguidas - 1].started_at, seguidas,
  }, agora);
}

module.exports = {
  FALHAS_PARA_ALERTAR, JANELA_HORAS,
  resumo, alertaDoPainel, alertaDeRuns, falhasSeguidas, serieDeHoras, passoFalho,
};
