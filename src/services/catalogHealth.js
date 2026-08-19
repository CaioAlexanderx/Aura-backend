// ============================================================
// AURA. — E1: índice de saúde do catálogo (F0)
//
// `GET /catalog/health` do contrato §5. O B2 deixou explicitamente
// atribuído à Onda E ("não implementado aqui").
//
// ── ISTO É PLACAR DO LOJISTA, NÃO RELATÓRIO TÉCNICO ─────────
// "10,3% de cobertura de foto" é lamento. "Feminino: 12 de 80 com foto"
// é meta. Por isso a quebra POR CATEGORIA é a metade que importa — sem
// ela o lojista sabe que o catálogo está mal e não sabe por onde começar.
//
// ── O QUE `categoria` MEDE, E POR QUE ───────────────────────
// Cobertura de categoria mede VÍNCULO NA ÁRVORE, não o texto legado.
// Medir texto daria ~100% hoje e esconderia exatamente o trabalho que a
// fase existe para fazer. Os dois são reportados lado a lado:
//   categoria_arvore — tem vínculo primário (modelo novo)
//   categoria_texto  — tem products.category preenchido (legado)
// Enquanto o wizard não roda, o primeiro fica em 0% e o segundo em 100%.
// Essa distância É o indicador.
//
// ── ESCOPO, E POR QUE ELE DIFERE DO WIZARD ──────────────────
// Aqui: produto ATIVO e não-serviço. Inclui estoque zerado de propósito
// — produto sem estoque continua precisando de foto para quando voltar.
//
// O `analyze` do wizard (categoryMigration.js) usa um escopo mais
// estreito, com `stock_qty > 0`. Logo a contagem de órfãos DESTE
// endpoint pode ser MAIOR que a do wizard. Não é divergência: são
// perguntas diferentes ("o catálogo está apresentável?" vs "o que
// precisa ser migrado agora?"). Documentado para ninguém tentar
// "consertar" a diferença depois.
// ============================================================
'use strict';

const db = require('../config/database');

// Produto que conta para saúde de catálogo. Serviço fica de fora — a F0
// é product-only (DEC-03) e os únicos `unit='srv'` da base são os SKUs
// de plano da própria Aura.
const ESCOPO = `p.is_active IS TRUE AND (p.unit IS NULL OR p.unit <> 'srv')`;

const TEM_TEXTO = `p.category IS NOT NULL AND btrim(p.category) <> ''`;
const TEM_DESCRICAO = `p.description IS NOT NULL AND btrim(p.description) <> ''`;
const TEM_MARCA = `p.brand IS NOT NULL AND btrim(p.brand) <> ''`;

function pct(parte, total) {
  if (!total) return 0;
  return Math.round((parte * 1000) / total) / 10;
}

function cobertura(com, total) {
  return { com, sem: total - com, pct: pct(com, total) };
}

/**
 * Resumo geral do catálogo da empresa.
 * Nunca lança por schema ausente: base sem as migrations 257/258 devolve
 * o resumo com categoria_arvore zerada (CLAUDE.md, armadilhas 1 e 10).
 */
async function resumo(companyId) {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int                                          AS total,
      COUNT(*) FILTER (WHERE ${TEM_TEXTO})::int              AS com_categoria_texto,
      COUNT(*) FILTER (WHERE p.image_url IS NOT NULL)::int    AS com_foto,
      COUNT(*) FILTER (WHERE ${TEM_DESCRICAO})::int          AS com_descricao,
      COUNT(*) FILTER (WHERE p.cost_price IS NOT NULL AND p.cost_price > 0)::int AS com_custo,
      COUNT(*) FILTER (WHERE ${TEM_MARCA})::int              AS com_marca
    FROM products p
    WHERE p.company_id = $1 AND ${ESCOPO}
  `, [companyId]);

  const r = rows[0] || {};
  const total = r.total || 0;

  // Vínculo na árvore: query separada porque a tabela pode não existir.
  let comVinculo = 0;
  let arvoreDisponivel = true;
  try {
    const { rows: v } = await db.query(`
      SELECT COUNT(DISTINCT p.id)::int AS n
        FROM products p
        JOIN product_category_links l ON l.product_id = p.id AND l.is_primary
       WHERE p.company_id = $1 AND ${ESCOPO}
    `, [companyId]);
    comVinculo = v[0] ? v[0].n : 0;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') arvoreDisponivel = false;
    else throw e;
  }

  // Órfão = sem vínculo E sem texto. Não tem categoria por caminho nenhum.
  let orfaos = total - r.com_categoria_texto;
  if (arvoreDisponivel) {
    const { rows: o } = await db.query(`
      SELECT COUNT(*)::int AS n
        FROM products p
       WHERE p.company_id = $1 AND ${ESCOPO}
         AND NOT (${TEM_TEXTO})
         AND NOT EXISTS (
           SELECT 1 FROM product_category_links l WHERE l.product_id = p.id
         )
    `, [companyId]);
    orfaos = o[0] ? o[0].n : orfaos;
  }

  return {
    total,
    cobertura: {
      // O par que conta: quanto do catálogo já está no modelo novo.
      categoria_arvore: cobertura(comVinculo, total),
      categoria_texto:  cobertura(r.com_categoria_texto || 0, total),
      foto:             cobertura(r.com_foto || 0, total),
      descricao:        cobertura(r.com_descricao || 0, total),
      custo:            cobertura(r.com_custo || 0, total),
      marca:            cobertura(r.com_marca || 0, total),
    },
    orfaos,
    arvore_disponivel: arvoreDisponivel,
  };
}

/**
 * Quebra por categoria da árvore — a metade que torna o índice acionável.
 *
 * Conta a SUBÁRVORE de cada nó (o produto de "Feminino > Calçados > Botas"
 * conta em Botas, em Calçados e em Feminino). Contar só o vínculo direto
 * faria o nó pai parecer vazio — a mesma razão de a DEC-01 ter separado
 * product_count de product_count_total.
 */
async function porCategoria(companyId) {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.name, c.path, c.depth,
             COUNT(p.id)::int                                       AS total,
             COUNT(p.id) FILTER (WHERE p.image_url IS NOT NULL)::int AS com_foto,
             COUNT(p.id) FILTER (WHERE ${TEM_DESCRICAO})::int        AS com_descricao
        FROM product_categories c
        -- descendentes de c (inclusive ela): casa pelo prefixo de path
        LEFT JOIN product_categories d
               ON d.company_id = c.company_id
              AND (d.path = c.path OR d.path LIKE c.path || '/%')
        LEFT JOIN product_category_links l ON l.category_id = d.id AND l.is_primary
        LEFT JOIN products p ON p.id = l.product_id AND ${ESCOPO}
       WHERE c.company_id = $1 AND c.type = 'product'
       GROUP BY c.id, c.name, c.path, c.depth
       ORDER BY c.path
    `, [companyId]);

    return rows.map(r => ({
      id: r.id, name: r.name, path: r.path, depth: r.depth,
      total: r.total,
      com_foto: r.com_foto,
      com_descricao: r.com_descricao,
      pct_foto: pct(r.com_foto, r.total),
      pct_descricao: pct(r.com_descricao, r.total),
    }));
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return [];
    throw e;
  }
}

async function health(companyId) {
  const [geral, categorias] = await Promise.all([
    resumo(companyId),
    porCategoria(companyId),
  ]);
  return { ...geral, por_categoria: categorias };
}

module.exports = { health, resumo, porCategoria, ESCOPO };
