// ============================================================
// AURA. — Variant Image Upload (23/05/2026, +color-image 27/06/2026)
//
// POST   /companies/:id/products/:pid/variant-image
// DELETE /companies/:id/products/:pid/variant-image
//   Identifica a variante por COMBINACAO (color_hex + size_value),
//   NAO por variant_id. Motivo: PUT /variations faz soft-delete +
//   INSERT, criando IDs novos a cada save. Se o frontend guardasse
//   o id da variante, ficaria stale apos cada auto-save.
//
//   Como a combinacao (color_hex, size_value) eh estavel pelo lookup
//   via product_variant_values, o frontend so precisa enviar a tupla
//   e o backend resolve o variant_id ativo no momento.
//
//   Body:
//     { color_hex?: "#FF0000", size_value?: "P",
//       content: base64, content_type: "image/jpeg" }
//
//   Pelo menos um de (color_hex, size_value) deve ser informado.
//
// 27/06/2026 — POST/DELETE /color-image (Frente 2 do fix Davi):
//   POST   /companies/:id/products/:pid/color-image
//   DELETE /companies/:id/products/:pid/color-image
//   Aplica/remove imagem em TODAS as variantes ativas que tem
//   atributo Cor=hex (independente de tamanho). Permite UX nova
//   "foto por COR" em produtos com matrix cor+tamanho, evitando
//   o sub-bug onde subir foto numa variante de combo (cor,tamanho)
//   acertava a variante errada quando havia dups historicas.
//   Body: { color_hex, content, content_type }. Reusa uploadToR2
//   e a visibilidade (group_shared). Mantem POST/DELETE
//   /variant-image legados intactos pra back-compat.
//
// Visibility: replica padrao de productImage.js — produto P
// visivel para empresa X se P.company_id = X OU shared via group.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
// 02/09/2026: toda foto vira DUAS (grande + miniatura) — fotosDeProduto.js.
const { salvarFotoEmDoisTamanhos, apagarFoto, chaveBaseDe } = require('../utils/fotosDeProduto');

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
    if (wantColor && hasColor !== wantColor) return false;
    if (!wantColor && hasColor) return false;
    if (wantSize && hasSize !== wantSize) return false;
    if (!wantSize && hasSize) return false;
    return true;
  });

  if (!matched) return null;
  return { variantId: matched.id, ownerCid };
}

// 27/06/2026 (Frente 2 do fix Davi): resolve TODAS as variantes ativas
// que tem atributo Cor=hex no produto (independente de tamanho).
// Retorna { variantIds: string[], ownerCid } ou null se produto invisivel.
async function resolveVariantsByColor(pid, cid, colorHex) {
  const { rows: prodRows } = await db.query(
    `SELECT id, company_id FROM products WHERE ${visibilityWhere('$1', '$2')}`,
    [pid, cid]
  );
  if (!prodRows.length) return null;
  const ownerCid = prodRows[0].company_id;

  const { rows: varRows } = await db.query(
    `SELECT pv.id,
       COALESCE(json_agg(
         json_build_object('attribute', pvv.attribute_name, 'value', pvv.value)
       ) FILTER (WHERE pvv.id IS NOT NULL), '[]'::json) AS attributes
     FROM product_variants pv
     LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
     WHERE pv.product_id = $1 AND pv.is_active = true
     GROUP BY pv.id`,
    [pid]
  );

  const wantColor = String(colorHex || '').toUpperCase();
  if (!wantColor) return { variantIds: [], ownerCid };

  const variantIds = [];
  for (const v of varRows) {
    const attrs = v.attributes || [];
    for (const a of attrs) {
      const name = String(a.attribute || '').toLowerCase();
      if ((name === 'cor' || name === 'color')
          && String(a.value || '').toUpperCase() === wantColor) {
        variantIds.push(v.id);
        break;
      }
    }
  }
  return { variantIds, ownerCid };
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
    const salvo = await salvarFotoEmDoisTamanhos(`${ownerCid}/products/${pid}/variants/${variantId}`, content, content_type);
    if (!salvo.success) return res.status(500).json({ error: 'Erro no upload' });

    await db.query(
      'UPDATE product_variants SET image_url = $1, image_thumb_url = $2, updated_at = NOW() WHERE id = $3',
      [salvo.image_url, salvo.image_thumb_url, variantId]
    );

    res.json({
      image_url: salvo.image_url,
      image_thumb_url: salvo.image_thumb_url,
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

    await apagarFoto(`${ownerCid}/products/${pid}/variants/${variantId}`);

    await db.query(
      'UPDATE product_variants SET image_url = NULL, image_thumb_url = NULL, updated_at = NOW() WHERE id = $1',
      [variantId]
    );

    res.json({ deleted: true, variant_id: variantId });
  } catch (err) {
    console.error('[variant-image] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover imagem' });
  }
});

