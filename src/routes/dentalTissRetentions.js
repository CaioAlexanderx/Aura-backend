// ============================================================
// PR40 Sprint B - 2026-04-28
//
// Endpoint que sumariza retencoes de impostos feitas pelos convenios
// nas guias TISS - usado pelo bloco "Retencoes TISS" da contabilidade
// odonto pra calcular tributo liquido a recolher.
//
// Retencoes tipicas:
// - IRRF 1.5% sobre servicos medicos/odonto (convenio retem na fonte)
// - PIS+COFINS+CSLL 4.65% (Lucro Presumido/Real)
// - ISS variavel (substituicao tributaria municipal)
// ============================================================

const express = require('express');
const db = require('../config/database');

const router = express.Router({ mergeParams: true });

// GET /dental/tiss/retentions/summary?from=2026-01-01&to=2026-12-31
router.get('/tiss/retentions/summary', async (req, res) => {
  try {
    const companyId = req.params.companyId;
    const { from, to } = req.query;

    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const toDate = to ? new Date(to) : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);

    const { rows } = await db.query(
      `SELECT
         COUNT(*)::int AS total_guides,
         COALESCE(SUM(paid_value), 0) AS total_paid,
         COALESCE(SUM(authorized_value), 0) AS total_authorized,
         COALESCE(SUM(glossed_value), 0) AS total_glossed,
         COALESCE(SUM(irrf_retido_amount), 0) AS total_irrf,
         COALESCE(SUM(iss_retido_amount), 0) AS total_iss,
         COALESCE(SUM(pis_cofins_csll_retido_amount), 0) AS total_pis_cofins_csll,
         COALESCE(SUM(net_paid_value), 0) AS total_net_paid
       FROM dental_tiss_guides
       WHERE company_id = $1
         AND paid_at >= $2 AND paid_at <= $3
         AND status IN ('paid', 'authorized')`,
      [companyId, fromDate, toDate]
    );

    const summary = rows[0];
    const totalRetencoes =
      parseFloat(summary.total_irrf) +
      parseFloat(summary.total_iss) +
      parseFloat(summary.total_pis_cofins_csll);

    // Por convenio
    const { rows: byInsurance } = await db.query(
      `SELECT
         i.id AS insurance_id,
         i.name AS insurance_name,
         COUNT(g.id)::int AS guides,
         COALESCE(SUM(g.paid_value), 0) AS paid,
         COALESCE(SUM(g.irrf_retido_amount), 0) AS irrf,
         COALESCE(SUM(g.iss_retido_amount), 0) AS iss,
         COALESCE(SUM(g.pis_cofins_csll_retido_amount), 0) AS pis_cofins_csll
       FROM dental_tiss_guides g
       JOIN insurance_companies i ON i.id = g.insurance_id
       WHERE g.company_id = $1
         AND g.paid_at >= $2 AND g.paid_at <= $3
         AND g.status IN ('paid', 'authorized')
       GROUP BY i.id, i.name
       ORDER BY paid DESC`,
      [companyId, fromDate, toDate]
    );

    res.json({
      period: {
        from: fromDate.toISOString().split('T')[0],
        to: toDate.toISOString().split('T')[0],
      },
      summary: {
        total_guides: summary.total_guides,
        total_authorized: parseFloat(summary.total_authorized),
        total_paid: parseFloat(summary.total_paid),
        total_glossed: parseFloat(summary.total_glossed),
        total_irrf_retido: parseFloat(summary.total_irrf),
        total_iss_retido: parseFloat(summary.total_iss),
        total_pis_cofins_csll_retido: parseFloat(summary.total_pis_cofins_csll),
        total_retencoes: totalRetencoes,
        total_net_paid: parseFloat(summary.total_net_paid),
        // Aviso: IRRF retido pode ser deduzido do IRPJ devido (compensacao)
        compensacao_irrf_disponivel: parseFloat(summary.total_irrf),
      },
      by_insurance: byInsurance.map(r => ({
        insurance_id: r.insurance_id,
        insurance_name: r.insurance_name,
        guides: r.guides,
        paid: parseFloat(r.paid),
        irrf: parseFloat(r.irrf),
        iss: parseFloat(r.iss),
        pis_cofins_csll: parseFloat(r.pis_cofins_csll),
      })),
    });
  } catch (e) {
    console.error('[dental/tiss/retentions/summary] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /dental/tiss/guides/:id/retentions
// Permite ajuste manual das retencoes ao reconciliar o pagamento
router.patch('/tiss/guides/:guideId/retentions', async (req, res) => {
  try {
    const companyId = req.params.companyId;
    const { guideId } = req.params;
    const {
      irrf_retido_amount,
      iss_retido_amount,
      pis_cofins_csll_retido_amount,
      paid_value,
      paid_at,
    } = req.body;

    // Calcula valor liquido recebido
    const paid = parseFloat(paid_value || 0);
    const irrf = parseFloat(irrf_retido_amount || 0);
    const iss = parseFloat(iss_retido_amount || 0);
    const pcc = parseFloat(pis_cofins_csll_retido_amount || 0);
    const netPaid = paid - irrf - iss - pcc;

    const { rows } = await db.query(
      `UPDATE dental_tiss_guides
       SET irrf_retido_amount = COALESCE($1, irrf_retido_amount),
           iss_retido_amount = COALESCE($2, iss_retido_amount),
           pis_cofins_csll_retido_amount = COALESCE($3, pis_cofins_csll_retido_amount),
           paid_value = COALESCE($4, paid_value),
           paid_at = COALESCE($5::timestamptz, paid_at),
           net_paid_value = $6,
           status = CASE WHEN $4 IS NOT NULL THEN 'paid' ELSE status END,
           updated_at = NOW()
       WHERE id = $7 AND company_id = $8
       RETURNING *`,
      [
        irrf_retido_amount,
        iss_retido_amount,
        pis_cofins_csll_retido_amount,
        paid_value,
        paid_at || null,
        netPaid,
        guideId,
        companyId,
      ]
    );

    if (!rows.length) return res.status(404).json({ error: 'Guia nao encontrada' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[dental/tiss/guides/:id/retentions] error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
