// ============================================================
// AURA. — Etiquetas de produto (impressao direta)
// FIX DEFINITIVO: margem esquerda + barcode scanneavel
// Impressora: Bematech LB-1000 / 042 (203dpi, TSPL2)
// Etiqueta: 33mm x 21mm, 3 colunas por folha (99mm largura)
// ============================================================
const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const LABEL_W = 33;
const LABEL_H = 21;
const COLS = 3;
const SHEET_W = LABEL_W * COLS;

// GET /companies/:id/products/:pid/label
router.get('/:pid/label', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { show_name = 'true', show_price = 'true', qty = '1' } = req.query;
  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);
  try {
    const result = await pool.query(
      `SELECT id, name, price, barcode, barcode_format, sku
       FROM products WHERE id = $1 AND company_id = $2`,
      [product_id, company_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const product = result.rows[0];
    if (!product.barcode) return res.status(422).json({ error: 'Produto sem codigo cadastrado' });
    res.json({ product: { id: product.id, name: product.name, price: product.price, barcode: product.barcode, barcode_format: product.barcode_format, sku: product.sku }, label_options: { show_name: show_name === 'true', show_price: show_price === 'true', quantity, width_mm: LABEL_W, height_mm: LABEL_H, cols: COLS } });
  } catch (err) { console.error('label error:', err); res.status(500).json({ error: 'Erro ao gerar dados da etiqueta' }); }
});

