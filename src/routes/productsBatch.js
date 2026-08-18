// ============================================================
// AURA. -- Products Batch Create (lote)
// Mount: /companies/:id/products/batch-create
//
// Cria N produtos de uma vez em uma transacao, respeitando
// o limite do plano (essencial=2000, negocio=7000, expansao=unlimited).
//
// Duplicados SAO PERMITIDOS (mesmo nome na mesma categoria OK) -- o
// aviso de "X duplicados criados" fica no frontend.
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { linkImportedCategories } = require('../services/importCategoryLink');

function getPlanLimit(plan) {
  switch ((plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 999999;
    case 'negocio':       return 7000;
    default:              return 2000;
  }
}

function normalizeHexColor(val) {
  if (!val || typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;
  return null;
}

// POST /companies/:id/products/batch-create
// Body: { products: [{ name, price, cost_price, stock_qty, category, size, color, sku, barcode }] }
// Response: { created: [...], total_created: N, total_requested: M, duplicates: X, errors: [{ index, message }] }
router.post('/batch-create', async (req, res) => {
  const cid = req.params.id;
  const input = Array.isArray(req.body?.products) ? req.body.products : null;

  if (!input || input.length === 0) {
    return res.status(400).json({ error: 'products[] eh obrigatorio e nao pode estar vazio' });
  }
  if (input.length > 200) {
    return res.status(400).json({ error: 'Maximo de 200 produtos por lote' });
  }

  // Valida estrutura minima (name obrigatorio em cada linha)
  const errors = [];
  const valid = [];
  input.forEach((p, idx) => {
    const name = p?.name ? String(p.name).trim() : '';
    if (!name) {
      errors.push({ index: idx, message: 'Nome vazio' });
      return;
    }
    valid.push({
      name,
      price:       parseFloat(p.price)      || 0,
      cost_price:  parseFloat(p.cost_price) || 0,
      stock_qty:   parseInt(p.stock_qty)    || 0,
      category:    p.category ? String(p.category).trim() : 'Produtos',
      size:        p.size ? String(p.size).slice(0, 100) : null,
      color:       normalizeHexColor(p.color),
      sku:         p.sku ? String(p.sku).trim() || null : null,
      barcode:     p.barcode ? String(p.barcode).trim() || null : null,
    });
  });

  if (valid.length === 0) {
    return res.status(400).json({ error: 'Nenhum produto valido no lote', errors });
  }

  // Checa limite do plano: count atual + batch <= plan_limit
  try {
    const planLimit = getPlanLimit(req.user?.plan);
    const countRes = await db.query(
      'SELECT COUNT(*) AS total FROM products WHERE company_id = $1',
      [cid]
    );
    const current = parseInt(countRes.rows[0]?.total) || 0;
    if (current + valid.length > planLimit) {
      return res.status(403).json({
        error: `Limite do plano excedido. Atualmente com ${current} produtos, tentando adicionar ${valid.length}. Limite: ${planLimit}.`,
        limit: planLimit,
        current,
        attempted: valid.length,
      });
    }
  } catch (err) {
    console.error('[productsBatch] count check error:', err.message);
    // Nao bloqueia o fluxo se o count falhar - prossegue
  }

  // Detecta duplicados (mesmo nome + categoria ja existente) pra relatar
  // no response. NAO bloqueia insercao (regra: permite duplicado, avisa).
  let duplicates = 0;
  try {
    const names = [...new Set(valid.map(v => v.name.toLowerCase()))];
    const { rows: existing } = await db.query(
      `SELECT LOWER(name) AS name, category FROM products
       WHERE company_id = $1 AND LOWER(name) = ANY($2::text[])`,
      [cid, names]
    );
    const existingSet = new Set(existing.map(e => `${e.name}|${e.category || 'Produtos'}`));
    valid.forEach(v => {
      const key = `${v.name.toLowerCase()}|${v.category || 'Produtos'}`;
      if (existingSet.has(key)) duplicates++;
    });
  } catch (err) {
    console.error('[productsBatch] duplicate detection error:', err.message);
  }

  // Bulk INSERT em transacao
  const client = await db.connect();
  const created = [];
  let categorias = { linked: 0, pending: [], ambiguous: [], skipped: false };
  try {
    await client.query('BEGIN');

    // Monta VALUES parametrizado: ($1,$2,$3,...), ($N,$N+1,...)
    const cols = ['company_id', 'name', 'sku', 'barcode', 'category', 'price', 'cost_price', 'stock_qty', 'size', 'color'];
    const N = cols.length;
    const params = [];
    const tuples = [];
    valid.forEach((v, i) => {
      const base = i * N;
      tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`);
      params.push(
        cid, v.name, v.sku, v.barcode, v.category,
        v.price, v.cost_price, v.stock_qty, v.size, v.color
      );
    });

    const { rows } = await client.query(
      `INSERT INTO products (${cols.join(', ')}) VALUES ${tuples.join(', ')}
       RETURNING id, name, sku, barcode, category, price, cost_price, stock_qty, size, color, created_at`,
      params
    );
    rows.forEach(r => created.push(r));

    // D4: vincula categoria na arvore (ou deixa pendente no wizard).
    // DENTRO da transacao: ou o lote inteiro entra com vinculo, ou nada
    // entra -- produto criado com vinculo faltando seria pior que o
    // legado, porque o wizard nao reprocessa quem ja tem link.
    categorias = await linkImportedCategories(client, cid, rows);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[productsBatch] insert error:', err.message, err.code);
    client.release();
    return res.status(500).json({ error: 'Erro ao criar produtos em lote', detail: err.message });
  }
  client.release();

  return res.status(201).json({
    created,
    total_created:   created.length,
    total_requested: input.length,
    duplicates,
    errors,
    // D4: mesma razao do importData -- o que ficou pendente no wizard
    // precisa aparecer para quem criou o lote.
    categorias: {
      vinculados: categorias.linked,
      pendentes:  categorias.pending,
      ambiguos:   categorias.ambiguous,
    },
  });
});

module.exports = router;
