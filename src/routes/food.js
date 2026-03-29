// ============================================================
// AURA. — Módulo Food Service
// FOOD-01: Cardápio + variações + adicionais + fotos
// FOOD-02: Ficha técnica com custo automático
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');

// Nota: requireAuth + requireCompanyAccess já aplicados em private.js
const guardFood = [requirePlan('negocio', 'expansao')];

// ── helpers ──────────────────────────────────────────────────
const notFound = (res, entity = 'Item') => res.status(404).json({ error: `${entity} não encontrado` });
const ownedBy  = async (table, id, companyId) => {
  const { rows } = await db.query(`SELECT id FROM ${table} WHERE id=$1 AND company_id=$2`, [id, companyId]);
  return rows.length > 0;
};

// ============================================================
// FOOD-01 — CARDÁPIO
// ============================================================

router.get('/menu', guardFood, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows: menus } = await db.query(
      `SELECT * FROM food_menus WHERE company_id=$1 ORDER BY created_at LIMIT 1`, [cid]
    );
    if (!menus.length) return res.json({ menu: null, categories: [], items: [] });
    const menu = menus[0];

    const { rows: categories } = await db.query(
      `SELECT * FROM food_categories WHERE menu_id=$1 AND is_active=TRUE ORDER BY sort_order`, [menu.id]
    );

    const { rows: items } = await db.query(
      `SELECT fi.*,
        COALESCE(json_agg(DISTINCT fiv.*) FILTER (WHERE fiv.id IS NOT NULL), '[]') AS variations,
        COALESCE(json_agg(DISTINCT fa.*)  FILTER (WHERE fa.id IS NOT NULL),  '[]') AS addons
       FROM food_items fi
       LEFT JOIN food_item_variations fiv ON fiv.item_id = fi.id AND fiv.is_active = TRUE
       LEFT JOIN food_addons fa ON fa.item_id = fi.id AND fa.is_active = TRUE
       WHERE fi.company_id=$1
       GROUP BY fi.id
       ORDER BY fi.sort_order`, [cid]
    );

    res.json({ menu, categories, items });
  } catch (e) {
    console.error('[food/menu] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar cardápio' });
  }
});

router.get('/menu/public/:slug', async (req, res) => {
  try {
    const { rows: menus } = await db.query(
      `SELECT fm.* FROM food_menus fm
       JOIN companies c ON c.id = fm.company_id
       WHERE fm.slug=$1 AND fm.is_active=TRUE LIMIT 1`,
      [req.params.slug]
    );
    if (!menus.length) return notFound(res, 'Cardápio');
    const menu = menus[0];

    const { rows: categories } = await db.query(
      `SELECT * FROM food_categories WHERE menu_id=$1 AND is_active=TRUE ORDER BY sort_order`, [menu.id]
    );
    const { rows: items } = await db.query(
      `SELECT fi.*,
        COALESCE(json_agg(DISTINCT fiv.*) FILTER (WHERE fiv.id IS NOT NULL), '[]') AS variations,
        COALESCE(json_agg(DISTINCT fa.*)  FILTER (WHERE fa.id IS NOT NULL),  '[]') AS addons
       FROM food_items fi
       LEFT JOIN food_item_variations fiv ON fiv.item_id=fi.id AND fiv.is_active=TRUE
       LEFT JOIN food_addons fa ON fa.item_id=fi.id AND fa.is_active=TRUE
       WHERE fi.company_id=$1 AND fi.is_active=TRUE AND fi.is_available=TRUE
       GROUP BY fi.id ORDER BY fi.sort_order`, [menu.company_id]
    );

    res.json({ menu, categories, items });
  } catch (e) {
    console.error('[food/menu/public] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar cardápio público' });
  }
});

router.post('/menu', guardFood, async (req, res) => {
  const { name, slug, description, accepts_online_orders, min_order_amount } = req.body;
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `INSERT INTO food_menus (company_id, name, slug, description, accepts_online_orders, min_order_amount)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, slug) DO UPDATE
         SET name=$2, description=$4, accepts_online_orders=$5, min_order_amount=$6, updated_at=NOW()
       RETURNING *`,
      [cid, name||'Cardápio', slug||null, description||null, accepts_online_orders||false, min_order_amount||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[food/menu] Erro ao criar:', e.message);
    res.status(500).json({ error: 'Erro ao criar cardápio' });
  }
});

