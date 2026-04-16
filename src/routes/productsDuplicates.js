// ============================================================
// AURA. -- Duplicatas -> Variantes (Fase A + B)
// Fase A: check-duplicate (aviso no cadastro)
// Fase B: duplicate-groups (listar) + merge-as-variants (unificar)
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// Normaliza nome pra comparacao: trim + lowercase + colapsar espacos
function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ============================================================
// GET /products/check-duplicate?name=X&exclude_id=Y
// Fase A: retorna produtos existentes com nome igual (case-insensitive)
// ============================================================
router.get('/check-duplicate', async (req, res) => {
  const cid = req.params.id;
  const name = String(req.query.name || '').trim();
  const excludeId = req.query.exclude_id || null;

  if (!name || name.length < 2) {
    return res.json({ duplicates: [], count: 0 });
  }

  try {
    const params = [cid, normalizeName(name)];
    let where = 'company_id = $1 AND LOWER(TRIM(REGEXP_REPLACE(name, \'\\s+\', \' \', \'g\'))) = $2';
    if (excludeId) {
      params.push(excludeId);
      where += ` AND id != $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT id, name, sku, barcode, color, size, price, stock_qty
       FROM products
       WHERE ${where}
       ORDER BY created_at ASC
       LIMIT 20`,
      params
    );

    res.json({
      duplicates: rows.map(r => ({
        id: r.id, name: r.name, sku: r.sku || '', barcode: r.barcode || '',
        color: r.color || '', size: r.size || '',
        price: parseFloat(r.price) || 0, stock_qty: parseInt(r.stock_qty) || 0,
      })),
      count: rows.length,
    });
  } catch (err) {
    console.error('[duplicates] check error:', err.message);
    res.status(500).json({ error: 'Erro ao verificar duplicatas' });
  }
});

// ============================================================
// GET /products/duplicate-groups
// Fase B: lista todos os grupos com 2+ produtos de mesmo nome
// ============================================================
router.get('/duplicate-groups', async (req, res) => {
  const cid = req.params.id;
  try {
    // Passo 1: detectar nomes normalizados com count >= 2
    const { rows: groups } = await db.query(
      `SELECT LOWER(TRIM(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) AS normalized_name,
              MAX(name) AS display_name,
              COUNT(*) AS product_count
       FROM products
       WHERE company_id = $1
       GROUP BY normalized_name
       HAVING COUNT(*) >= 2
       ORDER BY product_count DESC, display_name ASC`,
      [cid]
    );

    if (groups.length === 0) return res.json({ groups: [], total: 0 });

    // Passo 2: buscar produtos de cada grupo
    const normalizedNames = groups.map(g => g.normalized_name);
    const { rows: products } = await db.query(
      `SELECT id, name, sku, barcode, color, size, price, cost_price, stock_qty, created_at,
              LOWER(TRIM(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) AS normalized_name
       FROM products
       WHERE company_id = $1
         AND LOWER(TRIM(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) = ANY($2)
       ORDER BY name, created_at ASC`,
      [cid, normalizedNames]
    );

    // Passo 3: agrupar
    const byName = new Map();
    for (const p of products) {
      if (!byName.has(p.normalized_name)) byName.set(p.normalized_name, []);
      byName.get(p.normalized_name).push({
        id: p.id, name: p.name, sku: p.sku || '', barcode: p.barcode || '',
        color: p.color || '', size: p.size || '',
        price: parseFloat(p.price) || 0, cost_price: parseFloat(p.cost_price) || 0,
        stock_qty: parseInt(p.stock_qty) || 0,
        created_at: p.created_at,
      });
    }

    const groupsResponse = groups.map(g => ({
      name: g.display_name,
      normalized_name: g.normalized_name,
      count: parseInt(g.product_count),
      products: byName.get(g.normalized_name) || [],
    }));

    res.json({ groups: groupsResponse, total: groupsResponse.length });
  } catch (err) {
    console.error('[duplicates] groups error:', err.message);
    res.status(500).json({ error: 'Erro ao listar duplicatas' });
  }
});

