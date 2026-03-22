// ============================================================
// AURA. — Serviço Salão Parceiro (BE-22)
// Lei nº 13.352/2016
// ============================================================

const db = require('../config/database');

function calculateSplit(serviceAmount, partnerSharePct) {
  const total      = parseFloat(serviceAmount);
  const partnerAmt = Math.round(total * partnerSharePct) / 100;
  const salonAmt   = Math.round((total - partnerAmt) * 100) / 100;
  return {
    service_amount:  total,
    partner_share:   partnerSharePct,
    partner_amount:  Math.round(partnerAmt * 100) / 100,
    salon_amount:    salonAmt,
    note: 'Apenas o valor do salão compõe a base de faturamento tributável (Lei 13.352/2016)',
  };
}

async function recordSplit(companyId, { partner_id, sale_id, service_amount, reference_month }) {
  const { rows } = await db.query(
    'SELECT id, name, partner_share FROM salon_partners WHERE id=$1 AND company_id=$2 AND is_active=true',
    [partner_id, companyId]
  );
  if (!rows.length) throw new Error('Parceiro não encontrado ou inativo');

  const partner  = rows[0];
  const split    = calculateSplit(service_amount, parseFloat(partner.partner_share));
  const refMonth = reference_month || new Date().toISOString().slice(0, 8) + '01';

  const { rows: inserted } = await db.query(
    `INSERT INTO salon_partner_splits
       (company_id, partner_id, sale_id, service_amount, partner_share,
        partner_amount, salon_amount, reference_month)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [companyId, partner_id, sale_id||null, split.service_amount,
     split.partner_share, split.partner_amount, split.salon_amount, refMonth]
  );
  return { ...inserted[0], partner_name: partner.name, split };
}

async function getMonthlySummary(companyId, referenceMonth) {
  const { rows } = await db.query(
    `SELECT
       p.id AS partner_id, p.name AS partner_name, p.partner_share,
       COUNT(s.id)                        AS split_count,
       COALESCE(SUM(s.service_amount), 0) AS total_service,
       COALESCE(SUM(s.partner_amount), 0) AS total_partner,
       COALESCE(SUM(s.salon_amount),   0) AS total_salon,
       COUNT(s.id) FILTER (WHERE s.status='paid')    AS paid_count,
       COUNT(s.id) FILTER (WHERE s.status='pending') AS pending_count
     FROM salon_partners p
     LEFT JOIN salon_partner_splits s
       ON s.partner_id=p.id AND s.company_id=p.company_id
      AND s.reference_month=$2 AND s.status!='cancelled'
     WHERE p.company_id=$1 AND p.is_active=true
     GROUP BY p.id, p.name, p.partner_share
     ORDER BY total_service DESC`,
    [companyId, referenceMonth]
  );
  const totals = rows.reduce((acc, r) => ({
    total_service: acc.total_service + parseFloat(r.total_service),
    total_partner: acc.total_partner + parseFloat(r.total_partner),
    total_salon:   acc.total_salon   + parseFloat(r.total_salon),
  }), { total_service: 0, total_partner: 0, total_salon: 0 });
  return {
    reference_month: referenceMonth,
    partners: rows.map(r => ({
      ...r,
      total_service: parseFloat(r.total_service),
      total_partner: parseFloat(r.total_partner),
      total_salon:   parseFloat(r.total_salon),
      partner_share: parseFloat(r.partner_share),
    })),
    totals: { ...totals, taxable_base: totals.total_salon,
      note: 'taxable_base = base de faturamento tributável do salão (exclui cotas dos parceiros)' },
  };
}

module.exports = { calculateSplit, recordSplit, getMonthlySummary };
