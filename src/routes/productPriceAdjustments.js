// ============================================================
// AURA. — Reajuste de preco em lote (p-51, 30/10/2026)
// Mount: /companies/:id/products  (ANTES de ./products, que tem /:pid curinga)
//
// POST /price-adjustments              previa (dry_run, padrao) ou aplicar.
// GET  /price-adjustments              ultimos reajustes da empresa (PR 2).
// GET  /price-adjustments/:adjId       um reajuste com os itens (PR 2).
// POST /price-adjustments/:adjId/undo  desfazer em ate 7 dias (PR 2).
//
// Contrato completo na descricao do PR (backend#p-51) e com o app (p-52/p-53).
//
// Regras:
//   - So produtos ATIVOS e visiveis para a empresa (mesma regra da listagem
//     do Estoque: da empresa ou compartilhado no grupo, bidirecional).
//   - Produto compartilhado e UMA linha: o preco novo vale no grupo todo.
//     A previa sinaliza (group_shared / owner_is_other).
//   - So muda products.price, products.card_price (manual) e
//     product_variants.price_override (quando ja existe). Nunca estoque,
//     custo nem codigo.
//   - Aplicar: transacao, linhas travadas (FOR UPDATE) e a conta refeita
//     com elas; lote e itens gravados na 422; audit_log depois do COMMIT.
//   - Abaixo do custo so grava com allow_below_cost: true (409 sem ele).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { logAuditAction, contextoDaRequisicao } = require('../middleware/auditLog');
const { lerPedido, montarPrevia, itemPublico } = require('../services/reajusteDePreco');

// Mesma regra de listVisibilityWhere de products.js (copia, como fazem
// productImage/productImages/productsVariations), com alias de tabela.
function listVisibilityWhere(cidParam, alias = 'p') {
  return `(${alias}.company_id = ${cidParam} OR (
    ${alias}.is_group_shared = true
    AND ${alias}.company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

async function tamanhoDoGrupo(q, cid) {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $1
      )`,
    [cid]
  );
  return rows[0] ? rows[0].n : 1;
}

/** Le produtos e variantes com preco proprio. `travar` = FOR UPDATE (aplicar). */
async function lerLinhas(q, cid, ids, travar) {
  const lock = travar ? 'FOR UPDATE OF p' : '';
  const { rows: products } = await q(
    `SELECT p.id, p.company_id, p.name, p.sku, p.price, p.cost_price, p.card_price, p.is_group_shared
       FROM products p
      WHERE p.is_active = true AND p.id = ANY($2::uuid[]) AND ${listVisibilityWhere('$1')}
      ${lock}`,
    [cid, ids]
  );
  if (!products.length) return { products, variants: [] };
  const { rows: variants } = await q(
    `SELECT pv.id, pv.product_id, pv.price_override, pv.sku_suffix,
            COALESCE(
              (SELECT string_agg(pvv.value, ' / ' ORDER BY pvv.attribute_name)
                 FROM product_variant_values pvv WHERE pvv.variant_id = pv.id),
              pv.sku_suffix
            ) AS label
       FROM product_variants pv
      WHERE pv.product_id = ANY($1::uuid[]) AND pv.is_active = true AND pv.price_override IS NOT NULL
      ${travar ? 'FOR UPDATE OF pv' : ''}`,
    [products.map((p) => p.id)]
  );
  return { products, variants };
}

function respostaDaPrevia(input, previa, extra = {}) {
  return {
    dry_run: input.dryRun,
    adjustment_id: null,
    mode: input.mode,
    direction: input.direction,
    value: input.value,
    rounding: input.rounding,
    allow_below_cost: input.allowBelowCost,
    summary: previa.summary,
    items: previa.items.map(itemPublico),
    not_found_ids: previa.notFoundIds,
    ...extra,
  };
}

