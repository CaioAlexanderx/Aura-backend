// ============================================================
// AURA Studio · Rotas autenticadas Fase 4 (KDS) + Fase 5 (request approval)
// Arquivo separado pra não inflar studio.js.
// Mount em private.js sob mesmo prefixo /studio.
// Migration 130 (studio_production_status) + 132 (approval_links) + 25/05
// (studio_kds_unified_view_and_trigger — view studio_orders unindo
//  digital_orders + sales personalizaveis).
// 25/05/2026 S-2.5: view tambem une marketplace_orders. PATCH production-status
//   ganha branch source='marketplace' (atualiza studio_production_status_override).
// 26/05/2026: GET /orders defensivo — query simplificada com fallback gracioso
//   pra evitar 500 quando colunas/views faltam em deploys parciais (Settings
//   Studio reload dispara essa rota; bug em prod 26/05).
// 26/05/2026 (segundo fix): subselect de approval estava usando MIN(image_url)
//   — coluna real e mockup_url. MIN() agregado tambem era redundante com
//   LIMIT 1. Trocado por SELECT mockup_url puro com LIMIT 1.
// 30/05/2026 (P1 Camada 1): gate de produção configurável por loja.
//   require_deposit_for_production em studio_settings (opt-in, default false).
//   force:true bypassa o gate e loga. M2: auto-criação do marco de pagamento
//   no convert está em studioQuotes.js.
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const crypto  = require('crypto');
const db      = require('../config/database');
const { markStudioOnboarding } = require('../utils/studioOnboarding');

// ═══════════════════════════════════════════════════════════
// FASE 4: KDS de Produção (atualizado 25/05 — KDS unificado + S-2.5)
// ═══════════════════════════════════════════════════════════

// S-0 + S-2.5: awaiting_customization eh status valido + cancelled
const VALID_PRODUCTION_STATUS = [
  'awaiting_customization',
  'pending_art',
  'approved',
  'in_production',
  'ready',
  'delivered',
  'cancelled',
];

