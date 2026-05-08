// ============================================================
// AURA. -- Products Variations v2 (reformulado)
// Mount: /companies/:id/products/:pid/variations
//
// Nova UX: produto pai tem listas de cores e tamanhos; matriz
// cor x tamanho forma o estoque por combinacao. Preco unico do pai.
//
// Shape da API:
//   GET  -> { colors: [{hex, name}], sizes: ["P","M"], matrix: {"#FF0000|P": 5, ...}, mode: 'none'|'color'|'size'|'matrix' }
//   PUT  -> recebe mesmo shape, reescreve variantes (soft-delete antigas)
//
// Schema preservado: usa product_variants + product_variant_values
// Cada combinacao = 1 row em product_variants + 1-2 rows em
// product_variant_values (attribute_name='Cor' ou 'Tamanho').
//
// Soft-delete (is_active=false) em vez de DELETE porque sale_items
// tem FK NO ACTION em variant_id (preserva historico de vendas).
//
// 08/05/2026: ao salvar variantes, se uma combinacao criada coincide
// com color/size proprios do pai, limpamos color=NULL e size=NULL do
// pai pra evitar dupla exibicao no VariantPickerModal e loop de
// banner-amarelo no editor (ver comentario no UPDATE final).
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

// Helpers
function buildMatrixKey(colorHex, sizeValue) {
  return (colorHex || '') + '|' + (sizeValue || '');
}

function skuSuffixFromAttrs(colorHex, colorName, sizeValue) {
  // Ex: "#FF0000" + "P" -> "VERMELHO-P"; "#FF0000" alone -> "VERMELHO"
  // Usa hex puro se nao tiver nome.
  const parts = [];
  if (colorHex) parts.push((colorName || colorHex.replace('#', '')).toUpperCase().slice(0, 10));
  if (sizeValue) parts.push(String(sizeValue).toUpperCase().slice(0, 10));
  return parts.join('-');
}

// GET /companies/:id/products/:pid/variations
router.get('/:pid/variations', async (req, res) => {
  const { id: cid, pid } = req.params;
  try {
    // Valida que o produto existe e pertence a empresa
    const { rows: prodRows } = await db.query(
      'SELECT id, name, stock_qty FROM products WHERE id = $1 AND company_id = $2',
      [pid, cid]
    );
    if (!prodRows.length) return res.status(404).json({ error: 'Produto nao encontrado' });

    // Busca variantes ativas + atributos
    const { rows: variantRows } = await db.query(
      `SELECT pv.id, pv.sku_suffix, pv.stock_qty, pv.barcode,
        COALESCE(json_agg(
          json_build_object('attribute', pvv.attribute_name, 'value', pvv.value)
          ORDER BY pvv.attribute_name
        ) FILTER (WHERE pvv.id IS NOT NULL), '[]'::json) AS attributes
       FROM product_variants pv
       LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
       WHERE pv.product_id = $1 AND pv.is_active = true
       GROUP BY pv.id, pv.sku_suffix, pv.stock_qty, pv.barcode
       ORDER BY pv.created_at ASC`,
      [pid]
    );

    // Decompoe variantes em cores, tamanhos e matriz
    const colorsMap = new Map();   // hex -> name
    const sizesSet = new Set();
    const matrix = {};

    for (const v of variantRows) {
      const attrs = v.attributes || [];
      let colorHex = null, colorName = null, sizeValue = null;
      for (const a of attrs) {
        const attrName = String(a.attribute || '').toLowerCase();
        if (attrName === 'cor' || attrName === 'color') {
          colorHex = a.value;
          // Tenta extrair nome do sku_suffix (VERMELHO-P -> VERMELHO)
          if (v.sku_suffix) {
            const first = v.sku_suffix.split('-')[0];
            if (first && !/^[0-9A-F]{6}$/i.test(first)) colorName = first;
          }
        } else if (attrName === 'tamanho' || attrName === 'size') {
          sizeValue = a.value;
        }
      }
      if (colorHex) colorsMap.set(colorHex, colorName || null);
      if (sizeValue) sizesSet.add(sizeValue);
      matrix[buildMatrixKey(colorHex, sizeValue)] = parseInt(v.stock_qty) || 0;
    }

    const colors = Array.from(colorsMap.entries()).map(([hex, name]) => ({ hex, name }));
    const sizes = Array.from(sizesSet);

    let mode = 'none';
    if (colors.length > 0 && sizes.length > 0) mode = 'matrix';
    else if (colors.length > 0) mode = 'color';
    else if (sizes.length > 0) mode = 'size';

    res.json({
      product_id: pid,
      product_name: prodRows[0].name,
      colors,
      sizes,
      matrix,
      mode,
      total_variants: variantRows.length,
    });
  } catch (err) {
    console.error('[productsVariations GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar variacoes' });
  }
});

