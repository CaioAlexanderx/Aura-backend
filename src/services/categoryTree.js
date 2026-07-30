// ============================================================
// AURA. -- Servico de arvore de categorias (F0 Bloco B1)
// Query canonica de arvore (CONTRACT_CATEGORIES.md secao 7), mapeamento
// de erros de trigger/constraint (secao 6), e helpers de movimentacao de
// vinculos produto<->categoria reusados por DELETE ?move_to= e /merge.
//
// Nunca calcula slug/path/depth aqui -- e responsabilidade exclusiva dos
// triggers trg_category_path_maintain / trg_category_path_cascade.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

// Query canonica -- contrato secao 7. left(path, ...) em vez de
// LIKE ... ESCAPE '\'' (a variante da spec v2 esta superada, secao 6.5
// do briefing): mesma regra que trg_category_path_cascade usa internamente.
const TREE_QUERY = `
WITH RECURSIVE tree AS (
  SELECT c.*
  FROM product_categories c
  WHERE c.company_id = $1 AND c.type = 'product' AND c.parent_id IS NULL
  UNION ALL
  SELECT c.*
  FROM product_categories c JOIN tree t ON c.parent_id = t.id
),
totals AS (
  SELECT p.id,
         p.product_count + COALESCE((
           SELECT sum(d.product_count) FROM product_categories d
           WHERE d.company_id = p.company_id
             AND d.type = p.type
             AND d.path IS NOT NULL
             AND left(d.path, length(p.path) + 1) = p.path || '/'
         ), 0) AS product_count_total
  FROM product_categories p
  WHERE p.company_id = $1 AND p.type = 'product' AND p.path IS NOT NULL
)
SELECT t.*, COALESCE(tt.product_count_total, t.product_count) AS product_count_total
FROM tree t LEFT JOIN totals tt ON tt.id = t.id
ORDER BY t.path;
`;

function shapeCategoryNode(row) {
  return {
    id: row.id,
    company_id: row.company_id,
    type: row.type,
    parent_id: row.parent_id,
    name: row.name,
    slug: row.slug,
    path: row.path,
    depth: row.depth,
    sort_order: row.sort_order,
    color: row.color,
    image_url: row.image_url,
    banner_url: row.banner_url,
    is_visible_storefront: row.is_visible_storefront,
    seo_title: row.seo_title,
    seo_description: row.seo_description,
    product_count: row.product_count,
    product_count_total: parseInt(row.product_count_total, 10) || 0,
    children: [],
  };
}

