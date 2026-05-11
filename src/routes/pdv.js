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
// FEAT 07/05/2026: POST /pdv/troca — Troca Option B.
//   Cria sales(type='troca', exchange_of_sale_id), sale_items para novos
//   itens, troca_returned_items para itens devolvidos. Restaura estoque dos
//   devolvidos, desconta dos novos. Se net > 0 cria transaction no financeiro.
//   Migration 101 adiciona coluna type + exchange_of_sale_id + tabela troca_returned_items.
// FEAT 07/05/2026: Group Stock Visibility (migration 100).
//   scan, POST /sale, DELETE /sale e POST /troca usam company_id real do
//   produto para mover estoque — subsidiárias vendem do catálogo do
//   billing_owner_company_id sem criar pool separado.
// FIX 07/05/2026: DELETE /sale — JOIN products no SELECT sale_items para
//   obter stock_company_id sem round-trip por item (compat. com testes).
// CRITICAL FIX 09/05/2026 (divergencia Davi 08/05):
//   POST /sale agora SEMPRE cria sale_payments — antes só rodava para
//   payments.length > 1, deixando 96% das vendas single-payment sem rows.
//   Isso fazia caixaService cair no fallback de transactions e
//   classificar tudo como total_outros. Agora:
//     - payments[] presente: 1 row por entry (exceto crediário, que
//       continua só em customer_credit_transactions);
//     - sem payments[]: 1 row sintetica com payment_method + cashAmount;
//     - sessao_id é resolvido por lookup da sessão aberta no momento
//       do INSERT, vinculando a venda ao caixa correto.
//   A ordem dos blocos foi reorganizada para que cashAmount seja
//   calculado antes do INSERT de sale_payments.
// HOTFIX 09/05/2026: lookup de caixa_sessoes envolto em try/catch.
//   Necessario pra (a) tolerar schemas legados sem o modulo de caixa,
//   (b) suportar testes que mockam client.query e esgotam o stack.
// FEAT 09/05/2026 (troca v2): POST /troca agora cria 2 transactions
//   distintas em vez de 1 pelo netAmount.
//     - 'Troca - Devolução' (expense, valor devolvido)
//     - 'Troca - Venda' (income, valor da nova venda)
//   Idempotency keys distintas (-return / -sale) pra cancelamento
//   granular e auditoria limpa. Funciona inclusive em troca par-a-par
//   (net=0). Net<0 (devolver dinheiro ao cliente) ignorado por ora.
// HOTFIX 09/05/2026 (troca caixa): POST /troca agora cria sale_payments
//   para a nova venda da troca (1 row com payment_method + saleTotal +
//   sessao_id da sessão aberta). Sem isso, a troca-venda não entrava no
//   caixa fechado mesmo após o fix do /sale. Identificado na divergência
//   Davi 09/05 (R$ 224,98 da troca ficou fora do caixa).
// FEAT 09/05/2026 (crediário Opção A — competência separada):
//   Crediário com customer_id agora cria transaction "Crediário - A Receber"
//   (status=pending, paid_at=NULL, idempotency_key=pdv-credit-receivable-{saleId}).
//   Não conta no caixa físico até ser confirmada pelo recebimento via
//   POST /credit/customer/:cid/payment, que faz FIFO marcando a transaction
//   como confirmed + cria sale_payment na sessão ativa do dia. Crediário
//   anônimo (sem customer_id) continua virando venda dinheiro (creditAmount=0).
//   DELETE /sale também apaga a transaction A Receber pendente da venda
//   cancelada para manter o ledger consistente.
// FEAT 09/05/2026 (troca fiscal Onda 1): POST /troca aceita
//   nfce_strategy='cancel_reissue'. Quando enviado:
//     1) localiza NFC-e autorizada da venda original (<24h);
//     2) chama nuvemfiscal.cancelNfce — abort se SEFAZ rejeitar;
//     3) marca nfce_emissions local como cancelada;
//     4) persiste sales.nfce_strategy/original_chave/devolucao_chave.
//   A NFC-e da nova venda fica a cargo do SaleComplete (auto_emit_nfce)
//   ou de chamada manual ao POST /nfce/emit. Estratégia 'devolucao_55'
//   (NF-e modelo 55) virá na Onda 2. Default 'none' = comportamento legado.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const nuvemfiscal = require('../services/nuvemfiscal');

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
// FEAT (migration 100): busca também em produtos do billing_owner_company_id
// onde is_group_shared = true.
router.get('/scan/:code', async (req, res) => {
  const raw = decodeURIComponent(req.params.code || '').trim();
  if (!raw) return res.status(400).json({ error: 'code obrigatorio', match: 'none' });

  const candidates = new Set([raw]);
  if (/^\d{12}$/.test(raw))                            candidates.add('0' + raw);
  if (/^\d{13}$/.test(raw) && raw.startsWith('0'))    candidates.add(raw.slice(1));
  const alts = [...candidates];

  try {
    const { rows: prods } = await db.query(
      `SELECT p.id, p.name, p.price, p.cost_price, p.barcode, p.stock_qty, p.has_variants,
              p.category, p.image_url, p.sku, p.company_id AS stock_company_id
       FROM products p
       JOIN companies c ON c.id = $1
       WHERE (p.company_id = $1 OR (p.company_id = c.billing_owner_company_id AND p.is_group_shared = true))
         AND p.barcode = ANY($2::text[])
         AND p.is_active = true
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
          stock_company_id: p.stock_company_id,
        },
      });
    }

    const { rows: vars } = await db.query(
      `SELECT pv.id AS variant_id, pv.price_override, pv.sku_suffix, pv.stock_qty AS variant_stock,
              p.id, p.name, p.price, p.barcode, p.image_url, p.company_id AS stock_company_id
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       JOIN companies c ON c.id = $1
       WHERE (p.company_id = $1 OR (p.company_id = c.billing_owner_company_id AND p.is_group_shared = true))
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
          stock_company_id: v.stock_company_id,
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
      let stockCompanyId = req.params.id;

      if (item.product_id) {
        const { rows: p } = await client.query(
          `SELECT p.name, p.cost_price, p.stock_qty, p.company_id AS stock_company_id
           FROM products p
           JOIN companies c ON c.id = $2
           WHERE p.id = $1
             AND (p.company_id = $2 OR (p.company_id = c.billing_owner_company_id AND p.is_group_shared = true))`,
          [item.product_id, req.params.id]
        );
        if (p.length) {
          productName  = productName || p[0].name;
          costPrice    = parseFloat(p[0].cost_price || 0);
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
              product_id: item.product_id,
              variant_id: item.variant_id || null,
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

    const rawCreditAmount = calcCreditAmount({ payment_method, payments, totalAmount });
    const creditAmount = (rawCreditAmount > 0 && customer_id) ? rawCreditAmount : 0;
    const cashAmount = parseFloat((totalAmount - creditAmount).toFixed(2));

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
            [item.quantity, item.product_id, item.stock_company_id]
          );
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

      await client.query(
        `INSERT INTO transactions
           (company_id, type, status, amount, description, category,
            due_date, paid_at, created_by, idempotency_key)
         VALUES ($1, 'income', 'pending', $2, $3, 'Crediário - A Receber',
                 ${SP_DATE_NOW}, NULL, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          req.params.id,
          creditAmount,
          `Crediário - venda ${sale.id} (${productNames.slice(0, 2).join(', ') || 'venda'})`,
          req.user?.id || null,
          'pdv-credit-receivable-' + sale.id,
        ]
      );
    }

    let activeSessaoId = null;
    try {
      const sessRes = await client.query(
        `SELECT id FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
        [req.params.id]
      );
      activeSessaoId = sessRes?.rows?.[0]?.id || null;
    } catch (sessErr) {
      // segue silenciosamente
    }

    if (Array.isArray(payments) && payments.length > 0) {
      for (const p of payments) {
        const m = (p.method || '').toLowerCase();
        if (m === 'crediario') continue;
        const amt = parseFloat(p.value ?? p.amount ?? 0);
        if (amt <= 0) continue;
        await client.query(
          `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [sale.id, req.params.id, p.method, amt, activeSessaoId]
        );
      }
    } else if (cashAmount > 0) {
      const fallbackMethod = (payment_method || 'dinheiro').toLowerCase();
      if (fallbackMethod !== 'crediario') {
        await client.query(
          `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [sale.id, req.params.id, fallbackMethod, cashAmount, activeSessaoId]
        );
      }
    }

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
      `SELECT si.product_id, si.variant_id, si.quantity, si.product_name_snapshot,
              COALESCE(p.company_id, $2) AS stock_company_id
       FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id
       WHERE si.sale_id=$1`,
      [req.params.saleId, req.params.id]
    );
    for (const item of items) {
      if (!item.product_id) continue;
      const qty = parseFloat(item.quantity);
      const stockCompanyId = item.stock_company_id || req.params.id;
      if (item.variant_id) {
        await client.query(`UPDATE product_variants SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2`, [qty, item.variant_id]);
      } else {
        await client.query(`UPDATE products SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2 AND company_id=$3`, [qty, item.product_id, stockCompanyId]);
      }
      await client.query(
        `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
         VALUES ($1,$2,'in',$3,$4,'sale_cancel',$5)`,
        [item.product_id, stockCompanyId, qty, req.params.saleId, 'Cancelamento venda - ' + (item.product_name_snapshot || 'Produto')]
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
    await client.query(`DELETE FROM transactions WHERE idempotency_key=$1 AND company_id=$2`, ['pdv-credit-receivable-' + req.params.saleId, req.params.id]);
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

// ── POST /companies/:id/pdv/troca ────────────────────────────
router.post('/troca', async (req, res) => {
  const {
    original_sale_id,
    returned_items = [],
    new_items = [],
    payment_method,
    customer_id,
    employee_id,
    seller_name,
  } = req.body;

  if (!original_sale_id)
    return res.status(400).json({ error: 'original_sale_id obrigatorio' });
  if (!returned_items.length && !new_items.length)
    return res.status(400).json({ error: 'Informe ao menos um item devolvido ou novo' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: origRows } = await client.query(
      `SELECT id, status, company_id FROM sales WHERE id=$1 AND company_id=$2`,
      [original_sale_id, req.params.id]
    );
    if (!origRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Venda original nao encontrada' });
    }
    if (origRows[0].status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Nao e possivel trocar itens de uma venda cancelada' });
    }

    const { rows: origItems } = await client.query(
      `SELECT product_id, variant_id, quantity, unit_price, product_name_snapshot
       FROM sale_items WHERE sale_id=$1`,
      [original_sale_id]
    );

    for (const ret of returned_items) {
      if (!ret.product_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cada item devolvido precisa de product_id' });
      }
      const origItem = origItems.find(
        o => o.product_id === ret.product_id &&
             (ret.variant_id ? o.variant_id === ret.variant_id : !o.variant_id)
      );
      if (!origItem) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Produto ${ret.product_name_snapshot || ret.product_id} nao encontrado na venda original`,
        });
      }
      if (parseFloat(ret.quantity) > parseFloat(origItem.quantity)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Quantidade devolvida (${ret.quantity}) excede a original (${origItem.quantity}) para "${origItem.product_name_snapshot || ret.product_id}"`,
        });
      }
    }

    const returnedValue = returned_items.reduce(
      (acc, r) => acc + parseFloat(r.quantity) * parseFloat(r.unit_price), 0
    );
    const newValue = new_items.reduce(
      (acc, n) => acc + parseFloat(n.quantity) * parseFloat(n.unit_price), 0
    );
    const netAmount = parseFloat((newValue - returnedValue).toFixed(2));
    const saleTotal = parseFloat(newValue.toFixed(2));

    for (const ret of returned_items) {
      const qty = parseFloat(ret.quantity);
      const { rows: pInfo } = await client.query('SELECT company_id FROM products WHERE id=$1', [ret.product_id]);
      const stockCompanyId = pInfo[0]?.company_id || req.params.id;
      if (ret.variant_id) {
        await client.query(
          `UPDATE product_variants SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2`,
          [qty, ret.variant_id]
        );
      } else {
        await client.query(
          `UPDATE products SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2 AND company_id=$3`,
          [qty, ret.product_id, stockCompanyId]
        );
      }
      await client.query(
        `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
         VALUES ($1,$2,'in',$3,$4,'troca','Troca — devolucao') ON CONFLICT DO NOTHING`,
        [ret.product_id, stockCompanyId, qty, original_sale_id]
      );
    }

    for (const item of new_items) {
      if (!item.product_id) continue;
      const qty = parseFloat(item.quantity);
      let stockAvailable;
      let stockLabel = item.product_name_snapshot || item.product_id;
      let trocaStockCompanyId = req.params.id;

      if (item.variant_id) {
        const { rows: vr } = await client.query(
          `SELECT pv.stock_qty, pv.sku_suffix, p.company_id AS stock_company_id
           FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE pv.id=$1 AND pv.product_id=$2`,
          [item.variant_id, item.product_id]
        );
        if (vr.length) {
          stockAvailable = parseFloat(vr[0].stock_qty);
          stockLabel += vr[0].sku_suffix ? ` (${vr[0].sku_suffix})` : ' (variante)';
          trocaStockCompanyId = vr[0].stock_company_id || req.params.id;
        }
      } else {
        const { rows: pr } = await client.query(
          `SELECT p.stock_qty, p.company_id AS stock_company_id
           FROM products p
           JOIN companies c ON c.id = $2
           WHERE p.id = $1
             AND (p.company_id = $2 OR (p.company_id = c.billing_owner_company_id AND p.is_group_shared = true))`,
          [item.product_id, req.params.id]
        );
        if (pr.length) {
          stockAvailable = parseFloat(pr[0].stock_qty);
          trocaStockCompanyId = pr[0].stock_company_id || req.params.id;
        }
      }

      if (stockAvailable !== undefined && stockAvailable < qty) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Estoque insuficiente para "${stockLabel}". Disponivel: ${stockAvailable}`,
          product_id: item.product_id,
          variant_id: item.variant_id || null,
        });
      }

      if (item.variant_id) {
        await client.query(
          `UPDATE product_variants SET stock_qty=GREATEST(0,stock_qty-$1), updated_at=NOW() WHERE id=$2`,
          [qty, item.variant_id]
        );
      } else {
        await client.query(
          `UPDATE products SET stock_qty=GREATEST(0,stock_qty-$1), updated_at=NOW() WHERE id=$2 AND company_id=$3`,
          [qty, item.product_id, trocaStockCompanyId]
        );
      }
      item._stock_company_id = trocaStockCompanyId;
    }

    const { rows: trocaSales } = await client.query(
      `INSERT INTO sales
         (company_id, customer_id, seller_id, employee_id, seller_name,
          total_amount, discount_amount, payment_method, notes,
          status, type, exchange_of_sale_id)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'completed','troca',$9)
       RETURNING *`,
      [
        req.params.id,
        customer_id || null,
        req.user?.id || null,
        employee_id || null,
        seller_name || null,
        saleTotal,
        payment_method || 'dinheiro',
        `Troca referente a venda ${original_sale_id}`,
        original_sale_id,
      ]
    );
    const trocaSale = trocaSales[0];

    for (const item of new_items) {
      const qty = parseFloat(item.quantity);
      const unitPrice = parseFloat(item.unit_price);
      const lineTotal = parseFloat((qty * unitPrice).toFixed(2));

      let costPrice = 0;
      let productName = item.product_name_snapshot || '';
      if (item.product_id) {
        const { rows: pr } = await client.query(
          `SELECT p.name, p.cost_price
           FROM products p
           JOIN companies c ON c.id = $2
           WHERE p.id = $1
             AND (p.company_id = $2 OR (p.company_id = c.billing_owner_company_id AND p.is_group_shared = true))`,
          [item.product_id, req.params.id]
        );
        if (pr.length) {
          productName = productName || pr[0].name;
          costPrice = parseFloat(pr[0].cost_price || 0);
        }
      }

      await client.query(
        `INSERT INTO sale_items
           (sale_id, product_id, variant_id, quantity, unit_price,
            unit_cost, discount, total_price, product_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)`,
        [
          trocaSale.id,
          item.product_id || null,
          item.variant_id || null,
          qty, unitPrice, costPrice, lineTotal,
          productName,
        ]
      );

      if (item.product_id) {
        const mvCompanyId = item._stock_company_id || req.params.id;
        await client.query(
          `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
           VALUES ($1,$2,'out',$3,$4,'troca','Troca — saida novo item') ON CONFLICT DO NOTHING`,
          [item.product_id, mvCompanyId, qty, trocaSale.id]
        );
      }
    }

    for (const ret of returned_items) {
      await client.query(
        `INSERT INTO troca_returned_items
           (troca_sale_id, original_sale_id, product_id, variant_id,
            quantity, unit_price, product_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          trocaSale.id,
          original_sale_id,
          ret.product_id || null,
          ret.variant_id || null,
          parseFloat(ret.quantity),
          parseFloat(ret.unit_price),
          ret.product_name_snapshot || null,
        ]
      );
    }

    let trocaSessaoId = null;
    try {
      const sRes = await client.query(
        `SELECT id FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
        [req.params.id]
      );
      trocaSessaoId = sRes?.rows?.[0]?.id || null;
    } catch (sErr) {
      // best-effort
    }

    if (saleTotal > 0) {
      const trocaPayMethod = (payment_method || 'dinheiro').toLowerCase();
      if (trocaPayMethod !== 'crediario') {
        await client.query(
          `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [trocaSale.id, req.params.id, trocaPayMethod, saleTotal, trocaSessaoId]
        );
      }
    }

    const trocaNamesSummary = (new_items || [])
      .map(n => n.product_name_snapshot || '')
      .filter(Boolean)
      .slice(0, 2)
      .join(', ') || 'itens';

    if (returnedValue > 0) {
      await client.query(
        `INSERT INTO transactions
           (company_id, type, status, amount, description, category,
            due_date, paid_at, created_by, idempotency_key)
         VALUES ($1,'expense','confirmed',$2,$3,'Troca - Devolução',${SP_DATE_NOW},NOW(),$4,$5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          req.params.id,
          parseFloat(returnedValue.toFixed(2)),
          `Troca PDV — devolução referente a venda ${original_sale_id}`,
          req.user?.id || null,
          'pdv-troca-' + trocaSale.id + '-return',
        ]
      );
    }
    if (newValue > 0) {
      await client.query(
        `INSERT INTO transactions
           (company_id, type, status, amount, description, category,
            due_date, paid_at, created_by, idempotency_key)
         VALUES ($1,'income','confirmed',$2,$3,'Troca - Venda',${SP_DATE_NOW},NOW(),$4,$5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          req.params.id,
          parseFloat(newValue.toFixed(2)),
          `Troca PDV — nova venda (${trocaNamesSummary})`,
          req.user?.id || null,
          'pdv-troca-' + trocaSale.id + '-sale',
        ]
      );
    }

    // ──────────────────────────────────────────────────────────────
    // 09/05/2026 — Troca fiscal Onda 1: cancel + reissue
    // Quando nfce_strategy='cancel_reissue', cancela a NFC-e original
    // (que precisa estar autorizada e ter <24h) e prepara o terreno
    // para que a nova NFC-e seja emitida pelo SaleComplete (auto-emit)
    // ou por chamada manual ao POST /nfce/emit usando trocaSale.id.
    // ──────────────────────────────────────────────────────────────
    let nfceFiscalResult = { strategy: 'none' };
    const nfceStrategy = (req.body.nfce_strategy || 'none').toLowerCase();

    if (nfceStrategy === 'cancel_reissue') {
      const { rows: origNfceList } = await client.query(
        `SELECT id, nuvemfiscal_id, chave_acesso, authorized_at, status, numero
           FROM nfce_emissions
          WHERE sale_id = $1 AND tipo = 'nfce' AND status = 'autorizada'
          ORDER BY created_at DESC LIMIT 1`,
        [original_sale_id]
      );
      if (!origNfceList.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Estratégia cancel_reissue requer NFC-e autorizada na venda original.',
        });
      }
      const orig = origNfceList[0];

      const ageHours = orig.authorized_at
        ? (Date.now() - new Date(orig.authorized_at).getTime()) / 3600000
        : 9999;
      if (ageHours >= 24) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'NFC-e original tem mais de 24 horas — use a estratégia devolucao_55 (NF-e modelo 55).',
          original_chave: orig.chave_acesso,
          authorized_at: orig.authorized_at,
          age_hours: Math.round(ageHours * 10) / 10,
        });
      }

      if (orig.nuvemfiscal_id) {
        try {
          await nuvemfiscal.cancelNfce(
            orig.nuvemfiscal_id,
            `Troca de mercadoria - emissao de nova NFC-e pela venda substituta (sale ${trocaSale.id.slice(0, 8)})`
          );
        } catch (sefazErr) {
          await client.query('ROLLBACK');
          console.error('[PDV troca fiscal] SEFAZ cancel error:', sefazErr.message);
          return res.status(502).json({
            error: 'SEFAZ rejeitou cancelamento da NFC-e original: ' + sefazErr.message,
            sefaz_payload: sefazErr.payload || null,
          });
        }
      }

      await client.query(
        `UPDATE nfce_emissions
            SET status        = 'cancelada',
                cancelled_at  = NOW(),
                cancel_reason = $1
          WHERE id = $2`,
        [
          'Troca de mercadoria - sale_troca=' + trocaSale.id,
          orig.id,
        ]
      );

      await client.query(
        `UPDATE sales
            SET nfce_strategy        = $1,
                nfce_original_chave  = $2,
                nfce_devolucao_chave = $2
          WHERE id = $3`,
        ['cancel_reissue', orig.chave_acesso, trocaSale.id]
      );

      nfceFiscalResult = {
        strategy: 'cancel_reissue',
        original_chave_cancelada: orig.chave_acesso,
        original_numero: orig.numero,
        original_age_hours: Math.round(ageHours * 10) / 10,
      };
    } else if (nfceStrategy !== 'none') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'nfce_strategy desconhecida ou ainda não suportada: ' + nfceStrategy,
      });
    }

    await client.query('COMMIT');

    const { rows: respNewItems } = await db.query(
      `SELECT si.*, COALESCE(p.name, si.product_name_snapshot) AS product_name
       FROM sale_items si LEFT JOIN products p ON p.id=si.product_id
       WHERE si.sale_id=$1`,
      [trocaSale.id]
    );
    const { rows: respRetItems } = await db.query(
      `SELECT tri.*, COALESCE(p.name, tri.product_name_snapshot) AS product_name
       FROM troca_returned_items tri LEFT JOIN products p ON p.id=tri.product_id
       WHERE tri.troca_sale_id=$1`,
      [trocaSale.id]
    );

    res.status(201).json({
      sale: { ...trocaSale, items: respNewItems },
      returned_items: respRetItems,
      new_items: respNewItems,
      net_amount: netAmount,
      returned_value: parseFloat(returnedValue.toFixed(2)),
      new_value: parseFloat(newValue.toFixed(2)),
      nfce: nfceFiscalResult,
      receipt_url: `/companies/${req.params.id}/print/receipt/${trocaSale.id}`,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[PDV] Erro ao registrar troca:', e.message);
    res.status(500).json({ error: 'Erro ao registrar troca' });
  } finally { client.release(); }
});

module.exports = router;
