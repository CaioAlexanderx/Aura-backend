// ============================================================
// AURA. — services/trocaV2.js
// Handler do contrato v2 do POST /pdv/troca:
//   - original_sale_ids[] (multi-venda)
//   - returned_items[] com original_sale_id + original_sale_item_id (dupla-devolucao check)
//   - payment_splits[] / refund_splits[] (multi-metodo)
//   - nfce_strategy: cancel_reissue | devolucao_55 | per_origin | none
//
// Doc: Aura/AUDITORIA_TROCA_PDV_2026-05-17.docx (Fases 1+2+4)
// 17/05/2026 (PR Aura-backend dev/troca-v2-backend-2026-05-17)
//
// Decisões importantes:
//   1. Fiscal ANTES do commit SQL — cancelamento SEFAZ pode falhar e
//      precisamos reverter. Cancelamentos ja confirmados pela SEFAZ
//      antes do erro ficam em cancelledForUndo[] e a gente tenta
//      destornar via API (best-effort).
//   2. per_origin: para cada original_sale_id, decide individualmente
//      cancel_reissue (NFC-e <24h) vs devolucao_55 (>=24h ou sem NFC-e).
//   3. Compat estrita com v1: este handler so e chamado quando body
//      tem original_sale_ids (array). Caso contrario, pdv.js mantem
//      o caminho v1 antigo.
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

// ─── Caixa check (copia de pdv.js — refactor futuro pra util) ──
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
      body: {
        error: 'Abra o caixa antes de registrar a troca.',
        code: 'CAIXA_REQUIRED',
      },
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

