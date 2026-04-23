// ============================================================
// AURA. — Variantes de Produto (BE-16)
// P0 #11: SKU optional (auto-generated), attributes optional
// Tarefa A: quick-batch endpoint pra "+" inline no AddProductForm
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const pool    = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

async function checkProductOwnership(company_id, product_id) {
  const { rows } = await pool.query(
    'SELECT id FROM products WHERE id = $1 AND company_id = $2',
    [product_id, company_id]
  );
  return rows.length > 0;
}

// Helper: assina o conjunto de atributos pra deteccao de duplicata.
// "Cor:Azul|Tamanho:M" (sorted, normalizado). Match case-insensitive.
function signatureFromAttrs(attrs) {
  if (!attrs || attrs.length === 0) return '';
  return attrs
    .filter(a => a.attribute && a.value)
    .map(a => a.attribute.toLowerCase().trim() + ':' + a.value.toLowerCase().trim())
    .sort()
    .join('|');
}

// Helper: extrai atributos "naturais" do produto pai (color, size).
// Retorna lista [{attribute, value}]. Se color tem hex, vira "Branco (#fff)".
function extractParentAttributes(product) {
  const attrs = [];
  if (product.color && /^#[0-9a-f]{6}$/i.test(product.color)) {
    // Cor sem nome — usa "Cor base" como label
    attrs.push({ attribute: 'Cor', value: 'Cor base (' + product.color + ')' });
  }
  if (product.size && product.size.trim()) {
    attrs.push({ attribute: 'Tamanho', value: product.size.trim() });
  }
  return attrs;
}

// Helper: gera SKU a partir de atributos. Mesma logica do POST /
function makeSkuFromAttrs(attrs, fallbackIdx) {
  if (attrs && attrs.length > 0) {
    return attrs.map(a => (a.value || '').slice(0, 6).toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '')).join('-');
  }
  return 'V' + fallbackIdx;
}

// GET /companies/:id/products/:pid/variants
router.get('/', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  try {
    if (!await checkProductOwnership(company_id, product_id)) {
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }
    const { rows } = await pool.query(
      `SELECT
         v.id, v.sku_suffix, v.price_override, v.stock_qty,
         v.barcode, v.barcode_format, v.is_active,
         v.created_at, v.updated_at,
         JSON_AGG(
           JSON_BUILD_OBJECT('attribute', vv.attribute_name, 'value', vv.value)
           ORDER BY vv.attribute_name
         ) FILTER (WHERE vv.id IS NOT NULL) AS attributes
       FROM product_variants v
       LEFT JOIN product_variant_values vv ON vv.variant_id = v.id
       WHERE v.product_id = $1
       GROUP BY v.id
       ORDER BY v.created_at ASC`,
      [product_id]
    );
    const { rows: product } = await pool.query(
      'SELECT name, price FROM products WHERE id = $1', [product_id]
    );
    res.json({
      product_id,
      product_name: product[0]?.name,
      base_price:   product[0]?.price,
      total:        rows.length,
      variants:     rows,
    });
  } catch (err) {
    console.error('variants GET error:', err);
    res.status(500).json({ error: 'Erro ao buscar variantes' });
  }
});

