// ============================================================
// AURA. -- PDV-01: Caixa de Vendas Touch
// Venda atomica: sale + items + estoque + metricas + cupom + financeiro
// TIMEZONE FIX: Todas as datas em SP (America/Sao_Paulo), nao UTC.
// FIX: Cancel restores stock + sets status='cancelled' + stock_movements
// FEAT: seller_name — nome da vendedora salvo direto (plano Essencial)
// FIX 22/04: validacao de estoque variant-aware (Fase C gap)
// FEAT 05/05/2026: pagamento 'crediario' — cria debit em
//   customer_credit_transactions e NAO entra no Financeiro/transactions.
//   Em split (payments[]), so o valor 'crediario' fica fora do Financeiro;
//   o resto vira receita normal. Cancelar venda apaga os debits (sale_id FK).
// FEAT 06/05/2026: GET /scan/:code — lookup normalizado por barcode.
//   Trata EAN-12 (UPC-A) vs EAN-13: tenta exato, depois +0 na frente,
//   depois sem o zero-líder. Cobre produtos E variantes.
// FIX 06/05/2026: split payments — frontend envia p.value (não p.amount).
//   calcCreditAmount e INSERT sale_payments agora leem p.value ?? p.amount.
// FIX 07/05/2026: crediário anônimo — cliente não é mais obrigatório.
//   Sem customer_id: creditAmount = 0, venda entra inteira no financeiro.
//   Com customer_id: comportamento original (ledger de crédito).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

const fmt = (v) => parseFloat(v || 0).toFixed(2);

const SP_DATE_NOW = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";
const SP_DATE_COL = (col) => `(${col} AT TIME ZONE 'America/Sao_Paulo')::date`;

// Calcula quanto da venda foi no crediario (split-aware).
// Retorna [creditAmount, payLabelForFinanceiro] — payLabel exclui 'crediario'
// pra descricao da transaction nao mentir.
// FIX 06/05/2026: frontend envia p.value (PaymentEntry), nao p.amount.
function calcCreditAmount({ payment_method, payments, totalAmount }) {
  if (Array.isArray(payments) && payments.length > 0) {
    let credit = 0;
    for (const p of payments) {
      if ((p.method || '').toLowerCase() === 'crediario') {
        credit += parseFloat(p.value ?? p.amount ?? 0);
      }
    }
    return parseFloat(credit.toFixed(2));
  }
  if ((payment_method || '').toLowerCase() === 'crediario') return totalAmount;
  return 0;
}

