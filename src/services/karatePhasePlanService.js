// ============================================================
// AURA KARATÊ — P1 Hub: PLANO DE FASES da chave (serviço PURO)
//
// Mesma filosofia de karateBracket.js / karateCompetitionPricingService:
// toda a regra vive aqui, sem DB, unit-testável — a rota só orquestra.
//
// MODELO (karate_brackets.phase_plan, migration 296) — derivado dos
// regulamentos reais (Dossiê Shiai §4):
//
//   {
//     "phases": [
//       { "from_participants": null, "format": "sanbon_kumite", "decision": "hantei" },
//       { "from_participants": 8,    "format": "kihon_ippon",   "decision": "hantei" },
//       { "from_participants": 4,    "format": "jyu_ippon",     "decision": "hantei" },
//       { "final": true, "format": "shobu_ippon", "duration_sec": 300, "time_mode": "efetivo" }
//     ],
//     "tiebreak": ["hantei", "kettei_sen", "central"],
//     "required_kata": "Heians até a faixa do menos graduado",
//     "prize_places": 4,
//     "third_place_dispute": false,
//     "notes": "texto livre para a súmula"
//   }
//
// SEMÂNTICA DA RESOLUÇÃO (resolvePhaseForRound):
//   • participantes da rodada r numa chave de R rodadas = 2^(R - r)
//     (rodada 0 = primeira; final tem 2).
//   • Fase com "final": true vale APENAS para a última rodada (e para a
//     disputa de 3º lugar, que acontece no mesmo bloco final).
//   • Das demais, vale a fase de MENOR from_participants que ainda
//     comporte a rodada (participants <= from_participants);
//     from_participants null = sem teto (pega as eliminatórias).
//   • Sem plano ({}): retorna null — comportamento legado (formato único
//     da modalidade da categoria).
//
// FORMATOS e MÉTODOS DE DECISÃO são vocabulário CONTROLADO (o dado é o
// conceito; o rótulo de exibição é da UI/súmula) — mesma decisão dos
// quesitos F10 (valor nomeado, nunca o símbolo).
// ============================================================
'use strict';

const MATCH_FORMATS = Object.freeze([
  'sanbon_kumite',
  'kihon_ippon',
  'jyu_ippon',
  'shobu_ippon',
  'shobu_sanbon',
  'kata_hantei',   // kata em chave 1×1 por bandeiras
  'kata_notas',    // kata por notas (final FPKT 14+)
]);

const DECISION_METHODS = Object.freeze([
  'ippon',        // vitória por ippon (ou wazari-ari acumulado)
  'wazari',
  'hantei',       // bandeiras (5 árbitros)
  'kettei_sen',   // prorrogação de 1' (primeiro wazari/ippon)
  'sai_shiai',    // nova luta (JKA, semis/final)
  'central',      // decisão do árbitro central (2º empate etc.)
  'wo',           // walkover / ausência
  'kiken',        // desistência/abandono
]);

const TIME_MODES = Object.freeze(['corrido', 'efetivo']);

const FORMAT_LABEL = Object.freeze({
  sanbon_kumite: 'Sanbon-Kumite',
  kihon_ippon: 'Kihon-Ippon-Kumite',
  jyu_ippon: 'Jyu-Ippon-Kumite',
  shobu_ippon: 'Kumite Shobu-Ippon',
  shobu_sanbon: 'Kumite Shobu-Sanbon',
  kata_hantei: 'Kata (bandeiras)',
  kata_notas: 'Kata (notas)',
});

const DECISION_LABEL = Object.freeze({
  ippon: 'Ippon',
  wazari: 'Wazari',
  hantei: 'Hantei (bandeiras)',
  kettei_sen: 'Kettei-Sen (prorrogação)',
  sai_shiai: 'Sai-Shiai (nova luta)',
  central: 'Decisão do árbitro central',
  wo: 'W.O.',
  kiken: 'Kiken (desistência)',
});

// ── Validação do plano ──────────────────────────────────────
// Retorna { ok: true } ou { ok: false, error }.
function validatePhasePlan(plan) {
  if (plan == null || (typeof plan === 'object' && !Array.isArray(plan) && Object.keys(plan).length === 0)) {
    return { ok: true }; // {} = sem plano (legado)
  }
  if (typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, error: 'phase_plan deve ser um objeto' };
  }

  if (plan.phases !== undefined) {
    if (!Array.isArray(plan.phases) || !plan.phases.length) {
      return { ok: false, error: 'phases deve ser um array não-vazio' };
    }
    let finals = 0;
    for (let i = 0; i < plan.phases.length; i++) {
      const p = plan.phases[i];
      if (!p || typeof p !== 'object') return { ok: false, error: `phases[${i}] deve ser objeto` };
      if (!MATCH_FORMATS.includes(p.format)) {
        return { ok: false, error: `phases[${i}].format inválido. Use: ${MATCH_FORMATS.join(', ')}` };
      }
      if (p.final === true) {
        finals++;
      } else if (p.from_participants !== undefined && p.from_participants !== null) {
        const n = Number(p.from_participants);
        if (!Number.isInteger(n) || n < 2) {
          return { ok: false, error: `phases[${i}].from_participants deve ser inteiro >= 2 (ou null)` };
        }
      }
      if (p.decision !== undefined && p.decision !== null && !DECISION_METHODS.includes(p.decision)) {
        return { ok: false, error: `phases[${i}].decision inválido. Use: ${DECISION_METHODS.join(', ')}` };
      }
      if (p.duration_sec !== undefined && p.duration_sec !== null) {
        const d = Number(p.duration_sec);
        if (!Number.isInteger(d) || d <= 0 || d > 3600) {
          return { ok: false, error: `phases[${i}].duration_sec inválido` };
        }
      }
      if (p.time_mode !== undefined && p.time_mode !== null && !TIME_MODES.includes(p.time_mode)) {
        return { ok: false, error: `phases[${i}].time_mode deve ser: ${TIME_MODES.join(', ')}` };
      }
    }
    if (finals > 1) return { ok: false, error: 'apenas uma fase pode ter final: true' };
  }

  if (plan.tiebreak !== undefined) {
    if (!Array.isArray(plan.tiebreak)) return { ok: false, error: 'tiebreak deve ser um array' };
    for (const t of plan.tiebreak) {
      if (!DECISION_METHODS.includes(t)) {
        return { ok: false, error: `tiebreak contém método inválido: ${t}` };
      }
    }
  }

  if (plan.prize_places !== undefined && plan.prize_places !== null) {
    const n = Number(plan.prize_places);
    if (!Number.isInteger(n) || n < 1 || n > 8) return { ok: false, error: 'prize_places deve ser 1..8' };
  }
  if (plan.third_place_dispute !== undefined && typeof plan.third_place_dispute !== 'boolean') {
    return { ok: false, error: 'third_place_dispute deve ser boolean' };
  }
  if (plan.required_kata !== undefined && plan.required_kata !== null && typeof plan.required_kata !== 'string') {
    return { ok: false, error: 'required_kata deve ser texto' };
  }
  if (plan.notes !== undefined && plan.notes !== null && typeof plan.notes !== 'string') {
    return { ok: false, error: 'notes deve ser texto' };
  }
  return { ok: true };
}

