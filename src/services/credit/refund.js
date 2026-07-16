// =============================================================
// AURA. -- Credito: motor de DEVOLUCAO de venda no crediario (B4).
//
// Modelo do contrato Onda A/B v2 (§3 B4), MVP 11/06/2026:
//   - Valor da devolucao = preco EFETIVO pago (total_price/quantity, ja
//     liquido de item_discount) x quantidade devolvida.
//   - Abate as ULTIMAS parcelas ABERTAS da venda (cancela as ultimas,
//     reduz amount_due de uma parcial). Nao toca parcelas pagas.
//   - Insere customer_credit_transactions type='refund' (migration 177):
//     a view customer_credit_balances trata refund como -amount, entao a
//     divida cai; excedente => saldo negativo = credito a favor.
//   - Reaproveita a infra de TROCA: cria uma linha sales type='devolucao'
//     (ancora), grava troca_returned_items (guarda anti-dupla-devolucao) e
//     repoe estoque (stock_movements 'in'), mesmo padrao do trocaV2.adjustStock.
//   - Reduz best-effort o "A Receber" pendente da venda (Financeiro).
//   - Ignora bloqueio manual (devolver e direito do cliente).
//
// FORA do MVP (seguem como follow-up):
//   - NF-e de devolucao (CFOP 1.202): crediario raramente emite nota.
//   - Pro-rata de cupom de venda (desconto no nivel da venda).
//   - Idempotency-Key.
//
// Chamar DENTRO de uma transacao (client ja em BEGIN), como applyPayment.
// =============================================================

const creditLedger = require('../creditLedger');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function err(status, body) {
  const e = new Error(body && body.error ? body.error : 'refund error');
  e.status = status;
  e.body = body;
  e.isRefundError = true;
  return e;
}

/**
 * refundCreditSale -- processa a devolucao de itens de uma venda no crediario.
 *
 * @param {pg.PoolClient} client  (ja em BEGIN)
 * @param {{ companyId, saleId, items:[{sale_item_id, quantity}], reason?, createdBy? }} opts
 * @returns {{ devolucao_sale_id, refund_value, abated_installments[],
 *             credit_generated, new_balance, stock_restored[] }}
 */