// ── CATEGORIAS ───────────────────────────────────────────────
router.post('/categories', guardFood, async (req, res) => {
  const { menu_id, name, sort_order } = req.body;
  if (!menu_id || !name) return res.status(400).json({ error: 'menu_id e name obrigatórios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO food_categories (menu_id, company_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
      [menu_id, req.params.id, name, sort_order||0]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[food/categories] Erro ao criar:', e.message);
    res.status(500).json({ error: 'Erro ao criar categoria' });
  }
});

router.patch('/categories/:cid', guardFood, async (req, res) => {
  const { name, sort_order, is_active } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE food_categories SET
         name=COALESCE($1,name), sort_order=COALESCE($2,sort_order), is_active=COALESCE($3,is_active)
       WHERE id=$4 AND company_id=$5 RETURNING *`,
      [name, sort_order, is_active, req.params.cid, req.params.id]
    );
    if (!rows.length) return notFound(res, 'Categoria');
    res.json(rows[0]);
  } catch (e) {
    console.error('[food/categories] Erro ao atualizar:', e.message);
    res.status(500).json({ error: 'Erro ao atualizar categoria' });
  }
});

// ── ITENS ─────────────────────────────────────────────────────
router.post('/items', guardFood, async (req, res) => {
  const { category_id, name, description, price, photo_url, preparation_time_min, serves, tags, sort_order } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name e price obrigatórios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO food_items
         (company_id, category_id, name, description, price, photo_url, preparation_time_min, serves, tags, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.id, category_id||null, name, description||null, price,
       photo_url||null, preparation_time_min||null, serves||1, tags||null, sort_order||0]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[food/items] Erro ao criar:', e.message);
    res.status(500).json({ error: 'Erro ao criar item' });
  }
});

router.patch('/items/:iid', guardFood, async (req, res) => {
  const fields = ['category_id','name','description','price','photo_url',
                  'is_active','is_available','preparation_time_min','serves','tags','sort_order'];
  const updates = [];
  const vals = [];
  let idx = 1;
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f}=$${idx++}`); vals.push(req.body[f]); }
  });
  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push(`updated_at=NOW()`);
  vals.push(req.params.iid, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE food_items SET ${updates.join(',')} WHERE id=$${idx} AND company_id=$${idx+1} RETURNING *`, vals
    );
    if (!rows.length) return notFound(res);
    res.json(rows[0]);
  } catch (e) {
    console.error('[food/items] Erro ao atualizar:', e.message);
    res.status(500).json({ error: 'Erro ao atualizar item' });
  }
});

router.delete('/items/:iid', guardFood, async (req, res) => {
  try {
    await db.query(`UPDATE food_items SET is_active=FALSE WHERE id=$1 AND company_id=$2`,
      [req.params.iid, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[food/items] Erro ao remover:', e.message);
    res.status(500).json({ error: 'Erro ao remover item' });
  }
});

// ── VARIAÇÕES ────────────────────────────────────────────────
router.post('/items/:iid/variations', guardFood, async (req, res) => {
  const { name, price_delta, is_required, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'name obrigatório' });
  if (!(await ownedBy('food_items', req.params.iid, req.params.id)))
    return notFound(res, 'Item');
  try {
    const { rows } = await db.query(
      `INSERT INTO food_item_variations (item_id, company_id, name, price_delta, is_required, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.iid, req.params.id, name, price_delta||0, is_required||false, sort_order||0]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[food/variations] Erro ao criar:', e.message);
    res.status(500).json({ error: 'Erro ao criar variação' });
  }
});

