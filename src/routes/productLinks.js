// ============================================================
// AURA. — Product Links (Multi-CNPJ M-STOCKLINK MSL-02/03/04)
//
// Vincula produtos entre empresas do mesmo owner via master_sku.
// Filosofia "soft link": dois produtos com mesmo master_sku são
// "o mesmo produto em CNPJs diferentes". A view consolidada (modo
// "Todas as empresas") soma o estoque por master_sku.
//
// Endpoints (todos prefixed com /companies/:id):
//   GET    /products/:productId/match-suggestions
//          → sugere produtos similares em OUTRAS empresas do owner
//            via barcode (exato) e name (similarity pg_trgm).
//
//   POST   /products/:productId/master-sku
//          → vincula produto a um master_sku.
//          Body: { master_sku: string }
//          Se master_sku já existir em OUTRO produto deste owner
//          em OUTRA empresa, vira parte do mesmo grupo.
//
//   DELETE /products/:productId/master-sku
//          → desvincula (master_sku=NULL).
//
//   GET    /products/aggregated
//          → quando user está em modo consolidado, retorna lista
//            de produtos AGREGADA por master_sku (estoque somado
//            entre empresas).
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// ── Helper: resolve owner_id da empresa do path ────────────
async function getOwnerOfCompany(companyId) {
  const { rows } = await db.query(
    `SELECT owner_id FROM companies WHERE id = $1 AND is_active = true`,
    [companyId]
  );
  return rows[0]?.owner_id || null;
}

// ── Helper: lista IDs de TODAS as empresas ativas do owner ─
async function getOwnerCompanyIds(ownerId) {
  const { rows } = await db.query(
    `SELECT id FROM companies WHERE owner_id = $1 AND is_active = true`,
    [ownerId]
  );
  return rows.map((r) => r.id);
}

