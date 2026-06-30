// ============================================================
// AURA KARATÊ — Rotas de Exames de Faixa (Track C)
//
// Exames CRUD:
//   GET  /belt-exams                          — lista (staffWrite ou read)
//   POST /belt-exams                          — cria exame
//   GET  /belt-exams/:examId                  — detalhe (banca + candidatos)
//   PATCH /belt-exams/:examId                 — edita exame
//
// Banca:
//   GET  /belt-exams/:examId/examiners        — lista banca
//   POST /belt-exams/:examId/examiners        — adiciona examinador
//
// Candidatos (inscrição e resultado):
//   POST /belt-exams/:examId/candidates       — inscreve candidato
//                                               SEMPRE 201 + eligibility (FPKT #1)
//                                               target_belt OPCIONAL p/ exam_type='curso'
//   PATCH /belt-exams/:examId/candidates/:cId — lança resultado
//                                               approved→ trigger karate_on_exam_approved
//                                               RBAC: guards.examResults
//
// Fechamento:
//   POST /belt-exams/:examId/close            — fecha exame (status→done)
//                                               NÃO emite certificados (FPKT #3)
//
// Elegibilidade avulsa:
//   GET  /practitioners/:practitionerId/eligibility/:targetBelt
//
// Estorno/correção:
//   POST /belt-exams/:examId/candidates/:cId/correction
//     — registro compensatório (karate_belt_history é imutável)
//
// NOTA DE COMPAT (22/06): o frontend lê exam.title/exam.exam_date, mas o schema
// usa name/event_date. Todas as respostas abaixo expõem aliases title/exam_date
// além dos campos canônicos name/event_date — additive, sem migration.
//
// TIPOS DE EVENTO (25/06): exam_type aceita os graus específicos usados pelos
// dojôs (kyu_regional | dan_estadual | dan_nacional) MAIS os tipos AMPLOS da
// federação (exame | curso). Tipos amplos NÃO inferem faixa-alvo: o grau (se
// houver) vem do payload por candidato (target_belt na inscrição), nunca do
// exam_type. 'curso' é evento sem graduação. Ver migration 192.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { checkEligibility } = require('../services/karateExamService');

// Tipos de evento aceitos em karate_belt_exams.exam_type (espelha o CHECK da
// migration 192). Graus específicos (dojô) + tipos amplos (federação).
// NÃO derivamos faixa-alvo a partir do tipo: a graduação vem do payload por
// candidato (target_belt). 'curso' é evento sem graduação.
const VALID_EXAM_TYPES = ['kyu_regional', 'dan_estadual', 'dan_nacional', 'exame', 'curso'];

// Migration 200 — registration_fields (karate_belt_exams) / registration_responses
// (karate_belt_exam_candidates). Backend sobe antes da migration ser aplicada
// (armadilha_schema_pre_migration do CLAUDE.md): cache module-level otimista,
// vira false em 42703 e os SELECTs/INSERTs caem para a forma sem a coluna.
let HAS_REGISTRATION_FIELDS_COL = true;

// Bloco C — cache module-level otimista p/ certificate_eligible no GET de
// detalhe (migration 202). Mesmo padrao: comeca true, vira false em 42703.
let HAS_CERTIFICATE_ELIGIBLE_COL_DETAIL = true;

const VALID_FIELD_TYPES = ['text', 'number', 'select', 'checkbox', 'date', 'phone'];

/**
 * Valida o formato de registration_fields recebido no PATCH do exame.
 * Retorna { ok: true } ou { ok: false, error } com mensagem pronta pro 422.
 * Formato esperado: array de { key, label, type, required, options? }.
 */
function validateRegistrationFields(fields) {
  if (!Array.isArray(fields)) {
    return { ok: false, error: 'registration_fields deve ser um array' };
  }
  const seenKeys = new Set();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      return { ok: false, error: `registration_fields[${i}] deve ser um objeto` };
    }
    if (typeof f.key !== 'string' || !f.key.trim()) {
      return { ok: false, error: `registration_fields[${i}].key é obrigatório (string)` };
    }
    if (seenKeys.has(f.key)) {
      return { ok: false, error: `registration_fields[${i}].key duplicada: "${f.key}"` };
    }
    seenKeys.add(f.key);
    if (typeof f.label !== 'string' || !f.label.trim()) {
      return { ok: false, error: `registration_fields[${i}].label é obrigatório (string)` };
    }
    if (typeof f.type !== 'string' || !VALID_FIELD_TYPES.includes(f.type)) {
      return { ok: false, error: `registration_fields[${i}].type inválido. Use: ${VALID_FIELD_TYPES.join(', ')}` };
    }
    if (f.required !== undefined && typeof f.required !== 'boolean') {
      return { ok: false, error: `registration_fields[${i}].required deve ser boolean` };
    }
    if (f.type === 'select') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        return { ok: false, error: `registration_fields[${i}].options é obrigatório (array) quando type='select'` };
      }
      for (const opt of f.options) {
        const isStr = typeof opt === 'string';
        const isObj = opt && typeof opt === 'object' && !Array.isArray(opt) && typeof opt.value === 'string';
        if (!isStr && !isObj) {
          return { ok: false, error: `registration_fields[${i}].options deve conter strings ou objetos {value,label}` };
        }
      }
    }
  }
  return { ok: true };
}


