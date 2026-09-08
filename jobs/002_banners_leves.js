// ============================================================
// Job 002 — Banners e capas de categoria leves
//
// Criado: 08/09/2026 (QA das lojas)
//
// Toda arte de banner subida DEPOIS deste PR passa pelo sharp na rota de
// upload (routes/digitalChannel.js -> utils/fotosDeProduto.js). Este job
// cuida do que ja estava no ar: a Davi Calcados abria a home com tres
// PNG de 2 MB cada, antes da primeira foto de produto.
//
// Pra cada arte nossa (no R2) que e PNG/WebP ou passa de LIMITE_BYTES:
// baixa o original, guarda uma copia de lado (`<chave>.orig.<ext>` — nada
// se perde), sobe a versao JPEG na largura da loja em `<chave>.jpg` e
// grava a URL nova com `?v=` (o navegador nao reaproveita o cache).
//
// Arte externa (fora do R2) ou que sumiu de la (404) fica como esta.
// Erro de rede/decodificacao conta como falha e o job volta na proxima
// subida. Roda uma vez (jobs_run) quando termina sem falha.
// ============================================================
'use strict';

const { comprimirArteDaLoja, LARGURA_BANNER, LARGURA_BANNER_MOBILE, LARGURA_CAPA } = require('../src/utils/fotosDeProduto');
const { uploadToR2, R2_CONFIG } = require('../src/utils/r2Storage');
const { chaveDaUrl } = require('./001_miniaturas_das_fotos');

// JPEG ate aqui ja esta leve o bastante pra nao valer o retrabalho.
const LIMITE_BYTES = 400 * 1024;

async function baixar(url) {
  const r = await fetch(String(url).split('?')[0]);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ao baixar');
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Uma arte. Devolve a URL nova, ou null quando nao ha o que fazer
 * (externa, sumiu, ou JPEG ja leve). Lanca em erro transitorio.
 */
async function comprimirNoR2(url, largura) {
  const chave = chaveDaUrl(url);
  if (!chave) return null;
  const original = await baixar(url);
  if (!original) return null;
  const ext = (chave.split('.').pop() || 'jpg').toLowerCase();
  const ehJpeg = ext === 'jpg' || ext === 'jpeg';
  if (ehJpeg && original.length <= LIMITE_BYTES) return null;

  const arte = await comprimirArteDaLoja(original, largura);
  const base = chave.replace(/\.(jpe?g|png|webp|gif)$/i, '');
  const mimeOriginal = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  const copia = await uploadToR2(base + '.orig.' + ext, original, mimeOriginal);
  if (!copia.success) throw new Error('copia do original: ' + copia.error);
  const nova = await uploadToR2(base + '.jpg', arte.buffer, 'image/jpeg');
  if (!nova.success) throw new Error('arte: ' + nova.error);
  return nova.url + '?v=' + Date.now();
}

async function run({ pool, log }) {
  if (!R2_CONFIG.accessKey || !R2_CONFIG.accountId) {
    return { concluido: false, motivo: 'R2 nao configurado neste ambiente' };
  }
  if (typeof fetch !== 'function') return { concluido: false, motivo: 'sem fetch (Node < 18)' };

  const totais = { ok: 0, pulado: 0, falha: 0 };

  // Banners da home: JSON em digital_channel_config.banners, com
  // image_url (larga) e image_url_mobile (quadrada) por item.
  const { rows: lojas } = await pool.query(
    `SELECT company_id, banners FROM digital_channel_config
      WHERE banners IS NOT NULL AND jsonb_typeof(banners) = 'array' AND jsonb_array_length(banners) > 0`,
  );
  for (const loja of lojas) {
    const banners = Array.isArray(loja.banners) ? loja.banners.map((b) => ({ ...b })) : [];
    let mudou = false;
    for (const b of banners) {
      for (const campo of ['image_url', 'image_url_mobile']) {
        if (!b || !b[campo]) continue;
        try {
          const nova = await comprimirNoR2(b[campo], campo === 'image_url_mobile' ? LARGURA_BANNER_MOBILE : LARGURA_BANNER);
          if (nova) { b[campo] = nova; mudou = true; totais.ok++; } else totais.pulado++;
        } catch (e) {
          totais.falha++;
          log(`banner ${loja.company_id} ${campo}: ${e.message}`);
        }
      }
    }
    if (mudou) {
      await pool.query(
        `UPDATE digital_channel_config SET banners = $1::jsonb, updated_at = NOW() WHERE company_id = $2`,
        [JSON.stringify(banners), loja.company_id],
      );
    }
  }

  // Capas de categoria (tira da home).
  const { rows: categorias } = await pool.query(
    `SELECT id, banner_url FROM product_categories WHERE banner_url IS NOT NULL AND btrim(banner_url) <> ''`,
  );
  for (const c of categorias) {
    try {
      const nova = await comprimirNoR2(c.banner_url, LARGURA_CAPA);
      if (nova) {
        await pool.query(`UPDATE product_categories SET banner_url = $1, updated_at = NOW() WHERE id = $2`, [nova, c.id]);
        totais.ok++;
      } else totais.pulado++;
    } catch (e) {
      totais.falha++;
      log(`capa ${c.id}: ${e.message}`);
    }
  }

  log(`banners e capas: ${JSON.stringify(totais)}`);
  return { concluido: totais.falha === 0, ...totais };
}

module.exports = { run, comprimirNoR2, LIMITE_BYTES };
