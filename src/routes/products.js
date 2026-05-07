// ============================================================
// AURA. -- S4: Products CRUD
// Plan limits: essencial=2000, negocio=7000, expansao=unlimited
// FIX: DELETE tries first, handles FK with retry
// FEAT: image_url included in GET and PATCH
// FEAT (mai/2026): ncm exposto no CRUD — pré-requisito do form de NCM
//   no aura-app. sanitizeNcm strip não-dígitos e exige 8 chars.
// FEAT (mai/2026): is_group_shared — produtos do billing_owner_company_id
//   ficam visíveis para CNPJs subsidiários do mesmo grupo (migration 100).
// FIX (mai/2026): multi-CNPJ WHERE usa subquery inline — sem round-trip
//   extra de coInfo, mantém 2 db.query calls no GET (compat. com testes).
// FIX (07/05/2026): GET listagem desacoplada do plan limit. Plan limit
//   ainda gating do CADASTRO (POST), mas o GET agora só aplica HARD_CAP
//   (20k) — clientes com produtos cadastrados acima do plano (import CSV
//   legacy ou downgrade) continuam enxergando todo o catálogo.
//   Bug Davi (07/05): plano negocio (7000) com 10.157 produtos →
//   3.157 produtos invisíveis no Estoque (filtro local não tinha como
//   achar barcodes que nem chegaram no payload). PDV não sofria porque
//   chama /scan que consulta direto no DB.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

// HARD_CAP: limite máximo de itens devolvidos em uma única chamada do GET,
// independente do plano. Defesa contra payload gigante / OOM no client.
// Acima disso o cliente precisa de busca server-side (TODO) ou paginação
// real via ?offset.
const HARD_CAP = 20000;

