// ============================================================
// AURA. — ODT-01: Funil de Vendas Odonto
// D-UNIFY: dental_leads.customer_id (paciente = customer).
// convert: cria customer com is_patient=true (NAO mais dental_patients).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/funnel', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT l.*,
              l.customer_id AS patient_id,
              e.name AS assigned_name,
              c.name AS patient_name
       FROM dental_leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
       LEFT JOIN customers c ON c.id = l.customer_id
       WHERE l.company_id = $1
       ORDER BY l.stage_changed_at DESC`, [cid]);
    const stages = ['lead','contacted','evaluation_scheduled','evaluation_done','budget_sent','budget_approved','in_treatment','completed','lost'];
    const byStage = {};
    for (const s of stages) byStage[s] = { stage: s, count: 0, value: 0, leads: [] };
    for (const r of rows) {
      if (byStage[r.stage]) {
        byStage[r.stage].count++;
        byStage[r.stage].value += parseFloat(r.treatment_value) || 0;
        byStage[r.stage].leads.push(r);
      }
    }
    res.json({ stages: Object.values(byStage), total: rows.length });
  } catch (err) {
    console.error('[dentalFunnel GET /funnel]', err.message);
    res.status(500).json({ error: 'Erro ao buscar funil' });
  }
});

router.get('/funnel/stats', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { months = 3 } = req.query;
  try {
    const since = new Date(); since.setMonth(since.getMonth() - parseInt(months));
    const { rows: [counts] } = await db.query(
      `SELECT
         COUNT(*) AS total_leads,
         COUNT(CASE WHEN stage IN ('budget_sent','budget_approved','in_treatment','completed') THEN 1 END) AS reached_budget,
         COUNT(CASE WHEN stage IN ('in_treatment','completed') THEN 1 END) AS reached_treatment,
         COUNT(CASE WHEN stage = 'completed' THEN 1 END) AS completed,
         COUNT(CASE WHEN stage = 'lost' THEN 1 END) AS lost,
         COALESCE(SUM(CASE WHEN stage NOT IN ('lost','completed') THEN treatment_value END), 0) AS pipeline_value,
         COALESCE(SUM(CASE WHEN stage = 'completed' THEN treatment_value END), 0) AS completed_value
       FROM dental_leads WHERE company_id = $1 AND created_at >= $2`, [cid, since]);
    const total = parseInt(counts.total_leads) || 1;
    const { rows: [avgTime] } = await db.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (stage_changed_at - created_at))/86400)::int AS avg_days
       FROM dental_leads WHERE company_id = $1 AND stage = 'completed' AND created_at >= $2`, [cid, since]);
    res.json({
      total_leads: parseInt(counts.total_leads),
      conversion_to_budget: Math.round((parseInt(counts.reached_budget) / total) * 100),
      conversion_to_treatment: Math.round((parseInt(counts.reached_treatment) / total) * 100),
      conversion_to_completed: Math.round((parseInt(counts.completed) / total) * 100),
      lost_pct: Math.round((parseInt(counts.lost) / total) * 100),
      pipeline_value: parseFloat(counts.pipeline_value),
      completed_value: parseFloat(counts.completed_value),
      avg_days_to_complete: parseInt(avgTime?.avg_days) || null,
    });
  } catch (err) {
    console.error('[dentalFunnel GET /funnel/stats]', err.message);
    res.status(500).json({ error: 'Erro stats' });
  }
});

router.post('/funnel/leads', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const cid = req.params.id;
  const { lead_name, lead_phone, lead_email, source, treatment_value, notes, assigned_to } = req.body;
  if (!lead_name) return res.status(400).json({ error: 'lead_name obrigatorio' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_leads (company_id, lead_name, lead_phone, lead_email, source, treatment_value, notes, assigned_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cid, lead_name, lead_phone||null, lead_email||null, source||'walkin', treatment_value||0, notes||null, assigned_to||null]);
    await db.query(
      `INSERT INTO dental_lead_history (lead_id, to_stage, changed_by, notes) VALUES ($1,'lead',$2,'Lead criado')`,
      [rows[0].id, req.user.id]);
    res.status(201).json({ lead: rows[0] });
  } catch (err) {
    console.error('[dentalFunnel POST /funnel/leads]', err.message);
    res.status(500).json({ error: 'Erro ao criar lead' });
  }
});

