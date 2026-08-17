// ============================================================
// AURA. — Listagem e detalhes de vendas (Item 3 Eryca)
//
// GET    /companies/:id/sales              -> lista paginada + stats agregados
// GET    /companies/:id/sales/:sale_id     -> detalhes completos + items (+ troca breakdown + fiscal)
// PATCH  /companies/:id/sales/:sale_id     -> atualiza seller da venda
// POST   /companies/:id/sales/:sale_id/cancel  -> cancela venda inteira (troca-aware)
//
// 11/05/2026 — cancel deleta sale_payments (auditoria caixa).
// 29/05/2026 — Listagem expõe s.type (sale/troca).
//
// 02/06/2026 — Troca em Vendas:
//   - GET /:sale_id devolve bloco `troca` quando type='troca':
//     returned_items, returned_value, new_value, net_amount, payments,
//     exchange_of_sale_id. (Antes só mostrava os itens novos como faturados.)
//   - Lista expõe net_amount/returned_value; receita agregada conta troca
//     pelo LÍQUIDO (novos - devolvidos), nao pelo valor cheio.
//   - POST /:sale_id/cancel agora reverte troca POR COMPLETO: re-baixa os
//     itens devolvidos, apaga as transações pdv-troca-v2-*, reverte payouts
//     (estorno/crédito) e limpa as NF-e de devolução nao autorizadas (avisa
//     as autorizadas pra cancelamento manual na SEFAZ). Antes o cancel só
//     repunha os itens novos + apagava sale_payments (deixava resíduo).
//
// 02/06/2026 (b) — GET /:sale_id devolve bloco `fiscal`: emissoes
//   nfce_emissions da venda (tipo nfce / nfe / nfe_devolucao) com status,
//   numero, chave, pdf/qr/url_consulta e error_message. Alimenta a seção
//   de Nota Fiscal no detalhe (botao Emitir NFC-e / Reprocessar NF-e).
//   Filtra SO por sale_id (uuid unico) — nao por company_id — senao troca
//   cross-filial (emissao gravada na empresa de ORIGEM, venda na empresa
//   FISICA) apareceria sem nota no detalhe.
//
// 11/06/2026 — cancel de venda no CREDIARIO reverte o crediario (relato #3):
//   o cancel generico so apagava pdv-sale-<id> + sale_payments e tratava troca;
//   uma venda fiada tem debit no ledger + 'A Receber' (pdv-credit-receivable-<id>)
//   + credit_installments que ficavam de pe. Agora, quando a venda tem debit de
//   crediario, chamamos creditLedger.cancelCreditSale (apaga debit + A Receber +
//   splits + cancela parcelas + recalcula credit_used).
//
// 19/06/2026 — REVERT do #221: a pagina Vendas volta a ser POR EMPRESA.
//   Cada CNPJ ve apenas suas proprias vendas aqui. A visibilidade cross-CNPJ
//   fica SOMENTE no sistema de trocas (pdv.js sales-for-troca /
//   sales-by-product-barcode), que ja era group-aware.
//
// 24/06/2026 — stats NaN-safe: um único numeric 'NaN' (ex.: unit_price de um
//   returned_item vindo de payload invalido) envenenava o SUM e a receita por
//   empresa virava NaN -> JSON null -> crash/zero na tela de Vendas. Agora o
//   SQL usa NULLIF(x,'NaN'::numeric) (uma linha ruim contribui 0, nao zera o
//   total) e o JS aplica `|| 0` em revenue/avg_ticket/net_amount. Raiz (nao
//   persistir NaN) tratada no trocaV2.js.
// ============================================================

const router = require('express').Router({ mergeParams: true });
const pool = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const creditLedger = require('../services/creditLedger');

