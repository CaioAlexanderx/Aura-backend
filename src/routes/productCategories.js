// ============================================================
// AURA. -- Product/Service Categories CRUD
// Gerencia categorias cadastradas por empresa, separadas por
// type = 'product' | 'service'. Produtos e servicos continuam
// gravando `category` como texto (compat). Em rename, cascade
// update nos registros com (unit != 'srv' ou unit = 'srv') de
// acordo com o type. Em delete, permite ?move_to=Nome.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

function normalizeType(t) {
  const v = String(t || '').toLowerCase().trim();
  return v === 'service' ? 'service' : 'product';
}

// GET /product-categories?type=product|service
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const type = normalizeType(req.query.type);
  try {
    // product_count usa o tipo correto:
    //  - product: products.unit != 'srv' AND products.category = c.name
    //  - service: products.unit  = 'srv' AND products.category = c.name
    const countExpr = type === 'service'
      ? `(SELECT COUNT(*)::int FROM products p
           WHERE p.company_id = c.company_id
             AND p.category = c.name
             AND p.unit = 'srv')`
      : `(SELECT COUNT(*)::int FROM products p
           WHERE p.company_id = c.company_id
             AND p.category = c.name
             AND (p.unit IS NULL OR p.unit <> 'srv'))`;

    const { rows } = await db.query(
      `SELECT
         c.id, c.name, c.color, c.sort_order, c.type,
         c.created_at, c.updated_at,
         ${countExpr} AS product_count
       FROM product_categories c
       WHERE c.company_id = $1 AND c.type = $2
       ORDER BY c.sort_order ASC, c.name ASC`,
      [cid, type]
    );
    res.json({ categories: rows, total: rows.length, type });
  } catch (err) {
    console.error('[productCategories] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar categorias' });
  }
});

// POST /product-categories
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { name, color, sort_order } = req.body;
  const type = normalizeType(req.body.type);

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }
  const cleanName = String(name).trim().slice(0, 80);
  const hex = color && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : null;
  try {
    const { rows } = await db.query(
      `INSERT INTO product_categories (company_id, name, color, sort_order, type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, color, sort_order, type, created_at`,
      [cid, cleanName, hex, parseInt(sort_order) || 0, type]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ja existe uma categoria com esse nome' });
    }
    console.error('[productCategories] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar categoria' });
  }
});

// PATCH /product-categories/:catId
router.patch('/:catId', async (req, res) => {
  const { id: cid, catId } = req.params;
  const { name, color, sort_order } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query(
      'SELECT name, type FROM product_categories WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [catId, cid]
    );
    if (!existingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Categoria nao encontrada' });
    }
    const oldName = existingRows[0].name;
    const rowType = existingRows[0].type || 'product';

    const updates = [];
    const values = [];
    let idx = 1;
    let newName = oldName;

    if (name !== undefined && String(name).trim() && String(name).trim() !== oldName) {
      newName = String(name).trim().slice(0, 80);
      updates.push(`name = $${idx++}`);
      values.push(newName);
    }
    if (color !== undefined) {
      const hex = color && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : null;
      updates.push(`color = $${idx++}`);
      values.push(hex);
    }
    if (sort_order !== undefined) {
      updates.push(`sort_order = $${idx++}`);
      values.push(parseInt(sort_order) || 0);
    }

    if (!updates.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    updates.push('updated_at = NOW()');
    values.push(catId, cid);

    const { rows } = await client.query(
      `UPDATE product_categories SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx++}
       RETURNING id, name, color, sort_order, type, updated_at`,
      values
    );

    // Cascade: se o nome mudou, atualiza products.category SOMENTE no tipo correto
    let affectedProducts = 0;
    if (newName !== oldName) {
      const unitFilter = rowType === 'service' ? `p.unit = 'srv'` : `(p.unit IS NULL OR p.unit <> 'srv')`;
      const upRes = await client.query(
        `UPDATE products p
            SET category = $1, updated_at = NOW()
          WHERE p.company_id = $2
            AND p.category = $3
            AND ${unitFilter}`,
        [newName, cid, oldName]
      );
      affectedProducts = upRes.rowCount || 0;
    }

    await client.query('COMMIT');
    res.json({ ...rows[0], affected_products: affectedProducts });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ja existe uma categoria com esse nome' });
    }
    console.error('[productCategories] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar categoria' });
  } finally {
    client.release();
  }
});

// DELETE /product-categories/:catId
router.delete('/:catId', async (req, res) => {
  const { id: cid, catId } = req.params;
  const moveTo = req.query.move_to ? String(req.query.move_to).trim() : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query(
      'SELECT name, type FROM product_categories WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [catId, cid]
    );
    if (!existingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Categoria nao encontrada' });
    }
    const oldName = existingRows[0].name;
    const rowType = existingRows[0].type || 'product';

    let movedProducts = 0;
    if (moveTo) {
      // valida destino existe no mesmo tipo
      const { rows: destRows } = await client.query(
        'SELECT name FROM product_categories WHERE company_id = $1 AND name = $2 AND type = $3',
        [cid, moveTo, rowType]
      );
      if (!destRows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Categoria destino nao encontrada no mesmo tipo' });
      }
      const unitFilter = rowType === 'service' ? `p.unit = 'srv'` : `(p.unit IS NULL OR p.unit <> 'srv')`;
      const upRes = await client.query(
        `UPDATE products p
            SET category = $1, updated_at = NOW()
          WHERE p.company_id = $2
            AND p.category = $3
            AND ${unitFilter}`,
        [moveTo, cid, oldName]
      );
      movedProducts = upRes.rowCount || 0;
    }

    await client.query(
      'DELETE FROM product_categories WHERE id = $1 AND company_id = $2',
      [catId, cid]
    );

    await client.query('COMMIT');
    res.json({ deleted: true, id: catId, moved_products: movedProducts, type: rowType });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[productCategories] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao excluir categoria' });
  } finally {
    client.release();
  }
});

module.exports = router;
