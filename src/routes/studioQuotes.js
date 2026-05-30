// ============================================================
// AURA Studio — Orçamentos (Camada 1, Fase A)
// Contratos em services/studioApi.ts. Montado em private.js sob /studio.
//
// GET    /studio/quotes?status=&days=&limit=  → {quotes}
// POST   /studio/quotes                       → StudioQuote
// GET    /studio/quotes/:qid                  → {quote, items}
// PATCH  /studio/quotes/:qid                  → StudioQuote (só draft)
// DELETE /studio/quotes/:qid                  → {deleted:true} (só draft)
// POST   /studio/quotes/:qid/send             → StudioQuoteCreated {quote_url, wa_me_link}
// POST   /studio/quotes/:qid/convert          → {order_id, quote} (idempotente)
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const crypto  = require('crypto');
const db      = require('../config/database');

// ─── helpers ────────────────────────────────────────────────

function calcTotals(items, discount) {
  const subtotal = items.reduce((acc, it) => {
    return acc + (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_price) || 0);
  }, 0);
  const disc  = Math.max(0, parseFloat(discount) || 0);
  const total = Math.max(0, subtotal - disc);
  return { subtotal, discount: disc, total };
}

function calcEstimatedCost(items) {
  if (!items.some((it) => it.unit_cost != null)) return null;
  return items.reduce((acc, it) => {
    const cost = it.unit_cost != null ? parseFloat(it.unit_cost) : 0;
    return acc + (parseFloat(it.quantity) || 0) * cost;
  }, 0);
}

// ─── GET /quotes ─────────────────────────────────────────────
router.get('/quotes', async function(req, res) {
  const { status, days = 90, limit = 100 } = req.query;
  const cid = req.params.id;
  const safeLimit = Math.min(parseInt(limit) || 100, 500);
  const safeDays  = Math.min(parseInt(days) || 90, 365);

  const params = [cid];
  let where = 'company_id = $1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  where += ` AND created_at >= NOW() - ($${params.length + 1} || ' days')::interval`;
  params.push(String(safeDays));
  params.push(safeLimit);

  try {
    const r = await db.query(
      `SELECT id, company_id, customer_id, customer_name, customer_phone,
              status, token, subtotal, discount, total, estimated_cost,
              validity_days, expires_at, sent_at, responded_at, response_note,
              order_id, deposit_pct, deposit_amount, notes, created_by,
              created_at, updated_at
         FROM studio_quotes
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ quotes: r.rows });
  } catch (err) {
    console.error('[studio/quotes:GET]', err.message);
    res.status(500).json({ error: 'Erro ao listar orçamentos' });
  }
});

// ─── POST /quotes ────────────────────────────────────────────
router.post('/quotes', async function(req, res) {
  const {
    customer_id, customer_name, customer_phone,
    items = [], discount = 0, validity_days = 7,
    deposit_pct, deposit_amount, notes,
  } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items deve ser array não vazio' });
  }
  for (const [i, it] of items.entries()) {
    if (!it.description || !String(it.description).trim()) {
      return res.status(400).json({ error: `items[${i}].description obrigatório` });
    }
    if (!(parseFloat(it.quantity) > 0)) {
      return res.status(400).json({ error: `items[${i}].quantity deve ser > 0` });
    }
    if (parseFloat(it.unit_price) < 0 || it.unit_price == null) {
      return res.status(400).json({ error: `items[${i}].unit_price inválido` });
    }
  }

  const { subtotal, discount: disc, total } = calcTotals(items, discount);
  const estimated_cost = calcEstimatedCost(items);
  const vDays = Math.max(1, parseInt(validity_days) || 7);

  // Calcula deposit_amount se deposit_pct fornecido
  let depPct    = deposit_pct    != null ? parseFloat(deposit_pct) : null;
  let depAmount = deposit_amount != null ? parseFloat(deposit_amount) : null;
  if (depPct != null && depAmount == null) {
    depAmount = parseFloat((total * depPct / 100).toFixed(2));
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const qRes = await client.query(
      `INSERT INTO studio_quotes
         (company_id, customer_id, customer_name, customer_phone,
          status, subtotal, discount, total, estimated_cost,
          validity_days, deposit_pct, deposit_amount, notes, created_by)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        req.params.id,
        customer_id || null,
        customer_name ? String(customer_name).trim() : null,
        customer_phone ? String(customer_phone).trim() : null,
        subtotal, disc, total,
        estimated_cost,
        vDays,
        depPct, depAmount,
        notes || null,
        req.user?.id || null,
      ]
    );
    const quote = qRes.rows[0];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await client.query(
        `INSERT INTO studio_quote_items
           (quote_id, product_id, description, quantity, unit_price,
            unit_cost, pricing_meta, customization, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          quote.id,
          it.product_id || null,
          String(it.description).trim(),
          parseFloat(it.quantity),
          parseFloat(it.unit_price),
          it.unit_cost != null ? parseFloat(it.unit_cost) : null,
          it.pricing_meta ? JSON.stringify(it.pricing_meta) : null,
          it.customization ? JSON.stringify(it.customization) : null,
          it.sort_order != null ? parseInt(it.sort_order) : i,
        ]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(quote);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[studio/quotes:POST]', err.message);
    res.status(500).json({ error: 'Erro ao criar orçamento' });
  } finally {
    client.release();
  }
});

// ─── GET /quotes/:qid ────────────────────────────────────────
router.get('/quotes/:qid', async function(req, res) {
  try {
    const qRes = await db.query(
      `SELECT * FROM studio_quotes
        WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [req.params.qid, req.params.id]
    );
    if (!qRes.rows.length) return res.status(404).json({ error: 'Orçamento não encontrado' });

    const iRes = await db.query(
      `SELECT * FROM studio_quote_items
        WHERE quote_id = $1 ORDER BY sort_order, created_at`,
      [req.params.qid]
    );

    res.json({ quote: qRes.rows[0], items: iRes.rows });
  } catch (err) {
    console.error('[studio/quotes/:qid:GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar orçamento' });
  }
});

