// ============================================================
// AURA. -- Product Categories: arvore + CRUD legado + vinculo produto<->categoria
// F0 Bloco B1 (30/07/2026). Reescreve a rota legada (absorvida aqui) e
// adiciona os endpoints novos da arvore. Contrato: docs/CONTRACT_CATEGORIES.md.
//
// Duas rotas exportadas (padrao ja usado no repo em productLinks/checklist/
// reviews/financeiroInsights):
//   categoriesRouter    -> montado em /product-categories (private.js)
//   productLinksRouter  -> montado em /products, ANTES de require('./products')
//                          (que tem PATCH/DELETE /:pid -- ver private.js secao 4.1)
//
// products.category NUNCA e escrito aqui. E responsabilidade exclusiva do
// trigger trg_sync_legacy_category (a partir de product_category_links) e
// trg_sync_legacy_category_rename (a partir de product_categories.name).
// slug/path/depth tambem nunca sao calculados aqui -- sao dos triggers.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const categoryTree = require('../services/categoryTree');

function normalizeType(t) {
  const v = String(t || '').toLowerCase().trim();
  return v === 'service' ? 'service' : 'product';
}

function isHexColor(v) {
  return typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
}

// ── GET / -- lista flat legada, bilingue por retrocompat ------------------
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const type = normalizeType(req.query.type);
  const filters = ['c.company_id = $1', 'c.type = $2'];
  const params = [cid, type];

  const depth = parseInt(req.query.depth, 10);
  if (Number.isFinite(depth)) { params.push(depth); filters.push(`c.depth = $${params.length}`); }

  if (req.query.parent_id === 'null') {
    filters.push('c.parent_id IS NULL');
  } else if (req.query.parent_id) {
    params.push(req.query.parent_id); filters.push(`c.parent_id = $${params.length}`);
  }

  if (req.query.q && String(req.query.q).trim()) {
    params.push(`%${String(req.query.q).trim()}%`);
    filters.push(`c.name ILIKE $${params.length}`);
  }

  // product_count ao vivo -- decisao A1, contrato secao 2. Superestima na
  // presenca de irmaos homonimos em ramos diferentes; aceito como transitorio.
  const countExpr = type === 'service'
    ? `(SELECT COUNT(*)::int FROM products p WHERE p.company_id = c.company_id AND p.category = c.name AND p.unit = 'srv')`
    : `(SELECT COUNT(*)::int FROM products p WHERE p.company_id = c.company_id AND p.category = c.name AND (p.unit IS NULL OR p.unit <> 'srv'))`;

  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.color, c.sort_order, c.type, c.path,
              c.created_at, c.updated_at, ${countExpr} AS product_count
         FROM product_categories c
        WHERE ${filters.join(' AND ')}
        ORDER BY c.sort_order ASC, c.name ASC`,
      params
    );
    // Shape preservado -- consumido por services/companiesApi.ts do aura-app.
    res.json({ categories: rows, total: rows.length, type });
  } catch (err) {
    console.error('[productCategories] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar categorias' });
  }
});

// ── GET /tree -- arvore aninhada, product-only, product_count da coluna ---
router.get('/tree', async (req, res) => {
  const cid = req.params.id;
  try {
    const categories = await categoryTree.getTree(db, cid);
    res.json({ categories, type: 'product' });
  } catch (err) {
    console.error('[productCategories] tree error:', err.message);
    res.status(500).json({ error: 'Erro ao montar arvore de categorias' });
  }
});

// ── POST / -- type='service' cria flat (decisao C1) -----------------------
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { name, color, sort_order, parent_id } = req.body;
  const type = normalizeType(req.body.type);

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }
  const cleanName = String(name).trim().slice(0, 80);
  const hex = isHexColor(color) ? color : null;
  const parentId = type === 'service' ? null : (parent_id || null);

  try {
    const { rows } = await db.query(
      `INSERT INTO product_categories (company_id, name, color, sort_order, type, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, company_id, name, slug, path, depth, color, sort_order, type, parent_id, created_at`,
      [cid, cleanName, hex, parseInt(sort_order) || 0, type, parentId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    const mapped = categoryTree.mapTriggerOrConstraintError(err);
    if (mapped) {
      if (mapped.body.code === 'CATEGORY_DUPLICATE') {
        mapped.body.existing_id = await categoryTree
          .findSiblingId(db, { companyId: cid, type, parentId, name: cleanName })
          .catch(() => null);
      }
      return res.status(mapped.status).json(mapped.body);
    }
    console.error('[productCategories] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar categoria' });
  }
});

// ── PATCH /:catId -- renomeia/edita metadados, SEM cascata manual ---------
const PATCHABLE = {
  name: 'name', color: 'color', sort_order: 'sort_order',
  image_url: 'image_url', banner_url: 'banner_url',
  is_visible_storefront: 'is_visible_storefront',
  seo_title: 'seo_title', seo_description: 'seo_description',
};

router.patch('/:catId', async (req, res) => {
  const { id: cid, catId } = req.params;
  const updates = [];
  const values = [];
  let idx = 1;
  for (const [bodyKey, dbCol] of Object.entries(PATCHABLE)) {
    if (req.body[bodyKey] === undefined) continue;
    let val = req.body[bodyKey];
    if (dbCol === 'name') val = String(val).trim().slice(0, 80);
    if (dbCol === 'color') val = isHexColor(val) ? val : null;
    if (dbCol === 'sort_order') val = parseInt(val) || 0;
    if (dbCol === 'is_visible_storefront') val = !!val;
    updates.push(`${dbCol} = $${idx++}`);
    values.push(val);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()');
  values.push(catId, cid);

  try {
    const { rows } = await db.query(
      `UPDATE product_categories SET ${updates.join(', ')}
        WHERE id = $${idx++} AND company_id = $${idx++}
        RETURNING id, company_id, name, slug, path, depth, color, sort_order, type,
                  parent_id, image_url, banner_url, is_visible_storefront,
                  seo_title, seo_description, updated_at`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Categoria nao encontrada' });

    // affected_products: NAO ha mais cascata manual em products.category (o
    // trigger trg_sync_legacy_category_rename ja propaga a partir do link
    // primario). O campo continua no payload -- aura-app/useProductCategories
    // le pra montar o toast "N itens ajustados" -- mas agora deriva da
    // contagem de links da categoria, nao de um rowCount de UPDATE.
    // Documentado no corpo do PR.
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*)::int AS n FROM product_category_links WHERE category_id = $1',
      [catId]
    );
    res.json({ ...rows[0], affected_products: countRows[0]?.n || 0 });
  } catch (err) {
    const mapped = categoryTree.mapTriggerOrConstraintError(err);
    if (mapped) {
      if (mapped.body.code === 'CATEGORY_DUPLICATE' && req.body.name !== undefined) {
        const nameVal = String(req.body.name).trim().slice(0, 80);
        const ctx = await db.query(
          'SELECT type, parent_id FROM product_categories WHERE id = $1 AND company_id = $2',
          [catId, cid]
        ).catch(() => ({ rows: [] }));
        if (ctx.rows[0]) {
          mapped.body.existing_id = await categoryTree
            .findSiblingId(db, { companyId: cid, type: ctx.rows[0].type, parentId: ctx.rows[0].parent_id, name: nameVal })
            .catch(() => null);
        }
      }
      return res.status(mapped.status).json(mapped.body);
    }
    console.error('[productCategories] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar categoria' });
  }
});

// ── DELETE /:catId -- reescrita completa, decisao B1 -----------------------
router.delete('/:catId', async (req, res) => {
  const { id: cid, catId } = req.params;
  const moveToRaw = req.query.move_to ? String(req.query.move_to).trim() : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query(
      'SELECT id, type FROM product_categories WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [catId, cid]
    );
    if (!existingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Categoria nao encontrada' });
    }
    const rowType = existingRows[0].type;

    // Guarda 1 -- filhos, ANTES de qualquer DELETE.
    const { rows: childRows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM product_categories WHERE parent_id = $1 AND company_id = $2',
      [catId, cid]
    );
    const childrenCount = childRows[0]?.n || 0;
    if (childrenCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Categoria tem subcategorias -- mova ou exclua-as primeiro',
        code: 'CATEGORY_HAS_CHILDREN', children_count: childrenCount,
      });
    }

    const { rows: linkRows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM product_category_links WHERE category_id = $1',
      [catId]
    );
    const productCount = linkRows[0]?.n || 0;

    // Guarda 2 -- produtos vinculados sem destino.
    if (productCount > 0 && !moveToRaw) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Categoria tem produtos vinculados -- informe move_to ou desvincule-os primeiro',
        code: 'CATEGORY_HAS_PRODUCTS', product_count: productCount,
      });
    }

    if (productCount > 0 && moveToRaw) {
      const target = await categoryTree.resolveMoveTarget(client, { companyId: cid, type: rowType, raw: moveToRaw });
      if (!target) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Categoria destino (move_to) nao encontrada', code: 'CATEGORY_NOT_FOUND' });
      }
      if (target.ambiguous) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'move_to por nome e ambiguo -- existe mais de uma categoria com esse nome',
          code: 'CATEGORY_DUPLICATE', candidates: target.ambiguous,
        });
      }
      if (target.id === catId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'move_to nao pode ser a propria categoria' });
      }
      // Move os LINKS, nao o texto -- o trigger cuida de products.category.
      await categoryTree.moveLinks(client, { sourceIds: [catId], targetId: target.id });
    }

    await client.query('DELETE FROM product_categories WHERE id = $1 AND company_id = $2', [catId, cid]);

    await client.query('COMMIT');
    res.json({ deleted: true, id: catId, moved_products: productCount, type: rowType });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const mapped = categoryTree.mapTriggerOrConstraintError(err);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error('[productCategories] delete error:', err.message, err.code);
    res.status(500).json({ error: 'Erro ao excluir categoria' });
  } finally {
    client.release();
  }
});

// ── POST /:catId/move ------------------------------------------------------
router.post('/:catId/move', async (req, res) => {
  const { id: cid, catId } = req.params;
  const { parent_id, sort_order } = req.body;

  try {
    if (parent_id) {
      const { rows: parentRows } = await db.query(
        "SELECT id FROM product_categories WHERE id = $1 AND company_id = $2 AND type = 'product'",
        [parent_id, cid]
      );
      if (!parentRows.length) return res.status(404).json({ error: 'Categoria pai nao encontrada' });
    }
    const { rows } = await db.query(
      `UPDATE product_categories
          SET parent_id = $1, sort_order = COALESCE($2, sort_order), updated_at = NOW()
        WHERE id = $3 AND company_id = $4 AND type = 'product'
        RETURNING id, company_id, name, slug, path, depth, parent_id, sort_order, type, updated_at`,
      [parent_id || null, sort_order !== undefined ? parseInt(sort_order) : null, catId, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Categoria nao encontrada' });
    res.json(rows[0]);
  } catch (err) {
    const mapped = categoryTree.mapTriggerOrConstraintError(err);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error('[productCategories] move error:', err.message, err.code);
    res.status(500).json({ error: 'Erro ao mover categoria' });
  }
});

// ── POST /merge -------------------------------------------------------------
router.post('/merge', async (req, res) => {
  const cid = req.params.id;
  const sourceIds = Array.isArray(req.body?.source_ids) ? req.body.source_ids.filter(Boolean) : [];
  const targetId = req.body?.target_id;

  if (!sourceIds.length || !targetId) {
    return res.status(400).json({ error: 'source_ids[] e target_id sao obrigatorios' });
  }
  const cleanSourceIds = sourceIds.filter((sid) => sid !== targetId);
  if (!cleanSourceIds.length) {
    return res.status(400).json({ error: 'source_ids nao pode conter apenas o proprio target_id' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: targetRows } = await client.query(
      'SELECT id, type FROM product_categories WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [targetId, cid]
    );
    if (!targetRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Categoria destino (target_id) nao encontrada' });
    }

    const { rows: sourceRows } = await client.query(
      'SELECT id FROM product_categories WHERE id = ANY($1::uuid[]) AND company_id = $2 AND type = $3 FOR UPDATE',
      [cleanSourceIds, cid, targetRows[0].type]
    );
    if (sourceRows.length !== cleanSourceIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Uma ou mais categorias de origem nao encontradas' });
    }

    const { rows: childRows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM product_categories WHERE parent_id = ANY($1::uuid[])',
      [cleanSourceIds]
    );
    if ((childRows[0]?.n || 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Uma ou mais categorias de origem tem subcategorias -- mova-as primeiro',
        code: 'CATEGORY_HAS_CHILDREN', children_count: childRows[0].n,
      });
    }

    await categoryTree.moveLinks(client, { sourceIds: cleanSourceIds, targetId });
    await client.query('DELETE FROM product_categories WHERE id = ANY($1::uuid[]) AND company_id = $2', [cleanSourceIds, cid]);

    await client.query('COMMIT');
    res.json({ merged: true, target_id: targetId, source_ids: cleanSourceIds });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const mapped = categoryTree.mapTriggerOrConstraintError(err);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error('[productCategories] merge error:', err.message, err.code);
    res.status(500).json({ error: 'Erro ao unificar categorias' });
  } finally {
    client.release();
  }
});

// ── POST /reorder ------------------------------------------------------------
router.post('/reorder', async (req, res) => {
  const cid = req.params.id;
  const parentId = req.body?.parent_id || null;
  const orderedIds = Array.isArray(req.body?.ordered_ids) ? req.body.ordered_ids.filter(Boolean) : [];
  if (!orderedIds.length) return res.status(400).json({ error: 'ordered_ids[] e obrigatorio' });

  try {
    const { rowCount } = await db.query(
      `UPDATE product_categories AS c
          SET sort_order = o.idx, updated_at = NOW()
         FROM (SELECT id, ord - 1 AS idx FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ord)) AS o
        WHERE c.id = o.id AND c.company_id = $2 AND c.type = 'product'
          AND ((c.parent_id = $3::uuid) OR ($3::uuid IS NULL AND c.parent_id IS NULL))`,
      [orderedIds, cid, parentId]
    );
    res.json({ reordered: rowCount, parent_id: parentId });
  } catch (err) {
    console.error('[productCategories] reorder error:', err.message);
    res.status(500).json({ error: 'Erro ao reordenar categorias' });
  }
});

// ── POST /clone-from -----------------------------------------------------
// Copia estrutura + sort_order de outra empresa do MESMO grupo de
// faturamento (group_root -- mesmo padrao de src/routes/products.js
// visibilityWhere). Nenhum produto e copiado. Guard de grupo e decisao
// adicional, fora do texto literal do contrato -- declarada no corpo do PR.
router.post('/clone-from', async (req, res) => {
  const cid = req.params.id;
  const sourceCompanyId = req.body?.source_company_id;
  if (!sourceCompanyId) return res.status(400).json({ error: 'source_company_id e obrigatorio' });
  if (sourceCompanyId === cid) return res.status(400).json({ error: 'source_company_id nao pode ser a propria empresa' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: groupRows } = await client.query(
      `SELECT
         (SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $1) AS target_group,
         (SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $2) AS source_group`,
      [cid, sourceCompanyId]
    );
    const g = groupRows[0] || {};
    if (!g.source_group || !g.target_group || g.source_group !== g.target_group) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'source_company_id nao pertence ao mesmo grupo de faturamento' });
    }

    const { rows: srcRows } = await client.query(
      `SELECT id, parent_id, name, sort_order, color
         FROM product_categories
        WHERE company_id = $1 AND type = 'product'
        ORDER BY depth ASC, sort_order ASC, name ASC`,
      [sourceCompanyId]
    );

    const idMap = new Map();
    for (const row of srcRows) {
      const newParentId = row.parent_id ? (idMap.get(row.parent_id) || null) : null;
      const { rows: ins } = await client.query(
        `INSERT INTO product_categories (company_id, type, parent_id, name, sort_order, color)
         VALUES ($1, 'product', $2, $3, $4, $5) RETURNING id`,
        [cid, newParentId, row.name, row.sort_order, row.color]
      );
      idMap.set(row.id, ins[0].id);
    }

    await client.query('COMMIT');
    res.status(201).json({ cloned: idMap.size, source_company_id: sourceCompanyId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const mapped = categoryTree.mapTriggerOrConstraintError(err);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error('[productCategories] clone-from error:', err.message, err.code);
    res.status(500).json({ error: 'Erro ao clonar arvore de categorias' });
  } finally {
    client.release();
  }
});

// ============================================================
// productLinksRouter -- monta em /products (private.js), ANTES de
// require('./products'). Rotas estaticas (unclassified, categories/bulk)
// antes da parametrica (:productId/categories) -- disciplina do repo.
// ============================================================
const productLinksRouter = require('express').Router({ mergeParams: true });

// GET /products/unclassified -- orfao = produto SEM link primario, nao
// category IS NULL (briefing secao 5.7). Insensivel a acento/caixa no ?q=.
productLinksRouter.get('/unclassified', async (req, res) => {
  const cid = req.params.id;
  const q = req.query.q ? String(req.query.q).trim() : null;
  const hasStock = req.query.has_stock === 'true' ? true : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const filters = [
    'p.company_id = $1',
    "(p.unit IS NULL OR p.unit <> 'srv')",
    'NOT EXISTS (SELECT 1 FROM product_category_links l WHERE l.product_id = p.id AND l.is_primary)',
  ];
  const params = [cid];
  if (q) {
    params.push(`%${q}%`);
    filters.push(`unaccent(lower(p.name)) LIKE unaccent(lower($${params.length}))`);
  }
  if (hasStock) filters.push('p.stock_qty > 0');

  try {
    const where = filters.join(' AND ');
    const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM products p WHERE ${where}`, params);
    const dataParams = [...params, limit, offset];
    const dataRes = await db.query(
      `SELECT p.id, p.name, p.sku, p.barcode, p.category, p.stock_qty, p.price, p.created_at
         FROM products p WHERE ${where}
        ORDER BY p.name ASC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );
    res.json({ products: dataRes.rows, total: countRes.rows[0]?.total || 0, limit, offset });
  } catch (err) {
    console.error('[productCategories] unclassified error:', err.message);
    res.status(500).json({ error: 'Erro ao listar produtos nao classificados' });
  }
});

// POST /products/categories/bulk -- maximo 100. mode: replace_primary
// (troca a primaria de quem ja tem) | add_secondary (DO NOTHING e correto).
productLinksRouter.post('/categories/bulk', async (req, res) => {
  const cid = req.params.id;
  const productIds = Array.isArray(req.body?.product_ids) ? req.body.product_ids.filter(Boolean) : [];
  const primaryCategoryId = req.body?.primary_category_id;
  const mode = req.body?.mode;

  if (!productIds.length) return res.status(400).json({ error: 'product_ids[] e obrigatorio' });
  if (productIds.length > 100) return res.status(400).json({ error: 'Maximo de 100 produtos por lote' });
  if (!primaryCategoryId) return res.status(400).json({ error: 'primary_category_id e obrigatorio' });
  if (!['replace_primary', 'add_secondary'].includes(mode)) {
    return res.status(400).json({ error: "mode deve ser 'replace_primary' ou 'add_secondary'" });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Restringe aos produtos da propria empresa (regra 3 -- WHERE company_id
    // em toda query). O trigger trg_link_tenant_guard e a barreira final.
    const { rows: ownRows } = await client.query(
      'SELECT id FROM products WHERE id = ANY($1::uuid[]) AND company_id = $2',
      [productIds, cid]
    );
    const ownIds = ownRows.map((r) => r.id);
    if (!ownIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nenhum dos product_ids pertence a esta empresa' });
    }

    if (mode === 'replace_primary') {
      // O UPDATE vem ANTES, sempre -- contrato secao 6.1 / secao 4.
      await client.query(
        'UPDATE product_category_links SET is_primary = false WHERE product_id = ANY($1::uuid[]) AND is_primary',
        [ownIds]
      );
      await client.query(
        `INSERT INTO product_category_links (product_id, category_id, is_primary)
           SELECT unnest($1::uuid[]), $2::uuid, true
             ON CONFLICT (product_id, category_id) DO UPDATE SET is_primary = true`,
        [ownIds, primaryCategoryId]
      );
    } else {
      await client.query(
        `INSERT INTO product_category_links (product_id, category_id, is_primary)
           SELECT unnest($1::uuid[]), $2::uuid, false
             ON CONFLICT DO NOTHING`,
        [ownIds, primaryCategoryId]
      );
    }

    await client.query('COMMIT');
    res.json({ updated: ownIds.length, mode, primary_category_id: primaryCategoryId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const mapped = categoryTree.mapTriggerOrConstraintError(err);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error('[productCategories] bulk error:', err.message, err.code);
    res.status(500).json({ error: 'Erro ao classificar produtos em lote' });
  } finally {
    client.release();
  }
});

// PUT /products/:productId/categories -- substitui os vinculos do produto.
productLinksRouter.put('/:productId/categories', async (req, res) => {
  const { id: cid, productId } = req.params;
  const primaryCategoryId = req.body?.primary_category_id;
  const alsoIn = Array.isArray(req.body?.also_in)
    ? [...new Set(req.body.also_in.filter((cidItem) => cidItem && cidItem !== primaryCategoryId))]
    : [];

  if (!primaryCategoryId) return res.status(400).json({ error: 'primary_category_id e obrigatorio' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: prodRows } = await client.query(
      'SELECT id FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [productId, cid]
    );
    if (!prodRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }

    const allCategoryIds = [primaryCategoryId, ...alsoIn];
    const { rows: catRows } = await client.query(
      "SELECT id FROM product_categories WHERE id = ANY($1::uuid[]) AND company_id = $2 AND type = 'product'",
      [allCategoryIds, cid]
    );
    if (catRows.length !== allCategoryIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Uma ou mais categorias informadas nao foram encontradas' });
    }

    await client.query('DELETE FROM product_category_links WHERE product_id = $1', [productId]);
    const isPrimaryFlags = allCategoryIds.map((_, i) => i === 0);
    await client.query(
      `INSERT INTO product_category_links (product_id, category_id, is_primary)
         SELECT $1::uuid, cat_id, is_primary
           FROM unnest($2::uuid[], $3::boolean[]) AS t(cat_id, is_primary)`,
      [productId, allCategoryIds, isPrimaryFlags]
    );

    await client.query('COMMIT');
    res.json({ product_id: productId, primary_category_id: primaryCategoryId, also_in: alsoIn });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const mapped = categoryTree.mapTriggerOrConstraintError(err);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error('[productCategories] put categories error:', err.message, err.code);
    res.status(500).json({ error: 'Erro ao vincular categorias ao produto' });
  } finally {
    client.release();
  }
});

module.exports = { categoriesRouter: router, productLinksRouter };