// ── GET /belt-exams ─────────────────────────────────────────
router.get('/belt-exams', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { status, year } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;

  try {
    const conditions = ['be.federation_id = $1'];
    const params = [federationId];
    let n = 2;

    if (status) {
      conditions.push(`be.status = $${n}`);
      params.push(status);
      n++;
    }
    if (year) {
      // karate_belt_exams uses event_date (not exam_date)
      conditions.push(`EXTRACT(YEAR FROM be.event_date) = $${n}`);
      params.push(parseInt(year, 10));
      n++;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM karate_belt_exams be ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    const dataRes = await db.query(
      `SELECT
         be.id, be.federation_id, be.name, be.exam_type, be.event_date, be.location,
         be.max_candidates, be.fee_amount, be.status, be.created_at,
         COUNT(DISTINCT ec.id) AS candidate_count,
         COUNT(DISTINCT ee.id) AS examiner_count
       FROM karate_belt_exams be
       LEFT JOIN karate_belt_exam_candidates ec ON ec.exam_id = be.id
       LEFT JOIN karate_exam_examiners ee ON ee.exam_id = be.id
       ${where}
       GROUP BY be.id
       ORDER BY be.event_date DESC
       LIMIT $${n} OFFSET $${n + 1}`,
      [...params, pageSize, offset]
    );

    const data = dataRes.rows.map(r => ({
      id: r.id,
      federation_id: r.federation_id,
      name: r.name || null,
      title: r.name || null,            // alias compat front
      exam_type: r.exam_type || null,
      event_date: r.event_date,
      exam_date: r.event_date,          // alias compat front
      location: r.location || null,
      max_candidates: r.max_candidates || null,
      fee_amount: r.fee_amount || null,
      status: r.status,
      candidate_count: parseInt(r.candidate_count, 10),
      examiner_count: parseInt(r.examiner_count, 10),
      created_at: r.created_at,
    }));

    res.json({ page, page_size: pageSize, total, data });
  } catch (err) {
    console.error('[karateExams] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar exames' });
  }
});

