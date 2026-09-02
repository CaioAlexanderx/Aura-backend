// ============================================================
// AURA. — Fotos de produto em dois tamanhos
//
// Criado: 02/09/2026 (QA da Finesse)
//
// A lojista sobe a foto que o celular tirou: 3024x4032, 1 a 3 MB. A loja
// desenhava esse original num card de 250px, uns 40 por pagina — o Chrome
// congelava so pra decodificar. A Oscar e a Vans servem menos de 100 KB
// por card.
//
// Toda foto de produto passa por aqui e vira DUAS: a grande (ate 1600px no
// lado maior, pra pagina do produto e pro zoom) e a miniatura (ate 640px,
// pra grade, home, sacola). As duas em JPEG: fundo transparente vira
// branco, e a orientacao do EXIF e aplicada antes — foto de celular
// "deitada" era um bug antigo que a compressao resolve de graca.
//
// Quem chama: as rotas de upload (productImage, variantImage) e o job que
// reprocessa o acervo (jobs/001_miniaturas_das_fotos.js). E uma funcao
// so pra que o upload novo e o acervo antigo saiam identicos.
//
// `sharp` e carregado por demanda: se o binario nao existir no ambiente
// (Windows sem o pacote, CI enxuto), quem chama recebe o erro e decide —
// as rotas caem no upload do original, como sempre foi.
// ============================================================
'use strict';

const LADO_GRANDE = 1600;
const LADO_MINI = 640;
const QUALIDADE_GRANDE = 82;
const QUALIDADE_MINI = 78;

let _sharp = null;
function sharp() {
  if (!_sharp) _sharp = require('sharp');
  return _sharp;
}

/**
 * @param {Buffer|string} entrada  bytes da imagem, ou base64.
 * @returns {Promise<{grande:Buffer, mini:Buffer, largura:number, altura:number, bytesOriginais:number}>}
 */
async function derivarFotos(entrada) {
  const original = Buffer.isBuffer(entrada) ? entrada : Buffer.from(String(entrada || ''), 'base64');
  if (!original.length) throw new Error('imagem vazia');
  const s = sharp();
  const base = s(original, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' });
  const meta = await base.metadata();
  const grande = await base.clone()
    .resize({ width: LADO_GRANDE, height: LADO_GRANDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: QUALIDADE_GRANDE, mozjpeg: true })
    .toBuffer();
  const mini = await base.clone()
    .resize({ width: LADO_MINI, height: LADO_MINI, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: QUALIDADE_MINI, mozjpeg: true })
    .toBuffer();
  return { grande, mini, largura: meta.width || 0, altura: meta.height || 0, bytesOriginais: original.length };
}

/**
 * As duas chaves no R2 a partir da chave-base (sem extensao):
 *   "<cid>/products/<pid>" -> "<cid>/products/<pid>.jpg" e ".thumb.jpg"
 * A grande fica na chave canonica (a mesma de sempre, so que menor); a
 * miniatura ganha o sufixo. Um so lugar decide isso pra que a rota de
 * delete e o job achem os arquivos.
 */
function chavesDaFoto(chaveBase) {
  return { grande: chaveBase + '.jpg', mini: chaveBase + '.thumb.jpg' };
}

/** Tira "?v=..." e a extensao de uma chave ou URL: e a chave-base. */
function chaveBaseDe(chaveOuUrl) {
  const semQuery = String(chaveOuUrl || '').split('?')[0];
  return semQuery.replace(/\.(thumb\.)?(jpe?g|png|webp|gif)$/i, '');
}

/**
 * O que as rotas de upload chamam: sobe a grande e a miniatura, e devolve
 * as duas URLs com `?v=` (troca de foto do mesmo produto nao fica presa
 * no cache do navegador). Se o sharp nao conseguir (binario ausente,
 * arquivo corrompido), sobe o original como sempre foi e devolve a
 * miniatura nula — a loja cai na foto grande.
 */
async function salvarFotoEmDoisTamanhos(chaveBase, content, contentType) {
  const { uploadToR2 } = require('./r2Storage');
  const v = '?v=' + Date.now();
  let fotos = null;
  try { fotos = await derivarFotos(content); }
  catch (e) { console.warn('[fotos] sharp falhou, subindo o original:', e.message); }
  if (!fotos) {
    const ext = String(contentType || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const r = await uploadToR2(chaveBase + '.' + ext, content, contentType || 'image/jpeg');
    if (!r.success) return { success: false, error: r.error };
    return { success: true, image_url: r.url + v, image_thumb_url: null, key: r.key, original: true };
  }
  const k = chavesDaFoto(chaveBase);
  const grande = await uploadToR2(k.grande, fotos.grande, 'image/jpeg');
  if (!grande.success) return { success: false, error: grande.error };
  const mini = await uploadToR2(k.mini, fotos.mini, 'image/jpeg');
  if (!mini.success) return { success: false, error: mini.error };
  return {
    success: true, image_url: grande.url + v, image_thumb_url: mini.url + v, key: grande.key,
    largura: fotos.largura, altura: fotos.altura, bytesOriginais: fotos.bytesOriginais, bytes: fotos.grande.length,
  };
}

/** Apaga a grande, a miniatura e o .png antigo (best-effort). */
async function apagarFoto(chaveBase) {
  const { deleteFromR2 } = require('./r2Storage');
  const k = chavesDaFoto(chaveBase);
  for (const key of [k.grande, k.mini, chaveBase + '.png', chaveBase + '.webp']) {
    try { await deleteFromR2(key); } catch (_) { /* best-effort */ }
  }
}

module.exports = { derivarFotos, chavesDaFoto, chaveBaseDe, salvarFotoEmDoisTamanhos, apagarFoto, LADO_GRANDE, LADO_MINI };
