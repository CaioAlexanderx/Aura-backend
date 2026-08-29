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
// FEAT 05/05/2026: GET / agora retorna credit_balance (saldo de
// crediario na empresa onde o cliente foi cadastrado), via LEFT JOIN
// com a view customer_credit_balances. Crediario e por (customer_id,
// company_id), entao cada cliente exibe o saldo da sua propria loja.
//
// 13/05/2026: removido gate global requirePlan('negocio'+) que
// bloqueava TODAS as rotas (inclusive GET) para o plano Essencial.
// O plano Essencial tem limite de 1000 clientes, ja aplicado no
// POST via getPlanLimit. GET de listagem nunca deve ser bloqueado
// (armadilha_plan_limit_listagem). requirePlan era overly broad.
//
// 06/06/2026: adicionado parseBirthDate para aceitar tanto
// dd/mm/yyyy (formato do DateInput do app) quanto yyyy-mm-dd,
// validar e retornar null se invalido. Evita o erro Postgres
// "date/time field value out of range" quando o FE enviava
// valores como "1984-95-97" (conversao mal-feita de dd/mm/yyyy).
//
// 29/08/2026 (QA de usabilidade): GET / aceita ?sort=recent. O seletor de
// cliente do PDV abria em ordem alfabetica (Abbey, Abdel, Adamo...), a
// ordenacao menos util possivel com o cliente na frente do balcao. O
// default continua sendo o alfabetico -- a tela de Clientes e uma agenda,
// onde procurar pelo nome faz sentido; o balcao e que precisa de recencia.
//
// Ordenar no BANCO, nao no app: o app so recebe a primeira pagina, entao
// ordenar o que chegou colocaria no topo o cliente mais recente ENTRE OS
// PRIMEIROS ALFABETICAMENTE, nao o mais recente de verdade.
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

/**
 * Normaliza birth_date para yyyy-mm-dd antes de mandar ao Postgres.
 * Aceita:
 *   - dd/mm/yyyy  (formato do DateInput do app)
 *   - yyyy-mm-dd  (ISO, ja correto)
 * Retorna null se vazio, invalido ou fora de range razoavel.
 */
function parseBirthDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let year, month, day;

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    // dd/mm/yyyy
    [day, month, year] = s.split('/').map(Number);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // yyyy-mm-dd
    [year, month, day] = s.split('-').map(Number);
  } else {
    return null;
  }

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1900 || year > new Date().getFullYear()) return null;

  // Validacao real da data (ex: 31/02 seria invalido)
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}


/**
 * ORDER BY da listagem de clientes.
 *
 * 'recent' = atendidos por ultimo primeiro. NULLS LAST porque quem nunca
 * comprou nao pode ocupar o topo do balcao; o desempate alfabetico deixa
 * o bloco dos "sem compra" navegavel. last_purchase_at e confiavel desde
 * a migration 311 (antes era NOW() fixo, que mentia em cancelamento e em
 * venda retroativa).
 *
 * Whitelist fechada: o valor entra concatenado no SQL.
 */
function buildOrderBy(sort, alias) {
  const a = alias ? alias + '.' : '';
  switch (String(sort || '').toLowerCase()) {
    case 'recent':
      return `ORDER BY ${a}last_purchase_at DESC NULLS LAST, ${a}name ASC`;
    default:
      return `ORDER BY ${a}name ASC`;
  }
}

// GET / -- list customers (owner-scoped: todas as empresas do owner)
router.get('/', async (req, res) => {
  const companyId = req.params.id;
  const planLimit = getPlanLimit(req.user?.plan);
  const limit = Math.min(parseInt(req.query.limit) || planLimit, planLimit);
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.search;
  const orderBy = buildOrderBy(req.query.sort, 'c');

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
    // LEFT JOIN customer_credit_balances pra trazer saldo do crediario.
    // Match por (customer_id, company_id) pra respeitar o escopo da view.
    // 29/08/2026: o saldo do crediario e ENFEITE nesta tela; a lista de
    // clientes nao pode morrer junto com ele. A view
    // customer_credit_balances some em deploy parcial / banco restaurado
    // sem as migrations de crediario, e ai um 42P01 virava 500 -> a tela
    // inteira em branco com "Total de clientes: 0" (armadilha 10 do
    // CLAUDE.md). Sem a view, lista sem o saldo.
    const selectCustomers = (comCredito) => `
      SELECT c.id, c.name, c.cpf_cnpj, c.email, c.phone, c.birth_date, c.instagram_handle,
             c.total_purchases, c.total_spent, c.last_purchase_at, c.first_purchase_at,
             c.notes, c.is_active, c.created_at, c.company_id,
             comp.trade_name AS company_trade, comp.legal_name AS company_legal,
             ${comCredito ? 'COALESCE(cb.balance, 0)' : '0'} AS credit_balance
        FROM customers c
        JOIN companies comp ON comp.id = c.company_id
        ${comCredito ? `LEFT JOIN customer_credit_balances cb
          ON cb.customer_id = c.id AND cb.company_id = c.company_id` : ''}
       ${where}
       ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    let dataRes;
    try {
      dataRes = await db.query(selectCustomers(true), [...params, limit, offset]);
    } catch (creditErr) {
      if (creditErr.code !== '42P01' && creditErr.code !== '42703') throw creditErr;
      console.warn('[customers] customer_credit_balances indisponivel, listando sem saldo:', creditErr.code);
      dataRes = await db.query(selectCustomers(false), [...params, limit, offset]);
    }

    const customers = dataRes.rows.map(r => ({
      id: r.id, name: r.name || '', email: r.email || '', phone: r.phone || '',
      cpf_cnpj: r.cpf_cnpj || '',
      birthday: r.birth_date ? new Date(r.birth_date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '',
      birth_date: r.birth_date, instagram: r.instagram_handle || '', instagram_handle: r.instagram_handle || '',
      total_spent: parseFloat(r.total_spent) || 0, totalSpent: parseFloat(r.total_spent) || 0,
      visits: parseInt(r.total_purchases) || 0, visit_count: parseInt(r.total_purchases) || 0,
      last_purchase: r.last_purchase_at,
      // Alias explicito: o nome da coluna, pro app nao ter que adivinhar
      // que 'last_purchase' e um timestamp. Aditivo -- last_purchase fica.
      last_purchase_at: r.last_purchase_at,
      first_visit: r.first_purchase_at, first_purchase_at: r.first_purchase_at,
      notes: r.notes || '', is_active: r.is_active !== false, rating: null, created_at: r.created_at,
      // Multi-CNPJ: empresa onde foi cadastrado (FE mostra badge se owner tem 2+ lojas)
      company_id: r.company_id,
      company_name: r.company_trade || r.company_legal || 'Empresa',
      // Crediario: saldo > 0 = cliente deve. Saldo na empresa onde ele foi cadastrado.
      credit_balance: parseFloat(r.credit_balance) || 0,
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

  const finalBirthDate = parseBirthDate(birth_date || birthday);
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
      let val = req.body[bodyKey];
      // Sanitiza datas antes de mandar ao Postgres
      if (dbCol === 'birth_date') val = parseBirthDate(val);
      updates.push(`${dbCol} = $${idx}`);
      values.push(val);
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