// Constroi clausula WHERE dinamica baseada nos filtros recebidos.
function buildWhere(companyId, filters) {
  const conds = ['s.company_id = $1'];
  const vals = [companyId];
  let i = 2;

  if (filters.date_from) {
    conds.push('s.created_at >= $' + (i++) + '::timestamptz');
    vals.push(filters.date_from);
  }
  if (filters.date_to) {
    conds.push('s.created_at <= $' + (i++) + '::timestamptz');
    vals.push(filters.date_to);
  }
  if (filters.status === 'active') {
    conds.push("COALESCE(s.status, 'completed') != 'cancelled'");
  } else if (filters.status === 'cancelled') {
    conds.push("s.status = 'cancelled'");
  }

  if (filters.seller_id) {
    conds.push('(s.seller_id = $' + i + ' OR s.employee_id = $' + i + ')');
    vals.push(filters.seller_id);
    i++;
  }
  if (filters.customer_id) {
    conds.push('s.customer_id = $' + (i++));
    vals.push(filters.customer_id);
  }
  if (filters.q) {
    conds.push('(c.name ILIKE $' + i + ' OR COALESCE(s.seller_name, e.name) ILIKE $' + i + ')');
    vals.push('%' + filters.q + '%');
    i++;
  }

  if (filters.product_barcode) {
    conds.push(
      'EXISTS (' +
      '  SELECT 1 FROM sale_items si ' +
      '  LEFT JOIN products p ON p.id = si.product_id ' +
      '  LEFT JOIN product_variants pv ON pv.id = si.variant_id ' +
      '  WHERE si.sale_id = s.id ' +
      '    AND (p.barcode = $' + i + ' OR pv.barcode = $' + i + ')' +
      ')'
    );
    vals.push(filters.product_barcode);
    i++;
  }

  return { conds: conds.join(' AND '), vals: vals };
}

