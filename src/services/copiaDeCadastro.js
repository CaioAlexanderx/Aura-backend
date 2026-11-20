// ============================================================
// AURA. — Copia do cadastro de um produto para outra loja do grupo
//
// 20/11/2026 ("Em qual loja o produto entra", B1): extraida, sem mudar uma
// linha de SQL, de services/transferenciaDeEstoque.js (passo 6 e o INSERT
// das variantes do passo 7). Usam esta copia:
//   - a transferencia de estoque (produto que nao existe no destino);
//   - services/produtoNasLojas.js (o mesmo produto cadastrado em 2+ lojas).
//
// O que vai: TODAS as colunas do cadastro que existem na base (lista lida do
// information_schema, menos FORA_DA_COPIA), fotos (product_images),
// fornecedores (product_suppliers) e categorias (criadas no destino pelo
// nome, com a mesma arvore). O produto nasce com estoque 0 e
// is_group_shared = false; a variante nasce ativa e com estoque 0. Quem
// chama soma o estoque depois.
//
// master_sku e copiado (nao esta em FORA_DA_COPIA): e o vinculo "mesmo
// produto em lojas diferentes" (productLinks.js), unico por loja.
// ============================================================
'use strict';

// ─── colunas copiaveis (cache do processo) ───────────────────
// A copia leva TODAS as colunas do cadastro que existem na base (NCM, campos
// fiscais da 437, nota_fiscal da 442, Matcon, marca, fotos...), sem lista
// fixa que envelhece quando uma migration nova adiciona coluna.
const FORA_DA_COPIA = {
  products: new Set([
    'id', 'company_id', 'stock_qty', 'stock_fraction', 'is_group_shared',
    'created_at', 'updated_at', 'import_batch_id', 'barcode',
    'promo_price', 'promo_starts_at', 'promo_ends_at',
  ]),
  product_variants: new Set([
    'id', 'product_id', 'stock_qty', 'is_active', 'deactivated_reason',
    'created_at', 'updated_at', 'promo_price', 'promo_starts_at', 'promo_ends_at',
  ]),
};
let colunasCache = null;
async function colunasCopiaveis(conn) {
  if (colunasCache) return colunasCache;
  const { rows } = await conn.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('products', 'product_variants')
        AND is_generated = 'NEVER'
        AND identity_generation IS NULL
      ORDER BY table_name, ordinal_position`
  );
  const out = { products: [], product_variants: [] };
  for (const r of rows) {
    if (!out[r.table_name] || FORA_DA_COPIA[r.table_name].has(r.column_name)) continue;
    if (!/^[a-z_][a-z0-9_]*$/.test(r.column_name)) continue;
    out[r.table_name].push(r.column_name);
  }
  if (!out.products.includes('name')) {
    // information_schema vazio (permissao/base estranha): o minimo do cadastro.
    out.products = ['name', 'sku', 'category', 'description', 'price', 'cost_price', 'unit', 'ncm'];
  }
  if (!out.product_variants.includes('sku_suffix')) {
    out.product_variants = ['sku_suffix', 'price_override', 'barcode', 'image_url'];
  }
  colunasCache = out;
  return out;
}
function _limparCacheDeColunas() { colunasCache = null; }

const q = (c) => `"${c}"`;

// SAVEPOINT para as tabelas penduradas no produto (fotos, fornecedores,
// categorias): base sem a tabela/coluna segue sem elas. `toleraDuplicado`:
// categoria que colide na unicidade do destino (ex.: mesmo caminho/slug com
// outro nome) nao derruba a copia — o produto vai sem a categoria
// (o texto products.category segue copiado).
async function opcional(conn, nome, fn, { toleraDuplicado = false } = {}) {
  await conn.query(`SAVEPOINT ${nome}`);
  try {
    const r = await fn();
    await conn.query(`RELEASE SAVEPOINT ${nome}`);
    return r;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703' || (toleraDuplicado && e.code === '23505'))) {
      await conn.query(`ROLLBACK TO SAVEPOINT ${nome}`);
      return null;
    }
    throw e;
  }
}

// ─── categorias no destino ───────────────────────────────────
// Categoria e por empresa. Acha a equivalente no destino pelo nome (mesmo
// pai, mesmo type — a unicidade de product_categories) ou cria, de cima
// para baixo. Numero de queries = numero de categorias envolvidas.
async function copiarCategorias(conn, destinoId, mapaProdutos) {
  const origens = [...mapaProdutos.keys()];
  if (!origens.length) return;
  const { rows: links } = await conn.query(
    `SELECT product_id, category_id, is_primary FROM product_category_links WHERE product_id = ANY($1::uuid[])`,
    [origens]
  );
  if (!links.length) return;
  const { rows: cats } = await conn.query(
    `WITH RECURSIVE arvore AS (
       SELECT id, parent_id, name, type, color, sort_order, depth
         FROM product_categories WHERE id = ANY($1::uuid[])
       UNION
       SELECT c.id, c.parent_id, c.name, c.type, c.color, c.sort_order, c.depth
         FROM product_categories c JOIN arvore a ON c.id = a.parent_id
     )
     SELECT DISTINCT id, parent_id, name, type, color, sort_order, depth FROM arvore ORDER BY depth ASC NULLS FIRST`,
    [[...new Set(links.map((l) => l.category_id))]]
  );
  const mapaCat = new Map();
  for (const c of cats) {
    const tipo = c.type || 'product';
    const pai = c.parent_id ? mapaCat.get(String(c.parent_id)) || null : null;
    if (c.parent_id && !pai) continue; // pai nao copiado: nao inventa arvore
    const { rows: achada } = await conn.query(
      `SELECT id FROM product_categories
        WHERE company_id = $1 AND COALESCE(type, 'product') = $2::text
          AND parent_id IS NOT DISTINCT FROM $3::uuid
          AND lower(btrim(name)) = lower(btrim($4::text))
        LIMIT 1`,
      [destinoId, tipo, pai, c.name]
    );
    if (achada[0]) { mapaCat.set(String(c.id), achada[0].id); continue; }
    const { rows: nova } = await conn.query(
      `INSERT INTO product_categories (company_id, type, parent_id, name, color, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [destinoId, tipo, pai, c.name, c.color, c.sort_order || 0]
    );
    mapaCat.set(String(c.id), nova[0].id);
  }
  const prod = [], cat = [], prim = [];
  for (const l of links) {
    const novoProduto = mapaProdutos.get(String(l.product_id).toLowerCase());
    const novaCat = mapaCat.get(String(l.category_id));
    if (!novoProduto || !novaCat) continue;
    prod.push(novoProduto); cat.push(novaCat); prim.push(!!l.is_primary);
  }
  if (!prod.length) return;
  await conn.query(
    `INSERT INTO product_category_links (product_id, category_id, is_primary)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::boolean[])
     ON CONFLICT DO NOTHING`,
    [prod, cat, prim]
  );
}

