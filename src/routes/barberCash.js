// ============================================================
// AURA. — B-04: Barber Cash Register
// Daily open/close, sangria, suprimento, movements
// Mounted at: /companies/:id/barbershop/cash
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');

// GET /cash/current — current open register
router.get('/current', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cr.*, u.name AS opened_by_name,
              (SELECT COALESCE(SUM(CASE WHEN type IN ('venda','suprimento','gorjeta','produto') THEN amount ELSE -amount END),0)
               FROM barber_cash_movements WHERE register_id=cr.id) AS current_balance
       FROM barber_cash_register cr
       LEFT JOIN users u ON u.id=cr.opened_by
       WHERE cr.company_id=$1 AND cr.status='open'
       ORDER BY cr.opened_at DESC LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return res.json({ register: null, message: 'Nenhum caixa aberto' });

    // Get today's movements
    const { rows: movements } = await db.query(
      `SELECT m.*, p.name AS professional_name, u.name AS created_by_name
       FROM barber_cash_movements m
       LEFT JOIN barbershop_professionals p ON p.id=m.professional_id
       LEFT JOIN users u ON u.id=m.created_by
       WHERE m.register_id=$1
       ORDER BY m.created_at DESC`,
      [rows[0].id]
    );

    // Summary
    const summary = { sales: 0, tips: 0, products: 0, sangria: 0, suprimento: 0 };
    for (const m of movements) {
      if (m.type === 'venda') summary.sales += parseFloat(m.amount);
      else if (m.type === 'gorjeta') summary.tips += parseFloat(m.amount);
      else if (m.type === 'produto') summary.products += parseFloat(m.amount);
      else if (m.type === 'sangria') summary.sangria += parseFloat(m.amount);
      else if (m.type === 'suprimento') summary.suprimento += parseFloat(m.amount);
    }

    res.json({ register: rows[0], movements, summary });
  } catch (err) {
    console.error('cash current error:', err);
    res.status(500).json({ error: 'Erro ao buscar caixa' });
  }
});

// POST /cash/open — open new register
router.post('/open', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { opening_amount = 0 } = req.body;
  try {
    // Check if there's already an open register
    const { rows: existing } = await db.query(
      'SELECT id FROM barber_cash_register WHERE company_id=$1 AND status=$2',
      [req.params.id, 'open']
    );
    if (existing.length) return res.status(409).json({ error: 'Ja existe um caixa aberto. Feche antes de abrir outro.' });

    const { rows } = await db.query(
      `INSERT INTO barber_cash_register (company_id, opened_by, opening_amount)
       VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, req.user.id, opening_amount]
    );
    logAuditAction(req.user.id, req.params.id, 'cash_opened', `Caixa aberto com R$ ${opening_amount}`);
    res.status(201).json({ register: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao abrir caixa' });
  }
});

// POST /cash/close — close register
router.post('/close', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { closing_amount, notes } = req.body;
  if (closing_amount === undefined) return res.status(400).json({ error: 'closing_amount e obrigatorio' });
  try {
    const { rows: regs } = await db.query(
      'SELECT * FROM barber_cash_register WHERE company_id=$1 AND status=$2',
      [req.params.id, 'open']
    );
    if (!regs.length) return res.status(404).json({ error: 'Nenhum caixa aberto' });

    const reg = regs[0];
    // Calculate expected
    const { rows: sumRows } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('venda','suprimento','gorjeta','produto') THEN amount ELSE -amount END),0) AS balance
       FROM barber_cash_movements WHERE register_id=$1`, [reg.id]
    );
    const expected = parseFloat(reg.opening_amount) + parseFloat(sumRows[0].balance);
    const difference = parseFloat(closing_amount) - expected;

    const { rows } = await db.query(
      `UPDATE barber_cash_register SET status='closed', closed_by=$1, closed_at=NOW(),
       closing_amount=$2, expected_amount=$3, difference=$4, notes=$5
       WHERE id=$6 RETURNING *`,
      [req.user.id, closing_amount, Math.round(expected * 100) / 100,
       Math.round(difference * 100) / 100, notes || null, reg.id]
    );
    logAuditAction(req.user.id, req.params.id, 'cash_closed',
      `Caixa fechado. Esperado: R$ ${expected.toFixed(2)}, Informado: R$ ${closing_amount}, Dif: R$ ${difference.toFixed(2)}`);
    res.json({ register: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao fechar caixa' });
  }
});

// POST /cash/movement — add sangria, suprimento, or manual entry
router.post('/movement', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { type, amount, description, payment_method, professional_id } = req.body;
  const validTypes = ['venda', 'sangria', 'suprimento', 'gorjeta', 'produto', 'ajuste'];
  if (!type || !validTypes.includes(type)) return res.status(400).json({ error: `type deve ser: ${validTypes.join(', ')}` });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount deve ser positivo' });

  try {
    const { rows: regs } = await db.query(
      'SELECT id FROM barber_cash_register WHERE company_id=$1 AND status=$2', [req.params.id, 'open']
    );
    if (!regs.length) return res.status(409).json({ error: 'Nenhum caixa aberto' });

    const { rows } = await db.query(
      `INSERT INTO barber_cash_movements
         (company_id, register_id, type, amount, payment_method, description, professional_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, regs[0].id, type, amount, payment_method || null,
       description || null, professional_id || null, req.user.id]
    );
    res.status(201).json({ movement: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar movimentacao' });
  }
});

module.exports = router;
