// ============================================================
// AURA KARATÊ — Cursos e Seminários (Track C)
// Tabela: karate_events (migration 160, event_type='course'|'seminar')
//
// Schema real karate_events:
//   id, federation_id, event_type, name, event_date, location,
//   hours, fee_amount, status, created_at, updated_at
//   (NOT: title, workload_hours, instructor, max_participants, description)
//
// Schema real karate_event_enrollments:
//   id, event_id, student_id, dojo_id, hours_completed,
//   status, fee_paid, created_at
//   (NOT: enrolled_at, attended_at)
//
// GET  /courses                    — lista cursos/seminários
// POST /courses                    — cria curso/seminário
// GET  /courses/:eventId           — detalhe
// POST /courses/:eventId/enroll    — inscreve praticante
//
// RBAC: staffWrite para criar; read para consultar.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

// ── GET /courses ────────────────────────────────────────────
router.get('/courses', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { event_type, year } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;

  try {
    const conditions = [`ev.federation_id = $1`, `ev.event_type IN ('course', 'seminar', 'training')`];
    const params = [federationId];
    let n = 2;

    if (event_type) {
      conditions.push(`ev.event_type = $${n}`);
      params.push(event_type);
      n++;
    }
    if (year) {
      conditions.push(`EXTRACT(YEAR FROM ev.event_date) = $${n}`);
      params.push(parseInt(year, 10));
      n++;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM karate_events ev ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    // karate_events: name (not title), hours (not workload_hours)
    // no instructor, max_participants, description columns
    const dataRes = await db.query(
      `SELECT
         ev.id, ev.federation_id, ev.event_type, ev.name,
         ev.event_date, ev.location, ev.hours,
         ev.fee_amount, ev.status, ev.created_at,
         COUNT(ee.id) AS enrollment_count
       FROM karate_events ev
       LEFT JOIN karate_event_enrollments ee ON ee.event_id = ev.id
       ${where}
       GROUP BY ev.id
       ORDER BY ev.event_date DESC
       LIMIT $${n} OFFSET $${n + 1}`,
      [...params, pageSize, offset]
    );

    const data = dataRes.rows.map(r => ({
      id: r.id,
      federation_id: r.federation_id,
      event_type: r.event_type,
      name: r.name,
      event_date: r.event_date,
      location: r.location || null,
      hours: r.hours ? parseFloat(r.hours) : null,
      fee_amount: r.fee_amount ? parseFloat(r.fee_amount) : null,
      status: r.status,
      enrollment_count: parseInt(r.enrollment_count, 10),
      created_at: r.created_at,
    }));

    res.json({ page, page_size: pageSize, total, data });
  } catch (err) {
    console.error('[karateCourses] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar cursos' });
  }
});