// ── Helper: valida que o user tem acesso ao produto ────────
// Verifica que o produto pertence à company do path E que o
// owner da company é o user autenticado (ou ele tem permissão
// via company_members — mas pra MVP só owner pode linkar).
async function validateProductAccess(productId, companyId, userId) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.master_sku, p.barcode, p.sku, p.image_url, p.price,
            c.id AS company_id, c.owner_id, c.trade_name AS company_name
       FROM products p
       JOIN companies c ON c.id = p.company_id
      WHERE p.id = $1
        AND p.company_id = $2
        AND p.is_active = true
        AND c.is_active = true
        AND c.owner_id = $3`,
    [productId, companyId, userId]
  );
  return rows[0] || null;
}

// ────────────────────────────────────────────────────────────
// GET /products/:productId/match-suggestions
//
// Sugere produtos em OUTRAS empresas do owner que poderiam ser
// "o mesmo produto" deste. Estratégia:
//   1. Match EXATO por barcode  → score 1.0 (top)
//   2. Match exato por sku       → score 0.95
//   3. Similarity por name       → pg_trgm threshold ≥ 0.4
//
// Já filtra produtos que JÁ têm o mesmo master_sku (não faria
// sentido sugerir vincular ao próprio grupo).
// ────────────────────────────────────────────────────────────
router.get('/products/:productId/match-suggestions', requireAuth, async (req, res) => {
  const { id: companyId, productId } = req.params;
  const userId = req.user.id;

  try {
    const product = await validateProductAccess(productId, companyId, userId);
    if (!product) {
      return res.status(404).json({ error: 'Produto não encontrado ou sem acesso' });
    }

    // Quais empresas considerar (exclui a do produto atual)
    const ownerCompanyIds = await getOwnerCompanyIds(product.owner_id);
    const otherCompanyIds = ownerCompanyIds.filter((id) => id !== companyId);

    if (otherCompanyIds.length === 0) {
      return res.json({
        product: {
          id: product.id,
          name: product.name,
          master_sku: product.master_sku,
        },
        suggestions: [],
        note: 'Você só tem uma empresa ativa. Adicione outro CNPJ para vincular produtos.',
      });
    }

    // Query única que junta os 3 critérios. Usa UNION ALL pra
    // ranquear cada match com seu próprio score, depois agrupa
    // pelo id pra evitar duplicatas (produto pode bater em barcode
    // E em similarity ao mesmo tempo).
    const { rows } = await db.query(
      `WITH candidates AS (
        -- Critério 1: barcode exato
        SELECT p.id, p.name, p.barcode, p.sku, p.master_sku, p.stock_qty,
               p.price, p.image_url, c.id AS company_id, c.trade_name AS company_name,
               1.0::float AS score, 'barcode'::text AS match_type
          FROM products p
          JOIN companies c ON c.id = p.company_id
         WHERE p.company_id = ANY($1::uuid[])
           AND p.is_active = true
           AND p.barcode IS NOT NULL
           AND p.barcode = $2
           AND ($3::text IS NULL OR p.master_sku IS DISTINCT FROM $3)

        UNION ALL

        -- Critério 2: sku exato
        SELECT p.id, p.name, p.barcode, p.sku, p.master_sku, p.stock_qty,
               p.price, p.image_url, c.id AS company_id, c.trade_name AS company_name,
               0.95::float AS score, 'sku'::text AS match_type
          FROM products p
          JOIN companies c ON c.id = p.company_id
         WHERE p.company_id = ANY($1::uuid[])
           AND p.is_active = true
           AND p.sku IS NOT NULL
           AND $4::text IS NOT NULL
           AND lower(p.sku) = lower($4)
           AND ($3::text IS NULL OR p.master_sku IS DISTINCT FROM $3)

        UNION ALL

        -- Critério 3: similarity de nome via pg_trgm
        SELECT p.id, p.name, p.barcode, p.sku, p.master_sku, p.stock_qty,
               p.price, p.image_url, c.id AS company_id, c.trade_name AS company_name,
               similarity(lower(p.name), lower($5))::float AS score,
               'name_similarity'::text AS match_type
          FROM products p
          JOIN companies c ON c.id = p.company_id
         WHERE p.company_id = ANY($1::uuid[])
           AND p.is_active = true
           AND similarity(lower(p.name), lower($5)) >= 0.4
           AND ($3::text IS NULL OR p.master_sku IS DISTINCT FROM $3)
      )
      SELECT DISTINCT ON (id)
             id, name, barcode, sku, master_sku, stock_qty, price, image_url,
             company_id, company_name, score, match_type
        FROM candidates
       ORDER BY id, score DESC
       LIMIT 20`,
      [
        otherCompanyIds,
        product.barcode,
        product.master_sku,  // pra excluir produtos já no mesmo grupo
        product.sku,
        product.name,
      ]
    );

    // Re-ordena por score desc (DISTINCT ON quebra a ordenação final)
    const suggestions = rows
      .sort((a, b) => b.score - a.score)
      .map((r) => ({
        id: r.id,
        name: r.name,
        barcode: r.barcode,
        sku: r.sku,
        master_sku: r.master_sku,
        stock_qty: parseFloat(r.stock_qty) || 0,
        price: parseFloat(r.price) || 0,
        image_url: r.image_url,
        company_id: r.company_id,
        company_name: r.company_name,
        match_score: parseFloat(r.score.toFixed(3)),
        match_type: r.match_type,
        already_in_a_group: !!r.master_sku,
      }));

    res.json({
      product: {
        id: product.id,
        name: product.name,
        barcode: product.barcode,
        sku: product.sku,
        master_sku: product.master_sku,
      },
      suggestions,
      total: suggestions.length,
      searched_companies: otherCompanyIds.length,
    });
  } catch (err) {
    console.error('[productLinks] match-suggestions error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar sugestões', detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// POST /products/:productId/master-sku
// Body: { master_sku: string }
//
// Vincula o produto ao master_sku. Se outro produto do owner
// (em outra empresa) já tem esse master_sku, eles passam a ser
// considerados o mesmo grupo. Se ninguém tem, cria um grupo novo.
//
// Validações:
//   - Produto existe e pertence ao owner
//   - master_sku tem >=2 chars, sem espaços (norma: trim + lower)
//   - master_sku NÃO está em uso por OUTRO produto da MESMA empresa
//     (caso contrário viola índice uq_products_master_sku_per_company)
// ────────────────────────────────────────────────────────────
router.post('/products/:productId/master-sku', requireAuth, async (req, res) => {
  const { id: companyId, productId } = req.params;
  const userId = req.user.id;
  const rawSku = req.body?.master_sku;

  if (!rawSku || typeof rawSku !== 'string') {
    return res.status(400).json({ error: 'Campo master_sku é obrigatório (string)' });
  }

  // Normalização: trim + uppercase. Padroniza pra evitar "ABC" vs "abc"
  // virarem grupos diferentes. Uppercase é convenção comum em SKUs.
  const masterSku = rawSku.trim().toUpperCase();

  if (masterSku.length < 2 || masterSku.length > 64) {
    return res.status(400).json({ error: 'master_sku deve ter entre 2 e 64 caracteres' });
  }
  if (/\s/.test(masterSku)) {
    return res.status(400).json({ error: 'master_sku não pode conter espaços' });
  }

  try {
    const product = await validateProductAccess(productId, companyId, userId);
    if (!product) {
      return res.status(404).json({ error: 'Produto não encontrado ou sem acesso' });
    }

    // Verifica se outro produto da MESMA empresa já tem esse sku
    const { rows: dupInCompany } = await db.query(
      `SELECT id, name FROM products
        WHERE company_id = $1
          AND master_sku = $2
          AND id <> $3
          AND is_active = true
        LIMIT 1`,
      [companyId, masterSku, productId]
    );
    if (dupInCompany.length > 0) {
      return res.status(409).json({
        error: 'DUPLICATE_IN_COMPANY',
        message: `O produto "${dupInCompany[0].name}" desta empresa já usa este código. Escolha outro.`,
        conflicting_product_id: dupInCompany[0].id,
      });
    }

    // Atualiza o master_sku
    const previousSku = product.master_sku;
    await db.query(
      `UPDATE products SET master_sku = $1, updated_at = NOW() WHERE id = $2`,
      [masterSku, productId]
    );

    // Audit
    try {
      await db.query(
        `INSERT INTO product_link_audit
           (user_id, product_id, company_id, action, master_sku, previous_master_sku, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          userId, productId, companyId,
          previousSku ? 'rename_master_sku' : 'link',
          masterSku,
          previousSku,
          JSON.stringify({ product_name: product.name }),
        ]
      );
    } catch (auditErr) {
      console.error('[productLinks] audit failed:', auditErr.message);
    }

    // Conta quantos produtos no total agora têm esse master_sku
    // (incluindo este) — pra UI mostrar "agora vinculado a N empresas"
    const { rows: groupRows } = await db.query(
      `SELECT COUNT(DISTINCT p.company_id)::int AS company_count,
              COUNT(*)::int AS product_count,
              COALESCE(SUM(p.stock_qty), 0)::numeric AS total_stock
         FROM products p
         JOIN companies c ON c.id = p.company_id
        WHERE p.master_sku = $1
          AND p.is_active = true
          AND c.owner_id = $2
          AND c.is_active = true`,
      [masterSku, product.owner_id]
    );

    const group = groupRows[0] || { company_count: 1, product_count: 1, total_stock: 0 };

    res.json({
      linked: true,
      product_id: productId,
      master_sku: masterSku,
      previous_master_sku: previousSku,
      group: {
        company_count: group.company_count,
        product_count: group.product_count,
        total_stock: parseFloat(group.total_stock),
      },
      message: group.product_count > 1
        ? `Produto vinculado. Agora "${masterSku}" agrupa ${group.product_count} produtos em ${group.company_count} empresa(s).`
        : `Produto marcado com código "${masterSku}". Quando outras empresas usarem o mesmo código, serão agrupadas automaticamente.`,
    });
  } catch (err) {
    console.error('[productLinks] POST master-sku error:', err.message);
    res.status(500).json({ error: 'Erro ao vincular produto', detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// DELETE /products/:productId/master-sku
// Desvincula o produto (master_sku = NULL).
// ────────────────────────────────────────────────────────────
router.delete('/products/:productId/master-sku', requireAuth, async (req, res) => {
  const { id: companyId, productId } = req.params;
  const userId = req.user.id;

  try {
    const product = await validateProductAccess(productId, companyId, userId);
    if (!product) {
      return res.status(404).json({ error: 'Produto não encontrado ou sem acesso' });
    }

    if (!product.master_sku) {
      return res.json({ unlinked: false, reason: 'not_linked', message: 'Este produto não estava vinculado.' });
    }

    const previousSku = product.master_sku;
    await db.query(
      `UPDATE products SET master_sku = NULL, updated_at = NOW() WHERE id = $1`,
      [productId]
    );

    try {
      await db.query(
        `INSERT INTO product_link_audit
           (user_id, product_id, company_id, action, master_sku, previous_master_sku, metadata)
         VALUES ($1, $2, $3, 'unlink', NULL, $4, $5::jsonb)`,
        [userId, productId, companyId, previousSku, JSON.stringify({ product_name: product.name })]
      );
    } catch (auditErr) {
      console.error('[productLinks] audit failed:', auditErr.message);
    }

    res.json({
      unlinked: true,
      product_id: productId,
      previous_master_sku: previousSku,
      message: 'Produto desvinculado.',
    });
  } catch (err) {
    console.error('[productLinks] DELETE master-sku error:', err.message);
    res.status(500).json({ error: 'Erro ao desvincular produto', detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// GET /products/aggregated
//
// Retorna lista de produtos AGREGADA por master_sku quando o user
// está em modo consolidado. Produtos sem master_sku aparecem
// individualmente (cada um conta como um "grupo" de 1).
//
// Útil pra tela de Estoque quando o usuário troca pra "Todas as
// empresas" — em vez de ver "Camiseta M" 2x (uma por CNPJ), vê
// "Camiseta M" 1x com estoque somado e badge "vinculado em 2 lojas".
//
// Esta rota REQUER consolidated_view=true no JWT (user trocou pra
// "Todas as empresas" via /auth/switch-company com company_id=null).
// Se não estiver em modo consolidado, retorna 400 — o caller deve
// usar GET /products normal.
// ────────────────────────────────────────────────────────────
router.get('/products/aggregated', requireAuth, async (req, res) => {
  const userId = req.user.id;

  // Modo consolidado é setado no JWT pelo /auth/switch-company.
  // Se chegou aqui sem isso, provavelmente o caller errou — devolve
  // mensagem clara.
  if (!req.user.consolidated_view) {
    return res.status(400).json({
      error: 'NOT_CONSOLIDATED',
      message: 'Esta rota só funciona no modo "Todas as empresas". Troque o switcher primeiro.',
    });
  }

  try {
    // Resolve as empresas do owner
    const ownerCompanyIds = await getOwnerCompanyIds(userId);
    if (ownerCompanyIds.length === 0) {
      return res.json({ products: [], total: 0 });
    }

    // Query: agrega por master_sku quando existe; senão, cada produto
    // vira sua própria "linha" (key = product_id pra não colidir).
    // Soma estoque, conta empresas, lista os produtos do grupo.
    const { rows } = await db.query(
      `WITH all_products AS (
        SELECT p.id, p.name, p.master_sku, p.barcode, p.sku, p.price,
               p.cost_price, p.stock_qty, p.image_url, p.category, p.unit,
               p.company_id, c.trade_name AS company_name
          FROM products p
          JOIN companies c ON c.id = p.company_id
         WHERE p.company_id = ANY($1::uuid[])
           AND p.is_active = true
      ),
      grouped AS (
        -- Produtos com master_sku: agrupa
        SELECT
          'master:' || master_sku                    AS group_key,
          master_sku                                 AS master_sku,
          MIN(name)                                  AS name,
          MIN(barcode)                               AS barcode,
          MIN(sku)                                   AS sku,
          AVG(price)::numeric(10,2)                  AS avg_price,
          AVG(cost_price)::numeric(10,2)             AS avg_cost,
          SUM(stock_qty)::numeric                    AS total_stock,
          MIN(image_url)                             AS image_url,
          MIN(category)                              AS category,
          MIN(unit)                                  AS unit,
          COUNT(DISTINCT company_id)::int            AS company_count,
          COUNT(*)::int                              AS product_count,
          jsonb_agg(jsonb_build_object(
            'product_id',   id,
            'company_id',   company_id,
            'company_name', company_name,
            'stock_qty',    stock_qty,
            'price',        price
          ) ORDER BY company_name)                   AS items
        FROM all_products
        WHERE master_sku IS NOT NULL
        GROUP BY master_sku

        UNION ALL

        -- Produtos sem master_sku: cada um é seu próprio "grupo" de 1
        SELECT
          'solo:' || id::text                        AS group_key,
          NULL                                       AS master_sku,
          name,
          barcode,
          sku,
          price                                      AS avg_price,
          cost_price                                 AS avg_cost,
          stock_qty                                  AS total_stock,
          image_url,
          category,
          unit,
          1                                          AS company_count,
          1                                          AS product_count,
          jsonb_build_array(jsonb_build_object(
            'product_id',   id,
            'company_id',   company_id,
            'company_name', company_name,
            'stock_qty',    stock_qty,
            'price',        price
          ))                                         AS items
        FROM all_products
        WHERE master_sku IS NULL
      )
      SELECT * FROM grouped
       ORDER BY name
       LIMIT 500`,
      [ownerCompanyIds]
    );

    res.json({
      products: rows.map((r) => ({
        group_key:     r.group_key,
        master_sku:    r.master_sku,
        is_linked:     r.master_sku !== null && r.product_count > 1,
        name:          r.name,
        barcode:       r.barcode,
        sku:           r.sku,
        avg_price:     parseFloat(r.avg_price) || 0,
        avg_cost:      parseFloat(r.avg_cost)  || 0,
        total_stock:   parseFloat(r.total_stock) || 0,
        image_url:     r.image_url,
        category:      r.category,
        unit:          r.unit,
        company_count: r.company_count,
        product_count: r.product_count,
        items:         r.items,
      })),
      total: rows.length,
      searched_companies: ownerCompanyIds.length,
    });
  } catch (err) {
    console.error('[productLinks] aggregated error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar produtos agregados', detail: err.message });
  }
});

module.exports = router;
