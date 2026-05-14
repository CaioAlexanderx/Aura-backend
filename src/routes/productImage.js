// ============================================================
// AURA. — Product Image Upload
// POST /companies/:id/products/:pid/image — upload base64 image
// DELETE /companies/:id/products/:pid/image — remove image
//
// FIX (14/05/2026): queries usavam WHERE company_id=$cid direto,
// bloqueando upload/delete de imagens de produtos is_group_shared
// (produto da matriz editado pela filial). Agora usa visibilityWhere
// idêntico ao products.js — bidirecional via group_root.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { uploadToR2, deleteFromR2 } = require('../utils/r2Storage');

// Mesma lógica de visibilidade bidirecional de products.js.
// Produto P visível para empresa X se:
//   P.company_id = X
//   OU (P.is_group_shared E group_root(P.company_id) = group_root(X))
function visibilityWhere(idParam, cidParam) {
  return `id = ${idParam} AND (company_id = ${cidParam} OR (
    is_group_shared = true
    AND company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

// POST /:pid/image
router.post('/:pid/image', async (req, res) => {
  const { id: cid, pid } = req.params;
  const { content, content_type } = req.body;
  if (!content) return res.status(400).json({ error: 'content (base64) obrigatorio' });

  try {
    // Verifica existência respeitando visibilidade de grupo
    const { rows } = await db.query(
      `SELECT id, company_id FROM products WHERE ${visibilityWhere('$1', '$2')}`,
      [pid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });

    const ownerCid = rows[0].company_id; // company_id real do produto (pode ser da matriz)
    const ext = (content_type || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const key = `${ownerCid}/products/${pid}.${ext}`;
    const result = await uploadToR2(key, content, content_type || 'image/jpeg');
    if (!result.success) return res.status(500).json({ error: 'Erro no upload' });

    // Atualiza pelo id real do produto (sem filtrar company_id pois já validamos acima)
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
      `SELECT id, company_id, image_url FROM products WHERE ${visibilityWhere('$1', '$2')}`,
      [pid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });

    if (rows[0].image_url) {
      const ownerCid = rows[0].company_id;
      const key = rows[0].image_url.split('/').slice(-2).join('/');
      try { await deleteFromR2(`${ownerCid}/products/${key}`); } catch (_) {}
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
