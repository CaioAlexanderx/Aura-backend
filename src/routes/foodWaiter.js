// ============================================================
// AURA. — FOOD-07: App Garcom (rotas AUTENTICADAS)
// API para PWA mobile do garcom (montado em /companies/:id/food/waiter).
// ============================================================
// As rotas PUBLICAS (/public/:tableId/menu|order|call) foram movidas
// para foodWaiterPublic.js — necessario porque o mesmo arquivo era
// montado em DUAS rotas e quebrava o guard de plano no mount publico.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');

// Nota: requireAuth + requireCompanyAccess ja aplicados em private.js
const guard = [requirePlan('negocio', 'expansao')];

// ── ROTAS AUTENTICADAS (App Garcom interno) ──────────────────

router.get('/tables', guard, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        ft.*,
        COUNT(fo.id) FILTER (
          WHERE fo.status NOT IN ('delivered','cancelled')
        ) AS active_orders,
        COALESCE(SUM(fo.total) FILTER (
          WHERE fo.status NOT IN ('delivered','cancelled')
        ), 0) AS open_total,
        (SELECT reason FROM food_waiter_calls wc
         WHERE wc.table_id=ft.id AND wc.status='pending'
         ORDER BY wc.created_at DESC LIMIT 1) AS pending_call
      FROM food_tables ft
      LEFT JOIN food_orders fo ON fo.table_id = ft.id
      WHERE ft.company_id = $1
      GROUP BY ft.id
      ORDER BY ft.number`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { console.error('[food/waiter/tables]', e.message); res.status(500).json({ error: 'Erro ao buscar mesas' }); }
});

router.get('/menu', guard, async (req, res) => {
  try {
    const { rows: categories } = await db.query(
      `SELECT fc.*
       FROM food_categories fc
       JOIN food_menus fm ON fm.id = fc.menu_id
       WHERE fm.company_id=$1 AND fc.is_active=TRUE
       ORDER BY fc.sort_order`,
      [req.params.id]
    );
    const { rows: items } = await db.query(
      `SELECT fi.*,
         COALESCE(json_agg(DISTINCT fiv.*) FILTER (WHERE fiv.id IS NOT NULL), '[]') AS variations,
         COALESCE(json_agg(DISTINCT fa.*) FILTER (WHERE fa.id IS NOT NULL), '[]') AS addons
       FROM food_items fi
       LEFT JOIN food_item_variations fiv ON fiv.item_id=fi.id AND fiv.is_active=TRUE
       LEFT JOIN food_addons fa ON fa.item_id=fi.id AND fa.is_active=TRUE
       WHERE fi.company_id=$1 AND fi.is_active=TRUE AND fi.is_available=TRUE
       GROUP BY fi.id ORDER BY fi.sort_order`,
      [req.params.id]
    );
    res.json({ categories, items });
  } catch (e) { console.error('[food/waiter/menu]', e.message); res.status(500).json({ error: 'Erro ao buscar cardapio' }); }
});

router.get('/calls', guard, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT wc.*, ft.number AS table_number
      FROM food_waiter_calls wc
      JOIN food_tables ft ON ft.id = wc.table_id
      WHERE wc.company_id=$1 AND wc.status='pending'
      ORDER BY wc.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { console.error('[food/waiter/calls]', e.message); res.status(500).json({ error: 'Erro ao buscar chamadas' }); }
});

router.patch('/calls/:callId/answer', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE food_waiter_calls
       SET status='answered', answered_by=$1, answered_at=NOW()
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [req.user?.id||null, req.params.callId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Chamada nao encontrada' });
    res.json(rows[0]);
  } catch (e) { console.error('[food/waiter/calls]', e.message); res.status(500).json({ error: 'Erro ao responder chamada' }); }
});

router.post('/orders', guard, async (req, res) => {
  const { table_id } = req.body;
  if (table_id) {
    const { rows } = await db.query(
      `SELECT id FROM food_tables WHERE id=$1 AND company_id=$2`,
      [table_id, req.params.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'Mesa nao pertence a esta empresa' });
  }
  req.body.channel = req.body.channel || 'presencial';
  res.status(501).json({
    message: 'Use POST /companies/:id/food/orders — este endpoint e um alias documentado.',
    forward_to: `/companies/${req.params.id}/food/orders`,
  });
});

module.exports = router;