// ── POST /belt-exams ────────────────────────────────────────
router.post('/belt-exams', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  // karate_belt_exams: id, federation_id, exam_type, name, event_date, location,
  //                    max_candidates, fee_amount, status, created_by, created_at, updated_at
  const { exam_type, name, event_date, location, max_candidates, fee_amount } = req.body;

  if (!event_date) {
    return res.status(422).json({ error: 'event_date é obrigatório', code: 'VALIDATION_ERROR' });
  }

  // Whitelist de exam_type (espelha o CHECK da migration 192). Tipo é OPCIONAL —
  // null é aceito (evento amplo sem classificação). Quando informado, deve ser um
  // dos valores válidos; caso contrário 422 limpo (em vez de 500 da constraint).
  // NÃO inferimos faixa-alvo do tipo: para 'exame'/'curso' (amplos) a graduação,
  // se houver, vem do payload por candidato (target_belt na inscrição). 'curso'
  // é evento sem graduação.
  if (exam_type !== undefined && exam_type !== null && !VALID_EXAM_TYPES.includes(exam_type)) {
    return res.status(422).json({
      error: `exam_type inválido. Use: ${VALID_EXAM_TYPES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  try {
    const insertRes = await db.query(
      `INSERT INTO karate_belt_exams
         (federation_id, exam_type, name, event_date, location, max_candidates, fee_amount,
          status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, NOW(), NOW())
       RETURNING id, federation_id, exam_type, name, event_date, location,
                 max_candidates, fee_amount, status, created_at`,
      [
        federationId,
        exam_type || null,
        name || null,
        event_date,
        location || null,
        max_candidates ? parseInt(max_candidates, 10) : null,
        fee_amount ? parseFloat(fee_amount) : null,
        req.user?.id || null,
      ]
    );

    const exam = insertRes.rows[0];
    res.status(201).json({
      id: exam.id,
      federation_id: exam.federation_id,
      exam_type: exam.exam_type || null,
      name: exam.name || null,
      title: exam.name || null,          // alias compat front
      event_date: exam.event_date,
      exam_date: exam.event_date,        // alias compat front
      location: exam.location || null,
      max_candidates: exam.max_candidates || null,
      fee_amount: exam.fee_amount || null,
      status: exam.status,
      candidate_count: 0,
      examiner_count: 0,
      created_at: exam.created_at,
    });
  } catch (err) {
    console.error('[karateExams] create error:', err.message);
    // Mensagem de erro deve refletir a entidade certa: este endpoint cria tanto
    // 'exame' quanto 'curso' (evento amplo) — usa exam_type pra acertar a palavra
    // em vez de sempre dizer "exame" mesmo quando o usuario estava criando um curso.
    const entityLabel = exam_type === 'curso' ? 'curso' : 'exame';
    res.status(500).json({ error: `Erro ao criar ${entityLabel}`, detail: err.message });
  }
});

// ── GET /belt-exams/:examId ─────────────────────────────────
router.get('/belt-exams/:examId', ...guards.read(), async (req, res) => {
  const { id: federationId, examId } = req.params;

  try {
    let exam;
    if (HAS_REGISTRATION_FIELDS_COL) {
      try {
        const examRes = await db.query(
          `SELECT id, federation_id, exam_type, name, event_date, location,
                  max_candidates, fee_amount, status, registration_fields,
                  created_at, updated_at
           FROM karate_belt_exams
           WHERE id = $1 AND federation_id = $2
           LIMIT 1`,
          [examId, federationId]
        );
        exam = examRes.rows[0];
      } catch (e) {
        if (e.code === '42703') {
          HAS_REGISTRATION_FIELDS_COL = false;
          console.warn('[karateExams] registration_fields ausente (migration 200 pendente)');
        } else throw e;
      }
    }
    if (exam === undefined) {
      const examRes = await db.query(
        `SELECT id, federation_id, exam_type, name, event_date, location,
                max_candidates, fee_amount, status, created_at, updated_at
         FROM karate_belt_exams
         WHERE id = $1 AND federation_id = $2
         LIMIT 1`,
        [examId, federationId]
      );
      exam = examRes.rows[0];
    }

    if (!exam) {
      return res.status(404).json({ error: 'Exame não encontrado', code: 'NOT_FOUND' });
    }

    // Banca — karate_exam_examiners: id, exam_id, examiner_id, role, dan_level, confirmed, created_at
    const examinerRes = await db.query(
      `SELECT ee.id, ee.examiner_id AS student_id, ee.role, ee.dan_level, ee.confirmed,
              cu.name,
              cu.karate_registration_number
       FROM karate_exam_examiners ee
       JOIN customers cu ON cu.id = ee.examiner_id
       WHERE ee.exam_id = $1`,
      [examId]
    );

    // Candidatos — karate_belt_exam_candidates: id, exam_id, student_id, current_belt,
    //   target_belt, target_belt_name, belt_schema, status, result_notes, fee_paid,
    //   registration_responses (migration 200), created_at, updated_at
    let candidateRows;
    if (HAS_REGISTRATION_FIELDS_COL) {
      try {
        const certEligibleSelect = HAS_CERTIFICATE_ELIGIBLE_COL_DETAIL
          ? 'ec.certificate_eligible,' : '';
        const candidateRes = await db.query(
          `SELECT ec.id, ec.student_id, ec.target_belt, ec.target_belt_name,
                  ec.current_belt, ec.status, ec.result_notes, ec.registration_responses,
                  ${certEligibleSelect}
                  ec.created_at,
                  cu.name AS student_name,
                  cu.karate_registration_number,
                  cb.belt_level AS current_belt_level,
                  cb.belt_name  AS current_belt_name
           FROM karate_belt_exam_candidates ec
           JOIN customers cu ON cu.id = ec.student_id
           LEFT JOIN karate_current_belt cb
             ON cb.student_id = ec.student_id AND cb.federation_id = $2
           WHERE ec.exam_id = $1
           ORDER BY ec.created_at ASC`,
          [examId, federationId]
        );
        candidateRows = candidateRes.rows;
      } catch (e) {
        if (e.code === '42703') {
          if (HAS_CERTIFICATE_ELIGIBLE_COL_DETAIL) {
            // Pode ser certificate_eligible (migration 202) ou
            // registration_responses (migration 200) que falta — tenta de
            // novo só sem certificate_eligible antes de desistir de tudo.
            HAS_CERTIFICATE_ELIGIBLE_COL_DETAIL = false;
            try {
              const retryRes = await db.query(
                `SELECT ec.id, ec.student_id, ec.target_belt, ec.target_belt_name,
                        ec.current_belt, ec.status, ec.result_notes, ec.registration_responses,
                        ec.created_at,
                        cu.name AS student_name,
                        cu.karate_registration_number,
                        cb.belt_level AS current_belt_level,
                        cb.belt_name  AS current_belt_name
                 FROM karate_belt_exam_candidates ec
                 JOIN customers cu ON cu.id = ec.student_id
                 LEFT JOIN karate_current_belt cb
                   ON cb.student_id = ec.student_id AND cb.federation_id = $2
                 WHERE ec.exam_id = $1
                 ORDER BY ec.created_at ASC`,
                [examId, federationId]
              );
              candidateRows = retryRes.rows;
            } catch (e2) {
              if (e2.code === '42703') {
                HAS_REGISTRATION_FIELDS_COL = false;
                console.warn('[karateExams] registration_responses ausente (migration 200 pendente)');
              } else throw e2;
            }
          } else {
            HAS_REGISTRATION_FIELDS_COL = false;
            console.warn('[karateExams] registration_responses ausente (migration 200 pendente)');
          }
        } else throw e;
      }
    }
    if (candidateRows === undefined) {
      const candidateRes = await db.query(
        `SELECT ec.id, ec.student_id, ec.target_belt, ec.target_belt_name,
                ec.current_belt, ec.status, ec.result_notes, ec.created_at,
                cu.name AS student_name,
                cu.karate_registration_number,
                cb.belt_level AS current_belt_level,
                cb.belt_name  AS current_belt_name
         FROM karate_belt_exam_candidates ec
         JOIN customers cu ON cu.id = ec.student_id
         LEFT JOIN karate_current_belt cb
           ON cb.student_id = ec.student_id AND cb.federation_id = $2
         WHERE ec.exam_id = $1
         ORDER BY ec.created_at ASC`,
        [examId, federationId]
      );
      candidateRows = candidateRes.rows;
    }

    res.json({
      id: exam.id,
      federation_id: exam.federation_id,
      exam_type: exam.exam_type || null,
      name: exam.name || null,
      title: exam.name || null,          // alias compat front
      event_date: exam.event_date,
      exam_date: exam.event_date,        // alias compat front
      location: exam.location || null,
      max_candidates: exam.max_candidates || null,
      fee_amount: exam.fee_amount || null,
      status: exam.status,
      registration_fields: exam.registration_fields || [],
      created_at: exam.created_at,
      updated_at: exam.updated_at,
      examiners: examinerRes.rows.map(e => ({
        id: e.id,
        student_id: e.student_id,
        name: e.name,
        karate_registration_number: e.karate_registration_number || null,
        role: e.role || null,
        dan_level: e.dan_level || null,
        confirmed: e.confirmed,
      })),
      candidates: candidateRows.map(c => ({
        id: c.id,
        student_id: c.student_id,
        student_name: c.student_name,
        karate_registration_number: c.karate_registration_number || null,
        current_belt_level: c.current_belt_level || null,
        current_belt_name: c.current_belt_name || null,
        target_belt: c.target_belt,
        target_belt_name: c.target_belt_name || null,
        status: c.status,
        result_notes: c.result_notes || null,
        registration_responses: c.registration_responses || {},
        // Bloco C — elegibilidade a certificado (migration 202). undefined
        // quando a coluna ainda nao existe vira false (nunca undefined no
        // payload, pra nao confundir o front com "indeterminado").
        certificate_eligible: c.certificate_eligible === true,
        created_at: c.created_at,
      })),
    });
  } catch (err) {
    console.error('[karateExams] detail error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar exame' });
  }
});

// ── PATCH /belt-exams/:examId ───────────────────────────────
router.patch('/belt-exams/:examId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, examId } = req.params;

  // karate_belt_exams editable columns: event_date, location, name, exam_type,
  //   max_candidates, fee_amount (dojo_id and notes do NOT exist)
  const ALLOWED = ['event_date', 'location', 'name', 'exam_type', 'max_candidates', 'fee_amount'];

  // Whitelist de exam_type quando presente (espelha migration 192 / POST).
  if (req.body.exam_type !== undefined && req.body.exam_type !== null
      && !VALID_EXAM_TYPES.includes(req.body.exam_type)) {
    return res.status(422).json({
      error: `exam_type inválido. Use: ${VALID_EXAM_TYPES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  // registration_fields (migration 200) — array de { key, label, type, required, options? }.
  // Validação de formato ANTES de tocar o banco; 422 limpo se inválido.
  const hasRegistrationFields = req.body.registration_fields !== undefined;
  if (hasRegistrationFields) {
    const check = validateRegistrationFields(req.body.registration_fields);
    if (!check.ok) {
      return res.status(422).json({ error: check.error, code: 'VALIDATION_ERROR' });
    }
  }

  const updates = [];
  const values = [];
  let idx = 1;

  for (const field of ALLOWED) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${idx}`);
      values.push(req.body[field]);
      idx++;
    }
  }

  // Permitir atualizar status apenas para valores válidos não-terminais
  if (req.body.status !== undefined) {
    const VALID_STATUS = ['draft', 'open', 'closed'];
    if (!VALID_STATUS.includes(req.body.status)) {
      return res.status(422).json({
        error: `status inválido. Use: ${VALID_STATUS.join(', ')}. Para fechar use POST /close`,
        code: 'VALIDATION_ERROR',
      });
    }
    updates.push(`status = $${idx}`);
    values.push(req.body.status);
    idx++;
  }

  // registration_fields entra no SET só se a coluna existir (cache otimista —
  // vira false em 42703 e a tentativa abaixo cai pro UPDATE sem a coluna).
  let registrationFieldsIdx = null;
  if (hasRegistrationFields && HAS_REGISTRATION_FIELDS_COL) {
    registrationFieldsIdx = idx;
    updates.push(`registration_fields = $${idx}::jsonb`);
    values.push(JSON.stringify(req.body.registration_fields));
    idx++;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  updates.push('updated_at = NOW()');
  values.push(examId, federationId);

  try {
    let result;
    try {
      result = await db.query(
        `UPDATE karate_belt_exams
         SET ${updates.join(', ')}
         WHERE id = $${idx} AND federation_id = $${idx + 1}
         RETURNING id, federation_id, exam_type, name, event_date, location,
                   max_candidates, fee_amount, status,
                   ${HAS_REGISTRATION_FIELDS_COL ? 'registration_fields,' : ''} updated_at`,
        values
      );
    } catch (e) {
      if (e.code === '42703' && registrationFieldsIdx !== null) {
        // Coluna ainda não existe (migration 200 pendente) — refaz sem ela.
        HAS_REGISTRATION_FIELDS_COL = false;
        console.warn('[karateExams] registration_fields ausente no PATCH (migration 200 pendente)');
        // Remonta updates/values sem o campo registration_fields.
        const updates3 = [];
        const values3 = [];
        let idx3 = 1;
        for (const field of ALLOWED) {
          if (req.body[field] !== undefined) {
            updates3.push(`${field} = $${idx3}`);
            values3.push(req.body[field]);
            idx3++;
          }
        }
        if (req.body.status !== undefined) {
          updates3.push(`status = $${idx3}`);
          values3.push(req.body.status);
          idx3++;
        }
        updates3.push('updated_at = NOW()');
        values3.push(examId, federationId);
        result = await db.query(
          `UPDATE karate_belt_exams
           SET ${updates3.join(', ')}
           WHERE id = $${idx3} AND federation_id = $${idx3 + 1}
           RETURNING id, federation_id, exam_type, name, event_date, location,
                     max_candidates, fee_amount, status, updated_at`,
          values3
        );
      } else {
        throw e;
      }
    }

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Exame não encontrado', code: 'NOT_FOUND' });
    }

    const exam = result.rows[0];
    res.json({
      id: exam.id,
      federation_id: exam.federation_id,
      exam_type: exam.exam_type || null,
      name: exam.name || null,
      title: exam.name || null,          // alias compat front
      event_date: exam.event_date,
      exam_date: exam.event_date,        // alias compat front
      location: exam.location || null,
      max_candidates: exam.max_candidates || null,
      fee_amount: exam.fee_amount || null,
      status: exam.status,
      registration_fields: exam.registration_fields !== undefined ? (exam.registration_fields || []) : undefined,
      updated_at: exam.updated_at,
    });
  } catch (err) {
    console.error('[karateExams] patch error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar exame' });
  }
});

// ── GET /belt-exams/:examId/examiners ──────────────────────
router.get('/belt-exams/:examId/examiners', ...guards.read(), async (req, res) => {
  const { id: federationId, examId } = req.params;

  try {
    // Verifica exame pertence à federação
    const examCheck = await db.query(
      `SELECT id FROM karate_belt_exams WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [examId, federationId]
    );
    if (!examCheck.rows.length) {
      return res.status(404).json({ error: 'Exame não encontrado', code: 'NOT_FOUND' });
    }

    // karate_exam_examiners: id, exam_id, examiner_id, role, dan_level, confirmed, created_at
    const { rows } = await db.query(
      `SELECT ee.id, ee.examiner_id AS student_id, ee.role, ee.dan_level,
              ee.confirmed, ee.created_at,
              cu.name,
              cu.karate_registration_number
       FROM karate_exam_examiners ee
       JOIN customers cu ON cu.id = ee.examiner_id
       WHERE ee.exam_id = $1
       ORDER BY ee.created_at ASC`,
      [examId]
    );

    res.json(rows.map(e => ({
      id: e.id,
      student_id: e.student_id,
      name: e.name,
      karate_registration_number: e.karate_registration_number || null,
      role: e.role || null,
      dan_level: e.dan_level || null,
      confirmed: e.confirmed,
      created_at: e.created_at,
    })));
  } catch (err) {
    console.error('[karateExams] examiners list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar banca' });
  }
});

