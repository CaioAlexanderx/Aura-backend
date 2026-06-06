// ============================================================
// AURA KARATÊ — Rotas de Praticantes (Track A)
// GET  /federation/:id/practitioners
// POST /federation/:id/practitioners
// GET  /federation/:id/practitioners/:practitionerId
//
// Nota: /practitioners/import é registrado ANTES deste router no index.js
// para que 'import' não seja capturado como :practitionerId.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { nextPractitionerRegistrationNumber } = require('../services/karateService');

// ── GET /federation/:id/practitioners ──────────────────────
router.get('/', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { dojo_id, belt_level, affiliation_status, role, q } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;

  try {
    const conditions = [`cu.federation_id = $1`];
    const params = [federationId];
    let n = 2;

    if (dojo_id) {
      conditions.push(`cu.dojo_id = $${n}`);
      params.push(dojo_id);
      n++;
    }
    if (belt_level) {
      conditions.push(`cb.belt_level = $${n}`);
      params.push(belt_level);
      n++;
    }
    if (role) {
      const roleColMap = { arbiter: 'is_arbiter', instructor: 'is_instructor', examiner: 'is_examiner' };
      const col = roleColMap[role];
      if (col) {
        conditions.push(`cu.${col} = true`);
      }
    }
    if (q) {
      conditions.push(`(cu.name ILIKE $${n} OR cu.cpf_cnpj ILIKE $${n} OR cu.karate_registration_number ILIKE $${n})`);
      params.push(`%${q}%`);
      n++;
    }

    // affiliation_status: active=is_active true, pending=sem faixa, inactive=is_active false
    if (affiliation_status === 'active') {
      conditions.push('cu.is_active = true');
    } else if (affiliation_status === 'inactive') {
      conditions.push('cu.is_active = false');
    } else if (affiliation_status === 'pending') {
      conditions.push('cb.belt_level IS NULL');
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRes = await db.query(
      `SELECT COUNT(DISTINCT cu.id) AS total
       FROM customers cu
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = cu.federation_id
       ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    const dataRes = await db.query(
      `SELECT cu.id, cu.name AS full_name, cu.karate_registration_number,
              comp.name AS dojo_name,
              cb.belt_name, cu.is_active
       FROM customers cu
       LEFT JOIN companies comp ON comp.id = cu.dojo_id
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = cu.federation_id
       ${where}
       ORDER BY cu.name ASC
       LIMIT $${n} OFFSET $${n + 1}`,
      [...params, pageSize, offset]
    );

    const practitioners = dataRes.rows.map(r => ({
      id: r.id,
      full_name: r.full_name,
      karate_registration_number: r.karate_registration_number || null,
      dojo_name: r.dojo_name || null,
      belt_name: r.belt_name || null,
      affiliation_status: r.is_active ? 'active' : 'inactive',
    }));

    res.json({
      page,
      page_size: pageSize,
      total,
      data: practitioners,
    });
  } catch (err) {
    console.error('[karatePractitioners] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar praticantes' });
  }
});

// ── POST /federation/:id/practitioners ─────────────────────
router.post('/', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const {
    full_name, cpf, rg, birth_date, email, phone,
    dojo_id, is_student, parent_guardian_id,
    is_arbiter, is_instructor, is_examiner,
    photo_url,
  } = req.body;

  if (!full_name || !String(full_name).trim()) {
    return res.status(422).json({ error: 'Campo full_name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!dojo_id) {
    return res.status(422).json({ error: 'Campo dojo_id é obrigatório', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica federação
    const fedRes = await client.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [federationId]
    );
    if (!fedRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Federação não encontrada', code: 'NOT_FOUND' });
    }

    // Verifica dojô pertence à federação
    const dojoRes = await client.query(
      `SELECT id FROM companies WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
      [dojo_id, federationId]
    );
    if (!dojoRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'dojo_id não pertence a esta federação', code: 'VALIDATION_ERROR' });
    }

    // Gera número de registro FPKT-A-NNNNN
    const regNumber = await nextPractitionerRegistrationNumber(client, federationId);

    const insertRes = await client.query(
      `INSERT INTO customers
         (company_id, name, cpf_cnpj, rg, birth_date, email, phone,
          is_student, parent_guardian_id, federation_id, dojo_id,
          is_arbiter, is_instructor, is_examiner,
          karate_photo_url, karate_registration_number,
          is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, true, NOW(), NOW())
       RETURNING id, name, cpf_cnpj, rg, birth_date, email, phone,
                 is_student, parent_guardian_id, federation_id, dojo_id,
                 is_arbiter, is_instructor, is_examiner,
                 karate_photo_url, karate_registration_number, is_active`,
      [
        federationId,                        // company_id = federação (owner do registro)
        String(full_name).trim(),
        cpf || null,
        rg || null,
        birth_date || null,
        email || null,
        phone || null,
        is_student !== false,                 // default true
        parent_guardian_id || null,
        federationId,
        dojo_id,
        is_arbiter === true,
        is_instructor === true,
        is_examiner === true,
        photo_url || null,
        regNumber,
      ]
    );

    await client.query('COMMIT');

    const p = insertRes.rows[0];
    res.status(201).json({
      id: p.id,
      full_name: p.name,
      cpf: p.cpf_cnpj || null,
      rg: p.rg || null,
      birth_date: p.birth_date || null,
      email: p.email || null,
      phone: p.phone || null,
      dojo_id: p.dojo_id,
      is_student: p.is_student,
      parent_guardian_id: p.parent_guardian_id || null,
      is_arbiter: p.is_arbiter,
      is_instructor: p.is_instructor,
      is_examiner: p.is_examiner,
      photo_url: p.karate_photo_url || null,
      karate_registration_number: p.karate_registration_number,
      affiliation_status: 'active',
      current_belt: null, // recém criado, sem faixa ainda
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karatePractitioners] create error:', err.message);
    res.status(500).json({ error: 'Erro ao cadastrar praticante', detail: err.message });
  } finally {
    client.release();
  }
});

