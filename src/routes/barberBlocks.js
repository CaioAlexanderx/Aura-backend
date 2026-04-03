// ============================================================
// AURA. — B-08: Barber Schedule Blocks
// Manage lunch breaks, days off, vacations
// Mounted at: /companies/:id/barbershop/blocks
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET / — list blocks for a date range
router.get('/', requireAuth, async (req, res) => {
  const { professional_id, start, end } = req.query;
  const now = new Date();
  const qStart = start || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const qEnd = end || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();

  try {
    const params = [req.params.id, qStart, qEnd];
    let where = 'WHERE b.company_id=$1 AND b.start_at < $3 AND b.end_at > $2';
    if (professional_id) { params.push(professional_id); where += ` AND b.professional_id=$${params.length}`; }

    const { rows } = await db.query(
      `SELECT b.*, p.name AS professional_name, p.color AS professional_color
       FROM barber_schedule_blocks b
       JOIN barbershop_professionals p ON p.id=b.professional_id
       ${where}
       ORDER BY b.start_at`, params
    );
    res.json({ total: rows.length, blocks: rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar bloqueios' });
  }
});

// POST / — create a block
router.post('/', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { professional_id, block_type = 'block', title, start_at, end_at, recurrence, notes } = req.body;
  if (!professional_id || !start_at || !end_at) {
    return res.status(400).json({ error: 'professional_id, start_at e end_at sao obrigatorios' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO barber_schedule_blocks
         (company_id, professional_id, block_type, title, start_at, end_at, recurrence, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, professional_id, block_type, title || null,
       start_at, end_at, recurrence || null, notes || null]
    );
    res.status(201).json({ block: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar bloqueio' });
  }
});

// DELETE /:blockId
router.delete('/:blockId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM barber_schedule_blocks WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.blockId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bloqueio nao encontrado' });
    res.json({ message: 'Bloqueio removido' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover bloqueio' });
  }
});

module.exports = router;
