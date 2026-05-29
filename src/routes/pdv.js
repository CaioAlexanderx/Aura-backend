// ============================================================
// AURA. -- PDV-01: Caixa de Vendas Touch
// Venda atomica: sale + items + estoque + metricas + cupom + financeiro
// 17/05/2026 (TROCA v2): POST /troca detecta body.original_sale_ids.
// 25/05/2026 (Polish v3): GET /pdv/sales-by-product-barcode.
// 26/05/2026 (crediario): POST /sale -- bloco crediario agora atomico.
// 29/05/2026 (F1 unificacao credito):
//   - 422 CREDIARIO_REQUIRES_CUSTOMER quando crediario sem customer_id.
//   - createCreditSale chamado DENTRO da transacao principal (atomico).
//   - DELETE /sale cancela credit_installments via UPDATE.
// ============================================================
const router      = require('express').Router({ mergeParams: true });
const db          = require('../config/database');
const trocaV2     = require('../services/trocaV2');
const { createCreditSale, cancelCreditSale } = require('../services/creditLedger');

const fmt = (v) => parseFloat(v || 0).toFixed(2);
const SP_DATE_NOW = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";
const SP_DATE_COL = (col) => `(${col} AT TIME ZONE 'America/Sao_Paulo')::date`;

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

async function assertCaixaOpenOrAllowed(client, companyId) {
  try {
    const { rows: cfgRows } = await client.query(
      `SELECT pdv_settings FROM companies WHERE id = $1`, [companyId]
    );
    const caixaRequired = !!(cfgRows[0]?.pdv_settings?.caixa_enabled);
    if (!caixaRequired) return { ok: true };
    const { rows: sessoes } = await client.query(
      `SELECT id FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
      [companyId]
    );
    if (sessoes.length > 0) return { ok: true };
    return { ok: false, status: 409, body: { error: 'Abra o caixa antes de finalizar a venda.', code: 'CAIXA_REQUIRED' } };
  } catch (e) {
    console.warn('[PDV] assertCaixaOpenOrAllowed fail-open:', e.message);
    return { ok: true };
  }
}

let _exchangeColsCheckedAt = 0;
let _exchangeColsAvailable = null;
async function hasExchangeCols(client) {
  const now = Date.now();
  if (_exchangeColsAvailable !== null && (now - _exchangeColsCheckedAt) < 60000) return _exchangeColsAvailable;
  try {
    const r = await client.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_name='sales' AND column_name IN ('exchange_seller_id','exchange_employee_id')`
    );
    _exchangeColsAvailable = parseInt(r.rows[0]?.n || '0', 10) === 2;
  } catch (e) { _exchangeColsAvailable = false; }
  _exchangeColsCheckedAt = now;
  return _exchangeColsAvailable;
}

async function fetchCustomerPhone(customerId) {
  if (!customerId) return null;
  try {
    const { rows } = await db.query(`SELECT phone FROM customers WHERE id=$1`, [customerId]);
    return rows[0]?.phone || null;
  } catch (_) { return null; }
}