// ─── POST /price-adjustments ──────────────────────────────
router.post('/price-adjustments', async (req, res) => {
  const cid = req.params.id;
  const lido = lerPedido(req.body);
  if (lido.error) return res.status(400).json({ error: lido.error, code: lido.code });
  const input = lido.input;

  // Previa: nada gravado, nao depende da migration 422.
  if (input.dryRun) {
    try {
      const q = (sql, p) => db.query(sql, p);
      const groupSize = await tamanhoDoGrupo(q, cid);
      const { products, variants } = await lerLinhas(q, cid, input.productIds, false);
      const previa = montarPrevia({ products, variants, input, companyId: cid, groupSize });
      return res.json(respostaDaPrevia(input, previa));
    } catch (err) {
      console.error('[priceAdjustments] previa:', err.message, err.code);
      return res.status(500).json({ error: 'Erro ao calcular o reajuste' });
    }
  }

  // Aplicar.
  const client = await db.connect();
  let previa;
  let adjustmentId = null;
  try {
    await client.query('BEGIN');
    const q = (sql, p) => client.query(sql, p);
    const groupSize = await tamanhoDoGrupo(q, cid);
    const { products, variants } = await lerLinhas(q, cid, input.productIds, true);
    previa = montarPrevia({ products, variants, input, companyId: cid, groupSize });
    const mudam = previa.items.filter((i) => i.status === 'change');

    if (previa.summary.below_cost > 0 && !input.allowBelowCost) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        ...respostaDaPrevia(input, previa),
        error: 'Alguns produtos ficariam abaixo do custo',
        code: 'BELOW_COST',
      });
    }

    if (mudam.length === 0) {
      await client.query('ROLLBACK');
      return res.json(respostaDaPrevia(input, previa));
    }

    const s = previa.summary;
    const { rows: [lote] } = await q(
      `INSERT INTO product_price_adjustments
         (company_id, user_id, mode, direction, value, rounding, allow_below_cost,
          products_count, items_count, skipped_count, below_cost_count, group_shared_count, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       RETURNING id`,
      [cid, req.user?.id || null, input.mode, input.direction, input.value, input.rounding, input.allowBelowCost,
        previa.productsChangedCount, mudam.length, s.skipped_no_cost + s.skipped_not_positive,
        s.below_cost, s.group_shared, JSON.stringify(s)]
    );
    adjustmentId = lote.id;

    const prods = mudam.filter((i) => i.variant_id === null);
    const vars = mudam.filter((i) => i.variant_id !== null);
    if (prods.length) {
      await q(
        `UPDATE products p
            SET price = v.price, card_price = v.card, updated_at = NOW()
           FROM unnest($1::uuid[], $2::numeric[], $3::numeric[]) AS v(id, price, card)
          WHERE p.id = v.id`,
        [prods.map((i) => i.product_id), prods.map((i) => i._priceCents / 100),
          prods.map((i) => (i._cardCents === null ? null : i._cardCents / 100))]
      );
    }
    if (vars.length) {
      await q(
        `UPDATE product_variants pv
            SET price_override = v.price, updated_at = NOW()
           FROM unnest($1::uuid[], $2::numeric[]) AS v(id, price)
          WHERE pv.id = v.id`,
        [vars.map((i) => i.variant_id), vars.map((i) => i._priceCents / 100)]
      );
    }

    await q(
      `INSERT INTO product_price_adjustment_items
         (adjustment_id, product_id, variant_id, owner_company_id, group_shared, name, variant_label,
          cost_price, price_before, price_after, card_price_before, card_price_after, below_cost)
       SELECT $1, v.product_id, v.variant_id, v.owner, v.grp, v.name, v.vlabel,
              v.cost, v.pb, v.pa, v.cb, v.ca, v.below
         FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::boolean[], $6::text[], $7::text[],
                     $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::boolean[])
           AS v(product_id, variant_id, owner, grp, name, vlabel, cost, pb, pa, cb, ca, below)`,
      [adjustmentId,
        mudam.map((i) => i.product_id), mudam.map((i) => i.variant_id), mudam.map((i) => i.owner_company_id),
        mudam.map((i) => i.group_shared), mudam.map((i) => i.name), mudam.map((i) => i.variant_label),
        mudam.map((i) => i.cost_price), mudam.map((i) => i.price_before), mudam.map((i) => i.price_after),
        mudam.map((i) => i.card_price_before), mudam.map((i) => i.card_price_after), mudam.map((i) => i.below_cost)]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '42P01') {
      return res.status(503).json({
        error: 'O reajuste em lote ainda esta sendo instalado. Tente de novo em alguns minutos.',
        code: 'MIGRATION_PENDING',
      });
    }
    console.error('[priceAdjustments] aplicar:', err.message, err.code);
    return res.status(500).json({ error: 'Erro ao aplicar o reajuste' });
  } finally {
    if (client.release) client.release();
  }

  const s = previa.summary;
  logAuditAction(
    req.user?.id || null, cid, 'products.price_adjusted',
    `Reajuste em lote (${input.mode}) em ${s.items_changed} itens`,
    {
      adjustment_id: adjustmentId, mode: input.mode, direction: input.direction, value: input.value,
      rounding: input.rounding, allow_below_cost: input.allowBelowCost,
      items_changed: s.items_changed, below_cost: s.below_cost, group_shared: s.group_shared,
    },
    contextoDaRequisicao(req)
  );

  return res.json(respostaDaPrevia(input, previa, { adjustment_id: adjustmentId }));
});