// ============================================================
// POST /products/merge-as-variants
// Fase B: unifica N produtos em variantes de 1 produto primary
// Body: {
//   primary_id: "uuid",
//   attribute_name: "Cor" | "Tamanho" | outro,
//   variants: [
//     { product_id: "uuid", value: "Marrom" },  -- o value vira product_variant_values.value
//     ...
//   ]
// }
// ============================================================
router.post('/merge-as-variants', async (req, res) => {
  const cid = req.params.id;
  const { primary_id, attribute_name, variants } = req.body;

  if (!primary_id) return res.status(400).json({ error: 'primary_id e obrigatorio' });
  if (!attribute_name || !String(attribute_name).trim()) {
    return res.status(400).json({ error: 'attribute_name e obrigatorio (ex: Cor, Tamanho)' });
  }
  if (!Array.isArray(variants) || variants.length === 0) {
    return res.status(400).json({ error: 'variants deve ser array nao-vazio' });
  }

  const attrName = String(attribute_name).trim();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Validar primary existe e pertence a company
    const { rows: primaryRows } = await client.query(
      'SELECT id, name, price, stock_qty, barcode, color, size FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [primary_id, cid]
    );
    if (!primaryRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto primario nao encontrado' });
    }
    const primary = primaryRows[0];

    // 2. Validar todas as variantes existem e nao incluem o primary
    const secondaryIds = variants.map(v => v.product_id).filter(id => id && id !== primary_id);
    if (secondaryIds.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nenhum produto secundario valido para unificar' });
    }

    const { rows: secondaryRows } = await client.query(
      `SELECT id, name, price, stock_qty, barcode, barcode_format, color, size
       FROM products WHERE id = ANY($1) AND company_id = $2 FOR UPDATE`,
      [secondaryIds, cid]
    );
    if (secondaryRows.length !== secondaryIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'Um ou mais produtos secundarios nao encontrados',
        found: secondaryRows.length, expected: secondaryIds.length,
      });
    }

    const secondaryMap = new Map(secondaryRows.map(s => [s.id, s]));
    const variantsBody = variants.filter(v => v.product_id !== primary_id);

    // 3. Criar um product_variant pro primary (mantem estoque/barcode dele como uma variante "base")
    //    -- so cria se o primary tiver estoque ou barcode distinto
    const primaryValue = variantsBody.find(v => v.product_id === primary_id)?.value
      || (variantsBody.length > 0 && variants.find(v => v.product_id === primary_id)?.value)
      || 'Original';

    const createdVariants = [];

    // Cria variante pro proprio primary (preserva o estoque/barcode dele)
    const primaryVariantValue = variants.find(v => v.product_id === primary_id)?.value || primaryValue;
    if (primary.stock_qty > 0 || primary.barcode) {
      const { rows: pvRows } = await client.query(
        `INSERT INTO product_variants
           (product_id, sku_suffix, stock_qty, barcode, barcode_format)
         VALUES ($1, $2, $3, $4, NULL)
         RETURNING id`,
        [
          primary_id,
          (primaryVariantValue || 'V1').slice(0, 20).toUpperCase().replace(/[^A-Z0-9]/g, ''),
          parseInt(primary.stock_qty) || 0,
          primary.barcode || null,
        ]
      );
      const primaryVariantId = pvRows[0].id;
      await client.query(
        `INSERT INTO product_variant_values (variant_id, attribute_name, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (variant_id, attribute_name) DO UPDATE SET value = EXCLUDED.value`,
        [primaryVariantId, attrName, primaryVariantValue]
      );
      // Atualiza sale_items historicas do primary pra apontar tambem pra essa variante
      await client.query(
        `UPDATE sale_items SET variant_id = $1
         WHERE product_id = $2 AND variant_id IS NULL`,
        [primaryVariantId, primary_id]
      );
      createdVariants.push({ variant_id: primaryVariantId, product_id: primary_id, value: primaryVariantValue });
    }

    // 4. Pra cada secundario: criar variante vinculada ao primary, migrar historico, deletar
    for (const varBody of variantsBody) {
      const sec = secondaryMap.get(varBody.product_id);
      if (!sec) continue;

      const valueStr = String(varBody.value || '').trim() || (sec.color ? sec.color : 'Variante');

      // 4a. Criar variante
      const { rows: variantRows } = await client.query(
        `INSERT INTO product_variants
           (product_id, sku_suffix, price_override, stock_qty, barcode, barcode_format)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          primary_id,
          valueStr.slice(0, 20).toUpperCase().replace(/[^A-Z0-9]/g, ''),
          // so salva price_override se for diferente do primary
          parseFloat(sec.price) !== parseFloat(primary.price) ? parseFloat(sec.price) : null,
          parseInt(sec.stock_qty) || 0,
          sec.barcode || null,
          sec.barcode_format || null,
        ]
      );
      const newVariantId = variantRows[0].id;

      // 4b. Associar atributo
      await client.query(
        `INSERT INTO product_variant_values (variant_id, attribute_name, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (variant_id, attribute_name) DO UPDATE SET value = EXCLUDED.value`,
        [newVariantId, attrName, valueStr]
      );

      // 4c. Atualizar sale_items: referenciar o primary e a nova variante
      await client.query(
        `UPDATE sale_items
         SET product_id = $1, variant_id = $2
         WHERE product_id = $3`,
        [primary_id, newVariantId, sec.id]
      );

      // 4d. Atualizar stock_movements: apontar pro primary
      await client.query(
        `UPDATE stock_movements SET product_id = $1 WHERE product_id = $2`,
        [primary_id, sec.id]
      );

      // 4e. Deletar o produto secundario (agora sem referencias)
      await client.query(
        `DELETE FROM products WHERE id = $1 AND company_id = $2`,
        [sec.id, cid]
      );

      createdVariants.push({ variant_id: newVariantId, product_id: sec.id, value: valueStr });
    }

    // 5. Atualizar products.stock_qty do primary pra somatorio das variantes
    const { rows: sumRows } = await client.query(
      `SELECT COALESCE(SUM(stock_qty), 0) AS total
       FROM product_variants WHERE product_id = $1`,
      [primary_id]
    );
    await client.query(
      `UPDATE products SET stock_qty = $1, updated_at = NOW() WHERE id = $2`,
      [parseInt(sumRows[0].total) || 0, primary_id]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      primary_id,
      attribute_name: attrName,
      variants_created: createdVariants,
      deleted_product_ids: secondaryIds,
      new_total_stock: parseInt(sumRows[0].total) || 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[duplicates] merge error:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao unificar produtos: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