// ── Resolução: fase efetiva de uma rodada ───────────────────
// round: 0-based; totalRounds: nº de rodadas da árvore principal.
// isThird: disputa de 3º lugar (vale a fase final).
// Retorna a fase ({format, decision, duration_sec, time_mode, ...}) ou
// null (sem plano → formato legado da modalidade).
function resolvePhaseForRound(plan, round, totalRounds, isThird = false) {
  const phases = plan && Array.isArray(plan.phases) ? plan.phases : null;
  if (!phases || !phases.length) return null;

  const isFinalRound = isThird || round === totalRounds - 1;
  const finalPhase = phases.find((p) => p && p.final === true) || null;
  if (isFinalRound && finalPhase) return finalPhase;

  const participants = Math.pow(2, totalRounds - round);
  let best = null;
  for (const p of phases) {
    if (!p || p.final === true) continue;
    const cap = p.from_participants == null ? Infinity : Number(p.from_participants);
    if (participants <= cap) {
      const bestCap = best == null
        ? Infinity + 1 // força a primeira atribuição
        : (best.from_participants == null ? Infinity : Number(best.from_participants));
      if (best == null || cap < bestCap) best = p;
    }
  }
  // Rodada maior que todos os tetos (só fases com teto e participants
  // acima de todos): cai na fase SEM teto se houver; senão a de MAIOR teto.
  if (best == null) {
    best = phases.find((p) => p && !p.final && p.from_participants == null) || null;
    if (best == null) {
      best = phases
        .filter((p) => p && !p.final)
        .sort((a, b) => Number(b.from_participants || 0) - Number(a.from_participants || 0))[0] || null;
    }
  }
  return best;
}

// Mapa rodada → fase para uma árvore inteira (o que o GET do bracket e a
// súmula consomem). totalRounds >= 1.
function phaseByRound(plan, totalRounds) {
  const out = [];
  for (let r = 0; r < totalRounds; r++) {
    const phase = resolvePhaseForRound(plan, r, totalRounds, false);
    out.push(phase ? {
      round: r,
      format: phase.format,
      format_label: FORMAT_LABEL[phase.format] || phase.format,
      decision: phase.decision || null,
      duration_sec: phase.duration_sec != null ? phase.duration_sec : null,
      time_mode: phase.time_mode || null,
    } : { round: r, format: null, format_label: null, decision: null, duration_sec: null, time_mode: null });
  }
  return out;
}

// ── Validação do registro de decisão de UMA luta ────────────
function validateDecision(decision) {
  if (decision == null) return { ok: true };
  if (typeof decision !== 'object' || Array.isArray(decision)) {
    return { ok: false, error: 'decision deve ser um objeto' };
  }
  if (!DECISION_METHODS.includes(decision.method)) {
    return { ok: false, error: `decision.method inválido. Use: ${DECISION_METHODS.join(', ')}` };
  }
  for (const k of ['votes_aka', 'votes_shiro']) {
    if (decision[k] !== undefined && decision[k] !== null) {
      const v = Number(decision[k]);
      if (!Number.isInteger(v) || v < 0 || v > 5) {
        return { ok: false, error: `decision.${k} deve ser 0..5 (bandeiras dos 5 árbitros)` };
      }
    }
  }
  if (decision.note !== undefined && decision.note !== null && typeof decision.note !== 'string') {
    return { ok: false, error: 'decision.note deve ser texto' };
  }
  return { ok: true };
}

// Normaliza o registro para persistência (campos conhecidos, note limitada).
function normalizeDecision(decision) {
  if (decision == null) return null;
  const out = { method: decision.method };
  if (decision.votes_aka != null) out.votes_aka = Number(decision.votes_aka);
  if (decision.votes_shiro != null) out.votes_shiro = Number(decision.votes_shiro);
  if (decision.note != null && String(decision.note).trim() !== '') {
    out.note = String(decision.note).trim().slice(0, 500);
  }
  return out;
}

module.exports = {
  MATCH_FORMATS,
  DECISION_METHODS,
  TIME_MODES,
  FORMAT_LABEL,
  DECISION_LABEL,
  validatePhasePlan,
  resolvePhaseForRound,
  phaseByRound,
  validateDecision,
  normalizeDecision,
};
