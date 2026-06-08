// ============================================================
// AURA KARATÊ — Critérios de Graduação (Track C)
//
// DECISÃO FPKT #2 — Critérios PROVISÓRIOS:
//   - karate_belt_requirements.confirmed (bool)
//   - false = provisório (UI deve sinalizar)
//   - true = confirmado pela federação
//   - GET expõe confirmed
//   - PUT permite editar confirmed e os valores
//
// Schema real (migração 147-162):
//   karate_belt_requirements:
//     id, federation_id, from_belt, to_belt, belt_schema,
//     min_months, required_kata (text[]), required_kumite,
//     min_courses, notes, is_hard_block, is_active,
//     confirmed, confirmed_at, created_at, updated_at
//
// GET /belt-requirements               — lista critérios vigentes
// PUT /belt-requirements               — atualiza critérios (adminOnly)
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

// ── GET /belt-requirements ──────────────────────────────────
router.get('/belt-requirements', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  // Filter by target belt (to_belt in schema)
  const { to_belt, confirmed } = req.query;

  try {
    const conditions = ['federation_id = $1', 'is_active = true'];
    const params = [federationId];
    let n = 2;

    if (to_belt !== undefined) {
      conditions.push(`to_belt = $${n}`);
      params.push(parseInt(to_belt, 10));
      n++;
    }
    // Filtro por confirmed (opcional) — FPKT #2
    if (confirmed === 'true' || confirmed === 'false') {
      conditions.push(`confirmed = $${n}`);
      params.push(confirmed === 'true');
      n++;
    }

    const { rows } = await db.query(
      `SELECT
         id, federation_id, from_belt, to_belt, belt_schema,
         min_months, required_kata, required_kumite, min_courses,
         notes, is_hard_block,
         confirmed,        -- FPKT #2: expõe status provisório
         confirmed_at, is_active, created_at, updated_at
       FROM karate_belt_requirements
       WHERE ${conditions.join(' AND ')}
       ORDER BY to_belt ASC, from_belt ASC`,
      params
    );

    res.json(rows.map(r => ({
      id: r.id,
      federation_id: r.federation_id,
      from_belt: r.from_belt,
      to_belt: r.to_belt,
      belt_schema: r.belt_schema || null,
      min_months: r.min_months || null,
      required_kata: r.required_kata || [],
      required_kumite: r.required_kumite || null,
      min_courses: r.min_courses || null,
      notes: r.notes || null,
      is_hard_block: r.is_hard_block,
      confirmed: r.confirmed,          // FPKT #2: provisório enquanto false
      confirmed_at: r.confirmed_at || null,
      is_active: r.is_active,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })));
  } catch (err) {
    console.error('[karateRequirements] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar critérios' });
  }
});

// ── PUT /belt-requirements ──────────────────────────────────
// Atualiza critérios. adminOnly.
// Pode marcar confirmed=true/false em cada critério.
// Suporta atualização em lote (array de critérios).
router.put('/belt-requirements', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { requirements } = req.body;

  if (!Array.isArray(requirements) || requirements.length === 0) {
    return res.status(422).json({
      error: 'requirements deve ser um array não-vazio',
      code: 'VALIDATION_ERROR',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const updated = [];

    for (const req_item of requirements) {
      // Editable columns per schema: min_months, required_kata, required_kumite,
      // min_courses, notes, is_hard_block, confirmed, is_active
      const { id, min_months, required_kata, required_kumite, min_courses,
              notes, is_hard_block, confirmed, is_active } = req_item;

      if (!id) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: 'Cada critério deve ter um id',
          code: 'VALIDATION_ERROR',
        });
      }

      const updates = [];
      const values = [];
      let idx = 1;

      if (min_months !== undefined) {
        updates.push(`min_months = $${idx}`);
        values.push(parseInt(min_months, 10));
        idx++;
      }
      if (required_kata !== undefined) {
        updates.push(`required_kata = $${idx}`);
        values.push(required_kata); // text[]
        idx++;
      }
      if (required_kumite !== undefined) {
        updates.push(`required_kumite = $${idx}`);
        values.push(required_kumite);
        idx++;
      }
      if (min_courses !== undefined) {
        updates.push(`min_courses = $${idx}`);
        values.push(parseInt(min_courses, 10));
        idx++;
      }
      if (notes !== undefined) {
        updates.push(`notes = $${idx}`);
        values.push(notes);
        idx++;
      }
      if (is_hard_block !== undefined) {
        updates.push(`is_hard_block = $${idx}`);
        values.push(Boolean(is_hard_block));
        idx++;
      }
      if (confirmed !== undefined) {
        // FPKT #2: permite marcar confirmed
        updates.push(`confirmed = $${idx}`);
        values.push(Boolean(confirmed));
        idx++;
        // Also set confirmed_at when confirming
        if (Boolean(confirmed)) {
          updates.push(`confirmed_at = NOW()`);
        }
      }
      if (is_active !== undefined) {
        updates.push(`is_active = $${idx}`);
        values.push(Boolean(is_active));
        idx++;
      }

      if (updates.length === 0) continue;

      updates.push('updated_at = NOW()');
      values.push(id, federationId);

      const result = await client.query(
        `UPDATE karate_belt_requirements
         SET ${updates.join(', ')}
         WHERE id = $${idx} AND federation_id = $${idx + 1}
         RETURNING
           id, federation_id, from_belt, to_belt, belt_schema,
           min_months, required_kata, required_kumite, min_courses,
           notes, is_hard_block, confirmed, confirmed_at, is_active, updated_at`,
        values
      );

      if (result.rows.length) {
        updated.push(result.rows[0]);
      }
    }

    await client.query('COMMIT');

    res.json(updated.map(r => ({
      id: r.id,
      federation_id: r.federation_id,
      from_belt: r.from_belt,
      to_belt: r.to_belt,
      belt_schema: r.belt_schema || null,
      min_months: r.min_months || null,
      required_kata: r.required_kata || [],
      required_kumite: r.required_kumite || null,
      min_courses: r.min_courses || null,
      notes: r.notes || null,
      is_hard_block: r.is_hard_block,
      confirmed: r.confirmed, // FPKT #2
      confirmed_at: r.confirmed_at || null,
      is_active: r.is_active,
      updated_at: r.updated_at,
    })));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateRequirements] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar critérios', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
