// ============================================================
// AURA — catálogo da loja comum, paginado
//
// A loja mandava 500 produtos de uma vez (419 KB na Finesse), desenhava
// os primeiros 60 e escrevia no rodapé "Mais 802 produtos no catálogo —
// use a busca". Para quem está comprando, essa frase diz "não vamos te
// atender, procure em outra loja".
//
// Agora a loja pagina: 24 por página, números embaixo da grade, catálogo
// inteiro alcançável. A página passa a nascer com UMA página de produtos
// em vez de 500 — a Finesse cai de 419 KB para ~30 KB.
//
// Filtro de categoria, busca e ordenação passam a ser do SERVIDOR: com
// paginação real, filtrar só o que está carregado esconderia resultado.
// ============================================================
'use strict';

// Import PREGUICOSO: config/database exige JWT_SECRET no carregamento, e
// as funcoes puras deste arquivo (janela de paginas, normalizacao, ordem)
// precisam ser testaveis sem banco e sem ambiente.
function bd() { return require('../config/database'); }

/** Quantos produtos por página. */
const POR_PAGINA = 24;

/** Teto de segurança: ninguém pede 10 mil de uma vez. */
const LIMITE_MAXIMO = 60;

const ORDENS = {
  // A ordem que a lojista curou (featured primeiro) já vem do array de
  // destaques; sem ele, o mais recente na frente.
  destaque: 'created_at DESC',
  novidades: 'created_at DESC',
  preco_asc: 'price ASC NULLS LAST',
  preco_desc: 'price DESC NULLS LAST',
  nome: 'name ASC',
};

function ordemSql(chave) {
  return ORDENS[String(chave || '').trim()] || ORDENS.destaque;
}

/** Normaliza para busca sem acento, igual ao cliente. */
function normalizar(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Uma página do catálogo.
 *
 * `visibilityWhere` chega de fora porque a regra de visibilidade mora no
 * builder e não pode ser reimplementada aqui — duas versões da mesma
 * regra é como produto de outra empresa vaza para a loja errada.
 */
async function paginaDoCatalogo({
  cid, visibilityWhere, offset, limit, categoria, busca, ordem, featuredIds,
}) {
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const lim = Math.min(LIMITE_MAXIMO, Math.max(1, parseInt(limit, 10) || POR_PAGINA));

  const params = [cid];
  const filtros = [visibilityWhere, 'is_active IS NOT FALSE'];

  // `featured_product_ids` nao e so ordenacao: quando a lojista cura a
  // lista, a loja mostra SO aqueles produtos. A pagina 1 vem embutida no
  // HTML com essa restricao, entao a rota tem que aplicar a mesma — senao
  // a pagina 2 traria produto que a pagina 1 nao mostra, e produto curado
  // apareceria duas vezes.
  const curados = Array.isArray(featuredIds) ? featuredIds.map(String).filter(Boolean) : [];
  let ordenacao = ordemSql(ordem);
  if (curados.length > 0) {
    params.push(curados);
    filtros.push(`id::text = ANY($${params.length})`);
    // Ordem curada primeiro; o criterio escolhido decide o desempate.
    ordenacao = `array_position($${params.length}, id::text), ${ordenacao}`;
  }

  if (categoria && String(categoria).trim() && String(categoria).trim() !== 'Todos') {
    params.push(String(categoria).trim());
    filtros.push(`category = $${params.length}`);
  }

  const termos = normalizar(busca).split(/\s+/).filter(Boolean);
  for (const termo of termos) {
    // unaccent não está garantido em toda base; lower + translate cobre
    // os acentos do português sem depender de extensão.
    params.push(`%${termo}%`);
    filtros.push(
      `translate(lower(coalesce(name,'') || ' ' || coalesce(description,'')),
                 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')
       LIKE $${params.length}`,
    );
  }

  const where = filtros.join(' AND ');

  const { rows: contagem } = await bd().query(
    `SELECT COUNT(*)::int AS n FROM products WHERE ${where}`,
    params,
  );
  const total = contagem[0] ? contagem[0].n : 0;

  params.push(lim, off);
  const { rows: produtos } = await bd().query(
    `SELECT id, name, description, price, image_url, gallery_urls, category, stock_qty, created_at
     FROM products
     WHERE ${where}
     ORDER BY ${ordenacao}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { produtos, total, offset: off, limit: lim };
}

/**
 * Números de página para a barra.
 *
 * Com 55 páginas não dá para desenhar 55 botões. Mostra as vizinhas, a
 * primeira, a última, e reticências no meio — o padrão que todo mundo já
 * sabe usar sem aprender.
 */
function janelaDePaginas(atual, totalPaginas, vizinhas = 1) {
  if (totalPaginas <= 1) return [1];
  const p = Math.min(Math.max(1, atual), totalPaginas);
  const set = new Set([1, totalPaginas]);
  for (let i = p - vizinhas; i <= p + vizinhas; i++) {
    if (i >= 1 && i <= totalPaginas) set.add(i);
  }
  const ordenadas = [...set].sort((a, b) => a - b);

  const saida = [];
  let anterior = 0;
  for (const n of ordenadas) {
    if (anterior && n - anterior > 1) saida.push('...');
    saida.push(n);
    anterior = n;
  }
  return saida;
}

module.exports = { POR_PAGINA, LIMITE_MAXIMO, paginaDoCatalogo, janelaDePaginas, normalizar, ordemSql };