// ── POST /belt-exams/:examId/examiners ─────────────────────
router.post('/belt-exams/:examId/examiners', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, examId } = req.params;
  const { student_id, role } = req.body;

  if (!student_id) {
    return res.status(422).json({ error: 'student_id é obrigatório', code: 'VALIDATION_ERROR' });
  }

  try {
    // Verifica exame
    const examCheck = await db.query(
      `SELECT id FROM karate_belt_exams WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [examId, federationId]
    );
    if (!examCheck.rows.length) {
      return res.status(404).json({ error: 'Exame não encontrado', code: 'NOT_FOUND' });
    }

    // Verifica praticante — customers.name (not full_name)
    const studentCheck = await db.query(
      `SELECT id, name, karate_registration_number
       FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [student_id, federationId]
    );
    if (!studentCheck.rows.length) {
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    // karate_exam_examiners: id, exam_id, examiner_id, role, dan_level, confirmed, created_at
    const insertRes = await db.query(
      `INSERT INTO karate_exam_examiners (exam_id, examiner_id, role, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (exam_id, examiner_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, exam_id, examiner_id, role, created_at`,
      [examId, student_id, role || null]
    );

    const e = insertRes.rows[0];
    const s = studentCheck.rows[0];
    res.status(201).json({
      id: e.id,
      exam_id: e.exam_id,
      student_id: e.examiner_id,
      name: s.name,
      karate_registration_number: s.karate_registration_number || null,
      role: e.role || null,
      created_at: e.created_at,
    });
  } catch (err) {
    console.error('[karateExams] add examiner error:', err.message);
    res.status(500).json({ error: 'Erro ao adicionar examinador', detail: err.message });
  }
});