// ── POST /courses ───────────────────────────────────────────
router.post('/courses', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  // karate_events columns: name (not title), hours (not workload_hours)
  // no instructor, max_participants, description
  const {
    event_type = 'course',
    name, event_date, location,
    hours, fee_amount,
  } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(422).json({ error: 'name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!event_date) {
    return res.status(422).json({ error: 'event_date é obrigatório', code: 'VALIDATION_ERROR' });
  }
  const VALID_TYPES = ['course', 'seminar', 'training'];
  if (!VALID_TYPES.includes(event_type)) {
    return res.status(422).json({
      error: `event_type deve ser: ${VALID_TYPES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  try {
    const insertRes = await db.query(
      `INSERT INTO karate_events
         (federation_id, event_type, name, event_date, location,
          hours, fee_amount, status,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', NOW(), NOW())
       RETURNING id, federation_id, event_type, name, event_date, location,
                 hours, fee_amount, status, created_at`,
      [
        federationId,
        event_type,
        String(name).trim(),
        event_date,
        location || null,
        hours ? parseFloat(hours) : null,
        fee_amount ? parseFloat(fee_amount) : null,
      ]
    );

    const ev = insertRes.rows[0];
    res.status(201).json({
      id: ev.id,
      federation_id: ev.federation_id,
      event_type: ev.event_type,
      name: ev.name,
      event_date: ev.event_date,
      location: ev.location || null,
      hours: ev.hours ? parseFloat(ev.hours) : null,
      fee_amount: ev.fee_amount ? parseFloat(ev.fee_amount) : null,
      status: ev.status,
      enrollment_count: 0,
      created_at: ev.created_at,
    });
  } catch (err) {
    console.error('[karateCourses] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar curso', detail: err.message });
  }
});

// ── GET /courses/:eventId ───────────────────────────────────
router.get('/courses/:eventId', ...guards.read(), async (req, res) => {
  const { id: federationId, eventId } = req.params;

  try {
    const evRes = await db.query(
      `SELECT ev.id, ev.federation_id, ev.event_type, ev.name,
              ev.event_date, ev.location, ev.hours,
              ev.fee_amount, ev.status, ev.created_at,
              COUNT(ee.id) AS enrollment_count
       FROM karate_events ev
       LEFT JOIN karate_event_enrollments ee ON ee.event_id = ev.id
       WHERE ev.id = $1 AND ev.federation_id = $2
       GROUP BY ev.id`,
      [eventId, federationId]
    );

    if (!evRes.rows.length) {
      return res.status(404).json({ error: 'Curso não encontrado', code: 'NOT_FOUND' });
    }

    const ev = evRes.rows[0];

    // Lista de inscritos — karate_event_enrollments:
    //   id, event_id, student_id, dojo_id, hours_completed, status, fee_paid, created_at
    //   (NOT enrolled_at, NOT attended_at)
    const enrollRes = await db.query(
      `SELECT ee.id, ee.student_id, ee.status, ee.hours_completed,
              ee.fee_paid, ee.created_at,
              cu.name AS student_name,
              cu.karate_registration_number
       FROM karate_event_enrollments ee
       JOIN customers cu ON cu.id = ee.student_id
       WHERE ee.event_id = $1
       ORDER BY ee.created_at ASC`,
      [eventId]
    );

    res.json({
      id: ev.id,
      federation_id: ev.federation_id,
      event_type: ev.event_type,
      name: ev.name,
      event_date: ev.event_date,
      location: ev.location || null,
      hours: ev.hours ? parseFloat(ev.hours) : null,
      fee_amount: ev.fee_amount ? parseFloat(ev.fee_amount) : null,
      status: ev.status,
      enrollment_count: parseInt(ev.enrollment_count, 10),
      created_at: ev.created_at,
      enrollments: enrollRes.rows.map(e => ({
        id: e.id,
        student_id: e.student_id,
        student_name: e.student_name,
        karate_registration_number: e.karate_registration_number || null,
        status: e.status,
        hours_completed: e.hours_completed ? parseFloat(e.hours_completed) : null,
        fee_paid: e.fee_paid || false,
        created_at: e.created_at,
      })),
    });
  } catch (err) {
    console.error('[karateCourses] detail error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar curso' });
  }
});

// ── POST /courses/:eventId/enroll ───────────────────────────
// Inscreve praticante no curso. Carga horária registrada em
// karate_event_enrollments.hours_completed (preenchida ao concluir).
router.post('/courses/:eventId/enroll', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, eventId } = req.params;
  const { student_id } = req.body;

  if (!student_id) {
    return res.status(422).json({ error: 'student_id é obrigatório', code: 'VALIDATION_ERROR' });
  }

  try {
    // Verifica evento — karate_events: hours (not workload_hours)
    const evRes = await db.query(
      `SELECT id, status, hours
       FROM karate_events WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [eventId, federationId]
    );
    if (!evRes.rows.length) {
      return res.status(404).json({ error: 'Curso não encontrado', code: 'NOT_FOUND' });
    }
    const ev = evRes.rows[0];
    if (ev.status === 'closed' || ev.status === 'cancelled') {
      return res.status(409).json({
        error: `Curso com status ${ev.status} não aceita inscrições`,
        code: 'CONFLICT',
      });
    }

    // Verifica praticante — customers.name (not full_name)
    const stuRes = await db.query(
      `SELECT id, name
       FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [student_id, federationId]
    );
    if (!stuRes.rows.length) {
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    // Insere inscrição (idempotente via ON CONFLICT)
    // karate_event_enrollments: id, event_id, student_id, dojo_id, hours_completed,
    //   status, fee_paid, created_at
    const insertRes = await db.query(
      `INSERT INTO karate_event_enrollments
         (event_id, student_id, status, created_at)
       VALUES ($1, $2, 'enrolled', NOW())
       ON CONFLICT (event_id, student_id) DO NOTHING
       RETURNING id, event_id, student_id, status, created_at`,
      [eventId, student_id]
    );

    if (!insertRes.rows.length) {
      return res.status(409).json({
        error: 'Praticante já inscrito neste curso',
        code: 'CONFLICT',
      });
    }

    const enroll = insertRes.rows[0];
    res.status(201).json({
      id: enroll.id,
      event_id: enroll.event_id,
      student_id: enroll.student_id,
      student_name: stuRes.rows[0].name,
      status: enroll.status,
      created_at: enroll.created_at,
      hours: ev.hours ? parseFloat(ev.hours) : null,
    });
  } catch (err) {
    console.error('[karateCourses] enroll error:', err.message);
    res.status(500).json({ error: 'Erro ao inscrever no curso', detail: err.message });
  }
});

module.exports = router;