// ── GET /federation/:id/practitioners/:practitionerId ───────
router.get('/:practitionerId', ...guards.read(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;

  try {
    const pracRes = await db.query(
      `SELECT cu.id, cu.name AS full_name, cu.cpf_cnpj, cu.rg, cu.birth_date,
              cu.email, cu.phone, cu.is_student, cu.parent_guardian_id,
              cu.dojo_id, cu.is_arbiter, cu.is_instructor, cu.is_examiner,
              cu.karate_photo_url AS photo_url, cu.karate_registration_number,
              cu.is_active,
              cb.belt_level, cb.belt_name, cb.current_since
       FROM customers cu
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $1
       WHERE cu.id = $2 AND cu.federation_id = $1
       LIMIT 1`,
      [federationId, practitionerId]
    );

    if (!pracRes.rows.length) {
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    const p = pracRes.rows[0];

    // Histórico de faixas
    const beltHistRes = await db.query(
      `SELECT id, belt_level, belt_name, belt_schema, graduated_at, exam_id
       FROM karate_belt_history
       WHERE student_id = $1 AND federation_id = $2
       ORDER BY graduated_at ASC`,
      [practitionerId, federationId]
    );

    const beltHistory = beltHistRes.rows.map(r => ({
      id: r.id,
      belt_level: r.belt_level,
      belt_name: r.belt_name,
      belt_schema: r.belt_schema,
      graduated_at: r.graduated_at,
      is_legacy: r.belt_schema === 'legacy',
      exam_id: r.exam_id || null,
    }));

    res.json({
      id: p.id,
      full_name: p.full_name,
      cpf: p.cpf_cnpj || null,
      rg: p.rg || null,
      birth_date: p.birth_date || null,
      email: p.email || null,
      phone: p.phone || null,
      dojo_id: p.dojo_id || null,
      is_student: p.is_student,
      parent_guardian_id: p.parent_guardian_id || null,
      is_arbiter: p.is_arbiter,
      is_instructor: p.is_instructor,
      is_examiner: p.is_examiner,
      photo_url: p.photo_url || null,
      karate_registration_number: p.karate_registration_number || null,
      affiliation_status: p.is_active ? 'active' : 'inactive',
      current_belt: p.belt_level ? {
        belt_level: p.belt_level,
        belt_name: p.belt_name,
        current_since: p.current_since,
      } : null,
      belt_history: beltHistory,
    });
  } catch (err) {
    console.error('[karatePractitioners] detail error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar praticante' });
  }
});

module.exports = router;
