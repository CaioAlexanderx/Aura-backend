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
// 02/09/2026: toda foto vira DUAS (grande + miniatura) — fotosDeProduto.js.
const { salvarFotoEmDoisTamanhos, apagarFoto } = require('../utils/fotosDeProduto');

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
    const salvo = await salvarFotoEmDoisTamanhos(`${ownerCid}/products/${pid}`, content, content_type);
    if (!salvo.success) return res.status(500).json({ error: 'Erro no upload' });

    // Atualiza pelo id real do produto (sem filtrar company_id pois já validamos acima)
    await db.query(
      'UPDATE products SET image_url=$1, image_thumb_url=$2, updated_at=NOW() WHERE id=$3',
      [salvo.image_url, salvo.image_thumb_url, pid]
    );

    res.json({ image_url: salvo.image_url, image_thumb_url: salvo.image_thumb_url, key: salvo.key });
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
      await apagarFoto(`${rows[0].company_id}/products/${pid}`);
    }

    await db.query(
      'UPDATE products SET image_url=NULL, image_thumb_url=NULL, updated_at=NOW() WHERE id=$1',
      [pid]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error('[product-image] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover imagem' });
  }
});

module.exports = router;
