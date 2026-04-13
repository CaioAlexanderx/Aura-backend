// ============================================================
// AURA. — Etiquetas de produto (impressao direta)
// P0 #3: Simplificado — apenas 33x21mm com QR Code
// Impressora alvo: Bematech LB-1000 / 042 (203dpi, TSPL2)
// ============================================================
const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// Unico layout suportado: etiqueta 33x21mm com QR
const LABEL_WIDTH = 33;  // mm
const LABEL_HEIGHT = 21; // mm
const QR_SIZE = 17;      // mm (cabe no height com 2mm padding)

// GET /companies/:id/products/:pid/label
// Retorna dados estruturados para uso no frontend
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

// GET /companies/:id/products/:pid/label/print
// Retorna HTML pronto para window.print() na Bematech 33x21
router.get('/:pid/label/print', requireAuth, async (req, res) => {
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

    const showName = show_name === 'true';
    const showPrice = show_price === 'true';
    const priceText = product.price ? `R$ ${parseFloat(product.price).toFixed(2).replace('.', ',')}` : '';
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(product.barcode)}&bgcolor=ffffff&color=000000&margin=1`;

    const labels = [];
    for (let i = 0; i < quantity; i++) {
      labels.push(`<div class="label">
        <img src="${qrUrl}" class="qr" alt="QR">
        <div class="info">
          ${showName ? `<div class="name">${product.name}</div>` : ''}
          ${showPrice ? `<div class="price">${priceText}</div>` : ''}
        </div>
      </div>`);
    }

    // INSTRUCOES para a cliente configurar a Bematech:
    // 1. Instalar driver Bematech LB-1000 no Windows
    // 2. Nas propriedades da impressora > Preferencias > Tamanho do papel: 33mm x 21mm
    // 3. Orientacao: Paisagem (ou retrato dependendo do modelo)
    // 4. No Chrome: Ctrl+P > Impressora: Bematech > Mais config > Tamanho do papel: 33x21
    // 5. Margens: Nenhuma / Minima
    // 6. Escala: 100%

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Etiqueta 33x21 - ${product.name}</title>
<style>
  /* P0 #3: @page exato para Bematech 33x21mm */
  @page {
    margin: 0;
    padding: 0;
    size: ${LABEL_WIDTH}mm ${LABEL_HEIGHT}mm;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    background: #f5f5f5;
  }

  .label {
    width: ${LABEL_WIDTH}mm;
    height: ${LABEL_HEIGHT}mm;
    display: flex;
    flex-direction: row;
    align-items: center;
    padding: 1mm 1.5mm;
    gap: 1.5mm;
    background: #fff;
    page-break-after: always;
    overflow: hidden;
  }
  .label:last-child { page-break-after: auto; }

  .qr {
    width: ${QR_SIZE}mm;
    height: ${QR_SIZE}mm;
    flex-shrink: 0;
    image-rendering: pixelated;
    image-rendering: -webkit-optimize-contrast;
  }

  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.5mm;
    overflow: hidden;
  }

  .name {
    font-size: 5.5pt;
    font-weight: 700;
    line-height: 1.15;
    max-height: 10mm;
    overflow: hidden;
    word-break: break-word;
    color: #000;
  }

  .price {
    font-size: 7.5pt;
    font-weight: 900;
    color: #000;
    white-space: nowrap;
  }

  /* Tela de preview (nao imprime) */
  .preview-bar {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    background: #1a1a2e;
    padding: 12px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    z-index: 999;
    font-family: -apple-system, sans-serif;
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
    font-family: -apple-system, sans-serif; font-size: 12px; color: #555;
    line-height: 1.6;
  }
  .setup-info h3 { font-size: 14px; color: #1a1a2e; margin-bottom: 8px; }
  .setup-info li { margin-bottom: 4px; }

  .label-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    padding: 20px;
    padding-bottom: 80px;
  }
  .label-preview .label {
    border: 1px dashed #ccc;
    border-radius: 2px;
  }

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
    <li>No <b>Painel de Controle > Impressoras</b>, clique com botao direito na Bematech e va em <b>Preferencias de impressao</b></li>
    <li>Defina o tamanho do papel como <b>33mm x 21mm</b> (ou crie um tamanho personalizado)</li>
    <li>Ao imprimir no Chrome: <b>Ctrl+P</b> > selecione a Bematech > <b>Mais configuracoes</b></li>
    <li>Tamanho do papel: <b>33 x 21 mm</b> | Margens: <b>Nenhuma</b> | Escala: <b>100%</b></li>
  </ol>
</div>

<div class="label-preview">
${labels.join('\n')}
</div>

<div class="preview-bar">
  <div>
    <span>Etiqueta 33x21mm</span><br>
    <b>${product.name} ${showPrice ? '| ' + priceText : ''}</b>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <span>${quantity} etiqueta${quantity > 1 ? 's' : ''}</span>
    <button onclick="window.print()">Imprimir</button>
  </div>
</div>

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
// Batch: gera multiplas etiquetas de varios produtos
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
