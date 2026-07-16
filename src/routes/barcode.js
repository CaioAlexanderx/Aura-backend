// ============================================================
// AURA. — Barcode / QR Code
// fix(schema): B-02 — stock_quantity→stock_qty, active→is_active
// fix(19/06/2026): lookup do scan tambem resolve barcode de VARIANTE.
//   Antes /products/barcode/:code so casava products.barcode com
//   is_active=true. Depois da migration que move barcode pras variants,
//   o pai ativo fica com barcode=NULL e o EAN-13 vive na variante (ou
//   num pai duplicado desativado por merge) -> 404 no scanner.
//   Caso Davi Calcados: troca nao localizava Mormaii (7909937905668) nem
//   Klin Flyer 469 (7909874573449). Agora faz LEFT JOIN em variants
//   ativas e casa p.barcode OR pv.barcode, retornando o pai (+ variante).
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const pool    = require('../config/database');
const { requireAuth, requireCompanyAccess, requireRole } = require('../middleware/auth');
const { validateBarcode } = require('../services/barcode');

// POST /companies/:id/products/:pid/barcode
// Vincula ou atualiza o código de barras/QR de um produto
router.post(
  '/:pid/barcode',
  requireAuth,
  requireCompanyAccess({ roles: ['owner', 'admin', 'member'] }),
  async (req, res) => {
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
      const productCheck = await pool.query(
        'SELECT id FROM products WHERE id = $1 AND company_id = $2',
        [product_id, company_id]
      );
      if (productCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Produto não encontrado' });
      }

      const dupCheck = await pool.query(
        'SELECT id FROM products WHERE company_id = $1 AND barcode = $2 AND id != $3',
        [company_id, code, product_id]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(409).json({ error: 'Este código já está vinculado a outro produto' });
      }

      const result = await pool.query(
        `UPDATE products
         SET barcode = $1, barcode_format = $2::barcode_format, updated_at = NOW()
         WHERE id = $3 AND company_id = $4
         RETURNING id, name, barcode, barcode_format`,
        [code, format, product_id, company_id]
      );

      res.json({ product: result.rows[0] });
    } catch (err) {
      console.error('barcode upsert error:', err);
      res.status(500).json({ error: 'Erro ao salvar código' });
    }
  }
);

// DELETE /companies/:id/products/:pid/barcode
router.delete(
  '/:pid/barcode',
  requireAuth,
  requireCompanyAccess({ roles: ['owner', 'admin', 'member'] }),
  async (req, res) => {
    const { id: company_id, pid: product_id } = req.params;
    try {
      const result = await pool.query(
        `UPDATE products
         SET barcode = NULL, barcode_format = NULL, updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING id, name`,
        [product_id, company_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Produto não encontrado' });
      }
      res.json({ message: 'Código removido', product: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao remover código' });
    }
  }
);

// GET /companies/:id/products/barcode/:code
// Lookup por código — usado pelo PDV/troca ao escanear.
// fix(B-02): stock_quantity→stock_qty, active→is_active
// fix(19/06/2026): casa tambem barcode de variante ativa. Sem isso, pai
//   com barcode=NULL (codigo so na variante) dava 404 no scanner — embora
//   a busca textual em products.js (search) ja achasse via EXISTS(pv).
//   Retorna sempre o produto-pai; matched_variant_id/_sku permitem o
//   PDV/troca pre-selecionar o tamanho escaneado. ORDER BY prefere match
//   no nivel do produto; LIMIT 1 evita ambiguidade quando variantes de
//   tamanhos diferentes compartilham o mesmo EAN.
router.get(
  '/barcode/:code',
  requireAuth,
  requireCompanyAccess(),
  async (req, res) => {
    const { id: company_id, code } = req.params;
    try {
      const result = await pool.query(
        `SELECT p.id, p.name, p.description, p.price, p.cost_price,
                p.stock_qty, p.barcode, p.barcode_format, p.category,
                p.sku, p.is_active,
                pv.id         AS matched_variant_id,
                pv.sku_suffix AS matched_variant_sku
         FROM products p
         LEFT JOIN product_variants pv
                ON pv.product_id = p.id
               AND pv.is_active  = true
               AND pv.barcode    = $2
         WHERE p.company_id = $1
           AND p.is_active  = true
           AND (p.barcode = $2 OR pv.id IS NOT NULL)
         ORDER BY (p.barcode = $2) DESC NULLS LAST
         LIMIT 1`,
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
  }
);

module.exports = router;