// ─── PATCH /quotes/:qid ──────────────────────────────────────
router.patch('/quotes/:qid', async function(req, res) {
  const cid = req.params.id;
  const qid = req.params.qid;

  try {
    const cur = await db.query(
      `SELECT * FROM studio_quotes WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [qid, cid]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Orçamento não encontrado' });
    if (cur.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Só é possível editar orçamentos em rascunho (draft)' });
    }

    const q = cur.rows[0];
    const {
      customer_name, customer_phone, items,
      discount, validity_days, deposit_pct, deposit_amount, notes,
    } = req.body;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Recalcula totais se items fornecidos
      let subtotal = parseFloat(q.subtotal);
      let disc     = parseFloat(q.discount);
      let total    = parseFloat(q.total);
      let estCost  = q.estimated_cost != null ? parseFloat(q.estimated_cost) : null;

      if (Array.isArray(items) && items.length > 0) {
        const t = calcTotals(items, discount != null ? discount : q.discount);
        subtotal = t.subtotal;
        disc     = t.discount;
        total    = t.total;
        estCost  = calcEstimatedCost(items);

        // Substitui itens
        await client.query('DELETE FROM studio_quote_items WHERE quote_id = $1', [qid]);
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          await client.query(
            `INSERT INTO studio_quote_items
               (quote_id, product_id, description, quantity, unit_price,
                unit_cost, pricing_meta, customization, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              qid,
              it.product_id || null,
              String(it.description || '').trim() || 'Item',
              parseFloat(it.quantity) || 1,
              parseFloat(it.unit_price) || 0,
              it.unit_cost != null ? parseFloat(it.unit_cost) : null,
              it.pricing_meta ? JSON.stringify(it.pricing_meta) : null,
              it.customization ? JSON.stringify(it.customization) : null,
              it.sort_order != null ? parseInt(it.sort_order) : i,
            ]
          );
        }
      } else if (discount != null) {
        // Só ajuste de desconto sem mudar itens
        disc  = Math.max(0, parseFloat(discount));
        total = Math.max(0, subtotal - disc);
      }

      // deposit
      let depPct    = deposit_pct    !== undefined ? (deposit_pct    != null ? parseFloat(deposit_pct)    : null) : q.deposit_pct;
      let depAmount = deposit_amount !== undefined ? (deposit_amount != null ? parseFloat(deposit_amount) : null) : q.deposit_amount;
      if (depPct != null && deposit_amount === undefined) {
        depAmount = parseFloat((total * depPct / 100).toFixed(2));
      }

      const vDays = validity_days != null ? Math.max(1, parseInt(validity_days)) : q.validity_days;

      const updRes = await client.query(
        `UPDATE studio_quotes SET
           customer_name  = $1,
           customer_phone = $2,
           subtotal       = $3,
           discount       = $4,
           total          = $5,
           estimated_cost = $6,
           validity_days  = $7,
           deposit_pct    = $8,
           deposit_amount = $9,
           notes          = $10,
           updated_at     = NOW()
         WHERE id = $11 AND company_id = $12
         RETURNING *`,
        [
          customer_name !== undefined ? (customer_name ? String(customer_name).trim() : null) : q.customer_name,
          customer_phone !== undefined ? (customer_phone ? String(customer_phone).trim() : null) : q.customer_phone,
          subtotal, disc, total, estCost,
          vDays, depPct, depAmount,
          notes !== undefined ? (notes || null) : q.notes,
          qid, cid,
        ]
      );

      await client.query('COMMIT');
      res.json(updRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[studio/quotes/:qid:PATCH]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar orçamento' });
  }
});

