// ============================================================
// AURA. — Product Image Upload
// POST /companies/:id/products/:pid/image — upload base64 image
// DELETE /companies/:id/products/:pid/image — remove image
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { uploadToR2, deleteFromR2, generateDocKey } = require('../utils/r2Storage');

// POST /:pid/image
router.post('/:pid/image', async (req, res) => {
  const { id: cid, pid } = req.params;
  const { content, content_type } = req.body;
  if (!content) return res.status(400).json({ error: 'content (base64) obrigatorio' });

  try {
    // Verify product exists
    const { rows } = await db.query('SELECT id FROM products WHERE id=$1 AND company_id=$2', [pid, cid]);
    if (!rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });

    const ext = (content_type || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const key = `${cid}/products/${pid}.${ext}`;
    const result = await uploadToR2(key, content, content_type || 'image/jpeg');
    if (!result.success) return res.status(500).json({ error: 'Erro no upload' });

    // Save URL to product
    await db.query('UPDATE products SET image_url=$1, updated_at=NOW() WHERE id=$2 AND company_id=$3',
      [result.url, pid, cid]);

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
    const { rows } = await db.query('SELECT image_url FROM products WHERE id=$1 AND company_id=$2', [pid, cid]);
    if (!rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });

    if (rows[0].image_url) {
      const key = rows[0].image_url.split('/').slice(-2).join('/');
      try { await deleteFromR2(`${cid}/products/${key}`); } catch (_) {}
    }

    await db.query('UPDATE products SET image_url=NULL, updated_at=NOW() WHERE id=$1 AND company_id=$2', [pid, cid]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[product-image] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover imagem' });
  }
});

module.exports = router;
