// ============================================================
// AURA Studio · Rotas PÚBLICAS (sem auth) /aprovacao/:token
// Mount em routes/index.js (público, igual /storefront).
//
// Fluxo:
//   1. Cliente recebe link wa.me com URL /aprovacao/:token
//   2. GET /aprovacao/:token devolve mockup + dados do pedido (sem PII sensível)
//   3. POST /aprovacao/:token/respond com action=approve|request_changes
//   4. Se approve → studio_production_status do pedido vira 'approved'
//      Se request_changes → cria revision, mantém pending
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

// GET /aprovacao/:token — devolve dados do mockup pro cliente
router.get('/:token', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT a.id, a.token, a.mockup_url, a.status, a.expires_at, a.response_note,
              a.responded_at, a.message_text,
              o.id AS order_id, o.total_amount,
              COALESCE(o.customer_data->>'name', o.customer_name) AS customer_name,
              c.trade_name, c.legal_name,
              (SELECT json_agg(json_build_object(
                'product_name', oi.product_name,
                'quantity', oi.quantity,
                'unit_price', oi.unit_price,
                'customization', oi.customization
              ))
                FROM digital_order_items oi WHERE oi.order_id = o.id) AS items,
              (SELECT json_agg(json_build_object(
                'revision_number', r.revision_number,
                'mockup_url', r.mockup_url,
                'note', r.note,
                'created_by_type', r.created_by_type,
                'created_at', r.created_at
              ) ORDER BY r.revision_number)
                FROM studio_approval_revisions r WHERE r.approval_id = a.id) AS revisions
         FROM studio_approval_links a
         JOIN digital_orders o ON o.id = a.order_id
         LEFT JOIN companies c ON c.id = a.company_id
        WHERE a.token = $1 LIMIT 1`,
      [req.params.token]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Link inválido ou expirado' });

    const a = r.rows[0];
    const expired = new Date(a.expires_at) < new Date();

    res.json({
      token: a.token,
      mockup_url: a.mockup_url,
      status: expired && a.status === 'pending' ? 'expired' : a.status,
      response_note: a.response_note,
      responded_at: a.responded_at,
      expires_at: a.expires_at,
      shop: {
        name: a.trade_name || a.legal_name,
      },
      order: {
        id: a.order_id,
        customer_name: a.customer_name,
        total_amount: parseFloat(a.total_amount) || 0,
        items: a.items || [],
      },
      revisions: a.revisions || [],
    });
  } catch (err) {
    console.error('[aprovacao:GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar aprovação' });
  }
});

// POST /aprovacao/:token/respond
// body: { action: 'approve' | 'request_changes', note?: string }
router.post('/:token/respond', async function(req, res) {
  const { action, note } = req.body;
  if (!['approve', 'request_changes'].includes(action)) {
    return res.status(400).json({ error: "action deve ser 'approve' ou 'request_changes'" });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Busca aprovação + valida que ainda está pending e não expirou
    const aRes = await client.query(
      `SELECT id, company_id, order_id, status, expires_at
         FROM studio_approval_links WHERE token = $1 LIMIT 1`,
      [req.params.token]
    );
    if (!aRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Link inválido' }); }
    const a = aRes.rows[0];
    if (a.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esta aprovação já foi respondida' });
    }
    if (new Date(a.expires_at) < new Date()) {
      // Marca como expired ao detectar
      await client.query(`UPDATE studio_approval_links SET status = 'expired' WHERE id = $1`, [a.id]);
      await client.query('COMMIT');
      return res.status(410).json({ error: 'Link expirado — peça pro lojista enviar um novo' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'changes_requested';

    // Atualiza aprovação
    await client.query(
      `UPDATE studio_approval_links
          SET status = $1, response_note = $2, responded_at = NOW()
        WHERE id = $3`,
      [newStatus, note ? String(note).slice(0, 1000) : null, a.id]
    );

    // Cria revisão registrando resposta do cliente
    const nextRev = await client.query(
      `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
         FROM studio_approval_revisions WHERE approval_id = $1`,
      [a.id]
    );
    await client.query(
      `INSERT INTO studio_approval_revisions
         (approval_id, revision_number, note, created_by_type)
       VALUES ($1, $2, $3, 'customer')`,
      [a.id, nextRev.rows[0].next, action === 'approve' ? 'Cliente aprovou' : (note || 'Cliente pediu ajuste')]
    );

    // Se aprovado, avança o pedido pra 'approved' no KDS
    if (action === 'approve') {
      await client.query(
        `UPDATE digital_orders
            SET studio_production_status = 'approved', updated_at = NOW()
          WHERE id = $1 AND company_id = $2`,
        [a.order_id, a.company_id]
      );
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      action,
      new_status: newStatus,
      message: action === 'approve'
        ? '🎉 Aprovado! A loja já foi notificada e vai começar a produzir.'
        : 'Pronto! A loja recebeu seu pedido de ajuste e vai te chamar.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[aprovacao:respond]', err.message);
    res.status(500).json({ error: 'Erro ao registrar resposta' });
  } finally {
    client.release();
  }
});

module.exports = router;
