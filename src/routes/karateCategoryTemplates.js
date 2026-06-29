// ============================================================
// AURA KARATÊ — Rotas de Templates de Categoria (biblioteca reutilizável)
// Montado em /federation/:id (igual aos Tracks B/C/E).
//
//   GET    /category-templates             — lista templates ativos (read)
//   POST   /category-templates             — cria template (staffWrite)
//   PATCH  /category-templates/:tid         — edita template (staffWrite)
//   DELETE /category-templates/:tid         — arquiva template (staffWrite, soft-delete)
//
// Migration 196: karate_competition_category_templates.
// Espelha as colunas de karate_competition_categories (sem competition_id),
// + federation_id + soft-delete (archived_at). Decisão Caio: o template guarda
// a definição COMPLETA, incluindo taxa/vagas como padrão reutilizável.
//
// Defensive 42P01: seguro mergear/deployar antes da migration ser aplicada
// (GET devolve [] e POST devolve 503 MIGRATION_PENDING em vez de 500).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

const MODALITIES = ['kata', 'kumite', 'kihon_ippon', 'team_kata', 'team_kumite'];
const SEXES = ['M', 'F', 'mixed'];

function mapRow(r) {
  return {
    id: r.id,
    federation_id: r.federation_id,
    name: r.name,
    modality: r.modality,
    min_age: r.min_age != null ? r.min_age : null,
    max_age: r.max_age != null ? r.max_age : null,
    belt_min: r.belt_min || null,
    belt_max: r.belt_max || null,
    sex: r.sex,
    weight_class: r.weight_class || null,
    max_entries: r.max_entries != null ? r.max_entries : null,
    fee_amount: r.fee_amount != null ? r.fee_amount : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const SELECT_COLS = `id, federation_id, name, modality, min_age, max_age, belt_min,
  belt_max, sex, weight_class, max_entries, fee_amount, created_at, updated_at`;

// ── GET /category-templates ──
router.get('/category-templates', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT ${SELECT_COLS}
       FROM karate_competition_category_templates
       WHERE federation_id = $1 AND archived_at IS NULL
       ORDER BY name ASC`,
      [federationId]
    );
    res.json(rows.map(mapRow));
  } catch (err) {
    if (err.code === '42P01') return res.json([]); // tabela ainda não migrada
    console.error('[karateCategoryTemplates] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar templates de categoria' });
  }
});

// ── POST /category-templates ──
router.post('/category-templates', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const { name, modality, min_age, max_age, belt_min, belt_max, sex, weight_class, max_entries, fee_amount } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(422).json({ error: 'name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!modality || !MODALITIES.includes(modality)) {
    return res.status(422).json({ error: `modality deve ser: ${MODALITIES.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  const sexVal = sex || 'mixed';
  if (!SEXES.includes(sexVal)) {
    return res.status(422).json({ error: 'sex deve ser: M, F, mixed', code: 'VALIDATION_ERROR' });
  }

  const toInt = (v) => (v != null && v !== '' ? parseInt(v, 10) : null);
  const toNum = (v) => (v != null && v !== '' ? parseFloat(v) : null);

  try {
    const ins = await db.query(
      `INSERT INTO karate_competition_category_templates
         (federation_id, name, modality, min_age, max_age, belt_min, belt_max,
          sex, weight_class, max_entries, fee_amount, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), NOW())
       RETURNING ${SELECT_COLS}`,
      [
        federationId, String(name).trim(), modality,
        toInt(min_age), toInt(max_age),
        belt_min || null, belt_max || null, sexVal,
        weight_class || null, toInt(max_entries), toNum(fee_amount),
        req.user && req.user.id ? req.user.id : null,
      ]
    );
    res.status(201).json(mapRow(ins.rows[0]));
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(503).json({ error: 'Biblioteca de categorias indisponível (migração pendente)', code: 'MIGRATION_PENDING' });
    }
    console.error('[karateCategoryTemplates] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar template de categoria', detail: err.message });
  }
});

// ── PATCH /category-templates/:tid ──
router.patch('/category-templates/:tid', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, tid } = req.params;
  const ALLOWED = ['name', 'modality', 'min_age', 'max_age', 'belt_min', 'belt_max', 'sex', 'weight_class', 'max_entries', 'fee_amount'];

  if (req.body.modality !== undefined && !MODALITIES.includes(req.body.modality)) {
    return res.status(422).json({ error: `modality deve ser: ${MODALITIES.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  if (req.body.sex !== undefined && !SEXES.includes(req.body.sex)) {
    return res.status(422).json({ error: 'sex deve ser: M, F, mixed', code: 'VALIDATION_ERROR' });
  }

  const updates = [];
  const values = [];
  let idx = 1;
  for (const field of ALLOWED) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${idx}`);
      values.push(req.body[field] === '' ? null : req.body[field]);
      idx++;
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()');
  values.push(tid, federationId);

  try {
    const result = await db.query(
      `UPDATE karate_competition_category_templates SET ${updates.join(', ')}
       WHERE id = $${idx} AND federation_id = $${idx + 1} AND archived_at IS NULL
       RETURNING ${SELECT_COLS}`,
      values
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Template não encontrado', code: 'NOT_FOUND' });
    }
    res.json(mapRow(result.rows[0]));
  } catch (err) {
    console.error('[karateCategoryTemplates] patch error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar template de categoria' });
  }
});

// ── DELETE /category-templates/:tid (soft-delete) ──
router.delete('/category-templates/:tid', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, tid } = req.params;
  try {
    const result = await db.query(
      `UPDATE karate_competition_category_templates
       SET archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND federation_id = $2 AND archived_at IS NULL
       RETURNING id`,
      [tid, federationId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Template não encontrado', code: 'NOT_FOUND' });
    }
    res.json({ id: tid, archived: true });
  } catch (err) {
    console.error('[karateCategoryTemplates] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao arquivar template de categoria' });
  }
});

module.exports = router;
