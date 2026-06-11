// ============================================================
// AURA. -- Crediario: DEVOLUCAO de venda (B4)
// POST /companies/:id/credit/sales/:saleId/refund
//
// Router enxuto: delega ao motor services/credit/refund.js (refundCreditSale),
// que reusa a infra de troca (estoque + guarda anti-dupla-devolucao) e aplica
// o modelo do contrato (abate ultimas parcelas + transacao 'refund' no ledger).
//
// Montado em private.js sob /credit (requireAuth + requireCompanyAccess +
// requirePlan('negocio','expansao') ja aplicados a montante).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { refundCreditSale } = require('../services/credit/refund');

async function assertCrediarioEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) { const e = new Error('Empresa nao encontrada'); e.status = 404; throw e; }
  if (rows[0].enabled !== 'true') {
    const e = new Error('Modulo de crediario nao esta habilitado. Ative em Configuracoes > PDV > Politicas do Caixa.');
    e.status = 403; e.code = 'CREDIARIO_DISABLED'; throw e;
  }
}

// POST /sales/:saleId/refund  { items:[{sale_item_id, quantity}], reason? }
router.post('/sales/:saleId/refund', async (req, res) => {
  const companyId = req.params.id;
  const saleId    = req.params.saleId;
  const items     = Array.isArray(req.body?.items) ? req.body.items : null;
  const reason    = req.body?.reason ? String(req.body.reason).trim() : null;

  if (!items || !items.length) {
    return res.status(400).json({ error: 'items[] obrigatorio (array nao vazio)' });
  }

  try {
    await assertCrediarioEnabled(companyId);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await refundCreditSale(client, {
      companyId,
      saleId,
      items,
      reason,
      createdBy: req.user?.id || null,
    });
    await client.query('COMMIT');
    return res.status(201).json(result);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err.isRefundError) return res.status(err.status).json(err.body);
    console.error('[credit] refund error:', err.message);
    return res.status(500).json({ error: 'Erro ao registrar devolucao de crediario' });
  } finally {
    client.release();
  }
});

module.exports = router;
