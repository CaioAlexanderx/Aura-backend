// ============================================================
// AURA. — Etiquetas v6 (transform offset — ignora driver)
//
// PROBLEMA: @page margin negativo depende do driver respeitar.
// Impressoras termicas ignoram e adicionam 1-3mm de margem.
// SOLUCAO: transform: translateX() no grid de impressao.
// O transform desloca fisicamente o conteudo renderizado
// DEPOIS que o driver ja aplicou a margem dele.
// O offset e configuravel pelo usuario via ?offset=-2
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
  const { show_name = 'true', show_price = 'true', qty = '1', mode = 'barcode', cols: colsParam, offset: offsetParam } = req.query;
  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);
  const cols = Math.min(Math.max(parseInt(colsParam) || COLS, 1), 5);
  const sheetW = LABEL_W * cols;
  // offset em mm — negativo empurra pra esquerda, positivo pra direita
  const offset = Math.min(Math.max(parseFloat(offsetParam) || -2, -8), 5);

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

  /* ===== PRINT GRID =====
     transform: translateX() e a chave.
     O driver da impressora adiciona margem ANTES do render.
     O transform desloca o conteudo JA RENDERIZADO pra esquerda,
     compensando a margem que o driver forçou.
     Isso funciona porque transform acontece na camada de pintura,
     nao na camada de layout — o driver nao consegue impedir.
  */
  .print-grid {
    display: flex;
    flex-wrap: wrap;
    width: ${sheetW}mm;
    margin: 0;
    padding: 0;
    transform: translateX(${offset}mm) translateY(-0.5mm);
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
    padding: 0.3mm 0.5mm;
    text-align: center;
    page-break-inside: avoid;
  }

  .bc-wrap {
    width: 32mm;
    max-height: ${showName && showPrice ? '13' : showName || showPrice ? '15' : '17'}mm;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .bc-wrap svg {
    height: ${showName && showPrice ? '11' : showName || showPrice ? '13' : '16'}mm;
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

  /* ===== SCREEN PREVIEW =====
     Simula a margem da impressora para o usuario ver
     como vai ficar ANTES de imprimir
  */
  .preview-wrapper {
    max-width: 600px;
    margin: 0 auto;
    padding: 20px;
    padding-bottom: 80px;
  }
  .printer-sim {
    background: #fff;
    border: 2px solid #e2e8f0;
    border-radius: 8px;
    padding: 0;
    position: relative;
    overflow: hidden;
  }
  .printer-sim-header {
    background: #f1f5f9;
    padding: 6px 12px;
    border-bottom: 1px solid #e2e8f0;
    font-size: 11px;
    color: #64748b;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .printer-sim-body {
    position: relative;
    padding: 0;
  }
  /* Margem simulada da impressora (zona vermelha) */
  .printer-margin-overlay {
    position: absolute;
    top: 0; left: 0; bottom: 0;
    width: 3mm;
    background: repeating-linear-gradient(45deg, rgba(239,68,68,0.08), rgba(239,68,68,0.08) 2px, transparent 2px, transparent 6px);
    border-right: 1px dashed #ef4444;
    z-index: 2;
    pointer-events: none;
  }
  .printer-margin-label {
    position: absolute;
    top: 2px; left: 1px;
    font-size: 7px;
    color: #ef4444;
    writing-mode: vertical-rl;
    z-index: 3;
  }
  /* Labels no preview (com transform aplicado) */
  .sim-labels {
    display: flex;
    flex-wrap: wrap;
    transform: translateX(${offset}mm);
    padding: 0;
  }
  .sim-labels .label {
    border: 1px dashed #cbd5e1;
    border-radius: 2px;
  }

  .preview-bar { position:fixed; bottom:0; left:0; right:0; background:#1a1a2e; padding:12px 20px; display:flex; align-items:center; justify-content:space-between; z-index:999; font-family:-apple-system,sans-serif; }
  .preview-bar span { color:#a78bfa; font-size:12px; }
  .preview-bar b { color:#e2e8f0; font-size:13px; }
  .preview-bar button { background:#7c3aed; color:#fff; border:none; padding:10px 24px; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; }
  .preview-bar button:hover { background:#6d28d9; }
  .setup-info { max-width:600px; margin:20px auto; padding:16px 20px; background:#fff; border-radius:12px; border:1px solid #e2e8f0; font-size:12px; color:#555; line-height:1.6; }
  .setup-info h3 { font-size:14px; color:#1a1a2e; margin-bottom:8px; }
  .setup-info code { background:#f0edff; padding:2px 6px; border-radius:4px; font-size:11px; color:#7c3aed; }

  .offset-control { display:flex; align-items:center; gap:8px; margin-top:12px; padding:12px; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0; flex-wrap:wrap; }
  .offset-control label { font-size:13px; font-weight:600; color:#334155; }
  .offset-control input[type=range] { width:180px; accent-color:#7c3aed; }
  .offset-control .val { font-size:14px; font-weight:700; color:#7c3aed; min-width:50px; text-align:center; }
  .offset-control button { background:#7c3aed; color:#fff; border:none; padding:8px 18px; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer; }
  .offset-control button:hover { background:#6d28d9; }
  .offset-control .hint { font-size:11px; color:#94a3b8; width:100%; margin-top:4px; }

  .presets { display:flex; gap:6px; margin-top:8px; }
  .presets button { background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; padding:6px 12px; border-radius:6px; font-size:11px; cursor:pointer; }
  .presets button:hover { background:#e2e8f0; }
  .presets button.active { background:#7c3aed; color:#fff; border-color:#7c3aed; }

  @media print {
    .preview-bar, .setup-info, .preview-wrapper { display:none!important; }
    .print-grid { display:flex!important; }
    body { background:#fff!important; }
  }
  @media screen { .print-grid { display:none; } }
</style>
</head>
<body>

<div class="setup-info">
  <h3>Etiquetas ${LABEL_W}x${LABEL_H}mm &mdash; ${jsFormat}</h3>
  <p style="color:#059669"><b>${barcodeData}</b> &mdash; ${quantity} etiqueta${quantity > 1 ? 's' : ''} (${cols} colunas)</p>

  <div class="offset-control">
    <label>Compensar margem da impressora:</label>
    <input type="range" id="offsetRange" min="-6" max="2" step="0.5" value="${offset}" oninput="document.getElementById('offsetVal').textContent=this.value+'mm'; updateSimPreview(this.value);" />
    <span class="val" id="offsetVal">${offset}mm</span>
    <button onclick="applyOffset()">Aplicar e imprimir</button>
    <span class="hint">Arraste para a esquerda ate o codigo de barras ficar centralizado na etiqueta. A zona vermelha simula a margem da impressora.</span>
  </div>

  <div class="presets">
    <button onclick="setOffset(0)" ${offset === 0 ? 'class="active"' : ''}>Sem ajuste</button>
    <button onclick="setOffset(-1)" ${offset === -1 ? 'class="active"' : ''}>-1mm</button>
    <button onclick="setOffset(-2)" ${offset === -2 ? 'class="active"' : ''}>-2mm (padrao)</button>
    <button onclick="setOffset(-3)" ${offset === -3 ? 'class="active"' : ''}>-3mm</button>
    <button onclick="setOffset(-4)" ${offset === -4 ? 'class="active"' : ''}>-4mm</button>
  </div>

  <p style="margin-top:10px;font-size:11px;color:#64748b">
    <b>Ctrl+P:</b> Margens=Nenhuma, Escala=100%, Desmarcar cabecalho/rodape.
    Papel: <code>${sheetW}mm x ${LABEL_H}mm</code>
  </p>
</div>

<div class="preview-wrapper">
  <div class="printer-sim">
    <div class="printer-sim-header">
      <span>Simulacao de impressao (com margem da impressora)</span>
      <span style="color:#ef4444;font-weight:600">Zona vermelha = margem do driver</span>
    </div>
    <div class="printer-sim-body">
      <div class="printer-margin-overlay"></div>
      <div class="printer-margin-label">margem</div>
      <div class="sim-labels" id="simLabels">
${Array.from({length: Math.min(quantity, cols * 3)}, (_, i) => `        <div class="label"><div class="bc-wrap"><svg class="barcode" data-idx="s${i}"></svg></div>${showName ? `<div class="name">${product.name}</div>` : ''}${showPrice ? `<div class="price">${priceText}</div>` : ''}</div>`).join('\n')}
      </div>
    </div>
  </div>
  ${quantity > cols * 3 ? `<p style="text-align:center;padding:8px;color:#94a3b8;font-size:11px">+ ${quantity - cols * 3} etiquetas na impressao</p>` : ''}
</div>

<div class="print-grid">
${Array.from({length: quantity}, (_, i) => `<div class="label"><div class="bc-wrap"><svg class="barcode" data-idx="p${i}"></svg></div>${showName ? `<div class="name">${product.name}</div>` : ''}${showPrice ? `<div class="price">${priceText}</div>` : ''}</div>`).join('\n')}
</div>

<div class="preview-bar">
  <div>
    <span>${jsFormat} | ${sheetW}x${LABEL_H}mm | offset ${offset}mm</span><br>
    <b>${product.name} ${showPrice ? '| ' + priceText : ''}</b>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <span>${quantity} etiqueta${quantity > 1 ? 's' : ''}</span>
    <button onclick="window.print()">Imprimir</button>
  </div>
</div>

<script>
var BARCODE_DATA = "${barcodeData}";
var FORMAT = "${jsFormat}";

document.querySelectorAll('.barcode').forEach(function(el) {
  try {
    JsBarcode(el, BARCODE_DATA, {
      format: FORMAT,
      width: 1,
      height: 50,
      margin: 0,
      marginTop: 1,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      displayValue: false,
      background: "#ffffff",
      lineColor: "#000000",
      flat: false
    });
  } catch(e) {
    try {
      JsBarcode(el, BARCODE_DATA, { format:"CODE128", width:1, height:50, margin:0, marginLeft:0, marginRight:0, displayValue:false, background:"#ffffff", lineColor:"#000000" });
    } catch(e2) {
      el.outerHTML = '<div style="font-size:7pt;color:red;padding:2mm">Erro: ' + e2.message + '</div>';
    }
  }
});

// Live preview: atualiza o transform do sim-labels conforme o slider
function updateSimPreview(val) {
  document.getElementById('simLabels').style.transform = 'translateX(' + val + 'mm)';
}

function setOffset(val) {
  document.getElementById('offsetRange').value = val;
  document.getElementById('offsetVal').textContent = val + 'mm';
  updateSimPreview(val);
}

function applyOffset() {
  var val = document.getElementById('offsetRange').value;
  var url = new URL(window.location.href);
  url.searchParams.set('offset', val);
  window.location.href = url.toString();
}
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
