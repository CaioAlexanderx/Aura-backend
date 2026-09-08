// ============================================================
// AURA. — Galeria de fotos do produto, por cor (migration 323)
//
// GET    /companies/:id/products/:pid/images
// POST   /companies/:id/products/:pid/images
// DELETE /companies/:id/products/:pid/images/:imageId
// PATCH  /companies/:id/products/:pid/images/reorder
//
// Ate aqui a peca tinha UMA foto (products.image_url) e cada cor tinha
// UMA (product_variants.image_url, migration 129). Quem vende tenis
// fotografa o de cima, o de lado e a sola — e nao tinha onde por. Agora
// sao ate 4 por cor, mais ate 4 na galeria principal (color_hex null).
//
// ── O QUE NAO PODE QUEBRAR ────────────────────────────────────────────
// A vitrine, o PDV, o carrinho, o marketplace e a notificacao leem
// `products.image_url` e `product_variants.image_url`. NENHUM deles foi
// tocado. A galeria mantem esses campos espelhados:
//   • posicao 0 da principal  -> products.image_url / image_thumb_url
//   • posicao 0 de uma cor    -> image_url de TODAS as variantes ativas
//                                daquela cor (o mesmo que POST /color-image
//                                faz hoje)
// Apagar a capa promove a proxima; apagar a ultima limpa a coluna legada.
// E o mesmo dual-write da migration 290, pela mesma razao: a coluna
// antiga tem leitor demais pra ser trocada de uma vez.
//
// A regra (limite de 4, reempacotamento, ordem) vive em
// services/productImageGallery.js — aqui so tem banco e storage.
//
// visibilityWhere e copia da canonica de products.js, como ja fazem
// productImage.js, variantImage.js e productsVariations.js. Regra de
// visibilidade duplicada e como produto de outra empresa vaza pra rota
// errada quando so uma das copias e corrigida — se mexer numa, mexer em
// todas (CLAUDE.md, armadilha 4).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { randomUUID } = require('crypto');
const db = require('../config/database');
const { salvarFotoEmDoisTamanhos, apagarFoto } = require('../utils/fotosDeProduto');
const {
  MAX_FOTOS,
  normalizarCorHex,
  erroDeLimite,
  proximaPosicao,
  reempacotarAposRemover,
  ordenarPorIds,
  agruparGaleria,
} = require('../services/productImageGallery');

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

/** O produto, se esta empresa pode ve-lo. Devolve { ownerCid } ou null. */
async function produtoVisivel(pid, cid) {
  const { rows } = await db.query(
    `SELECT id, company_id FROM products WHERE ${visibilityWhere('$1', '$2')}`,
    [pid, cid]
  );
  if (!rows.length) return null;
  return { ownerCid: rows[0].company_id };
}

/** As fotos de um par (produto, cor), na ordem. */
async function fotosDoPar(pid, colorHex) {
  const { rows } = await db.query(
    `SELECT id, color_hex, url, thumb_url, position
       FROM product_images
      WHERE product_id = $1
        AND ${colorHex ? 'lower(color_hex) = $2' : 'color_hex IS NULL'}
      ORDER BY position ASC, created_at ASC`,
    colorHex ? [pid, colorHex] : [pid]
  );
  return rows;
}

/**
 * Espelha a capa de uma cor nas variantes ativas dessa cor — a mesma
 * coisa que POST /color-image faz, e por isso a comparacao e em CAIXA
 * ALTA: e assim que o atributo Cor foi gravado desde sempre.
 * `url` null limpa a foto das variantes.
 */