// POST /companies/:id/products/:pid/variants/quick-batch
//
// Tarefa A: cria N variantes em batch (ex: P, G, GG) herdando atributos do pai.
//
// Body:
//   attribute_name: string                 // "Tamanho" ou "Cor"
//   values: string[]                       // ["P", "G", "GG"]
//   shared_attributes?: [{name,value}]     // attrs adicionais herdados (opcional;
//                                           // padrao: extrai do produto pai)
//   stock_per_variant?: number             // default 0
//   price_override?: number                // default null (usa preco do pai)
//
// Comportamento:
//   1. Se produto NAO tem variantes ainda E pai tem color/size:
//      Cria 1 "variante 0" representando o pai (preserva o estoque atual).
//      Pai vira container, stock_qty do pai zera (estoque agora vive nas variantes).
//   2. Pra cada value em values:
//      Compoe attrs = [{attribute_name, value}, ...shared_attributes_minus_collision]
//      Pula se signature ja existe (idempotente)
//      Cria variante com SKU auto-gerado
//
// Returns: { created, skipped, parent_promoted, variants }
router.post('/quick-batch', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const {
    attribute_name,
    values,
    shared_attributes,
    stock_per_variant = 0,
    price_override = null,
  } = req.body || {};

  // Validacoes
  if (!attribute_name || typeof attribute_name !== 'string' || !attribute_name.trim()) {
    return res.status(400).json({ error: 'attribute_name eh obrigatorio' });
  }
  if (!Array.isArray(values) || values.length === 0) {
    return res.status(400).json({ error: 'values deve ser array nao vazio' });
  }

  // Limpa values: trim, remove duplicatas, max 20 por batch (anti-spam)
  const cleanValues = Array.from(
    new Set(values.map(v => String(v || '').trim()).filter(v => v.length > 0))
  ).slice(0, 20);
  if (cleanValues.length === 0) {
    return res.status(400).json({ error: 'values nao tem nenhum valor valido' });
  }

  const attrName = attribute_name.trim();
  const stockPer = Math.max(0, parseInt(stock_per_variant) || 0);
  const priceOver = price_override != null ? parseFloat(price_override) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Carrega produto + checa ownership
    const { rows: prodRows } = await client.query(
      `SELECT id, name, color, size, price, stock_qty
       FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [product_id, company_id]
    );
    if (!prodRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }
    const product = prodRows[0];

    // 2. Carrega variantes existentes + suas signatures (pra dedup)
    const { rows: existingVariants } = await client.query(
      `SELECT v.id, v.sku_suffix,
              COALESCE(JSON_AGG(JSON_BUILD_OBJECT('attribute', vv.attribute_name, 'value', vv.value))
                       FILTER (WHERE vv.id IS NOT NULL), '[]'::json) AS attributes
       FROM product_variants v
       LEFT JOIN product_variant_values vv ON vv.variant_id = v.id
       WHERE v.product_id = $1
       GROUP BY v.id`,
      [product_id]
    );
    const existingSignatures = new Set(
      existingVariants.map(v => signatureFromAttrs(v.attributes || []))
    );

    // 3. Determina shared_attributes efetivos.
    //    Se cliente nao mandou, extrai do pai (color, size) — exceto o que coincide
    //    com attribute_name (evita "Cor: Branco" + "Cor: Azul" duplicado quando
    //    o batch eh sobre Cor).
    let sharedEffective;
    if (Array.isArray(shared_attributes) && shared_attributes.length > 0) {
      sharedEffective = shared_attributes
        .filter(a => a && a.attribute && a.value)
        .filter(a => a.attribute.toLowerCase().trim() !== attrName.toLowerCase());
    } else {
      sharedEffective = extractParentAttributes(product)
        .filter(a => a.attribute.toLowerCase() !== attrName.toLowerCase());
    }

    // 4. Promove pai a variante padrao se ainda nao tem variantes E pai tem attrs
    //    proprios (color OU size). Cria a variante representando o pai com seus
    //    atributos atuais + o valor "atual" do attribute_name (se aplicavel).
    let parentPromoted = false;
    let parentVariant = null;
    if (existingVariants.length === 0) {
      const parentAttrs = extractParentAttributes(product);
      // Se attribute_name eh "Tamanho" e pai tem `size`, o valor do pai entra nas
      // attrs da variante padrao. Idem pra "Cor" e color.
      let parentValueForBatch = null;
      if (attrName.toLowerCase() === 'tamanho' && product.size) {
        parentValueForBatch = product.size.trim();
      } else if (attrName.toLowerCase() === 'cor' && product.color) {
        parentValueForBatch = 'Cor base (' + product.color + ')';
      }

      // Monta attrs da variante padrao
      const promotedAttrs = parentAttrs.slice();
      // Se attribute_name nao esta nos parentAttrs e tem valor base, adiciona
      if (parentValueForBatch && !promotedAttrs.find(a => a.attribute.toLowerCase() === attrName.toLowerCase())) {
        promotedAttrs.push({ attribute: attrName, value: parentValueForBatch });
      }

      // So promove se tem AO MENOS 1 atributo (caso contrario seria variante fantasma)
      if (promotedAttrs.length > 0) {
        const promotedSig = signatureFromAttrs(promotedAttrs);
        // Se o batch ja vai criar uma variante com mesma sig (ex: cliente vai
        // criar "M, G, GG" e produto pai ja tem size=M), pula a promocao.
        const batchWillCollide = cleanValues.some(v => {
          const sigCheck = signatureFromAttrs([
            { attribute: attrName, value: v },
            ...sharedEffective,
          ]);
          return sigCheck === promotedSig;
        });

        if (!batchWillCollide) {
          const promotedSku = makeSkuFromAttrs(promotedAttrs, 1);
          const { rows: pvRows } = await client.query(
            `INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty)
             VALUES ($1, $2, NULL, $3) RETURNING *`,
            [product_id, promotedSku, parseInt(product.stock_qty) || 0]
          );
          parentVariant = pvRows[0];
          // Insere os attrs
          for (const attr of promotedAttrs) {
            await client.query(
              `INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, $2, $3)`,
              [parentVariant.id, attr.attribute.trim(), attr.value.trim()]
            );
          }
          // Zera o stock do pai (estoque agora vive na variante)
          await client.query(
            'UPDATE products SET stock_qty = 0, updated_at = NOW() WHERE id = $1',
            [product_id]
          );
          existingSignatures.add(promotedSig);
          parentPromoted = true;
        }
      }
    }

    // 5. Cria as N variantes do batch
    const created = [];
    const skipped = [];

    for (let i = 0; i < cleanValues.length; i++) {
      const value = cleanValues[i];
      const variantAttrs = [
        { attribute: attrName, value: value },
        ...sharedEffective,
      ];
      const sig = signatureFromAttrs(variantAttrs);

      if (existingSignatures.has(sig)) {
        skipped.push({ value: value, reason: 'duplicate' });
        continue;
      }

      // Gera SKU. Se duplicar SKU, adiciona sufixo timestamp.
      let sku = makeSkuFromAttrs(variantAttrs, existingVariants.length + i + 2);
      const dupSku = await client.query(
        'SELECT id FROM product_variants WHERE product_id = $1 AND sku_suffix = $2',
        [product_id, sku]
      );
      if (dupSku.rows.length > 0) {
        sku = sku + '-' + Date.now().toString(36).slice(-4) + i;
      }

      const { rows: nvRows } = await client.query(
        `INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [product_id, sku, priceOver, stockPer]
      );
      const newVariant = nvRows[0];

      for (const attr of variantAttrs) {
        await client.query(
          `INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, $2, $3)`,
          [newVariant.id, attr.attribute.trim(), attr.value.trim()]
        );
      }

      existingSignatures.add(sig);
      created.push({
        id: newVariant.id,
        sku_suffix: newVariant.sku_suffix,
        attributes: variantAttrs,
      });
    }

    await client.query('COMMIT');
    res.status(201).json({
      ok: true,
      created: created.length,
      skipped: skipped.length,
      parent_promoted: parentPromoted,
      parent_variant_id: parentVariant?.id || null,
      variants: created,
      skipped_details: skipped,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('variants quick-batch error:', err);
    res.status(500).json({ error: 'Erro ao criar variantes em lote: ' + (err.message || '') });
  } finally {
    client.release();
  }
});

