// ============================================================
// AURA. — A home da loja nasce do estoque
//
// Redesign de 09/2026 (Claude Design, loja-modelo Finesse). O princípio:
// tudo que a home mostra sai de colunas que a lojista JÁ preencheu no
// Estoque e no Caixa. Foto e banner melhoram a loja; nunca destravam um
// bloco. Loja sem foto nenhuma continua tendo "Mais vendidos".
//
// Três blocos, três consultas, e a regra de cada um mora AQUI — não no
// template. A vitrine Studio vai ler este mesmo módulo quando for a vez
// dela; escrever a regra nas duas lojas é como elas divergem em silêncio.
//
// Quem chama passa `visibilityWhere` e `exigeFoto` porque a regra de
// visibilidade mora no builder (produto compartilhado de outra empresa
// não pode vazar) e a de foto é a migration 308. Nenhuma das duas se
// reimplementa aqui.
// ============================================================
'use strict';

function bd() { return require('../config/database'); }

const { EM_ESTOQUE, COM_FOTO, filtroDeFoto, VENDIDOS_RECENTES } = require('./catalogoPaginado');

/** Abaixo disto o bloco não aparece: um cartão sozinho lê como defeito. */
const MINIMO_PARA_O_BLOCO = 2;

const LIMITE_MAIS_VENDIDOS = 4;
const LIMITE_ULTIMAS_UNIDADES = 4;
const LIMITE_NOVIDADES = 8;

/** Até quantos dias depois do cadastro a peça ganha o selo NOVO. */
const DIAS_DE_NOVO = 14;

/** As mesmas colunas do builder — o cartão da home é o cartão da grade. */
const COLUNAS = `id, name, description, price, image_url, gallery_urls, category,
  stock_qty, stock_min, created_at, material, medidas, cuidados`;

/**
 * Saldo total da peça, na mesma regra de EM_ESTOQUE: com variante ativa,
 * a soma das variantes; sem, o saldo do próprio produto.
 */
const ESTOQUE_TOTAL = `(
  CASE WHEN EXISTS (
    SELECT 1 FROM product_variants v
     WHERE v.product_id = products.id AND v.is_active = true
  )
  THEN (SELECT COALESCE(SUM(v.stock_qty), 0) FROM product_variants v
         WHERE v.product_id = products.id AND v.is_active = true)
  ELSE products.stock_qty
  END
)`;

/**
 * "Últimas unidades": a peça entra quando o saldo total chegou ao mínimo
 * que a lojista cadastrou — ou a 1, quando ela não cadastrou mínimo.
 *
 * Decisão de Caio (02/09/2026). A regra do design era só `stock_qty <=
 * stock_min`, e na Finesse 3 de 1.303 peças têm mínimo cadastrado: o
 * bloco nasceria com 1 peça. A alternativa "até 2 unidades" pegava 62 de
 * 143 — metade da loja em "urgência" não é urgência. GREATEST(min, 1)
 * mostra o que está acabando DE VERDADE, e se ela cadastrar mínimo, o
 * mínimo dela manda.
 */
const NO_LIMITE = `${ESTOQUE_TOTAL} <= GREATEST(COALESCE(products.stock_min, 0), 1)`;

function filtrosBase(visibilityWhere, exigeFoto) {
  return [
    visibilityWhere,
    'products.is_active IS NOT FALSE',
    EM_ESTOQUE,
    filtroDeFoto(exigeFoto),
  ].join('\n       AND ');
}

/**
 * Top N por quantidade vendida no Caixa, sem troca e sem cancelada.
 *
 * Troca fica de fora pelo mesmo motivo da armadilha 5 do CLAUDE.md:
 * `sales.type = 'troca'` registra a peça nova que saiu, não uma venda.
 * Contar troca como venda faria a peça mais trocada virar "mais vendida".
 */
async function maisVendidos({ cid, visibilityWhere, exigeFoto }) {
  // A subconsulta de vendas roda UMA vez por peca (no SELECT interno);
  // filtrar e ordenar pelo apelido evita computa-la de novo no WHERE.
  const sql = `
    SELECT * FROM (
      SELECT ${COLUNAS}, ${VENDIDOS_RECENTES} AS vendidos
        FROM products
       WHERE ${filtrosBase(visibilityWhere, exigeFoto)}
    ) pecas
     WHERE vendidos > 0
     ORDER BY vendidos DESC, created_at DESC
     LIMIT ${LIMITE_MAIS_VENDIDOS}`;
  const { rows } = await bd().query(sql, [cid]);
  return rows;
}

/**
 * Até 4 peças no limite, ordenadas por quem vendeu mais recentemente —
 * o que está acabando E tem procura vem antes do que está acabando por
 * falta dela.
 */
async function ultimasUnidades({ cid, visibilityWhere, exigeFoto }) {
  const sql = `
    SELECT ${COLUNAS}, ${ESTOQUE_TOTAL} AS restam, ${VENDIDOS_RECENTES} AS vendidos
      FROM products
     WHERE ${filtrosBase(visibilityWhere, exigeFoto)}
       AND ${NO_LIMITE}
     ORDER BY vendidos DESC, restam ASC, created_at DESC
     LIMIT ${LIMITE_ULTIMAS_UNIDADES}`;
  const { rows } = await bd().query(sql, [cid]);
  return rows;
}

