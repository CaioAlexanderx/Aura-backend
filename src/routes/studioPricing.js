// ============================================================
// AURA Studio — Motor de Precificação (Camada 1, Fase B)
// Contratos em services/studioApi.ts. Montado em private.js.
//
// GET  /studio/pricing/rules              → lista regras (global + por produto)
// PUT  /studio/pricing/rules/:productId   → upsert (productId='global' = regra global)
// POST /studio/pricing/quote-line         → calcula preço de 1 linha (breakdown visível)
//
// Nota: product_id pode ser NULL no DB (regra global).
//       Na URL usa-se a string literal 'global' para a regra global.
//
// studio_compositions_summary é uma VIEW já existente com total_cost por produto.
// Se não existir BOM e não vier unit_cost → retorna price=0 com breakdown zerado.
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true }); // company_id = req.params.id
const db      = require('../config/database');

// ─────────────────────────────────────────────────────────────
// GET /studio/pricing/rules
// Lista todas as regras ativas da empresa (global + por produto).
// Ordena: global (product_id IS NULL) primeiro, depois por produto.
// ─────────────────────────────────────────────────────────────
router.get('/pricing/rules', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT * FROM studio_pricing_rules
       WHERE company_id = $1 AND is_active = true
       ORDER BY product_id NULLS FIRST`,
      [cid]
    );
    return res.json({ rules: rows });
  } catch (e) {
    console.error('[studioPricing] GET /rules', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /studio/pricing/rules/:productId
// Upsert de uma regra. productId='global' => product_id=NULL.
// Body: { setup_fee?, labor_cost?, default_margin_pct?, urgency_pct?, qty_tiers? }
// ─────────────────────────────────────────────────────────────
router.put('/pricing/rules/:productId', async (req, res) => {
  const cid = req.params.id;
  const pid = req.params.productId;

  // 'global' é o alias da URL para product_id = NULL
  const productIdValue = pid === 'global' ? null : pid;

  const {
    setup_fee,
    labor_cost,
    default_margin_pct,
    urgency_pct,
    qty_tiers,
  } = req.body || {};

  // Monta lista de campos fornecidos para o upsert
  const fields = {};
  if (setup_fee          !== undefined) fields.setup_fee          = parseFloat(setup_fee)          || 0;
  if (labor_cost         !== undefined) fields.labor_cost         = parseFloat(labor_cost)         || 0;
  if (default_margin_pct !== undefined) fields.default_margin_pct = default_margin_pct === null ? null : parseFloat(default_margin_pct);
  if (urgency_pct        !== undefined) fields.urgency_pct        = parseFloat(urgency_pct)        || 0;
  if (qty_tiers          !== undefined) fields.qty_tiers          = qty_tiers === null ? null : qty_tiers;

  try {
    // ON CONFLICT usa a constraint UNIQUE(company_id, product_id).
    // Para product_id NULL o Postgres trata cada NULL como distinto em unique,
    // MAS a tabela foi criada com uma constraint parcial ou UNIQUE NULLS NOT DISTINCT
    // (migration 138+). O INSERT ON CONFLICT funciona com (company_id, product_id)
    // explícito quando há constraint nomeada.
    //
    // Abordagem segura: tenta UPDATE primeiro, se 0 rows → INSERT.
    let row;

    if (productIdValue === null) {
      // Regra global: WHERE product_id IS NULL
      const upd = await db.query(
        `UPDATE studio_pricing_rules
         SET
           setup_fee          = COALESCE($3, setup_fee),
           labor_cost         = COALESCE($4, labor_cost),
           default_margin_pct = COALESCE($5, default_margin_pct),
           urgency_pct        = COALESCE($6, urgency_pct),
           qty_tiers          = COALESCE($7::jsonb, qty_tiers),
           updated_at         = NOW()
         WHERE company_id = $1 AND product_id IS NULL AND is_active = true
         RETURNING *`,
        [
          cid,
          null,
          fields.setup_fee          !== undefined ? fields.setup_fee          : null,
          fields.labor_cost         !== undefined ? fields.labor_cost         : null,
          fields.default_margin_pct !== undefined ? fields.default_margin_pct : null,
          fields.urgency_pct        !== undefined ? fields.urgency_pct        : null,
          fields.qty_tiers          !== undefined ? JSON.stringify(fields.qty_tiers) : null,
        ]
      );
      if (upd.rows.length > 0) {
        row = upd.rows[0];
      } else {
        // Não existe ainda — insere
        const ins = await db.query(
          `INSERT INTO studio_pricing_rules
             (company_id, product_id, setup_fee, labor_cost, default_margin_pct, urgency_pct, qty_tiers, is_active)
           VALUES ($1, NULL, $2, $3, $4, $5, $6::jsonb, true)
           RETURNING *`,
          [
            cid,
            fields.setup_fee          ?? 0,
            fields.labor_cost         ?? 0,
            fields.default_margin_pct ?? null,
            fields.urgency_pct        ?? 0,
            fields.qty_tiers          !== undefined ? JSON.stringify(fields.qty_tiers) : null,
          ]
        );
        row = ins.rows[0];
      }
    } else {
      // Regra por produto: WHERE product_id = $2
      const upd = await db.query(
        `UPDATE studio_pricing_rules
         SET
           setup_fee          = COALESCE($3, setup_fee),
           labor_cost         = COALESCE($4, labor_cost),
           default_margin_pct = COALESCE($5, default_margin_pct),
           urgency_pct        = COALESCE($6, urgency_pct),
           qty_tiers          = COALESCE($7::jsonb, qty_tiers),
           updated_at         = NOW()
         WHERE company_id = $1 AND product_id = $2 AND is_active = true
         RETURNING *`,
        [
          cid,
          productIdValue,
          fields.setup_fee          !== undefined ? fields.setup_fee          : null,
          fields.labor_cost         !== undefined ? fields.labor_cost         : null,
          fields.default_margin_pct !== undefined ? fields.default_margin_pct : null,
          fields.urgency_pct        !== undefined ? fields.urgency_pct        : null,
          fields.qty_tiers          !== undefined ? JSON.stringify(fields.qty_tiers) : null,
        ]
      );
      if (upd.rows.length > 0) {
        row = upd.rows[0];
      } else {
        const ins = await db.query(
          `INSERT INTO studio_pricing_rules
             (company_id, product_id, setup_fee, labor_cost, default_margin_pct, urgency_pct, qty_tiers, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true)
           RETURNING *`,
          [
            cid,
            productIdValue,
            fields.setup_fee          ?? 0,
            fields.labor_cost         ?? 0,
            fields.default_margin_pct ?? null,
            fields.urgency_pct        ?? 0,
            fields.qty_tiers          !== undefined ? JSON.stringify(fields.qty_tiers) : null,
          ]
        );
        row = ins.rows[0];
      }
    }

    return res.json(row);
  } catch (e) {
    console.error('[studioPricing] PUT /rules/:productId', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /studio/pricing/quote-line
// Calcula preço de uma linha de orçamento.
// Body: { product_id?, quantity, urgency?, overrides?: { unit_price?, unit_cost? } }
// Retorna: PricingBreakdown { unit_price, breakdown: {...} }
// ─────────────────────────────────────────────────────────────
router.post('/pricing/quote-line', async (req, res) => {
  const cid = req.params.id;
  const {
    product_id = null,
    quantity    = 1,
    urgency     = false,
    overrides   = {},
  } = req.body || {};

  const qty = Math.max(1, parseInt(quantity, 10) || 1);

  try {
    // ── 1. Custo base (BOM) ───────────────────────────────────
    let base_cost = 0;

    if (product_id) {
      // Tenta buscar o custo total da composição do produto
      try {
        const { rows: bomRows } = await db.query(
          `SELECT total_cost FROM studio_compositions_summary
           WHERE company_id = $1 AND product_id = $2
           LIMIT 1`,
          [cid, product_id]
        );
        if (bomRows.length > 0 && bomRows[0].total_cost != null) {
          base_cost = parseFloat(bomRows[0].total_cost);
        }
      } catch (bomErr) {
        // View pode não existir ainda — não é erro fatal
        console.warn('[studioPricing] compositions_summary indisponivel:', bomErr.code);
      }
    }

    // override de unit_cost tem prioridade sobre BOM
    if (overrides.unit_cost !== undefined && overrides.unit_cost !== null) {
      base_cost = parseFloat(overrides.unit_cost) || 0;
    }

    // ── 2. Regra de precificação (produto > global) ───────────
    let rule = null;

    if (product_id) {
      // Busca regra por produto e regra global, prioriza por produto
      try {
        const { rows: ruleRows } = await db.query(
          `SELECT * FROM studio_pricing_rules
           WHERE company_id = $1
             AND (product_id = $2 OR product_id IS NULL)
             AND is_active = true
           ORDER BY product_id NULLS LAST
           LIMIT 2`,
          [cid, product_id]
        );
        if (ruleRows.length > 0) {
          // Primeiro resultado: por produto (NULLS LAST); se só há global, usa global
          rule = ruleRows[0];
        }
      } catch (ruleErr) {
        console.warn('[studioPricing] erro ao buscar regra:', ruleErr.message);
      }
    } else {
      // Sem product_id: busca apenas a regra global
      try {
        const { rows: ruleRows } = await db.query(
          `SELECT * FROM studio_pricing_rules
           WHERE company_id = $1 AND product_id IS NULL AND is_active = true
           LIMIT 1`,
          [cid]
        );
        if (ruleRows.length > 0) rule = ruleRows[0];
      } catch (ruleErr) {
        console.warn('[studioPricing] erro ao buscar regra global:', ruleErr.message);
      }
    }

    // Sem regra e sem custo → retorna zeros (não é erro)
    if (!rule && base_cost === 0) {
      return res.json({
        unit_price: 0,
        breakdown: {
          base_cost:       0,
          labor:           0,
          setup:           0,
          tier_multiplier: 1,
          margin_pct:      null,
          urgency:         0,
        },
      });
    }

    const setup_fee          = rule ? parseFloat(rule.setup_fee)          || 0 : 0;
    const labor_cost         = rule ? parseFloat(rule.labor_cost)         || 0 : 0;
    const default_margin_pct = rule ? (rule.default_margin_pct != null ? parseFloat(rule.default_margin_pct) : null) : null;
    const urgency_pct        = rule ? parseFloat(rule.urgency_pct)        || 0 : 0;
    const qty_tiers          = rule ? (rule.qty_tiers || null) : null;

    // ── 3. Faixa de tiragem ────────────────────────────────────
    let tier_multiplier = 1;
    let tier_unit_price = null; // preço fixo da faixa (sobrescreve o cálculo de custo)

    if (Array.isArray(qty_tiers) && qty_tiers.length > 0) {
      const tier = qty_tiers.find((t) => {
        const inMin = qty >= (t.min_qty || 0);
        const inMax = t.max_qty == null || qty <= t.max_qty;
        return inMin && inMax;
      });
      if (tier) {
        if (tier.unit_multiplier != null) {
          tier_multiplier = parseFloat(tier.unit_multiplier) || 1;
        }
        if (tier.unit_price != null) {
          tier_unit_price = parseFloat(tier.unit_price);
        }
      }
    }

    // ── 4. Cálculo ─────────────────────────────────────────────
    const setup_per_unit = setup_fee / Math.max(qty, 1);
    const labor          = labor_cost;
    const applied_base   = base_cost * tier_multiplier;
    const cost_total     = applied_base + labor + setup_per_unit;
    const margin         = default_margin_pct ?? 0;

    let unit_price;

    if (tier_unit_price !== null) {
      // Faixa define preço fixo por unidade
      unit_price = tier_unit_price;
    } else {
      // Markup sobre custo: preço = custo / (1 - margin/100)
      // Protege divisão por zero: se margin >= 100, usa custo * 2 (100% markup)
      const divisor = margin >= 100 ? 0.5 : (1 - margin / 100);
      unit_price = cost_total / divisor;
    }

    // Urgência: acréscimo sobre o custo total (não sobre o preço final)
    const urgency_val = urgency ? cost_total * (urgency_pct / 100) : 0;
    unit_price += urgency_val;

    // Override de unit_price tem prioridade total
    if (overrides.unit_price !== undefined && overrides.unit_price !== null) {
      unit_price = parseFloat(overrides.unit_price) || 0;
    }

    return res.json({
      unit_price: parseFloat(unit_price.toFixed(2)),
      breakdown: {
        base_cost:       parseFloat(applied_base.toFixed(4)),
        labor:           parseFloat(labor.toFixed(4)),
        setup:           parseFloat(setup_per_unit.toFixed(4)),
        tier_multiplier: tier_multiplier,
        margin_pct:      default_margin_pct,
        urgency:         parseFloat(urgency_val.toFixed(4)),
      },
    });
  } catch (e) {
    console.error('[studioPricing] POST /quote-line', e.message);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