// GET /companies/:id/sales
router.get('/', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const {
    date_from, date_to, status, seller_id, customer_id,
    q, product_barcode, limit, offset,
  } = req.query;

  const filters = { date_from, date_to, status, seller_id, customer_id, q, product_barcode };
  const { conds, vals } = buildWhere(companyId, filters);

  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const offsetNum = parseInt(offset) || 0;

  const countQuery =
    'SELECT COUNT(*)::int AS total FROM sales s ' +
    'LEFT JOIN customers c ON c.id = s.customer_id ' +
    'LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id ' +
    'WHERE ' + conds;
  const { rows: countRows } = await pool.query(countQuery, vals);
  const total = countRows[0].total;

  // 02/06/2026: lista expoe net_amount/returned_value pra troca (lista mostra liquido).
  // net = total_amount (novos) - SUM(troca_returned_items) quando type='troca'.
  // 24/06/2026: NULLIF(...,'NaN') no subselect — um numeric 'NaN' nao polui o returned_value.
  const listQuery =
    'SELECT s.id, s.total_amount, s.discount_amount, s.payment_method, s.status, ' +
    "       COALESCE(s.type, 'sale') AS type, s.exchange_of_sale_id, " +
    '       s.cancelled_at, s.created_at, ' +
    '       s.customer_id, c.name AS customer_name, ' +
    '       s.seller_id, COALESCE(s.seller_name, e.name) AS seller_name, s.employee_id, ' +
    '       (SELECT COUNT(*)::int FROM sale_items WHERE sale_id = s.id) AS items_count, ' +
    "       (SELECT COALESCE(SUM(NULLIF(tri.quantity,'NaN'::numeric) * NULLIF(tri.unit_price,'NaN'::numeric)), 0) FROM troca_returned_items tri WHERE tri.troca_sale_id = s.id) AS returned_value, " +
    "       (SELECT t.id FROM transactions t WHERE t.idempotency_key = 'pdv-sale-' || s.id AND t.company_id = s.company_id LIMIT 1) AS transaction_id " +
    'FROM sales s ' +
    'LEFT JOIN customers c ON c.id = s.customer_id ' +
    'LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id ' +
    'WHERE ' + conds + ' ' +
    'ORDER BY s.created_at DESC ' +
    'LIMIT $' + (vals.length + 1) + ' OFFSET $' + (vals.length + 2);
  const { rows } = await pool.query(listQuery, [...vals, limitNum, offsetNum]);

  // Stats agregados: receita conta troca pelo LIQUIDO (novos - devolvidos),
  // venda normal pelo total_amount. (Antes somava total_amount cheio da troca.)
  // 24/06/2026: NULLIF(...,'NaN'::numeric) em cada termo — um único valor NaN
  // (ex.: unit_price corrompido) deixa de envenenar o SUM/AVG inteiro (uma
  // linha ruim contribui 0/NULL em vez de zerar a receita da empresa toda).
  const statsQuery =
    'SELECT ' +
    '  COUNT(*)::int AS total_sales, ' +
    "  COUNT(*) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled')::int AS active_sales, " +
    "  COUNT(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled_sales, " +
    "  COALESCE(SUM( " +
    "    CASE WHEN COALESCE(s.type,'sale') = 'troca' " +
    "         THEN COALESCE(NULLIF(s.total_amount,'NaN'::numeric),0) - (SELECT COALESCE(SUM(NULLIF(tri.quantity,'NaN'::numeric)*NULLIF(tri.unit_price,'NaN'::numeric)),0) FROM troca_returned_items tri WHERE tri.troca_sale_id = s.id) " +
    "         ELSE COALESCE(NULLIF(s.total_amount,'NaN'::numeric),0) END " +
    "  ) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled'), 0)::numeric AS revenue, " +
    "  COALESCE(AVG(NULLIF(s.total_amount,'NaN'::numeric)) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled' AND COALESCE(s.type,'sale')='sale'), 0)::numeric AS avg_ticket " +
    'FROM sales s ' +
    'LEFT JOIN customers c ON c.id = s.customer_id ' +
    'LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id ' +
    'WHERE ' + conds;
  const { rows: statsRows } = await pool.query(statsQuery, vals);
  const stats = statsRows[0];

  res.json({
    total: total,
    limit: limitNum,
    offset: offsetNum,
    sales: rows.map(function(r) {
      const type = r.type || 'sale';
      // 24/06/2026: `|| 0` defende contra um total_amount/returned_value NaN
      // (numeric 'NaN' serializa como string "NaN" -> parseFloat = NaN).
      const newValue = parseFloat(r.total_amount) || 0;
      const returnedValue = parseFloat(r.returned_value) || 0;
      const isTroca = type === 'troca';
      return {
        id: r.id,
        total_amount: newValue,
        discount_amount: parseFloat(r.discount_amount || 0) || 0,
        payment_method: r.payment_method,
        status: r.status || 'completed',
        type: type,
        exchange_of_sale_id: r.exchange_of_sale_id || null,
        // troca: liquido = novos - devolvidos; venda normal: net = total
        returned_value: isTroca ? returnedValue : 0,
        net_amount: isTroca ? parseFloat((newValue - returnedValue).toFixed(2)) : newValue,
        cancelled_at: r.cancelled_at,
        created_at: r.created_at,
        customer: r.customer_id ? { id: r.customer_id, name: r.customer_name } : null,
        seller: { id: r.seller_id || r.employee_id || null, name: r.seller_name || null },
        items_count: r.items_count,
        transaction_id: r.transaction_id,
      };
    }),
    stats: {
      total_sales: stats.total_sales,
      active_sales: stats.active_sales,
      cancelled_sales: stats.cancelled_sales,
      revenue: parseFloat(stats.revenue) || 0,
      avg_ticket: parseFloat(stats.avg_ticket) || 0,
    },
  });
}));

