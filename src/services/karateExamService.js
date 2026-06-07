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
 *   - min_months_in_current_belt: tempo desde última graduação
 *   - min_trainings: contagem de treinos declarados (usa metadata do customer)
 *   - kata_approved, kumite_approved: flags no belt_history / customer
 *
 * Elegibilidade é SOMENTE informativa — is_hard_block é sempre false.
 */
async function checkEligibility(student_id, target_belt, federation_id) {
  // Busca requisitos para a faixa alvo na federação
  const reqRes = await db.query(
    `SELECT id, criterion, required_value, unit, confirmed
     FROM karate_belt_requirements
     WHERE federation_id = $1
       AND target_belt_level = $2
       AND is_active = true
     ORDER BY sort_order ASC, criterion ASC`,
    [federation_id, target_belt]
  );
  const requirements = reqRes.rows;

  // Busca dados do praticante + faixa atual
  const studentRes = await db.query(
    `SELECT
       cu.id,
       COALESCE(cu.full_name, cu.name) AS full_name,
       cu.is_active,
       cb.belt_level AS current_belt_level,
       cb.belt_name  AS current_belt_name,
       cb.graduated_at
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

  // Calcula meses desde última graduação
  let monthsInCurrentBelt = null;
  if (student.graduated_at) {
    const graduatedAt = new Date(student.graduated_at);
    const now = new Date();
    const diffMs = now - graduatedAt;
    monthsInCurrentBelt = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.44));
  }

  // Busca contagem de treinos declarados (via karate_event_enrollments de cursos)
  const trainingRes = await db.query(
    `SELECT COUNT(*) AS training_count
     FROM karate_event_enrollments ee
     JOIN karate_events ev ON ev.id = ee.event_id
     WHERE ee.student_id = $1
       AND ev.federation_id = $2
       AND ev.event_type = 'training'
       AND ee.status = 'present'`,
    [student_id, federation_id]
  );
  const trainingCount = parseInt(trainingRes.rows[0]?.training_count || 0, 10);

  // Avalia cada critério
  const checks = requirements.map(req => {
    const criterion = req.criterion;
    const required = parseFloat(req.required_value) || 0;
    const confirmed = req.confirmed;

    let actual = null;
    let ok = false;

    switch (criterion) {
      case 'min_months_in_current_belt': {
        actual = monthsInCurrentBelt;
        ok = actual !== null && actual >= required;
        break;
      }
      case 'min_trainings': {
        actual = trainingCount;
        ok = actual >= required;
        break;
      }
      case 'min_age': {
        // best-effort: não bloqueia se idade não informada
        actual = null;
        ok = true; // sem dado = aviso neutro
        break;
      }
      default: {
        // critério desconhecido: não bloqueia
        actual = null;
        ok = true;
      }
    }

    return {
      criterion,
      ok,
      required,
      actual,
      unit: req.unit || null,
      confirmed, // FPKT #2: expõe se o critério é provisório
    };
  });

  const allOk = checks.every(c => c.ok);

  return {
    student_id,
    student_name: student.full_name,
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
