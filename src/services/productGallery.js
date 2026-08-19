// ============================================================
// AURA — Galeria de fotos do produto (S9, migration 290)
//
// Ate 6 fotos por produto, na ordem de exibicao. O indice 0 e a CAPA, e
// `products.image_url` continua espelhando ela — assim todos os
// consumidores atuais de image_url (listagem, carrinho, marketplace,
// notificacao, PDV) seguem funcionando sem serem tocados. Mesmo padrao
// de dual-write que a F0 usa em products.category.
//
// Este modulo e a UNICA fonte da regra. A rota valida chamando daqui, e
// os testes exercitam daqui — nao de uma copia no handler.
// ============================================================
'use strict';

const MAX_FOTOS = 6;

// Aceita http(s) e data URI de imagem. Recusa o resto: um `javascript:`
// no src de <img> nao executa, mas uma URL invalida vira foto quebrada na
// vitrine, e isso o cliente ve.
function urlValida(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s || s.length > 2048) return false;
  return /^https?:\/\/.+/i.test(s) || /^data:image\/[a-z+.-]+;base64,/i.test(s);
}

/**
 * Normaliza o que veio do cliente numa galeria gravavel.
 *
 * @returns {{error: string} | {gallery: string[], cover: string|null}}
 */
function normalizeGallery(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return { error: 'gallery_urls invalido' }; }
  }
  if (arr == null) arr = [];
  if (!Array.isArray(arr)) return { error: 'gallery_urls deve ser uma lista' };

  const limpo = [];
  for (const v of arr) {
    if (!urlValida(v)) return { error: 'Foto invalida na galeria: use uma URL http(s)' };
    const s = String(v).trim();
    // Duplicata nao vira uma posicao a menos no limite de 6: a mesma foto
    // duas vezes no carrossel e erro de quem cadastrou, nao intencao.
    if (!limpo.includes(s)) limpo.push(s);
  }

  if (limpo.length > MAX_FOTOS) {
    return { error: `Maximo de ${MAX_FOTOS} fotos por produto` };
  }

  return { gallery: limpo, cover: limpo.length ? limpo[0] : null };
}

/**
 * Reordena a galeria colocando `url` na frente — e a operacao "definir
 * como capa", que e como a lojista pensa. Devolve null se a foto nao
 * estiver na galeria.
 */
function setCover(gallery, url) {
  const lista = Array.isArray(gallery) ? gallery.slice() : [];
  const i = lista.indexOf(url);
  if (i < 0) return null;
  lista.splice(i, 1);
  lista.unshift(url);
  return lista;
}

module.exports = { MAX_FOTOS, urlValida, normalizeGallery, setCover };
