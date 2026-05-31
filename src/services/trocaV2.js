// ============================================================
// AURA. — services/trocaV2.js
// Handler do contrato v2 do POST /pdv/troca.
// Doc: Aura/AUDITORIA_TROCA_PDV_2026-05-17.docx
//
// 25/05/2026 (fix sem-NFC-e): removido bloco needsDevolucao55 ->
//   CUSTOMER_ADDRESS_REQUIRED. SEFAZ FAQ MG #7 — dest NF-e 55
//   devolucao varejo e o proprio emitente.
// 26/05/2026 (fix customer_phone): response inclui customer_phone
//   no sale pra Step5Success habilitar botao WhatsApp do NfceActions.
// 29/05/2026 (fase1-refactor):
//   - Idempotencia via troca_idempotency (antes do BEGIN)
//   - Lock atomico de estoque (UPDATE ... WHERE stock_qty >= qty RETURNING)
//   - SEFAZ desacoplado do COMMIT: INSERT pendente dentro da tx,
//     chamada real pos-COMMIT, falha grava last_error/retry_count
//   - Shape fiscal.per_origin[] canonico para o frontend
// 29/05/2026 (C2): advisory lock pg_advisory_xact_lock + idempotencia
//   movida para DENTRO da transacao; fecha race condition de duplo-clique.
// 29/05/2026 (C6.1): reemitirEmissao exportada para endpoint de reemissao
//   manual POST /companies/:id/troca/:trocaSaleId/reemitir-fiscal.
// 29/05/2026 (fix 42P18): placeholders separados ($1-based) para
//   sale_items e nfce_emissions em lookupOriginSales — $1 orfao
//   causava "could not determine data type of parameter $1".
// 29/05/2026 (fix splits NAO-bloqueante): a divergencia entre payment_splits
//   e o valor liquido da troca NAO bloqueia mais a operacao. computeAndValidate
//   Totals agora RECONCILIA os splits (deriva do metodo unico legado quando
//   vazios, ajusta quando nao batem) e so loga aviso. Causa do bug Davi:
//   o adapter v1 (pdv.js) mandava payment_method_legacy mas nao payment_splits,
//   e a validacao rodava ANTES da derivacao do split -> 400 "Soma dos
//   payment_splits (0.00) nao bate com diferenca a pagar".
// ============================================================

const db = require('../config/database');
const nuvemfiscal = require('./nuvemfiscal');
const trocaDevolucao55 = require('./trocaDevolucao55');

const SP_DATE_NOW = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

class TrocaV2Error extends Error {
  constructor(status, body) {
    super(body && body.error ? body.error : 'troca v2 error');
    this.status = status;
    this.body = body;
    this.isTrocaV2Error = true;
  }
}

async function assertCaixaOpenOrAllowed(client, companyId) {
  try {
    const { rows: cfgRows } = await client.query(
      `SELECT pdv_settings FROM companies WHERE id = $1`,
      [companyId]
    );
    const caixaRequired = !!(cfgRows[0]?.pdv_settings?.caixa_enabled);
    if (!caixaRequired) return { ok: true };

    const { rows: sessoes } = await client.query(
      `SELECT id FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
      [companyId]
    );
    if (sessoes.length > 0) return { ok: true, sessaoId: sessoes[0].id };
    return {
      ok: false,
      status: 409,
      body: { error: 'Abra o caixa antes de registrar a troca.', code: 'CAIXA_REQUIRED' },
    };
  } catch (e) {
    console.warn('[trocaV2] assertCaixaOpenOrAllowed fail-open:', e.message);
    return { ok: true };
  }
}

async function getActiveSessaoId(client, companyId) {
  try {
    const r = await client.query(
      `SELECT id FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
      [companyId]
    );
    return r.rows[0]?.id || null;
  } catch (_) { return null; }
}

async function fetchCustomerPhone(customerId) {
  if (!customerId) return null;
  try {
    const { rows } = await db.query(
      `SELECT phone FROM customers WHERE id = $1`,
      [customerId]
    );
    return rows[0]?.phone || null;
  } catch (_) { return null; }
}