// ─── Lookup origin sales (group-aware) ────────────────────────
// Retorna metadata + items + NFC-e info (chave, idade, nuvemfiscal_id)
// pra cada original_sale_id.
async function lookupOriginSales(client, currentCompanyId, originalSaleIds) {
  if (!Array.isArray(originalSaleIds) || originalSaleIds.length === 0) {
    throw new TrocaV2Error(400, { error: 'original_sale_ids[] obrigatorio (array nao vazio)' });
  }

  const placeholders = originalSaleIds.map((_, i) => `$${i + 2}`).join(',');
  const { rows: salesRows } = await client.query(
    `SELECT s.id, s.status, s.company_id, s.seller_id, s.employee_id, s.created_at, s.total_amount
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

  // sale_items por venda — usados em validateItems
  const itemsResp = await client.query(
    `SELECT id, sale_id, product_id, variant_id, quantity, unit_price, product_name_snapshot
       FROM sale_items WHERE sale_id IN (${placeholders})`,
    [currentCompanyId, ...originalSaleIds]
  );
  const itemsBySale = new Map();
  for (const it of itemsResp.rows) {
    if (!itemsBySale.has(it.sale_id)) itemsBySale.set(it.sale_id, []);
    itemsBySale.get(it.sale_id).push(it);
  }

  // NFC-e mais recente autorizada por venda original (pra decidir per_origin)
  const nfceResp = await client.query(
    `SELECT DISTINCT ON (sale_id) sale_id, id, nuvemfiscal_id, chave_acesso, authorized_at, numero, status
       FROM nfce_emissions
      WHERE sale_id IN (${placeholders}) AND tipo = 'nfce' AND status = 'autorizada'
      ORDER BY sale_id, created_at DESC`,
    [currentCompanyId, ...originalSaleIds]
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

// ─── Validate returned_items (dupla-devolucao + ownership) ─────
async function validateReturnedItems(client, originSales, returnedItems) {
  if (!Array.isArray(returnedItems)) {
    throw new TrocaV2Error(400, { error: 'returned_items deve ser array' });
  }
  const originIdSet = new Set(originSales.map((s) => s.id));
  const itemsBySale = new Map(originSales.map((s) => [s.id, s.items]));

  // Agrupa returned por original_sale_item_id pra check de dupla-devolucao
  const requestedByItem = new Map();

  for (const ret of returnedItems) {
    if (!ret.original_sale_id) {
      throw new TrocaV2Error(400, { error: 'returned_item.original_sale_id obrigatorio em todas as linhas' });
    }
    if (!originIdSet.has(ret.original_sale_id)) {
      throw new TrocaV2Error(400, {
        error: `returned_item aponta pra original_sale_id ${ret.original_sale_id} que nao esta em original_sale_ids[]`,
      });
    }
    if (!ret.original_sale_item_id) {
      throw new TrocaV2Error(400, {
        error: 'returned_item.original_sale_item_id obrigatorio (sale_items.id da linha original)',
      });
    }
    const saleItems = itemsBySale.get(ret.original_sale_id) || [];
    const origItem = saleItems.find((i) => i.id === ret.original_sale_item_id);
    if (!origItem) {
      throw new TrocaV2Error(400, {
        error: `sale_items.${ret.original_sale_item_id} nao pertence a venda ${ret.original_sale_id}`,
      });
    }
    const qty = parseFloat(ret.quantity);
    if (!qty || qty <= 0) {
      throw new TrocaV2Error(400, { error: 'returned_item.quantity deve ser > 0' });
    }
    if (qty > parseFloat(origItem.quantity)) {
      throw new TrocaV2Error(400, {
        error: `quantity ${qty} excede a quantidade original ${origItem.quantity} de "${origItem.product_name_snapshot}"`,
      });
    }
    requestedByItem.set(
      ret.original_sale_item_id,
      (requestedByItem.get(ret.original_sale_item_id) || 0) + qty
    );
  }

  // Dupla-devolucao: somar quantidades JA devolvidas em trocas anteriores
  // (status != 'cancelled') e verificar que (anterior + agora) <= original.
  const itemIds = Array.from(requestedByItem.keys());
  if (itemIds.length === 0) return; // sem returned_items, ok

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
    // origItem.quantity ja foi validado acima
    const saleItems = itemsBySale.get(ret.original_sale_id) || [];
    const origItem = saleItems.find((i) => i.id === ret.original_sale_item_id);
    const origQty = parseFloat(origItem.quantity);
    const stillAvailable = origQty - already;
    // Aviso: requestedByItem agrupa multiplos returned_items mesmo item.
    // O loop ja somou e a checagem usa o total agrupado.
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

// ─── Compute totals + validate splits ──────────────────────────
function computeAndValidateTotals({ returned_items, new_items, payment_splits, refund_splits }) {
  const returnedValue = (returned_items || []).reduce(
    (acc, r) => acc + parseFloat(r.quantity) * parseFloat(r.unit_price), 0
  );
  const newValue = (new_items || []).reduce(
    (acc, n) => acc + parseFloat(n.quantity) * parseFloat(n.unit_price), 0
  );
  const netAmount = parseFloat((newValue - returnedValue).toFixed(2));

  if ((returned_items || []).length === 0 && (new_items || []).length === 0) {
    throw new TrocaV2Error(400, { error: 'Informe pelo menos um returned_item ou new_item' });
  }

  if (netAmount > 0.005) {
    const total = (payment_splits || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    if (Math.abs(total - netAmount) > 0.01) {
      throw new TrocaV2Error(400, {
        error: `Soma dos payment_splits (${total.toFixed(2)}) nao bate com diferenca a pagar (${netAmount.toFixed(2)})`,
        expected: netAmount,
        received: parseFloat(total.toFixed(2)),
      });
    }
  } else if (netAmount < -0.005) {
    const total = (refund_splits || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    const target = Math.abs(netAmount);
    if (Math.abs(total - target) > 0.01) {
      throw new TrocaV2Error(400, {
        error: `Soma dos refund_splits (${total.toFixed(2)}) nao bate com saldo a devolver (${target.toFixed(2)})`,
        expected: target,
        received: parseFloat(total.toFixed(2)),
      });
    }
  }
  // netAmount === 0: sem split obrigatorio

  return {
    returnedValue: parseFloat(returnedValue.toFixed(2)),
    newValue: parseFloat(newValue.toFixed(2)),
    netAmount,
    saleTotal: parseFloat(newValue.toFixed(2)),
  };
}

// ─── Decide fiscal strategy per origin ─────────────────────────
// Retorna Map<originalSaleId, 'cancel_reissue' | 'devolucao_55' | 'none'>
function decideFiscalPerOrigin(originSales, returnedItems, requestedStrategy) {
  const strategyMap = new Map();
  if (requestedStrategy === 'none') {
    for (const s of originSales) strategyMap.set(s.id, 'none');
    return strategyMap;
  }

  const involvedIds = new Set((returnedItems || []).map((r) => r.original_sale_id));
  const now = Date.now();

  for (const s of originSales) {
    if (!involvedIds.has(s.id)) {
      strategyMap.set(s.id, 'none');
      continue;
    }
    if (requestedStrategy === 'cancel_reissue') {
      // forca cancel_reissue mesmo que >24h — backend valida e rejeita
      strategyMap.set(s.id, 'cancel_reissue');
      continue;
    }
    if (requestedStrategy === 'devolucao_55') {
      strategyMap.set(s.id, 'devolucao_55');
      continue;
    }
    // per_origin (default): decide automaticamente
    if (!s.nfce) {
      // sem NFC-e autorizada — nao tem o que cancelar e nao tem chave pra refNFe
      strategyMap.set(s.id, 'none');
      continue;
    }
    const ageHours = s.nfce.authorized_at
      ? (now - new Date(s.nfce.authorized_at).getTime()) / 3600000
      : 9999;
    strategyMap.set(s.id, ageHours < 24 ? 'cancel_reissue' : 'devolucao_55');
  }

  return strategyMap;
}

// ─── Cancel NFCes (PRE-COMMIT) ─────────────────────────────────
// Cancela todas as NFC-es das vendas marcadas como cancel_reissue.
// Retorna lista [{originalSaleId, origNfceRow}] das que foram canceladas
// na SEFAZ — caso ROLLBACK SQL aconteca depois, caller tenta destornar
// via undoCancellations() (best-effort).
async function preCancelNfces(originSales, strategyMap) {
  const cancelled = [];
  for (const s of originSales) {
    if (strategyMap.get(s.id) !== 'cancel_reissue') continue;
    if (!s.nfce || !s.nfce.nuvemfiscal_id) continue;

    const ageHours = s.nfce.authorized_at
      ? (Date.now() - new Date(s.nfce.authorized_at).getTime()) / 3600000
      : 9999;
    if (ageHours >= 24) {
      // Cliente forcou cancel_reissue mas a janela passou — nao temos como
      // cancelar. Sugerir devolucao_55 via error explicito.
      throw new TrocaV2Error(409, {
        error: `NFC-e da venda ${s.id} tem ${Math.round(ageHours)}h (>24h). Use nfce_strategy='devolucao_55' ou 'per_origin'.`,
        original_sale_id: s.id,
        original_chave: s.nfce.chave_acesso,
        age_hours: Math.round(ageHours * 10) / 10,
      });
    }

    try {
      await nuvemfiscal.cancelNfce(
        s.nfce.nuvemfiscal_id,
        `Troca de mercadoria — emissao de nova NFC-e (troca v2)`
      );
      cancelled.push({ originalSaleId: s.id, origNfce: s.nfce });
    } catch (sefazErr) {
      console.error('[trocaV2] SEFAZ cancel error:', sefazErr.message);
      throw new TrocaV2Error(502, {
        error: 'SEFAZ rejeitou cancelamento da NFC-e original: ' + sefazErr.message,
        original_sale_id: s.id,
        sefaz_payload: sefazErr.payload || null,
        cancelled_so_far: cancelled.map((c) => c.originalSaleId), // pra caller saber
      });
    }
  }
  return cancelled;
}

// ─── Undo cancellations (best-effort) ──────────────────────────
// Chamado em catch quando o SQL transaction da pau APOS pre-cancel.
// Tenta destornar as cancelaments via Nuvem Fiscal. Pode falhar — nesse
// caso log e segue (NFC-e fica cancelada e operador precisa reemitir manualmente).
async function undoCancellations(cancelled) {
  for (const c of cancelled) {
    try {
      if (nuvemfiscal.uncancelNfce) {
        await nuvemfiscal.uncancelNfce(c.origNfce.nuvemfiscal_id);
        console.log('[trocaV2] undo cancel OK', c.originalSaleId);
      } else {
        console.warn('[trocaV2] nuvemfiscal.uncancelNfce nao implementado — NFC-e fica cancelada:', c.originalSaleId);
      }
    } catch (e) {
      console.error('[trocaV2] undo cancel failed:', c.originalSaleId, e.message);
    }
  }
}

// ─── Adjust stock ──────────────────────────────────────────────
async function adjustStock(client, returnedItems, newItems, currentCompanyId, trocaSaleId) {
  // Devolvidos → stock IN (volta pro estoque da company de origem)
  for (const ret of returnedItems) {
    const qty = parseFloat(ret.quantity);
    if (!ret.product_id) continue;
    const { rows: pInfo } = await client.query(
      'SELECT company_id FROM products WHERE id=$1',
      [ret.product_id]
    );
    const stockCompanyId = pInfo[0]?.company_id || currentCompanyId;
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
       VALUES ($1,$2,'in',$3,$4,'troca','Troca v2 - devolucao') ON CONFLICT DO NOTHING`,
      [ret.product_id, stockCompanyId, qty, trocaSaleId]
    );
  }

  // Novos → stock OUT (sai do estoque da company fisica = currentCompanyId)
  for (const item of newItems) {
    if (!item.product_id) continue;
    const qty = parseFloat(item.quantity);
    let stockAvailable;
    let stockLabel = item.product_name_snapshot || item.product_id;
    let stockCompanyId = currentCompanyId;

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
        stockCompanyId = vr[0].stock_company_id || currentCompanyId;
      }
    } else {
      const { rows: pr } = await client.query(
        `SELECT p.stock_qty, p.company_id AS stock_company_id
           FROM products p
           JOIN companies c ON c.id = $2
          WHERE p.id = $1
            AND (p.company_id = $2 OR (p.company_id = c.billing_owner_company_id AND p.is_group_shared = true))`,
        [item.product_id, currentCompanyId]
      );
      if (pr.length) {
        stockAvailable = parseFloat(pr[0].stock_qty);
        stockCompanyId = pr[0].stock_company_id || currentCompanyId;
      }
    }

    if (stockAvailable !== undefined && stockAvailable < qty) {
      throw new TrocaV2Error(409, {
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
        [qty, item.product_id, stockCompanyId]
      );
    }
    await client.query(
      `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
       VALUES ($1,$2,'out',$3,$4,'troca','Troca v2 - saida novo item') ON CONFLICT DO NOTHING`,
      [item.product_id, stockCompanyId, qty, trocaSaleId]
    );
  }
}

