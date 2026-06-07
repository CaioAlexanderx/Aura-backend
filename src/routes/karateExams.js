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
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { checkEligibility } = require('../services/karateExamService');

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
      conditions.push(`EXTRACT(YEAR FROM be.exam_date) = $${n}`);
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
         be.id, be.federation_id, be.dojo_id, be.exam_date, be.location,
         be.status, be.notes, be.created_at,
         COUNT(DISTINCT ec.id) AS candidate_count,
         COUNT(DISTINCT ee.id) AS examiner_count
       FROM karate_belt_exams be
       LEFT JOIN karate_belt_exam_candidates ec ON ec.exam_id = be.id
       LEFT JOIN karate_exam_examiners ee ON ee.exam_id = be.id
       ${where}
       GROUP BY be.id
       ORDER BY be.exam_date DESC
       LIMIT $${n} OFFSET $${n + 1}`,
      [...params, pageSize, offset]
    );

    const data = dataRes.rows.map(r => ({
      id: r.id,
      federation_id: r.federation_id,
      dojo_id: r.dojo_id || null,
      exam_date: r.exam_date,
      location: r.location || null,
      status: r.status,
      notes: r.notes || null,
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
  const { dojo_id, exam_date, location, notes } = req.body;

  if (!exam_date) {
    return res.status(422).json({ error: 'exam_date é obrigatório', code: 'VALIDATION_ERROR' });
  }

  try {
    const insertRes = await db.query(
      `INSERT INTO karate_belt_exams
         (federation_id, dojo_id, exam_date, location, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'scheduled', $5, NOW(), NOW())
       RETURNING id, federation_id, dojo_id, exam_date, location, status, notes, created_at`,
      [federationId, dojo_id || null, exam_date, location || null, notes || null]
    );

    const exam = insertRes.rows[0];
    res.status(201).json({
      id: exam.id,
      federation_id: exam.federation_id,
      dojo_id: exam.dojo_id || null,
      exam_date: exam.exam_date,
      location: exam.location || null,
      status: exam.status,
      notes: exam.notes || null,
      candidate_count: 0,
      examiner_count: 0,
      created_at: exam.created_at,
    });
  } catch (err) {
    console.error('[karateExams] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar exame', detail: err.message });
  }
});

// ── GET /belt-exams/:examId ─────────────────────────────────
router.get('/belt-exams/:examId', ...guards.read(), async (req, res) => {
  const { id: federationId, examId } = req.params;

  try {
    const examRes = await db.query(
      `SELECT id, federation_id, dojo_id, exam_date, location, status, notes, created_at, updated_at
       FROM karate_belt_exams
       WHERE id = $1 AND federation_id = $2
       LIMIT 1`,
      [examId, federationId]
    );

    if (!examRes.rows.length) {
      return res.status(404).json({ error: 'Exame não encontrado', code: 'NOT_FOUND' });
    }

    const exam = examRes.rows[0];

    // Banca
    const examinerRes = await db.query(
      `SELECT ee.id, ee.student_id, ee.role,
              COALESCE(cu.full_name, cu.name) AS name,
              cu.karate_registration_number
       FROM karate_exam_examiners ee
       JOIN customers cu ON cu.id = ee.student_id
       WHERE ee.exam_id = $1`,
      [examId]
    );

    // Candidatos
    const candidateRes = await db.query(
      `SELECT ec.id, ec.student_id, ec.target_belt, ec.status,
              ec.result_notes, ec.enrolled_at, ec.result_at,
              COALESCE(cu.full_name, cu.name) AS student_name,
              cu.karate_registration_number,
              cb.belt_level AS current_belt_level,
              cb.belt_name  AS current_belt_name
       FROM karate_belt_exam_candidates ec
       JOIN customers cu ON cu.id = ec.student_id
       LEFT JOIN karate_current_belt cb
         ON cb.student_id = ec.student_id AND cb.federation_id = $2
       WHERE ec.exam_id = $1
       ORDER BY ec.enrolled_at ASC`,
      [examId, federationId]
    );

    res.json({
      id: exam.id,
      federation_id: exam.federation_id,
      dojo_id: exam.dojo_id || null,
      exam_date: exam.exam_date,
      location: exam.location || null,
      status: exam.status,
      notes: exam.notes || null,
      created_at: exam.created_at,
      updated_at: exam.updated_at,
      examiners: examinerRes.rows.map(e => ({
        id: e.id,
        student_id: e.student_id,
        name: e.name,
        karate_registration_number: e.karate_registration_number || null,
        role: e.role || null,
      })),
      candidates: candidateRes.rows.map(c => ({
        id: c.id,
        student_id: c.student_id,
        student_name: c.student_name,
        karate_registration_number: c.karate_registration_number || null,
        current_belt_level: c.current_belt_level || null,
        current_belt_name: c.current_belt_name || null,
        target_belt: c.target_belt,
        status: c.status,
        result_notes: c.result_notes || null,
        enrolled_at: c.enrolled_at,
        result_at: c.result_at || null,
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

  const ALLOWED = ['exam_date', 'location', 'notes', 'dojo_id'];
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
    const VALID_STATUS = ['scheduled', 'in_progress', 'cancelled'];
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

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  updates.push('updated_at = NOW()');
  values.push(examId, federationId);

  try {
    const result = await db.query(
      `UPDATE karate_belt_exams
       SET ${updates.join(', ')}
       WHERE id = $${idx} AND federation_id = $${idx + 1}
       RETURNING id, federation_id, dojo_id, exam_date, location, status, notes, updated_at`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Exame não encontrado', code: 'NOT_FOUND' });
    }

    const exam = result.rows[0];
    res.json({
      id: exam.id,
      federation_id: exam.federation_id,
      dojo_id: exam.dojo_id || null,
      exam_date: exam.exam_date,
      location: exam.location || null,
      status: exam.status,
      notes: exam.notes || null,
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

    const { rows } = await db.query(
      `SELECT ee.id, ee.student_id, ee.role, ee.added_at,
              COALESCE(cu.full_name, cu.name) AS name,
              cu.karate_registration_number
       FROM karate_exam_examiners ee
       JOIN customers cu ON cu.id = ee.student_id
       WHERE ee.exam_id = $1
       ORDER BY ee.added_at ASC`,
      [examId]
    );

    res.json(rows.map(e => ({
      id: e.id,
      student_id: e.student_id,
      name: e.name,
      karate_registration_number: e.karate_registration_number || null,
      role: e.role || null,
      added_at: e.added_at,
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

    // Verifica praticante
    const studentCheck = await db.query(
      `SELECT id, COALESCE(full_name, name) AS name, karate_registration_number
       FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [student_id, federationId]
    );
    if (!studentCheck.rows.length) {
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    const insertRes = await db.query(
      `INSERT INTO karate_exam_examiners (exam_id, student_id, role, added_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (exam_id, student_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, exam_id, student_id, role, added_at`,
      [examId, student_id, role || null]
    );

    const e = insertRes.rows[0];
    const s = studentCheck.rows[0];
    res.status(201).json({
      id: e.id,
      exam_id: e.exam_id,
      student_id: e.student_id,
      name: s.name,
      karate_registration_number: s.karate_registration_number || null,
      role: e.role || null,
      added_at: e.added_at,
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
router.post('/belt-exams/:examId/candidates', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, examId } = req.params;
  const { student_id, target_belt } = req.body;

  if (!student_id) {
    return res.status(422).json({ error: 'student_id é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!target_belt) {
    return res.status(422).json({ error: 'target_belt é obrigatório', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica exame
    const examCheck = await client.query(
      `SELECT id, status FROM karate_belt_exams
       WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [examId, federationId]
    );
    if (!examCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Exame não encontrado', code: 'NOT_FOUND' });
    }
    if (examCheck.rows[0].status === 'done' || examCheck.rows[0].status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Exame com status ${examCheck.rows[0].status} não aceita novas inscrições`,
        code: 'CONFLICT',
      });
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

    // Insere candidato
    const insertRes = await client.query(
      `INSERT INTO karate_belt_exam_candidates
         (exam_id, student_id, target_belt, status, enrolled_at)
       VALUES ($1, $2, $3, 'enrolled', NOW())
       RETURNING id, exam_id, student_id, target_belt, status, enrolled_at`,
      [examId, student_id, target_belt]
    );

    await client.query('COMMIT');

    const cand = insertRes.rows[0];

    // FPKT #1: Checa elegibilidade APÓS inscrição (somente aviso, nunca bloqueia)
    // A checagem usa db direto (fora da transação já fechada)
    let eligibility = { eligible: true, is_hard_block: false, checks: [], warnings: [] };
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

    // SEMPRE 201 — a elegibilidade é só informativa
    res.status(201).json({
      id: cand.id,
      exam_id: cand.exam_id,
      student_id: cand.student_id,
      target_belt: cand.target_belt,
      status: cand.status,
      enrolled_at: cand.enrolled_at,
      eligibility, // FPKT #1: aviso anexado, nunca 422 por critério
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
    const updRes = await db.query(
      `UPDATE karate_belt_exam_candidates
       SET status = $1, result_notes = $2, result_at = NOW(), updated_at = NOW()
       WHERE id = $3
       RETURNING id, exam_id, student_id, target_belt, status, result_notes, result_at`,
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
      result_at: updated.result_at,
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
           (exam_id, student_id, target_belt, status, result_notes, enrolled_at)
         VALUES ($1, $2, $3, 'correction_pending', $4, NOW())`,
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
router.post('/belt-exams/:examId/close', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, examId } = req.params;
  const { force = false } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const examRes = await client.query(
      `SELECT id, status FROM karate_belt_exams
       WHERE id = $1 AND federation_id = $2 FOR UPDATE`,
      [examId, federationId]
    );

    if (!examRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Exame não encontrado', code: 'NOT_FOUND' });
    }

    const exam = examRes.rows[0];

    if (exam.status === 'done') {
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

    // Fecha exame
    const closeRes = await client.query(
      `UPDATE karate_belt_exams
       SET status = 'done', updated_at = NOW()
       WHERE id = $1
       RETURNING id, status, updated_at`,
      [examId]
    );

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