// GET /companies/:id/sales/:sale_id
router.get('/:sale_id', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const saleId = req.params.sale_id;

  const saleRes = await pool.query(
    'SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, ' +
    '       COALESCE(s.seller_name, e.name) AS seller_name_eff, ' +
    "       (SELECT t.id FROM transactions t WHERE t.idempotency_key = 'pdv-sale-' || s.id AND t.company_id = s.company_id LIMIT 1) AS transaction_id " +
    'FROM sales s ' +
    'LEFT JOIN customers c ON c.id = s.customer_id ' +
    'LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id ' +
    'WHERE s.id = $1 AND s.company_id = $2',
    [saleId, companyId]
  );
  if (!saleRes.rows.length) throw new AppError('Venda nao encontrada', 404);
  const sale = saleRes.rows[0];

  const itemsRes = await pool.query(
    'SELECT si.id, si.product_id, si.variant_id, si.quantity, si.unit_price, ' +
    '       si.discount, si.total_price, si.product_name_snapshot, ' +
    '       p.name AS product_name, p.image_url ' +
    'FROM sale_items si ' +
    'LEFT JOIN products p ON p.id = si.product_id ' +
    'WHERE si.sale_id = $1 ' +
    'ORDER BY si.id',
    [saleId]
  );

  const items = itemsRes.rows.map(function(r) {
    return {
      id: r.id,
      product_id: r.product_id,
      variant_id: r.variant_id,
      quantity: parseFloat(r.quantity) || 0,
      unit_price: parseFloat(r.unit_price) || 0,
      discount: parseFloat(r.discount || 0) || 0,
      total_price: parseFloat(r.total_price) || 0,
      product_name: r.product_name || r.product_name_snapshot || 'Item',
      image_url: r.image_url,
    };
  });

  // 02/06/2026: bloco `troca` quando type='troca' — lado devolvido + liquido + pagamentos.
  let troca = null;
  if ((sale.type || 'sale') === 'troca') {
    const retRes = await pool.query(
      'SELECT tri.product_id, tri.variant_id, tri.quantity, tri.unit_price, ' +
      '       tri.product_name_snapshot, tri.original_sale_id, ' +
      '       p.name AS product_name, p.image_url ' +
      'FROM troca_returned_items tri ' +
      'LEFT JOIN products p ON p.id = tri.product_id ' +
      'WHERE tri.troca_sale_id = $1 ORDER BY tri.id',
      [saleId]
    );
    const payRes = await pool.query(
      'SELECT method, amount FROM sale_payments WHERE sale_id = $1 ORDER BY id',
      [saleId]
    );
    const returnedValue = retRes.rows.reduce(function(acc, r) {
      return acc + (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_price) || 0);
    }, 0);
    const newValue = items.reduce(function(acc, r) { return acc + r.total_price; }, 0);
    troca = {
      exchange_of_sale_id: sale.exchange_of_sale_id || null,
      returned_value: parseFloat(returnedValue.toFixed(2)),
      new_value: parseFloat(newValue.toFixed(2)),
      net_amount: parseFloat((newValue - returnedValue).toFixed(2)),
      returned_items: retRes.rows.map(function(r) {
        return {
          product_id: r.product_id,
          variant_id: r.variant_id,
          quantity: parseFloat(r.quantity) || 0,
          unit_price: parseFloat(r.unit_price) || 0,
          product_name: r.product_name || r.product_name_snapshot || 'Item',
          image_url: r.image_url,
          original_sale_id: r.original_sale_id,
        };
      }),
      payments: payRes.rows.map(function(r) {
        return { method: r.method, amount: parseFloat(r.amount) || 0 };
      }),
    };
  }

  // 02/06/2026 (b): bloco `fiscal` — emissoes da venda (NFC-e 65 / NF-e 55 devolucao).
  // Filtra SO por sale_id (uuid unico). NAO por company_id: numa troca cross-filial
  // a emissao e gravada na empresa de ORIGEM, enquanto a venda da troca pertence a
  // empresa FISICA — com filtro de company_id o detalhe mostraria "sem nota".
  // Defensivo (schema pre-migration): nfce_emissions/colunas podem faltar em deploy antigo.
  let fiscal = [];
  try {
    const fRes = await pool.query(
      'SELECT id, tipo, status, numero, serie, chave_acesso, pdf_url, qr_code, ' +
      '       url_consulta, error_message, created_at, authorized_at ' +
      'FROM nfce_emissions WHERE sale_id = $1 ORDER BY created_at DESC',
      [saleId]
    );
    fiscal = fRes.rows.map(function(r) {
      return {
        id: r.id,
        tipo: r.tipo,
        status: r.status,
        numero: r.numero,
        serie: r.serie,
        chave_acesso: r.chave_acesso,
        pdf_url: r.pdf_url,
        qr_code: r.qr_code,
        url_consulta: r.url_consulta,
        error_message: r.error_message,
        created_at: r.created_at,
        authorized_at: r.authorized_at,
      };
    });
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }

  res.json({
    sale: {
      id: sale.id,
      total_amount: parseFloat(sale.total_amount) || 0,
      discount_amount: parseFloat(sale.discount_amount || 0) || 0,
      payment_method: sale.payment_method,
      status: sale.status || 'completed',
      type: sale.type || 'sale',
      exchange_of_sale_id: sale.exchange_of_sale_id || null,
      cancelled_at: sale.cancelled_at,
      created_at: sale.created_at,
      notes: sale.notes,
      cash_tendered: sale.cash_tendered ? parseFloat(sale.cash_tendered) : null,
      coupon_code: sale.coupon_code,
      transaction_id: sale.transaction_id,
    },
    customer: sale.customer_id ? {
      id: sale.customer_id,
      name: sale.customer_name,
      phone: sale.customer_phone,
      email: sale.customer_email,
    } : null,
    seller: {
      id: sale.seller_id || sale.employee_id,
      name: sale.seller_name_eff,
    },
    items: items,
    troca: troca,
    fiscal: fiscal,
  });
}));