// ===== GET /scan/:code =====
router.get('/scan/:code', async (req, res) => {
  const raw = decodeURIComponent(req.params.code || '').trim();
  if (!raw) return res.status(400).json({ error: 'code obrigatorio', match: 'none' });
  const candidates = new Set([raw]);
  if (/^\d{12}$/.test(raw)) candidates.add('0' + raw);
  if (/^\d{13}$/.test(raw) && raw.startsWith('0')) candidates.add(raw.slice(1));
  const alts = [...candidates];
  try {
    const { rows: prods } = await db.query(
      `SELECT p.id, p.name, p.price, p.cost_price, p.barcode, p.stock_qty, p.has_variants,
              p.category, p.image_url, p.sku, p.company_id AS stock_company_id
       FROM products p JOIN companies c ON c.id=$1
       WHERE (p.company_id=$1 OR (p.company_id=c.billing_owner_company_id AND p.is_group_shared=true))
         AND p.barcode=ANY($2::text[]) AND p.is_active=true LIMIT 1`,
      [req.params.id, alts]
    );
    if (prods.length) {
      const p = prods[0];
      return res.json({ match: 'exact', source: 'barcode',
        product: { id: p.id, name: p.name, price: parseFloat(p.price)||0,
          cost_price: parseFloat(p.cost_price)||0, barcode: p.barcode,
          stock_qty: parseInt(p.stock_qty)||0, has_variants: p.has_variants||false,
          category: p.category, image_url: p.image_url, sku: p.sku, stock_company_id: p.stock_company_id } });
    }
    const { rows: vars } = await db.query(
      `SELECT pv.id AS variant_id, pv.price_override, pv.sku_suffix, pv.stock_qty AS variant_stock,
              p.id, p.name, p.price, p.barcode, p.image_url, p.company_id AS stock_company_id
       FROM product_variants pv JOIN products p ON p.id=pv.product_id
       JOIN companies c ON c.id=$1
       WHERE (p.company_id=$1 OR (p.company_id=c.billing_owner_company_id AND p.is_group_shared=true))
         AND pv.barcode=ANY($2::text[]) AND pv.is_active=true AND p.is_active=true LIMIT 1`,
      [req.params.id, alts]
    );
    if (vars.length) {
      const v = vars[0];
      return res.json({ match: 'exact', source: 'variant_barcode',
        product: { id: v.id, name: v.name, price: parseFloat(v.price)||0,
          barcode: v.barcode, image_url: v.image_url, sku_suffix: v.sku_suffix, stock_company_id: v.stock_company_id },
        variant_id: v.variant_id, effective_price: parseFloat(v.price_override)||parseFloat(v.price)||0 });
    }
    return res.json({ match: 'none', message: 'Nenhum produto encontrado' });
  } catch (e) {
    console.error('[PDV] scan error:', e.message);
    res.status(500).json({ error: 'Erro ao buscar produto', match: 'none' });
  }
});