// ── GET /companies/:id/pdv/scan/:code ────────────────────────
// Lookup de produto por codigo de barras com normalizacao EAN-12↔13.
// Ordem de busca:
//   1. Exato (qualquer tamanho)
//   2. Codigo 12 digitos → tenta com '0' na frente (EAN-13)
//   3. Codigo 13 digitos com zero-lider → tenta sem o zero (EAN-12/UPC-A)
//   4. Variantes com barcode proprio
// Retorna { match, source, product, variant_id?, effective_price? }
// compativel com o tipo PdvScanResult do frontend (services/api.ts).
router.get('/scan/:code', async (req, res) => {
  const raw = decodeURIComponent(req.params.code || '').trim();
  if (!raw) return res.status(400).json({ error: 'code obrigatorio', match: 'none' });

  // Monta lista de candidates sem duplicatas
  const candidates = new Set([raw]);
  if (/^\d{12}$/.test(raw))                            candidates.add('0' + raw);
  if (/^\d{13}$/.test(raw) && raw.startsWith('0'))    candidates.add(raw.slice(1));
  const alts = [...candidates];

  try {
    // 1. Busca em products
    const { rows: prods } = await db.query(
      `SELECT id, name, price, cost_price, barcode, stock_qty, has_variants,
              category, image_url, sku
       FROM products
       WHERE company_id = $1
         AND barcode = ANY($2::text[])
         AND is_active = true
       LIMIT 1`,
      [req.params.id, alts]
    );

    if (prods.length) {
      const p = prods[0];
      return res.json({
        match: 'exact',
        source: 'barcode',
        product: {
          id:          p.id,
          name:        p.name,
          price:       parseFloat(p.price) || 0,
          cost_price:  parseFloat(p.cost_price) || 0,
          barcode:     p.barcode,
          stock_qty:   parseInt(p.stock_qty) || 0,
          has_variants: p.has_variants || false,
          category:    p.category,
          image_url:   p.image_url,
          sku:         p.sku,
        },
      });
    }

    // 2. Busca em product_variants
    const { rows: vars } = await db.query(
      `SELECT pv.id AS variant_id, pv.price_override, pv.sku_suffix, pv.stock_qty AS variant_stock,
              p.id, p.name, p.price, p.barcode, p.image_url
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE p.company_id = $1
         AND pv.barcode = ANY($2::text[])
         AND pv.is_active = true
         AND p.is_active = true
       LIMIT 1`,
      [req.params.id, alts]
    );

    if (vars.length) {
      const v = vars[0];
      return res.json({
        match: 'exact',
        source: 'variant_barcode',
        product: {
          id:        v.id,
          name:      v.name,
          price:     parseFloat(v.price) || 0,
          barcode:   v.barcode,
          image_url: v.image_url,
          sku_suffix: v.sku_suffix,
        },
        variant_id:      v.variant_id,
        effective_price: parseFloat(v.price_override) || parseFloat(v.price) || 0,
      });
    }

    return res.json({
      match: 'none',
      message: 'Nenhum produto encontrado para este codigo de barras',
    });
  } catch (e) {
    console.error('[PDV] scan error:', e.message);
    res.status(500).json({ error: 'Erro ao buscar produto por codigo de barras', match: 'none' });
  }
});