async function lookupOriginSales(client, currentCompanyId, originalSaleIds) {
  if (!Array.isArray(originalSaleIds) || originalSaleIds.length === 0) {
    throw new TrocaV2Error(400, { error: 'original_sale_ids[] obrigatorio (array nao vazio)' });
  }

  // Placeholders para a query principal (usa $1 = currentCompanyId)
  const placeholders = originalSaleIds.map((_, i) => `$${i + 2}`).join(',');
  const { rows: salesRows } = await client.query(
    `SELECT s.id, s.status, s.company_id, s.seller_id, s.employee_id, s.created_at, s.total_amount, s.customer_id
       FROM sales s
       JOIN companies c ON c.id = $1
      WHERE s.id IN (${placeholders})
        AND (
          s.company_id = $1
          OR EXISTS (
            SELECT 1 FROM companies c2
             WHERE c2.id = s.company_id
               AND COALESCE(NULLIF(c2.billing_owner_company_id, c2.id), c2.id)
                 = COALESCE(NULLIF(c.billing_owner_company_id, c.id), c.id)
          )
        )`,
    [currentCompanyId, ...originalSaleIds]
  );

  if (salesRows.length !== originalSaleIds.length) {
    const found = new Set(salesRows.map((r) => r.id));
    const missing = originalSaleIds.filter((id) => !found.has(id));
    throw new TrocaV2Error(404, {
      error: 'Algumas vendas originais nao foram encontradas (mesma empresa ou grupo)',
      missing_sale_ids: missing,
    });
  }
  const cancelled = salesRows.filter((s) => s.status === 'cancelled');
  if (cancelled.length) {
    throw new TrocaV2Error(409, {
      error: 'Vendas canceladas nao podem ser trocadas',
      cancelled_sale_ids: cancelled.map((s) => s.id),
    });
  }

  // Placeholders $1-based para queries que NAO usam currentCompanyId
  const idPlaceholders = originalSaleIds.map((_, i) => `$${i + 1}`).join(',');

  const itemsResp = await client.query(
    `SELECT id, sale_id, product_id, variant_id, quantity, unit_price, product_name_snapshot
       FROM sale_items WHERE sale_id IN (${idPlaceholders})`,
    originalSaleIds
  );
  const itemsBySale = new Map();
  for (const it of itemsResp.rows) {
    if (!itemsBySale.has(it.sale_id)) itemsBySale.set(it.sale_id, []);
    itemsBySale.get(it.sale_id).push(it);
  }

  const nfceResp = await client.query(
    `SELECT DISTINCT ON (sale_id) sale_id, id, nuvemfiscal_id, chave_acesso, authorized_at, numero, status
       FROM nfce_emissions
      WHERE sale_id IN (${idPlaceholders}) AND tipo = 'nfce' AND status = 'autorizada'
      ORDER BY sale_id, created_at DESC`,
    originalSaleIds
  );
  const nfceBySale = new Map();
  for (const n of nfceResp.rows) nfceBySale.set(n.sale_id, n);

  const enriched = salesRows.map((s) => ({
    ...s,
    items: itemsBySale.get(s.id) || [],
    nfce: nfceBySale.get(s.id) || null,
    is_cross_filial: s.company_id !== currentCompanyId,
  }));

  return enriched;
}

async function validateReturnedItems(client, originSales, returnedItems) {
  if (!Array.isArray(returnedItems)) {
    throw new TrocaV2Error(400, { error: 'returned_items deve ser array' });
  }
  const originIdSet = new Set(originSales.map((s) => s.id));
  const itemsBySale = new Map(originSales.map((s) => [s.id, s.items]));

  const requestedByItem = new Map();

  for (const ret of returnedItems) {
    if (!ret.original_sale_id) throw new TrocaV2Error(400, { error: 'returned_item.original_sale_id obrigatorio em todas as linhas' });
    if (!originIdSet.has(ret.original_sale_id)) {
      throw new TrocaV2Error(400, { error: `returned_item aponta pra original_sale_id ${ret.original_sale_id} que nao esta em original_sale_ids[]` });
    }
    if (!ret.original_sale_item_id) throw new TrocaV2Error(400, { error: 'returned_item.original_sale_item_id obrigatorio (sale_items.id da linha original)' });
    const saleItems = itemsBySale.get(ret.original_sale_id) || [];
    const origItem = saleItems.find((i) => i.id === ret.original_sale_item_id);
    if (!origItem) throw new TrocaV2Error(400, { error: `sale_items.${ret.original_sale_item_id} nao pertence a venda ${ret.original_sale_id}` });
    const qty = parseFloat(ret.quantity);
    if (!qty || qty <= 0) throw new TrocaV2Error(400, { error: 'returned_item.quantity deve ser > 0' });
    if (qty > parseFloat(origItem.quantity)) {
      throw new TrocaV2Error(400, { error: `quantity ${qty} excede a quantidade original ${origItem.quantity} de "${origItem.product_name_snapshot}"` });
    }
    requestedByItem.set(ret.original_sale_item_id, (requestedByItem.get(ret.original_sale_item_id) || 0) + qty);
  }

  const itemIds = Array.from(requestedByItem.keys());
  if (itemIds.length === 0) return;

  const placeholders = itemIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: prev } = await client.query(
    `SELECT tri.original_sale_item_id, SUM(tri.quantity) AS already_returned
       FROM troca_returned_items tri
       JOIN sales ts ON ts.id = tri.troca_sale_id
      WHERE tri.original_sale_item_id IN (${placeholders})
        AND COALESCE(ts.status, 'completed') != 'cancelled'
      GROUP BY tri.original_sale_item_id`,
    itemIds
  );
  const alreadyByItem = new Map(prev.map((r) => [r.original_sale_item_id, parseFloat(r.already_returned) || 0]));

  for (const ret of returnedItems) {
    const qty = parseFloat(ret.quantity);
    const already = alreadyByItem.get(ret.original_sale_item_id) || 0;
    const saleItems = itemsBySale.get(ret.original_sale_id) || [];
    const origItem = saleItems.find((i) => i.id === ret.original_sale_item_id);
    const origQty = parseFloat(origItem.quantity);
    const stillAvailable = origQty - already;
    const totalNow = requestedByItem.get(ret.original_sale_item_id) || 0;
    if (totalNow > stillAvailable + 0.0001) {
      throw new TrocaV2Error(409, {
        error: `Tentando devolver ${totalNow} de "${origItem.product_name_snapshot}", mas so restam ${stillAvailable} (ja foram devolvidos ${already} em trocas anteriores).`,
        code: 'DOUBLE_RETURN_BLOCKED',
        original_sale_item_id: ret.original_sale_item_id,
        already_returned: already,
        original_qty: origQty,
        attempting: totalNow,
      });
    }
  }
}