router.delete('/items/:iid/variations/:vid', guardFood, async (req, res) => {
  try {
    await db.query(`UPDATE food_item_variations SET is_active=FALSE WHERE id=$1 AND company_id=$2`,
      [req.params.vid, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[food/variations] Erro ao remover:', e.message);
    res.status(500).json({ error: 'Erro ao remover variação' });
  }
});

// ── ADICIONAIS ───────────────────────────────────────────────
router.post('/addons', guardFood, async (req, res) => {
  const { item_id, name, price, max_qty } = req.body;
  if (!name) return res.status(400).json({ error: 'name obrigatório' });
  try {
    const { rows } = await db.query(
      `INSERT INTO food_addons (company_id, item_id, name, price, max_qty)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, item_id||null, name, price||0, max_qty||1]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[food/addons] Erro ao criar:', e.message);
    res.status(500).json({ error: 'Erro ao criar adicional' });
  }
});

// ── MESAS ────────────────────────────────────────────────────
router.get('/tables', guardFood, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM food_tables WHERE company_id=$1 ORDER BY number`, [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/tables] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar mesas' });
  }
});

router.post('/tables', guardFood, async (req, res) => {
  const { number, seats } = req.body;
  if (!number) return res.status(400).json({ error: 'number obrigatório' });
  try {
    const { rows } = await db.query(
      `INSERT INTO food_tables (company_id, number, seats) VALUES ($1,$2,$3)
       ON CONFLICT (company_id, number) DO UPDATE SET seats=$3 RETURNING *`,
      [req.params.id, number, seats||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[food/tables] Erro ao criar:', e.message);
    res.status(500).json({ error: 'Erro ao criar mesa' });
  }
});

router.patch('/tables/:tid/status', guardFood, async (req, res) => {
  const { status } = req.body;
  if (!['free','occupied','reserved'].includes(status))
    return res.status(400).json({ error: 'status inválido' });
  try {
    const { rows } = await db.query(
      `UPDATE food_tables SET status=$1 WHERE id=$2 AND company_id=$3 RETURNING *`,
      [status, req.params.tid, req.params.id]
    );
    if (!rows.length) return notFound(res, 'Mesa');
    res.json(rows[0]);
  } catch (e) {
    console.error('[food/tables] Erro ao atualizar:', e.message);
    res.status(500).json({ error: 'Erro ao atualizar mesa' });
  }
});

// ============================================================
// FOOD-02 — FICHA TÉCNICA (custo automático)
// ============================================================

router.get('/items/:iid/recipe', guardFood, async (req, res) => {
  if (!(await ownedBy('food_items', req.params.iid, req.params.id)))
    return notFound(res, 'Item');
  try {
    const { rows: ingredients } = await db.query(
      `SELECT fr.*, p.name AS product_name, p.cost_price AS stock_unit_cost
       FROM food_recipes fr
       LEFT JOIN products p ON p.id = fr.product_id
       WHERE fr.item_id=$1 ORDER BY fr.created_at`,
      [req.params.iid]
    );
    const totalCost = ingredients.reduce((sum, r) => sum + (parseFloat(r.unit_cost) * parseFloat(r.quantity)), 0);

    const { rows: items } = await db.query(
      `SELECT price, name FROM food_items WHERE id=$1`, [req.params.iid]
    );
    const item = items[0];
    const marginPct = item && item.price > 0
      ? ((item.price - totalCost) / item.price * 100).toFixed(1)
      : null;

    res.json({
      item_id: req.params.iid,
      item_name: item?.name,
      sale_price: item?.price,
      total_cost: parseFloat(totalCost.toFixed(4)),
      margin_pct: marginPct ? parseFloat(marginPct) : null,
      margin_alert: marginPct !== null && parseFloat(marginPct) < 30,
      ingredients
    });
  } catch (e) {
    console.error('[food/recipe] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar ficha técnica' });
  }
});

router.post('/items/:iid/recipe', guardFood, async (req, res) => {
  const { ingredient_name, unit, quantity, unit_cost, product_id, notes } = req.body;
  if (!ingredient_name || quantity == null || unit_cost == null)
    return res.status(400).json({ error: 'ingredient_name, quantity e unit_cost obrigatórios' });
  if (!(await ownedBy('food_items', req.params.iid, req.params.id)))
    return notFound(res, 'Item');
  try {
    const { rows } = await db.query(
      `INSERT INTO food_recipes (item_id, company_id, ingredient_name, unit, quantity, unit_cost, product_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.iid, req.params.id, ingredient_name, unit||'un',
       quantity, unit_cost, product_id||null, notes||null]
    );
    await _recalcItemCost(req.params.iid);
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[food/recipe] Erro ao adicionar ingrediente:', e.message);
    res.status(500).json({ error: 'Erro ao adicionar ingrediente' });
  }
});

router.put('/items/:iid/recipe/:rid', guardFood, async (req, res) => {
  const { ingredient_name, unit, quantity, unit_cost, product_id, notes } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE food_recipes SET
         ingredient_name=COALESCE($1,ingredient_name), unit=COALESCE($2,unit),
         quantity=COALESCE($3,quantity), unit_cost=COALESCE($4,unit_cost),
         product_id=COALESCE($5,product_id), notes=COALESCE($6,notes), updated_at=NOW()
       WHERE id=$7 AND item_id=$8 AND company_id=$9 RETURNING *`,
      [ingredient_name, unit, quantity, unit_cost, product_id, notes,
       req.params.rid, req.params.iid, req.params.id]
    );
    if (!rows.length) return notFound(res, 'Ingrediente');
    await _recalcItemCost(req.params.iid);
    res.json(rows[0]);
  } catch (e) {
    console.error('[food/recipe] Erro ao atualizar ingrediente:', e.message);
    res.status(500).json({ error: 'Erro ao atualizar ingrediente' });
  }
});

router.delete('/items/:iid/recipe/:rid', guardFood, async (req, res) => {
  try {
    await db.query(`DELETE FROM food_recipes WHERE id=$1 AND item_id=$2 AND company_id=$3`,
      [req.params.rid, req.params.iid, req.params.id]);
    await _recalcItemCost(req.params.iid);
    res.json({ ok: true });
  } catch (e) {
    console.error('[food/recipe] Erro ao remover ingrediente:', e.message);
    res.status(500).json({ error: 'Erro ao remover ingrediente' });
  }
});

async function _recalcItemCost(itemId) {
  const { rows } = await db.query(
    `SELECT SUM(quantity * unit_cost) AS total FROM food_recipes WHERE item_id=$1`, [itemId]
  );
  const cost = rows[0]?.total || 0;
  await db.query(`UPDATE food_items SET cost_price=$1, updated_at=NOW() WHERE id=$2`, [cost, itemId]);
  return cost;
}

router.get('/recipes/summary', guardFood, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT fi.id, fi.name, fi.price,
         COALESCE(fi.cost_price, 0) AS cost_price,
         CASE WHEN fi.price > 0
           THEN ROUND(((fi.price - COALESCE(fi.cost_price,0)) / fi.price * 100)::NUMERIC, 1)
           ELSE NULL END AS margin_pct,
         (SELECT COUNT(*) FROM food_recipes fr WHERE fr.item_id = fi.id) AS ingredient_count
       FROM food_items fi
       WHERE fi.company_id=$1 AND fi.is_active=TRUE
       ORDER BY margin_pct ASC NULLS LAST`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/recipes/summary] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar resumo de fichas técnicas' });
  }
});

// ── ZONAS DE ENTREGA ─────────────────────────────────────────
router.get('/delivery/zones', guardFood, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM food_delivery_zones WHERE company_id=$1 ORDER BY name`, [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/delivery/zones] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar zonas de entrega' });
  }
});

router.post('/delivery/zones', guardFood, async (req, res) => {
  const { name, fee, min_time_min, max_time_min } = req.body;
  if (!name) return res.status(400).json({ error: 'name obrigatório' });
  try {
    const { rows } = await db.query(
      `INSERT INTO food_delivery_zones (company_id, name, fee, min_time_min, max_time_min)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, name, fee||0, min_time_min||null, max_time_min||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[food/delivery/zones] Erro ao criar:', e.message);
    res.status(500).json({ error: 'Erro ao criar zona de entrega' });
  }
});

module.exports = router;