// POST /companies/:id/pdv/sale
router.post('/sale', async (req, res) => {
  const {
    items, customer_id, employee_id, payment_method,
    discount_amount, discount_pct, coupon_code,
    notes, seller_id, payments,
    sale_date, seller_name,
  } = req.body;

  if (!items?.length)
    return res.status(400).json({ error: 'items obrigatorio' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let subtotal = 0;
    const enrichedItems = [];
    const productNames = [];

    for (const item of items) {
      const qty       = parseFloat(item.quantity);
      const unitPrice = parseFloat(item.unit_price);
      const lineTotal = parseFloat((qty * unitPrice).toFixed(2));
      subtotal += lineTotal;

      let productName = item.product_name_snapshot || '';
      let costPrice   = 0;
      if (item.product_id) {
        const { rows: p } = await client.query(
          `SELECT name, cost_price, stock_qty FROM products WHERE id=$1 AND company_id=$2`,
          [item.product_id, req.params.id]
        );
        if (p.length) {
          productName = productName || p[0].name;
          costPrice   = parseFloat(p[0].cost_price || 0);

          // FIX 22/04: validar estoque da variante quando variant_id presente
          let stockAvailable = parseFloat(p[0].stock_qty);
          let stockLabel = p[0].name;
          if (item.variant_id) {
            const { rows: v } = await client.query(
              `SELECT stock_qty, sku_suffix FROM product_variants WHERE id=$1 AND product_id=$2`,
              [item.variant_id, item.product_id]
            );
            if (v.length) {
              stockAvailable = parseFloat(v[0].stock_qty);
              stockLabel = p[0].name + (v[0].sku_suffix ? ` (${v[0].sku_suffix})` : ' (variante)');
            }
          }

          if (!sale_date && stockAvailable < qty) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `Estoque insuficiente para "${stockLabel}". Disponivel: ${stockAvailable}`,
              product_id: item.product_id,
              variant_id: item.variant_id || null,
            });
          }
        }
      }
      productNames.push(productName);
      enrichedItems.push({ ...item, product_name_snapshot: productName, cost_price: costPrice, line_total: lineTotal });
    }

    let discountAmt = 0;
    let couponId = null;
    let couponCodeUsed = null;

    if (coupon_code) {
      const upperCode = String(coupon_code).toUpperCase().trim();
      const { rows: coupons } = await client.query(
        `SELECT * FROM coupons WHERE company_id=$1 AND code=$2 AND is_active=true`,
        [req.params.id, upperCode]
      );
      if (!coupons.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cupom nao encontrado' }); }
      const coupon = coupons[0];
      if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cupom expirado' }); }
      if (coupon.max_uses !== null && coupon.current_uses >= coupon.max_uses) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cupom esgotado' }); }
      if (coupon.min_order_value > 0 && subtotal < parseFloat(coupon.min_order_value)) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Valor minimo: R$ ${Number(coupon.min_order_value).toFixed(2).replace('.', ',')}` }); }
      discountAmt = coupon.discount_type === 'percent'
        ? Math.round(subtotal * parseFloat(coupon.discount_value) / 100 * 100) / 100
        : Math.min(parseFloat(coupon.discount_value), subtotal);
      couponId = coupon.id;
      couponCodeUsed = upperCode;
    } else if (discount_amount && parseFloat(discount_amount) > 0) {
      discountAmt = parseFloat(discount_amount);
    } else if (discount_pct && parseFloat(discount_pct) > 0) {
      discountAmt = parseFloat((subtotal * parseFloat(discount_pct) / 100).toFixed(2));
    }
    const totalAmount = parseFloat((subtotal - discountAmt).toFixed(2));

    if (employee_id) {
      const { rows: empCheck } = await client.query(
        `SELECT id FROM employees WHERE id=$1 AND company_id=$2`, [employee_id, req.params.id]
      );
      if (!empCheck.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Funcionario nao encontrado nesta empresa' }); }
    }

    // Crediário anônimo: sem customer_id não lança no ledger de crédito — o valor
    // inteiro vai pro financeiro como receita normal. Com customer_id, o crédito
    // fica fora do financeiro e entra em customer_credit_transactions.
    const rawCreditAmount = calcCreditAmount({ payment_method, payments, totalAmount });
    const creditAmount = (rawCreditAmount > 0 && customer_id) ? rawCreditAmount : 0;

    const { rows: sales } = await client.query(
      `INSERT INTO sales
         (company_id, customer_id, seller_id, employee_id, seller_name, total_amount, discount_amount,
          payment_method, notes, coupon_id, coupon_code, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed')
       RETURNING *`,
      [
        req.params.id, customer_id || null,
        seller_id || req.user?.id || null,
        employee_id || null,
        seller_name || null,
        totalAmount, discountAmt,
        payment_method || (payments?.[0]?.method) || 'dinheiro',
        notes || null, couponId, couponCodeUsed,
      ]
    );
    const sale = sales[0];

    for (const item of enrichedItems) {
      await client.query(
        `INSERT INTO sale_items
           (sale_id, product_id, variant_id, quantity, unit_price,
            unit_cost, discount, total_price, product_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          sale.id, item.product_id || null, item.variant_id || null,
          item.quantity, item.unit_price, item.cost_price,
          item.item_discount || 0, item.line_total, item.product_name_snapshot,
        ]
      );

      if (item.product_id) {
        if (item.variant_id) {
          await client.query(
            `UPDATE product_variants SET stock_qty=GREATEST(0,stock_qty-$1), updated_at=NOW() WHERE id=$2`,
            [item.quantity, item.variant_id]
          );
        } else {
          await client.query(
            `UPDATE products SET stock_qty=GREATEST(0,stock_qty-$1), updated_at=NOW() WHERE id=$2 AND company_id=$3`,
            [item.quantity, item.product_id, req.params.id]
          );
        }
        await client.query(
          `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
           VALUES ($1,$2,'out',$3,$4,'sale','Venda PDV') ON CONFLICT DO NOTHING`,
          [item.product_id, req.params.id, item.quantity, sale.id]
        );
      }
    }

    // FIX 06/05/2026: frontend envia p.value (campo PaymentEntry), nao p.amount.
    // Usando p.value ?? p.amount para retrocompatibilidade.
    if (payments?.length > 1) {
      for (const p of payments) {
        await client.query(
          `INSERT INTO sale_payments (sale_id,company_id,method,amount) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [sale.id, req.params.id, p.method, p.value ?? p.amount]
        );
      }
    }

    if (customer_id) {
      await client.query(
        `UPDATE customers SET total_purchases=total_purchases+1, total_spent=total_spent+$1,
           last_purchase_at=NOW(), first_purchase_at=COALESCE(first_purchase_at,NOW()), updated_at=NOW()
         WHERE id=$2 AND company_id=$3`,
        [totalAmount, customer_id, req.params.id]
      );
    }

    if (employee_id) {
      await client.query(
        `UPDATE employees SET total_sales=COALESCE(total_sales,0)+1, total_revenue=COALESCE(total_revenue,0)+$1, updated_at=NOW()
         WHERE id=$2 AND company_id=$3`,
        [totalAmount, employee_id, req.params.id]
      );
    }

    if (couponId) {
      await client.query(
        `UPDATE coupons SET current_uses=current_uses+1, updated_at=NOW() WHERE id=$1`,
        [couponId]
      );
    }

    if (creditAmount > 0) {
      await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, sale_id, type, amount, notes, created_by)
         VALUES ($1, $2, $3, 'debit', $4, $5, $6)`,
        [
          req.params.id, customer_id, sale.id, creditAmount,
          `Venda no crediario (${productNames.slice(0, 2).join(', ') || 'Venda'})`,
          req.user?.id || null,
        ]
      );
    }

    const cashAmount = parseFloat((totalAmount - creditAmount).toFixed(2));
    if (cashAmount > 0) {
      const itemsSummary = productNames.slice(0, 3).join(', ') + (productNames.length > 3 ? ` +${productNames.length - 3}` : '');
      let payLabel = payment_method || 'dinheiro';
      if (Array.isArray(payments) && payments.length > 0) {
        const nonCredit = payments.find(p => (p.method || '').toLowerCase() !== 'crediario');
        if (nonCredit) payLabel = nonCredit.method;
      }
      const txDesc = sale_date
        ? `Venda (retroativa) - ${itemsSummary} (${payLabel})`
        : `Venda PDV - ${itemsSummary} (${payLabel})`;
      const dueDateExpr = sale_date ? `$6::date` : SP_DATE_NOW;
      const txParams = [req.params.id, cashAmount, txDesc, req.user?.id || null, 'pdv-sale-' + sale.id];
      if (sale_date) txParams.push(sale_date);

      await client.query(
        `INSERT INTO transactions
           (company_id, type, status, amount, description, category, due_date, paid_at, created_by, idempotency_key)
         VALUES ($1, 'income', 'confirmed', $2, $3, 'Vendas', ${dueDateExpr}, NOW(), $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        txParams
      );
    }

    await client.query('COMMIT');

    const { rows: saleItems } = await db.query(
      `SELECT si.*, p.name AS product_name FROM sale_items si
       LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1`, [sale.id]
    );

    let creditInfo = null;
    if (creditAmount > 0) {
      const { rows: bal } = await db.query(
        `SELECT balance FROM customer_credit_balances
          WHERE customer_id=$1 AND company_id=$2`,
        [customer_id, req.params.id]
      );
      creditInfo = {
        debited: creditAmount,
        new_balance: parseFloat(bal[0]?.balance || 0),
      };
    }

    res.status(201).json({
      sale: { ...sale, items: saleItems },
      coupon_applied: couponCodeUsed ? { code: couponCodeUsed, discount: discountAmt } : null,
      credit: creditInfo,
      receipt_url: `/companies/${req.params.id}/print/receipt/${sale.id}`,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[PDV] Erro ao registrar venda:', e.message);
    res.status(500).json({ error: 'Erro ao registrar venda' });
  } finally { client.release(); }
});

// GET /companies/:id/pdv/sale/:saleId
router.get('/sale/:saleId', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, u.full_name AS user_seller_name, c.name AS customer_name, e.name AS employee_name
       FROM sales s LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN customers c ON c.id=s.customer_id
       LEFT JOIN employees e ON e.id=s.employee_id
       WHERE s.id=$1 AND s.company_id=$2`,
      [req.params.saleId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Venda nao encontrada' });
    const { rows: items } = await db.query(
      `SELECT si.*, COALESCE(p.name, si.product_name_snapshot) AS product_name
       FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1`,
      [req.params.saleId]
    );
    res.json({ ...rows[0], items });
  } catch (e) {
    console.error('[PDV] Erro ao buscar venda:', e.message);
    res.status(500).json({ error: 'Erro ao buscar venda' });
  }
});

// GET /companies/:id/pdv/sales — exclui canceladas por padrao
router.get('/sales', async (req, res) => {
  const { date, limit = 50, offset = 0, include_cancelled } = req.query;
  const cond = ['s.company_id=$1'];
  const vals = [req.params.id];
  let i = 2;
  if (date) { cond.push(`${SP_DATE_COL('s.created_at')}=$${i++}`); vals.push(date); }
  if (!include_cancelled) { cond.push("s.status != 'cancelled'"); }
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.total_amount, s.discount_amount, s.payment_method, s.coupon_code, s.status,
              s.seller_name, s.created_at,
              u.full_name AS user_seller_name, c.name AS customer_name, e.name AS employee_name,
              COUNT(si.id) AS item_count
       FROM sales s LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN customers c ON c.id=s.customer_id
       LEFT JOIN employees e ON e.id=s.employee_id
       LEFT JOIN sale_items si ON si.sale_id=s.id
       WHERE ${cond.join(' AND ')} GROUP BY s.id, u.full_name, c.name, e.name
       ORDER BY s.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...vals, limit, offset]
    );
    res.json(rows);
  } catch (e) {
    console.error('[PDV] Erro ao listar vendas:', e.message);
    res.status(500).json({ error: 'Erro ao listar vendas' });
  }
});