// POST /companies/:id/products/:pid/variants
// P0 #11: sku_suffix is now optional (auto-generated), attributes optional
router.post('/', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { sku_suffix, price_override, stock_qty = 0, barcode, barcode_format, attributes = [] } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!await checkProductOwnership(company_id, product_id)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }

    // Auto-generate SKU if not provided
    let finalSku = (sku_suffix || '').trim();
    if (!finalSku) {
      const { rows: countRows } = await client.query(
        'SELECT COUNT(*) AS cnt FROM product_variants WHERE product_id = $1', [product_id]
      );
      const idx = parseInt(countRows[0].cnt) + 1;
      // Build SKU from attributes if available
      if (attributes.length > 0) {
        finalSku = attributes.map(a => (a.value || '').slice(0, 6).toUpperCase().replace(/\s+/g, '')).join('-');
      } else {
        finalSku = `V${idx}`;
      }
    }

    // Check duplicate SKU
    const dupCheck = await client.query(
      'SELECT id FROM product_variants WHERE product_id = $1 AND sku_suffix = $2',
      [product_id, finalSku]
    );
    if (dupCheck.rows.length > 0) {
      // Append number to make unique
      finalSku = finalSku + '-' + Date.now().toString(36).slice(-4);
    }

    const { rows: variantRows } = await client.query(
      `INSERT INTO product_variants
         (product_id, sku_suffix, price_override, stock_qty, barcode, barcode_format)
       VALUES ($1, $2, $3, $4, $5, $6::barcode_format)
       RETURNING *`,
      [product_id, finalSku, price_override || null, stock_qty,
       barcode || null, barcode_format || null]
    );
    const variant = variantRows[0];
    const attrResults = [];
    for (const attr of attributes) {
      if (!attr.attribute || !attr.value) continue;
      const { rows: attrRows } = await client.query(
        `INSERT INTO product_variant_values (variant_id, attribute_name, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (variant_id, attribute_name) DO UPDATE SET value = EXCLUDED.value
         RETURNING attribute_name, value`,
        [variant.id, attr.attribute.trim(), attr.value.trim()]
      );
      attrResults.push(attrRows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ variant: { ...variant, attributes: attrResults } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('variant POST error:', err);
    res.status(500).json({ error: 'Erro ao criar variante' });
  } finally {
    client.release();
  }
});

