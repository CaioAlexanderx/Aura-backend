// ============================================================
// AURA KARATÊ — Serviço de Exames (Track C)
// checkEligibility: verifica requisitos FPKT para um praticante
// se candidatar a uma faixa alvo.
//
// DECISÃO FPKT #1 — Elegibilidade é SEMPRE só AVISO:
//   - Nunca retorna erro bloqueante por critério
//   - is_hard_block sempre false
//   - checks[] descreve cada critério e se foi atendido
//
// DECISÃO FPKT #2 — Critérios provisórios:
//   - karate_belt_requirements.confirmed (bool) é exposto nos checks
// ============================================================
'use strict';

const db = require('../config/database');

/**
 * checkEligibility(student_id, target_belt, federation_id)
 * Retorna { eligible: bool, checks: Array<Check>, is_hard_block: false }
 *
 * Check = { criterion, ok, required, actual, confirmed }
 * Critérios verificados:
 *   - min_months: tempo desde última graduação (karate_current_belt.current_since)
 *   - min_courses: contagem de cursos/treinos concluídos
 *   - required_kata / required_kumite: flags no requirement row
 *
 * Elegibilidade é SOMENTE informativa — is_hard_block é sempre false.
 *
 * Schema real karate_belt_requirements:
 *   id, federation_id, from_belt, to_belt, belt_schema,
 *   min_months, required_kata (text[]), required_kumite,
 *   min_courses, notes, is_hard_block, is_active,
 *   confirmed, confirmed_at, created_at, updated_at
 *
 * Schema real karate_current_belt (view):
 *   student_id, federation_id, belt_level, belt_name,
 *   belt_schema, current_since, exam_id
 *   (NOT graduated_at — use current_since)
 */
async function checkEligibility(student_id, target_belt, federation_id) {
  // Busca requisitos para a faixa alvo na federação.
  // Uses to_belt (target belt level) and real schema columns.
  const reqRes = await db.query(
    `SELECT id, from_belt, to_belt, min_months, required_kata,
            required_kumite, min_courses, is_hard_block, confirmed
     FROM karate_belt_requirements
     WHERE federation_id = $1
       AND to_belt = $2
       AND is_active = true
     ORDER BY from_belt ASC`,
    [federation_id, target_belt]
  );
  const requirements = reqRes.rows;

  // Busca dados do praticante + faixa atual.
  // karate_current_belt view: current_since (not graduated_at)
  // customers: name (not full_name)
  const studentRes = await db.query(
    `SELECT
       cu.id,
       cu.name,
       cu.is_active,
       cb.belt_level AS current_belt_level,
       cb.belt_name  AS current_belt_name,
       cb.current_since
     FROM customers cu
     LEFT JOIN karate_current_belt cb
       ON cb.student_id = cu.id AND cb.federation_id = $2
     WHERE cu.id = $1 AND cu.federation_id = $2
     LIMIT 1`,
    [student_id, federation_id]
  );

  if (!studentRes.rows.length) {
    return {
      eligible: false,
      is_hard_block: false,
      student_found: false,
      checks: [],
      warnings: ['Praticante não encontrado na federação'],
    };
  }

  const student = studentRes.rows[0];

  // Calcula meses desde última graduação usando current_since (not graduated_at)
  let monthsInCurrentBelt = null;
  if (student.current_since) {
    const currentSince = new Date(student.current_since);
    const now = new Date();
    const diffMs = now - currentSince;
    monthsInCurrentBelt = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.44));
  }

  // Busca contagem de cursos/treinos concluídos
  // karate_event_enrollments: hours_completed (not workload_hours)
  const courseRes = await db.query(
    `SELECT COUNT(*) AS course_count
     FROM karate_event_enrollments ee
     JOIN karate_events ev ON ev.id = ee.event_id
     WHERE ee.student_id = $1
       AND ev.federation_id = $2
       AND ev.event_type IN ('course', 'seminar', 'training')
       AND ee.status = 'present'`,
    [student_id, federation_id]
  );
  const courseCount = parseInt(courseRes.rows[0]?.course_count || 0, 10);

  // Avalia cada requisito (one row per from_belt→to_belt pair in real schema)
  const checks = [];

  for (const req of requirements) {
    const confirmed = req.confirmed;

    // Check min_months (karate_current_belt.current_since)
    if (req.min_months !== null && req.min_months !== undefined) {
      const required = parseInt(req.min_months, 10);
      const actual = monthsInCurrentBelt;
      const ok = actual !== null && actual >= required;
      checks.push({
        criterion: 'min_months',
        ok,
        required,
        actual,
        unit: 'meses',
        confirmed,
      });
    }

    // Check min_courses
    if (req.min_courses !== null && req.min_courses !== undefined) {
      const required = parseInt(req.min_courses, 10);
      const actual = courseCount;
      const ok = actual >= required;
      checks.push({
        criterion: 'min_courses',
        ok,
        required,
        actual,
        unit: 'cursos',
        confirmed,
      });
    }

    // Check required_kata (text[] — non-empty means kata requirement exists)
    if (req.required_kata && req.required_kata.length > 0) {
      // Best-effort: we note the requirement; actual validation requires instructor
      checks.push({
        criterion: 'required_kata',
        ok: true, // informational only — not blockable per FPKT #1
        required: req.required_kata,
        actual: null,
        unit: null,
        confirmed,
      });
    }

    // Check required_kumite
    if (req.required_kumite !== null && req.required_kumite !== undefined) {
      checks.push({
        criterion: 'required_kumite',
        ok: true, // informational only — not blockable per FPKT #1
        required: req.required_kumite,
        actual: null,
        unit: null,
        confirmed,
      });
    }
  }

  const allOk = checks.length === 0 || checks.every(c => c.ok);

  return {
    student_id,
    student_name: student.name,
    current_belt_level: student.current_belt_level || null,
    current_belt_name: student.current_belt_name || null,
    target_belt,
    eligible: allOk,
    is_hard_block: false, // FPKT #1: NUNCA bloqueia
    checks,
    warnings: checks
      .filter(c => !c.ok)
      .map(c => `Critério "${c.criterion}" não atendido: esperado ${c.required}${c.unit ? ' ' + c.unit : ''}, atual ${c.actual ?? 'N/D'}${!c.confirmed ? ' (critério provisório)' : ''}`),
  };
}

module.exports = { checkEligibility };