async function refundCreditSale(client, { companyId, saleId, items, reason = null, createdBy = null }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw err(400, { error: 'items[] obrigatorio (array nao vazio)' });
  }

  // 1. Venda (group-aware: mesma empresa ou mesmo billing owner)
  const { rows: saleRows } = await client.query(
    `SELECT s.id, s.company_id, s.customer_id, s.status
       FROM sales s
       JOIN companies c ON c.id = $2
      WHERE s.id = $1
        AND (
          s.company_id = $2
          OR EXISTS (
            SELECT 1 FROM companies c2
             WHERE c2.id = s.company_id
               AND COALESCE(NULLIF(c2.billing_owner_company_id, c2.id), c2.id)
                 = COALESCE(NULLIF(c.billing_owner_company_id, c.id), c.id)
          )
        )`,
    [saleId, companyId]
  );
  if (!saleRows.length) throw err(404, { error: 'Venda nao encontrada nesta empresa ou grupo' });
  const sale = saleRows[0];
  if (sale.status === 'cancelled') throw err(409, { error: 'Venda cancelada nao pode ser devolvida' });

  const saleCompanyId = sale.company_id;
  const customerId = sale.customer_id;

  // 2. A venda e do crediario? (precisa do debit no ledger) + resolve account_id
  let accountId = null;
  try {
    const { rows: debitRows } = await client.query(
      `SELECT account_id FROM customer_credit_transactions
        WHERE sale_id = $1 AND company_id = $2 AND type = 'debit' LIMIT 1`,
      [saleId, saleCompanyId]
    );
    if (!debitRows.length) throw err(422, { error: 'Venda nao e do crediario (sem lancamento de credito)', code: 'NOT_A_CREDIT_SALE' });
    accountId = debitRows[0].account_id || null;
  } catch (e) {
    if (e.isRefundError) throw e;
    if (e.code === '42703') {
      const { rows: debitRows } = await client.query(
        `SELECT id FROM customer_credit_transactions
          WHERE sale_id = $1 AND company_id = $2 AND type = 'debit' LIMIT 1`,
        [saleId, saleCompanyId]
      );
      if (!debitRows.length) throw err(422, { error: 'Venda nao e do crediario (sem lancamento de credito)', code: 'NOT_A_CREDIT_SALE' });
      accountId = null;
    } else throw e;
  }

  // 3. Itens da venda
  const { rows: saleItems } = await client.query(
    `SELECT id, product_id, variant_id, quantity, unit_price, total_price, product_name_snapshot
       FROM sale_items WHERE sale_id = $1`,
    [saleId]
  );
  const byId = new Map(saleItems.map((i) => [i.id, i]));

  // 3.1. Quanto ja foi devolvido/trocado por item (guarda anti-dupla-devolucao)
  const reqIds = items.map((i) => i.sale_item_id);
  const ph = reqIds.map((_, i) => `$${i + 1}`).join(',');
  let alreadyByItem = new Map();
  if (reqIds.length) {
    try {
      const { rows: prev } = await client.query(
        `SELECT tri.original_sale_item_id, COALESCE(SUM(tri.quantity), 0) AS already
           FROM troca_returned_items tri
           JOIN sales ts ON ts.id = tri.troca_sale_id
          WHERE tri.original_sale_item_id IN (${ph})
            AND COALESCE(ts.status, 'completed') != 'cancelled'
          GROUP BY tri.original_sale_item_id`,
        reqIds
      );
      alreadyByItem = new Map(prev.map((r) => [r.original_sale_item_id, parseFloat(r.already) || 0]));
    } catch (e) {
      if (e.code !== '42P01') throw e; // tabela ausente em deploy parcial -> sem historico
    }
  }

  // 4. Valida itens + calcula valor efetivo
  let refundValue = 0;
  const normalized = [];
  for (const it of items) {
    const orig = byId.get(it.sale_item_id);
    if (!orig) throw err(400, { error: `sale_item_id ${it.sale_item_id} nao pertence a venda ${saleId}` });
    const qty = parseFloat(it.quantity);
    if (!qty || qty <= 0) throw err(400, { error: 'quantity deve ser > 0 em todos os itens' });
    const origQty = parseFloat(orig.quantity) || 0;
    const already = alreadyByItem.get(it.sale_item_id) || 0;
    const available = round2(origQty - already);
    if (qty > available + 0.0001) {
      throw err(409, {
        error: `Devolvendo ${qty} de "${orig.product_name_snapshot}", mas so restam ${available} (ja devolvidos ${already}).`,
        code: 'DOUBLE_RETURN_BLOCKED',
        sale_item_id: it.sale_item_id,
      });
    }
    // Preco efetivo unitario = total_price / quantity (ja liquido de item_discount).
    const effectiveUnit = origQty > 0 ? round2(parseFloat(orig.total_price) / origQty) : parseFloat(orig.unit_price) || 0;
    const lineValue = round2(effectiveUnit * qty);
    refundValue = round2(refundValue + lineValue);
    normalized.push({
      sale_item_id: it.sale_item_id,
      product_id: orig.product_id,
      variant_id: orig.variant_id,
      quantity: qty,
      effective_unit: effectiveUnit,
      line_value: lineValue,
      product_name_snapshot: orig.product_name_snapshot,
    });
  }
  if (refundValue <= 0) throw err(400, { error: 'Valor de devolucao resultou em zero' });

  // 5. Ancora: linha sales type='devolucao' (reaproveita infra da troca).
  //    sales.type nao tem CHECK; total negativo representa a saida de valor.
  const { rows: devRows } = await client.query(
    `INSERT INTO sales
       (company_id, customer_id, total_amount, discount_amount, payment_method, notes, status, type, exchange_of_sale_id)
     VALUES ($1, $2, $3, 0, 'crediario', $4, 'completed', 'devolucao', $5)
     RETURNING id`,
    [saleCompanyId, customerId, -refundValue, reason || 'Devolucao de venda no crediario', saleId]
  );
  const devolucaoSaleId = devRows[0].id;

  // 6. troca_returned_items (guarda anti-dupla-devolucao) + reposicao de estoque
  //    (mesmo padrao do trocaV2.adjustStock, perna devolvida).
  const stockRestored = [];
  for (const n of normalized) {
    await client.query(
      `INSERT INTO troca_returned_items
         (troca_sale_id, original_sale_id, original_sale_item_id,
          product_id, variant_id, quantity, unit_price, product_name_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [devolucaoSaleId, saleId, n.sale_item_id, n.product_id || null, n.variant_id || null,
       n.quantity, n.effective_unit, n.product_name_snapshot || null]
    );

    if (n.product_id) {
      let stockCompanyId = saleCompanyId;
      try {
        const { rows: pInfo } = await client.query('SELECT company_id FROM products WHERE id=$1', [n.product_id]);
        stockCompanyId = pInfo[0]?.company_id || saleCompanyId;
      } catch (_) {}
      if (n.variant_id) {
        await client.query(`UPDATE product_variants SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2`, [n.quantity, n.variant_id]);
      } else {
        await client.query(`UPDATE products SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2 AND company_id=$3`, [n.quantity, n.product_id, stockCompanyId]);
      }
      try {
        await client.query(
          `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
           VALUES ($1,$2,'in',$3,$4,'devolucao','Devolucao crediario') ON CONFLICT DO NOTHING`,
          [n.product_id, stockCompanyId, n.quantity, devolucaoSaleId]
        );
      } catch (e) { if (e.code !== '42P01' && e.code !== '42703') throw e; }
      stockRestored.push({ product_id: n.product_id, variant_id: n.variant_id || null, quantity: n.quantity });
    }
  }

  // 7. Ledger: transacao 'refund' vinculada a VENDA original. A view de saldo
  //    subtrai (type != 'debit' => -amount), reduzindo a divida; excedente vira
  //    saldo negativo = credito a favor. payment_method='crediario_credito'
  //    para o historico (B1) exibir como credito.
  try {
    await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, sale_id, type, amount, payment_method, notes, source, created_by, account_id)
       VALUES ($1, $2, $3, 'refund', $4, 'crediario_credito', $5, 'refund', $6, $7)`,
      [saleCompanyId, customerId, saleId, refundValue,
       `Devolucao de venda (dev ${String(devolucaoSaleId).slice(0, 8)})`, createdBy, accountId]
    );
  } catch (e) {
    if (e.code === '42703') {
      await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, sale_id, type, amount, payment_method, notes, created_by)
         VALUES ($1, $2, $3, 'refund', $4, 'crediario_credito', $5, $6)`,
        [saleCompanyId, customerId, saleId, refundValue,
         `Devolucao de venda (dev ${String(devolucaoSaleId).slice(0, 8)})`, createdBy]
      );
    } else throw e;
  }

  // 8. Abate as ULTIMAS parcelas ABERTAS da venda (numero DESC).
  //    Cancela as ultimas; reduz amount_due de uma parcial. Nao toca pagas
  //    nem o que ja foi coberto (covered_amount).
  let rem = refundValue;
  const abated = [];
  let installments = [];
  try {
    const { rows } = await client.query(
      `SELECT id, installment_number, amount_due, covered_amount, status
         FROM credit_installments
        WHERE sale_id = $1 AND company_id = $2 AND status IN ('pending','overdue')
        ORDER BY installment_number DESC
        FOR UPDATE`,
      [saleId, saleCompanyId]
    );
    installments = rows;
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }

  for (const inst of installments) {
    if (rem <= 0.005) break;
    const due = parseFloat(inst.amount_due) || 0;
    const cov = parseFloat(inst.covered_amount) || 0;
    const uncovered = round2(due - cov);
    if (uncovered <= 0.005) continue;

    if (rem >= uncovered - 0.005) {
      // M2 (auditoria 12/06): covered_amount = 0 ao cancelar, alinhado com
      // cancelCreditSale -- parcela cancelada nao deve reter cobertura.
      await client.query(
        `UPDATE credit_installments SET status='cancelled', covered_amount=0, updated_at=NOW() WHERE id=$1 AND company_id=$2`,
        [inst.id, saleCompanyId]
      );
      rem = round2(rem - uncovered);
      abated.push({ installment_id: inst.id, number: inst.installment_number, action: 'cancelled', amount: uncovered });
    } else {
      const newDue = round2(due - rem);
      await client.query(
        `UPDATE credit_installments SET amount_due=$3, updated_at=NOW() WHERE id=$1 AND company_id=$2`,
        [inst.id, saleCompanyId, newDue]
      );
      abated.push({ installment_id: inst.id, number: inst.installment_number, action: 'reduced', amount: rem, new_amount_due: newDue });
      rem = 0;
    }
  }
  const creditGenerated = round2(Math.max(0, rem));

  // 9. Reduz best-effort o "A Receber" pendente da venda (Financeiro nao
  //    superestimar). Nao-fatal: falha aqui nao desfaz a devolucao.
  //    M3 (auditoria 12/06): alem da key exata, consome tambem os receivables
  //    PARCIAIS ('pdv-credit-receivable-<saleId>-rest-...', criados pelo
  //    applyPayment em pagamento parcial) -- mesma tecnica do cancelCreditSale.
  //    Ordem: principal primeiro, depois os '-rest-' (created_at ASC), sem
  //    nunca deixar valor negativo; consumo total => DELETE (pending).
  try {
    let toReduce = refundValue;
    const mainKey = 'pdv-credit-receivable-' + saleId;
    const { rows: recvRows } = await client.query(
      `SELECT id, amount, idempotency_key FROM transactions
        WHERE company_id = $1
          AND (idempotency_key = $2 OR idempotency_key LIKE $3)
          AND status = 'pending'
        ORDER BY (idempotency_key = $2) DESC, created_at ASC
        FOR UPDATE`,
      [saleCompanyId, mainKey, mainKey + '-%']
    );
    for (const recv of recvRows) {
      if (toReduce <= 0.005) break;
      const recvAmount = parseFloat(recv.amount) || 0;
      if (recvAmount <= 0.005) continue;
      const cut = round2(Math.min(recvAmount, toReduce));
      if (cut >= recvAmount - 0.005) {
        await client.query(
          `DELETE FROM transactions WHERE id = $1 AND company_id = $2 AND status = 'pending'`,
          [recv.id, saleCompanyId]
        );
      } else {
        await client.query(
          `UPDATE transactions
              SET amount = GREATEST(0, amount - $1), updated_at = NOW()
            WHERE id = $2 AND company_id = $3`,
          [cut, recv.id, saleCompanyId]
        );
      }
      toReduce = round2(toReduce - cut);
    }
  } catch (e) {
    console.warn('[credit/refund] reduce A Receber (non-fatal):', e.message);
  }

  // 10. Recalcula credit_used + saldo novo
  try { await creditLedger._updateCreditUsed(client, saleCompanyId, customerId); } catch (_) {}

  let newBalance = 0;
  try {
    const { rows: balRows } = await client.query(
      `SELECT balance FROM customer_credit_balances WHERE customer_id=$1 AND company_id=$2`,
      [customerId, saleCompanyId]
    );
    newBalance = parseFloat(balRows[0]?.balance || 0);
  } catch (_) {}

  return {
    devolucao_sale_id: devolucaoSaleId,
    refund_value: refundValue,
    abated_installments: abated,
    credit_generated: creditGenerated,
    new_balance: newBalance,
    stock_restored: stockRestored,
  };
}

module.exports = { refundCreditSale };