// 27/06/2026: POST /:pid/color-image — aplica foto em TODAS variantes
// ativas com atributo Cor=hex (independente de tamanho).
router.post('/:pid/color-image', async (req, res) => {
  const { id: cid, pid } = req.params;
  const { color_hex, content, content_type } = req.body || {};

  if (!content) return res.status(400).json({ error: 'content (base64) obrigatorio' });
  if (!color_hex) return res.status(400).json({ error: 'color_hex obrigatorio' });

  try {
    const resolved = await resolveVariantsByColor(pid, cid, color_hex);
    if (!resolved) return res.status(404).json({ error: 'Produto nao encontrado' });

    const { variantIds, ownerCid } = resolved;
    if (variantIds.length === 0) {
      return res.status(404).json({ error: 'Nenhuma variante ativa com essa cor' });
    }

    // Upload R2 (1 unico arquivo; key inclui hex normalizado UPPERCASE pra
    // evitar colisao entre cores diferentes do mesmo produto)
    const hexKeyPart = String(color_hex).toUpperCase().replace(/[^0-9A-F]/g, '');
    const salvo = await salvarFotoEmDoisTamanhos(`${ownerCid}/products/${pid}/colors/${hexKeyPart}`, content, content_type);
    if (!salvo.success) return res.status(500).json({ error: 'Erro no upload' });

    // Aplica a mesma URL em todas as variantes da cor
    await db.query(
      'UPDATE product_variants SET image_url = $1, image_thumb_url = $2, updated_at = NOW() WHERE id = ANY($3::uuid[])',
      [salvo.image_url, salvo.image_thumb_url, variantIds]
    );

    res.json({
      image_url: salvo.image_url,
      image_thumb_url: salvo.image_thumb_url,
      color_hex: String(color_hex).toUpperCase(),
      variants_affected: variantIds.length,
    });
  } catch (err) {
    console.error('[color-image] upload error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar imagem' });
  }
});

// 27/06/2026: DELETE /:pid/color-image — remove foto de TODAS variantes
// ativas com atributo Cor=hex (zera image_url; remove arquivo do R2
// best-effort, ignorando se nao conseguir).
router.delete('/:pid/color-image', async (req, res) => {
  const { id: cid, pid } = req.params;
  const { color_hex } = req.body || {};

  if (!color_hex) return res.status(400).json({ error: 'color_hex obrigatorio' });

  try {
    const resolved = await resolveVariantsByColor(pid, cid, color_hex);
    if (!resolved) return res.status(404).json({ error: 'Produto nao encontrado' });

    const { variantIds, ownerCid } = resolved;
    if (variantIds.length === 0) {
      return res.status(404).json({ error: 'Nenhuma variante ativa com essa cor' });
    }

    // Pega 1 URL atual pra montar a key do R2 (mesma URL pra todas)
    const { rows: vRows } = await db.query(
      'SELECT image_url FROM product_variants WHERE id = ANY($1::uuid[]) AND image_url IS NOT NULL LIMIT 1',
      [variantIds]
    );
    const currentUrl = vRows[0]?.image_url;
    if (currentUrl) {
      // Padrao /colors/<hex> — mais novo. Fallback: variants/<vid>. A chave
      // vem da URL sem o "?v=" (chaveBaseDe), e apaga grande + miniatura.
      const m = String(currentUrl).split('?')[0].match(/\/([^\/]+\/products\/[^\/]+\/(?:colors|variants)\/[^\/?]+)$/);
      if (m && m[1]) await apagarFoto(chaveBaseDe(m[1]));
    }

    await db.query(
      'UPDATE product_variants SET image_url = NULL, image_thumb_url = NULL, updated_at = NOW() WHERE id = ANY($1::uuid[])',
      [variantIds]
    );

    res.json({
      deleted: true,
      color_hex: String(color_hex).toUpperCase(),
      variants_affected: variantIds.length,
    });
  } catch (err) {
    console.error('[color-image] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover imagem' });
  }
});

module.exports = router;