function getPlanLimit(plan) {
  switch ((plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 999999;
    case 'negocio':       return 7000;
    default:              return 2000;
  }
}

// NCM SEFAZ: 8 dígitos. Strip de pontos/espaços e valida tamanho.
// Retorna null pra entradas vazias/inválidas — não bloqueia request,
// só evita salvar lixo no banco. SEFAZ valida na hora de emitir nota.
function sanitizeNcm(raw) {
  if (raw === undefined || raw === null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length !== 8) return null;
  return digits;
}

// GET /
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const planLimit = getPlanLimit(req.user?.plan);
  // Listagem NÃO capa por plano (bug Davi #2 — 07/05). Default sem ?limit
  // = HARD_CAP, suficiente pra Davi (10157) e folga grande pra clientes
  // típicos. Cliente pode pedir ?limit=N (cap em HARD_CAP).
  const requested = parseInt(req.query.limit);
  const limit = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : HARD_CAP,
    HARD_CAP
  );
  const offset = parseInt(req.query.offset) || 0;
  const category = req.query.category;
  const search = req.query.search;

  try {
    // Visibilidade multi-CNPJ (migration 100): subquery inline — sem round-trip extra.
    // Subsidiárias enxergam produtos shared do billing_owner sem query separada.
    let where = `WHERE (company_id = $1 OR (
      is_group_shared = true
      AND company_id = (
        SELECT billing_owner_company_id FROM companies
        WHERE id = $1 AND billing_owner_company_id IS NOT NULL AND billing_owner_company_id != $1
      )
    ))`;
    const params = [cid];

    if (category) { where += ` AND category = $${params.length + 1}`; params.push(category); }
    if (search)   { where += ` AND (name ILIKE $${params.length + 1} OR sku ILIKE $${params.length + 1} OR barcode ILIKE $${params.length + 1})`; params.push(`%${search}%`); }

    const countRes = await db.query(`SELECT COUNT(*) AS total FROM products ${where}`, params);
    const dataRes = await db.query(
      `SELECT id, name, sku, barcode, category, description, price, cost_price,
              stock_qty, stock_min, stock_max, unit, color, size, image_url, ncm,
              is_active, is_group_shared, company_id, created_at,
              (SELECT EXISTS(SELECT 1 FROM product_variants pv WHERE pv.product_id = products.id AND pv.is_active = true)) AS has_variants
       FROM products ${where} ORDER BY name ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const products = dataRes.rows.map(r => ({
      id: r.id, name: r.name || '', sku: r.sku || '', barcode: r.barcode || '',
      category: r.category || 'Produtos', description: r.description || '',
      price: parseFloat(r.price) || 0, cost_price: parseFloat(r.cost_price) || 0,
      stock_qty: parseInt(r.stock_qty) || 0, min_stock: parseInt(r.stock_min) || 0,
      stock_max: parseInt(r.stock_max) || 0, unit: r.unit || 'un',
      color: r.color || '', size: r.size || '',
      image_url: r.image_url || '',
      ncm: r.ncm || '',
      is_active: r.is_active !== false,
      is_group_shared: r.is_group_shared || false,
      // stock_company_id exposto para o frontend saber qual CNPJ detém o estoque
      stock_company_id: r.company_id,
      created_at: r.created_at,
      has_variants: r.has_variants || false,
    }));

    res.json({ products, total: parseInt(countRes.rows[0]?.total) || 0, limit, offset, plan_limit: planLimit });
  } catch (err) { console.error('[products] list error:', err.message); res.status(500).json({ error: 'Erro ao listar produtos' }); }
});

// GET /:pid/variants
router.get('/:pid/variants', async (req, res) => {
  const { id: companyId, pid: productId } = req.params;
  try {
    // Permite buscar variantes de produto shared
    const { rows: check } = await db.query(
      `SELECT p.id FROM products p
       JOIN companies c ON c.id = $2
       WHERE p.id = $1
         AND (p.company_id = $2 OR (p.company_id = c.billing_owner_company_id AND p.is_group_shared = true))`,
      [productId, companyId]
    );
    if (!check.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const { rows } = await db.query(`
      SELECT pv.id, pv.sku_suffix, pv.price_override, pv.stock_qty, pv.barcode,
        COALESCE(json_agg(json_build_object('attribute', pvv.attribute_name, 'value', pvv.value) ORDER BY pvv.attribute_name) FILTER (WHERE pvv.id IS NOT NULL), '[]'::json) AS attributes
      FROM product_variants pv LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
      WHERE pv.product_id = $1 AND pv.is_active = true
      GROUP BY pv.id, pv.sku_suffix, pv.price_override, pv.stock_qty, pv.barcode ORDER BY pv.created_at ASC`, [productId]);
    res.json({ variants: rows });
  } catch (err) { console.error('[products] variants error:', err.message); res.status(500).json({ error: 'Erro ao buscar variantes' }); }
});

// POST /
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { name, sku, barcode, category, description, price, cost_price, stock_qty, min_stock, stock_max, unit, color, size, ncm } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name e obrigatorio' });

  try {
    const planLimit = getPlanLimit(req.user?.plan);
    const countRes = await db.query('SELECT COUNT(*) AS total FROM products WHERE company_id = $1', [cid]);
    const current = parseInt(countRes.rows[0]?.total) || 0;
    if (current >= planLimit) return res.status(403).json({ error: `Limite de produtos atingido (${planLimit}).`, limit: planLimit, current });
  } catch (err) { console.error('[products] count check error:', err.message); }

  try {
    const result = await db.query(
      `INSERT INTO products (company_id, name, sku, barcode, category, description, price, cost_price, stock_qty, stock_min, stock_max, unit, color, size, ncm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [cid, String(name).trim(), sku||null, barcode||null, category||'Produtos', description||null,
       parseFloat(price)||0, parseFloat(cost_price)||0, parseInt(stock_qty)||0, parseInt(min_stock)||0,
       parseInt(stock_max)||0, unit||'un', color && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : null,
       size ? String(size).slice(0,100) : null, sanitizeNcm(ncm)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error('[products] create error:', err.message); res.status(500).json({ error: 'Erro ao criar produto' }); }
});

// PATCH /:pid
router.patch('/:pid', async (req, res) => {
  const { id: cid, pid } = req.params;

  if (req.body.stock_qty_decrement !== undefined) {
    const decrement = parseInt(req.body.stock_qty_decrement);
    if (!decrement || decrement <= 0) return res.status(400).json({ error: 'stock_qty_decrement deve ser positivo' });
    try {
      const result = await db.query('UPDATE products SET stock_qty = GREATEST(0, stock_qty - $1), updated_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING *', [decrement, pid, cid]);
      if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
      return res.json(result.rows[0]);
    } catch (err) { console.error('[products] decrement error:', err.message); return res.status(500).json({ error: 'Erro ao decrementar estoque' }); }
  }

  const fieldMap = { name:'name', sku:'sku', barcode:'barcode', category:'category', description:'description', price:'price', cost_price:'cost_price', stock_qty:'stock_qty', min_stock:'stock_min', stock_max:'stock_max', unit:'unit', is_active:'is_active', color:'color', size:'size', image_url:'image_url', ncm:'ncm', is_group_shared:'is_group_shared' };
  const numFields = ['price','cost_price','stock_qty','stock_min','stock_max'];
  const updates = [], values = []; let idx = 1;
  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[bodyKey] !== undefined) {
      updates.push(`${dbCol} = $${idx}`); let val = req.body[bodyKey];
      if (numFields.includes(dbCol)) val = parseFloat(val);
      if (dbCol === 'color' && val && !/^#[0-9A-Fa-f]{6}$/.test(val)) val = null;
      if (dbCol === 'ncm') val = sanitizeNcm(val);
      values.push(val); idx++;
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()'); values.push(pid, cid);
  try {
    const result = await db.query(`UPDATE products SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx+1} RETURNING *`, values);
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    res.json(result.rows[0]);
  } catch (err) { console.error('[products] update error:', err.message); res.status(500).json({ error: 'Erro ao atualizar produto' }); }
});

// DELETE /:pid — try DELETE first, handle FK with nullify + retry
router.delete('/:pid', async (req, res) => {
  const { id: cid, pid } = req.params;
  try {
    const result = await db.query('DELETE FROM products WHERE id = $1 AND company_id = $2 RETURNING id, name', [pid, cid]);
    if (!result || !result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    res.json({ deleted: true, id: pid, name: result.rows[0].name });
  } catch (err) {
    if (err.code === '23503') {
      try {
        await db.query('UPDATE sale_items SET product_id = NULL WHERE product_id = $1', [pid]);
        await db.query('UPDATE barber_stock_movements SET product_id = NULL WHERE product_id = $1', [pid]);
        await db.query('UPDATE stock_movements SET product_id = NULL WHERE product_id = $1', [pid]);
        const retry = await db.query('DELETE FROM products WHERE id = $1 AND company_id = $2 RETURNING id, name', [pid, cid]);
        if (retry && retry.rows.length) return res.json({ deleted: true, id: pid, name: retry.rows[0].name });
        return res.status(404).json({ error: 'Produto nao encontrado' });
      } catch (retryErr) {
        console.error('[products] delete retry error:', retryErr.message, retryErr.code);
        return res.status(409).json({ error: 'Este produto esta vinculado a outros registros e nao pode ser excluido. Tente desativa-lo.', code: 'FK_VIOLATION' });
      }
    }
    console.error('[products] delete error:', err.message, err.code);
    res.status(500).json({ error: 'Erro ao deletar produto' });
  }
});

module.exports = router;
