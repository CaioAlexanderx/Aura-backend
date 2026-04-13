// ============================================================
// AURA. — Etiquetas de produto (impressao direta)
// P0 #3: 33x21mm — suporta BARCODE (JsBarcode SVG) e QR Code
// Impressora alvo: Bematech LB-1000 / 042 (203dpi, TSPL2)
// ============================================================
const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const LABEL_WIDTH = 33;  // mm
const LABEL_HEIGHT = 21; // mm

// GET /companies/:id/products/:pid/label
router.get('/:pid/label', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { show_name = 'true', show_price = 'true', qty = '1' } = req.query;
  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);

  try {
    const result = await pool.query(
      `SELECT id, name, price, barcode, barcode_format, sku
       FROM products WHERE id = $1 AND company_id = $2 AND active = true`,
      [product_id, company_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const product = result.rows[0];
    if (!product.barcode) return res.status(422).json({ error: 'Produto sem codigo cadastrado' });

    res.json({
      product: {
        id: product.id, name: product.name, price: product.price,
        barcode: product.barcode, barcode_format: product.barcode_format, sku: product.sku,
      },
      label_options: {
        show_name: show_name === 'true', show_price: show_price === 'true',
        quantity, width_mm: LABEL_WIDTH, height_mm: LABEL_HEIGHT,
      },
    });
  } catch (err) {
    console.error('label error:', err);
    res.status(500).json({ error: 'Erro ao gerar dados da etiqueta' });
  }
});

