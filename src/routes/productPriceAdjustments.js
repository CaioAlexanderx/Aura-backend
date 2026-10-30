// ============================================================
// AURA. — Reajuste de preco em lote (p-51, 30/10/2026)
// Mount: /companies/:id/products  (ANTES de ./products, que tem /:pid curinga)
//
// POST /price-adjustments  previa (dry_run, padrao) ou aplicar.
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

module.exports = router;
module.exports.listVisibilityWhere = listVisibilityWhere;
