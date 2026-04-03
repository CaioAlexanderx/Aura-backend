// ============================================================
// AURA. — Módulo Barbearia/Salão (BE-11 + S5)
// Sub-routes: cash (B-04), blocks (B-08)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/professionals', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, sp.name AS partner_name FROM barbershop_professionals p
       LEFT JOIN salon_partners sp ON sp.id=p.salon_partner_id
       WHERE p.company_id=$1 ORDER BY p.name`,
      [req.params.id]
    );
    res.json({ total: rows.length, professionals: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar profissionais' }); }
});

router.post('/professionals', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { name, phone, color, commission_pct=0, salon_partner_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name é obrigatório' });
  try {
    const { rows } = await db.query(
      `INSERT INTO barbershop_professionals (company_id, name, phone, color, commission_pct, salon_partner_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, name, phone||null, color||'#6d28d9', commission_pct, salon_partner_id||null]
    );
    res.status(201).json({ professional: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao criar profissional' }); }
});

router.patch('/professionals/:pid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const allowed = ['name','phone','color','commission_pct','salon_partner_id','is_active'];
  const fields=[], values=[]; let idx=1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key}=$${idx++}`); values.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  fields.push(`updated_at=NOW()`);
  values.push(req.params.pid, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE barbershop_professionals SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Profissional não encontrado' });
    res.json({ professional: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar profissional' }); }
});

router.get('/services', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM barbershop_services WHERE company_id=$1 AND active=true ORDER BY name`, [req.params.id]
    );
    res.json({ total: rows.length, services: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar serviços' }); }
});

router.post('/services', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { name, description, duration_min=30, price, commission_pct } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'name e price são obrigatórios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO barbershop_services (company_id, name, description, duration_min, price, commission_pct)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, name, description||null, duration_min, price, commission_pct||null]
    );
    res.status(201).json({ service: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao criar serviço' }); }
});

