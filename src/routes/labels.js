// ============================================================
// AURA. -- Etiquetas v8 (calibracao persistida por loja)
//
// v7: flex-wrap nao garante N por linha em contexto de impressao.
// Solucao: CSS Grid com grid-template-columns: repeat(cols, LABEL_W).
//
// v8: offset/cols calibrados viviam so na query string e no dialogo
// do Chrome — qualquer visita nova voltava ao padrao e a etiqueta
// saia cortada de novo. Agora "Aplicar e imprimir" grava a calibracao
// em companies.pdv_settings (label_offset_mm, label_cols) via save=1
// na propria rota autenticada, e a rota usa o valor salvo como padrao
// quando a URL nao traz offset/cols. Whitelist correspondente em
// pdvSettings.js (PUT la faz merge, nao replace, pra nao resetar isto).
// ============================================================
const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const LABEL_W = 33;
const LABEL_H = 21;
const COLS = 3;

// Calibracao salva da loja (pdv_settings.label_offset_mm / label_cols).
// Fallback nos padroes se nunca calibrada ou se a leitura falhar.
async function readCalibration(company_id) {
  let saved = {};
  try {
    const s = await pool.query('SELECT pdv_settings FROM companies WHERE id=$1', [company_id]);
    saved = (s.rows[0] && s.rows[0].pdv_settings) || {};
  } catch (e) { console.error('label calibration read error:', e.message); }
  return {
    cols: Number.isInteger(Number(saved.label_cols)) && Number(saved.label_cols) >= 1 ? Number(saved.label_cols) : COLS,
    offset_mm: Number.isFinite(Number(saved.label_offset_mm)) ? Number(saved.label_offset_mm) : -2,
  };
}

router.get('/:pid/label', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { show_name = 'true', show_price = 'true', qty = '1' } = req.query;
  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);
  try {
    const result = await pool.query('SELECT id,name,price,barcode,barcode_format,sku,color,size FROM products WHERE id=$1 AND company_id=$2', [product_id, company_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const p = result.rows[0];
    if (!p.barcode) return res.status(422).json({ error: 'Produto sem codigo cadastrado' });
    const cal = await readCalibration(company_id);
    res.json({ product: p, label_options: { show_name: show_name === 'true', show_price: show_price === 'true', quantity, width_mm: LABEL_W, height_mm: LABEL_H, cols: cal.cols, offset_mm: cal.offset_mm } });
  } catch (err) { res.status(500).json({ error: 'Erro ao gerar dados da etiqueta' }); }
});