// ── POST /belt-exams/:examId/candidates ────────────────────
// FPKT DECISÃO #1: SEMPRE retorna 201, mesmo inelegível.
// Nunca retorna 422 por critério de elegibilidade.
// A checagem é INFORMATIVA — retornada em eligibility{} na resposta.
//
// CURSO (exam_type='curso'): target_belt é OPCIONAL — cursos não graduam.
// Para exames normais, target_belt continua obrigatório.
router.post('/belt-exams/:examId/candidates', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, examId } = req.params;
  const { student_id, target_belt } = req.body;

  if (!student_id) {
    return res.status(422).json({ error: 'student_id é obrigatório', code: 'VALIDATION_ERROR' });
  }
  // Nota: NÃO validamos target_belt aqui ainda — precisamos saber o exam_type
  // antes de decidir se ele é obrigatório.

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica exame e carrega exam_type para decidir a obrigatoriedade de target_belt
    const examCheck = await client.query(
      `SELECT id, status, exam_type FROM karate_belt_exams
       WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [examId, federationId]
    );
    if (!examCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Exame não encontrado', code: 'NOT_FOUND' });
    }

    const exam = examCheck.rows[0];

    if (exam.status === 'done' || exam.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Exame com status ${exam.status} não aceita novas inscrições`,
        code: 'CONFLICT',
      });
    }

    // Cursos não exigem faixa-alvo; exames normais sim.
    const isCurso = exam.exam_type === 'curso';
    if (!isCurso && !target_belt) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'target_belt é obrigatório para exames de faixa', code: 'VALIDATION_ERROR' });
    }

    // Advisory lock para evitar dupla inscrição
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text || '-candidate-' || $2::text))`,
      [examId, student_id]
    );

    // Verifica inscrição dupla
    const dupCheck = await client.query(
      `SELECT id FROM karate_belt_exam_candidates
       WHERE exam_id = $1 AND student_id = $2 LIMIT 1`,
      [examId, student_id]
    );
    if (dupCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Candidato já inscrito neste exame',
        code: 'CONFLICT',
        candidate_id: dupCheck.rows[0].id,
      });
    }

    // Insere candidato — target_belt é NULL para cursos
    // karate_belt_exam_candidates: id, exam_id, student_id,
    //   current_belt, target_belt, target_belt_name, belt_schema, status,
    //   result_notes, fee_paid, created_at, updated_at
    const insertRes = await client.query(
      `INSERT INTO karate_belt_exam_candidates
         (exam_id, student_id, target_belt, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'enrolled', NOW(), NOW())
       RETURNING id, exam_id, student_id, target_belt, status, created_at`,
      [examId, student_id, target_belt || null]
    );

    await client.query('COMMIT');

    const cand = insertRes.rows[0];

    // FPKT #1: Checa elegibilidade APÓS inscrição (somente aviso, nunca bloqueia).
    // Para cursos não há faixa-alvo — pulamos a checagem de elegibilidade.
    let eligibility = null;
    if (!isCurso) {
      try {
        eligibility = await checkEligibility(student_id, target_belt, federationId);
      } catch (eligErr) {
        // Falha na checagem não impede a inscrição
        eligibility = {
          eligible: null,
          is_hard_block: false,
          checks: [],
          warnings: ['Não foi possível verificar elegibilidade: ' + eligErr.message],
          error: eligErr.message,
        };
      }
    }

    // SEMPRE 201 — a elegibilidade é só informativa
    res.status(201).json({
      id: cand.id,
      exam_id: cand.exam_id,
      student_id: cand.student_id,
      target_belt: cand.target_belt,
      status: cand.status,
      created_at: cand.created_at,
      eligibility, // null para cursos; objeto com checks para exames de faixa
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateExams] enroll candidate error:', err.message);
    res.status(500).json({ error: 'Erro ao inscrever candidato', detail: err.message });
  } finally {
    client.release();
  }
});

// ── PATCH /belt-exams/:examId/candidates/:candidateId ──────
// Lança resultado. approved dispara trigger karate_on_exam_approved
// que insere em karate_belt_history (imutável).
// RBAC: guards.examResults (admin + examiner)
router.patch('/belt-exams/:examId/candidates/:candidateId', ...guards.examResults(), async (req, res) => {
  const { id: federationId, examId, candidateId } = req.params;
  const { status, result_notes } = req.body;

  const VALID_STATUS = ['approved', 'failed', 'absent'];
  if (!status || !VALID_STATUS.includes(status)) {
    return res.status(422).json({
      error: `status deve ser: ${VALID_STATUS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  try {
    // Verifica exame + candidato
    const candRes = await db.query(
      `SELECT ec.id, ec.student_id, ec.status AS current_status, ec.target_belt
       FROM karate_belt_exam_candidates ec
       JOIN karate_belt_exams be ON be.id = ec.exam_id
       WHERE ec.id = $1 AND ec.exam_id = $2 AND be.federation_id = $3
       LIMIT 1`,
      [candidateId, examId, federationId]
    );

    if (!candRes.rows.length) {
      return res.status(404).json({ error: 'Candidato não encontrado', code: 'NOT_FOUND' });
    }

    const cand = candRes.rows[0];

    if (cand.current_status !== 'enrolled') {
      return res.status(409).json({
        error: `Resultado já lançado (status atual: ${cand.current_status})`,
        code: 'CONFLICT',
      });
    }

    // Atualiza status — trigger karate_on_exam_approved é disparado
    // automaticamente pelo banco quando status = 'approved'
    // karate_belt_exam_candidates has no result_at column — use updated_at
    const updRes = await db.query(
      `UPDATE karate_belt_exam_candidates
       SET status = $1, result_notes = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, exam_id, student_id, target_belt, status, result_notes, updated_at`,
      [status, result_notes || null, candidateId]
    );

    const updated = updRes.rows[0];
    res.json({
      id: updated.id,
      exam_id: updated.exam_id,
      student_id: updated.student_id,
      target_belt: updated.target_belt,
      status: updated.status,
      result_notes: updated.result_notes || null,
      result_at: updated.updated_at,
      _note: status === 'approved'
        ? 'Trigger karate_on_exam_approved inseriu histórico de faixa (imutável)'
        : undefined,
    });
  } catch (err) {
    console.error('[karateExams] result error:', err.message);
    res.status(500).json({ error: 'Erro ao lançar resultado', detail: err.message });
  }
});

