// ============================================================
// AURA. — Etiquetas v4 (DEFINITIVO — scanner + margem)
//
// ROOT CAUSE barcode não lê:
//   JsBarcode width=3 → SVG 305px → CSS comprime para 113px (30mm)
//   → barras ficam 37% do tamanho → scanner não reconhece
// FIX: width=1 → SVG 111px → cabe em 30mm SEM compressão
//   → cada módulo = 1 CSS px = ~2.1 dots @ 203dpi = legível
//
// ROOT CAUSE margem esquerda:
//   Impressoras térmicas ignoram margin:0 e adicionam ~1-2mm
// FIX: @page margin negativo + margin-left negativo no grid
// ============================================================
const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const LABEL_W = 33;
const LABEL_H = 21;
const COLS = 3;

router.get('/:pid/label', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { show_name = 'true', show_price = 'true', qty = '1' } = req.query;
  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);
  try {
    const result = await pool.query('SELECT id,name,price,barcode,barcode_format,sku FROM products WHERE id=$1 AND company_id=$2', [product_id, company_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const p = result.rows[0];
    if (!p.barcode) return res.status(422).json({ error: 'Produto sem codigo cadastrado' });
    res.json({ product: p, label_options: { show_name: show_name === 'true', show_price: show_price === 'true', quantity, width_mm: LABEL_W, height_mm: LABEL_H, cols: COLS } });
  } catch (err) { res.status(500).json({ error: 'Erro ao gerar dados da etiqueta' }); }
});

