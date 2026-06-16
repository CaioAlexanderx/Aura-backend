// ============================================================
// AURA Studio - PATCH sale_items.customization + GET /studio/products
//
// Endpoint isolado em /companies/:id/studio/sale-items/:sale_item_id/customization
// pra evitar mexer no pdv.js (45kb). Frontend PDV Studio fecha venda
// via /pdv/sale (sem customization) e depois faz PATCH em cada item
// personalizavel.
//
// Tambem expoe GET /studio/products que a rota generica /products
// nao retorna (faltam campos is_personalizable + customization_config).
//
// Trigger SQL trg_sales_studio_status (migration studio_kds_unified_view_and_trigger)
// detecta produto is_personalizable em sale_items e seta
// sales.studio_production_status='pending_art' automaticamente.
//
// 25/05/2026 - Sub-onda E do Nivel 1 Studio
// 27/05/2026 - query param include_non_personalizable pra /studio/estoque
//              listar tudo (Personalizáveis + Não personalizáveis). Default
//              continua filtrando is_personalizable=true (PDV Studio + tela
//              personalizáveis sem mudança).
// 16/06/2026 - studio_storefront_visible exposto na lista pro toggle de
//              visibilidade na Loja Virtual (configurador do produto).
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

// Visibility canonica (mesma de products.js)
function listVisibilityWhere(cidParam) {
  return `(company_id = ${cidParam} OR (
    is_group_shared = true
    AND company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

// GET /companies/:id/studio/products
// Default: lista APENAS produtos is_personalizable=true com customization_config
//          (usado pelo PDV Studio e tela personalizáveis).
// Com ?include_non_personalizable=true: lista TODOS os produtos visíveis
//          (usado pela tela master /studio/estoque pra cobrir os 3 filtros).
router.get('/products', async (req, res) => {
  const cid = req.params.id;
  const search = (req.query.search || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const includeAll = req.query.include_non_personalizable === 'true'
                  || req.query.include_non_personalizable === '1';
  try {
    const params = [cid];
    let where;
    if (includeAll) {
      // /studio/estoque: catálogo completo (todos os produtos visíveis)
      where = `WHERE is_active IS NOT FALSE
                 AND ${listVisibilityWhere('$1')}`;
    } else {
      // Default histórico: PDV Studio + tela personalizáveis (só personalizáveis)
      where = `WHERE is_active IS NOT FALSE
                 AND is_personalizable = true
                 AND customization_config IS NOT NULL
                 AND ${listVisibilityWhere('$1')}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (name ILIKE $${params.length} OR category ILIKE $${params.length})`;
    }
    params.push(limit);
    const { rows } = await db.query(
      `SELECT id, name, description, price, image_url, category, stock_qty,
              is_personalizable, customization_config, company_id, created_at,
              studio_storefront_visible
         FROM products
         ${where}
        ORDER BY name ASC
        LIMIT $${params.length}`,
      params
    );
    res.json({
      products: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description || null,
        price: parseFloat(r.price) || 0,
        image_url: r.image_url || null,
        category: r.category || null,
        stock_qty: parseFloat(r.stock_qty) || 0,
        is_personalizable: !!r.is_personalizable,
        customization_config: r.customization_config,
        studio_storefront_visible: r.studio_storefront_visible !== false,
        stock_company_id: r.company_id,
      })),
      count: rows.length,
      include_non_personalizable: includeAll,
    });
  } catch (err) {
    console.error('[studio/products] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar produtos personalizaveis' });
  }
});

// PATCH /companies/:id/studio/sale-items/:sale_item_id/customization
router.patch('/sale-items/:sale_item_id/customization', async (req, res) => {
  const cid = req.params.id;
  const saleItemId = req.params.sale_item_id;
  const customization = req.body && req.body.customization;

  if (!customization || typeof customization !== 'object') {
    return res.status(400).json({ error: 'customization (objeto JSON) obrigatorio' });
  }

  try {
    // Garante escopo da empresa: sale_item -> sale -> company_id == cid
    const { rows } = await db.query(
      `UPDATE sale_items si
          SET customization = $1::jsonb
         FROM sales s
        WHERE si.id = $2
          AND si.sale_id = s.id
          AND s.company_id = $3
        RETURNING si.id, si.sale_id, si.product_id, si.customization`,
      [JSON.stringify(customization), saleItemId, cid]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'sale_item nao encontrado nesta empresa' });
    }

    res.json({
      ok: true,
      sale_item_id: rows[0].id,
      sale_id: rows[0].sale_id,
      product_id: rows[0].product_id,
      customization: rows[0].customization,
    });
  } catch (err) {
    if (err && err.code === '42703') {
      // Coluna customization nao existe - migration studio_sale_items_customization
      // nao rodou ainda. Retorna 503 pro frontend evitar bloquear o fluxo.
      console.error('[studio/sale-items] coluna customization inexistente:', err.message);
      return res.status(503).json({
        error: 'Schema da Sub-onda E ainda nao aplicado. Aguarde alguns minutos.',
        code: 'MIGRATION_SALE_ITEMS_CUSTOMIZATION_PENDING',
      });
    }
    console.error('[studio/sale-items] PATCH error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar personalizacao do item' });
  }
});

module.exports = router;
