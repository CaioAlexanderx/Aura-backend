// ============================================================
// AURA Studio - PATCH sale_items.customization (Sub-onda E)
//
// Endpoint isolado em /companies/:id/studio/sale-items/:sale_item_id/customization
// pra evitar mexer no pdv.js (45kb). Frontend PDV Studio fecha venda
// via /pdv/sale (sem customization) e depois faz PATCH em cada item
// personalizavel.
//
// Trigger SQL trg_sales_studio_status (migration studio_kds_unified_view_and_trigger)
// detecta produto is_personalizable em sale_items e seta
// sales.studio_production_status='pending_art' automaticamente.
//
// 25/05/2026 - Sub-onda E do Nivel 1 Studio
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

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
      // Coluna customization nao existe — migration studio_sale_items_customization
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