// Ajusta uma lista de splits para somar exatamente `target`, preservando ao
// maximo os splits informados. Se somam menos, acrescenta um split de ajuste
// com fallbackMethod; se somam mais, reduz a partir do ultimo ate bater.
// Helper puro (sem efeitos colaterais) — usado por computeAndValidateTotals.
function balanceSplits(splits, target, fallbackMethod) {
  const round = (n) => parseFloat(parseFloat(n || 0).toFixed(2));
  const list = (splits || []).map((p) => ({
    method: p.method || fallbackMethod,
    amount: round(p.amount),
    notes: p.notes,
  }));
  const total = round(list.reduce((s, p) => s + p.amount, 0));
  const delta = round(target - total);
  if (Math.abs(delta) <= 0.01) return list;
  if (delta > 0) {
    // Falta valor — acrescenta split de ajuste com o metodo de fallback.
    list.push({ method: fallbackMethod, amount: delta });
    return list;
  }
  // Sobra valor — reduz do ultimo split pro primeiro ate bater no target.
  let excess = round(-delta);
  for (let i = list.length - 1; i >= 0 && excess > 0.005; i--) {
    const take = Math.min(list[i].amount, excess);
    list[i].amount = round(list[i].amount - take);
    excess = round(excess - take);
  }
  return list.filter((p) => p.amount > 0.005);
}

// Calcula os totais da troca e RECONCILIA os splits de pagamento/estorno.
// IMPORTANTE: a divergencia entre splits e valor liquido NUNCA bloqueia a
// troca. Quando os splits vem vazios (cliente v1/legado, que so manda o metodo
// unico via legacyMethod) ou nao batem, derivamos/ajustamos automaticamente.
// O split serve apenas para registrar a forma de pagamento no caixa — uma
// divergencia de UI/cliente legado nao pode impedir o lojista de concluir.
// Retorna tambem paymentSplits/refundSplits ja normalizados e somando certo.
function computeAndValidateTotals({ returned_items, new_items, payment_splits, refund_splits, legacyMethod }) {
  const returnedValue = (returned_items || []).reduce((acc, r) => acc + parseFloat(r.quantity) * parseFloat(r.unit_price), 0);
  const newValue = (new_items || []).reduce((acc, n) => acc + parseFloat(n.quantity) * parseFloat(n.unit_price), 0);
  const netAmount = parseFloat((newValue - returnedValue).toFixed(2));

  if ((returned_items || []).length === 0 && (new_items || []).length === 0) {
    throw new TrocaV2Error(400, { error: 'Informe pelo menos um returned_item ou new_item' });
  }

  const fallbackMethod = legacyMethod || 'dinheiro';
  let paymentSplits = Array.isArray(payment_splits) ? payment_splits.filter((p) => p && parseFloat(p.amount) > 0) : [];
  let refundSplits = Array.isArray(refund_splits) ? refund_splits.filter((p) => p && parseFloat(p.amount) > 0) : [];
  const sum = (arr) => parseFloat(arr.reduce((s, p) => s + parseFloat(p.amount || 0), 0).toFixed(2));

  if (netAmount > 0.005) {
    // Cliente paga a diferenca — garante que paymentSplits some exatamente netAmount.
    const target = netAmount;
    if (paymentSplits.length === 0) {
      paymentSplits = [{ method: fallbackMethod, amount: target }];
    } else if (Math.abs(sum(paymentSplits) - target) > 0.01) {
      console.warn(`[trocaV2] payment_splits (${sum(paymentSplits).toFixed(2)}) != diferenca a pagar (${target.toFixed(2)}) — auto-ajustado (nao bloqueante)`);
      paymentSplits = balanceSplits(paymentSplits, target, fallbackMethod);
    }
    refundSplits = [];
  } else if (netAmount < -0.005) {
    // Loja devolve saldo ao cliente — garante que refundSplits some |netAmount|.
    const target = parseFloat(Math.abs(netAmount).toFixed(2));
    if (refundSplits.length === 0) {
      refundSplits = [{ method: fallbackMethod, amount: target }];
    } else if (Math.abs(sum(refundSplits) - target) > 0.01) {
      console.warn(`[trocaV2] refund_splits (${sum(refundSplits).toFixed(2)}) != saldo a devolver (${target.toFixed(2)}) — auto-ajustado (nao bloqueante)`);
      refundSplits = balanceSplits(refundSplits, target, fallbackMethod);
    }
    paymentSplits = [];
  } else {
    // Troca par-a-par (netAmount ~ 0): sem pagamento nem estorno.
    paymentSplits = [];
    refundSplits = [];
  }

  return {
    returnedValue: parseFloat(returnedValue.toFixed(2)),
    newValue: parseFloat(newValue.toFixed(2)),
    netAmount,
    saleTotal: parseFloat(newValue.toFixed(2)),
    paymentSplits,
    refundSplits,
  };
}

function decideFiscalPerOrigin(originSales, returnedItems, requestedStrategy) {
  const strategyMap = new Map();
  if (requestedStrategy === 'none') {
    for (const s of originSales) strategyMap.set(s.id, 'none');
    return strategyMap;
  }
  const involvedIds = new Set((returnedItems || []).map((r) => r.original_sale_id));
  const now = Date.now();
  for (const s of originSales) {
    if (!involvedIds.has(s.id)) { strategyMap.set(s.id, 'none'); continue; }
    if (requestedStrategy === 'cancel_reissue') { strategyMap.set(s.id, 'cancel_reissue'); continue; }
    if (requestedStrategy === 'devolucao_55') { strategyMap.set(s.id, 'devolucao_55'); continue; }
    if (!s.nfce) { strategyMap.set(s.id, 'none'); continue; }
    const ageHours = s.nfce.authorized_at
      ? (now - new Date(s.nfce.authorized_at).getTime()) / 3600000
      : 9999;
    strategyMap.set(s.id, ageHours < 24 ? 'cancel_reissue' : 'devolucao_55');
  }
  return strategyMap;
}