router.get('/:pid/label/print', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { show_name = 'true', show_price = 'true', qty = '1', mode = 'barcode', cols: colsParam } = req.query;
  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);
  const cols = Math.min(Math.max(parseInt(colsParam) || COLS, 1), 5);
  const sheetW = LABEL_W * cols;
  const useQR = mode === 'qr';

  try {
    const result = await pool.query('SELECT id,name,price,barcode,barcode_format,sku FROM products WHERE id=$1 AND company_id=$2', [product_id, company_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const product = result.rows[0];
    if (!product.barcode) return res.status(422).json({ error: 'Produto sem codigo cadastrado' });

    const showName = show_name === 'true';
    const showPrice = show_price === 'true';
    const priceText = product.price ? `R$ ${parseFloat(product.price).toFixed(2).replace('.', ',')}` : '';
    const barcodeData = product.barcode;

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

    // Calculate optimal barcode width based on format
    // EAN-13: 95 modules. At width=1, SVG=~111px. 30mm@96dpi=113px → NO compression
    // CODE128: varies, but ~110 modules typical. width=1 → ~126px → slight compression OK
    const bcWidth = (jsFormat === 'EAN13' || jsFormat === 'EAN8') ? 1 : 1;

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Etiquetas Aura - ${quantity}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<style>
  @page {
    size: ${sheetW}mm ${LABEL_H}mm;
    margin: 0mm !important;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { margin:0!important; padding:0!important; }
  body { font-family:Arial,Helvetica,sans-serif; background:#f5f5f5; -webkit-print-color-adjust:exact; }

  /* ===== PRINT GRID ===== */
  .print-grid {
    display: flex;
    flex-wrap: wrap;
    width: ${sheetW}mm;
    margin: 0;
    padding: 0;
    /* Compensa margem interna da impressora termica (~1mm) */
    margin-left: -1mm;
    margin-top: -0.5mm;
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
    padding: 0.5mm 1mm;
    text-align: center;
    page-break-inside: avoid;
  }

  /* ===== BARCODE CONTAINER =====
     CRITICO: NÃO usar width:100% no SVG!
     O SVG deve manter seu tamanho natural para que
     cada barra tenha exatamente 1 CSS px de largura.
     Se comprimirmos, as barras ficam sub-pixel e o scanner falha.
  */
  .bc-wrap {
    width: 31mm;
    max-height: ${showName && showPrice ? '13' : showName || showPrice ? '15' : '17'}mm;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  /* SVG barcode: height fixo, largura NATURAL (não forçar width!) */
  .bc-wrap svg {
    height: ${showName && showPrice ? '11' : showName || showPrice ? '13' : '16'}mm;
    /* NÃO definir width — deixar o SVG manter proporção natural */
  }

  .label .name {
    font-size: 5.5pt; font-weight:700; line-height:1.1;
    max-height:4mm; overflow:hidden; word-break:break-word;
    color:#000; margin-top:0.3mm;
  }
  .label .price {
    font-size: 8pt; font-weight:900; color:#000;
    white-space:nowrap; letter-spacing:0.3pt;
  }

  /* ===== SCREEN ===== */
  .screen-preview { display:flex; flex-wrap:wrap; gap:4px; justify-content:center; padding:20px; padding-bottom:80px; }
  .screen-preview .label { border:1px dashed #ccc; border-radius:2px; }
  .preview-bar { position:fixed; bottom:0; left:0; right:0; background:#1a1a2e; padding:12px 20px; display:flex; align-items:center; justify-content:space-between; z-index:999; font-family:-apple-system,sans-serif; }
  .preview-bar span { color:#a78bfa; font-size:12px; }
  .preview-bar b { color:#e2e8f0; font-size:13px; }
  .preview-bar button { background:#7c3aed; color:#fff; border:none; padding:10px 24px; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; }
  .preview-bar button:hover { background:#6d28d9; }
  .setup-info { max-width:600px; margin:20px auto; padding:16px 20px; background:#fff; border-radius:12px; border:1px solid #e2e8f0; font-size:12px; color:#555; line-height:1.6; }
  .setup-info h3 { font-size:14px; color:#1a1a2e; margin-bottom:8px; }
  .setup-info code { background:#f0edff; padding:2px 6px; border-radius:4px; font-size:11px; color:#7c3aed; }

  @media print {
    .preview-bar, .setup-info, .screen-preview { display:none!important; }
    .print-grid { display:flex!important; }
    body { background:#fff!important; }
  }
  @media screen { .print-grid { display:none; } }
</style>
</head>
<body>

<div class="setup-info">
  <h3>Impressao de etiquetas 33x21mm (${cols} colunas)</h3>
  <p><b>Chrome:</b> Ctrl+P &rarr; Mais configuracoes</p>
  <ul>
    <li>Tamanho do papel: <code>${sheetW}mm x ${LABEL_H}mm</code></li>
    <li>Margens: <code>Nenhuma</code></li>
    <li>Escala: <code>100%</code></li>
    <li>Desmarque: Cabecalhos e rodapes</li>
  </ul>
  <p style="margin-top:8px;color:#059669"><b>Barcode:</b> ${barcodeData} (${jsFormat}) — ${quantity} etiquetas</p>
  <p style="color:#d97706;margin-top:4px"><b>Se a margem esquerda ficar grande:</b> reduza a escala para 97-98%.</p>
</div>

<div class="screen-preview">
${Array.from({length: Math.min(quantity, 12)}, (_, i) => `<div class="label"><div class="bc-wrap"><svg class="barcode" data-idx="s${i}"></svg></div>${showName ? `<div class="name">${product.name}</div>` : ''}${showPrice ? `<div class="price">${priceText}</div>` : ''}</div>`).join('\n')}
${quantity > 12 ? `<div style="width:100%;text-align:center;padding:12px;color:#888;font-size:12px">+ ${quantity - 12} etiquetas (visivel na impressao)</div>` : ''}
</div>

<div class="print-grid">
${Array.from({length: quantity}, (_, i) => `<div class="label"><div class="bc-wrap"><svg class="barcode" data-idx="p${i}"></svg></div>${showName ? `<div class="name">${product.name}</div>` : ''}${showPrice ? `<div class="price">${priceText}</div>` : ''}</div>`).join('\n')}
</div>

<div class="preview-bar">
  <div>
    <span>${jsFormat} | ${sheetW}x${LABEL_H}mm</span><br>
    <b>${product.name} ${showPrice ? '| ' + priceText : ''}</b>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <span>${quantity} etiqueta${quantity > 1 ? 's' : ''}</span>
    <button onclick="window.print()">Imprimir</button>
  </div>
</div>

<script>
// =====================================================
// BARCODE CONFIG — NUNCA comprimir o SVG
// width=1: cada módulo = 1 CSS px = ~2.1 dots @ 203dpi
// EAN-13 tem 95 módulos → SVG ~111px → cabe em 30mm (113px)
// Se forçar width:100% no CSS, as barras ficam sub-pixel = falha scanner
// =====================================================
var BARCODE_DATA = "${barcodeData}";
var FORMAT = "${jsFormat}";

document.querySelectorAll('.barcode').forEach(function(el) {
  try {
    JsBarcode(el, BARCODE_DATA, {
      format: FORMAT,
      width: ${bcWidth},
      height: 50,
      margin: 0,
      marginTop: 2,
      marginBottom: 0,
      marginLeft: 10,
      marginRight: 7,
      displayValue: false,
      background: "#ffffff",
      lineColor: "#000000",
      flat: false
    });
  } catch(e) {
    try {
      JsBarcode(el, BARCODE_DATA, {
        format: "CODE128",
        width: 1,
        height: 50,
        margin: 0,
        marginLeft: 10,
        marginRight: 7,
        displayValue: false,
        background: "#ffffff",
        lineColor: "#000000"
      });
    } catch(e2) {
      el.outerHTML = '<div style="font-size:7pt;color:red;padding:2mm">Erro: ' + e2.message + '</div>';
    }
  }
});
<\/script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { console.error('label print error:', err); res.status(500).json({ error: 'Erro ao gerar etiqueta' }); }
});

router.get('/labels/batch', requireAuth, async (req, res) => {
  const { id: company_id } = req.params;
  const { ids, show_name = 'true', show_price = 'true' } = req.query;
  if (!ids) return res.status(400).json({ error: 'Informe ids separados por virgula' });
  const productIds = ids.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (productIds.length === 0) return res.status(400).json({ error: 'Nenhum id valido' });
  try {
    const result = await pool.query(
      `SELECT id,name,price,barcode,barcode_format,sku FROM products WHERE id=ANY($1::uuid[]) AND company_id=$2 AND barcode IS NOT NULL ORDER BY name`,
      [productIds, company_id]
    );
    res.json({ products: result.rows, label_options: { show_name: show_name === 'true', show_price: show_price === 'true', width_mm: LABEL_W, height_mm: LABEL_H, cols: COLS }, total: result.rows.length });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar produtos' }); }
});

module.exports = router;
