// ============================================================
// AURA Studio — Pagamentos / Sinal (Camada 1, Fase C)
// GET  /studio/orders/:oid/payments     → lista marcos do pedido
// POST /studio/orders/:oid/payments     → cria marco {kind, amount, due_at, method}
// POST /studio/payments/:pid/mark-paid  → confirma Pix manual recebido
//   (p-185: no pedido de orcamento lanca a entrada e baixa a conta a receber,
//    services/financeiroDoOrcamento.js)
// POST /studio/payments/:pid/charge-link→ retorna chave Pix da empresa (MVP)
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true }); // company_id = req.params.id
const db      = require('../config/database');
const lojaEvents = require('../services/lojaEvents');
// 25/11/2026 (p-185): marco de pedido de orcamento lanca no Financeiro.
const financeiroDoOrcamento = require('../services/financeiroDoOrcamento');
const { lerChave } = require('../services/pedidoBalcao');

// 18/11/2026 (B4a, revisao do Fable): o pedido guardado no Caixa (origem
// 'balcao') tem o sinal pela rota propria (POST /pedidos/:oid/sinal), que
// lanca o dinheiro, baixa a conta a receber e grava a forma. Um marco criado
// ou marcado como pago por aqui seria um "sinal" sem dinheiro no Financeiro.
const PEDIDO_DO_BALCAO = {
  error: 'Este pedido foi guardado no Caixa. O sinal dele se registra pelo pedido, no Caixa.',
  code: 'PEDIDO_DO_BALCAO',
};
async function eDoBalcao(orderId) {
  const { rows } = await db.query(`SELECT origem FROM digital_orders WHERE id = $1`, [orderId]);
  return !!(rows[0] && rows[0].origem === 'balcao');
}

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
    if (await eDoBalcao(oid)) return res.status(409).json(PEDIDO_DO_BALCAO);
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
    if (await eDoBalcao(payment.order_id)) return res.status(409).json(PEDIDO_DO_BALCAO);

    // p-185 (25/11/2026, decisao do Caio): pedido que saiu de orcamento lanca
    // pelo caminho do sinal do pedido guardado. Sinal: entrada "Sinal de
    // pedido"; saldo: entrada "Saldo de pedido"; a conta "Pedido a receber"
    // baixa pelo que entrou e quita quando nada falta. Pix sem taxa da
    // maquininha. Tudo numa transacao, com o pedido e o marco travados;
    // marco ja pago responde sem lancar de novo.
    if (await financeiroDoOrcamento.ePedidoDeOrcamento(db, company_id, payment.order_id)) {
      try {
        const r = await financeiroDoOrcamento.receberMarco(db, {
          companyId: company_id,
          paymentId: pid,
          body: req.body,
          chave: lerChave(req),
          userId: req.user && req.user.id,
        });
        const deposit_released = r.tipo === 'sinal';
        if (r.repetido) {
          res.set('Idempotent-Replayed', 'true');
          return res.json({ ok: true, payment: r.payment, deposit_released, ja_pago: true, idempotent_replay: true });
        }
        if (deposit_released) lojaEvents.emit('loja_sinal_pago', { id: payment.order_id, company_id });
        return res.json({
          ok: true,
          payment: r.payment,
          deposit_released,
          lancamento: r.tipo,
          taxa: r.taxa,
          falta_receber: r.falta_receber,
        });
      } catch (e) {
        if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
        throw e;
      }
    }

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
      // 01/09/2026 — o sinal pago é o que destrava a produção da encomenda.
      // Quem marca aqui costuma ser o financeiro; quem precisa saber é a
      // produção. Evento durável no sino em vez de ninguém saber.
      lojaEvents.emit('loja_sinal_pago', { id: payment.order_id, company_id });
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