async function preCancelNfces(originSales, strategyMap) {
  const cancelled = [];
  for (const s of originSales) {
    if (strategyMap.get(s.id) !== 'cancel_reissue') continue;
    if (!s.nfce || !s.nfce.nuvemfiscal_id) continue;

    const ageHours = s.nfce.authorized_at
      ? (Date.now() - new Date(s.nfce.authorized_at).getTime()) / 3600000
      : 9999;
    if (ageHours >= 24) {
      throw new TrocaV2Error(409, {
        error: `NFC-e da venda ${s.id} tem ${Math.round(ageHours)}h (>24h). Use nfce_strategy='devolucao_55' ou 'per_origin'.`,
        original_sale_id: s.id,
        original_chave: s.nfce.chave_acesso,
        age_hours: Math.round(ageHours * 10) / 10,
      });
    }

    try {
      await nuvemfiscal.cancelNfce(s.nfce.nuvemfiscal_id, `Troca de mercadoria — emissao de nova NFC-e (troca v2)`);
      cancelled.push({ originalSaleId: s.id, origNfce: s.nfce });
    } catch (sefazErr) {
      console.error('[trocaV2] SEFAZ cancel error:', sefazErr.message);
      throw new TrocaV2Error(502, {
        error: 'SEFAZ rejeitou cancelamento da NFC-e original: ' + sefazErr.message,
        original_sale_id: s.id, sefaz_payload: sefazErr.payload || null,
        cancelled_so_far: cancelled.map((c) => c.originalSaleId),
      });
    }
  }
  return cancelled;
}

async function undoCancellations(cancelled) {
  for (const c of cancelled) {
    try {
      if (nuvemfiscal.uncancelNfce) {
        await nuvemfiscal.uncancelNfce(c.origNfce.nuvemfiscal_id);
        console.log('[trocaV2] undo cancel OK', c.originalSaleId);
      } else {
        console.warn('[trocaV2] nuvemfiscal.uncancelNfce nao implementado:', c.originalSaleId);
      }
    } catch (e) {
      console.error('[trocaV2] undo cancel failed:', c.originalSaleId, e.message);
    }
  }
}

async function adjustStock(client, returnedItems, newItems, currentCompanyId, trocaSaleId) {
  // Devolver estoque dos itens retornados (incremento simples — produto volta ao estoque)
  for (const ret of returnedItems) {
    const qty = parseFloat(ret.quantity);
    if (!ret.product_id) continue;
    const { rows: pInfo } = await client.query('SELECT company_id FROM products WHERE id=$1', [ret.product_id]);
    const stockCompanyId = pInfo[0]?.company_id || currentCompanyId;
    if (ret.variant_id) {
      await client.query(`UPDATE product_variants SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2`, [qty, ret.variant_id]);
    } else {
      await client.query(`UPDATE products SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2 AND company_id=$3`, [qty, ret.product_id, stockCompanyId]);
    }
    await client.query(
      `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
       VALUES ($1,$2,'in',$3,$4,'troca','Troca v2 - devolucao') ON CONFLICT DO NOTHING`,
      [ret.product_id, stockCompanyId, qty, trocaSaleId]
    );
  }

  // Decrementar estoque dos novos itens — lock atomico
  for (const item of newItems) {
    if (!item.product_id) continue;
    const qty = parseFloat(item.quantity);
    let stockLabel = item.product_name_snapshot || item.product_id;
    let stockCompanyId = currentCompanyId;

    if (item.variant_id) {
      // Busca stock_company_id sem decrementar ainda
      const { rows: vr } = await client.query(
        `SELECT p.company_id AS stock_company_id, pv.sku_suffix
           FROM product_variants pv JOIN products p ON p.id = pv.product_id
          WHERE pv.id=$1 AND pv.product_id=$2`,
        [item.variant_id, item.product_id]
      );
      if (vr.length) {
        stockLabel += vr[0].sku_suffix ? ` (${vr[0].sku_suffix})` : ' (variante)';
        stockCompanyId = vr[0].stock_company_id || currentCompanyId;
      }
      // Lock atomico
      const { rows: stkRows } = await client.query(
        `UPDATE product_variants SET stock_qty = stock_qty - $1, updated_at = NOW()
         WHERE id = $2 AND stock_qty >= $1 RETURNING stock_qty`,
        [qty, item.variant_id]
      );
      if (!stkRows.length) {
        throw Object.assign(
          new Error(`INSUFFICIENT_STOCK:${item.product_id}:${item.variant_id}`),
          { code: 'INSUFFICIENT_STOCK', product_id: item.product_id, variant_id: item.variant_id }
        );
      }
    } else {
      // Busca stock_company_id
      const { rows: pr } = await client.query(
        `SELECT p.company_id AS stock_company_id
           FROM products p JOIN companies c ON c.id = $2
          WHERE p.id = $1 AND (p.company_id = $2 OR (p.company_id = c.billing_owner_company_id AND p.is_group_shared = true))`,
        [item.product_id, currentCompanyId]
      );
      if (pr.length) stockCompanyId = pr[0].stock_company_id || currentCompanyId;
      // Lock atomico
      const { rows: stkRows } = await client.query(
        `UPDATE products SET stock_qty = stock_qty - $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3 AND stock_qty >= $1 RETURNING stock_qty`,
        [qty, item.product_id, stockCompanyId]
      );
      if (!stkRows.length) {
        throw Object.assign(
          new Error(`INSUFFICIENT_STOCK:${item.product_id}`),
          { code: 'INSUFFICIENT_STOCK', product_id: item.product_id, variant_id: null }
        );
      }
    }
    await client.query(
      `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
       VALUES ($1,$2,'out',$3,$4,'troca','Troca v2 - saida novo item') ON CONFLICT DO NOTHING`,
      [item.product_id, stockCompanyId, qty, trocaSaleId]
    );
  }
}