// ===== POST /sale =====
router.post('/sale', async (req, res) => {
  const {
    items, customer_id, employee_id, payment_method,
    discount_amount, discount_pct, coupon_code, notes, seller_id, payments,
    sale_date, seller_name,
  } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'items obrigatorio' });

  // F1 (29/05/2026): 422 quando crediario sem customer_id
  // Nao pode virar venda a vista silenciosa (bug #4 do plano).
  const hasCreditInPayments = Array.isArray(payments) &&
    payments.some(p => (p.method || '').toLowerCase() === 'crediario');
  const isCrediario = (payment_method || '').toLowerCase() === 'crediario' || hasCreditInPayments;
  if (isCrediario && !customer_id) {
    return res.status(422).json({
      error: 'Cliente obrigatorio para venda no crediario.',
      code: 'CREDIARIO_REQUIRES_CUSTOMER',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (!sale_date) {
      const caixaCheck = await assertCaixaOpenOrAllowed(client, req.params.id);
      if (!caixaCheck.ok) {
        await client.query('ROLLBACK');
        return res.status(caixaCheck.status).json(caixaCheck.body);
      }
    }
    let subtotal = 0;
    const enrichedItems = [];
    const productNames = [];
    for (const item of items) {
      const qty = parseFloat(item.quantity);
      const unitPrice = parseFloat(item.unit_price);
      const lineTotal = parseFloat((qty * unitPrice).toFixed(2));
      subtotal += lineTotal;
      let productName = item.product_name_snapshot || '';
      let costPrice = 0;
      let stockCompanyId = req.params.id;
      if (item.product_id) {
        const { rows: p } = await client.query(
          `SELECT p.name, p.cost_price, p.stock_qty, p.company_id AS stock_company_id
           FROM products p JOIN companies c ON c.id=$2
           WHERE p.id=$1
             AND (p.company_id=$2 OR (p.company_id=c.billing_owner_company_id AND p.is_group_shared=true))`,
          [item.product_id, req.params.id]
        );
        if (p.length) {
          productName = productName || p[0].name;
          costPrice = parseFloat(p[0].cost_price || 0);
          stockCompanyId = p[0].stock_company_id;
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
              product_id: item.product_id, variant_id: item.variant_id || null,
            });
          }
        }
      }
      productNames.push(productName);
      enrichedItems.push({ ...item, product_name_snapshot: productName, cost_price: costPrice, line_total: lineTotal, stock_company_id: stockCompanyId });
    }
    let discountAmt = 0;
    let couponId = null;
    let couponCodeUsed = null;
    if (coupon_code) {
      const upperCode = String(coupon_code).toUpperCase().trim();
      const { rows: coupons } = await client.query(
        `SELECT * FROM coupons WHERE company_id=$1 AND code=$2 AND is_active=true`, [req.params.id, upperCode]
      );
      if (!coupons.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cupom nao encontrado' }); }
      const coupon = coupons[0];
      if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cupom expirado' }); }
      if (coupon.max_uses !== null && coupon.current_uses >= coupon.max_uses) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cupom esgotado' }); }
      if (coupon.min_order_value > 0 && subtotal < parseFloat(coupon.min_order_value)) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Valor minimo: R$ ${Number(coupon.min_order_value).toFixed(2).replace('.',',')}` }); }
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
    const rawCreditAmount = calcCreditAmount({ payment_method, payments, totalAmount });
    const creditAmount = (rawCreditAmount > 0 && customer_id) ? rawCreditAmount : 0;
    const cashAmount = parseFloat((totalAmount - creditAmount).toFixed(2));
    const { rows: sales } = await client.query(
      sale_date
        ? `INSERT INTO sales (company_id,customer_id,seller_id,employee_id,seller_name,total_amount,discount_amount,payment_method,notes,coupon_id,coupon_code,status,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed',$12::date + INTERVAL '3 hours') RETURNING *`
        : `INSERT INTO sales (company_id,customer_id,seller_id,employee_id,seller_name,total_amount,discount_amount,payment_method,notes,coupon_id,coupon_code,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed') RETURNING *`,
      [
        req.params.id, customer_id||null,
        seller_id||req.user?.id||null, employee_id||null, seller_name||null,
        totalAmount, discountAmt,
        payment_method||(payments?.[0]?.method)||'dinheiro',
        notes||null, couponId, couponCodeUsed,
        ...(sale_date ? [sale_date] : []),
      ]
    );
    const sale = sales[0];
    for (const item of enrichedItems) {
      await client.query(
        `INSERT INTO sale_items (sale_id,product_id,variant_id,quantity,unit_price,unit_cost,discount,total_price,product_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [sale.id, item.product_id||null, item.variant_id||null,
         item.quantity, item.unit_price, item.cost_price,
         item.item_discount||0, item.line_total, item.product_name_snapshot]
      );
      if (item.product_id) {
        if (item.variant_id) {
          await client.query(`UPDATE product_variants SET stock_qty=GREATEST(0,stock_qty-$1),updated_at=NOW() WHERE id=$2`, [item.quantity, item.variant_id]);
        } else {
          await client.query(`UPDATE products SET stock_qty=GREATEST(0,stock_qty-$1),updated_at=NOW() WHERE id=$2 AND company_id=$3`, [item.quantity, item.product_id, item.stock_company_id]);
        }
        await client.query(
          `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
           VALUES ($1,$2,'out',$3,$4,'sale','Venda PDV') ON CONFLICT DO NOTHING`,
          [item.product_id, item.stock_company_id, item.quantity, sale.id]
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
        `UPDATE employees SET total_sales=COALESCE(total_sales,0)+1,
           total_revenue=COALESCE(total_revenue,0)+$1, updated_at=NOW()
         WHERE id=$2 AND company_id=$3`,
        [totalAmount, employee_id, req.params.id]
      );
    }
    if (couponId) {
      await client.query(`UPDATE coupons SET current_uses=current_uses+1,updated_at=NOW() WHERE id=$1`, [couponId]);
    }

    // F1 (29/05/2026): crediario atomico DENTRO da transacao principal.
    // createCreditSale grava debit + A Receber + agenda parcelas (se installments>1).
    // Erro aqui REVERTE a venda (comportamento correto).
    if (creditAmount > 0) {
      await createCreditSale(client, {
        companyId:    req.params.id,
        customerId:   customer_id,
        saleId:       sale.id,
        amount:       creditAmount,
        installments: parseInt(req.body?.installments || 1),
        firstDueDate: req.body?.first_due_date || null,
        productNames,
        createdBy:    req.user?.id || null,
      });
    }

    let activeSessaoId = null;
    try {
      const sessRes = await client.query(
        `SELECT id FROM caixa_sessoes WHERE company_id=$1 AND status='aberta' LIMIT 1`,
        [req.params.id]
      );
      activeSessaoId = sessRes?.rows?.[0]?.id || null;
    } catch (sessErr) {}
    if (Array.isArray(payments) && payments.length > 0) {
      for (const p of payments) {
        const m = (p.method || '').toLowerCase();
        if (m === 'crediario') continue;
        const amt = parseFloat(p.value ?? p.amount ?? 0);
        if (amt <= 0) continue;
        await client.query(
          `INSERT INTO sale_payments (sale_id,company_id,method,amount,sessao_id)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [sale.id, req.params.id, p.method, amt, activeSessaoId]
        );
      }
    } else if (cashAmount > 0) {
      const fallbackMethod = (payment_method || 'dinheiro').toLowerCase();
      if (fallbackMethod !== 'crediario') {
        await client.query(
          `INSERT INTO sale_payments (sale_id,company_id,method,amount,sessao_id)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [sale.id, req.params.id, fallbackMethod, cashAmount, activeSessaoId]
        );
      }
    }
    if (cashAmount > 0) {
      const itemsSummary = productNames.slice(0, 3).join(', ');
      let payLabel = payment_method || 'dinheiro';
      if (Array.isArray(payments) && payments.length > 0) {
        const nonCredit = payments.find(p => (p.method || '').toLowerCase() !== 'crediario');
        if (nonCredit) payLabel = nonCredit.method;
      }
      const txDesc = sale_date
        ? `Venda (retroativa) - ${itemsSummary} (${payLabel})`
        : `Venda PDV - ${itemsSummary} (${payLabel})`;
      const dueDateExpr = sale_date ? `$6::date` : SP_DATE_NOW;
      const txParams = [req.params.id, cashAmount, txDesc, req.user?.id||null, 'pdv-sale-'+sale.id];
      if (sale_date) txParams.push(sale_date);
      await client.query(
        `INSERT INTO transactions
           (company_id,type,status,amount,description,category,due_date,paid_at,created_by,idempotency_key)
         VALUES ($1,'income','confirmed',$2,$3,'Vendas',${dueDateExpr},NOW(),$4,$5)
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
        `SELECT balance FROM customer_credit_balances WHERE customer_id=$1 AND company_id=$2`,
        [customer_id, req.params.id]
      );
      creditInfo = { debited: creditAmount, new_balance: parseFloat(bal[0]?.balance || 0) };
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

// ===== GET /sale/:saleId =====
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
  } catch (e) { res.status(500).json({ error: 'Erro ao buscar venda' }); }
});