// ─── DELETE /quotes/:qid ─────────────────────────────────────
router.delete('/quotes/:qid', async function(req, res) {
  try {
    const r = await db.query(
      `DELETE FROM studio_quotes
        WHERE id = $1 AND company_id = $2 AND status = 'draft'
        RETURNING id`,
      [req.params.qid, req.params.id]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: 'Orçamento não encontrado ou não está em rascunho' });
    }
    res.json({ deleted: true, id: req.params.qid });
  } catch (err) {
    console.error('[studio/quotes/:qid:DELETE]', err.message);
    res.status(500).json({ error: 'Erro ao excluir orçamento' });
  }
});

// ─── POST /quotes/:qid/send ──────────────────────────────────
router.post('/quotes/:qid/send', async function(req, res) {
  const cid = req.params.id;
  const qid = req.params.qid;

  try {
    const qRes = await db.query(
      `SELECT q.*, c.studio_settings
         FROM studio_quotes q
         JOIN companies c ON c.id = q.company_id
        WHERE q.id = $1 AND q.company_id = $2 LIMIT 1`,
      [qid, cid]
    );
    if (!qRes.rows.length) return res.status(404).json({ error: 'Orçamento não encontrado' });
    const quote = qRes.rows[0];
    if (!['draft', 'sent'].includes(quote.status)) {
      return res.status(400).json({ error: `Não é possível enviar orçamento com status '${quote.status}'` });
    }

    // Gera token único
    let token = null;
    for (let i = 0; i < 5; i++) {
      const candidate = crypto.randomBytes(32).toString('hex');
      const exists = await db.query(
        `SELECT 1 FROM studio_quotes WHERE token = $1 LIMIT 1`,
        [candidate]
      );
      if (!exists.rows.length) { token = candidate; break; }
    }
    if (!token) return res.status(500).json({ error: 'Não foi possível gerar token' });

    const vDays = Math.max(1, parseInt(quote.validity_days) || 7);

    const updRes = await db.query(
      `UPDATE studio_quotes
          SET token      = $1,
              status     = 'sent',
              sent_at    = NOW(),
              expires_at = NOW() + ($2 || ' days')::interval,
              updated_at = NOW()
        WHERE id = $3 AND company_id = $4
        RETURNING *`,
      [token, String(vDays), qid, cid]
    );
    const updated = updRes.rows[0];

    const appUrl = process.env.APP_URL || 'https://app.getaura.com.br';
    const quoteUrl = `${appUrl}/orcamento/${token}`;

    // Monta wa.me se approval_wa_phone configurado
    let waMeLink = null;
    const settings = quote.studio_settings || {};
    const waPhone  = settings.approval_wa_phone;
    if (waPhone) {
      const digits = String(waPhone).replace(/\D/g, '');
      const fullDigits = (digits.length === 10 || digits.length === 11) ? '55' + digits : digits;
      const msg = encodeURIComponent(`Seu orçamento: ${quoteUrl}`);
      waMeLink = `https://wa.me/${fullDigits}?text=${msg}`;
    }

    res.json({ ...updated, quote_url: quoteUrl, wa_me_link: waMeLink });
  } catch (err) {
    console.error('[studio/quotes/:qid/send]', err.message);
    res.status(500).json({ error: 'Erro ao enviar orçamento' });
  }
});

