// ============================================================
// AURA. — Bipe rápido: só o bipe, a cada 30 s (t1-08, 14/10/2026)
//
// Por que existe: o bipe sintético completo (services/canary.js, a cada
// 5 min, alerta em 2 falhas seguidas) leva de 5 a 11 min para avisar, e as
// rajadas de EMAXCONNSESSION de 1 a 9 min passam entre duas amostras. Este
// laço faz SÓ o passo do bipe (GET /companies/:id/pdv/scan/:code), pelo
// mesmo caminho HTTP real, a cada 30 s, e avisa em 3 falhas seguidas. Meta:
// detectar em até 3 min.
//
// Só leitura: não vende, não grava no banco. O estado (últimas execuções e
// "quem já avisou") fica em memória. O canary_runs é do laço de 5 min, com
// uma linha por janela de 5 min e trava entre réplicas; enfiar 120 linhas
// por hora ali mudaria a disponibilidade do painel. O banco só é LIDO, uma
// vez por queda, para não repetir um "caiu" que o laço de 5 min já mandou
// antes de um deploy apagar a memória.
//
// Um aviso por evento, nunca dois:
//   - este laço manda "caiu" só se ninguém avisou a queda atual. Quando o
//     laço de 5 min decide "caiu" depois, ele vê que já foi avisado
//     (jaAvisadoPeloBipe) e só registra canary_runs.alerta, sem e-mail. Daí
//     em diante os lembretes de 30 min são dele, como antes;
//   - "voltou" sai de quem avisou a queda. Se este laço avisou e o bipe
//     voltou, ele manda; o laço de 5 min, ao decidir "voltou", vê que já foi
//     e só registra. Se a queda foi avisada pelo laço de 5 min (ex.: falha
//     na venda com o bipe ok), este laço não manda "voltou".
//   - o laço de 5 min avisa este (registrarAvisoDoCanario) a cada e-mail.
// Com duas instâncias no ar (troca de versão), cada uma tem a sua memória:
// numa queda que coincida com o deploy o "caiu" pode sair duas vezes.
//
// Config: as mesmas envs do canário (sem elas, dormente) +
//   CANARY_BIPE_RAPIDO_ENABLED  'false' desliga só este laço (padrão: ligado)
//   CANARY_BIPE_TIMEOUT_MS      tempo-limite da requisição (padrão 10000)
// CANARY_ENABLED=false desliga os dois.
// ============================================================
'use strict';

const pool = require('../config/database');
const canary = require('./canary');
const alerta = require('./canaryAlerta');

const TICK_MS = 30 * 1000;
const FALHAS_PARA_ALERTAR = 3;
const HISTORICO = 20;
const TIMEOUT_PADRAO_MS = 10000;

function estadoInicial() {
  return {
    historico: [],          // execuções, da mais nova para a mais antiga
    quedaAvisadaEm: null,   // quando a queda atual foi avisada ("caiu"/"repeticao")
    quedaAvisadaPor: null,  // 'bipe' (este laço) | 'canario' (laço de 5 min)
    voltaAvisadaEm: null,
    voltaAvisadaPor: null,
  };
}
let estado = estadoInicial();

const ms = (d) => (d ? new Date(d).getTime() : 0);

// Config ou null (dormente/desligado).
function configuracaoRapida(env = process.env) {
  if (String(env.CANARY_BIPE_RAPIDO_ENABLED || 'true').trim().toLowerCase() === 'false') return null;
  const cfg = canary.configuracao(env);
  if (!cfg) return null;
  const t = parseInt(env.CANARY_BIPE_TIMEOUT_MS, 10);
  return { ...cfg, timeoutMs: Number.isFinite(t) && t > 0 ? t : Math.min(cfg.timeoutMs, TIMEOUT_PADRAO_MS) };
}

// Há uma queda avisada (por qualquer um dos laços) e ainda sem "voltou"?
function quedaAtiva() {
  return !!estado.quedaAvisadaEm && ms(estado.voltaAvisadaEm) < ms(estado.quedaAvisadaEm);
}

// ── Ponte com o laço de 5 min (jobs/canaryJob.js) ───────────────────────────

// O laço de 5 min mandou um e-mail.
function registrarAvisoDoCanario(tipo, agora = new Date()) {
  if (alerta.AVISOS_DE_QUEDA.includes(tipo)) {
    if (!quedaAtiva()) { estado.quedaAvisadaEm = agora; estado.quedaAvisadaPor = 'canario'; }
  } else if (tipo === 'voltou') {
    if (quedaAtiva()) { estado.voltaAvisadaEm = agora; estado.voltaAvisadaPor = 'canario'; }
  }
}

// O laço de 5 min vai avisar `tipo`: este laço já avisou?
function jaAvisadoPeloBipe(tipo) {
  if (tipo === 'caiu') return quedaAtiva() && estado.quedaAvisadaPor === 'bipe';
  if (tipo === 'voltou') {
    return !!estado.voltaAvisadaEm && estado.voltaAvisadaPor === 'bipe' && !quedaAtiva();
  }
  return false; // 'repeticao' é sempre do laço de 5 min
}