// Monta a arvore aninhada. A query e recursiva ordenada por path, entao o
// pai sempre chega antes do filho na lista de linhas.
function nestTree(rows) {
  const byId = new Map();
  const roots = [];
  for (const row of rows) byId.set(row.id, shapeCategoryNode(row));
  for (const row of rows) {
    const node = byId.get(row.id);
    if (row.parent_id && byId.has(row.parent_id)) {
      byId.get(row.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Ordena filhos por sort_order -- reflete o efeito de /reorder, que a
  // ordenacao por path (lexicografica por slug) sozinha nao capturaria.
  const sortChildren = (nodes) => {
    nodes.sort((a, b) => (a.sort_order - b.sort_order) || String(a.name).localeCompare(String(b.name)));
    nodes.forEach((n) => sortChildren(n.children));
  };
  sortChildren(roots);
  return roots;
}

async function getTree(db, companyId) {
  const { rows } = await db.query(TREE_QUERY, [companyId]);
  return nestTree(rows);
}

// ── Mapeamento de erros --------------------------------------------------
// P0001 (RAISE EXCEPTION em trigger) chega com a string em err.message, nao
// em err.code -- contrato secao 6. Mapear por comparacao de mensagem.
function mapTriggerOrConstraintError(err) {
  if (!err) return null;
  if (err.code === 'P0001') {
    const msg = String(err.message || '');
    if (msg.includes('CATEGORY_CYCLE')) {
      return { status: 422, body: { error: 'Mover categoria para dentro do proprio descendente', code: 'CATEGORY_CYCLE' } };
    }
    if (msg.includes('CATEGORY_CROSS_TENANT')) {
      return { status: 403, body: { error: 'Categoria e produto pertencem a empresas diferentes', code: 'CATEGORY_CROSS_TENANT' } };
    }
    if (msg.includes('CATEGORY_TYPE_MISMATCH')) {
      // Inalcancavel pela API da F0 (tudo e 'product') -- mapeado so pra
      // nao vazar 500 se algo escrever direto na tabela. Contrato secao 6.
      return { status: 422, body: { error: 'Tipo da categoria incompativel com o pai', code: 'CATEGORY_TYPE_MISMATCH' } };
    }
    return null;
  }
  const ref = String(err.constraint || err.message || '');
  if (err.code === '23514' && /product_categories_depth_max/.test(ref)) {
    return { status: 422, body: { error: 'Profundidade maxima de categoria excedida (3 niveis)', code: 'CATEGORY_MAX_DEPTH' } };
  }
  if (err.code === '23505' && /product_categories_unique_sibling|product_categories_company_type_name_key/.test(ref)) {
    return { status: 409, body: { error: 'Ja existe uma categoria com esse nome nesse nivel', code: 'CATEGORY_DUPLICATE' } };
  }
  return null;
}

// Busca o id da categoria conflitante pra enriquecer CATEGORY_DUPLICATE com
// existing_id (contrato secao 6). Best-effort: se nao achar, o caller
// devolve o erro sem existing_id em vez de quebrar a resposta.
async function findSiblingId(db, { companyId, type, parentId, name }) {
  const { rows } = await db.query(
    `SELECT id FROM product_categories
      WHERE company_id = $1 AND type = $2
        AND COALESCE(parent_id, '${ZERO_UUID}'::uuid) = COALESCE($3::uuid, '${ZERO_UUID}'::uuid)
        AND name_norm = lower(btrim($4))
      LIMIT 1`,
    [companyId, type, parentId || null, name]
  );
  return rows[0]?.id || null;
}

// ── Resolucao do destino do DELETE ?move_to= ------------------------------
// Aceita uuid ou nome -- contrato secao 3.1 / briefing secao 5.6.
// Retorna { id } | { ambiguous: [{id,path}] } | null (nao encontrado).
async function resolveMoveTarget(queryable, { companyId, type, raw }) {
  if (isUuid(raw)) {
    const { rows } = await queryable.query(
      'SELECT id, path FROM product_categories WHERE id = $1 AND company_id = $2 AND type = $3',
      [raw.trim(), companyId, type]
    );
    return rows[0] ? { id: rows[0].id } : null;
  }
  const { rows } = await queryable.query(
    `SELECT id, path FROM product_categories
      WHERE company_id = $1 AND type = $2 AND name_norm = lower(btrim($3))`,
    [companyId, type, raw]
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) return { ambiguous: rows.map((r) => ({ id: r.id, path: r.path })) };
  return { id: rows[0].id };
}

// ── Movimentacao de vinculos (DELETE move_to e /merge) --------------------
// INSERT com DO NOTHING (evita violar o indice parcial one_primary), depois
// reafirma a primaria em statement SEPARADO -- a armadilha da secao 6.1 do
// briefing / secao 4 do contrato.
async function moveLinks(client, { sourceIds, targetId }) {
  const { rows: primaryRows } = await client.query(
    'SELECT product_id FROM product_category_links WHERE category_id = ANY($1::uuid[]) AND is_primary',
    [sourceIds]
  );
  const primaryProductIds = primaryRows.map((r) => r.product_id);

  await client.query(
    `INSERT INTO product_category_links (product_id, category_id, is_primary)
       SELECT product_id, $2::uuid, false
         FROM product_category_links WHERE category_id = ANY($1::uuid[])
       ON CONFLICT (product_id, category_id) DO NOTHING`,
    [sourceIds, targetId]
  );
  await client.query(
    'DELETE FROM product_category_links WHERE category_id = ANY($1::uuid[])',
    [sourceIds]
  );
  if (primaryProductIds.length) {
    await client.query(
      `UPDATE product_category_links SET is_primary = true
        WHERE category_id = $1::uuid AND product_id = ANY($2::uuid[])`,
      [targetId, primaryProductIds]
    );
  }
  return { moved_products: primaryProductIds.length };
}

module.exports = {
  isUuid,
  TREE_QUERY,
  getTree,
  nestTree,
  shapeCategoryNode,
  mapTriggerOrConstraintError,
  findSiblingId,
  resolveMoveTarget,
  moveLinks,
};
