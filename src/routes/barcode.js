const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateBarcode } = require('../services/barcode');

// POST /companies/:id/products/:pid/barcode
// Vincula ou atualiza o código de barras/QR de um produto
router.post('/:pid/barcode', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;
  const { code, format } = req.body;

  if (!code || !format) {
    return res.status(400).json({ error: 'code e format são obrigatórios' });
  }

  const validFormats = ['EAN-13', 'EAN-8', 'CODE-128', 'QR'];
  if (!validFormats.includes(format)) {
    return res.status(400).json({ error: `format inválido. Use: ${validFormats.join(', ')}` });
  }

  if (!validateBarcode(code, format)) {
    return res.status(400).json({ error: `Código inválido para o formato ${format}` });
  }

  try {
    // Verificar se o produto pertence à empresa
    const productCheck = await pool.query(
      'SELECT id FROM products WHERE id = $1 AND company_id = $2',
      [product_id, company_id]
    );
    if (productCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }

    // Verificar unicidade do código na empresa (exceto o próprio produto)
    const dupCheck = await pool.query(
      'SELECT id FROM products WHERE company_id = $1 AND barcode = $2 AND id != $3',
      [company_id, code, product_id]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Este código já está vinculado a outro produto' });
    }

    const result = await pool.query(
      `UPDATE products SET barcode = $1, barcode_format = $2::barcode_format, updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING id, name, barcode, barcode_format`,
      [code, format, product_id, company_id]
    );

    res.json({ product: result.rows[0] });
  } catch (err) {
    console.error('barcode upsert error:', err);
    res.status(500).json({ error: 'Erro ao salvar código' });
  }
});

// DELETE /companies/:id/products/:pid/barcode
router.delete('/:pid/barcode', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, pid: product_id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE products SET barcode = NULL, barcode_format = NULL, updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING id, name`,
      [product_id, company_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json({ message: 'Código removido', product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover código' });
  }
});

// GET /companies/:id/products/barcode/:code
// Lookup por código — usado pelo PDV ao escanear
router.get('/barcode/:code', requireAuth, async (req, res) => {
  const { id: company_id, code } = req.params;

  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.description, p.price, p.cost_price,
              p.stock_quantity, p.barcode, p.barcode_format, p.category,
              p.sku, p.active
       FROM products p
       WHERE p.company_id = $1 AND p.barcode = $2 AND p.active = true`,
      [company_id, code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado para este código' });
    }

    res.json({ product: result.rows[0] });
  } catch (err) {
    console.error('barcode lookup error:', err);
    res.status(500).json({ error: 'Erro na busca' });
  }
});

module.exports = router;
