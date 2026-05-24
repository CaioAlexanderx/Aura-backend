// ============================================================
// AURA. — Variant Image Upload (23/05/2026)
//
// POST   /companies/:id/products/:pid/variant-image
// DELETE /companies/:id/products/:pid/variant-image
//
// Identifica a variante por COMBINACAO (color_hex + size_value),
// NAO por variant_id. Motivo: PUT /variations faz soft-delete +
// INSERT, criando IDs novos a cada save. Se o frontend guardasse
// o id da variante, ficaria stale apos cada auto-save.
//
// Como a combinacao (color_hex, size_value) eh estavel pelo lookup
// via product_variant_values, o frontend so precisa enviar a tupla
// e o backend resolve o variant_id ativo no momento.
//
// Body:
//   { color_hex?: "#FF0000", size_value?: "P",
//     content: base64, content_type: "image/jpeg" }
//
// Pelo menos um de (color_hex, size_value) deve ser informado.
//
// Visibility: replica padrao de productImage.js — produto P
// visivel para empresa X se P.company_id = X OU shared via group.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { uploadToR2, deleteFromR2 } = require('../utils/r2Storage');

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

// Resolve variant_id ativo a partir da combinacao color/size.
// Retorna { variantId, ownerCid } ou null.
async function resolveVariant(pid, cid, colorHex, sizeValue) {
  // 1) Valida produto + visibilidade + captura ownerCid (pode ser matriz)
  const { rows: prodRows } = await db.query(
    `SELECT id, company_id FROM products WHERE ${visibilityWhere('$1', '$2')}`,
    [pid, cid]
  );
  if (!prodRows.length) return null;
  const ownerCid = prodRows[0].company_id;

  // 2) Busca todas as variantes ativas do produto + atributos
  const { rows: varRows } = await db.query(
    `SELECT pv.id,
       COALESCE(json_agg(
         json_build_object('attribute', pvv.attribute_name, 'value', pvv.value)
         ORDER BY pvv.attribute_name
       ) FILTER (WHERE pvv.id IS NOT NULL), '[]'::json) AS attributes
     FROM product_variants pv
     LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
     WHERE pv.product_id = $1 AND pv.is_active = true
     GROUP BY pv.id`,
    [pid]
  );

  // 3) Filtra pela combinacao
  // Match: variante tem TODOS os atributos especificados e
  // NENHUM atributo a mais. Ex: se colorHex=#F00 e sizeValue=null,
  // procuramos variante que so tem Cor=#F00 (sem tamanho).
  const wantColor = colorHex ? String(colorHex).toUpperCase() : null;
  const wantSize  = sizeValue ? String(sizeValue) : null;

  const matched = varRows.find((v) => {
    const attrs = v.attributes || [];
    let hasColor = null, hasSize = null;
    for (const a of attrs) {
      const name = String(a.attribute || '').toLowerCase();
      if (name === 'cor' || name === 'color') hasColor = String(a.value || '').toUpperCase();
      else if (name === 'tamanho' || name === 'size') hasSize = String(a.value || '');
    }
    // Wants color → must match. Wants no color → must not have color.
    if (wantColor && hasColor !== wantColor) return false;
    if (!wantColor && hasColor) return false;
    if (wantSize && hasSize !== wantSize) return false;
    if (!wantSize && hasSize) return false;
    return true;
  });

  if (!matched) return null;
  return { variantId: matched.id, ownerCid };
}

// POST /:pid/variant-image
router.post('/:pid/variant-image', async (req, res) => {
  const { id: cid, pid } = req.params;
  const { color_hex, size_value, content, content_type } = req.body || {};

  if (!content) return res.status(400).json({ error: 'content (base64) obrigatorio' });
  if (!color_hex && !size_value) {
    return res.status(400).json({ error: 'Informe color_hex e/ou size_value' });
  }

  try {
    const resolved = await resolveVariant(pid, cid, color_hex, size_value);
    if (!resolved) return res.status(404).json({ error: 'Variante nao encontrada' });

    const { variantId, ownerCid } = resolved;
    const ext = (content_type || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const key = `${ownerCid}/products/${pid}/variants/${variantId}.${ext}`;
    const result = await uploadToR2(key, content, content_type || 'image/jpeg');
    if (!result.success) return res.status(500).json({ error: 'Erro no upload' });

    await db.query(
      'UPDATE product_variants SET image_url = $1, updated_at = NOW() WHERE id = $2',
      [result.url, variantId]
    );

    res.json({
      image_url: result.url,
      variant_id: variantId,
      color_hex: color_hex || null,
      size_value: size_value || null,
    });
  } catch (err) {
    console.error('[variant-image] upload error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar imagem' });
  }
});

// DELETE /:pid/variant-image
// Body: { color_hex?, size_value? }
router.delete('/:pid/variant-image', async (req, res) => {
  const { id: cid, pid } = req.params;
  const { color_hex, size_value } = req.body || {};

  if (!color_hex && !size_value) {
    return res.status(400).json({ error: 'Informe color_hex e/ou size_value' });
  }

  try {
    const resolved = await resolveVariant(pid, cid, color_hex, size_value);
    if (!resolved) return res.status(404).json({ error: 'Variante nao encontrada' });

    const { variantId, ownerCid } = resolved;

    // Busca image_url atual pra deletar do R2
    const { rows: vRows } = await db.query(
      'SELECT image_url FROM product_variants WHERE id = $1',
      [variantId]
    );
    const currentUrl = vRows[0]?.image_url;
    if (currentUrl) {
      try {
        // Reconstroi key a partir da URL publica (ultimo segmento de path)
        // Padrao: <r2_public>/<ownerCid>/products/<pid>/variants/<vid>.<ext>
        const m = currentUrl.match(/\/([^\/]+\/products\/[^\/]+\/variants\/[^\/]+)$/);
        if (m && m[1]) {
          await deleteFromR2(m[1]);
        }
      } catch (_) { /* swallow — UPDATE abaixo zera URL no banco */ }
    }

    await db.query(
      'UPDATE product_variants SET image_url = NULL, updated_at = NOW() WHERE id = $1',
      [variantId]
    );

    res.json({ deleted: true, variant_id: variantId });
  } catch (err) {
    console.error('[variant-image] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover imagem' });
  }
});

module.exports = router;