/** Os últimos cadastros. O selo NOVO é decidido por peça, em ehNovo. */
async function novidades({ cid, visibilityWhere, exigeFoto }) {
  const sql = `
    SELECT ${COLUNAS}
      FROM products
     WHERE ${filtrosBase(visibilityWhere, exigeFoto)}
     ORDER BY created_at DESC
     LIMIT ${LIMITE_NOVIDADES}`;
  const { rows } = await bd().query(sql, [cid]);
  return rows;
}

/**
 * A capa de cada categoria de topo quando a lojista não subiu banner:
 * a foto da peça mais vendida daquela subárvore. Sempre com foto, mesmo
 * em loja que não exige foto — capa de categoria sem imagem é o ladrilho
 * de cor, não um placeholder cinza.
 *
 * Devolve { [path da raiz]: url }. Raiz sem peça vendida cai na peça mais
 * recente com foto; raiz sem peça com foto não entra no mapa.
 */
async function capasDasCategorias({ cid, visibilityWhere, exigeFoto }) {
  // As pecas visiveis ficam numa CTE SEM join: visibilityWhere, EM_ESTOQUE
  // e COM_FOTO dizem `company_id` e `products.` sem alias, e ao lado de
  // product_categories (que tambem tem company_id) o Postgres devolveria
  // 42702, coluna ambigua. Mesma armadilha que ja derrubou a arvore.
  const sql = `
    WITH pecas AS (
      SELECT products.id, products.image_url, products.gallery_urls, products.created_at,
             ${VENDIDOS_RECENTES} AS vendidos
        FROM products
       WHERE ${filtrosBase(visibilityWhere, exigeFoto)}
         AND ${COM_FOTO}
    )
    SELECT DISTINCT ON (raiz.path)
           raiz.path AS caminho,
           COALESCE(NULLIF(btrim(p.image_url), ''), p.gallery_urls->>0) AS url
      FROM product_categories raiz
      JOIN product_categories d
        ON d.company_id = raiz.company_id AND d.type = raiz.type
       AND (d.id = raiz.id OR left(d.path, length(raiz.path) + 1) = raiz.path || '/')
      JOIN product_category_links l ON l.category_id = d.id AND l.is_primary
      JOIN pecas p ON p.id = l.product_id
     WHERE raiz.company_id = $1
       AND raiz.type = 'product'
       AND raiz.parent_id IS NULL
       AND raiz.path IS NOT NULL
     ORDER BY raiz.path, p.vendidos DESC, p.created_at DESC`;
  const { rows } = await bd().query(sql, [cid]);
  const mapa = {};
  for (const r of rows) if (r.url) mapa[r.caminho] = r.url;
  return mapa;
}

/** A peça foi cadastrada há menos de DIAS_DE_NOVO dias? */
function ehNovo(createdAt, agora) {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  const ref = agora instanceof Date ? agora.getTime() : Date.now();
  return ref - t < DIAS_DE_NOVO * 24 * 60 * 60 * 1000;
}

/** Lista abaixo do mínimo vira vazia: o cliente não precisa saber do limiar. */
function aplicarMinimo(lista, minimo = MINIMO_PARA_O_BLOCO) {
  const l = Array.isArray(lista) ? lista : [];
  return l.length >= minimo ? l : [];
}

/**
 * Os três blocos, já na forma do payload. `mapear` é montarProdutoPublico
 * com os mapas de variante e categoria já carregados — o cartão da home
 * tem que ser IDÊNTICO ao da grade, e o único jeito garantido é passar
 * pela mesma função.
 *
 * Erro de banco aqui não derruba a loja: a home volta sem os blocos e o
 * erro vai pro log com o código, sempre. Silêncio já escondeu bug de SQL
 * em produção duas vezes (ver facetasDoCatalogo).
 */
async function montarHome({ cid, visibilityWhere, exigeFoto, mapear, agora }) {
  const vazio = { mais_vendidos: [], ultimas_unidades: [], novidades: [] };
  let mv = [], uu = [], nv = [];
  try {
    [mv, uu, nv] = await Promise.all([
      maisVendidos({ cid, visibilityWhere, exigeFoto }),
      ultimasUnidades({ cid, visibilityWhere, exigeFoto }),
      novidades({ cid, visibilityWhere, exigeFoto }),
    ]);
  } catch (e) {
    console.error('[home] consulta falhou (' + e.code + '), home sai sem blocos:', e.message);
    return vazio;
  }
  const m = typeof mapear === 'function' ? mapear : (p) => p;
  return {
    mais_vendidos: aplicarMinimo(mv).map((p) => Object.assign(m(p), { vendidos: Number(p.vendidos) || 0 })),
    ultimas_unidades: aplicarMinimo(uu).map((p) => Object.assign(m(p), { restam: Number(p.restam) || 0 })),
    novidades: nv.map((p) => Object.assign(m(p), { is_new: ehNovo(p.created_at, agora) })),
  };
}

module.exports = {
  MINIMO_PARA_O_BLOCO, LIMITE_MAIS_VENDIDOS, LIMITE_ULTIMAS_UNIDADES, LIMITE_NOVIDADES, DIAS_DE_NOVO,
  ESTOQUE_TOTAL, NO_LIMITE,
  maisVendidos, ultimasUnidades, novidades, capasDasCategorias,
  ehNovo, aplicarMinimo, montarHome,
};