router.get('/:pid/label/print', requireAuth, async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { show_name = 'true', show_price = 'true', qty = '1', mode = 'barcode', cols: colsParam, offset: offsetParam, save, override_color, override_size } = req.query;
  const quantity = Math.min(Math.max(parseInt(qty) || 1, 1), 200);

  // Calibracao salva da loja — padrao quando a URL nao traz offset/cols.
  const cal = await readCalibration(company_id);
  // parseFloat(x) || padrao trataria offset 0 como ausente ("Sem ajuste" nunca
  // funcionava) — por isso o Number.isFinite explicito.
  const parsedCols = parseInt(colsParam);
  const parsedOffset = parseFloat(offsetParam);
  const cols = Math.min(Math.max(Number.isInteger(parsedCols) ? parsedCols : cal.cols, 1), 5);
  const offset = Math.min(Math.max(Number.isFinite(parsedOffset) ? parsedOffset : cal.offset_mm, -8), 5);
  const sheetW = LABEL_W * cols;

  try {
    if (save === '1' && (offset !== cal.offset_mm || cols !== cal.cols)) {
      try {
        await pool.query(
          `UPDATE companies SET pdv_settings = COALESCE(pdv_settings,'{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify({ label_offset_mm: offset, label_cols: cols }), company_id]
        );
      } catch (e) { console.error('label calibration save error:', e.message); }
    }

    const result = await pool.query('SELECT id,name,price,barcode,barcode_format,sku,color,size FROM products WHERE id=$1 AND company_id=$2', [product_id, company_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const product = result.rows[0];
    if (!product.barcode) return res.status(422).json({ error: 'Produto sem codigo cadastrado' });

    const showName = show_name === 'true';
    const showPrice = show_price === 'true';
    const priceText = product.price ? `R$ ${parseFloat(product.price).toFixed(2).replace('.', ',')}` : '';
    const barcodeData = product.barcode;
    const effectiveSize = (override_size || (product.size ? product.size.trim() : ''));
    const effectiveColor = (override_color || product.color || '');
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // Nome numa linha (CSS corta com reticencias, nao no meio da letra) e
    // tamanho/cor numa linha propria — tamanho e o que a loja le de relance.
    const labelTitle = (function() {
      var n = product.name || '';
      return n.length > 34 ? n.substring(0, 34).trim() + '…' : n;
    })();
    const labelMeta = (function() {
      var sz = effectiveSize;
      var cl = effectiveColor && /^#[0-9A-Fa-f]{6}$/.test(effectiveColor) ? effectiveColor : '';
      if (!sz && !cl) return '';
      var parts = [];
      if (sz) parts.push('Tam ' + sz);
      if (cl) {
        var map = {'#000000':'Preto','#ffffff':'Branco','#ff0000':'Vermelho','#0000ff':'Azul','#00ff00':'Verde','#ffff00':'Amarelo','#ffa500':'Laranja','#ffc0cb':'Rosa','#800080':'Roxo','#a52a2a':'Marrom','#800000':'Vinho','#808080':'Cinza','#000080':'Marinho','#c0c0c0':'Prata','#ffd700':'Dourado','#f5f5dc':'Bege','#ff6347':'Coral','#4b0082':'Indigo','#d2691e':'Caramelo','#40e0d0':'Turquesa','#dc143c':'Carmesim','#ff69b4':'Pink','#daa520':'Mostarda','#8b4513':'Cafe','#ff1493':'Magenta','#8b0000':'Bordo','#006400':'Vd Esc','#191970':'Az Esc','#556b2f':'Oliva','#2f4f4f':'Chumbo','#cd853f':'Areia','#9acd32':'Limao','#964b00':'Marrom','#8be8b3':'Menta','#196110':'Vd Esc','#fa946c':'Salmao','#ff6ec7':'Pink'};
        var colorName = map[cl.toLowerCase()];
        if (!colorName) {
          var r1=parseInt(cl.slice(1,3),16),g1=parseInt(cl.slice(3,5),16),b1=parseInt(cl.slice(5,7),16);
          var best=999,bn='';
          for(var h in map){var r2=parseInt(h.slice(1,3),16),g2=parseInt(h.slice(3,5),16),b2=parseInt(h.slice(5,7),16);var d=Math.sqrt((r1-r2)*(r1-r2)+(g1-g2)*(g1-g2)+(b1-b2)*(b1-b2));if(d<best){best=d;bn=map[h];}}
          colorName = bn;
        }
        parts.push(colorName);
      }
      return parts.join(' • ');
    })();

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

    const labelInner = `<div class="bc-wrap"><svg class="barcode"></svg></div>${showName ? `<div class="name">${esc(labelTitle)}</div>` : ''}${showName && labelMeta ? `<div class="meta">${esc(labelMeta)}</div>` : ''}${showPrice ? `<div class="price">${priceText}</div>` : ''}`;

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
    display: grid;
    grid-template-columns: repeat(${cols}, ${LABEL_W}mm);
    grid-auto-rows: ${LABEL_H}mm;
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
    break-inside: avoid;
  }

  .bc-wrap {
    width: 31.5mm;
    max-height: ${showName && showPrice ? '10.5' : showName || showPrice ? '12.5' : '16'}mm;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  /* Altura do svg inclui os digitos do codigo (displayValue) */
  .bc-wrap svg {
    height: ${showName && showPrice ? '10' : showName || showPrice ? '12' : '15.5'}mm;
  }

  .label .name {
    font-size: 5.5pt; font-weight:700; line-height:1.2;
    max-width:31.5mm; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
    color:#000; margin-top:0.2mm;
  }
  .label .meta {
    font-size: 5pt; font-weight:400; line-height:1.15; letter-spacing:0.2pt;
    max-width:31.5mm; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
    color:#000;
  }
  .label .price {
    font-size: 8pt; font-weight:900; color:#000;
    white-space:nowrap; letter-spacing:0.3pt; margin-top:0.2mm;
  }

  /* ===== SCREEN PREVIEW ===== */
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
  /* Preview: grid espelha o layout de impressao */
  .sim-labels {
    display: grid;
    grid-template-columns: repeat(${cols}, ${LABEL_W}mm);
    grid-auto-rows: ${LABEL_H}mm;
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
    .print-grid { display:grid!important; }
    body { background:#fff!important; }
  }
  @media screen { .print-grid { display:none; } }
</style>
</head>
<body>

<div class="setup-info">
  <h3>Etiquetas ${LABEL_W}x${LABEL_H}mm &mdash; ${jsFormat} &mdash; ${cols} por linha</h3>
  <p style="color:#059669"><b>${barcodeData}</b> &mdash; ${quantity} etiqueta${quantity > 1 ? 's' : ''} (${cols} colunas &times; ${Math.ceil(quantity / cols)} linhas)</p>

  <div class="offset-control">
    <label>Compensar margem da impressora:</label>
    <input type="range" id="offsetRange" min="-6" max="2" step="0.5" value="${offset}" oninput="document.getElementById('offsetVal').textContent=this.value+'mm'; updateSimPreview(this.value);" />
    <span class="val" id="offsetVal">${offset}mm</span>
    <button onclick="applyOffset()">Aplicar e imprimir</button>
    <span class="hint">Arraste ate o codigo ficar centralizado. "Aplicar e imprimir" salva a calibracao para a loja &mdash; vale para todas as maquinas.</span>
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
    Papel: <code>${sheetW}mm x ${LABEL_H}mm</code> (${cols} colunas)
  </p>
</div>

<div class="preview-wrapper">
  <div class="printer-sim">
    <div class="printer-sim-header">
      <span>Simulacao de impressao &mdash; ${cols} etiquetas por linha</span>
      <span style="color:#ef4444;font-weight:600">Zona vermelha = margem do driver</span>
    </div>
    <div class="printer-sim-body">
      <div class="printer-margin-overlay"></div>
      <div class="printer-margin-label">margem</div>
      <div class="sim-labels" id="simLabels">
${Array.from({length: Math.min(quantity, cols * 3)}, () => `        <div class="label">${labelInner}</div>`).join('\n')}
      </div>
    </div>
  </div>
  ${quantity > cols * 3 ? `<p style="text-align:center;padding:8px;color:#94a3b8;font-size:11px">+ ${quantity - cols * 3} etiquetas na impressao</p>` : ''}
</div>

<div class="print-grid">
${Array.from({length: quantity}, () => `<div class="label">${labelInner}</div>`).join('\n')}
</div>

<div class="preview-bar">
  <div>
    <span>${jsFormat} | ${sheetW}x${LABEL_H}mm | ${cols} por linha | offset ${offset}mm</span><br>
    <b>${esc(product.name)} ${showPrice ? '| ' + priceText : ''}</b>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <span>${quantity} etiqueta${quantity > 1 ? 's' : ''}</span>
    <button onclick="window.print()">Imprimir</button>
  </div>
</div>

<script>
var BARCODE_DATA = ${JSON.stringify(barcodeData)};
var FORMAT = "${jsFormat}";

document.querySelectorAll('.barcode').forEach(function(el) {
  try {
    JsBarcode(el, BARCODE_DATA, {
      format: FORMAT,
      width: 1,
      height: 44,
      margin: 0,
      marginTop: 1,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      displayValue: true,
      fontSize: 11,
      textMargin: 0,
      font: "Arial",
      background: "#ffffff",
      lineColor: "#000000",
      flat: false
    });
  } catch(e) {
    try {
      JsBarcode(el, BARCODE_DATA, { format:"CODE128", width:1, height:44, margin:0, marginLeft:0, marginRight:0, displayValue:true, fontSize:11, textMargin:0, background:"#ffffff", lineColor:"#000000" });
    } catch(e2) {
      el.outerHTML = '<div style="font-size:7pt;color:red;padding:2mm">Erro: ' + e2.message + '</div>';
    }
  }
});

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
  url.searchParams.set('save', '1');
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
      `SELECT id,name,price,barcode,barcode_format,sku,color,size FROM products WHERE id=ANY($1::uuid[]) AND company_id=$2 AND barcode IS NOT NULL ORDER BY name`,
      [productIds, company_id]
    );
    const cal = await readCalibration(company_id);
    res.json({ products: result.rows, label_options: { show_name: show_name === 'true', show_price: show_price === 'true', width_mm: LABEL_W, height_mm: LABEL_H, cols: cal.cols, offset_mm: cal.offset_mm }, total: result.rows.length });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar produtos' }); }
});

module.exports = router;
