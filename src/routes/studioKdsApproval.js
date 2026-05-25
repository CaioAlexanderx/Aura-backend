// ============================================================
// AURA Studio · Rotas autenticadas Fase 4 (KDS) + Fase 5 (request approval)
// Arquivo separado pra não inflar studio.js.
// Mount em private.js sob mesmo prefixo /studio.
// Migration 130 (studio_production_status) + Migration 132 (approval_links).
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const crypto  = require('crypto');
const db      = require('../config/database');
const { markStudioOnboarding } = require('../utils/studioOnboarding');

// ═══════════════════════════════════════════════════════════
// FASE 4: KDS de Produção
// ═══════════════════════════════════════════════════════════

const VALID_PRODUCTION_STATUS = ['pending_art', 'approved', 'in_production', 'ready', 'delivered'];

router.get('/orders', async function(req, res) {
  const { status, days = 30, limit = 200 } = req.query;
  const params = [req.params.id];
  let where = `o.company_id = $1 AND o.vertical = 'studio'`;
  if (status && VALID_PRODUCTION_STATUS.includes(String(status))) {
    params.push(status);
    where += ` AND o.studio_production_status = $${params.length}`;
  }
  if (days) {
    where += ` AND o.created_at >= NOW() - INTERVAL '${Math.min(parseInt(days) || 30, 365)} days'`;
  }
  try {
    const r = await db.query(
      `SELECT o.id, o.created_at, o.total_amount, o.status,
              o.studio_production_status,
              o.customer_name, o.customer_phone,
              COALESCE(o.customer_data->>'name', o.customer_name) AS display_name,
              (SELECT COUNT(*) FROM digital_order_items oi WHERE oi.order_id = o.id) AS item_count,
              (SELECT MIN(image_url) FROM studio_approval_links a
                WHERE a.order_id = o.id AND a.status = 'pending'
                ORDER BY a.created_at DESC LIMIT 1) AS pending_approval_url,
              (SELECT COUNT(*) FROM studio_approval_links a
                WHERE a.order_id = o.id) AS approval_count
         FROM digital_orders o
        WHERE ${where}
        ORDER BY o.created_at DESC
        LIMIT $${params.length + 1}`,
      [...params, Math.min(parseInt(limit) || 200, 500)]
    );
    res.json({ orders: r.rows });
  } catch (err) {
    console.error('[studio/orders:GET]', err.message);
    res.status(500).json({ error: 'Erro ao listar pedidos do Studio' });
  }
});