// ─── GET /orders — lista da view studio_orders (digital + pdv + marketplace) ────
router.get('/orders', async function(req, res) {
  const { status, days = 30, limit = 200 } = req.query;
  const cid = req.params.id;
  const safeLimit = Math.min(parseInt(limit) || 200, 500);
  const safeDays  = Math.min(parseInt(days) || 30, 365);
  const statusFilter = (status && VALID_PRODUCTION_STATUS.includes(String(status))) ? String(status) : null;

  // ── 1. Tentativa RICA: view completa com subselects (KDS precisa disso) ──
  try {
    const params = [cid];
    let where = `o.company_id = $1`;
    if (statusFilter) {
      params.push(statusFilter);
      where += ` AND o.studio_production_status = $${params.length}`;
    }
    where += ` AND o.created_at >= NOW() - INTERVAL '${safeDays} days'`;
    params.push(safeLimit);

    const r = await db.query(
      `SELECT o.id, o.created_at, o.total_amount, o.status,
              o.studio_production_status,
              o.customer_name, o.customer_phone,
              o.display_name,
              o.source,
              o.digital_order_id,
              o.pdv_sale_id,
              o.marketplace_order_id,
              o.marketplace_platform,
              o.customization_collected_at,
              CASE
                WHEN o.source = 'digital' THEN
                  (SELECT COUNT(*) FROM digital_order_items oi WHERE oi.order_id = o.digital_order_id)
                WHEN o.source = 'pdv' THEN
                  (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = o.pdv_sale_id)
                WHEN o.source = 'marketplace' THEN
                  (SELECT CASE
                    WHEN mo.items IS NULL THEN 0
                    WHEN jsonb_typeof(mo.items) = 'array' THEN jsonb_array_length(mo.items)
                    ELSE 0
                  END FROM marketplace_orders mo WHERE mo.id = o.marketplace_order_id)
                ELSE 0
              END AS item_count,
              (SELECT a.mockup_url FROM studio_approval_links a
                WHERE a.order_id = o.digital_order_id AND a.status = 'pending'
                ORDER BY a.created_at DESC LIMIT 1) AS pending_approval_url,
              (SELECT COUNT(*) FROM studio_approval_links a
                WHERE a.order_id = o.digital_order_id) AS approval_count
         FROM studio_orders o
        WHERE ${where}
        ORDER BY o.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    return res.json({ orders: r.rows });
  } catch (errRich) {
    console.error('[studio/orders:GET][rich]', errRich.message, errRich.code, errRich.stack);
  }

  // ── 2. Fallback SLIM ──
  try {
    const params = [cid];
    let where = `o.company_id = $1`;
    if (statusFilter) {
      params.push(statusFilter);
      where += ` AND o.studio_production_status = $${params.length}`;
    }
    where += ` AND o.created_at >= NOW() - INTERVAL '${safeDays} days'`;
    params.push(safeLimit);

    const r = await db.query(
      `SELECT o.id, o.created_at, o.total_amount, o.status,
              o.studio_production_status,
              o.customer_name, o.customer_phone,
              o.source
         FROM studio_orders o
        WHERE ${where}
        ORDER BY o.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    return res.json({
      orders: r.rows.map((row) => ({
        ...row,
        display_name: row.customer_name,
        digital_order_id: null,
        pdv_sale_id: null,
        marketplace_order_id: null,
        marketplace_platform: null,
        customization_collected_at: null,
        item_count: 0,
        pending_approval_url: null,
        approval_count: 0,
      })),
      degraded: 'slim',
    });
  } catch (errSlim) {
    console.error('[studio/orders:GET][slim]', errSlim.message, errSlim.code, errSlim.stack);
  }

  // ── 3. Fallback RAW ──
  try {
    const params = [cid];
    let where = `company_id = $1 AND vertical = 'studio'`;
    if (statusFilter) {
      params.push(statusFilter);
      where += ` AND studio_production_status = $${params.length}`;
    }
    where += ` AND created_at >= NOW() - INTERVAL '${safeDays} days'`;
    params.push(safeLimit);

    const r = await db.query(
      `SELECT id, created_at, total_amount, status,
              studio_production_status,
              customer_name, customer_phone
         FROM digital_orders
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    return res.json({
      orders: r.rows.map((row) => ({
        ...row,
        display_name: row.customer_name,
        source: 'digital',
        digital_order_id: row.id,
        pdv_sale_id: null,
        marketplace_order_id: null,
        marketplace_platform: null,
        customization_collected_at: null,
        item_count: 0,
        pending_approval_url: null,
        approval_count: 0,
      })),
      degraded: 'raw',
    });
  } catch (errRaw) {
    console.error('[studio/orders:GET][raw]', errRaw.message, errRaw.code, errRaw.stack);
    return res.json({ orders: [], degraded: 'empty', error_hint: errRaw.message });
  }
});

// ─── GET /orders/:oid — detalhe source-aware ──────────────────────
router.get('/orders/:oid', async function(req, res) {
  try {
    const headRes = await db.query(
      `SELECT * FROM studio_orders
        WHERE id = $1 AND company_id = $2
        LIMIT 1`,
      [req.params.oid, req.params.id]
    );
    if (!headRes.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    const head = headRes.rows[0];

    let items = [];
    if (head.source === 'digital') {
      try {
        const r = await db.query(
          `SELECT id, product_id, product_name, quantity, unit_price, customization
             FROM digital_order_items
            WHERE order_id = $1
            ORDER BY id`,
          [head.digital_order_id]
        );
        items = r.rows;
      } catch (e) { console.error('[studio/orders/:oid][items.digital]', e.message); }
    } else if (head.source === 'pdv') {
      try {
        const r = await db.query(
          `SELECT si.id, si.product_id, p.name AS product_name,
                  si.quantity, si.unit_price,
                  si.customization
             FROM sale_items si
             LEFT JOIN products p ON p.id = si.product_id
            WHERE si.sale_id = $1
            ORDER BY si.id`,
          [head.pdv_sale_id]
        );
        items = r.rows;
      } catch (e) { console.error('[studio/orders/:oid][items.pdv]', e.message); }
    } else if (head.source === 'marketplace') {
      try {
        const r = await db.query(
          `SELECT items, customization_data
             FROM marketplace_orders WHERE id = $1`,
          [head.marketplace_order_id]
        );
        const row = r.rows[0];
        const rawItems = Array.isArray(row?.items) ? row.items : [];
        const custData = row?.customization_data || {};
        items = rawItems.map((it, idx) => ({
          id: `${head.marketplace_order_id}-${idx}`,
          product_id: it.product_id || null,
          product_name: it.product_name || null,
          quantity: it.quantity || 1,
          unit_price: it.unit_price || 0,
          customization: it.product_id ? (custData[it.product_id] || null) : null,
        }));
      } catch (e) { console.error('[studio/orders/:oid][items.marketplace]', e.message); }
    }

    let approvals = [];
    if (head.source === 'digital') {
      try {
        const r = await db.query(
          `SELECT id, token, status, mockup_url, response_note, expires_at, responded_at, created_at
             FROM studio_approval_links
            WHERE order_id = $1
            ORDER BY created_at DESC`,
          [head.digital_order_id]
        );
        approvals = r.rows;
      } catch (e) { console.error('[studio/orders/:oid][approvals]', e.message); }
    }

    res.json({ order: head, items, approvals });
  } catch (err) {
    console.error('[studio/orders/:oid]', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

// ─── PATCH /orders/:oid/production-status — source-aware update ───
router.patch('/orders/:oid/production-status', async function(req, res) {
  const { status, force } = req.body;
  if (!VALID_PRODUCTION_STATUS.includes(status)) {
    return res.status(400).json({ error: `status inválido (use: ${VALID_PRODUCTION_STATUS.join(', ')})` });
  }
  try {
    const headRes = await db.query(
      `SELECT source, digital_order_id, pdv_sale_id, marketplace_order_id, customization_collected_at
         FROM studio_orders
        WHERE id = $1 AND company_id = $2
        LIMIT 1`,
      [req.params.oid, req.params.id]
    );
    if (!headRes.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    const head = headRes.rows[0];

    // ── P1 — Gate de produção configurável (Camada 1, 30/05/2026) ─────────
    // Opt-in por loja: require_deposit_for_production em studio_settings.
    // Default = false → produção flui sem restrição (zero quebra).
    // Só aplica pra source='digital' com deposit_required > 0.
    // force: true bypassa o gate (lojista pode forçar manualmente).
    if (status === 'in_production') {
      try {
        const settingsRes = await db.query(
          `SELECT COALESCE((studio_settings->>'require_deposit_for_production')::boolean, false) AS require_deposit
             FROM companies WHERE id = $1`,
          [req.params.id]
        );
        const requireDeposit = settingsRes.rows[0]?.require_deposit === true;

        if (requireDeposit && head.source === 'digital') {
          const depRes = await db.query(
            `SELECT deposit_required, deposit_paid FROM digital_orders WHERE id = $1 LIMIT 1`,
            [head.digital_order_id]
          );
          const ord = depRes.rows[0];
          const hasDepositRequired = ord && parseFloat(ord.deposit_required || '0') > 0;
          const depositPaid = ord?.deposit_paid === true;

          if (hasDepositRequired && !depositPaid) {
            if (!force) {
              return res.status(409).json({
                error: 'deposit_required',
                message: `Sinal de R$ ${parseFloat(ord.deposit_required).toFixed(2)} não recebido. Confirme o sinal antes de iniciar a produção, ou use force: true para forçar.`,
              });
            }
            // M2: loga quem forçou produção sem sinal confirmado
            console.warn(
              `[studio/production-status][FORCED] company=${req.params.id}` +
              ` order=${head.digital_order_id}` +
              ` by=${req.user?.id || 'unknown'}` +
              ` at=${new Date().toISOString()}`
            );
          }
        }
      } catch (gateErr) {
        // Gate não deve travar o fluxo em caso de erro de query
        console.warn('[studio/production-status][gate-check-err]', gateErr.message);
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    let updated;
    if (head.source === 'digital') {
      const r = await db.query(
        `UPDATE digital_orders
            SET studio_production_status = $1, updated_at = NOW()
          WHERE id = $2 AND company_id = $3 AND vertical = 'studio'
          RETURNING id, studio_production_status`,
        [status, head.digital_order_id, req.params.id]
      );
      updated = r.rows[0];
    } else if (head.source === 'pdv') {
      const r = await db.query(
        `UPDATE sales
            SET studio_production_status = $1, updated_at = NOW()
          WHERE id = $2 AND company_id = $3
          RETURNING id, studio_production_status`,
        [status, head.pdv_sale_id, req.params.id]
      );
      updated = r.rows[0];
    } else if (head.source === 'marketplace') {
      if (status === 'awaiting_customization' && head.customization_collected_at) {
        return res.status(400).json({
          error: 'Personalização já foi coletada; não dá pra voltar pra awaiting_customization. Use o modal Coletar Personalização pra editar a personalização.',
        });
      }
      const statusMap = {
        approved:      'separando',
        in_production: 'separando',
        ready:         'enviado',
        delivered:     'entregue',
        cancelled:     'cancelado',
      };
      const mktStatus = statusMap[status] || null;
      const r = await db.query(
        `UPDATE marketplace_orders
            SET studio_production_status_override = $1,
                ${mktStatus ? `status = '${mktStatus}', ` : ''}
                updated_at = NOW()
          WHERE id = $2 AND company_id = $3 AND vertical = 'studio'
          RETURNING id, studio_production_status_override AS studio_production_status`,
        [status === 'awaiting_customization' ? null : status, head.marketplace_order_id, req.params.id]
      );
      updated = r.rows[0];
    }

    if (!updated) return res.status(404).json({ error: 'Pedido não encontrado pra atualizar' });
    res.json({ ...updated, source: head.source });
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

  const headRes = await db.query(
    `SELECT source, digital_order_id FROM studio_orders
      WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [req.params.oid, req.params.id]
  );
  if (!headRes.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (headRes.rows[0].source !== 'digital') {
    return res.status(400).json({
      error: 'Aprovação remota só disponível pra pedidos do Canal Digital. Pra venda PDV mostre o mockup presencialmente; pra marketplace use o chat da plataforma.',
    });
  }
  const digitalOrderId = headRes.rows[0].digital_order_id;

  const orderRes = await db.query(
    `SELECT o.id, o.customer_name, o.customer_phone,
            COALESCE(o.customer_data->>'name', o.customer_name) AS display_name,
            c.trade_name, c.legal_name
       FROM digital_orders o
       LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.id = $1 AND o.company_id = $2 AND o.vertical = 'studio'
      LIMIT 1`,
    [digitalOrderId, req.params.id]
  );
  if (!orderRes.rows.length) return res.status(404).json({ error: 'Pedido digital não encontrado' });
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
      [req.params.id, digitalOrderId, token, mockup_url, messageText,
       phone || null, String(expiresInDays), req.user?.id || null]
    );

    await db.query(
      `INSERT INTO studio_approval_revisions
         (approval_id, revision_number, mockup_url, note, created_by_type)
       VALUES ($1, 1, $2, $3, 'shop')`,
      [r.rows[0].id, mockup_url, 'Mockup inicial enviado pra aprovação']
    );

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
    const headRes = await db.query(
      `SELECT source, digital_order_id FROM studio_orders
        WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [req.params.oid, req.params.id]
    );
    if (!headRes.rows.length || headRes.rows[0].source !== 'digital') {
      return res.json({ approvals: [] });
    }
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
      [headRes.rows[0].digital_order_id, req.params.id]
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