// ─── Desfazer e lista (PR 2) ──────────────────────────────
//
// Desfazer: so lote da propria empresa, ate 7 dias, uma vez. Por item,
// volta ao "antes" SO se o valor atual ainda e exatamente o que o lote
// gravou (preco e, no produto, tambem o preco no cartao). Nao ha
// historico de preco nem trigger por campo (o updated_at sobe em qualquer
// update, inclusive baixa de estoque), entao a comparacao de valor e a
// unica prova de que ninguem mexeu depois. Os outros ficam como estao e
// voltam em changed_after.

const UNDO_DIAS = 7;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const num = (v) => (v === null || v === undefined ? null : Number(v));
const cents = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));

function loteOut(r) {
  return {
    id: r.id,
    created_at: r.created_at,
    user: r.user_id ? { id: r.user_id, name: r.user_name || null } : null,
    mode: r.mode,
    direction: r.direction,
    value: num(r.value),
    rounding: r.rounding,
    allow_below_cost: r.allow_below_cost,
    items_count: r.items_count,
    products_count: r.products_count,
    skipped_count: r.skipped_count,
    below_cost_count: r.below_cost_count,
    group_shared_count: r.group_shared_count,
    undo_deadline: r.undo_deadline,
    can_undo: !!r.can_undo,
    undone_at: r.undone_at,
    undone_by: r.undone_by,
    undo_restored_count: r.undo_restored_count,
    undo_changed_count: r.undo_changed_count,
  };
}

const LOTE_SELECT = `
  SELECT a.*, u.full_name AS user_name,
         a.created_at + INTERVAL '${UNDO_DIAS} days' AS undo_deadline,
         (a.undone_at IS NULL AND a.created_at > NOW() - INTERVAL '${UNDO_DIAS} days') AS can_undo
    FROM product_price_adjustments a
    LEFT JOIN users u ON u.id = a.user_id`;

// ─── GET /price-adjustments ───────────────────────────────
router.get('/price-adjustments', async (req, res) => {
  const cid = req.params.id;
  const lim = parseInt(req.query.limit, 10);
  const limit = Math.min(Number.isFinite(lim) && lim > 0 ? lim : 20, 100);
  const off = parseInt(req.query.offset, 10);
  const offset = Number.isFinite(off) && off > 0 ? off : 0;
  try {
    const { rows } = await db.query(
      `${LOTE_SELECT} WHERE a.company_id = $1 ORDER BY a.created_at DESC, a.id LIMIT $2 OFFSET $3`,
      [cid, limit, offset]
    );
    const { rows: [t] } = await db.query(
      `SELECT COUNT(*)::int AS total FROM product_price_adjustments WHERE company_id = $1`, [cid]
    );
    return res.json({ adjustments: rows.map(loteOut), total: t ? t.total : rows.length });
  } catch (err) {
    if (err.code === '42P01') return res.json({ adjustments: [], total: 0 });
    console.error('[priceAdjustments] lista:', err.message, err.code);
    return res.status(500).json({ error: 'Erro ao listar os reajustes' });
  }
});

