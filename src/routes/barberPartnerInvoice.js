// ============================================================
// AURA. — S11 B-17/B-18: Partner NFS-e (Lei do Salão)
// Cota-parte tracking + NFS-e emission control
// Mounted at: /companies/:id/barbershop/partners
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /invoices — List partner invoices
router.get('/invoices', requireAuth, async (req, res) => {
  const { period_start, partner_id } = req.query;
  try {
    const params = [req.params.id];
    let where = 'WHERE pi.company_id=$1';
    if (period_start) { params.push(period_start); where += ` AND pi.period_start>=$${params.length}`; }
    if (partner_id) { params.push(partner_id); where += ` AND pi.partner_id=$${params.length}`; }
    const { rows } = await db.query(
      `SELECT pi.*, sp.name AS partner_name, sp.type AS partner_type, sp.cnpj AS partner_cnpj,
              bp.name AS professional_name
       FROM barber_partner_invoices pi
       JOIN salon_partners sp ON sp.id=pi.partner_id
       LEFT JOIN barbershop_professionals bp ON bp.id=pi.professional_id
       ${where} ORDER BY pi.period_start DESC`, params
    );
    // Summary
    const { rows: summary } = await db.query(
      `SELECT COALESCE(SUM(gross_revenue),0)::numeric AS total_gross,
              COALESCE(SUM(partner_share),0)::numeric AS total_partner,
              COALESCE(SUM(salon_share),0)::numeric AS total_salon,
              COUNT(*) FILTER (WHERE partner_nfse_status='pendente')::int AS pending_nfse
       FROM barber_partner_invoices WHERE company_id=$1`, [req.params.id]
    );
    res.json({ total: rows.length, invoices: rows, summary: summary[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar faturas' }); }
});

// POST /invoices — Generate partner invoice for period
router.post('/invoices', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { partner_id, professional_id, period_start, period_end, deductions } = req.body;
  if (!partner_id || !period_start || !period_end) return res.status(400).json({ error: 'partner_id, period_start e period_end obrigatorios' });
  try {
    // Calculate gross revenue for professional in period
    const { rows: revenue } = await db.query(
      `SELECT COALESCE(SUM(a.total_amount),0)::numeric AS gross
       FROM barbershop_appointments a
       WHERE a.company_id=$1 AND a.professional_id=$2
         AND a.scheduled_at>=$3 AND a.scheduled_at<=$4
         AND a.status='concluido'`,
      [req.params.id, professional_id, period_start, period_end]
    );
    const gross = parseFloat(revenue[0]?.gross || 0);

    // Get partner share %
    const { rows: partners } = await db.query(
      'SELECT share_percentage FROM salon_partners WHERE id=$1', [partner_id]
    );
    const sharePct = parseFloat(partners[0]?.share_percentage || 50);
    const partnerShare = Math.round(gross * sharePct) / 100;
    const totalDeductions = (deductions || []).reduce((s, d) => s + (d.amount || 0), 0);
    const salonShare = Math.round((gross - partnerShare - totalDeductions) * 100) / 100;

    const { rows } = await db.query(
      `INSERT INTO barber_partner_invoices
         (company_id, partner_id, professional_id, period_start, period_end,
          gross_revenue, partner_share, salon_share, partner_share_pct, deductions, deduction_details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, partner_id, professional_id||null, period_start, period_end,
       gross, partnerShare, salonShare, sharePct, totalDeductions, JSON.stringify(deductions||[])]
    );
    res.status(201).json({ invoice: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao gerar fatura' }); }
});

// PATCH /invoices/:invId — Update NFS-e status
router.patch('/invoices/:invId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { partner_nfse_number, partner_nfse_status, partner_nfse_url, salon_nfse_number, salon_nfse_status, notes } = req.body;
  const fields = [], values = []; let idx = 1;
  if (partner_nfse_number) { fields.push(`partner_nfse_number=$${idx++}`); values.push(partner_nfse_number); }
  if (partner_nfse_status) { fields.push(`partner_nfse_status=$${idx++}`); values.push(partner_nfse_status); }
  if (partner_nfse_url) { fields.push(`partner_nfse_url=$${idx++}`); values.push(partner_nfse_url); }
  if (salon_nfse_number) { fields.push(`salon_nfse_number=$${idx++}`); values.push(salon_nfse_number); }
  if (salon_nfse_status) { fields.push(`salon_nfse_status=$${idx++}`); values.push(salon_nfse_status); }
  if (notes) { fields.push(`notes=$${idx++}`); values.push(notes); }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo' });
  fields.push('updated_at=NOW()'); values.push(req.params.invId, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE barber_partner_invoices SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Fatura nao encontrada' });
    res.json({ invoice: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar' }); }
});

module.exports = router;
