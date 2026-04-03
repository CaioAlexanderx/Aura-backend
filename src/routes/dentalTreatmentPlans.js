// ============================================================
// AURA. — D-02: Dental Treatment Plans (Orcamentos)
// CRUD for treatment plans with items and installments
// Mounted at: /companies/:id/dental/treatment-plans
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');

// ── LIST treatment plans (with filters) ─────────────────
router.get('/', requireAuth, async (req, res) => {
  const { status, patient_id } = req.query;
  try {
    const params = [req.params.id];
    let where = 'WHERE tp.company_id=$1';
    if (status) { params.push(status); where += ` AND tp.status=$${params.length}::dental_plan_status`; }
    if (patient_id) { params.push(patient_id); where += ` AND tp.patient_id=$${params.length}`; }

    const { rows } = await db.query(
      `SELECT tp.*, p.full_name AS patient_name, p.phone AS patient_phone,
              (SELECT COUNT(*) FROM dental_treatment_plan_items WHERE plan_id=tp.id) AS items_count,
              (SELECT COUNT(*) FROM dental_treatment_plan_items WHERE plan_id=tp.id AND status='concluido') AS items_done
       FROM dental_treatment_plans tp
       JOIN dental_patients p ON p.id=tp.patient_id
       ${where}
       ORDER BY tp.created_at DESC`, params
    );
    
    // Funnel stats
    const { rows: funnel } = await db.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total),0)::numeric AS total_value
       FROM dental_treatment_plans WHERE company_id=$1
       GROUP BY status`, [req.params.id]
    );

    res.json({ total: rows.length, plans: rows, funnel });
  } catch (err) {
    console.error('treatment plans list error:', err);
    res.status(500).json({ error: 'Erro ao listar orcamentos' });
  }
});

// ── GET single plan with items + installments ────────────
router.get('/:planId', requireAuth, async (req, res) => {
  try {
    const { rows: plans } = await db.query(
      `SELECT tp.*, p.full_name AS patient_name, p.phone AS patient_phone, p.email AS patient_email
       FROM dental_treatment_plans tp
       JOIN dental_patients p ON p.id=tp.patient_id
       WHERE tp.id=$1 AND tp.company_id=$2`,
      [req.params.planId, req.params.id]
    );
    if (!plans.length) return res.status(404).json({ error: 'Orcamento nao encontrado' });

    const { rows: items } = await db.query(
      'SELECT * FROM dental_treatment_plan_items WHERE plan_id=$1 ORDER BY sort_order, created_at',
      [req.params.planId]
    );
    const { rows: installments } = await db.query(
      'SELECT * FROM dental_treatment_plan_installments WHERE plan_id=$1 ORDER BY installment_number',
      [req.params.planId]
    );

    res.json({ plan: { ...plans[0], items, installments } });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar orcamento' });
  }
});

// ── CREATE treatment plan ────────────────────────────
router.post('/', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { patient_id, items = [], discount_pct = 0, notes, valid_until } = req.body;
  if (!patient_id) return res.status(400).json({ error: 'patient_id e obrigatorio' });
  if (!items.length) return res.status(400).json({ error: 'Adicione pelo menos um procedimento' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Calculate totals
    let subtotal = 0;
    for (const item of items) { subtotal += parseFloat(item.price || 0); }
    const discountAmount = Math.round(subtotal * discount_pct) / 100;
    const total = Math.round((subtotal - discountAmount) * 100) / 100;

    // Create plan
    const { rows: [plan] } = await client.query(
      `INSERT INTO dental_treatment_plans
         (company_id, patient_id, subtotal, discount_pct, discount_amount, total, notes, valid_until, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, patient_id, subtotal, discount_pct, discountAmount, total,
       notes||null, valid_until||null, req.user.id]
    );

    // Insert items
    const insertedItems = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const { rows: [row] } = await client.query(
        `INSERT INTO dental_treatment_plan_items
           (plan_id, procedure_id, procedure_name, tooth_number, face, price, notes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [plan.id, it.procedure_id||null, it.procedure_name||it.name,
         it.tooth_number||null, it.face||null, it.price||0, it.notes||null, i]
      );
      insertedItems.push(row);
    }

    await client.query('COMMIT');

    logAuditAction(req.user.id, req.params.id, 'treatment_plan_created',
      `Plan ${plan.plan_number} for patient ${patient_id} — R$ ${total}`);

    res.status(201).json({ plan: { ...plan, items: insertedItems } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('create treatment plan error:', err);
    res.status(500).json({ error: 'Erro ao criar orcamento' });
  } finally { client.release(); }
});

// ── UPDATE plan status ───────────────────────────────
router.patch('/:planId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { status, discount_pct, notes, valid_until } = req.body;
  const fields = [], values = [];
  let idx = 1;

  if (status) {
    fields.push(`status=$${idx++}::dental_plan_status`);
    values.push(status);
    if (status === 'aprovado') { fields.push(`approved_at=NOW()`); }
  }
  if (discount_pct !== undefined) {
    fields.push(`discount_pct=$${idx++}`);
    values.push(discount_pct);
  }
  if (notes !== undefined) { fields.push(`notes=$${idx++}`); values.push(notes); }
  if (valid_until !== undefined) { fields.push(`valid_until=$${idx++}`); values.push(valid_until); }

  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo' });
  fields.push('updated_at=NOW()');
  values.push(req.params.planId, req.params.id);

  try {
    const { rows } = await db.query(
      `UPDATE dental_treatment_plans SET ${fields.join(',')}
       WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Orcamento nao encontrado' });

    // Recalc if discount changed
    if (discount_pct !== undefined) {
      const { rows: items } = await db.query(
        'SELECT price FROM dental_treatment_plan_items WHERE plan_id=$1', [req.params.planId]
      );
      const subtotal = items.reduce((s, i) => s + parseFloat(i.price), 0);
      const discountAmount = Math.round(subtotal * discount_pct) / 100;
      const total = Math.round((subtotal - discountAmount) * 100) / 100;
      await db.query(
        'UPDATE dental_treatment_plans SET subtotal=$1, discount_amount=$2, total=$3 WHERE id=$4',
        [subtotal, discountAmount, total, req.params.planId]
      );
      rows[0].subtotal = subtotal;
      rows[0].discount_amount = discountAmount;
      rows[0].total = total;
    }

    logAuditAction(req.user.id, req.params.id, 'treatment_plan_updated',
      `Plan ${rows[0].plan_number} status=${status || 'unchanged'}`);

    res.json({ plan: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar orcamento' });
  }
});

