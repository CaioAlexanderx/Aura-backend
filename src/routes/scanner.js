// BE-15 — Lookup de produto por código escaneado (PDV)
// Suporta: leitor USB/HID (envia como texto), câmera via QuaggaJS/ZXing (envia o código decoded)
// O frontend faz a decodificação; o backend apenas resolve o código → produto.

const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// GET /companies/:id/pdv/scan/:code
// Lookup principal — chamado pelo PDV ao receber qualquer código escaneado
router.get('/scan/:code', requireAuth, async (req, res) => {
  const { id: company_id, code } = req.params;

  if (!code || code.trim().length === 0) {
    return res.status(400).json({ error: 'Código não informado' });
  }

  const cleanCode = code.trim();

  try {
    // 1. Tentativa direta pelo barcode
    let result = await pool.query(
      `SELECT p.id, p.name, p.description, p.price, p.cost_price,
              p.stock_quantity, p.barcode, p.barcode_format,
              p.category, p.sku, p.active,
              p.barcode_format AS format
       FROM products p
       WHERE p.company_id = $1 AND p.barcode = $2 AND p.active = true
       LIMIT 1`,
      [company_id, cleanCode]
    );

    // 2. Fallback: busca por SKU
    if (result.rows.length === 0) {
      result = await pool.query(
        `SELECT id, name, description, price, cost_price,
                stock_quantity, barcode, barcode_format,
                category, sku, active
         FROM products
         WHERE company_id = $1 AND sku = $2 AND active = true
         LIMIT 1`,
        [company_id, cleanCode]
      );
    }

    // 3. Fallback: busca textual pelo nome (útil para debug/teclado manual)
    if (result.rows.length === 0) {
      result = await pool.query(
        `SELECT id, name, description, price, cost_price,
                stock_quantity, barcode, barcode_format,
                category, sku, active
         FROM products
         WHERE company_id = $1
           AND active = true
           AND (name ILIKE $2 OR sku ILIKE $2)
         ORDER BY name
         LIMIT 5`,
        [company_id, `%${cleanCode}%`]
      );

      // Retorna lista para o PDV escolher (não é match exato)
      if (result.rows.length > 0) {
        return res.status(207).json({
          match: 'partial',
          message: 'Nenhum código exato encontrado. Sugestões por nome/SKU:',
          suggestions: result.rows,
        });
      }

      return res.status(404).json({
        match: 'none',
        error: 'Produto não encontrado para este código',
        code: cleanCode,
      });
    }

    res.json({
      match: 'exact',
      product: result.rows[0],
    });

  } catch (err) {
    console.error('scanner lookup error:', err);
    res.status(500).json({ error: 'Erro na busca do código' });
  }
});

module.exports = router;
