// ============================================================
// AURA Studio — Pagamentos / Sinal (Camada 1, Fase C)
// GET  /studio/orders/:oid/payments     → lista marcos do pedido
// POST /studio/orders/:oid/payments     → cria marco {kind, amount, due_at, method}
// POST /studio/payments/:pid/mark-paid  → confirma Pix manual recebido
// POST /studio/payments/:pid/charge-link→ retorna chave Pix da empresa (MVP)
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true }); // company_id = req.params.id
const db      = require('../config/database');

// ── GET /studio/orders/:oid/payments ─────────────────────────────────────────
router.get('/orders/:oid/payments', async (req, res) => {
  const { id: company_id, oid } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT * FROM studio_payments
       WHERE company_id = $1 AND order_id = $2
       ORDER BY created_at`,
      [company_id, oid]
    );
    return res.json({ payments: rows });
  } catch (err) {
    console.error('[studioPayments GET]', err);
    return res.status(500).json({ error: 'Erro ao listar pagamentos' });
  }
});

// ── POST /studio/orders/:oid/payments ────────────────────────────────────────
router.post('/orders/:oid/payments', async (req, res) => {
  const { id: company_id, oid } = req.params;
  const { kind, amount, due_at, method } = req.body || {};

  // Validação
  if (!['deposit', 'balance', 'full'].includes(kind)) {
    return res.status(400).json({ error: 'kind inválido. Use: deposit, balance ou full' });
  }
  const amt = Number(amount);
  if (!amt || amt <= 0) {
    return res.status(400).json({ error: 'amount deve ser maior que zero' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO studio_payments
         (company_id, order_id, kind, amount, status, method, due_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, NOW(), NOW())
       RETURNING *`,
      [company_id, oid, kind, amt, method || null, due_at || null]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[studioPayments POST]', err);
    return res.status(500).json({ error: 'Erro ao criar pagamento' });
  }
});

// ── POST /studio/payments/:pid/mark-paid ─────────────────────────────────────
router.post('/payments/:pid/mark-paid', async (req, res) => {
  const { id: company_id, pid } = req.params;
  const { method } = req.body || {};

  try {
    // Busca o pagamento garantindo company_id
    const { rows: found } = await db.query(
      `SELECT * FROM studio_payments WHERE id = $1 AND company_id = $2`,
      [pid, company_id]
    );
    if (!found.length) {
      return res.status(404).json({ error: 'Pagamento não encontrado' });
    }
    const payment = found[0];

    // Atualiza o pagamento para paid
    const { rows: updated } = await db.query(
      `UPDATE studio_payments
       SET status = 'paid', paid_at = NOW(), method = COALESCE($1, method), updated_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [method || null, pid, company_id]
    );

    let deposit_released = false;

    // Se era sinal (deposit), libera a produção no pedido
    if (payment.kind === 'deposit') {
      await db.query(
        `UPDATE digital_orders
         SET deposit_paid = true, updated_at = NOW()
         WHERE id = $1 AND company_id = $2`,
        [payment.order_id, company_id]
      );
      deposit_released = true;
    }

    return res.json({ ok: true, payment: updated[0], deposit_released });
  } catch (err) {
    console.error('[studioPayments mark-paid]', err);
    return res.status(500).json({ error: 'Erro ao confirmar pagamento' });
  }
});

// ── POST /studio/payments/:pid/charge-link ───────────────────────────────────
// MVP: retorna chave Pix da empresa. Futuramente: Asaas charge_id.
router.post('/payments/:pid/charge-link', async (req, res) => {
  const { id: company_id, pid } = req.params;

  try {
    // Busca o pagamento garantindo company_id
    const { rows: found } = await db.query(
      `SELECT * FROM studio_payments WHERE id = $1 AND company_id = $2`,
      [pid, company_id]
    );
    if (!found.length) {
      return res.status(404).json({ error: 'Pagamento não encontrado' });
    }
    const payment = found[0];

    // Busca dados da empresa (pix_key nas studio_settings + nome)
    const { rows: cRows } = await db.query(
      `SELECT studio_settings->>'pix_key'          AS pix_key,
              studio_settings->>'approval_wa_phone' AS phone,
              COALESCE(trade_name, legal_name)       AS name
       FROM companies WHERE id = $1`,
      [company_id]
    );
    const company = cRows[0] || {};
    const pix_key = company.pix_key || null;
    const shopName = company.name || 'a loja';
    const amtFormatted = Number(payment.amount).toFixed(2);

    const instructions = pix_key
      ? `Envie R$ ${amtFormatted} via Pix para ${pix_key} — ${shopName}`
      : `Entre em contato com ${shopName} para combinar o pagamento de R$ ${amtFormatted}`;

    return res.json({
      ok: true,
      payment_url: null,
      pix_code: pix_key,
      method: 'pix',
      instructions,
    });
  } catch (err) {
    console.error('[studioPayments charge-link]', err);
    return res.status(500).json({ error: 'Erro ao gerar link de cobrança' });
  }
});

module.exports = router;