// PATCH /companies/:id/products/:pid/variants/:vid
router.patch('/:vid', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, pid: product_id, vid: variant_id } = req.params;
  const { sku_suffix, price_override, stock_qty, barcode, barcode_format, is_active, attributes } = req.body;
  try {
    if (!await checkProductOwnership(company_id, product_id)) {
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }
    const fields = [], values = [];
    let idx = 1;
    if (sku_suffix     !== undefined) { fields.push(`sku_suffix = $${idx++}`);     values.push(sku_suffix); }
    if (price_override !== undefined) { fields.push(`price_override = $${idx++}`); values.push(price_override); }
    if (stock_qty      !== undefined) { fields.push(`stock_qty = $${idx++}`);      values.push(stock_qty); }
    if (barcode        !== undefined) { fields.push(`barcode = $${idx++}`);        values.push(barcode); }
    if (barcode_format !== undefined) { fields.push(`barcode_format = $${idx++}::barcode_format`); values.push(barcode_format); }
    if (is_active      !== undefined) { fields.push(`is_active = $${idx++}`);      values.push(is_active); }
    if (fields.length === 0 && !attributes) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }
    let variant = null;
    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(variant_id, product_id);
      const { rows } = await pool.query(
        `UPDATE product_variants SET ${fields.join(', ')}
         WHERE id = $${idx++} AND product_id = $${idx++} RETURNING *`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Variante nao encontrada' });
      variant = rows[0];
    }
    if (attributes && Array.isArray(attributes)) {
      for (const attr of attributes) {
        if (!attr.attribute || !attr.value) continue;
        await pool.query(
          `INSERT INTO product_variant_values (variant_id, attribute_name, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (variant_id, attribute_name) DO UPDATE SET value = EXCLUDED.value`,
          [variant_id, attr.attribute.trim(), attr.value.trim()]
        );
      }
    }
    res.json({ variant: variant || { id: variant_id, updated: true } });
  } catch (err) {
    console.error('variant PATCH error:', err);
    res.status(500).json({ error: 'Erro ao atualizar variante' });
  }
});

// DELETE /companies/:id/products/:pid/variants/:vid
router.delete('/:vid', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, pid: product_id, vid: variant_id } = req.params;
  try {
    if (!await checkProductOwnership(company_id, product_id)) {
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }
    const { rows } = await pool.query(
      'DELETE FROM product_variants WHERE id = $1 AND product_id = $2 RETURNING id',
      [variant_id, product_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Variante nao encontrada' });
    res.json({ message: 'Variante removida' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover variante' });
  }
});

module.exports = router;
