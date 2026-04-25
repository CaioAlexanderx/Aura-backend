// ============================================================
// AURA. — GAP-03: Estoque de Materiais Odontológicos
// Mounted at: /dental/supplies (Negócio+)
//
// Reutiliza a estrutura existente de produtos:
//   - Tabela: products (is_dental_supply = true)
//   - Movimentações: stock_movements (sem alteração)
//   - Ranking/alertas: queries sobre stock_qty vs stock_min
//
// Categorias dentais:
//   anestesico | resina | fio | broca | descartavel |
//   material_restaurador | material_protecao | rx | equipamento | outro
// ============================================================

const express = require('express');
const db      = require('../config/database');

const router = express.Router({ mergeParams: true });

const DENTAL_CATEGORIES = [
  'anestesico', 'resina', 'fio', 'broca', 'descartavel',
  'material_restaurador', 'material_protecao', 'rx', 'equipamento', 'outro',
];

// ─────────────────────────────────────────────────────────────
// GET /dental/supplies
// Lista materiais odontológicos com alertas de estoque/validade
// Query: category, search, alert (low_stock | expiring), page, limit
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { companyId } = req;
  const { category, search, alert, page = 1, limit = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const conditions = [
    'p.company_id = $1',
    'p.is_dental_supply = true',
    'p.is_active = true',
  ];
  const params = [companyId];
  let idx = 2;

  if (category) { conditions.push(`p.dental_category = $${idx++}`); params.push(category); }
  if (search)   { conditions.push(`p.name ILIKE $${idx++}`); params.push(`%${search}%`); }

  // Filtros de alerta
  if (alert === 'low_stock')  conditions.push('p.stock_qty <= p.stock_min AND p.stock_min > 0');
  if (alert === 'expiring')   conditions.push(`p.expiry_date IS NOT NULL AND p.expiry_date <= NOW() + INTERVAL '30 days'`);
  if (alert === 'expired')    conditions.push(`p.expiry_date IS NOT NULL AND p.expiry_date < CURRENT_DATE`);

  const where = conditions.join(' AND ');

  try {
    const { rows } = await db.query(
      `SELECT
          p.id, p.name, p.description, p.dental_category,
          p.unit, p.cost_price, p.supplier_name,
          p.stock_qty, p.stock_min, p.stock_max,
          p.expiry_date, p.lot_number,
          p.created_at, p.updated_at,
          -- flags de alerta calculados
          CASE WHEN p.stock_min > 0 AND p.stock_qty <= p.stock_min THEN true ELSE false END AS low_stock,
          CASE WHEN p.expiry_date IS NOT NULL AND p.expiry_date < CURRENT_DATE THEN true ELSE false END AS expired,
          CASE WHEN p.expiry_date IS NOT NULL
                AND p.expiry_date >= CURRENT_DATE
                AND p.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
               THEN true ELSE false END AS expiring_soon,
          -- dias para vencer
          CASE WHEN p.expiry_date IS NOT NULL
               THEN (p.expiry_date - CURRENT_DATE)
               ELSE NULL END AS days_to_expiry,
          -- última movimentação
          (SELECT sm.created_at FROM stock_movements sm
            WHERE sm.product_id = p.id
            ORDER BY sm.created_at DESC LIMIT 1) AS last_movement_at
        FROM products p
       WHERE ${where}
       ORDER BY
          -- alertas críticos primeiro
          (p.stock_min > 0 AND p.stock_qty <= p.stock_min) DESC,
          (p.expiry_date IS NOT NULL AND p.expiry_date <= CURRENT_DATE + INTERVAL '30 days') DESC,
          p.name ASC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, Number(limit), offset]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM products p WHERE ${where}`,
      params
    );

    // Totais de alerta (para badges da aba)
    const { rows: alertRows } = await db.query(
      `SELECT
          COUNT(*) FILTER (WHERE stock_min > 0 AND stock_qty <= stock_min) AS low_stock,
          COUNT(*) FILTER (WHERE expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE) AS expired,
          COUNT(*) FILTER (WHERE expiry_date IS NOT NULL
                            AND expiry_date >= CURRENT_DATE
                            AND expiry_date <= CURRENT_DATE + INTERVAL '30 days') AS expiring_soon
       FROM products
       WHERE company_id = $1 AND is_dental_supply = true AND is_active = true`,
      [companyId]
    );

    res.json({
      supplies: rows,
      total:    Number(countRows[0].total),
      page:     Number(page),
      limit:    Number(limit),
      alerts:   alertRows[0],
    });
  } catch (err) {
    console.error('GET /dental/supplies', err);
    res.status(500).json({ error: 'Erro ao buscar materiais' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /dental/supplies
// Cria material odontológico (produto com is_dental_supply=true)
// Campos simplificados — sem price, barcode, variants
// ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { companyId } = req;
  const {
    name, description, dental_category, unit,
    cost_price, supplier_name,
    stock_qty, stock_min, stock_max,
    expiry_date, lot_number,
  } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'name obrigatório' });
  if (dental_category && !DENTAL_CATEGORIES.includes(dental_category)) {
    return res.status(400).json({ error: `dental_category inválida. Use: ${DENTAL_CATEGORIES.join(', ')}` });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO products
         (company_id, name, description, category, dental_category,
          unit, cost_price, supplier_name,
          stock_qty, stock_min, stock_max,
          expiry_date, lot_number,
          is_dental_supply, is_active, price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,true,0)
       RETURNING *`,
      [
        companyId,
        name.trim(),
        description || null,
        dental_category || 'outro',       // category = dental_category (compatibilidade)
        dental_category || 'outro',
        unit || 'un',
        cost_price || 0,
        supplier_name || null,
        stock_qty || 0,
        stock_min || 0,
        stock_max || null,
        expiry_date || null,
        lot_number || null,
      ]
    );

    // Registra movimentação inicial se stock_qty > 0
    if (stock_qty && Number(stock_qty) > 0) {
      await client.query(
        `INSERT INTO stock_movements (product_id, company_id, type, quantity, notes)
         VALUES ($1, $2, 'entrada', $3, 'Estoque inicial')`,
        [rows[0].id, companyId, Number(stock_qty)]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ supply: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /dental/supplies', err);
    res.status(500).json({ error: 'Erro ao criar material' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────
// GET /dental/supplies/categories
// Lista categorias disponíveis com contagens
// ─────────────────────────────────────────────────────────────
router.get('/categories', async (req, res) => {
  const { companyId } = req;
  try {
    const { rows } = await db.query(
      `SELECT
          dental_category AS category,
          COUNT(*)        AS total,
          COUNT(*) FILTER (WHERE stock_min > 0 AND stock_qty <= stock_min) AS low_stock_count
        FROM products
       WHERE company_id = $1 AND is_dental_supply = true AND is_active = true
       GROUP BY dental_category
       ORDER BY total DESC`,
      [companyId]
    );

    // Inclui todas as categorias (mesmo as vazias)
    const map = {};
    DENTAL_CATEGORIES.forEach(c => { map[c] = { category: c, total: 0, low_stock_count: 0 }; });
    rows.forEach((r) => { if (r.category) map[r.category] = r; });

    res.json({ categories: Object.values(map) });
  } catch (err) {
    console.error('GET /dental/supplies/categories', err);
    res.status(500).json({ error: 'Erro ao buscar categorias' });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /dental/supplies/:id
// Atualiza dados do material (não movimenta estoque)
// ─────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const { companyId } = req;
  const { id } = req.params;
  const {
    name, description, dental_category, unit,
    cost_price, supplier_name,
    stock_min, stock_max,
    expiry_date, lot_number,
  } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE products
          SET name            = COALESCE($3, name),
              description     = COALESCE($4, description),
              dental_category = COALESCE($5, dental_category),
              category        = COALESCE($5, category),
              unit            = COALESCE($6, unit),
              cost_price      = COALESCE($7, cost_price),
              supplier_name   = COALESCE($8, supplier_name),
              stock_min       = COALESCE($9,  stock_min),
              stock_max       = COALESCE($10, stock_max),
              expiry_date     = COALESCE($11, expiry_date),
              lot_number      = COALESCE($12, lot_number),
              updated_at      = NOW()
        WHERE id = $1 AND company_id = $2 AND is_dental_supply = true
        RETURNING *`,
      [id, companyId, name || null, description || null, dental_category || null,
       unit || null, cost_price ?? null, supplier_name || null,
       stock_min ?? null, stock_max ?? null, expiry_date || null, lot_number || null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Material não encontrado' });
    res.json({ supply: rows[0] });
  } catch (err) {
    console.error('PATCH /dental/supplies/:id', err);
    res.status(500).json({ error: 'Erro ao atualizar material' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /dental/supplies/:id/movement
// Movimenta estoque: entrada | saida | ajuste
// Reutiliza stock_movements (mesma tabela do PDV)
// ─────────────────────────────────────────────────────────────
router.post('/:id/movement', async (req, res) => {
  const { companyId } = req;
  const { id } = req.params;
  const { type, quantity, notes } = req.body;

  if (!['entrada', 'saida', 'ajuste'].includes(type)) {
    return res.status(400).json({ error: 'type deve ser: entrada, saida ou ajuste' });
  }
  const qty = Number(quantity);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'quantity deve ser positivo' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica posse e busca estoque atual
    const { rows: prodRows } = await client.query(
      'SELECT id, stock_qty, name FROM products WHERE id=$1 AND company_id=$2 AND is_dental_supply=true',
      [id, companyId]
    );
    if (prodRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Material não encontrado' });
    }

    const currentQty = Number(prodRows[0].stock_qty);
    let newQty;

    if (type === 'ajuste') {
      newQty = qty;  // ajuste define o valor absoluto
    } else if (type === 'saida') {
      newQty = Math.max(0, currentQty - qty);
    } else {
      newQty = currentQty + qty;
    }

    // Atualiza stock_qty no produto
    await client.query(
      'UPDATE products SET stock_qty = $1, updated_at = NOW() WHERE id = $2',
      [newQty, id]
    );

    // Registra movimentação
    const movQty = type === 'ajuste' ? (newQty - currentQty) : (type === 'saida' ? -qty : qty);
    const { rows: movRows } = await client.query(
      `INSERT INTO stock_movements (product_id, company_id, type, quantity, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, companyId, type, Math.abs(movQty), notes || null]
    );

    await client.query('COMMIT');
    res.json({
      movement:       movRows[0],
      stock_qty_prev: currentQty,
      stock_qty_new:  newQty,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /dental/supplies/:id/movement', err);
    res.status(500).json({ error: 'Erro ao movimentar estoque' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────
// GET /dental/supplies/:id/movements
// Histórico de movimentações de um material
// ─────────────────────────────────────────────────────────────
router.get('/:id/movements', async (req, res) => {
  const { companyId } = req;
  const { id } = req.params;
  const { limit = 30 } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT sm.*, p.name AS product_name
         FROM stock_movements sm
         JOIN products p ON p.id = sm.product_id
        WHERE sm.product_id = $1 AND sm.company_id = $2
        ORDER BY sm.created_at DESC
        LIMIT $3`,
      [id, companyId, Number(limit)]
    );
    res.json({ movements: rows });
  } catch (err) {
    console.error('GET /dental/supplies/:id/movements', err);
    res.status(500).json({ error: 'Erro ao buscar movimentações' });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /dental/supplies/:id
// Soft-delete (is_active = false)
// ─────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const { companyId } = req;
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      `UPDATE products SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND is_dental_supply = true
        RETURNING id`,
      [id, companyId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Material não encontrado' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /dental/supplies/:id', err);
    res.status(500).json({ error: 'Erro ao remover material' });
  }
});

module.exports = router;
