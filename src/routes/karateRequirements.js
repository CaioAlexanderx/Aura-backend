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
  const { target_belt, confirmed } = req.query;

  try {
    const conditions = ['federation_id = $1', 'is_active = true'];
    const params = [federationId];
    let n = 2;

    if (target_belt !== undefined) {
      conditions.push(`target_belt_level = $${n}`);
      params.push(parseInt(target_belt, 10));
      n++;
    }
    // Filtro por confirmed (opcional)
    if (confirmed === 'true' || confirmed === 'false') {
      conditions.push(`confirmed = $${n}`);
      params.push(confirmed === 'true');
      n++;
    }

    const { rows } = await db.query(
      `SELECT
         id, federation_id, target_belt_level, target_belt_name,
         criterion, required_value, unit, description,
         confirmed,        -- FPKT #2: expõe status provisório
         sort_order, is_active, created_at, updated_at
       FROM karate_belt_requirements
       WHERE ${conditions.join(' AND ')}
       ORDER BY target_belt_level ASC, sort_order ASC, criterion ASC`,
      params
    );

    res.json(rows.map(r => ({
      id: r.id,
      federation_id: r.federation_id,
      target_belt_level: r.target_belt_level,
      target_belt_name: r.target_belt_name || null,
      criterion: r.criterion,
      required_value: r.required_value,
      unit: r.unit || null,
      description: r.description || null,
      confirmed: r.confirmed,          // FPKT #2: provisório enquanto false
      sort_order: r.sort_order || null,
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
      const { id, required_value, unit, description, confirmed, sort_order } = req_item;

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

      if (required_value !== undefined) {
        updates.push(`required_value = $${idx}`);
        values.push(String(required_value));
        idx++;
      }
      if (unit !== undefined) {
        updates.push(`unit = $${idx}`);
        values.push(unit);
        idx++;
      }
      if (description !== undefined) {
        updates.push(`description = $${idx}`);
        values.push(description);
        idx++;
      }
      if (confirmed !== undefined) {
        // FPKT #2: permite marcar confirmed
        updates.push(`confirmed = $${idx}`);
        values.push(Boolean(confirmed));
        idx++;
      }
      if (sort_order !== undefined) {
        updates.push(`sort_order = $${idx}`);
        values.push(parseInt(sort_order, 10));
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
           id, federation_id, target_belt_level, target_belt_name,
           criterion, required_value, unit, description,
           confirmed, sort_order, is_active, updated_at`,
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
      target_belt_level: r.target_belt_level,
      target_belt_name: r.target_belt_name || null,
      criterion: r.criterion,
      required_value: r.required_value,
      unit: r.unit || null,
      description: r.description || null,
      confirmed: r.confirmed, // FPKT #2
      sort_order: r.sort_order || null,
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