// PUT /companies/:id/products/:pid/variations
// Body: { colors: [{hex, name?}], sizes: ["P","M"], matrix: {"hex|size": stock, ...} }
// Reescreve todas as variantes: soft-delete as ativas + cria novas.
router.put('/:pid/variations', async (req, res) => {
  const { id: cid, pid } = req.params;
  const { colors = [], sizes = [], matrix = {} } = req.body || {};

  // Validacoes
  if (!Array.isArray(colors) || !Array.isArray(sizes)) {
    return res.status(400).json({ error: 'colors e sizes devem ser arrays' });
  }
  if (colors.length > 30 || sizes.length > 30) {
    return res.status(400).json({ error: 'Maximo de 30 cores ou 30 tamanhos' });
  }

  // Validacao: hex valido em cada cor
  for (const c of colors) {
    if (!c || !c.hex || !/^#[0-9A-Fa-f]{6}$/.test(c.hex)) {
      return res.status(400).json({ error: 'Cor invalida: hex deve ser no formato #RRGGBB' });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Valida produto + captura color/size proprios atuais (necessario pra
    // detectar migracao do estoque do pai pra variante e limpar os campos
    // depois — evita dupla exibicao no VariantPickerModal e loop de banner
    // amarelo no editor)
    const { rows: prodRows } = await client.query(
      'SELECT id, color, size FROM products WHERE id = $1 AND company_id = $2',
      [pid, cid]
    );
    if (!prodRows.length) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }
    const parentColor = prodRows[0].color || null;
    const parentSize  = prodRows[0].size  || null;

    // Soft-delete variantes ativas atuais (preserva sale_items FK)
    await client.query(
      'UPDATE product_variants SET is_active = false, updated_at = NOW() WHERE product_id = $1 AND is_active = true',
      [pid]
    );

    // Monta lista de combinacoes a criar baseado nos inputs
    // - Se tem cores E tamanhos: matriz completa (N*M combinacoes)
    // - Se so tem cores: 1 variante por cor
    // - Se so tem tamanhos: 1 variante por tamanho
    // - Se nao tem nenhum: produto simples (sem variantes)
    const combinations = [];
    if (colors.length > 0 && sizes.length > 0) {
      for (const c of colors) {
        for (const s of sizes) {
          const key = buildMatrixKey(c.hex, s);
          combinations.push({
            colorHex: c.hex, colorName: c.name || null,
            sizeValue: s,
            stock: parseInt(matrix[key]) || 0,
          });
        }
      }
    } else if (colors.length > 0) {
      for (const c of colors) {
        const key = buildMatrixKey(c.hex, null);
        combinations.push({
          colorHex: c.hex, colorName: c.name || null,
          sizeValue: null,
          stock: parseInt(matrix[key]) || 0,
        });
      }
    } else if (sizes.length > 0) {
      for (const s of sizes) {
        const key = buildMatrixKey(null, s);
        combinations.push({
          colorHex: null, colorName: null,
          sizeValue: s,
          stock: parseInt(matrix[key]) || 0,
        });
      }
    }

    const created = [];
    for (const combo of combinations) {
      const skuSuffix = skuSuffixFromAttrs(combo.colorHex, combo.colorName, combo.sizeValue);

      // Cria variante
      const { rows: variantRow } = await client.query(
        `INSERT INTO product_variants (product_id, sku_suffix, stock_qty, is_active)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [pid, skuSuffix || null, combo.stock]
      );
      const variantId = variantRow[0].id;

      // Cria atributos
      if (combo.colorHex) {
        await client.query(
          `INSERT INTO product_variant_values (variant_id, attribute_name, value)
           VALUES ($1, 'Cor', $2)`,
          [variantId, combo.colorHex]
        );
      }
      if (combo.sizeValue) {
        await client.query(
          `INSERT INTO product_variant_values (variant_id, attribute_name, value)
           VALUES ($1, 'Tamanho', $2)`,
          [variantId, combo.sizeValue]
        );
      }

      created.push({
        id: variantId,
        sku_suffix: skuSuffix,
        stock: combo.stock,
        color: combo.colorHex,
        size: combo.sizeValue,
      });
    }

    // Atualiza stock_qty do produto pai como SOMA das variantes
    // (se nao tem variantes, mantem o valor atual do produto)
    //
    // Detecta migracao: se alguma combinacao criada coincide com a
    // cor+tamanho proprios do pai, esse "estoque orfao" do pai foi agora
    // formalizado como variante. Limpa color/size do pai pra:
    //  - VariantPickerModal nao mostrar mais "Preto · M · estoque do pai"
    //  - useEffect do ProductVariationsSection nao re-disparar o merge
    //    no proximo open do editor (loop do banner amarelo)
    if (combinations.length > 0) {
      const totalStock = combinations.reduce((acc, c) => acc + c.stock, 0);

      // Logica de match adapta-se ao mode (matrix / color / size)
      const parentMigrated = combinations.some(c => {
        const matchColor = !!(parentColor && c.colorHex &&
          String(c.colorHex).toUpperCase() === String(parentColor).toUpperCase());
        const matchSize = !!(parentSize && c.sizeValue &&
          String(c.sizeValue) === String(parentSize));
        if (parentColor && parentSize) return matchColor && matchSize;     // matrix mode
        if (parentColor) return matchColor;                                 // color-only mode
        if (parentSize) return matchSize;                                   // size-only mode
        return false;                                                        // pai sem atributos
      });

      if (parentMigrated) {
        await client.query(
          `UPDATE products
           SET stock_qty = $1, color = NULL, size = NULL, updated_at = NOW()
           WHERE id = $2`,
          [totalStock, pid]
        );
      } else {
        await client.query(
          'UPDATE products SET stock_qty = $1, updated_at = NOW() WHERE id = $2',
          [totalStock, pid]
        );
      }
    }

    await client.query('COMMIT');
    client.release();

    let mode = 'none';
    if (colors.length > 0 && sizes.length > 0) mode = 'matrix';
    else if (colors.length > 0) mode = 'color';
    else if (sizes.length > 0) mode = 'size';

    res.json({
      product_id: pid,
      created_count: created.length,
      total_stock: combinations.reduce((acc, c) => acc + c.stock, 0),
      mode,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[productsVariations PUT]', err.message, err.code);
    res.status(500).json({ error: 'Erro ao salvar variacoes', detail: err.message });
  }
});

module.exports = router;