router.patch('/services/:sid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const allowed = ['name','description','duration_min','price','commission_pct','active'];
  const fields=[], values=[]; let idx=1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key}=$${idx++}`); values.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  fields.push(`updated_at=NOW()`);
  values.push(req.params.sid, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE barbershop_services SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Serviço não encontrado' });
    res.json({ service: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar serviço' }); }
});

router.get('/agenda', requireAuth, async (req, res) => {
  const now = new Date();
  const start = req.query.start || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end   = req.query.end   || new Date(now.getFullYear(), now.getMonth(), now.getDate()+1).toISOString();
  const { professional_id } = req.query;
  try {
    const params = [req.params.id, start, end];
    let profFilter = '';
    if (professional_id) { params.push(professional_id); profFilter = `AND a.professional_id=$${params.length}`; }
    const { rows } = await db.query(
      `SELECT a.*, p.name AS professional_name, p.color AS professional_color,
              COALESCE(c.name, a.customer_name) AS client_name, a.customer_phone,
              a.tip_amount, a.payment_method
       FROM barbershop_appointments a
       JOIN barbershop_professionals p ON p.id=a.professional_id
       LEFT JOIN customers c ON c.id=a.customer_id
       WHERE a.company_id=$1 AND a.scheduled_at>=$2 AND a.scheduled_at<$3
         AND a.status NOT IN ('cancelado') ${profFilter}
       ORDER BY a.scheduled_at, p.name`, params
    );
    res.json({ start, end, total: rows.length, appointments: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar agenda' }); }
});

router.post('/appointments', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { professional_id, customer_id, customer_name, customer_phone,
          scheduled_at, duration_min=30, services=[], deposit_amount=0, notes } = req.body;
  if (!professional_id || !scheduled_at) return res.status(400).json({ error: 'professional_id e scheduled_at são obrigatórios' });
  if (!customer_id && !customer_name) return res.status(400).json({ error: 'Informe customer_id ou customer_name' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let totalAmount=0, commissionAmount=0;
    const serviceRows = [];
    for (const svc of services) {
      const price   = parseFloat(svc.price_override || svc.price || 0);
      const commPct = parseFloat(svc.commission_pct_override ?? svc.commission_pct ?? 0);
      const comm    = Math.round(price * commPct) / 100;
      totalAmount += price; commissionAmount += comm;
      serviceRows.push({ ...svc, price, commPct, comm });
    }
    const { rows: apptRows } = await client.query(
      `INSERT INTO barbershop_appointments
         (company_id, professional_id, customer_id, customer_name, customer_phone,
          scheduled_at, duration_min, total_amount, commission_amount, deposit_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, professional_id, customer_id||null, customer_name||null,
       customer_phone||null, scheduled_at, duration_min,
       Math.round(totalAmount*100)/100, Math.round(commissionAmount*100)/100, deposit_amount, notes||null]
    );
    const appt = apptRows[0];
    for (const svc of serviceRows) {
      await client.query(
        `INSERT INTO barbershop_appointment_services
           (appointment_id, service_id, service_name, price, commission_pct, commission_amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [appt.id, svc.service_id||null, svc.service_name||svc.name, svc.price, svc.commPct, svc.comm]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ appointment: { ...appt, services: serviceRows } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao criar agendamento' });
  } finally { client.release(); }
});

// B-05: Updated to include tip_amount and payment_method
router.patch('/appointments/:aid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { status, notes, cancel_reason, tip_amount, payment_method } = req.body;
  try {
    const tsMap = { em_atendimento:'started_at', concluido:'concluded_at', cancelado:'cancelled_at' };
    const tsField = status && tsMap[status] ? `, ${tsMap[status]}=NOW()` : '';
    const fields=[], values=[]; let idx=1;
    if (status)         { fields.push(`status=$${idx++}::barber_appointment_status`); values.push(status); }
    if (notes)          { fields.push(`notes=$${idx++}`);          values.push(notes); }
    if (cancel_reason)  { fields.push(`cancel_reason=$${idx++}`);  values.push(cancel_reason); }
    if (tip_amount !== undefined)    { fields.push(`tip_amount=$${idx++}`);    values.push(tip_amount); }
    if (payment_method) { fields.push(`payment_method=$${idx++}`); values.push(payment_method); }
    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    fields.push(`updated_at=NOW()`);
    values.push(req.params.aid, req.params.id);
    const { rows } = await db.query(
      `UPDATE barbershop_appointments SET ${fields.join(',')}${tsField}
       WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json({ appointment: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar agendamento' }); }
});

router.get('/queue', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT q.*, p.name AS professional_name FROM barbershop_queue q
       LEFT JOIN barbershop_professionals p ON p.id=q.professional_id
       WHERE q.company_id=$1 AND q.status IN ('waiting','called','in_service')
       ORDER BY q.position, q.entered_at`, [req.params.id]
    );
    res.json({ total: rows.length, queue: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar fila' }); }
});

router.post('/queue', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { customer_name, customer_phone, service_id, service_name, professional_id } = req.body;
  if (!customer_name) return res.status(400).json({ error: 'customer_name é obrigatório' });
  try {
    const { rows: pos } = await db.query(
      `SELECT COALESCE(MAX(position),0)+1 AS next FROM barbershop_queue
       WHERE company_id=$1 AND status IN ('waiting','called','in_service')`, [req.params.id]
    );
    const { rows } = await db.query(
      `INSERT INTO barbershop_queue
         (company_id, customer_name, customer_phone, service_id, service_name, professional_id, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, customer_name, customer_phone||null, service_id||null,
       service_name||null, professional_id||null, pos[0].next]
    );
    res.status(201).json({ entry: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao entrar na fila' }); }
});

router.patch('/queue/:qid/call', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE barbershop_queue SET status='called', called_at=NOW()
       WHERE id=$1 AND company_id=$2 AND status='waiting' RETURNING *`,
      [req.params.qid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado na fila' });
    res.json({ entry: rows[0], message: `${rows[0].customer_name} chamado(a)!` });
  } catch (err) { res.status(500).json({ error: 'Erro ao chamar cliente' }); }
});

router.patch('/queue/:qid/done', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE barbershop_queue SET status='done', done_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.qid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Entrada não encontrada' });
    res.json({ entry: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao finalizar fila' }); }
});

router.get('/customers/:cid/cut-history', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT h.*, p.name AS professional_name FROM barbershop_cut_history h
       LEFT JOIN barbershop_professionals p ON p.id=h.professional_id
       WHERE h.company_id=$1 AND h.customer_id=$2 ORDER BY h.recorded_at DESC LIMIT 20`,
      [req.params.id, req.params.cid]
    );
    res.json({ total: rows.length, history: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar histórico' }); }
});

router.post('/cut-history', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { customer_id, professional_id, appointment_id, machine_number, technique, photo_url, notes } = req.body;
  if (!customer_id) return res.status(400).json({ error: 'customer_id é obrigatório' });
  try {
    const { rows } = await db.query(
      `INSERT INTO barbershop_cut_history
         (company_id, customer_id, professional_id, appointment_id, machine_number, technique, photo_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, customer_id, professional_id||null, appointment_id||null,
       machine_number||null, technique||null, photo_url||null, notes||null]
    );
    res.status(201).json({ entry: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao registrar histórico' }); }
});

// ── B-04: Cash Register sub-routes ────────────────────────
router.use('/cash', require('./barberCash'));

// ── B-08: Schedule Blocks sub-routes ──────────────────────
router.use('/blocks', require('./barberBlocks'));

module.exports = router;
