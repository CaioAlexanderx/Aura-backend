// ============================================================
// AURA. — Product Image Upload
// POST /companies/:id/products/:pid/image — upload base64 image
// DELETE /companies/:id/products/:pid/image — remove image
//
// FIX (14/05/2026): respeita visibilidade de grupo (is_group_shared).
//   Antes, o SELECT/UPDATE filtrava `WHERE company_id=$2` ingenuo, igual
//   ao que products.js fazia ANTES do PR #43 (08/05). Resultado: Davi
//   logado em Villa Branca recebia 404 "Produto nao encontrado" ao tentar
//   trocar a imagem de produto cadastrado na Matriz (com is_group_shared
//   = true, visivel no GET, editavel no PATCH, mas a rota de imagem
//   nunca recebeu o fix). Agora usa visibilityWhere() exportado de
//   products.js — mesmo helper que PATCH/DELETE consomem.
//
//   Bonus: o R2 key usa o company_id REAL do produto (owner canonico)
//   em vez do cid da rota. Isso evita criar arquivos duplicados em paths
//   distintos quando subsidiarias diferentes editam o mesmo produto
//   shared (a image_url canonica sempre aponta para a pasta do owner).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { uploadToR2, deleteFromR2 } = require('../utils/r2Storage');
const { visibilityWhere } = require('./products');

// POST /:pid/image
router.post('/:pid/image', async (req, res) => {
  const { id: cid, pid } = req.params;
  const { content, content_type } = req.body;
  if (!content) return res.status(400).json({ error: 'content (base64) obrigatorio' });

  try {
    // Verifica que o produto existe E é visível pra essa company (incluindo
    // produtos shared do grupo). Retorna company_id pra usar no R2 key.
    const { rows } = await db.query(
      `SELECT id, company_id FROM products WHERE ${visibilityWhere('$1', '$2')}`,
      [pid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });

    const ownerCid = rows[0].company_id;
    const ext = (content_type || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const key = `${ownerCid}/products/${pid}.${ext}`;
    const result = await uploadToR2(key, content, content_type || 'image/jpeg');
    if (!result.success) return res.status(500).json({ error: 'Erro no upload' });

    // Visibilidade ja validada no SELECT — UPDATE so pelo id.
    await db.query(
      'UPDATE products SET image_url=$1, updated_at=NOW() WHERE id=$2',
      [result.url, pid]
    );

    res.json({ image_url: result.url, key: result.key });
  } catch (err) {
    console.error('[product-image] upload error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar imagem' });
  }
});

// DELETE /:pid/image
router.delete('/:pid/image', async (req, res) => {
  const { id: cid, pid } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT image_url, company_id FROM products WHERE ${visibilityWhere('$1', '$2')}`,
      [pid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });

    const { image_url: imageUrl, company_id: ownerCid } = rows[0];
    if (imageUrl) {
      // Key canonica: ${ownerCid}/products/${pid}.${ext}.
      // (a derivacao anterior via split/slice(-2) gerava "products/products/"
      // duplicado quando a URL ja vinha no formato canonico.)
      const ext = imageUrl.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      try { await deleteFromR2(`${ownerCid}/products/${pid}.${ext}`); } catch (_) {}
    }

    await db.query(
      'UPDATE products SET image_url=NULL, updated_at=NOW() WHERE id=$1',
      [pid]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error('[product-image] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover imagem' });
  }
});

module.exports = router;
