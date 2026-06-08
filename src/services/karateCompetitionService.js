// ============================================================
// AURA KARATÊ — Serviço de Competições (Track E)
//
// checkCategoryFit: verifica se um praticante "cabe" numa categoria
// (faixa etária, faixa de graduação, sexo). Segue a filosofia FPKT:
//   - SEMPRE só AVISO (is_hard_block: false) — nunca bloqueia a inscrição.
//   - checks[] descreve cada critério avaliado.
// Igual ao padrão do Track C (karateExamService.checkEligibility).
//
// computeAge: idade do praticante numa data de referência (evento).
//
// BELT_ORDER: ordena as faixas para comparar belt_min/belt_max.
// Usa o enum fpkt_shotokan (10kyu→8dan); valores legacy raros são
// tolerados (ficam fora da régua → check vira informativo).
// ============================================================
'use strict';

// Índice MAIOR = mais graduado (10kyu=0 ... 8dan=17). belt_min/belt_max são
// limites inclusivos da faixa de graduação aceita na categoria.
const BELT_ORDER = [
  '10kyu', '9kyu', '8kyu', '7kyu', '6kyu', '5kyu', '4kyu', '3kyu', '2kyu', '1kyu',
  '1dan', '2dan', '3dan', '4dan', '5dan', '6dan', '7dan', '8dan',
];

function beltRank(belt) {
  if (!belt) return null;
  const idx = BELT_ORDER.indexOf(String(belt).toLowerCase().trim());
  return idx === -1 ? null : idx;
}

// Idade completa em anos numa data de referência (string/Date).
function computeAge(birthDate, refDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  const r = refDate ? new Date(refDate) : new Date();
  if (isNaN(b.getTime()) || isNaN(r.getTime())) return null;
  let age = r.getFullYear() - b.getFullYear();
  const m = r.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && r.getDate() < b.getDate())) age--;
  return age;
}

/**
 * checkCategoryFit({ student, category, refDate })
 *   student  = { birth_date, gender, belt_level }
 *   category = { min_age, max_age, belt_min, belt_max, sex }
 * Retorna { fits, is_hard_block:false, checks[], warnings[] }.
 * is_hard_block é SEMPRE false — categoria incompatível é só aviso.
 */
function checkCategoryFit({ student, category, refDate }) {
  const checks = [];
  student = student || {};
  category = category || {};

  // ── Idade ──
  if (category.min_age != null || category.max_age != null) {
    const age = computeAge(student.birth_date, refDate);
    let ok = true;
    if (age == null) ok = true; // sem nascimento → informativo, não bloqueia
    else {
      if (category.min_age != null && age < category.min_age) ok = false;
      if (category.max_age != null && age > category.max_age) ok = false;
    }
    checks.push({
      criterion: 'age',
      ok,
      required: { min: category.min_age != null ? category.min_age : null, max: category.max_age != null ? category.max_age : null },
      actual: age,
      unit: 'anos',
    });
  }

  // ── Faixa (graduação) ──
  if (category.belt_min || category.belt_max) {
    const rank = beltRank(student.belt_level);
    const minR = beltRank(category.belt_min);
    const maxR = beltRank(category.belt_max);
    let ok = true;
    if (rank == null) ok = true; // faixa desconhecida/legacy → informativo
    else {
      if (minR != null && rank < minR) ok = false;
      if (maxR != null && rank > maxR) ok = false;
    }
    checks.push({
      criterion: 'belt',
      ok,
      required: { min: category.belt_min || null, max: category.belt_max || null },
      actual: student.belt_level || null,
      unit: null,
    });
  }

  // ── Sexo ──
  if (category.sex && category.sex !== 'mixed') {
    const g = String(student.gender || '').toUpperCase().trim();
    const norm = g.startsWith('M') ? 'M' : g.startsWith('F') ? 'F' : null;
    const ok = norm == null ? true : norm === category.sex; // sem gênero → informativo
    checks.push({
      criterion: 'sex',
      ok,
      required: category.sex,
      actual: student.gender || null,
      unit: null,
    });
  }

  const fits = checks.length === 0 || checks.every((c) => c.ok);
  const labels = { age: 'faixa etária', belt: 'graduação', sex: 'sexo' };
  const warnings = checks
    .filter((c) => !c.ok)
    .map((c) => `Categoria pode não corresponder ao critério de ${labels[c.criterion] || c.criterion} do atleta.`);

  return { fits, is_hard_block: false, checks, warnings };
}

module.exports = { checkCategoryFit, computeAge, beltRank, BELT_ORDER };