// GET /companies/:id/products/:pid/label/print?mode=barcode|qr
// Retorna HTML pronto para window.print() na Bematech 33x21
router.get('/:pid/label/print', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { show_name = 'true', show_price = 'true', qty = '1', mode = 'barcode' } = req.query;
  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);
  const useQR = mode === 'qr';

  try {
    const result = await pool.query(
      `SELECT id, name, price, barcode, barcode_format, sku
       FROM products WHERE id = $1 AND company_id = $2 AND active = true`,
      [product_id, company_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const product = result.rows[0];
    if (!product.barcode) return res.status(422).json({ error: 'Produto sem codigo cadastrado' });

    const showName = show_name === 'true';
    const showPrice = show_price === 'true';
    const priceText = product.price ? `R$ ${parseFloat(product.price).toFixed(2).replace('.', ',')}` : '';
    const barcodeData = product.barcode;

    // Detect barcode format for JsBarcode
    const barcodeLen = barcodeData.replace(/\D/g, '').length;
    let jsFormat = 'CODE128'; // default
    if (/^\d+$/.test(barcodeData)) {
      if (barcodeLen === 13) jsFormat = 'EAN13';
      else if (barcodeLen === 8) jsFormat = 'EAN8';
      else if (barcodeLen === 12) jsFormat = 'UPC';
    }
    if (product.barcode_format) {
      const fmtMap = { ean13: 'EAN13', ean8: 'EAN8', upc: 'UPC', code128: 'CODE128', code39: 'CODE39' };
      jsFormat = fmtMap[product.barcode_format] || jsFormat;
    }

    // QR URL (for QR mode)
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(barcodeData)}&bgcolor=ffffff&color=000000&margin=1`;

    const labels = [];
    for (let i = 0; i < quantity; i++) {
      if (useQR) {
        // QR layout: QR left, info right
        labels.push(`<div class="label qr-layout">
          <img src="${qrUrl}" class="qr" alt="QR">
          <div class="info">
            ${showName ? `<div class="name">${product.name}</div>` : ''}
            ${showPrice ? `<div class="price">${priceText}</div>` : ''}
          </div>
        </div>`);
      } else {
        // Barcode layout: barcode top, info bottom
        labels.push(`<div class="label barcode-layout">
          <svg class="barcode" id="bc-${i}"></svg>
          ${showName ? `<div class="name">${product.name}</div>` : ''}
          ${showPrice ? `<div class="price">${priceText}</div>` : ''}
        </div>`);
      }
    }

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Etiqueta - ${product.name}</title>
${!useQR ? '<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>' : ''}
<style>
  @page {
    margin: 0;
    padding: 0;
    size: ${LABEL_WIDTH}mm ${LABEL_HEIGHT}mm;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; background: #f5f5f5; }

  .label {
    width: ${LABEL_WIDTH}mm;
    height: ${LABEL_HEIGHT}mm;
    background: #fff;
    overflow: hidden;
    page-break-after: always;
  }
  .label:last-child { page-break-after: auto; }

  /* BARCODE layout: vertical stack */
  .barcode-layout {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0.5mm 1mm;
    gap: 0;
    text-align: center;
  }
  .barcode-layout .barcode {
    width: 30mm;
    height: 11mm;
    flex-shrink: 0;
  }
  .barcode-layout .name {
    font-size: 5pt;
    font-weight: 600;
    line-height: 1.1;
    max-height: 5mm;
    overflow: hidden;
    word-break: break-word;
    color: #000;
    margin-top: 0.3mm;
  }
  .barcode-layout .price {
    font-size: 7pt;
    font-weight: 900;
    color: #000;
    white-space: nowrap;
  }

  /* QR layout: horizontal */
  .qr-layout {
    display: flex;
    flex-direction: row;
    align-items: center;
    padding: 1mm 1.5mm;
    gap: 1.5mm;
  }
  .qr-layout .qr {
    width: 17mm;
    height: 17mm;
    flex-shrink: 0;
    image-rendering: pixelated;
  }
  .qr-layout .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.5mm;
    overflow: hidden;
  }
  .qr-layout .name {
    font-size: 5.5pt;
    font-weight: 700;
    line-height: 1.15;
    max-height: 10mm;
    overflow: hidden;
    word-break: break-word;
    color: #000;
  }
  .qr-layout .price {
    font-size: 7.5pt;
    font-weight: 900;
    color: #000;
    white-space: nowrap;
  }

  /* Preview */
  .preview-bar {
    position: fixed; bottom: 0; left: 0; right: 0;
    background: #1a1a2e; padding: 12px 20px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    z-index: 999; font-family: -apple-system, sans-serif;
  }
  .preview-bar span { color: #a78bfa; font-size: 12px; }
  .preview-bar b { color: #e2e8f0; font-size: 13px; }
  .preview-bar button {
    background: #7c3aed; color: #fff; border: none;
    padding: 10px 24px; border-radius: 8px; font-size: 14px;
    font-weight: 700; cursor: pointer;
  }
  .preview-bar button:hover { background: #6d28d9; }
  .setup-info {
    max-width: 600px; margin: 20px auto; padding: 16px 20px;
    background: #fff; border-radius: 12px; border: 1px solid #e2e8f0;
    font-family: -apple-system, sans-serif; font-size: 12px; color: #555; line-height: 1.6;
  }
  .setup-info h3 { font-size: 14px; color: #1a1a2e; margin-bottom: 8px; }
  .label-preview {
    display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;
    padding: 20px; padding-bottom: 80px;
  }
  .label-preview .label { border: 1px dashed #ccc; border-radius: 2px; }

  @media print {
    .preview-bar, .setup-info { display: none !important; }
    .label-preview { padding: 0; gap: 0; }
    .label-preview .label { border: none; }
    body { background: #fff; }
  }
</style>
</head>
<body>

<div class="setup-info">
  <h3>Configuracao da impressora Bematech</h3>
  <ol>
    <li>No <b>Painel de Controle > Impressoras</b>, abra <b>Preferencias de impressao</b> da Bematech</li>
    <li>Defina o tamanho do papel como <b>33mm x 21mm</b></li>
    <li>No Chrome: <b>Ctrl+P</b> > Bematech > <b>Mais configuracoes</b></li>
    <li>Tamanho: <b>33 x 21 mm</b> | Margens: <b>Nenhuma</b> | Escala: <b>100%</b></li>
  </ol>
</div>

<div class="label-preview">
${labels.join('\n')}
</div>

<div class="preview-bar">
  <div>
    <span>Etiqueta 33x21mm (${useQR ? 'QR Code' : 'Codigo de barras'})</span><br>
    <b>${product.name} ${showPrice ? '| ' + priceText : ''}</b>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <span>${quantity} etiqueta${quantity > 1 ? 's' : ''}</span>
    <button onclick="window.print()">Imprimir</button>
  </div>
</div>

${!useQR ? `<script>
  // Generate barcodes via JsBarcode (SVG — crisp at any DPI)
  document.querySelectorAll('.barcode').forEach(function(el) {
    try {
      JsBarcode(el, "${barcodeData}", {
        format: "${jsFormat}",
        width: 1.2,
        height: 28,
        margin: 0,
        fontSize: 7,
        textMargin: 1,
        displayValue: true,
        font: "Arial",
        textAlign: "center",
        background: "#ffffff",
        lineColor: "#000000"
      });
    } catch(e) {
      // Fallback to CODE128 if format fails
      try {
        JsBarcode(el, "${barcodeData}", {
          format: "CODE128", width: 1, height: 28, margin: 0,
          fontSize: 7, textMargin: 1, displayValue: true,
          font: "Arial", background: "#ffffff", lineColor: "#000000"
        });
      } catch(e2) { el.innerHTML = '<text y="15" font-size="8" fill="red">Erro no codigo</text>'; }
    }
  });
<\/script>` : ''}

</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('label print error:', err);
    res.status(500).json({ error: 'Erro ao gerar etiqueta' });
  }
});

// GET /companies/:id/products/labels/batch?ids=pid1,pid2
router.get('/labels/batch', requireAuth, async (req, res) => {
  const { id: company_id } = req.params;
  const { ids, show_name = 'true', show_price = 'true' } = req.query;
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
        show_name: show_name === 'true', show_price: show_price === 'true',
        width_mm: LABEL_WIDTH, height_mm: LABEL_HEIGHT,
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