// ─── produtos ────────────────────────────────────────────────
/**
 * Copia os produtos `orig[i]` para a loja `destinoId` com o id `novo[i]` e o
 * codigo de barras `barcode[i]` (null = sem codigo). Estoque 0,
 * is_group_shared = false. Leva fotos, fornecedores e categorias.
 * Roda DENTRO da transacao do chamador. `cols` = colunasCopiaveis(conn).
 */
async function copiarProdutos(conn, { destinoId, orig, novo, barcode, cols }) {
  if (!orig.length) return;
  const mapaCopias = new Map(orig.map((o, i) => [o, novo[i]]));
  const lista = cols.products.map(q).join(', ');
  const sel = cols.products.map((c) => `p.${q(c)}`).join(', ');
  await conn.query(
    `INSERT INTO products (id, company_id, stock_qty, is_group_shared, barcode, ${lista})
       SELECT m.novo, $1, 0, false, m.barcode, ${sel}
         FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS m(orig, novo, barcode)
         JOIN products p ON p.id = m.orig`,
    [destinoId, orig, novo, barcode]
  );
  await opcional(conn, 'sp_fotos', () => conn.query(
    `INSERT INTO product_images (company_id, product_id, color_hex, url, thumb_url, position)
       SELECT $1, m.novo, i.color_hex, i.url, i.thumb_url, i.position
         FROM unnest($2::uuid[], $3::uuid[]) AS m(orig, novo)
         JOIN product_images i ON i.product_id = m.orig`,
    [destinoId, orig, novo]
  ));
  await opcional(conn, 'sp_fornecedores', () => conn.query(
    `INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, supplier_code, is_main, last_purchase_at)
       SELECT $1, m.novo, s.supplier_id, s.cost, s.supplier_code, s.is_main, s.last_purchase_at
         FROM unnest($2::uuid[], $3::uuid[]) AS m(orig, novo)
         JOIN product_suppliers s ON s.product_id = m.orig
       ON CONFLICT DO NOTHING`,
    [destinoId, orig, novo]
  ));
  await opcional(conn, 'sp_categorias', () => copiarCategorias(conn, destinoId, mapaCopias), { toleraDuplicado: true });
}

// ─── variantes ───────────────────────────────────────────────
/**
 * Cria a variante `novo[i]` no produto `pid[i]`, copiada da variante
 * `orig[i]` (colunas + atributos Cor/Tamanho...). Ativa, estoque 0.
 */
async function copiarVariantes(conn, { cols, orig, novo, pid }) {
  if (!orig.length) return;
  const lista = cols.product_variants.map(q).join(', ');
  const sel = cols.product_variants.map((c) => `v.${q(c)}`).join(', ');
  await conn.query(
    `INSERT INTO product_variants (id, product_id, stock_qty, is_active, ${lista})
         SELECT m.novo, m.pid, 0, true, ${sel}
           FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS m(orig, novo, pid)
           JOIN product_variants v ON v.id = m.orig`,
    [orig, novo, pid]
  );
  await conn.query(
    `INSERT INTO product_variant_values (variant_id, attribute_name, value)
         SELECT m.novo, vv.attribute_name, vv.value
           FROM unnest($1::uuid[], $2::uuid[]) AS m(orig, novo)
           JOIN product_variant_values vv ON vv.variant_id = m.orig
         ON CONFLICT DO NOTHING`,
    [orig, novo]
  );
}

module.exports = {
  FORA_DA_COPIA,
  colunasCopiaveis,
  _limparCacheDeColunas,
  opcional,
  copiarCategorias,
  copiarProdutos,
  copiarVariantes,
};
