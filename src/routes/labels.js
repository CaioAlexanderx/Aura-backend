// ============================================================
// AURA. — Etiquetas de produto v3 (FIX DEFINITIVO)
// Problemas resolvidos:
//   1. Margem esquerda: margin-left negativo compensa margem da impressora
//   2. Barcode nao scaneia: width 2→3, height 35→45, quiet zone adequada
//   3. Layout: CSS Grid (mais confiavel que table para impressao)
// Impressora: Bematech LB-1000 / 042 (203dpi)
// Etiqueta: 33mm x 21mm, 3 colunas (99mm largura total)
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

// GET /companies/:id/products/:pid/label/print
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

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Etiquetas Aura - ${quantity} etiqueta${quantity > 1 ? 's' : ''}</title>
${!useQR ? '<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\\/script>' : ''}
<style>
  /* ===== RESET TOTAL ===== */
  @page {
    size: ${sheetW}mm ${LABEL_H}mm;
    margin: 0mm !important;
  }
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html { margin: 0 !important; padding: 0 !important; }
  body {
    margin: 0 !important;
    padding: 0 !important;
    font-family: Arial, Helvetica, sans-serif;
    background: #f5f5f5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ===== PRINT GRID (CSS Grid, no table) ===== */
  .print-grid {
    display: grid;
    grid-template-columns: repeat(${cols}, ${LABEL_W}mm);
    grid-auto-rows: ${LABEL_H}mm;
    width: ${sheetW}mm;
    margin: 0;
    padding: 0;
    /* Compensa margem minima da impressora */
    margin-left: -0.5mm;
  }

  /* ===== LABEL ===== */
  .label {
    width: ${LABEL_W}mm;
    height: ${LABEL_H}mm;
    overflow: hidden;
    background: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0.3mm 0.8mm;
    text-align: center;
  }

  /* Barcode: SVG ocupa toda a largura disponivel */
  .bc-wrap {
    width: 30mm;
    height: ${showName && showPrice ? '11' : showName || showPrice ? '13' : '16'}mm;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .label .barcode {
    width: 100%;
    height: 100%;
  }
  .label .name {
    font-size: 5.5pt;
    font-weight: 700;
    line-height: 1.1;
    max-height: 4mm;
    overflow: hidden;
    word-break: break-word;
    color: #000;
    margin-top: 0.2mm;
  }
  .label .price {
    font-size: 8pt;
    font-weight: 900;
    color: #000;
    white-space: nowrap;
    letter-spacing: 0.3pt;
  }

  /* ===== SCREEN PREVIEW ===== */
  .screen-preview {
    display: flex; flex-wrap: wrap; gap: 4px;
    justify-content: center; padding: 20px; padding-bottom: 80px;
  }
  .screen-preview .label {
    border: 1px dashed #ccc; border-radius: 2px;
    display: inline-flex !important;
  }
  .preview-bar {
    position: fixed; bottom: 0; left: 0; right: 0;
    background: #1a1a2e; padding: 12px 20px;
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; z-index: 999; font-family: -apple-system, sans-serif;
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
    font-family: -apple-system, sans-serif; font-size: 12px;
    color: #555; line-height: 1.6;
  }
  .setup-info h3 { font-size: 14px; color: #1a1a2e; margin-bottom: 8px; }

  @media print {
    .preview-bar, .setup-info, .screen-preview { display: none !important; }
    .print-grid { display: grid !important; }
    body { background: #fff !important; }
  }
  @media screen {
    .print-grid { display: none; }
  }
</style>
</head>
<body>

<div class="setup-info">
  <h3>Impressao de etiquetas 33x21mm (${cols} colunas)</h3>
  <p><b>No Chrome:</b> Ctrl+P &rarr; Mais configuracoes</p>
  <ul>
    <li>Tamanho do papel: <b>${sheetW}mm x ${LABEL_H}mm</b> (ou personalizado)</li>
    <li>Margens: <b>Nenhuma</b></li>
    <li>Escala: <b>100%</b></li>
    <li>Desmarque: <b>Cabecalhos e rodapes</b></li>
  </ul>
  <p style="margin-top:8px;color:#7c3aed"><b>Dica:</b> Se a margem esquerda ainda ficar grande, tente Escala 97-99%.</p>
</div>

<div class="screen-preview">
${Array.from({length: quantity}, (_, i) => `<div class="label"><div class="bc-wrap"><svg class="barcode" id="bc-s${i}"></svg></div>${showName ? `<div class="name">${product.name}</div>` : ''}${showPrice ? `<div class="price">${priceText}</div>` : ''}</div>`).join('\n')}
</div>

<!-- PRINT GRID -->
<div class="print-grid">
${Array.from({length: quantity}, (_, i) => `<div class="label"><div class="bc-wrap"><svg class="barcode" id="bc-p${i}"></svg></div>${showName ? `<div class="name">${product.name}</div>` : ''}${showPrice ? `<div class="price">${priceText}</div>` : ''}</div>`).join('\n')}
</div>

<div class="preview-bar">
  <div>
    <span>Etiqueta ${sheetW}x${LABEL_H}mm | ${jsFormat}</span><br>
    <b>${product.name} ${showPrice ? '| ' + priceText : ''}</b>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <span>${quantity} etiqueta${quantity > 1 ? 's' : ''}</span>
    <button onclick="window.print()">Imprimir</button>
  </div>
</div>

${!useQR ? `<script>
// =============================================
// BARCODE CONFIG — otimizado para scanner 203dpi
// width=3: barras mais largas = mais facil de ler
// height=45: mais alto = scanner acha mais rapido
// margin/quiet zone: minimo 10x bar width por lado
// =============================================
var bcConfig = {
  format: "${jsFormat}",
  width: 3,
  height: 45,
  margin: 2,
  marginTop: 0,
  marginBottom: 0,
  marginLeft: 10,
  marginRight: 10,
  fontSize: 0,
  displayValue: false,
  background: "#ffffff",
  lineColor: "#000000",
  flat: false
};

var fallbackConfig = {
  format: "CODE128",
  width: 3,
  height: 45,
  margin: 2,
  marginLeft: 10,
  marginRight: 10,
  fontSize: 0,
  displayValue: false,
  background: "#ffffff",
  lineColor: "#000000"
};

document.querySelectorAll('.barcode').forEach(function(el) {
  try {
    JsBarcode(el, "${barcodeData}", bcConfig);
  } catch(e) {
    try {
      JsBarcode(el, "${barcodeData}", fallbackConfig);
    } catch(e2) {
      el.innerHTML = '<text x="50%" y="50%" text-anchor="middle" font-size="8" fill="red">Erro</text>';
    }
  }
});
<\\/script>` : ''}
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { console.error('label print error:', err); res.status(500).json({ error: 'Erro ao gerar etiqueta' }); }
});

// GET /companies/:id/products/labels/batch
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