async function insertSalePayments(client, trocaSaleId, companyId, sessaoId, totals, paymentSplits, refundSplits) {
  if (totals.returnedValue > 0) {
    const negativeMethod = (refundSplits && refundSplits[0]?.method) || (paymentSplits && paymentSplits[0]?.method) || 'dinheiro';
    const normalized = normalizeMethodForSalePayments(negativeMethod);
    await client.query(
      `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [trocaSaleId, companyId, normalized, -parseFloat(totals.returnedValue.toFixed(2)), sessaoId]
    );
  }
  for (const p of (paymentSplits || [])) {
    if (parseFloat(p.amount) <= 0) continue;
    const normalized = normalizeMethodForSalePayments(p.method);
    await client.query(
      `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [trocaSaleId, companyId, normalized, parseFloat(parseFloat(p.amount).toFixed(2)), sessaoId]
    );
  }
}

function normalizeMethodForSalePayments(method) {
  if (!method) return 'dinheiro';
  const m = String(method).toLowerCase();
  if (m === 'cartao_credito') return 'cartao';
  if (m === 'cartao_debito') return 'debito';
  if (m === 'cartao_estorno') return 'cartao';
  if (m === 'crediario_credito') return 'crediario';
  return m;
}

async function insertTrocaPayouts(client, trocaSaleId, companyId, sessaoId, customerId, refundSplits, userId) {
  if (!refundSplits || !refundSplits.length) return [];
  const inserted = [];
  for (const r of refundSplits) {
    if (parseFloat(r.amount) <= 0) continue;
    const amount = parseFloat(parseFloat(r.amount).toFixed(2));
    let creditTxId = null;
    if (r.method === 'crediario_credito') {
      if (!customerId) throw new TrocaV2Error(400, { error: 'crediario_credito exige customer_id (cliente cadastrado)' });
      const { rows: txRows } = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, sale_id, type, amount, payment_method, notes, created_by)
         VALUES ($1, $2, $3, 'payment', $4, 'crediario_credito', $5, $6)
         RETURNING id`,
        [companyId, customerId, trocaSaleId, amount, `Credito de troca (sale ${trocaSaleId.slice(0, 8)})`, userId || null]
      );
      creditTxId = txRows[0]?.id || null;
    }
    const { rows: poRows } = await client.query(
      `INSERT INTO troca_payouts
         (troca_sale_id, company_id, customer_id, method, amount, sessao_id,
          credit_transaction_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [trocaSaleId, companyId, customerId || null, r.method, amount, sessaoId, creditTxId, r.notes || null, userId || null]
    );
    inserted.push({ id: poRows[0].id, method: r.method, amount, credit_transaction_id: creditTxId });
  }
  return inserted;
}