// ── Decisão (pura sobre o estado) ───────────────────────────────────────────
function falhasSeguidas(hist, desde = 0) {
  let n = 0;
  for (const r of hist.slice(desde)) { if (r.ok) break; n++; }
  return n;
}

// → { tipo: 'caiu'|'voltou', seguidas } | null
function decidir(hist = estado.historico) {
  const atual = hist[0];
  if (!atual) return null;
  if (!atual.ok) {
    const seguidas = falhasSeguidas(hist);
    if (seguidas >= FALHAS_PARA_ALERTAR && !quedaAtiva()) return { tipo: 'caiu', seguidas };
    return null;
  }
  if (quedaAtiva() && estado.quedaAvisadaPor === 'bipe') {
    return { tipo: 'voltou', seguidas: falhasSeguidas(hist, 1) };
  }
  return null;
}

// O laço de 5 min já avisou uma queda que continua? (memória perdida em
// deploy). Lê as últimas execuções de canary_runs; tabela ausente = não.
async function quedaJaAvisadaNoBanco(db) {
  try {
    const { rows } = await db.query(
      `SELECT ok, alerta FROM canary_runs WHERE ok IS NOT NULL
        ORDER BY started_at DESC LIMIT 40`
    );
    if (!rows || !rows.length || rows[0].ok) return false;
    for (const r of rows) {
      if (r.ok) break;
      if (alerta.AVISOS_DE_QUEDA.includes(r.alerta)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function enviar({ decisao, mailer, env }) {
  const m = mailer || require('./mailer');
  const { subject, text, html } = alerta.montarEmail({ ...decisao, runs: estado.historico }, m.escapeHtml);
  const nota = `Detectado pelo bipe rápido: só o passo do bipe, a cada ${TICK_MS / 1000} s, ${FALHAS_PARA_ALERTAR} falhas seguidas para avisar.`;
  const esc = m.escapeHtml || ((s) => String(s));
  const corpoHtml = `${html}<p style="color:#8a8aa0;font-size:12px;margin:12px 0 0;">${esc(nota)}</p>`;
  await m.sendMail({
    to: alerta.destinatario(env),
    subject,
    text: `${text}\n\n${nota}`,
    html: m.emailLayout ? m.emailLayout(corpoHtml) : corpoHtml,
  });
}

// Uma execução do laço. Devolve { r, aviso } — aviso = tipo enviado ou null.
async function rodarUmaVez(cfg, deps = {}) {
  const agora = deps.agora || new Date();
  const db = deps.db || pool;
  const env = deps.env || process.env;
  let r;
  try {
    r = await (deps.executar || canary.executarSoBipe)(cfg, deps);
  } catch (e) {
    r = { ok: false, passos: [], duracao_ms: 0, erro: `canário: ${e.message}`, passo_falho: null };
  }

  const anterior = estado.historico[0];
  estado.historico.unshift({
    started_at: agora, ok: !!r.ok, passos: r.passos || [], erro: r.erro || null, duracao_ms: r.duracao_ms, alerta: null,
  });
  estado.historico.length = Math.min(estado.historico.length, HISTORICO);

  // Log só nas viradas, para não escrever 2.880 linhas por dia.
  if (!r.ok) {
    console.warn(`[canary-bipe] falha ${falhasSeguidas(estado.historico)}/${FALHAS_PARA_ALERTAR} em ${r.duracao_ms}ms — ${r.erro}`);
  } else if (anterior && !anterior.ok) {
    console.log(`[canary-bipe] bipe voltou a passar (${r.duracao_ms}ms)`);
  }

  const decisao = decidir();
  if (!decisao) return { r, aviso: null };

  if (decisao.tipo === 'caiu' && await quedaJaAvisadaNoBanco(db)) {
    estado.quedaAvisadaEm = agora;
    estado.quedaAvisadaPor = 'canario';
    console.log('[canary-bipe] queda já avisada pelo bipe de 5 min — sem novo e-mail');
    return { r, aviso: null };
  }

  try {
    await enviar({ decisao, mailer: deps.mailer, env });
  } catch (e) {
    // Sem e-mail: não marca; a próxima execução tenta de novo.
    console.error('[canary-bipe] e-mail de alerta falhou:', e.message);
    return { r, aviso: null };
  }
  estado.historico[0].alerta = decisao.tipo;
  if (decisao.tipo === 'caiu') {
    estado.quedaAvisadaEm = agora;
    estado.quedaAvisadaPor = 'bipe';
  } else {
    estado.voltaAvisadaEm = agora;
    estado.voltaAvisadaPor = 'bipe';
  }
  console.log(`[canary-bipe] alerta "${decisao.tipo}" enviado para ${alerta.destinatario(env)}`);
  return { r, aviso: decisao.tipo };
}

// Só para testes.
function _resetForTests() { estado = estadoInicial(); }
function _estado() { return estado; }

module.exports = {
  TICK_MS, FALHAS_PARA_ALERTAR, TIMEOUT_PADRAO_MS,
  configuracaoRapida, rodarUmaVez, decidir, quedaAtiva, quedaJaAvisadaNoBanco,
  registrarAvisoDoCanario, jaAvisadoPeloBipe,
  _resetForTests, _estado,
};