// ─── Sale_payments split (pagamento da diferenca) ──────────────
// Cria 1 linha negativa de -returnedValue + 1 linha positiva por
// payment_split. Mantem o padrao do v1 mas particiona o positivo.
async function insertSalePayments(client, trocaSaleId, companyId, sessaoId, totals, paymentSplits, refundSplits) {
  // Linha negativa: returnedValue (mantida pra caixa nao perder)
  if (totals.returnedValue > 0) {
    // Method: se ha refund_splits, usa o primeiro. Senao, fallback dinheiro.
    const negativeMethod = (refundSplits && refundSplits[0]?.method) || (paymentSplits && paymentSplits[0]?.method) || 'dinheiro';
    const normalized = normalizeMethodForSalePayments(negativeMethod);
    await client.query(
      `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [trocaSaleId, companyId, normalized, -parseFloat(totals.returnedValue.toFixed(2)), sessaoId]
    );
  }
  // Linhas positivas: 1 por payment_split
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
  // sale_payments.method aceita: dinheiro, pix, cartao, debito, crediario etc
  // Frontend v2 manda: dinheiro, pix, cartao_credito, cartao_debito, cartao_estorno
  if (!method) return 'dinheiro';
  const m = String(method).toLowerCase();
  if (m === 'cartao_credito') return 'cartao';
  if (m === 'cartao_debito') return 'debito';
  if (m === 'cartao_estorno') return 'cartao';
  if (m === 'crediario_credito') return 'crediario';
  return m;
}

// ─── Troca_payouts + customer_credit_transactions ──────────────
// Quando netAmount < 0, registra refund_splits em troca_payouts.
// Para method=crediario_credito, ALEM disso grava customer_credit_transactions
// com type='payment' (saldo NEGATIVO = credito a favor do cliente).
async function insertTrocaPayouts(client, trocaSaleId, companyId, sessaoId, customerId, refundSplits, userId) {
  if (!refundSplits || !refundSplits.length) return [];
  const inserted = [];

  for (const r of refundSplits) {
    if (parseFloat(r.amount) <= 0) continue;
    const amount = parseFloat(parseFloat(r.amount).toFixed(2));

    let creditTxId = null;
    if (r.method === 'crediario_credito') {
      if (!customerId) {
        throw new TrocaV2Error(400, {
          error: 'crediario_credito exige customer_id (cliente cadastrado)',
        });
      }
      const { rows: txRows } = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, sale_id, type, amount, payment_method, notes, created_by)
         VALUES ($1, $2, $3, 'payment', $4, 'crediario_credito', $5, $6)
         RETURNING id`,
        [
          companyId, customerId, trocaSaleId, amount,
          `Credito de troca (sale ${trocaSaleId.slice(0, 8)})`,
          userId || null,
        ]
      );
      creditTxId = txRows[0]?.id || null;
    }

    const { rows: poRows } = await client.query(
      `INSERT INTO troca_payouts
         (troca_sale_id, company_id, customer_id, method, amount, sessao_id,
          credit_transaction_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        trocaSaleId, companyId, customerId || null, r.method, amount, sessaoId,
        creditTxId, r.notes || null, userId || null,
      ]
    );
    inserted.push({ id: poRows[0].id, method: r.method, amount, credit_transaction_id: creditTxId });
  }
  return inserted;
}

// ─── Aggregate transactions (income + expense) ─────────────────
async function insertAggregateTransactions(client, trocaSaleId, primaryCompanyId, totals, originalSaleIds, userId) {
  const summary = originalSaleIds.length === 1
    ? `Troca PDV — venda ${originalSaleIds[0].slice(0, 8)}`
    : `Troca PDV — ${originalSaleIds.length} vendas originais`;

  if (totals.returnedValue > 0) {
    await client.query(
      `INSERT INTO transactions
         (company_id, type, status, amount, description, category,
          due_date, paid_at, created_by, idempotency_key)
       VALUES ($1,'expense','confirmed',$2,$3,'Troca - Devolução',${SP_DATE_NOW},NOW(),$4,$5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        primaryCompanyId,
        parseFloat(totals.returnedValue.toFixed(2)),
        summary,
        userId || null,
        'pdv-troca-v2-' + trocaSaleId + '-return',
      ]
    );
  }
  if (totals.newValue > 0) {
    await client.query(
      `INSERT INTO transactions
         (company_id, type, status, amount, description, category,
          due_date, paid_at, created_by, idempotency_key)
       VALUES ($1,'income','confirmed',$2,$3,'Troca - Venda',${SP_DATE_NOW},NOW(),$4,$5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        primaryCompanyId,
        parseFloat(totals.newValue.toFixed(2)),
        summary,
        userId || null,
        'pdv-troca-v2-' + trocaSaleId + '-sale',
      ]
    );
  }
}

// ─── Main handler ──────────────────────────────────────────────
async function handle(req, res) {
  const {
    original_sale_ids,
    returned_items = [],
    new_items = [],
    payment_splits = [],
    refund_splits = [],
    customer_id,
    employee_id,
    seller_name,
    nfce_strategy = 'per_origin',
    customer_address,
  } = req.body || {};

  const client = await db.connect();
  let preCancelled = [];
  try {
    await client.query('BEGIN');

    // 1. Caixa aberto
    const caixaCheck = await assertCaixaOpenOrAllowed(client, req.params.id);
    if (!caixaCheck.ok) {
      await client.query('ROLLBACK');
      return res.status(caixaCheck.status).json(caixaCheck.body);
    }
    const sessaoId = caixaCheck.sessaoId || (await getActiveSessaoId(client, req.params.id));

    // 2. Lookup vendas originais
    const originSales = await lookupOriginSales(client, req.params.id, original_sale_ids);

    // 3. Validar returned_items (ownership + dupla-devolucao)
    await validateReturnedItems(client, originSales, returned_items);

    // 4. Calcular totais + validar splits
    const totals = computeAndValidateTotals({ returned_items, new_items, payment_splits, refund_splits });

    // 5. Decidir estrategia fiscal por origem
    const strategyMap = decideFiscalPerOrigin(originSales, returned_items, nfce_strategy);

    // 6. Validar pre-condicoes da devolucao_55
    const needsDevolucao55 = Array.from(strategyMap.values()).some((s) => s === 'devolucao_55');
    if (needsDevolucao55) {
      // valida endereço
      const addr = customer_address || {};
      const missing = [];
      if (!addr.street) missing.push('street');
      if (!addr.neighborhood) missing.push('neighborhood');
      if (!addr.city) missing.push('city');
      if (!addr.state) missing.push('state');
      if (!addr.zip) missing.push('zip');
      if (!addr.ibge) missing.push('ibge');
      if (missing.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'devolucao_55 exige endereco completo do cliente',
          code: 'CUSTOMER_ADDRESS_REQUIRED',
          missing_fields: missing,
        });
      }
    }

    // 7. PRE-COMMIT FISCAL: cancela NFC-es das vendas marcadas como cancel_reissue.
    //    Se falha aqui, ROLLBACK ainda preserva tudo no banco.
    preCancelled = await preCancelNfces(originSales, strategyMap);

    // 8. Determina company "primaria" da troca (onde a sale_row vai)
    //    Padrão: primeira venda original (mesmo grupo); pra cross-filial, mantem origem.
    const primarySale = originSales[0];
    const saleCompanyId = primarySale.company_id;
    const isCrossFilial = originSales.some((s) => s.is_cross_filial);

    // 9. Verificar se a tabela sales tem exchange_seller_id (migration 111)
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
      return res.status(503).json({
        error: 'Troca cross-filial v2 indisponivel: migration 111 nao aplicada',
        code: 'MIGRATION_111_PENDING',
      });
    }

    // 10. Criar sales row da troca (type='troca', exchange_of_sale_id = primeira original)
    let trocaSaleRow;
    if (hasExchangeCols) {
      const r = await client.query(
        `INSERT INTO sales
           (company_id, customer_id, seller_id, employee_id, seller_name,
            exchange_seller_id, exchange_employee_id,
            total_amount, discount_amount, payment_method, notes,
            status, type, exchange_of_sale_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,'completed','troca',$11)
         RETURNING *`,
        [
          saleCompanyId,
          customer_id || primarySale && (originSales[0]?.customer_id) || null,
          trocaSellerId, trocaEmployeeId,
          seller_name || null,
          exchangeSellerId, exchangeEmployeeId,
          totals.saleTotal,
          (payment_splits[0]?.method || refund_splits[0]?.method || 'dinheiro'),
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
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'completed','troca',$9)
         RETURNING *`,
        [
          saleCompanyId,
          customer_id || null,
          trocaSellerId, trocaEmployeeId,
          seller_name || null,
          totals.saleTotal,
          (payment_splits[0]?.method || refund_splits[0]?.method || 'dinheiro'),
          `Troca v2 — ${original_sale_ids.length} venda(s) original(is)`,
          original_sale_ids[0],
        ]
      );
      trocaSaleRow = r.rows[0];
    }

    // 11. Inserir new_items em sale_items
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
          trocaSaleRow.id,
          item.product_id || null,
          item.variant_id || null,
          qty, unitPrice, costPrice, lineTotal,
          productName,
        ]
      );
    }

    // 12. Inserir troca_returned_items (uma por linha, com original_sale_item_id v2)
    for (const ret of returned_items) {
      await client.query(
        `INSERT INTO troca_returned_items
           (troca_sale_id, original_sale_id, original_sale_item_id,
            product_id, variant_id, quantity, unit_price, product_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          trocaSaleRow.id,
          ret.original_sale_id,
          ret.original_sale_item_id,
          ret.product_id || null,
          ret.variant_id || null,
          parseFloat(ret.quantity),
          parseFloat(ret.unit_price),
          ret.product_name_snapshot || null,
        ]
      );
    }

    // 13. Estoque (in + out)
    await adjustStock(client, returned_items, new_items, req.params.id, trocaSaleRow.id);

    // 14. sale_payments split
    await insertSalePayments(
      client, trocaSaleRow.id, req.params.id, sessaoId,
      totals, payment_splits, refund_splits
    );

    // 15. troca_payouts (+ customer_credit_transactions se crediario_credito)
    const payoutsInserted = await insertTrocaPayouts(
      client, trocaSaleRow.id, req.params.id, sessaoId,
      customer_id || originSales[0]?.customer_id || null,
      refund_splits, req.user?.id
    );

    // 16. transactions agregadas
    await insertAggregateTransactions(
      client, trocaSaleRow.id, saleCompanyId, totals, original_sale_ids, req.user?.id
    );

    // 17. Marcar NFC-es originais canceladas + atualizar trocaSale.nfce_strategy
    for (const c of preCancelled) {
      await client.query(
        `UPDATE nfce_emissions
            SET status = 'cancelada', cancelled_at = NOW(),
                cancel_reason = $1
          WHERE id = $2`,
        ['Troca v2 — cancel_reissue sale_troca=' + trocaSaleRow.id, c.origNfce.id]
      );
    }

    // 18. POST-COMMIT FISCAL: emit NF-e 55 pra cada venda marcada
    //     como devolucao_55. Sao chamadas individuais por origem.
    const fiscalResults = [];
    for (const s of originSales) {
      const strat = strategyMap.get(s.id);
      if (strat !== 'devolucao_55') continue;
      const itemsForThis = returned_items.filter((r) => r.original_sale_id === s.id);
      const valueForThis = itemsForThis.reduce(
        (acc, r) => acc + parseFloat(r.quantity) * parseFloat(r.unit_price), 0
      );
      try {
        const result = await trocaDevolucao55.handle(client, {
          saleCompanyId: s.company_id,
          originalSaleId: s.id,
          trocaSaleId: trocaSaleRow.id,
          returnedItems: itemsForThis,
          returnedValue: valueForThis,
          customerAddress: customer_address,
          notes: req.body.notes,
          userId: req.user?.id,
        });
        fiscalResults.push({ original_sale_id: s.id, ...result });
      } catch (e) {
        if (e && e.isDevolucao55Error) {
          await client.query('ROLLBACK');
          await undoCancellations(preCancelled); // best-effort
          return res.status(e.status).json({
            ...e.body,
            failed_for_sale_id: s.id,
          });
        }
        throw e;
      }
    }
    for (const c of preCancelled) {
      fiscalResults.push({
        original_sale_id: c.originalSaleId,
        strategy: 'cancel_reissue',
        original_chave_cancelada: c.origNfce.chave_acesso,
      });
    }

    await client.query('COMMIT');

    // 19. Response
    const { rows: respNewItems } = await db.query(
      `SELECT si.*, COALESCE(p.name, si.product_name_snapshot) AS product_name
         FROM sale_items si LEFT JOIN products p ON p.id=si.product_id
        WHERE si.sale_id=$1`,
      [trocaSaleRow.id]
    );
    const { rows: respRetItems } = await db.query(
      `SELECT tri.*, COALESCE(p.name, tri.product_name_snapshot) AS product_name
         FROM troca_returned_items tri LEFT JOIN products p ON p.id=tri.product_id
        WHERE tri.troca_sale_id=$1`,
      [trocaSaleRow.id]
    );

    return res.status(201).json({
      version: 'v2',
      sale: { ...trocaSaleRow, items: respNewItems },
      returned_items: respRetItems,
      new_items: respNewItems,
      net_amount: totals.netAmount,
      returned_value: totals.returnedValue,
      new_value: totals.newValue,
      cross_filial: isCrossFilial,
      origin_company_ids: Array.from(new Set(originSales.map((s) => s.company_id))),
      physical_company_id: req.params.id,
      payouts: payoutsInserted,
      fiscal: { strategy: nfce_strategy, per_origin: fiscalResults },
      original_sale_ids,
      receipt_url: `/companies/${req.params.id}/print/receipt/${trocaSaleRow.id}`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (preCancelled.length) await undoCancellations(preCancelled);
    if (err.isTrocaV2Error) {
      return res.status(err.status).json(err.body);
    }
    console.error('[trocaV2] internal error:', err);
    return res.status(500).json({ error: 'Erro interno na troca v2' });
  } finally {
    client.release();
  }
}

module.exports = {
  handle,
  TrocaV2Error,
  // Exposto pra testes
  _internal: {
    computeAndValidateTotals,
    decideFiscalPerOrigin,
    normalizeMethodForSalePayments,
  },
};
