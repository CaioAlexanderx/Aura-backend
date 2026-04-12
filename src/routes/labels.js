// BE-14 — Geracao de dados para impressao de etiquetas
// A renderizacao visual (JsBarcode / qrcode.js) e client-side.
// O backend fornece os dados estruturados para o frontend montar o PDF/print.
// FIX #6: Adicionado layout bematech_33x21 (33x21mm, rotacao 180)

const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// Dimensoes recomendadas por layout (em mm) — guia para o frontend
const LAYOUT_META = {
  single:         { width_mm: 50, height_mm: 25, cols: 1, rows: 1,  type: 'barcode' },
  a4_2x5:         { width_mm: 99, height_mm: 56, cols: 2, rows: 5,  type: 'barcode' },
  a4_4x10:        { width_mm: 52, height_mm: 28, cols: 4, rows: 10, type: 'barcode' },
  qr_single:      { width_mm: 40, height_mm: 40, cols: 1, rows: 1,  type: 'qr'      },
  qr_3x5:         { width_mm: 60, height_mm: 55, cols: 3, rows: 5,  type: 'qr'      },
  bematech_33x21: { width_mm: 33, height_mm: 21, cols: 1, rows: 1,  type: 'qr', rotate: 180 },
};

const validLayouts = Object.keys(LAYOUT_META);

// GET /companies/:id/products/:pid/label
router.get('/:pid/label', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const {
    show_name  = 'true',
    show_price = 'true',
    qty        = '1',
    layout     = 'single',
  } = req.query;

  if (!validLayouts.includes(layout)) {
    return res.status(400).json({ error: `layout invalido. Use: ${validLayouts.join(', ')}` });
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
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }

    const product = result.rows[0];

    if (!product.barcode) {
      return res.status(422).json({ error: 'Produto nao possui codigo vinculado. Cadastre um codigo antes de imprimir a etiqueta.' });
    }

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
        layout_meta: LAYOUT_META[layout],
      },
    });
  } catch (err) {
    console.error('label error:', err);
    res.status(500).json({ error: 'Erro ao gerar dados da etiqueta' });
  }
});

// GET /companies/:id/products/:pid/label/print?layout=bematech_33x21
// Retorna HTML pronto para impressao direta (window.print)
router.get('/:pid/label/print', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const {
    show_name  = 'true',
    show_price = 'true',
    qty        = '1',
    layout     = 'bematech_33x21',
  } = req.query;

  if (!validLayouts.includes(layout)) {
    return res.status(400).json({ error: `layout invalido. Use: ${validLayouts.join(', ')}` });
  }

  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);

  try {
    const result = await pool.query(
      `SELECT id, name, price, barcode, barcode_format, sku
       FROM products
       WHERE id = $1 AND company_id = $2 AND active = true`,
      [product_id, company_id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const product = result.rows[0];
    if (!product.barcode) return res.status(422).json({ error: 'Produto sem codigo cadastrado' });

    const meta = LAYOUT_META[layout];
    const showName = show_name === 'true';
    const showPrice = show_price === 'true';
    const rotateDeg = meta.rotate || 0;
    const priceText = product.price ? `R$ ${parseFloat(product.price).toFixed(2)}` : '';

    // QR via external API (branco no escuro) — fundo branco forcado
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(product.barcode)}&bgcolor=ffffff&color=000000`;

    const labels = [];
    for (let i = 0; i < quantity; i++) {
      labels.push(`<div class="label" style="transform:rotate(${rotateDeg}deg)">
        <div class="qr-wrap"><img src="${qrUrl}" class="qr" alt="QR"></div>
        ${showName ? `<div class="name">${product.name}</div>` : ''}
        ${showPrice ? `<div class="price">${priceText}</div>` : ''}
      </div>`);
    }

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Etiqueta - ${product.name}</title>
<style>
  @page {
    margin: 0;
    size: ${meta.width_mm}mm ${meta.height_mm}mm;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; }
  .label {
    width: ${meta.width_mm}mm;
    height: ${meta.height_mm}mm;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: 1.5mm;
    padding: 1mm;
    page-break-after: always;
    background: #fff;
    overflow: hidden;
  }
  .label:last-child { page-break-after: auto; }
  .qr-wrap {
    flex-shrink: 0;
    width: ${Math.min(meta.height_mm - 3, 18)}mm;
    height: ${Math.min(meta.height_mm - 3, 18)}mm;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .qr {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }
  .name {
    font-size: 6pt;
    font-weight: 700;
    line-height: 1.1;
    overflow: hidden;
    max-height: 8mm;
    word-break: break-word;
  }
  .price {
    font-size: 7pt;
    font-weight: 900;
  }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    button { display: none !important; }
  }
</style>
</head>
<body>
${labels.join('\n')}
<button onclick="window.print()" style="position:fixed;bottom:10px;right:10px;padding:10px 20px;cursor:pointer;z-index:999">Imprimir</button>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('label print error:', err);
    res.status(500).json({ error: 'Erro ao gerar etiqueta' });
  }
});

// GET /companies/:id/products/labels/batch?ids=pid1,pid2&layout=a4_4x10
router.get('/labels/batch', requireAuth, async (req, res) => {
  const { id: company_id } = req.params;
  const { ids, layout = 'a4_4x10', show_name = 'true', show_price = 'true' } = req.query;

  if (!ids) return res.status(400).json({ error: 'Informe ids separados por virgula' });

  const productIds = ids.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (productIds.length === 0) return res.status(400).json({ error: 'Nenhum id valido' });

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
        layout_meta: LAYOUT_META[layout] || LAYOUT_META.a4_4x10,
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