// GET /companies/:id/pdv/summary — exclui canceladas
router.get('/summary', async (req, res) => {
  const date = req.query.date
    || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS total_sales, COALESCE(SUM(total_amount),0) AS gross_revenue,
              COALESCE(SUM(discount_amount),0) AS total_discounts,
              ROUND(AVG(total_amount)::NUMERIC,2) AS avg_ticket,
              json_object_agg(payment_method, cnt) AS by_payment_method
       FROM (SELECT s.total_amount, s.discount_amount, s.payment_method,
                    COUNT(*) OVER (PARTITION BY s.payment_method) AS cnt
             FROM sales s WHERE s.company_id=$1 AND ${SP_DATE_COL('s.created_at')}=$2 AND s.status != 'cancelled') sub`,
      [req.params.id, date]
    );
    res.json({ date, ...rows[0] });
  } catch (e) {
    console.error('[PDV] Erro ao buscar resumo:', e.message);
    res.status(500).json({ error: 'Erro ao buscar resumo do caixa' });
  }
});

// GET /companies/:id/pdv/employee-ranking — exclui canceladas
router.get('/employee-ranking', async (req, res) => {
  const { period = '30d' } = req.query;
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  try {
    const { rows } = await db.query(
      `SELECT e.id, e.name, e.role,
              COUNT(s.id) AS sales_count,
              COALESCE(SUM(s.total_amount), 0) AS total_revenue,
              ROUND(COALESCE(AVG(s.total_amount), 0)::NUMERIC, 2) AS avg_ticket,
              MAX(s.created_at) AS last_sale_at
       FROM employees e
       LEFT JOIN sales s ON s.employee_id = e.id AND s.created_at >= NOW() - INTERVAL '${days} days' AND s.status != 'cancelled'
       WHERE e.company_id = $1 AND e.status = 'active'
       GROUP BY e.id, e.name, e.role
       ORDER BY total_revenue DESC`,
      [req.params.id]
    );
    res.json({ period, employees: rows });
  } catch (e) {
    console.error('[PDV] Erro ao buscar ranking:', e.message);
    res.status(500).json({ error: 'Erro ao buscar ranking de funcionarios' });
  }
});

// DELETE /companies/:id/pdv/sale/:saleId — CANCELAR VENDA
router.delete('/sale/:saleId', async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, customer_id, employee_id, total_amount, coupon_id, status FROM sales WHERE id=$1 AND company_id=$2`,
      [req.params.saleId, req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Venda nao encontrada' }); }
    const sale = rows[0];
    if (sale.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Esta venda ja foi cancelada' }); }

    const { rows: items } = await client.query(
      `SELECT product_id, variant_id, quantity, product_name_snapshot FROM sale_items WHERE sale_id=$1`,
      [req.params.saleId]
    );
    for (const item of items) {
      if (!item.product_id) continue;
      const qty = parseFloat(item.quantity);
      if (item.variant_id) {
        await client.query(`UPDATE product_variants SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2`, [qty, item.variant_id]);
      } else {
        await client.query(`UPDATE products SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2 AND company_id=$3`, [qty, item.product_id, req.params.id]);
      }
      await client.query(
        `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
         VALUES ($1,$2,'in',$3,$4,'sale_cancel',$5)`,
        [item.product_id, req.params.id, qty, req.params.saleId, 'Cancelamento venda - ' + (item.product_name_snapshot || 'Produto')]
      );
    }

    if (sale.customer_id) {
      await client.query(
        `UPDATE customers SET total_purchases=GREATEST(0,total_purchases-1), total_spent=GREATEST(0,total_spent-$1), updated_at=NOW()
         WHERE id=$2 AND company_id=$3`,
        [sale.total_amount, sale.customer_id, req.params.id]
      );
    }
    if (sale.employee_id) {
      await client.query(
        `UPDATE employees SET total_sales=GREATEST(0,COALESCE(total_sales,0)-1), total_revenue=GREATEST(0,COALESCE(total_revenue,0)-$1), updated_at=NOW()
         WHERE id=$2 AND company_id=$3`,
        [sale.total_amount, sale.employee_id, req.params.id]
      );
    }
    if (sale.coupon_id) {
      await client.query(`UPDATE coupons SET current_uses=GREATEST(0,current_uses-1), updated_at=NOW() WHERE id=$1`, [sale.coupon_id]);
    }

    await client.query(
      `DELETE FROM customer_credit_transactions
        WHERE sale_id = $1 AND company_id = $2 AND type = 'debit'`,
      [req.params.saleId, req.params.id]
    );

    await client.query(`DELETE FROM transactions WHERE idempotency_key=$1 AND company_id=$2`, ['pdv-sale-' + req.params.saleId, req.params.id]);
    await client.query(
      `UPDATE sales SET status='cancelled', cancelled_at=NOW(), cancelled_by=$1,
         notes=CONCAT(COALESCE(notes,''),' [CANCELADA]'), updated_at=NOW() WHERE id=$2`,
      [req.user?.id || null, req.params.saleId]
    );

    await client.query('COMMIT');
    res.json({ ok: true, cancelled: req.params.saleId, items_restored: items.filter(i => i.product_id).length, amount_reversed: parseFloat(sale.total_amount) });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[PDV] Erro ao cancelar venda:', e.message);
    res.status(500).json({ error: 'Erro ao cancelar venda' });
  } finally { client.release(); }
});

module.exports = router;