async function insertAggregateTransactions(client, trocaSaleId, primaryCompanyId, totals, originalSaleIds, userId) {
  const summary = originalSaleIds.length === 1
    ? `Troca PDV — venda ${originalSaleIds[0].slice(0, 8)}`
    : `Troca PDV — ${originalSaleIds.length} vendas originais`;
  if (totals.returnedValue > 0) {
    await client.query(
      `INSERT INTO transactions
         (company_id, type, status, amount, description, category, due_date, paid_at, created_by, idempotency_key)
       VALUES ($1,'expense','confirmed',$2,$3,'Troca - Devolucao',${SP_DATE_NOW},NOW(),$4,$5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [primaryCompanyId, parseFloat(totals.returnedValue.toFixed(2)), summary, userId || null, 'pdv-troca-v2-' + trocaSaleId + '-return']
    );
  }
  if (totals.newValue > 0) {
    await client.query(
      `INSERT INTO transactions
         (company_id, type, status, amount, description, category, due_date, paid_at, created_by, idempotency_key)
       VALUES ($1,'income','confirmed',$2,$3,'Troca - Venda',${SP_DATE_NOW},NOW(),$4,$5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [primaryCompanyId, parseFloat(totals.newValue.toFixed(2)), summary, userId || null, 'pdv-troca-v2-' + trocaSaleId + '-sale']
    );
  }
}

/**
 * Reemite uma entrada de nfce_emissions que esta em falha/pendente.
 * Suporta apenas strategy='devolucao_55' (cancel_reissue nao gera row pendente).
 * Reutilizado pelo endpoint POST /companies/:id/troca/:trocaSaleId/reemitir-fiscal
 * e pode ser chamado por workers de retry futuros.
 *
 * O origin_sale_id e extraido do campo notes com o padrao "devolucao_55 origem={uuid}".
 * Parametros adicionais (returnedItems, returnedValue, customerAddress) sao
 * relidos do banco a partir da troca_sale_id + origin_sale_id.
 *
 * @param {object} emission - linha de nfce_emissions: { id, company_id, sale_id, tipo, notes }
 * @returns {{ status: 'autorizada'|'falha'|'none', chave_acesso: string|null, origin_sale_id: string|null, error: string|null }}
 */
async function reemitirEmissao(emission) {
  // Extrair origin_sale_id do campo notes: "devolucao_55 origem={uuid}"
  const match = String(emission.notes || '').match(/origem=([a-f0-9-]{36})/i);
  const originSaleId = match ? match[1] : null;

  if (emission.tipo !== 'nfe_devolucao' || !originSaleId) {
    return { status: 'none', chave_acesso: null, origin_sale_id: originSaleId, error: null };
  }

  const trocaSaleId = emission.sale_id;
  const saleCompanyId = emission.company_id;

  // Reler itens devolvidos desta origem a partir do banco
  let returnedItems = [];
  let returnedValue = 0;
  try {
    const { rows: retRows } = await db.query(
      `SELECT product_id, variant_id, quantity, unit_price, product_name_snapshot
         FROM troca_returned_items
        WHERE troca_sale_id = $1 AND original_sale_id = $2`,
      [trocaSaleId, originSaleId]
    );
    returnedItems = retRows;
    returnedValue = retRows.reduce((acc, r) => acc + parseFloat(r.quantity) * parseFloat(r.unit_price), 0);
  } catch (e) {
    console.warn('[trocaV2.reemitirEmissao] erro ao reler returned_items (non-fatal):', e.message);
  }

  try {
    const result = await trocaDevolucao55.handle(null, {
      saleCompanyId,
      originalSaleId: originSaleId,
      trocaSaleId,
      returnedItems,
      returnedValue,
      customerAddress: null,
      notes: null,
      userId: null,
    });
    await db.query(
      `UPDATE nfce_emissions SET status='autorizada', chave_acesso=$1, last_error=NULL, updated_at=NOW() WHERE id=$2`,
      [result.chave_acesso || null, emission.id]
    );
    return { status: 'autorizada', chave_acesso: result.chave_acesso || null, origin_sale_id: originSaleId, error: null };
  } catch (err) {
    await db.query(
      `UPDATE nfce_emissions SET status='falha', last_error=$1, retry_count=retry_count+1, next_retry_at=NOW()+INTERVAL '5 minutes', updated_at=NOW() WHERE id=$2`,
      [err.message, emission.id]
    );
    return { status: 'falha', chave_acesso: null, origin_sale_id: originSaleId, error: err.message };
  }
}

async function handle(req, res) {
  const {
    original_sale_ids, returned_items = [], new_items = [],
    payment_splits = [], refund_splits = [],
    customer_id, employee_id, seller_name,
    nfce_strategy = 'per_origin',
    customer_address,
    idempotency_key,
  } = req.body || {};

  const companyId = req.params.id;

  const client = await db.connect();
  let preCancelled = [];
  try {
    await client.query('BEGIN');

    // ── A) Idempotencia + advisory lock DENTRO da transacao (C2: fecha race condition) ──
    if (idempotency_key) {
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotency_key]);
        await client.query(
          'INSERT INTO troca_idempotency (idempotency_key, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [idempotency_key, companyId]
        );
        const { rows: idempRows } = await client.query(
          'SELECT troca_sale_id FROM troca_idempotency WHERE idempotency_key=$1 AND company_id=$2 AND troca_sale_id IS NOT NULL',
          [idempotency_key, companyId]
        );
        if (idempRows.length > 0) {
          await client.query('ROLLBACK');
          const { rows: [s] } = await db.query('SELECT * FROM sales WHERE id=$1', [idempRows[0].troca_sale_id]);
          return res.json({ success: true, troca: s, idempotent_hit: true, fiscal: { per_origin: [] } });
        }
      } catch (idempErr) {
        // Tabela pode nao existir ainda (migration pendente) — fail-open
        console.warn('[trocaV2] idempotency check fail-open:', idempErr.message);
      }
    }

    const caixaCheck = await assertCaixaOpenOrAllowed(client, companyId);
    if (!caixaCheck.ok) { await client.query('ROLLBACK'); return res.status(caixaCheck.status).json(caixaCheck.body); }
    const sessaoId = caixaCheck.sessaoId || (await getActiveSessaoId(client, companyId));

    const originSales = await lookupOriginSales(client, companyId, original_sale_ids);
    await validateReturnedItems(client, originSales, returned_items);
    // Reconciliacao de splits NAO bloqueante: deriva do metodo unico legado
    // (payment_method_legacy / payment_method) quando os splits vem vazios e
    // auto-ajusta quando nao batem. Resolve o bug Davi (adapter v1 mandava
    // payment_method_legacy mas nenhum split -> 400 antes da derivacao).
    const legacyMethod = (req.body && (req.body.payment_method_legacy || req.body.payment_method)) || 'dinheiro';
    const totals = computeAndValidateTotals({ returned_items, new_items, payment_splits, refund_splits, legacyMethod });
    const _paymentSplits = totals.paymentSplits;
    const _refundSplits = totals.refundSplits;
    const strategyMap = decideFiscalPerOrigin(originSales, returned_items, nfce_strategy);

    preCancelled = await preCancelNfces(originSales, strategyMap);

    const primarySale = originSales[0];
    const saleCompanyId = primarySale.company_id;
    const isCrossFilial = originSales.some((s) => s.is_cross_filial);

    const { rows: colCheck } = await client.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_name = 'sales' AND column_name IN ('exchange_seller_id','exchange_employee_id')`
    );
    const hasExchangeCols = parseInt(colCheck[0]?.n || '0', 10) === 2;
    const trocaSellerId   = isCrossFilial ? primarySale.seller_id : (req.user?.id || null);
    const trocaEmployeeId = isCrossFilial ? primarySale.employee_id : (employee_id || null);
    const exchangeSellerId   = isCrossFilial ? (req.user?.id || null) : null;
    const exchangeEmployeeId = isCrossFilial ? (employee_id || null) : null;

    if (isCrossFilial && !hasExchangeCols) {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'Troca cross-filial v2 indisponivel: migration 111 nao aplicada', code: 'MIGRATION_111_PENDING' });
    }

    const effectiveCustomerId = customer_id || primarySale?.customer_id || null;
    const trocaPaymentMethod = (_paymentSplits[0]?.method || _refundSplits[0]?.method || 'dinheiro');

    let trocaSaleRow;
    if (hasExchangeCols) {
      const r = await client.query(
        `INSERT INTO sales
           (company_id, customer_id, seller_id, employee_id, seller_name,
            exchange_seller_id, exchange_employee_id,
            total_amount, discount_amount, payment_method, notes,
            status, type, exchange_of_sale_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,'completed','troca',$11) RETURNING *`,
        [
          saleCompanyId, effectiveCustomerId,
          trocaSellerId, trocaEmployeeId, seller_name || null,
          exchangeSellerId, exchangeEmployeeId,
          totals.saleTotal,
          trocaPaymentMethod,
          `Troca v2 — ${original_sale_ids.length} venda(s) original(is)`,
          original_sale_ids[0],
        ]
      );
      trocaSaleRow = r.rows[0];
    } else {
      const r = await client.query(
        `INSERT INTO sales
           (company_id, customer_id, seller_id, employee_id, seller_name,
            total_amount, discount_amount, payment_method, notes,
            status, type, exchange_of_sale_id)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'completed','troca',$9) RETURNING *`,
        [
          saleCompanyId, effectiveCustomerId,
          trocaSellerId, trocaEmployeeId, seller_name || null,
          totals.saleTotal,
          trocaPaymentMethod,
          `Troca v2 — ${original_sale_ids.length} venda(s) original(is)`,
          original_sale_ids[0],
        ]
      );
      trocaSaleRow = r.rows[0];
    }

    for (const item of new_items) {
      const qty = parseFloat(item.quantity);
      const unitPrice = parseFloat(item.unit_price);
      const lineTotal = parseFloat((qty * unitPrice).toFixed(2));
      let costPrice = 0;
      let productName = item.product_name_snapshot || '';
      if (item.product_id) {
        const { rows: pr } = await client.query(
          `SELECT p.name, p.cost_price
             FROM products p JOIN companies c ON c.id = $2
            WHERE p.id = $1 AND (p.company_id = $2 OR (p.company_id = c.billing_owner_company_id AND p.is_group_shared = true))`,
          [item.product_id, companyId]
        );
        if (pr.length) { productName = productName || pr[0].name; costPrice = parseFloat(pr[0].cost_price || 0); }
      }
      await client.query(
        `INSERT INTO sale_items
           (sale_id, product_id, variant_id, quantity, unit_price, unit_cost, discount, total_price, product_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)`,
        [trocaSaleRow.id, item.product_id || null, item.variant_id || null, qty, unitPrice, costPrice, lineTotal, productName]
      );
    }

    for (const ret of returned_items) {
      await client.query(
        `INSERT INTO troca_returned_items
           (troca_sale_id, original_sale_id, original_sale_item_id,
            product_id, variant_id, quantity, unit_price, product_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [trocaSaleRow.id, ret.original_sale_id, ret.original_sale_item_id, ret.product_id || null, ret.variant_id || null, parseFloat(ret.quantity), parseFloat(ret.unit_price), ret.product_name_snapshot || null]
      );
    }

    // ── B) Lock de estoque atomico (dentro da transacao) ──
    await adjustStock(client, returned_items, new_items, companyId, trocaSaleRow.id);

    await insertSalePayments(client, trocaSaleRow.id, companyId, sessaoId, totals, _paymentSplits, _refundSplits);
    const payoutsInserted = await insertTrocaPayouts(client, trocaSaleRow.id, companyId, sessaoId, effectiveCustomerId, _refundSplits, req.user?.id);
    await insertAggregateTransactions(client, trocaSaleRow.id, saleCompanyId, totals, original_sale_ids, req.user?.id);

    for (const c of preCancelled) {
      await client.query(
        `UPDATE nfce_emissions SET status = 'cancelada', cancelled_at = NOW(), cancel_reason = $1 WHERE id = $2`,
        ['Troca v2 — cancel_reissue sale_troca=' + trocaSaleRow.id, c.origNfce.id]
      );
    }

    // ── C) Desacoplar SEFAZ do COMMIT:
    //    Para cada origem com devolucao_55, INSERT nfce_emissions pendente DENTRO da tx,
    //    chamada real SEFAZ vai ocorrer pos-COMMIT.
    const pendingEmissions = [];

    for (const s of originSales) {
      const strat = strategyMap.get(s.id);
      if (strat !== 'devolucao_55') continue;
      const itemsForThis = returned_items.filter((r) => r.original_sale_id === s.id);
      const valueForThis = itemsForThis.reduce((acc, r) => acc + parseFloat(r.quantity) * parseFloat(r.unit_price), 0);

      // INSERT pendente — referencia suficiente para o worker de retry tambem
      let emissionId = null;
      try {
        const { rows: emRows } = await client.query(
          `INSERT INTO nfce_emissions
             (company_id, sale_id, tipo, status, notes)
           VALUES ($1, $2, 'nfe_devolucao', 'pendente', $3)
           RETURNING id`,
          [s.company_id, trocaSaleRow.id, `devolucao_55 origem=${s.id}`]
        );
        emissionId = emRows[0]?.id || null;
      } catch (insErr) {
        console.warn('[trocaV2] insert pendente emission failed (non-fatal):', insErr.message);
      }

      pendingEmissions.push({
        emission_id: emissionId,
        origin_sale_id: s.id,
        strategy: 'devolucao_55',
        saleCompanyId: s.company_id,
        trocaSaleId: trocaSaleRow.id,
        returnedItems: itemsForThis,
        returnedValue: valueForThis,
      });
    }

    // cancel_reissue ja tratado acima (cancelamento pre-commit) — registrar no resultado
    for (const c of preCancelled) {
      pendingEmissions.push({
        emission_id: null,
        origin_sale_id: c.originalSaleId,
        strategy: 'cancel_reissue',
        original_chave_cancelada: c.origNfce.chave_acesso,
        saleCompanyId: null,
      });
    }

    // ── Gravar troca_sale_id na idempotencia antes do COMMIT ──
    if (idempotency_key) {
      try {
        await client.query(
          'UPDATE troca_idempotency SET troca_sale_id=$1 WHERE idempotency_key=$2',
          [trocaSaleRow.id, idempotency_key]
        );
      } catch (idempUpdErr) {
        console.warn('[trocaV2] idempotency update fail-soft:', idempUpdErr.message);
      }
    }

    await client.query('COMMIT');

    // ── C cont.) Chamar SEFAZ pos-COMMIT para devolucao_55 ──
    const fiscalResults = [];

    for (const emission of pendingEmissions) {
      if (emission.strategy === 'cancel_reissue') {
        fiscalResults.push({
          origin_sale_id: emission.origin_sale_id,
          strategy: 'cancel_reissue',
          status: 'autorizada',
          chave_acesso: emission.original_chave_cancelada || null,
          error: null,
        });
        continue;
      }

      if (emission.strategy === 'devolucao_55') {
        try {
          const result = await trocaDevolucao55.handle(null, {
            saleCompanyId: emission.saleCompanyId,
            originalSaleId: emission.origin_sale_id,
            trocaSaleId: emission.trocaSaleId,
            returnedItems: emission.returnedItems,
            returnedValue: emission.returnedValue,
            customerAddress: customer_address,
            notes: req.body.notes,
            userId: req.user?.id,
          });
          if (emission.emission_id) {
            await db.query(
              `UPDATE nfce_emissions SET status='autorizada', chave_acesso=$1, updated_at=NOW() WHERE id=$2`,
              [result.chave_acesso || null, emission.emission_id]
            );
          }
          fiscalResults.push({
            origin_sale_id: emission.origin_sale_id,
            strategy: 'devolucao_55',
            status: 'autorizada',
            chave_acesso: result.chave_acesso || null,
            error: null,
          });
        } catch (err) {
          if (emission.emission_id) {
            await db.query(
              `UPDATE nfce_emissions SET status='falha', last_error=$1, retry_count=retry_count+1, next_retry_at=NOW()+INTERVAL '5 minutes' WHERE id=$2`,
              [err.message, emission.emission_id]
            );
          }
          fiscalResults.push({
            origin_sale_id: emission.origin_sale_id,
            strategy: 'devolucao_55',
            status: 'falha',
            chave_acesso: null,
            error: err.message,
          });
        }
        continue;
      }
    }

    // Origens sem emissao fiscal
    for (const s of originSales) {
      const strat = strategyMap.get(s.id);
      if (strat === 'none') {
        fiscalResults.push({
          origin_sale_id: s.id,
          strategy: 'none',
          status: 'none',
          chave_acesso: null,
          error: null,
        });
      }
    }

    const { rows: respNewItems } = await db.query(
      `SELECT si.*, COALESCE(p.name, si.product_name_snapshot) AS product_name
         FROM sale_items si LEFT JOIN products p ON p.id=si.product_id
        WHERE si.sale_id=$1`, [trocaSaleRow.id]
    );
    const { rows: respRetItems } = await db.query(
      `SELECT tri.*, COALESCE(p.name, tri.product_name_snapshot) AS product_name
         FROM troca_returned_items tri LEFT JOIN products p ON p.id=tri.product_id
        WHERE tri.troca_sale_id=$1`, [trocaSaleRow.id]
    );

    const respCustomerPhone = await fetchCustomerPhone(trocaSaleRow.customer_id);

    // ── E) Shape de retorno canonico ──
    return res.status(201).json({
      version: 'v2',
      sale: { ...trocaSaleRow, items: respNewItems, customer_phone: respCustomerPhone },
      returned_items: respRetItems, new_items: respNewItems,
      net_amount: totals.netAmount,
      returned_value: totals.returnedValue,
      new_value: totals.newValue,
      cross_filial: isCrossFilial,
      origin_company_id: saleCompanyId,
      origin_company_ids: Array.from(new Set(originSales.map((s) => s.company_id))),
      physical_company_id: companyId,
      payouts: payoutsInserted,
      fiscal: {
        strategy: nfce_strategy,
        per_origin: fiscalResults,
        // Cada item: { origin_sale_id, strategy, status ('autorizada'|'pendente'|'falha'|'none'), chave_acesso, error }
      },
      original_sale_ids,
      receipt_url: `/companies/${companyId}/print/receipt/${trocaSaleRow.id}`,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (preCancelled.length) await undoCancellations(preCancelled);
    if (err.isTrocaV2Error) return res.status(err.status).json(err.body);
    // ── B) Estoque insuficiente — codigo padrao para pdv.js capturar ──
    if (err.code === 'INSUFFICIENT_STOCK' || (err.message && err.message.startsWith('INSUFFICIENT_STOCK'))) {
      return res.status(409).json({
        error: 'Estoque insuficiente para concluir a troca.',
        code: 'INSUFFICIENT_STOCK',
        product_id: err.product_id || null,
        variant_id: err.variant_id || null,
      });
    }
    console.error('[trocaV2] internal error:', err);
    return res.status(500).json({ error: 'Erro interno na troca v2' });
  } finally {
    client.release();
  }
}

module.exports = {
  handle,
  reemitirEmissao,
  TrocaV2Error,
  _internal: { computeAndValidateTotals, balanceSplits, decideFiscalPerOrigin, normalizeMethodForSalePayments },
};