// ── GENERATE installments ────────────────────────────
router.post('/:planId/installments', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { count = 1, first_due_date } = req.body;
  if (count < 1 || count > 24) return res.status(400).json({ error: 'Parcelas entre 1 e 24' });

  try {
    const { rows: plans } = await db.query(
      'SELECT total FROM dental_treatment_plans WHERE id=$1 AND company_id=$2',
      [req.params.planId, req.params.id]
    );
    if (!plans.length) return res.status(404).json({ error: 'Orcamento nao encontrado' });

    const total = parseFloat(plans[0].total);
    const installmentAmount = Math.floor(total / count * 100) / 100;
    const remainder = Math.round((total - installmentAmount * count) * 100) / 100;

    // Clear existing installments
    await db.query('DELETE FROM dental_treatment_plan_installments WHERE plan_id=$1', [req.params.planId]);

    const baseDate = first_due_date ? new Date(first_due_date) : new Date();
    const installments = [];

    for (let i = 0; i < count; i++) {
      const dueDate = new Date(baseDate);
      dueDate.setMonth(dueDate.getMonth() + i);
      const amount = i === 0 ? installmentAmount + remainder : installmentAmount;

      const { rows: [inst] } = await db.query(
        `INSERT INTO dental_treatment_plan_installments
           (plan_id, installment_number, amount, due_date)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.planId, i + 1, amount, dueDate.toISOString().split('T')[0]]
      );
      installments.push(inst);
    }

    res.status(201).json({ count, total, installments });
  } catch (err) {
    console.error('installments error:', err);
    res.status(500).json({ error: 'Erro ao gerar parcelas' });
  }
});

module.exports = router;
