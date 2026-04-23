// ============================================================
// AURA. — D-FIX #6: Dental Practitioners (CRUD)
// Mounted at: /companies/:id/dental/practitioners
// + Settings endpoint at /companies/:id/dental/settings
//
// Migration 049 cria:
//   - tabela dental_practitioners (id, name, cro, specialty, color, ...)
//   - companies.dental_settings jsonb
//     ({ chairs_active: [bool, ...], chair_practitioner_ids: [uuid|null, ...] })
//
// Plano define max chairs:
//   - essencial:    1 (sem opcao de odonto, mas defensivo)
//   - negocio:      2
//   - expansao+:    4
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

function getMaxChairs(plan) {
  switch ((plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 4;
    case 'negocio':       return 2;
    default:              return 1;
  }
}

// Default settings: 1 cadeira ativa + N-1 inativas (limpa a UI)
function buildDefaultSettings(plan) {
  const max = getMaxChairs(plan);
  const chairs_active = Array(max).fill(false);
  chairs_active[0] = true;  // primeira sempre ativa
  return {
    chairs_active,
    chair_practitioner_ids: Array(max).fill(null),
  };
}

// Normaliza settings vindo do DB pra ter todas as keys e tamanho correto.
function normalizeSettings(raw, plan) {
  const max = getMaxChairs(plan);
  const def = buildDefaultSettings(plan);
  if (!raw || typeof raw !== 'object') return def;

  const chairs_active = Array.isArray(raw.chairs_active) ? raw.chairs_active.slice(0, max) : [];
  while (chairs_active.length < max) chairs_active.push(false);
  if (!chairs_active.some(Boolean)) chairs_active[0] = true;  // garante 1 ativa

  const chair_practitioner_ids = Array.isArray(raw.chair_practitioner_ids)
    ? raw.chair_practitioner_ids.slice(0, max)
    : [];
  while (chair_practitioner_ids.length < max) chair_practitioner_ids.push(null);

  return { chairs_active, chair_practitioner_ids };
}

// ===== SETTINGS =====

// GET /companies/:id/dental/settings
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT dental_settings, plan FROM companies WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const settings = normalizeSettings(rows[0].dental_settings, rows[0].plan);
    res.json({ settings, plan: rows[0].plan, max_chairs: getMaxChairs(rows[0].plan) });
  } catch (err) {
    console.error('[dentalSettings GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar configuracoes' });
  }
});

// PUT /companies/:id/dental/settings
router.put('/settings', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { chairs_active, chair_practitioner_ids } = req.body || {};
  try {
    const { rows: companyRows } = await db.query('SELECT plan FROM companies WHERE id = $1', [req.params.id]);
    if (!companyRows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });

    const max = getMaxChairs(companyRows[0].plan);
    const newSettings = normalizeSettings({ chairs_active, chair_practitioner_ids }, companyRows[0].plan);

    // Valida: practitioner_ids fornecidos devem existir e pertencer a empresa
    const ids = newSettings.chair_practitioner_ids.filter(Boolean);
    if (ids.length > 0) {
      const { rows: validIds } = await db.query(
        'SELECT id FROM dental_practitioners WHERE company_id = $1 AND id = ANY($2::uuid[])',
        [req.params.id, ids]
      );
      const validSet = new Set(validIds.map(r => r.id));
      newSettings.chair_practitioner_ids = newSettings.chair_practitioner_ids.map(id => id && validSet.has(id) ? id : null);
    }

    await db.query(
      'UPDATE companies SET dental_settings = $1::jsonb WHERE id = $2',
      [JSON.stringify(newSettings), req.params.id]
    );
    res.json({ settings: newSettings, plan: companyRows[0].plan, max_chairs: max });
  } catch (err) {
    console.error('[dentalSettings PUT]', err.message);
    res.status(500).json({ error: 'Erro ao salvar configuracoes' });
  }
});

// ===== PRACTITIONERS CRUD =====