// PATCH /companies/:id/sales/:sale_id
router.patch('/:sale_id', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const saleId = req.params.sale_id;
  const { seller_id } = req.body || {};

  const saleRes = await pool.query(
    'SELECT id, status FROM sales WHERE id = $1 AND company_id = $2',
    [saleId, companyId]
  );
  if (!saleRes.rows.length) throw new AppError('Venda nao encontrada', 404);

  let sellerName = null;
  const resolvedSellerId = seller_id || null;

  if (seller_id) {
    const empRes = await pool.query(
      'SELECT id, name FROM employees WHERE id = $1 AND company_id = $2',
      [seller_id, companyId]
    );
    if (!empRes.rows.length) throw new AppError('Vendedor nao encontrado nesta empresa', 404);
    sellerName = empRes.rows[0].name;
  }

  await pool.query(
    'UPDATE sales SET seller_id = $1, employee_id = $1, seller_name = $2, updated_at = NOW() WHERE id = $3 AND company_id = $4',
    [resolvedSellerId, sellerName, saleId, companyId]
  );

  res.json({ ok: true, sale_id: saleId, seller_id: resolvedSellerId, seller_name: sellerName });
}));

// POST /companies/:id/sales/:sale_id/cancel  (troca-aware)
router.post('/:sale_id/cancel', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const saleId = req.params.sale_id;
  const reason = ((req.body && req.body.reason) || '').toString().trim().slice(0, 200);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const saleRes = await client.query(
      "SELECT id, total_amount, status, COALESCE(type,'sale') AS type FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE",
      [saleId, companyId]
    );
    if (!saleRes.rows.length) throw new AppError('Venda nao encontrada', 404);
    if (saleRes.rows[0].status === 'cancelled') {
      throw new AppError('Venda ja esta cancelada', 400);
    }
    const isTroca = saleRes.rows[0].type === 'troca';

    // Repoe estoque dos itens da venda (na troca = itens NOVOS levados)
    const itemsRes = await client.query(
      'SELECT si.product_id, si.variant_id, si.quantity FROM sale_items si WHERE si.sale_id = $1',
      [saleId]
    );
    for (let idx = 0; idx < itemsRes.rows.length; idx++) {
      const item = itemsRes.rows[idx];
      const qty = parseFloat(item.quantity);
      if (item.variant_id) {
        await client.query(
          'UPDATE product_variants SET stock_qty = COALESCE(stock_qty, 0) + $1, updated_at = NOW() WHERE id = $2',
          [qty, item.variant_id]
        );
      } else if (item.product_id) {
        await client.query(
          'UPDATE products SET stock_qty = COALESCE(stock_qty, 0) + $1, updated_at = NOW() WHERE id = $2 AND company_id = $3',
          [qty, item.product_id, companyId]
        );
      }
    }

    await client.query(
      "UPDATE sales SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $1, updated_at = NOW(), " +
      "                notes = COALESCE(notes, '') || CASE WHEN $2::text != '' THEN E'\\nCancelada: ' || $2::text ELSE '' END " +
      'WHERE id = $3',
      [req.user && req.user.id ? req.user.id : null, reason, saleId]
    );

    // Transacao da venda normal
    const txRes = await client.query(
      'SELECT id, amount FROM transactions WHERE idempotency_key = $1 AND company_id = $2',
      ['pdv-sale-' + saleId, companyId]
    );
    let refundedAmount = 0;
    let txRemoved = false;
    if (txRes.rows.length) {
      refundedAmount = parseFloat(txRes.rows[0].amount);
      await client.query('DELETE FROM transactions WHERE id = $1', [txRes.rows[0].id]);
      txRemoved = true;
    }

    // Taxa da maquininha (17/08/2026): a despesa pdv-card-fee-<id> tem que
    // sair JUNTO com a receita da venda. Senao cancelar a venda deixava a
    // despesa orfa -- a receita sumia e o custo ficava, virando prejuizo
    // fantasma no fechamento. Este cancel apaga transacao por transacao,
    // por idempotency_key: a chave nova precisa estar listada aqui.
    const cardFeeDel = await client.query(
      'DELETE FROM transactions WHERE idempotency_key = $1 AND company_id = $2 RETURNING amount',
      ['pdv-card-fee-' + saleId, companyId]
    );
    const cardFeeRemoved = cardFeeDel.rows.length > 0;

    const paymentsDel = await client.query(
      'DELETE FROM sale_payments WHERE sale_id = $1 RETURNING id, amount',
      [saleId]
    );
    const paymentsRemoved = paymentsDel.rows.length;
    const paymentsAmount = paymentsDel.rows.reduce(function(acc, r) {
      return acc + parseFloat(r.amount || 0);
    }, 0);

    // ── Crediario: reverte debito + A Receber + parcelas (relato #3) ──
    // O cancel generico (acima) so apaga pdv-sale-<id> (venda a vista) +
    // sale_payments. Uma venda no CREDIARIO tem, em vez disso, um 'debit' no
    // ledger + 'A Receber' (pdv-credit-receivable-<id> + splits) + credit_installments.
    // Sem isso, o saldo/parcelas do cliente ficavam de pe apos o cancelamento.
    // cancelCreditSale apaga debit + A Receber + splits, cancela as parcelas e
    // recalcula credit_used. Defensivo a schema pre-migration (42P01/42703).
    let creditReversed = false;
    try {
      const credRes = await client.query(
        "SELECT 1 FROM customer_credit_transactions WHERE sale_id = $1 AND company_id = $2 AND type = 'debit' LIMIT 1",
        [saleId, companyId]
      );
      if (credRes.rows.length) {
        await creditLedger.cancelCreditSale(client, { companyId: companyId, saleId: saleId });
        creditReversed = true;
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }

    // ── Troca: reversao adicional (o cancel generico nao desfaz a troca) ──
    let trocaReturnedDecremented = 0;
    let trocaTxRemoved = 0;
    let payoutsReversed = 0;
    const fiscalWarnings = [];
    if (isTroca) {
      // 1) Re-baixa os itens DEVOLVIDOS (a troca tinha somado de volta ao estoque)
      const retRows = await client.query(
        'SELECT product_id, variant_id, quantity FROM troca_returned_items WHERE troca_sale_id = $1',
        [saleId]
      );
      for (let k = 0; k < retRows.rows.length; k++) {
        const ri = retRows.rows[k];
        const rq = parseFloat(ri.quantity);
        if (ri.variant_id) {
          await client.query(
            'UPDATE product_variants SET stock_qty = GREATEST(0, COALESCE(stock_qty,0) - $1), updated_at = NOW() WHERE id = $2',
            [rq, ri.variant_id]
          );
        } else if (ri.product_id) {
          await client.query(
            'UPDATE products SET stock_qty = GREATEST(0, COALESCE(stock_qty,0) - $1), updated_at = NOW() WHERE id = $2',
            [rq, ri.product_id]
          );
        }
        if (ri.product_id) {
          await client.query(
            'INSERT INTO stock_movements (product_id, company_id, type, quantity, reference_id, reference_type, notes) ' +
            "VALUES ($1, $2, 'out', $3, $4, 'troca_cancel', 'Cancelamento de troca - retira item devolvido') ON CONFLICT DO NOTHING",
            [ri.product_id, companyId, rq, saleId]
          );
        }
        trocaReturnedDecremented++;
      }

      // 2) Remove as transacoes da troca (financeiro)
      const trocaTxDel = await client.query(
        'DELETE FROM transactions WHERE company_id = $1 AND idempotency_key IN ($2, $3) RETURNING id',
        [companyId, 'pdv-troca-v2-' + saleId + '-sale', 'pdv-troca-v2-' + saleId + '-return']
      );
      trocaTxRemoved = trocaTxDel.rows.length;

      // 3) Reverte payouts (estorno/credito) da troca
      try {
        const poRows = await client.query(
          'SELECT id, credit_transaction_id FROM troca_payouts WHERE troca_sale_id = $1',
          [saleId]
        );
        for (let k = 0; k < poRows.rows.length; k++) {
          const cid = poRows.rows[k].credit_transaction_id;
          if (cid) {
            await client.query('DELETE FROM customer_credit_transactions WHERE id = $1', [cid]);
          }
        }
        const poDel = await client.query('DELETE FROM troca_payouts WHERE troca_sale_id = $1 RETURNING id', [saleId]);
        payoutsReversed = poDel.rows.length;
      } catch (e) {
        if (e.code !== '42P01') throw e;
      }

      // 4) NF-e da devolucao: apaga as NAO autorizadas; avisa as autorizadas
      try {
        const autRows = await client.query(
          "SELECT numero, chave_acesso FROM nfce_emissions WHERE sale_id = $1 AND tipo IN ('nfe','nfe_devolucao') AND status = 'autorizada'",
          [saleId]
        );
        for (let k = 0; k < autRows.rows.length; k++) {
          fiscalWarnings.push('NF-e ' + (autRows.rows[k].numero || '?') + ' de devolucao autorizada — cancelar na SEFAZ: ' + (autRows.rows[k].chave_acesso || ''));
        }
        await client.query(
          "DELETE FROM nfce_emissions WHERE sale_id = $1 AND tipo IN ('nfe','nfe_devolucao') AND status <> 'autorizada'",
          [saleId]
        );
      } catch (e) {
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      sale_id: saleId,
      type: saleRes.rows[0].type,
      refunded_amount: refundedAmount,
      mirror_created: false,
      tx_removed: txRemoved,
      card_fee_removed: cardFeeRemoved,
      credit_reversed: creditReversed,
      items_returned: itemsRes.rows.length,
      payments_removed: paymentsRemoved,
      payments_amount: paymentsAmount,
      troca_returned_decremented: trocaReturnedDecremented,
      troca_tx_removed: trocaTxRemoved,
      payouts_reversed: payoutsReversed,
      fiscal_warnings: fiscalWarnings,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