router.patch('/funnel/leads/:lid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { lid } = req.params; const cid = req.params.id;
  const { stage, lead_name, lead_phone, lead_email, treatment_value, notes, assigned_to, lost_reason, treatment_plan_id } = req.body;
  try {
    let oldStage = null;
    if (stage) {
      const { rows: old } = await db.query('SELECT stage FROM dental_leads WHERE id=$1 AND company_id=$2', [lid, cid]);
      if (!old.length) return res.status(404).json({ error: 'Lead nao encontrado' });
      oldStage = old[0].stage;
    }
    const fields = []; const values = []; let idx = 1;
    const allowed = { stage, lead_name, lead_phone, lead_email, treatment_value, notes, assigned_to, lost_reason, treatment_plan_id };
    for (const [k, v] of Object.entries(allowed)) {
      if (v !== undefined) { fields.push(`${k}=$${idx++}`); values.push(v); }
    }
    if (stage) { fields.push(`stage_changed_at=NOW()`); }
    fields.push('updated_at=NOW()');
    values.push(lid, cid);
    const { rows } = await db.query(
      `UPDATE dental_leads SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values);
    if (!rows.length) return res.status(404).json({ error: 'Lead nao encontrado' });
    if (stage && oldStage !== stage) {
      await db.query(
        `INSERT INTO dental_lead_history (lead_id, from_stage, to_stage, changed_by, notes) VALUES ($1,$2,$3,$4,$5)`,
        [lid, oldStage, stage, req.user.id, notes || null]);
    }
    res.json({ lead: rows[0] });
  } catch (err) {
    console.error('[dentalFunnel PATCH /funnel/leads/:lid]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar lead' });
  }
});

// D-UNIFY: convert cria customer com is_patient=true (nao mais dental_patients)
router.post('/funnel/leads/:lid/convert', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { lid } = req.params; const cid = req.params.id;
  const { lgpd_consent = true } = req.body;

  if (!lgpd_consent) {
    return res.status(400).json({
      error: 'Consentimento LGPD Art.11 e obrigatorio para converter lead em paciente',
    });
  }

  try {
    const { rows: leads } = await db.query(
      'SELECT * FROM dental_leads WHERE id=$1 AND company_id=$2', [lid, cid]);
    if (!leads.length) return res.status(404).json({ error: 'Lead nao encontrado' });
    const lead = leads[0];
    if (lead.customer_id) {
      return res.status(409).json({ error: 'Lead ja convertido', customer_id: lead.customer_id, patient_id: lead.customer_id });
    }

    // Cria customer com is_patient=true
    const { rows: customer } = await db.query(
      `INSERT INTO customers (company_id, name, phone, email, is_patient, lgpd_consent, lgpd_consent_at)
       VALUES ($1, $2, $3, $4, true, $5, NOW())
       RETURNING *`,
      [cid, lead.lead_name, lead.lead_phone, lead.lead_email, lgpd_consent]);

    // Vincula ao lead
    await db.query(
      `UPDATE dental_leads
       SET customer_id=$1, stage='evaluation_scheduled', stage_changed_at=NOW(), updated_at=NOW()
       WHERE id=$2`,
      [customer[0].id, lid]);

    await db.query(
      `INSERT INTO dental_lead_history (lead_id, from_stage, to_stage, changed_by, notes)
       VALUES ($1, $2, 'evaluation_scheduled', $3, 'Convertido em paciente')`,
      [lid, lead.stage, req.user.id]);

    // Response com alias patient pra compat com FE legado
    const patient = {
      id: customer[0].id,
      full_name: customer[0].name,
      phone: customer[0].phone,
      email: customer[0].email,
      lgpd_consent: customer[0].lgpd_consent,
      ...customer[0],
    };

    res.json({ patient, customer: customer[0], lead_id: lid });
  } catch (err) {
    console.error('[dentalFunnel convert]', err.message);
    res.status(500).json({ error: 'Erro ao converter' });
  }
});

router.get('/funnel/leads/:lid/timeline', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT h.*, u.name AS changed_by_name FROM dental_lead_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.lead_id = $1 ORDER BY h.created_at ASC`, [req.params.lid]);
    res.json({ timeline: rows });
  } catch (err) {
    console.error('[dentalFunnel timeline]', err.message);
    res.status(500).json({ error: 'Erro timeline' });
  }
});

module.exports = router;
