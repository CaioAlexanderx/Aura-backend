// ============================================================
// AURA KARATÊ — P1 Hub: ESTIMATIVA DE CARGA do dia (serviço PURO)
//
// Reproduz em código a conta que a federação fazia à mão na planilha de
// distribuição de kotos: "Koto A — (3,5H) 58 atletas". Sem DB — a rota
// passa as categorias com entry_count e recebe minutos estimados por
// categoria/koto.
//
// CALIBRAGEM (documentos reais, Dossiê Shiai §6):
//   Os kotos do XXV Paulista JKA fecharam em ~3,5h para 52-59 atletas
//   → ~3,6 min/atleta na média de um mix kata+kumite. As heurísticas por
//   modalidade abaixo reproduzem essa média:
//     • kata (bateria de notas): ~2,5 min/atleta por fase — eliminatória
//       + final ≈ 3,5 min/atleta efetivos no total do dia;
//     • kumite e variantes 1×1: numa eliminatória simples há (N-1) lutas
//       (+1 com disputa de 3º) — minutos POR LUTA variam com o formato
//       (Kihon/Sanbon anunciados são mais curtos que Shobu-Ippon com
//       kettei-sen);
//     • equipes: por EQUIPE (o roster inteiro se apresenta/luta).
//   É estimativa de planejamento, não cronômetro — o rótulo da UI deve
//   dizer "~".
// ============================================================
'use strict';

// Minutos por LUTA nas modalidades 1×1 (inclui chamada + decisão).
const MINUTES_PER_MATCH = Object.freeze({
  kumite: 3.5,        // shobu-ippon com possíveis prorrogações
  kihon_ippon: 2.5,   // sequências anunciadas, 1 min por atacante
  team_kumite: 10,    // 3 lutas + extras
  kata_hantei: 4,     // dois katas apresentados por confronto
});

// Minutos por ATLETA/EQUIPE nas provas por apresentação (notas).
const MINUTES_PER_PRESENTATION = Object.freeze({
  kata: 3.5,          // eliminatória + final (média por atleta no dia)
  team_kata: 6,       // trio + (adulto) bunkai na final
});

// Nº de lutas de uma eliminatória simples com N participantes.
function matchesForEntries(n) {
  const x = Math.max(0, Number(n) || 0);
  return x < 2 ? 0 : x - 1;
}

/**
 * estimateCategoryMinutes({ modality, entry_count, kata_mode? }) → int
 * kata_mode='hantei_tree' faz kata contar como chave 1×1 (kata_hantei).
 */
function estimateCategoryMinutes({ modality, entry_count, kata_mode }) {
  const n = Math.max(0, Number(entry_count) || 0);
  if (n === 0) return 0;

  const isKata = modality === 'kata' || modality === 'team_kata';
  if (isKata && kata_mode !== 'hantei_tree') {
    const per = MINUTES_PER_PRESENTATION[modality] || MINUTES_PER_PRESENTATION.kata;
    return Math.round(n * per);
  }

  let perMatch;
  if (isKata) perMatch = MINUTES_PER_MATCH.kata_hantei;
  else if (modality === 'team_kumite') perMatch = MINUTES_PER_MATCH.team_kumite;
  else if (modality === 'kihon_ippon') perMatch = MINUTES_PER_MATCH.kihon_ippon;
  else perMatch = MINUTES_PER_MATCH.kumite;

  return Math.round(matchesForEntries(n) * perMatch);
}

/**
 * summarizeArea(categories) → { entry_count, est_minutes, est_label }
 * categories: [{ modality, entry_count, kata_mode? }]
 */
function summarizeArea(categories) {
  const list = Array.isArray(categories) ? categories : [];
  const entryCount = list.reduce((s, c) => s + (Number(c.entry_count) || 0), 0);
  const minutes = list.reduce((s, c) => s + estimateCategoryMinutes(c), 0);
  return {
    entry_count: entryCount,
    est_minutes: minutes,
    est_label: formatMinutes(minutes),
  };
}

// 210 → "~3,5h" (o formato da planilha real, com o ~ de estimativa).
function formatMinutes(min) {
  const m = Math.max(0, Number(min) || 0);
  if (m === 0) return '—';
  if (m < 60) return `~${m}min`;
  const hours = m / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `~${String(rounded).replace('.', ',')}h`;
}

module.exports = {
  MINUTES_PER_MATCH,
  MINUTES_PER_PRESENTATION,
  matchesForEntries,
  estimateCategoryMinutes,
  summarizeArea,
  formatMinutes,
};