// ===== GET /sales =====
router.get('/sales', async (req, res) => {
  const { date, limit=50, offset=0, include_cancelled, product_barcode, date_from, date_to, status } = req.query;
  const cond = ['s.company_id=$1'];
  const vals = [req.params.id];
  let i = 2;
  if (date) { cond.push(`${SP_DATE_COL('s.created_at')}=$${i++}`); vals.push(date); }
  if (date_from) { cond.push(`s.created_at>=$${i++}`); vals.push(date_from); }
  if (date_to)   { cond.push(`s.created_at<=$${i++}`); vals.push(date_to); }
  if (status === 'active') cond.push("s.status!='cancelled'");
  else if (!include_cancelled) cond.push("s.status!='cancelled'");
  if (product_barcode) {
    cond.push(`EXISTS (SELECT 1 FROM sale_items si2 JOIN products p2 ON p2.id=si2.product_id
      WHERE si2.sale_id=s.id AND p2.barcode=$${i})`);
    vals.push(product_barcode); i++;
  }
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.total_amount, s.discount_amount, s.payment_method, s.coupon_code, s.status,
              s.seller_name, s.created_at,
              u.full_name AS user_seller_name, c.name AS customer_name, c.cpf_cnpj,
              e.name AS employee_name, COUNT(si.id) AS items_count
       FROM sales s LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN customers c ON c.id=s.customer_id
       LEFT JOIN employees e ON e.id=s.employee_id LEFT JOIN sale_items si ON si.sale_id=s.id
       WHERE ${cond.join(' AND ')} GROUP BY s.id,u.full_name,c.name,c.cpf_cnpj,e.name
       ORDER BY s.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...vals, limit, offset]
    );
    res.json({ sales: rows });
  } catch (e) { res.status(500).json({ error: 'Erro ao listar vendas' }); }
});

