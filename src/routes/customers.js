// ============================================================
// AURA. -- S5: Customers CRUD
// Plan limits: essencial=1000, negocio=5000, expansao=unlimited
// Plan comes from req.user.plan (JWT token), not req.company
//
// MULTICNPJ Sessao 2 Onda 2.3 (03/05/2026): clientes sao
// owner-scoped. GET / lista clientes de TODAS as empresas do
// mesmo dono. POST / continua criando na empresa atual (req.params.id),
// mas o plan limit conta o owner inteiro. PATCH/DELETE permitem
// editar cliente "registrado em outra loja" do mesmo dono.
//
// Justificativa em src/utils/ownerScope.js.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');

function getPlanLimit(plan) {
  switch ((plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 999999;
    case 'negocio':       return 5000;
    default:              return 1000; // essencial / trial / unknown
  }
}

// GET / -- list customers (owner-scoped: todas as empresas do owner)
router.get('/', async (req, res) => {
  const companyId = req.params.id;
  const planLimit = getPlanLimit(req.user?.plan);
  const limit = Math.min(parseInt(req.query.limit) || planLimit, planLimit);
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.search;

  try {
    // MULTICNPJ Onda 2.3: expande pra todas as empresas do owner
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    if (ownerCompanyIds.length === 0) {
      return res.json({ customers: [], total: 0, limit, offset, plan_limit: planLimit });
    }

    let where = 'WHERE c.company_id = ANY($1)';
    const params = [ownerCompanyIds];
    if (search) {
      where += ` AND (c.name ILIKE $${params.length + 1} OR c.email ILIKE $${params.length + 1} OR c.phone ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    const countRes = await db.query(`SELECT COUNT(*) AS total FROM customers c ${where}`, params);

    // JOIN companies pra trazer nome da loja onde foi registrado (info pra UI)
    const dataRes = await db.query(
      `SELECT c.id, c.name, c.cpf_cnpj, c.email, c.phone, c.birth_date, c.instagram_handle,
              c.total_purchases, c.total_spent, c.last_purchase_at, c.first_purchase_at,
              c.notes, c.is_active, c.created_at, c.company_id,
              comp.trade_name AS company_trade, comp.legal_name AS company_legal
       FROM customers c
       JOIN companies comp ON comp.id = c.company_id
       ${where}
       ORDER BY c.name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const customers = dataRes.rows.map(r => ({
      id: r.id, name: r.name || '', email: r.email || '', phone: r.phone || '',
      cpf_cnpj: r.cpf_cnpj || '',
      birthday: r.birth_date ? new Date(r.birth_date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '',
      birth_date: r.birth_date, instagram: r.instagram_handle || '', instagram_handle: r.instagram_handle || '',
      total_spent: parseFloat(r.total_spent) || 0, totalSpent: parseFloat(r.total_spent) || 0,
      visits: parseInt(r.total_purchases) || 0, visit_count: parseInt(r.total_purchases) || 0,
      last_purchase: r.last_purchase_at, first_visit: r.first_purchase_at,
      notes: r.notes || '', is_active: r.is_active !== false, rating: null, created_at: r.created_at,
      // Multi-CNPJ: empresa onde foi cadastrado (FE mostra badge se owner tem 2+ lojas)
      company_id: r.company_id,
      company_name: r.company_trade || r.company_legal || 'Empresa',
    }));

    res.json({
      customers,
      total: parseInt(countRes.rows[0]?.total) || 0,
      limit, offset,
      plan_limit: planLimit,
    });
  } catch (err) {
    console.error('[customers] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// POST / -- create customer (na empresa atual, com plan limit do OWNER inteiro)
router.post('/', async (req, res) => {
  const companyId = req.params.id;
  const { name, email, phone, notes, birthday, birth_date, instagram, instagram_handle, cpf_cnpj } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }

  // MULTICNPJ Onda 2.3: plan limit conta TODOS os clientes do owner,
  // alinhado com a decisao de lista unica.
  try {
    const planLimit = getPlanLimit(req.user?.plan);
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    if (ownerCompanyIds.length > 0) {
      const countRes = await db.query(
        'SELECT COUNT(*) AS total FROM customers WHERE company_id = ANY($1)',
        [ownerCompanyIds]
      );
      const current = parseInt(countRes.rows[0]?.total) || 0;
      if (current >= planLimit) {
        return res.status(403).json({
          error: `Limite de clientes atingido para o seu plano (${planLimit} registros). Faca upgrade para continuar.`,
          limit: planLimit, current,
        });
      }
    }
  } catch (err) {
    console.error('[customers] count check error:', err.message);
  }

  const finalBirthDate = birth_date || birthday || null;
  const finalInstagram = instagram_handle || instagram || null;

  try {
    const result = await db.query(
      `INSERT INTO customers (company_id, name, email, phone, notes, birth_date, instagram_handle, cpf_cnpj)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [companyId, String(name).trim(), email || null, phone || null, notes || null, finalBirthDate, finalInstagram, cpf_cnpj || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[customers] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar cliente' });
  }
});

// PATCH /:cid -- update customer (owner-scoped: pode editar de qualquer loja do owner)
router.patch('/:cid', async (req, res) => {
  const { id: companyId, cid } = req.params;
  const fieldMap = {
    name: 'name', email: 'email', phone: 'phone', notes: 'notes',
    cpf_cnpj: 'cpf_cnpj', birth_date: 'birth_date', birthday: 'birth_date',
    instagram: 'instagram_handle', instagram_handle: 'instagram_handle', is_active: 'is_active',
  };
  const updates = []; const values = []; let idx = 1;
  const seen = new Set();

  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[bodyKey] !== undefined && !seen.has(dbCol)) {
      updates.push(`${dbCol} = $${idx}`);
      values.push(req.body[bodyKey]);
      idx++; seen.add(dbCol);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()');

  try {
    // MULTICNPJ Onda 2.3: pode editar cliente "de outra loja" do mesmo owner
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    values.push(cid, ownerCompanyIds);

    const result = await db.query(
      `UPDATE customers SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = ANY($${idx + 1}) RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[customers] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar cliente' });
  }
});

// DELETE /:cid (owner-scoped tambem)
router.delete('/:cid', async (req, res) => {
  const { id: companyId, cid } = req.params;
  try {
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    const result = await db.query(
      'DELETE FROM customers WHERE id = $1 AND company_id = ANY($2) RETURNING id, name',
      [cid, ownerCompanyIds]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
    res.json({ deleted: true, id: cid, name: result.rows[0].name });
  } catch (err) {
    console.error('[customers] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao deletar cliente' });
  }
});

module.exports = router;