async function espelharNasVariantesDaCor(pid, colorHex, url, thumbUrl) {
  const wantColor = String(colorHex || '').toUpperCase();
  if (!wantColor) return 0;
  const { rows } = await db.query(
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
  const alvos = [];
  for (const v of rows) {
    for (const a of v.attributes || []) {
      const nome = String(a.attribute || '').toLowerCase();
      if ((nome === 'cor' || nome === 'color')
          && String(a.value || '').toUpperCase() === wantColor) {
        alvos.push(v.id);
        break;
      }
    }
  }
  if (!alvos.length) return 0;
  await db.query(
    'UPDATE product_variants SET image_url = $1, image_thumb_url = $2, updated_at = NOW() WHERE id = ANY($3::uuid[])',
    [url, thumbUrl, alvos]
  );
  return alvos.length;
}

/** Espelha a capa da galeria principal em products. `url` null limpa. */
async function espelharNoProduto(pid, url, thumbUrl) {
  await db.query(
    'UPDATE products SET image_url = $1, image_thumb_url = $2, updated_at = NOW() WHERE id = $3',
    [url, thumbUrl, pid]
  );
}

/**
 * Depois de qualquer mudanca no par, a posicao 0 vira a capa legada.
 * Um lugar so decide isso — a compatibilidade e a parte que quebra em
 * silencio, e ela nao pode depender de cada handler lembrar.
 */
async function sincronizarCapa(pid, colorHex, capa) {
  const url = capa ? capa.url : null;
  const thumb = capa ? (capa.thumb_url || null) : null;
  if (colorHex) await espelharNasVariantesDaCor(pid, colorHex, url, thumb);
  else await espelharNoProduto(pid, url, thumb);
}

// ─── GET /:pid/images ────────────────────────────────────────
router.get('/:pid/images', async (req, res) => {
  const { id: cid, pid } = req.params;
  try {
    const prod = await produtoVisivel(pid, cid);
    if (!prod) return res.status(404).json({ error: 'Produto nao encontrado' });

    const { rows } = await db.query(
      `SELECT id, color_hex, url, thumb_url, position
         FROM product_images
        WHERE product_id = $1
        ORDER BY color_hex NULLS FIRST, position ASC, created_at ASC`,
      [pid]
    );
    res.json({ product_id: pid, max_por_cor: MAX_FOTOS, ...agruparGaleria(rows) });
  } catch (err) {
    // 42P01: a migration 323 ainda nao rodou nessa base. A tela abre
    // vazia em vez de dar 500 (CLAUDE.md, armadilha 1).
    if (err.code === '42P01') {
      return res.json({ product_id: pid, max_por_cor: MAX_FOTOS, main: [], by_color: {} });
    }
    console.error('[product-images] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar fotos' });
  }
});

// ─── POST /:pid/images ───────────────────────────────────────
// Body: { content: base64 sem o prefixo data:, content_type, color_hex? }
router.post('/:pid/images', async (req, res) => {
  const { id: cid, pid } = req.params;
  const { content, content_type, color_hex } = req.body || {};

  if (!content) return res.status(400).json({ error: 'content (base64) obrigatorio' });

  const cor = normalizarCorHex(color_hex);
  if (cor.error) return res.status(400).json({ error: cor.error });
  const colorHex = cor.color_hex;

  try {
    const prod = await produtoVisivel(pid, cid);
    if (!prod) return res.status(404).json({ error: 'Produto nao encontrado' });

    const atuais = await fotosDoPar(pid, colorHex);
    const limite = erroDeLimite(colorHex, atuais.length);
    if (limite) return res.status(400).json({ error: limite });

    // O id sai daqui (e nao do DEFAULT do banco) porque a chave no R2 e
    // derivada dele: com o id em maos, o DELETE sabe o arquivo sem
    // guardar a chave numa coluna.
    const imageId = randomUUID();
    const salvo = await salvarFotoEmDoisTamanhos(
      `${prod.ownerCid}/products/${pid}/gallery/${imageId}`, content, content_type
    );
    if (!salvo.success) return res.status(500).json({ error: 'Erro no upload' });

    const position = proximaPosicao(atuais.length);
    const { rows } = await db.query(
      `INSERT INTO product_images (id, company_id, product_id, color_hex, url, thumb_url, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, color_hex, url, thumb_url, position, created_at`,
      [imageId, prod.ownerCid, pid, colorHex, salvo.image_url, salvo.image_thumb_url || null, position]
    );
    const criada = rows[0];

    // Compatibilidade: a primeira foto de um par e a capa que o resto do
    // sistema le. Falhar aqui nao desfaz o upload — a foto ja esta
    // gravada e a tela ja pode mostra-la.
    if (position === 0) {
      await sincronizarCapa(pid, colorHex, criada)
        .catch((e) => console.error('[product-images] espelho da capa:', e.message));
    }

    res.status(201).json({
      id: criada.id,
      url: criada.url,
      thumb_url: criada.thumb_url || null,
      position: criada.position,
      color_hex: criada.color_hex,
      created_at: criada.created_at,
    });
  } catch (err) {
    console.error('[product-images] upload error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar foto' });
  }
});