// ─── POST /quotes/:qid/convert ───────────────────────────────
// Cria digital_order vertical='studio' + itens. Idempotente: se
// order_id já preenchido, retorna o pedido existente sem re-inserir.
router.post('/quotes/:qid/convert', async function(req, res) {
  const cid = req.params.id;
  const qid = req.params.qid;

  try {
    const qRes = await db.query(
      `SELECT * FROM studio_quotes WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [qid, cid]
    );
    if (!qRes.rows.length) return res.status(404).json({ error: 'Orçamento não encontrado' });
    const quote = qRes.rows[0];

    // Idempotente: já convertido
    if (quote.order_id) {
      const ordRes = await db.query(
        `SELECT id FROM digital_orders WHERE id = $1 LIMIT 1`,
        [quote.order_id]
      );
      return res.json({ order_id: quote.order_id, quote });
    }

    if (quote.status !== 'accepted') {
      return res.status(400).json({
        error: `Orçamento precisa estar aceito (accepted) para converter. Status atual: '${quote.status}'`,
      });
    }

    // Busca itens do orçamento
    const iRes = await db.query(
      `SELECT * FROM studio_quote_items WHERE quote_id = $1 ORDER BY sort_order, created_at`,
      [qid]
    );
    const items = iRes.rows;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Cria digital_order
      // Colunas NOT NULL conhecidas: company_id, status, total_amount (ver studioKdsApproval.js)
      const ordRes = await client.query(
        `INSERT INTO digital_orders
           (company_id, vertical, status, studio_production_status,
            customer_name, customer_phone,
            total_amount, deposit_required, deposit_paid,
            notes, created_by)
         VALUES ($1, 'studio', 'pending', 'pending_art',
                 $2, $3, $4, $5, false, $6, $7)
         RETURNING id`,
        [
          cid,
          quote.customer_name || null,
          quote.customer_phone || null,
          parseFloat(quote.total) || 0,
          quote.deposit_amount != null ? parseFloat(quote.deposit_amount) : null,
          quote.notes || null,
          req.user?.id || null,
        ]
      );
      const orderId = ordRes.rows[0].id;

      // Cria itens do pedido
      for (const it of items) {
        await client.query(
          `INSERT INTO digital_order_items
             (order_id, product_id, product_name, quantity, unit_price, customization)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            orderId,
            it.product_id || null,
            String(it.description),
            parseFloat(it.quantity),
            parseFloat(it.unit_price),
            it.customization || null,
          ]
        );
      }

      // Marca orçamento como convertido
      const updRes = await client.query(
        `UPDATE studio_quotes
            SET status     = 'converted',
                order_id   = $1,
                updated_at = NOW()
          WHERE id = $2 AND company_id = $3
          RETURNING *`,
        [orderId, qid, cid]
      );

      await client.query('COMMIT');
      res.json({ order_id: orderId, quote: updRes.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[studio/quotes/:qid/convert]', err.message);
    res.status(500).json({ error: 'Erro ao converter orçamento em pedido' });
  }
});

module.exports = router;