// GET /companies/:id/dental/practitioners
// Auto-cria o owner (a partir do nome do owner da company) na primeira chamada
// se nao tiver nenhum dentista cadastrado ainda.
router.get('/practitioners', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, cro, specialty, color, email, phone, is_active, is_owner, created_at, updated_at
       FROM dental_practitioners
       WHERE company_id = $1
       ORDER BY is_owner DESC, is_active DESC, name ASC`,
      [req.params.id]
    );

    // Auto-bootstrap: se nao tem nenhum dentista, cria um placeholder pro owner
    if (rows.length === 0) {
      const { rows: ownerRows } = await db.query(
        `SELECT u.name FROM users u
         JOIN company_members m ON m.user_id = u.id
         WHERE m.company_id = $1 AND m.role = 'owner'
         LIMIT 1`,
        [req.params.id]
      );
      const ownerName = ownerRows[0]?.name || 'Dentista responsavel';
      const { rows: created } = await db.query(
        `INSERT INTO dental_practitioners (company_id, name, is_owner, color)
         VALUES ($1, $2, true, '#06B6D4') RETURNING *`,
        [req.params.id, ownerName]
      );
      return res.json({ total: 1, practitioners: created, bootstrapped: true });
    }

    res.json({ total: rows.length, practitioners: rows });
  } catch (err) {
    console.error('[practitioners GET]', err.message);
    res.status(500).json({ error: 'Erro ao listar dentistas' });
  }
});

// POST /companies/:id/dental/practitioners
router.post('/practitioners', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { name, cro, specialty, color, email, phone } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Nome do dentista eh obrigatorio' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_practitioners (company_id, name, cro, specialty, color, email, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        req.params.id, String(name).trim(),
        cro || null, specialty || null,
        color && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#06B6D4',
        email || null, phone || null,
      ]
    );
    res.status(201).json({ practitioner: rows[0] });
  } catch (err) {
    console.error('[practitioners POST]', err.message);
    res.status(500).json({ error: 'Erro ao cadastrar dentista' });
  }
});

// PATCH /companies/:id/dental/practitioners/:pid
router.patch('/practitioners/:pid', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { name, cro, specialty, color, email, phone, is_active } = req.body || {};
  const fields = [], values = [];
  let idx = 1;
  if (name !== undefined)      { fields.push(`name = $${idx++}`);      values.push(String(name).trim()); }
  if (cro !== undefined)       { fields.push(`cro = $${idx++}`);       values.push(cro || null); }
  if (specialty !== undefined) { fields.push(`specialty = $${idx++}`); values.push(specialty || null); }
  if (color !== undefined) {
    const c = color && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#06B6D4';
    fields.push(`color = $${idx++}`); values.push(c);
  }
  if (email !== undefined)     { fields.push(`email = $${idx++}`);     values.push(email || null); }
  if (phone !== undefined)     { fields.push(`phone = $${idx++}`);     values.push(phone || null); }
  if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(!!is_active); }

  if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  values.push(req.params.pid, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE dental_practitioners SET ${fields.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Dentista nao encontrado' });
    res.json({ practitioner: rows[0] });
  } catch (err) {
    console.error('[practitioners PATCH]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar dentista' });
  }
});

// DELETE /companies/:id/dental/practitioners/:pid
// Owner nao pode ser deletado (so desativado via PATCH).
router.delete('/practitioners/:pid', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  try {
    const { rows: check } = await db.query(
      'SELECT is_owner FROM dental_practitioners WHERE id = $1 AND company_id = $2',
      [req.params.pid, req.params.id]
    );
    if (!check.length) return res.status(404).json({ error: 'Dentista nao encontrado' });
    if (check[0].is_owner) {
      return res.status(403).json({ error: 'Dentista responsavel nao pode ser excluido. Desative-o em vez disso.' });
    }
    await db.query('DELETE FROM dental_practitioners WHERE id = $1 AND company_id = $2', [req.params.pid, req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Dentista vinculado a agendamentos. Desative-o em vez de excluir.' });
    }
    console.error('[practitioners DELETE]', err.message);
    res.status(500).json({ error: 'Erro ao excluir dentista' });
  }
});

module.exports = router;