// ─── PATCH /:pid/images/reorder ──────────────────────────────
// Body: { color_hex: string|null, ids: [...] }
router.patch('/:pid/images/reorder', async (req, res) => {
  const { id: cid, pid } = req.params;
  const { color_hex, ids } = req.body || {};

  const cor = normalizarCorHex(color_hex);
  if (cor.error) return res.status(400).json({ error: cor.error });
  const colorHex = cor.color_hex;

  try {
    const prod = await produtoVisivel(pid, cid);
    if (!prod) return res.status(404).json({ error: 'Produto nao encontrado' });

    const atuais = await fotosDoPar(pid, colorHex);
    const r = ordenarPorIds(atuais, ids);
    if (r.error) return res.status(400).json({ error: r.error });

    // Uma query so: o CASE evita n UPDATEs e evita tambem o estado
    // intermediario em que duas fotos disputam a posicao 0.
    if (r.ordem.length) {
      const casos = r.ordem.map((_, i) => `WHEN $${i * 2 + 2}::uuid THEN $${i * 2 + 3}::smallint`).join(' ');
      const params = [pid];
      r.ordem.forEach((o) => { params.push(o.id, o.position); });
      await db.query(
        `UPDATE product_images SET position = CASE id ${casos} ELSE position END
          WHERE product_id = $1 AND id = ANY($${params.length + 1}::uuid[])`,
        [...params, r.ordem.map((o) => o.id)]
      );
    }

    const finais = await fotosDoPar(pid, colorHex);
    await sincronizarCapa(pid, colorHex, finais[0] || null)
      .catch((e) => console.error('[product-images] espelho da capa:', e.message));

    const { main, by_color } = agruparGaleria(finais);
    res.json({
      reordered: true,
      color_hex: colorHex,
      images: colorHex ? (by_color[colorHex] || []) : main,
    });
  } catch (err) {
    console.error('[product-images] reorder error:', err.message);
    res.status(500).json({ error: 'Erro ao reordenar fotos' });
  }
});

// ─── DELETE /:pid/images/:imageId ────────────────────────────
router.delete('/:pid/images/:imageId', async (req, res) => {
  const { id: cid, pid, imageId } = req.params;
  try {
    const prod = await produtoVisivel(pid, cid);
    if (!prod) return res.status(404).json({ error: 'Produto nao encontrado' });

    const { rows: alvo } = await db.query(
      'SELECT id, color_hex FROM product_images WHERE id = $1 AND product_id = $2',
      [imageId, pid]
    );
    if (!alvo.length) return res.status(404).json({ error: 'Foto nao encontrada' });
    const colorHex = alvo[0].color_hex ? String(alvo[0].color_hex).toLowerCase() : null;

    const antes = await fotosDoPar(pid, colorHex);
    const { mudancas, capa } = reempacotarAposRemover(antes, imageId);

    await db.query('DELETE FROM product_images WHERE id = $1', [imageId]);

    for (const m of mudancas) {
      await db.query('UPDATE product_images SET position = $1 WHERE id = $2', [m.position, m.id]);
    }

    // Capa nova (ou coluna legada limpa quando nao sobrou nenhuma).
    await sincronizarCapa(pid, colorHex, capa)
      .catch((e) => console.error('[product-images] espelho da capa:', e.message));

    // O arquivo sai depois da linha: orfao no R2 custa centavos, linha
    // apontando pra arquivo apagado e foto quebrada na vitrine.
    await apagarFoto(`${prod.ownerCid}/products/${pid}/gallery/${imageId}`)
      .catch((e) => console.error('[product-images] apagar do R2:', e.message));

    res.json({ deleted: true, id: imageId, color_hex: colorHex, remaining: Math.max(0, antes.length - 1) });
  } catch (err) {
    console.error('[product-images] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover foto' });
  }
});

module.exports = router;