// ─── GET /price-adjustments/:adjId ────────────────────────
router.get('/price-adjustments/:adjId', async (req, res) => {
  const { id: cid, adjId } = req.params;
  if (!UUID_RE.test(String(adjId))) return res.status(404).json({ error: 'Reajuste nao encontrado', code: 'NOT_FOUND' });
  try {
    const { rows: [lote] } = await db.query(`${LOTE_SELECT} WHERE a.id = $1 AND a.company_id = $2`, [adjId, cid]);
    if (!lote) return res.status(404).json({ error: 'Reajuste nao encontrado', code: 'NOT_FOUND' });
    const { rows: itens } = await db.query(
      `SELECT product_id, variant_id, name, variant_label, cost_price, price_before, price_after,
              card_price_before, card_price_after, below_cost, group_shared, undo_status
         FROM product_price_adjustment_items
        WHERE adjustment_id = $1
        ORDER BY name, variant_id NULLS FIRST, id`,
      [adjId]
    );
    return res.json({
      ...loteOut(lote),
      items: itens.map((i) => ({
        ...i,
        cost_price: num(i.cost_price),
        price_before: num(i.price_before),
        price_after: num(i.price_after),
        card_price_before: num(i.card_price_before),
        card_price_after: num(i.card_price_after),
      })),
    });
  } catch (err) {
    if (err.code === '42P01') return res.status(404).json({ error: 'Reajuste nao encontrado', code: 'NOT_FOUND' });
    console.error('[priceAdjustments] detalhe:', err.message, err.code);
    return res.status(500).json({ error: 'Erro ao abrir o reajuste' });
  }
});

