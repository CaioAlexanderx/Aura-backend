// ============================================================
// Job 001 — Miniaturas pro acervo de fotos de produto
//
// Criado: 02/09/2026 (QA da Finesse)
//
// Toda foto subida DEPOIS da migration 317 ja nasce em dois tamanhos
// (rotas de upload -> src/utils/fotosDeProduto.js). Este job cuida do que
// ja existia: products.image_url e product_variants.image_url sem
// image_thumb_url.
//
// Pra cada foto: baixa o original do R2, guarda uma copia de lado
// (`<chave>.orig.<ext>` — nada se perde), sobe a grande na chave
// canonica e a miniatura em `.thumb.jpg`, e grava as duas URLs com
// `?v=` novo (o navegador nao reaproveita o original do cache).
//
// Foto que nao mora no nosso R2 (URL externa) ou que sumiu de la (404)
// recebe image_thumb_url = image_url: a loja segue mostrando o que tem
// e o job nao fica preso nela. Erro de rede/decodificacao fica pendente
// e volta na proxima subida — ate MAX_POR_RODADA fotos por rodada, pra
// uma subida nunca virar uma maratona.
// ============================================================
'use strict';

const { derivarFotos, chavesDaFoto, chaveBaseDe } = require('../src/utils/fotosDeProduto');
const { uploadToR2, R2_CONFIG } = require('../src/utils/r2Storage');

const LOTE = 40;
const PARALELO = 3;
const MAX_POR_RODADA = 400;

function chaveDaUrl(url) {
  const pub = String(R2_CONFIG.publicUrl || '').replace(/\/$/, '');
  const semQuery = String(url || '').split('?')[0];
  if (!pub || !semQuery.startsWith(pub + '/')) return null;
  try { return decodeURIComponent(semQuery.slice(pub.length + 1)); } catch (_) { return null; }
}

async function baixar(url) {
  const r = await fetch(String(url).split('?')[0]);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ao baixar');
  return Buffer.from(await r.arrayBuffer());
}

/** Uma foto. Devolve 'ok' | 'externa' | 'sumiu'. Lanca em erro transitorio. */
async function processar(pool, tabela, linha) {
  const chave = chaveDaUrl(linha.image_url);
  if (!chave) {
    await pool.query(`UPDATE ${tabela} SET image_thumb_url = image_url WHERE id = $1`, [linha.id]);
    return 'externa';
  }
  const original = await baixar(linha.image_url);
  if (!original) {
    await pool.query(`UPDATE ${tabela} SET image_thumb_url = image_url WHERE id = $1`, [linha.id]);
    return 'sumiu';
  }
  const fotos = await derivarFotos(original);
  const base = chaveBaseDe(chave);
  const ext = (chave.split('.').pop() || 'jpg').toLowerCase();
  const copia = await uploadToR2(base + '.orig.' + ext, original, ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
  if (!copia.success) throw new Error('copia do original: ' + copia.error);
  const k = chavesDaFoto(base);
  const grande = await uploadToR2(k.grande, fotos.grande, 'image/jpeg');
  if (!grande.success) throw new Error('grande: ' + grande.error);
  const mini = await uploadToR2(k.mini, fotos.mini, 'image/jpeg');
  if (!mini.success) throw new Error('mini: ' + mini.error);
  const v = '?v=' + Date.now();
  await pool.query(
    `UPDATE ${tabela} SET image_url = $1, image_thumb_url = $2, updated_at = NOW() WHERE id = $3`,
    [grande.url + v, mini.url + v, linha.id],
  );
  return 'ok';
}

async function pendentes(pool, tabela, ignorar, limite) {
  const { rows } = await pool.query(
    `SELECT id, image_url FROM ${tabela}
      WHERE image_url IS NOT NULL AND btrim(image_url) <> '' AND image_thumb_url IS NULL
        AND NOT (id = ANY($1::uuid[]))
      ORDER BY updated_at DESC NULLS LAST
      LIMIT ${limite}`,
    [ignorar],
  );
  return rows;
}

async function contarPendentes(pool) {
  let n = 0;
  for (const tabela of ['products', 'product_variants']) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${tabela} WHERE image_url IS NOT NULL AND btrim(image_url) <> '' AND image_thumb_url IS NULL`,
    );
    n += rows[0] ? rows[0].n : 0;
  }
  return n;
}

async function run({ pool, log }) {
  if (!R2_CONFIG.accessKey || !R2_CONFIG.accountId) {
    return { concluido: false, motivo: 'R2 nao configurado neste ambiente' };
  }
  if (typeof fetch !== 'function') return { concluido: false, motivo: 'sem fetch (Node < 18)' };

  const totais = { ok: 0, externa: 0, sumiu: 0, falha: 0 };
  let feitas = 0;
  for (const tabela of ['products', 'product_variants']) {
    const vistos = [];
    while (feitas < MAX_POR_RODADA) {
      const lote = await pendentes(pool, tabela, vistos, Math.min(LOTE, MAX_POR_RODADA - feitas));
      if (!lote.length) break;
      for (let i = 0; i < lote.length; i += PARALELO) {
        await Promise.all(lote.slice(i, i + PARALELO).map(async (linha) => {
          vistos.push(linha.id);
          feitas++;
          try {
            const r = await processar(pool, tabela, linha);
            totais[r]++;
          } catch (e) {
            totais.falha++;
            log(`${tabela} ${linha.id}: ${e.message}`);
          }
        }));
      }
      log(`${tabela}: ${JSON.stringify(totais)}`);
    }
  }
  const restam = await contarPendentes(pool);
  return { concluido: restam === 0 && totais.falha === 0, ...totais, restam };
}

module.exports = { run, chaveDaUrl, LOTE, PARALELO, MAX_POR_RODADA };