// ===== GET /summary =====
router.get('/summary', async (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS total_sales, COALESCE(SUM(total_amount),0) AS gross_revenue,
              COALESCE(SUM(discount_amount),0) AS total_discounts,
              ROUND(AVG(total_amount)::NUMERIC,2) AS avg_ticket,
              json_object_agg(payment_method, cnt) AS by_payment_method
       FROM (SELECT s.total_amount, s.discount_amount, s.payment_method,
                    COUNT(*) OVER (PARTITION BY s.payment_method) AS cnt
             FROM sales s WHERE s.company_id=$1 AND ${SP_DATE_COL('s.created_at')}=$2
               AND s.status!='cancelled') sub`,
      [req.params.id, date]
    );
    res.json({ date, ...rows[0] });
  } catch (e) { res.status(500).json({ error: 'Erro ao buscar resumo' }); }
});

// ===== GET /employee-ranking =====
router.get('/employee-ranking', async (req, res) => {
  const { period='30d' } = req.query;
  const days = period==='7d' ? 7 : period==='90d' ? 90 : 30;
  try {
    const { rows } = await db.query(
      `SELECT e.id, e.name, e.role,
              COUNT(s.id) AS sales_count,
              COALESCE(SUM(s.total_amount),0) AS total_revenue,
              ROUND(COALESCE(AVG(s.total_amount),0)::NUMERIC,2) AS avg_ticket,
              MAX(s.created_at) AS last_sale_at
       FROM employees e
       LEFT JOIN sales s ON s.employee_id=e.id
         AND s.created_at>=NOW()-INTERVAL '${days} days' AND s.status!='cancelled'
       WHERE e.company_id=$1 AND e.status='active'
       GROUP BY e.id,e.name,e.role ORDER BY total_revenue DESC`,
      [req.params.id]
    );
    res.json({ period, employees: rows });
  } catch (e) { res.status(500).json({ error: 'Erro ao buscar ranking' }); }
});

// ===== DELETE /sale/:saleId =====
router.delete('/sale/:saleId', async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, customer_id, employee_id, total_amount, coupon_id, status
       FROM sales WHERE id=$1 AND company_id=$2`,
      [req.params.saleId, req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Venda nao encontrada' }); }
    const sale = rows[0];
    if (sale.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Esta venda ja foi cancelada' }); }
    const { rows: items } = await client.query(
      `SELECT si.product_id, si.variant_id, si.quantity, si.product_name_snapshot,
              COALESCE(p.company_id,$2) AS stock_company_id
       FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1`,
      [req.params.saleId, req.params.id]
    );
    for (const item of items) {
      if (!item.product_id) continue;
      const qty = parseFloat(item.quantity);
      const stockCompanyId = item.stock_company_id || req.params.id;
      if (item.variant_id) {
        await client.query(`UPDATE product_variants SET stock_qty=stock_qty+$1,updated_at=NOW() WHERE id=$2`, [qty, item.variant_id]);
      } else {
        await client.query(`UPDATE products SET stock_qty=stock_qty+$1,updated_at=NOW() WHERE id=$2 AND company_id=$3`, [qty, item.product_id, stockCompanyId]);
      }
      await client.query(
        `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
         VALUES ($1,$2,'in',$3,$4,'sale_cancel',$5)`,
        [item.product_id, stockCompanyId, qty, req.params.saleId, 'Cancelamento - '+(item.product_name_snapshot||'Produto')]
      );
    }
    if (sale.customer_id) {
      await client.query(
        `UPDATE customers SET total_purchases=GREATEST(0,total_purchases-1),
           total_spent=GREATEST(0,total_spent-$1), updated_at=NOW()
         WHERE id=$2 AND company_id=$3`,
        [sale.total_amount, sale.customer_id, req.params.id]
      );
    }
    if (sale.employee_id) {
      await client.query(
        `UPDATE employees SET total_sales=GREATEST(0,COALESCE(total_sales,0)-1),
           total_revenue=GREATEST(0,COALESCE(total_revenue,0)-$1), updated_at=NOW()
         WHERE id=$2 AND company_id=$3`,
        [sale.total_amount, sale.employee_id, req.params.id]
      );
    }
    if (sale.coupon_id) {
      await client.query(`UPDATE coupons SET current_uses=GREATEST(0,current_uses-1),updated_at=NOW() WHERE id=$1`, [sale.coupon_id]);
    }
    // Reverte crediario: debit + A Receber
    await client.query(
      `DELETE FROM customer_credit_transactions WHERE sale_id=$1 AND company_id=$2 AND type='debit'`,
      [req.params.saleId, req.params.id]
    );
    await client.query(`DELETE FROM transactions WHERE idempotency_key=$1 AND company_id=$2`, ['pdv-sale-'+req.params.saleId, req.params.id]);
    await client.query(`DELETE FROM transactions WHERE idempotency_key=$1 AND company_id=$2`, ['pdv-credit-receivable-'+req.params.saleId, req.params.id]);
    // F1 (29/05/2026): cancela credit_installments + atualiza credit_used
    try {
      await client.query(
        `UPDATE credit_installments
           SET status='cancelled', covered_amount=0, updated_at=NOW()
         WHERE sale_id=$1 AND company_id=$2 AND status IN ('pending','overdue')`,
        [req.params.saleId, req.params.id]
      );
      if (sale.customer_id) {
        await client.query(
          `UPDATE customer_credit_profiles
             SET credit_used=COALESCE((
               SELECT GREATEST(0,balance) FROM customer_credit_balances
               WHERE company_id=$1 AND customer_id=$2
             ),0), updated_at=NOW()
           WHERE company_id=$1 AND customer_id=$2`,
          [req.params.id, sale.customer_id]
        );
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }
    await client.query(
      `UPDATE sales SET status='cancelled', cancelled_at=NOW(), cancelled_by=$1,
         notes=CONCAT(COALESCE(notes,''),' [CANCELADA]'), updated_at=NOW() WHERE id=$2`,
      [req.user?.id||null, req.params.saleId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, cancelled: req.params.saleId, items_restored: items.filter(i => i.product_id).length, amount_reversed: parseFloat(sale.total_amount) });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao cancelar venda' });
  } finally { client.release(); }
});

// ===== POST /troca =====
router.post('/troca', async (req, res) => {
  const b = req.body || {};
  if (Array.isArray(b.original_sale_ids)) return trocaV2.handle(req, res);
  if (!b.original_sale_id) return res.status(400).json({ error: 'original_sale_id obrigatorio' });
  const returned = Array.isArray(b.returned_items) ? b.returned_items : [];
  const resolvedReturned = await Promise.all(
    returned.map(async (r) => {
      if (r.original_sale_item_id) return r;
      try {
        const { rows } = await db.query(
          `SELECT id FROM sale_items WHERE sale_id=$1 AND product_id=$2
           AND ($3::uuid IS NULL OR variant_id=$3) ORDER BY id LIMIT 1`,
          [b.original_sale_id, r.product_id, r.variant_id||null]
        );
        return { ...r, original_sale_item_id: rows[0]?.id||null };
      } catch (_) { return { ...r, original_sale_item_id: null }; }
    })
  );
  console.warn('[troca] payload v1 adaptado para v2', { companyId: req.params.id, sale: b.original_sale_id });
  req.body = {
    original_sale_ids: [b.original_sale_id],
    returned_items: resolvedReturned.map((r) => ({
      original_sale_id: b.original_sale_id,
      original_sale_item_id: r.original_sale_item_id,
      product_id: r.product_id, variant_id: r.variant_id||null,
      quantity: r.quantity, unit_price: r.unit_price,
      product_name_snapshot: r.product_name_snapshot,
    })),
    new_items: Array.isArray(b.new_items) ? b.new_items : [],
    payment_method_legacy: b.payment_method||'dinheiro',
    customer_id: b.customer_id, employee_id: b.employee_id,
    seller_name: b.seller_name, nfce_strategy: b.nfce_strategy||'none',
    customer_address: b.customer_address, idempotency_key: b.idempotency_key,
  };
  return trocaV2.handle(req, res);
});

// ===== POST /troca/:trocaSaleId/reemitir-fiscal =====
router.post('/troca/:trocaSaleId/reemitir-fiscal', async (req, res) => {
  const { trocaSaleId } = req.params;
  try {
    const { rows: emissions } = await db.query(
      `SELECT id, company_id, sale_id, tipo, status, notes
         FROM nfce_emissions
        WHERE sale_id=$1 AND tipo='nfe_devolucao' AND status IN ('falha','pendente')
        ORDER BY created_at`,
      [trocaSaleId]
    );
    if (!emissions.length) return res.json({ success: true, fiscal: { per_origin: [] }, message: 'Nenhuma emissao pendente.' });
    const perOrigin = [];
    for (const em of emissions) {
      const r = await trocaV2.reemitirEmissao(em);
      perOrigin.push({ origin_sale_id: r.origin_sale_id, strategy: 'devolucao_55', status: r.status, chave_acesso: r.chave_acesso, error: r.error });
    }
    return res.json({ success: true, fiscal: { per_origin: perOrigin } });
  } catch (e) {
    console.error('[PDV] reemitir-fiscal error:', e.message);
    return res.status(500).json({ error: 'Erro ao reemitir notas fiscais' });
  }
});

// ===== GET /sales-for-troca =====
router.get('/sales-for-troca', async (req, res) => {
  const { q, customer_id, order_number, nfce_chave, days=90, limit=50 } = req.query;
  const winDays = Math.max(1, Math.min(parseInt(days,10)||90, 365));
  const lim = Math.max(1, Math.min(parseInt(limit,10)||50, 200));
  const cond = [
    "s.status!='cancelled'", "COALESCE(s.type,'sale')='sale'",
    `s.created_at>=NOW()-INTERVAL '${winDays} days'`,
    `(s.company_id=$1 OR EXISTS (
       SELECT 1 FROM companies c2 WHERE c2.id=s.company_id
         AND COALESCE(NULLIF(c2.billing_owner_company_id,c2.id),c2.id)
           =COALESCE(NULLIF((SELECT billing_owner_company_id FROM companies WHERE id=$1),$1),$1)))`,
  ];
  const vals = [req.params.id];
  let i = 2;
  if (customer_id) { cond.push(`s.customer_id=$${i++}`); vals.push(customer_id); }
  let nfceJoin = '';
  if (nfce_chave && String(nfce_chave).trim()) {
    nfceJoin = `JOIN nfce_emissions ne ON ne.sale_id=s.id AND ne.tipo='nfce' AND ne.status='autorizada'`;
    cond.push(`ne.chave_acesso=$${i++}`); vals.push(String(nfce_chave).trim());
  }
  if (order_number && String(order_number).trim()) {
    const num = String(order_number).trim().replace(/^[#vV-]+/,'');
    cond.push(`s.id::text ILIKE $${i++}`); vals.push('%'+num+'%');
  }
  if (q && String(q).trim()) {
    const like = `%${String(q).trim()}%`;
    cond.push(`(LOWER(COALESCE(cust.name,'')) LIKE LOWER($${i})
      OR LOWER(COALESCE(cust.cpf_cnpj,'')) LIKE LOWER($${i})
      OR LOWER(COALESCE(s.seller_name,'')) LIKE LOWER($${i})
      OR EXISTS (SELECT 1 FROM sale_items si2 WHERE si2.sale_id=s.id
        AND LOWER(COALESCE(si2.product_name_snapshot,'')) LIKE LOWER($${i})))`);
    vals.push(like); i++;
  }
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.total_amount, s.payment_method, s.status, s.created_at,
              s.company_id, COALESCE(comp.trade_name,comp.legal_name) AS company_name,
              s.customer_id, cust.name AS customer_name, cust.cpf_cnpj,
              s.seller_id, s.seller_name,
              (s.company_id!=$1) AS is_cross_filial,
              EXISTS (SELECT 1 FROM nfce_emissions nf WHERE nf.sale_id=s.id AND nf.tipo='nfce' AND nf.status='autorizada') AS has_nfce,
              COUNT(si.id) AS item_count,
              COALESCE(json_agg(json_build_object(
                'product_id',si.product_id,'variant_id',si.variant_id,
                'product_name_snapshot',si.product_name_snapshot,
                'quantity',si.quantity,'unit_price',si.unit_price,
                'original_sale_item_id',si.id
              )) FILTER (WHERE si.id IS NOT NULL),'[]'::json) AS items
         FROM sales s ${nfceJoin}
         LEFT JOIN companies comp ON comp.id=s.company_id
         LEFT JOIN customers cust ON cust.id=s.customer_id
         LEFT JOIN sale_items si ON si.sale_id=s.id
        WHERE ${cond.join(' AND ')}
        GROUP BY s.id,comp.trade_name,comp.legal_name,cust.name,cust.cpf_cnpj
        ORDER BY s.created_at DESC LIMIT ${lim}`,
      vals
    );
    res.json(rows);
  } catch (e) {
    console.error('[PDV] Erro ao buscar vendas para troca:', e.message);
    res.status(500).json({ error: 'Erro ao buscar vendas elegiveis' });
  }
});

// ===== GET /sales-by-product-barcode =====
router.get('/sales-by-product-barcode', async (req, res) => {
  const { barcode, days=90, limit=50 } = req.query;
  const raw = String(barcode||'').trim();
  if (!raw) return res.status(400).json({ error: 'barcode obrigatorio' });
  const winDays = Math.max(1, Math.min(parseInt(days,10)||90, 365));
  const lim = Math.max(1, Math.min(parseInt(limit,10)||50, 200));
  const candidates = new Set([raw]);
  if (/^\d{12}$/.test(raw)) candidates.add('0'+raw);
  if (/^\d{13}$/.test(raw) && raw.startsWith('0')) candidates.add(raw.slice(1));
  const alts = [...candidates];
  try {
    const { rows } = await db.query(
      `WITH matched_products AS (
         SELECT p.id AS product_id, NULL::uuid AS variant_id
           FROM products p WHERE p.barcode=ANY($2::text[])
         UNION ALL
         SELECT pv.product_id, pv.id AS variant_id
           FROM product_variants pv WHERE pv.barcode=ANY($2::text[])
       ),
       eligible_sales AS (
         SELECT DISTINCT s.id FROM sales s
         JOIN sale_items si ON si.sale_id=s.id
         JOIN matched_products mp ON mp.product_id=si.product_id
           AND (mp.variant_id IS NULL OR mp.variant_id=si.variant_id)
         WHERE s.status!='cancelled' AND COALESCE(s.type,'sale')='sale'
           AND s.created_at>=NOW()-INTERVAL '${winDays} days'
           AND (s.company_id=$1 OR EXISTS (
             SELECT 1 FROM companies c2 WHERE c2.id=s.company_id
               AND COALESCE(NULLIF(c2.billing_owner_company_id,c2.id),c2.id)
                 =COALESCE(NULLIF((SELECT billing_owner_company_id FROM companies WHERE id=$1),$1),$1)))
       )
       SELECT s.id, s.total_amount, s.payment_method, s.status, s.created_at,
              s.company_id, COALESCE(comp.trade_name,comp.legal_name) AS company_name,
              s.customer_id, cust.name AS customer_name, cust.cpf_cnpj,
              s.seller_id, s.seller_name, (s.company_id!=$1) AS is_cross_filial,
              EXISTS (SELECT 1 FROM nfce_emissions nf WHERE nf.sale_id=s.id AND nf.tipo='nfce' AND nf.status='autorizada') AS has_nfce,
              COUNT(si.id) AS item_count,
              COALESCE(json_agg(json_build_object(
                'product_id',si.product_id,'variant_id',si.variant_id,
                'product_name_snapshot',si.product_name_snapshot,
                'quantity',si.quantity,'unit_price',si.unit_price,
                'original_sale_item_id',si.id
              )) FILTER (WHERE si.id IS NOT NULL),'[]'::json) AS items
         FROM sales s JOIN eligible_sales es ON es.id=s.id
         LEFT JOIN companies comp ON comp.id=s.company_id
         LEFT JOIN customers cust ON cust.id=s.customer_id
         LEFT JOIN sale_items si ON si.sale_id=s.id
        GROUP BY s.id,comp.trade_name,comp.legal_name,cust.name,cust.cpf_cnpj
        ORDER BY s.created_at DESC LIMIT ${lim}`,
      [req.params.id, alts]
    );
    res.json(rows);
  } catch (e) {
    console.error('[PDV] Erro em sales-by-product-barcode:', e.message);
    res.status(500).json({ error: 'Erro ao buscar vendas por barcode' });
  }
});

module.exports = router;
module.exports.fetchCustomerPhone = fetchCustomerPhone;