// GET /companies/:id/products/:pid/label/print?mode=barcode|qr&qty=3&cols=3
router.get('/:pid/label/print', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { show_name = 'true', show_price = 'true', qty = '1', mode = 'barcode', cols: colsParam } = req.query;
  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);
  const useQR = mode === 'qr';
  const cols = Math.min(Math.max(parseInt(colsParam) || COLS, 1), 5);
  const sheetW = LABEL_W * cols;

  try {
    const result = await pool.query(
      `SELECT id, name, price, barcode, barcode_format, sku
       FROM products WHERE id = $1 AND company_id = $2`,
      [product_id, company_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const product = result.rows[0];
    if (!product.barcode) return res.status(422).json({ error: 'Produto sem codigo cadastrado' });

    const showName = show_name === 'true';
    const showPrice = show_price === 'true';
    const priceText = product.price ? `R$ ${parseFloat(product.price).toFixed(2).replace('.', ',')}` : '';
    const barcodeData = product.barcode;

    // Detect barcode format
    const barcodeLen = barcodeData.replace(/\D/g, '').length;
    let jsFormat = 'CODE128';
    if (/^\d+$/.test(barcodeData)) {
      if (barcodeLen === 13) jsFormat = 'EAN13';
      else if (barcodeLen === 8) jsFormat = 'EAN8';
      else if (barcodeLen === 12) jsFormat = 'UPC';
    }
    if (product.barcode_format) {
      const fmtMap = { ean13: 'EAN13', ean8: 'EAN8', upc: 'UPC', code128: 'CODE128', code39: 'CODE39' };
      jsFormat = fmtMap[product.barcode_format] || jsFormat;
    }

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(barcodeData)}&bgcolor=ffffff&color=000000&margin=1`;

    const labels = [];
    for (let i = 0; i < quantity; i++) {
      if (useQR) {
        labels.push(`<div class="label qr-layout"><img src="${qrUrl}" class="qr" alt="QR"><div class="info">${showName ? `<div class="name">${product.name}</div>` : ''}${showPrice ? `<div class="price">${priceText}</div>` : ''}</div></div>`);
      } else {
        labels.push(`<div class="label barcode-layout"><div class="bc-wrap"><svg class="barcode" id="bc-${i}"></svg></div>${showName ? `<div class="name">${product.name}</div>` : ''}${showPrice ? `<div class="price">${priceText}</div>` : ''}</div>`);
      }
    }

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Etiquetas Aura - ${quantity} etiqueta${quantity > 1 ? 's' : ''}</title>
${!useQR ? '<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>' : ''}
<style>
  /* ========== PAGE SETUP ========== */
  @page {
    size: ${sheetW}mm ${LABEL_H}mm;
    margin: 0 !important;
    padding: 0 !important;
  }
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { margin: 0 !important; padding: 0 !important; }
  body { font-family: Arial, Helvetica, sans-serif; background: #f5f5f5; }

  /* ========== TABLE LAYOUT (fix: no left margin, perfect grid) ========== */
  .print-grid {
    border-collapse: collapse;
    border-spacing: 0;
    margin: 0;
    padding: 0;
    width: ${sheetW}mm;
  }
  .print-grid td {
    width: ${LABEL_W}mm;
    height: ${LABEL_H}mm;
    padding: 0;
    margin: 0;
    border: none;
    vertical-align: top;
    overflow: hidden;
  }

  /* ========== LABEL ========== */
  .label {
    width: ${LABEL_W}mm;
    height: ${LABEL_H}mm;
    overflow: hidden;
    background: #fff;
  }

  /* Barcode layout */
  .barcode-layout {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: 0.3mm 0.5mm; text-align: center;
  }
  .bc-wrap {
    width: 29mm;
    height: 12mm;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .barcode-layout .barcode {
    max-width: 29mm;
    height: 12mm;
  }
  .barcode-layout .name {
    font-size: 5.5pt; font-weight: 600; line-height: 1.1;
    max-height: 4.5mm; overflow: hidden; word-break: break-word;
    color: #000; margin-top: 0.2mm;
  }
  .barcode-layout .price {
    font-size: 7.5pt; font-weight: 900; color: #000; white-space: nowrap;
  }

  /* QR layout */
  .qr-layout { display: flex; flex-direction: row; align-items: center; padding: 1mm 1.5mm; gap: 1.5mm; }
  .qr-layout .qr { width: 17mm; height: 17mm; flex-shrink: 0; image-rendering: pixelated; }
  .qr-layout .info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 0.5mm; overflow: hidden; }
  .qr-layout .name { font-size: 5.5pt; font-weight: 700; line-height: 1.15; max-height: 10mm; overflow: hidden; word-break: break-word; color: #000; }
  .qr-layout .price { font-size: 7.5pt; font-weight: 900; color: #000; white-space: nowrap; }

  /* ========== SCREEN PREVIEW ========== */
  .preview-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #1a1a2e; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; z-index: 999; font-family: -apple-system, sans-serif; }
  .preview-bar span { color: #a78bfa; font-size: 12px; }
  .preview-bar b { color: #e2e8f0; font-size: 13px; }
  .preview-bar button { background: #7c3aed; color: #fff; border: none; padding: 10px 24px; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; }
  .preview-bar button:hover { background: #6d28d9; }
  .setup-info { max-width: 600px; margin: 20px auto; padding: 16px 20px; background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; font-family: -apple-system, sans-serif; font-size: 12px; color: #555; line-height: 1.6; }
  .setup-info h3 { font-size: 14px; color: #1a1a2e; margin-bottom: 8px; }
  .screen-preview { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; padding: 20px; padding-bottom: 80px; }
  .screen-preview .label { border: 1px dashed #ccc; border-radius: 2px; display: inline-flex !important; }

  @media print {
    .preview-bar, .setup-info, .screen-preview { display: none !important; }
    .print-grid { display: table !important; }
    body { background: #fff; }
  }
  @media screen {
    .print-grid { display: none; }
  }
</style>
</head>
<body>

<div class="setup-info">
  <h3>Configuracao para ${cols}x etiquetas 33x21mm</h3>
  <ol>
    <li>Na impressora Bematech: tamanho papel = <b>${sheetW}mm x ${LABEL_H}mm</b></li>
    <li>No Chrome: Ctrl+P > Mais configuracoes</li>
    <li>Tamanho: <b>${sheetW} x ${LABEL_H} mm</b> | Margens: <b>Nenhuma</b> | Escala: <b>100%</b></li>
    <li>Desmarque: Cabecalhos e rodapes</li>
  </ol>
</div>

<div class="screen-preview">
${labels.join('\n')}
</div>

<!-- PRINT: Table layout garante alinhamento perfeito sem margem -->
<table class="print-grid"><tbody>
${(() => {
  let rows = '';
  for (let i = 0; i < quantity; i++) {
    if (i % cols === 0) rows += '<tr>';
    rows += `<td>${labels[i]}</td>`;
    if (i % cols === cols - 1 || i === quantity - 1) {
      // Pad remaining cells
      const remaining = cols - (i % cols) - 1;
      if (i === quantity - 1 && remaining > 0) {
        for (let j = 0; j < remaining; j++) rows += '<td></td>';
      }
      rows += '</tr>';
    }
  }
  return rows;
})()}
</tbody></table>

<div class="preview-bar">
  <div>
    <span>Etiqueta ${sheetW}x${LABEL_H}mm (${useQR ? 'QR Code' : 'Codigo de barras'})</span><br>
    <b>${product.name} ${showPrice ? '| ' + priceText : ''}</b>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <span>${quantity} etiqueta${quantity > 1 ? 's' : ''}</span>
    <button onclick="window.print()">Imprimir</button>
  </div>
</div>

${!useQR ? `<script>
document.querySelectorAll('.barcode').forEach(function(el) {
  try {
    JsBarcode(el, "${barcodeData}", {
      format: "${jsFormat}",
      width: 2,
      height: 35,
      margin: 4,
      marginTop: 1,
      marginBottom: 0,
      marginLeft: 8,
      marginRight: 8,
      fontSize: 8,
      textMargin: 1,
      displayValue: true,
      font: "Arial",
      fontOptions: "bold",
      textAlign: "center",
      background: "#ffffff",
      lineColor: "#000000",
      flat: false
    });
  } catch(e) {
    try {
      JsBarcode(el, "${barcodeData}", {
        format: "CODE128",
        width: 2,
        height: 35,
        margin: 4,
        marginLeft: 8,
        marginRight: 8,
        fontSize: 8,
        textMargin: 1,
        displayValue: true,
        font: "Arial",
        fontOptions: "bold",
        background: "#ffffff",
        lineColor: "#000000"
      });
    } catch(e2) { el.innerHTML = '<text x="50%" y="50%" text-anchor="middle" font-size="8" fill="red">Erro barcode</text>'; }
  }
});
<\/script>` : ''}
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { console.error('label print error:', err); res.status(500).json({ error: 'Erro ao gerar etiqueta' }); }
});

// GET /companies/:id/products/labels/batch?ids=pid1,pid2&cols=3
router.get('/labels/batch', requireAuth, async (req, res) => {
  const { id: company_id } = req.params;
  const { ids, show_name = 'true', show_price = 'true' } = req.query;
  if (!ids) return res.status(400).json({ error: 'Informe ids separados por virgula' });
  const productIds = ids.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (productIds.length === 0) return res.status(400).json({ error: 'Nenhum id valido' });
  try {
    const result = await pool.query(
      `SELECT id, name, price, barcode, barcode_format, sku FROM products
       WHERE id = ANY($1::uuid[]) AND company_id = $2 AND barcode IS NOT NULL ORDER BY name`,
      [productIds, company_id]
    );
    res.json({ products: result.rows, label_options: { show_name: show_name === 'true', show_price: show_price === 'true', width_mm: LABEL_W, height_mm: LABEL_H, cols: COLS }, total: result.rows.length, skipped: productIds.length - result.rows.length });
  } catch (err) { console.error('batch label error:', err); res.status(500).json({ error: 'Erro ao buscar produtos' }); }
});

module.exports = router;