// ── POST /belt-exams/:examId/candidates/:candidateId/correction
// Estorno/correção de resultado. karate_belt_history é IMUTÁVEL,
// portanto a correção é um REGISTRO COMPENSATÓRIO:
//   1. Marca o candidato com status='correction_pending'
//   2. Insere nota de correção para auditoria
//   3. Federação decide o próximo passo manualmente (re-abrir, corrigir faixa)
router.post(
  '/belt-exams/:examId/candidates/:candidateId/correction',
  ...guards.examResults(),
  async (req, res) => {
    const { id: federationId, examId, candidateId } = req.params;
    const { reason, corrected_status } = req.body;

    if (!reason || !String(reason).trim()) {
      return res.status(422).json({ error: 'reason é obrigatório para correção', code: 'VALIDATION_ERROR' });
    }
    const VALID_CORRECTED = ['approved', 'failed', 'absent'];
    if (corrected_status && !VALID_CORRECTED.includes(corrected_status)) {
      return res.status(422).json({
        error: `corrected_status deve ser: ${VALID_CORRECTED.join(', ')}`,
        code: 'VALIDATION_ERROR',
      });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const candRes = await client.query(
        `SELECT ec.id, ec.student_id, ec.status, ec.target_belt
         FROM karate_belt_exam_candidates ec
         JOIN karate_belt_exams be ON be.id = ec.exam_id
         WHERE ec.id = $1 AND ec.exam_id = $2 AND be.federation_id = $3
         LIMIT 1`,
        [candidateId, examId, federationId]
      );

      if (!candRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Candidato não encontrado', code: 'NOT_FOUND' });
      }

      const cand = candRes.rows[0];

      // Insere registro compensatório de auditoria
      // (karate_belt_history é imutável — não alteramos o histórico existente)
      await client.query(
        `INSERT INTO karate_belt_exam_candidates
           (exam_id, student_id, target_belt, status, result_notes, created_at, updated_at)
         VALUES ($1, $2, $3, 'correction_pending', $4, NOW(), NOW())`,
        [
          examId,
          cand.student_id,
          cand.target_belt,
          `CORREÇÃO [motivo: ${reason}]${corrected_status ? ' → ' + corrected_status : ''}. Original candidato_id=${candidateId}`,
        ]
      );

      // Marca candidato original com status de correção para rastreabilidade
      await client.query(
        `UPDATE karate_belt_exam_candidates
         SET status = 'correction_pending',
             result_notes = COALESCE(result_notes, '') || ' [CORREÇÃO SOLICITADA: ' || $1 || ']',
             updated_at = NOW()
         WHERE id = $2`,
        [reason, candidateId]
      );

      await client.query('COMMIT');

      res.status(201).json({
        corrected_candidate_id: candidateId,
        student_id: cand.student_id,
        target_belt: cand.target_belt,
        original_status: cand.status,
        corrected_status: corrected_status || null,
        reason,
        _note: 'Registro compensatório criado. karate_belt_history é imutável — correção via novo lançamento após revisão.',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[karateExams] correction error:', err.message);
      res.status(500).json({ error: 'Erro ao registrar correção', detail: err.message });
    } finally {
      client.release();
    }
  }
);

// ── POST /belt-exams/:examId/close ─────────────────────────
// Fecha o exame e consolida resultados (status → done).
// NÃO emite certificados (FPKT #3).
// Valida que todos os candidatos têm resultado antes de fechar.
// Bloco C — cache module-level otimista p/ certificate_eligible (migration 202).
// Backend sobe antes da migration ser aplicada (armadilha_schema_pre_migration
// do CLAUDE.md): comeca true, vira false em 42703 e o UPDATE de elegibilidade
// e pulado (best-effort, nao impede o fechamento do exame).
let HAS_CERTIFICATE_ELIGIBLE_COL = true;

router.post('/belt-exams/:examId/close', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, examId } = req.params;
  const { force = false } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const examRes = await client.query(
      `SELECT id, status, exam_type FROM karate_belt_exams
       WHERE id = $1 AND federation_id = $2 FOR UPDATE`,
      [examId, federationId]
    );

    if (!examRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Exame não encontrado', code: 'NOT_FOUND' });
    }

    const exam = examRes.rows[0];

    // NOTA DE COMPAT: o status terminal historicamente gravado aqui é 'done',
    // mas o restante do schema (PATCH /belt-exams, frontend) usa 'closed'.
    // Checamos os dois pra nao deixar reabrir/fechar de novo um exame que já
    // foi fechado sob o valor antigo.
    if (exam.status === 'done' || exam.status === 'closed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Exame já fechado', code: 'CONFLICT' });
    }
    if (exam.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Exame cancelado não pode ser fechado', code: 'CONFLICT' });
    }

    // Verifica candidatos sem resultado (a menos que force=true)
    const pendingRes = await client.query(
      `SELECT COUNT(*) AS pending
       FROM karate_belt_exam_candidates
       WHERE exam_id = $1 AND status = 'enrolled'`,
      [examId]
    );
    const pendingCount = parseInt(pendingRes.rows[0].pending, 10);

    if (pendingCount > 0 && !force) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${pendingCount} candidato(s) sem resultado. Use force=true para fechar assim mesmo.`,
        code: 'CANDIDATES_PENDING',
        pending_count: pendingCount,
      });
    }

    // Fecha exame — 'closed' é o valor canônico do enum (draft/open/closed)
    // usado pelo PATCH /belt-exams e pelo frontend.
    const closeRes = await client.query(
      `UPDATE karate_belt_exams
       SET status = 'done', updated_at = NOW()
       WHERE id = $1
       RETURNING id, status, updated_at`,
      [examId]
    );

    // Bloco C — marca certificate_eligible:
    //   curso (exam_type='curso')  -> TODOS os inscritos/participantes
    //   exame/graus                -> apenas status='approved'
    // Best-effort: 42703 (migration 202 pendente) não impede o fechamento.
    // Usa SAVEPOINT porque estamos dentro de uma transação (BEGIN acima) —
    // um erro de coluna ausente abortaria a transação inteira até o
    // ROLLBACK explícito; o savepoint isola só esta tentativa.
    if (HAS_CERTIFICATE_ELIGIBLE_COL) {
      await client.query('SAVEPOINT cert_eligible');
      try {
        const isCurso = exam.exam_type === 'curso';
        if (isCurso) {
          await client.query(
            `UPDATE karate_belt_exam_candidates
             SET certificate_eligible = true
             WHERE exam_id = $1`,
            [examId]
          );
        } else {
          await client.query(
            `UPDATE karate_belt_exam_candidates
             SET certificate_eligible = true
             WHERE exam_id = $1 AND status = 'approved'`,
            [examId]
          );
        }
        await client.query('RELEASE SAVEPOINT cert_eligible');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT cert_eligible');
        if (e.code === '42703') {
          HAS_CERTIFICATE_ELIGIBLE_COL = false;
          console.warn('[karateExams] certificate_eligible ausente (migration 202 pendente)');
        } else throw e;
      }
    }

    // Sumário de resultados
    const summaryRes = await client.query(
      `SELECT status, COUNT(*) AS cnt
       FROM karate_belt_exam_candidates
       WHERE exam_id = $1
       GROUP BY status`,
      [examId]
    );

    const summary = {};
    for (const row of summaryRes.rows) {
      summary[row.status] = parseInt(row.cnt, 10);
    }

    await client.query('COMMIT');

    res.json({
      id: examId,
      status: closeRes.rows[0].status,
      updated_at: closeRes.rows[0].updated_at,
      summary,
      _note: 'Exame fechado. Certificados NÃO emitidos automaticamente (FPKT #3). Use POST /certificates/:candidateId/issue para emitir sob demanda.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateExams] close error:', err.message);
    res.status(500).json({ error: 'Erro ao fechar exame', detail: err.message });
  } finally {
    client.release();
  }
});

// ── GET /practitioners/:practitionerId/eligibility/:targetBelt
// Consulta avulsa de elegibilidade (sempre informativa, nunca bloqueia)
router.get(
  '/practitioners/:practitionerId/eligibility/:targetBelt',
  ...guards.read(),
  async (req, res) => {
    const { id: federationId, practitionerId, targetBelt } = req.params;

    try {
      const result = await checkEligibility(practitionerId, targetBelt, federationId);
      res.json(result);
    } catch (err) {
      console.error('[karateExams] eligibility check error:', err.message);
      res.status(500).json({ error: 'Erro ao verificar elegibilidade', detail: err.message });
    }
  }
);

module.exports = router;
