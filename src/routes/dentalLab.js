// ============================================================
// AURA. — D-12: Dental Lab Orders
// D-UNIFY: usa customer_id. Aceita patient_id (body) como alias.
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

async function resolveCustomerId(companyId, body) {
  const id = body.customer_id || body.patient_id;
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT id FROM customers WHERE id=$1 AND company_id=$2 AND is_patient=true`,
    [id, companyId]
  );
  return rows.length ? rows[0].id : null;
}

// GET /companies/:id/dental/lab-orders
router.get('/lab-orders', requireAuth, async (req, res) => {
  const { status, patient_id, customer_id } = req.query;
  const filterCustomer = customer_id || patient_id;
  try {
    const params = [req.params.id];
    let where = 'WHERE lo.company_id=$1';
    if (status) { params.push(status); where += ` AND lo.status=$${params.length}`; }
    if (filterCustomer) { params.push(filterCustomer); where += ` AND lo.customer_id=$${params.length}`; }

    const { rows } = await db.query(
      `SELECT lo.*,
              lo.customer_id AS patient_id,
              c.name AS patient_name
       FROM dental_lab_orders lo
       JOIN customers c ON c.id=lo.customer_id
       ${where}
       ORDER BY CASE lo.status
         WHEN 'pendente' THEN 1 WHEN 'enviado' THEN 2 WHEN 'producao' THEN 3
         WHEN 'pronto' THEN 4 ELSE 5 END, lo.deadline`, params
    );

    const pending = rows.filter(r => r.status === 'pendente').length;
    const inProduction = rows.filter(r => ['enviado','producao'].includes(r.status)).length;
    const ready = rows.filter(r => r.status === 'pronto').length;
    const totalCost = rows.reduce((s, r) => s + parseFloat(r.cost || 0), 0);

    res.json({ total: rows.length, orders: rows, summary: { pending, inProduction, ready, totalCost } });
  } catch (err) {
    console.error('[dentalLab GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar pedidos de laboratorio' });
  }
});

// POST /companies/:id/dental/lab-orders
router.post('/lab-orders', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { plan_id, lab_name, item_type, material, tooth_number, shade, cost, deadline, notes } = req.body;
  if (!lab_name || !item_type) {
    return res.status(400).json({ error: 'lab_name e item_type sao obrigatorios' });
  }
  const customerId = await resolveCustomerId(req.params.id, req.body);
  if (!customerId) return res.status(400).json({ error: 'Paciente (customer_id ou patient_id) invalido' });

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_lab_orders
         (company_id, customer_id, plan_id, lab_name, item_type, material, tooth_number, shade, cost, deadline, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *, customer_id AS patient_id`,
      [req.params.id, customerId, plan_id||null, lab_name, item_type, material||null,
       tooth_number||null, shade||null, cost||0, deadline||null, notes||null, req.user.id]
    );
    res.status(201).json({ order: rows[0] });
  } catch (err) {
    console.error('[dentalLab POST]', err.message);
    res.status(500).json({ error: 'Erro ao criar pedido' });
  }
});

// PATCH /companies/:id/dental/lab-orders/:orderId
router.patch('/lab-orders/:orderId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { status, notes, cost, received_at } = req.body;
  const fields = [], values = [];
  let idx = 1;
  if (status) {
    fields.push(`status=$${idx++}`);
    values.push(status);
    if (status === 'enviado') fields.push('sent_at=NOW()');
    if (status === 'entregue' || received_at) fields.push('received_at=NOW()');
  }
  if (notes !== undefined) { fields.push(`notes=$${idx++}`); values.push(notes); }
  if (cost !== undefined) { fields.push(`cost=$${idx++}`); values.push(cost); }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo' });
  fields.push('updated_at=NOW()');
  values.push(req.params.orderId, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE dental_lab_orders SET ${fields.join(',')}
       WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    res.json({ order: rows[0] });
  } catch (err) {
    console.error('[dentalLab PATCH]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar pedido' });
  }
});

module.exports = router;