router.get('/orders/:oid', async function(req, res) {
  try {
    const orderRes = await db.query(
      `SELECT o.*, COALESCE(o.customer_data->>'name', o.customer_name) AS display_name
         FROM digital_orders o
        WHERE o.id = $1 AND o.company_id = $2 LIMIT 1`,
      [req.params.oid, req.params.id]
    );
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });

    const itemsRes = await db.query(
      `SELECT id, product_id, product_name, quantity, unit_price, customization
         FROM digital_order_items
        WHERE order_id = $1
        ORDER BY id`,
      [req.params.oid]
    );

    const approvalsRes = await db.query(
      `SELECT id, token, status, mockup_url, response_note, expires_at, responded_at, created_at
         FROM studio_approval_links
        WHERE order_id = $1
        ORDER BY created_at DESC`,
      [req.params.oid]
    );

    res.json({
      order: orderRes.rows[0],
      items: itemsRes.rows,
      approvals: approvalsRes.rows,
    });
  } catch (err) {
    console.error('[studio/orders/:oid]', err.message);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

router.patch('/orders/:oid/production-status', async function(req, res) {
  const { status } = req.body;
  if (!VALID_PRODUCTION_STATUS.includes(status)) {
    return res.status(400).json({ error: `status inválido (use: ${VALID_PRODUCTION_STATUS.join(', ')})` });
  }
  try {
    const r = await db.query(
      `UPDATE digital_orders
          SET studio_production_status = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3 AND vertical = 'studio'
        RETURNING id, studio_production_status`,
      [status, req.params.oid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[studio/orders/production-status]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

// ═══════════════════════════════════════════════════════════
// FASE 5: Request approval (wa.me)
// ═══════════════════════════════════════════════════════════

function generateToken() {
  return crypto.randomBytes(24).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildWaMeLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const fullDigits = digits.length === 10 || digits.length === 11 ? '55' + digits : digits;
  return `https://wa.me/${fullDigits}?text=${encodeURIComponent(text)}`;
}

router.post('/orders/:oid/approval', async function(req, res) {
  const { mockup_url, customer_phone, custom_message, expires_in_days } = req.body;
  if (!mockup_url || !/^https?:\/\//.test(mockup_url)) {
    return res.status(400).json({ error: 'mockup_url obrigatório (URL pública do mockup)' });
  }

  const orderRes = await db.query(
    `SELECT o.id, o.customer_name, o.customer_phone,
            COALESCE(o.customer_data->>'name', o.customer_name) AS display_name,
            c.trade_name, c.legal_name
       FROM digital_orders o
       LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.id = $1 AND o.company_id = $2 AND o.vertical = 'studio'
      LIMIT 1`,
    [req.params.oid, req.params.id]
  );
  if (!orderRes.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
  const order = orderRes.rows[0];

  const phone = customer_phone || order.customer_phone || '';
  const customerFirstName = (order.display_name || 'cliente').split(' ')[0];
  const shopName = order.trade_name || order.legal_name || 'nossa loja';

  let token = null;
  for (let i = 0; i < 5; i++) {
    const candidate = generateToken();
    const exists = await db.query(`SELECT 1 FROM studio_approval_links WHERE token = $1 LIMIT 1`, [candidate]);
    if (!exists.rows.length) { token = candidate; break; }
  }
  if (!token) return res.status(500).json({ error: 'Não foi possível gerar token' });

  const expiresInDays = Math.min(Math.max(parseInt(expires_in_days) || 7, 1), 30);
  const approvalUrl = `${process.env.APP_PUBLIC_URL || ''}/aprovacao/${token}`;
  const defaultMsg =
    `Oi ${customerFirstName}! Sua arte do pedido ficou pronta 🎨\n\n` +
    `Dá uma olhada e me confirma se posso imprimir:\n${approvalUrl}\n\n` +
    `_${shopName} · respondemos em até 1h_`;
  const messageText = (custom_message && String(custom_message).trim()) || defaultMsg;

  try {
    const r = await db.query(
      `INSERT INTO studio_approval_links
         (company_id, order_id, token, mockup_url, message_text,
          customer_phone, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' days')::interval, $8)
       RETURNING id, token, mockup_url, status, expires_at, created_at`,
      [req.params.id, req.params.oid, token, mockup_url, messageText,
       phone || null, String(expiresInDays), req.user?.id || null]
    );

    await db.query(
      `INSERT INTO studio_approval_revisions
         (approval_id, revision_number, mockup_url, note, created_by_type)
       VALUES ($1, 1, $2, $3, 'shop')`,
      [r.rows[0].id, mockup_url, 'Mockup inicial enviado pra aprovação']
    );

    // Onboarding: gerou primeira aprovação via WhatsApp
    markStudioOnboarding(db, req.params.id, 'wa');

    res.status(201).json({
      ...r.rows[0],
      approval_url: approvalUrl,
      wa_me_link: buildWaMeLink(phone, messageText),
      message_text: messageText,
    });
  } catch (err) {
    console.error('[studio/orders/approval:POST]', err.message);
    res.status(500).json({ error: 'Erro ao criar link de aprovação' });
  }
});

router.get('/orders/:oid/approval', async function(req, res) {
  try {
    const r = await db.query(
      `SELECT a.*,
              (SELECT json_agg(json_build_object(
                'revision_number', r.revision_number,
                'mockup_url', r.mockup_url,
                'note', r.note,
                'created_by_type', r.created_by_type,
                'created_at', r.created_at
              ) ORDER BY r.revision_number)
               FROM studio_approval_revisions r WHERE r.approval_id = a.id) AS revisions
         FROM studio_approval_links a
        WHERE a.order_id = $1 AND a.company_id = $2
        ORDER BY a.created_at DESC`,
      [req.params.oid, req.params.id]
    );
    res.json({ approvals: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar aprovações' }); }
});

router.post('/approval/:approvalId/cancel', async function(req, res) {
  try {
    const r = await db.query(
      `UPDATE studio_approval_links SET status = 'expired'
        WHERE id = $1 AND company_id = $2 AND status = 'pending'
        RETURNING id`,
      [req.params.approvalId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Aprovação não encontrada ou já respondida' });
    res.json({ cancelled: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao cancelar' }); }
});

module.exports = router;