// ─── POST /price-adjustments/:adjId/undo ──────────────────
router.post('/price-adjustments/:adjId/undo', async (req, res) => {
  const { id: cid, adjId } = req.params;
  if (!UUID_RE.test(String(adjId))) return res.status(404).json({ error: 'Reajuste nao encontrado', code: 'NOT_FOUND' });

  const client = await db.connect();
  let resultado;
  try {
    await client.query('BEGIN');
    const q = (sql, p) => client.query(sql, p);

    const { rows: [lote] } = await q(
      `SELECT id, undone_at,
              created_at + INTERVAL '${UNDO_DIAS} days' AS undo_deadline,
              created_at > NOW() - INTERVAL '${UNDO_DIAS} days' AS dentro_do_prazo
         FROM product_price_adjustments
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [adjId, cid]
    );
    if (!lote) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reajuste nao encontrado', code: 'NOT_FOUND' });
    }
    if (lote.undone_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este reajuste ja foi desfeito', code: 'ALREADY_UNDONE', undone_at: lote.undone_at });
    }
    if (!lote.dentro_do_prazo) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: `O prazo para desfazer (${UNDO_DIAS} dias) ja passou`, code: 'EXPIRED', undo_deadline: lote.undo_deadline });
    }

    const { rows: itens } = await q(
      `SELECT id, product_id, variant_id, name, variant_label, price_before, price_after,
              card_price_before, card_price_after
         FROM product_price_adjustment_items WHERE adjustment_id = $1
        ORDER BY name, variant_id NULLS FIRST, id`,
      [adjId]
    );

    // Trava as linhas atuais (so as ainda visiveis para a empresa).
    const pids = [...new Set(itens.map((i) => i.product_id))];
    const { rows: prods } = pids.length ? await q(
      `SELECT p.id, p.price, p.card_price FROM products p
        WHERE p.id = ANY($2::uuid[]) AND ${listVisibilityWhere('$1')}
        FOR UPDATE OF p`,
      [cid, pids]
    ) : { rows: [] };
    const vids = itens.filter((i) => i.variant_id).map((i) => i.variant_id);
    const { rows: vars } = vids.length ? await q(
      `SELECT id, product_id, price_override FROM product_variants WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [vids]
    ) : { rows: [] };
    const prodPorId = new Map(prods.map((p) => [String(p.id), p]));
    const varPorId = new Map(vars.map((v) => [String(v.id), v]));

    const restored = [];
    const changedAfter = [];
    for (const i of itens) {
      const p = prodPorId.get(String(i.product_id));
      const v = i.variant_id ? varPorId.get(String(i.variant_id)) : null;
      let atual = null;
      let reason = null;
      if (!p || (i.variant_id && (!v || String(v.product_id) !== String(i.product_id)))) {
        reason = 'not_found';
      } else if (i.variant_id) {
        atual = v.price_override;
        if (cents(atual) !== cents(i.price_after)) reason = 'changed';
      } else {
        atual = p.price;
        if (cents(atual) !== cents(i.price_after) || cents(p.card_price) !== cents(i.card_price_after)) reason = 'changed';
      }
      if (reason) {
        changedAfter.push({
          item_id: i.id, product_id: i.product_id, variant_id: i.variant_id, name: i.name,
          variant_label: i.variant_label, price_after: num(i.price_after), price_now: num(atual), reason,
        });
      } else {
        restored.push(i);
      }
    }

    const rp = restored.filter((i) => !i.variant_id);
    const rv = restored.filter((i) => i.variant_id);
    if (rp.length) {
      await q(
        `UPDATE products p SET price = v.price, card_price = v.card, updated_at = NOW()
           FROM unnest($1::uuid[], $2::numeric[], $3::numeric[]) AS v(id, price, card)
          WHERE p.id = v.id`,
        [rp.map((i) => i.product_id), rp.map((i) => i.price_before), rp.map((i) => i.card_price_before)]
      );
    }
    if (rv.length) {
      await q(
        `UPDATE product_variants pv SET price_override = v.price, updated_at = NOW()
           FROM unnest($1::uuid[], $2::numeric[]) AS v(id, price)
          WHERE pv.id = v.id`,
        [rv.map((i) => i.variant_id), rv.map((i) => i.price_before)]
      );
    }
    if (restored.length) {
      await q(`UPDATE product_price_adjustment_items SET undo_status = 'restored' WHERE id = ANY($1::uuid[])`,
        [restored.map((i) => i.id)]);
    }
    if (changedAfter.length) {
      await q(`UPDATE product_price_adjustment_items SET undo_status = 'changed_after' WHERE id = ANY($1::uuid[])`,
        [changedAfter.map((i) => i.item_id)]);
    }
    const { rows: [fechado] } = await q(
      `UPDATE product_price_adjustments
          SET undone_at = NOW(), undone_by = $2, undo_restored_count = $3, undo_changed_count = $4
        WHERE id = $1
        RETURNING undone_at`,
      [adjId, req.user?.id || null, restored.length, changedAfter.length]
    );
    await client.query('COMMIT');

    resultado = {
      adjustment_id: adjId,
      undone_at: fechado.undone_at,
      restored_count: restored.length,
      changed_after_count: changedAfter.length,
      restored: restored.map((i) => ({ product_id: i.product_id, variant_id: i.variant_id })),
      changed_after: changedAfter.map(({ item_id, ...resto }) => resto),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '42P01') {
      return res.status(503).json({
        error: 'O reajuste em lote ainda esta sendo instalado. Tente de novo em alguns minutos.',
        code: 'MIGRATION_PENDING',
      });
    }
    console.error('[priceAdjustments] desfazer:', err.message, err.code);
    return res.status(500).json({ error: 'Erro ao desfazer o reajuste' });
  } finally {
    if (client.release) client.release();
  }

  logAuditAction(
    req.user?.id || null, cid, 'products.price_adjustment_undone',
    `Desfez reajuste em lote: ${resultado.restored_count} voltaram, ${resultado.changed_after_count} mudaram depois`,
    { adjustment_id: adjId, restored: resultado.restored_count, changed_after: resultado.changed_after_count },
    contextoDaRequisicao(req)
  );
  return res.json(resultado);
});

module.exports = router;
module.exports.listVisibilityWhere = listVisibilityWhere;
