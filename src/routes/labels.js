// BE-14 — Geração de dados para impressão de etiquetas
// A renderização visual (JsBarcode / qrcode.js) é client-side.
// O backend fornece os dados estruturados para o frontend montar o PDF/print.

const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// GET /companies/:id/products/:pid/label
// Retorna os dados do produto formatados para geração de etiqueta
router.get('/:pid/label', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;

  // Opções de layout (query params com defaults)
  const {
    show_name  = 'true',
    show_price = 'true',
    qty        = '1',
    layout     = 'single',   // single | a4_2x5 | a4_4x10 | qr_single | qr_3x5
  } = req.query;

  const validLayouts = ['single', 'a4_2x5', 'a4_4x10', 'qr_single', 'qr_3x5'];
  if (!validLayouts.includes(layout)) {
    return res.status(400).json({ error: `layout inválido. Use: ${validLayouts.join(', ')}` });
  }

  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);

  try {
    const result = await pool.query(
      `SELECT id, name, price, barcode, barcode_format, sku
       FROM products
       WHERE id = $1 AND company_id = $2 AND active = true`,
      [product_id, company_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }

    const product = result.rows[0];

    if (!product.barcode) {
      return res.status(422).json({ error: 'Produto não possui código vinculado. Cadastre um código antes de imprimir a etiqueta.' });
    }

    // Dimensões recomendadas por layout (em mm) — guia para o frontend
    const layoutMeta = {
      single:   { width_mm: 50, height_mm: 25, cols: 1, rows: 1,  type: 'barcode' },
      a4_2x5:   { width_mm: 99, height_mm: 56, cols: 2, rows: 5,  type: 'barcode' },
      a4_4x10:  { width_mm: 52, height_mm: 28, cols: 4, rows: 10, type: 'barcode' },
      qr_single:{ width_mm: 40, height_mm: 40, cols: 1, rows: 1,  type: 'qr'      },
      qr_3x5:   { width_mm: 60, height_mm: 55, cols: 3, rows: 5,  type: 'qr'      },
    };

    res.json({
      product: {
        id:             product.id,
        name:           product.name,
        price:          product.price,
        barcode:        product.barcode,
        barcode_format: product.barcode_format,
        sku:            product.sku,
      },
      label_options: {
        show_name:  show_name === 'true',
        show_price: show_price === 'true',
        quantity,
        layout,
        layout_meta: layoutMeta[layout],
      },
    });
  } catch (err) {
    console.error('label error:', err);
    res.status(500).json({ error: 'Erro ao gerar dados da etiqueta' });
  }
});

// GET /companies/:id/products/labels/batch?ids=pid1,pid2&layout=a4_4x10
// Múltiplos produtos de uma vez — útil para reimprimir estoque
router.get('/labels/batch', requireAuth, async (req, res) => {
  const { id: company_id } = req.params;
  const { ids, layout = 'a4_4x10', show_name = 'true', show_price = 'true' } = req.query;

  if (!ids) return res.status(400).json({ error: 'Informe ids separados por vírgula' });

  const productIds = ids.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (productIds.length === 0) return res.status(400).json({ error: 'Nenhum id válido' });

  try {
    const result = await pool.query(
      `SELECT id, name, price, barcode, barcode_format, sku
       FROM products
       WHERE id = ANY($1::uuid[]) AND company_id = $2 AND active = true AND barcode IS NOT NULL
       ORDER BY name`,
      [productIds, company_id]
    );

    res.json({
      products: result.rows,
      label_options: {
        show_name:  show_name === 'true',
        show_price: show_price === 'true',
        layout,
      },
      total: result.rows.length,
      skipped: productIds.length - result.rows.length,
    });
  } catch (err) {
    console.error('batch label error:', err);
    res.status(500).json({ error: 'Erro ao buscar produtos' });
  }
});

module.exports = router;
