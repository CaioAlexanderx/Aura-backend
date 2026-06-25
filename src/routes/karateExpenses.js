// ============================================================
// AURA KARATÊ — Rotas de Lançamentos + Inadimplência (Track B)
//
// "Lançamentos" = lançamentos manuais avulsos da federação, ENTRADAS (income)
// e SAÍDAS (expense). Antes era só "Saídas" (despesas). Reusa transactions.type
// (income/expense) — sem migration.
//
// GET    /financial/expenses            — lista lançamentos (entradas + saídas), com filtros
// POST   /financial/expenses            — lança um lançamento (kind: income|expense)
// PATCH  /financial/expenses/:entryId   — edita um lançamento
// DELETE /financial/expenses/:entryId   — remove um lançamento
// GET    /financial/overdue             — inadimplentes (dojôs + CPF)
// POST   /financial/overdue/:targetId/remind — enfileira cobrança (stub Fase 6)
//
// Guard: adminOnly() — financeiro é sensível.
//
// NOTA DE SCHEMA (23/06): transactions.status é o enum transaction_status
// (pending/confirmed/cancelled). \"Em aberto/vencido\" = status='pending' com
// due_date no passado. customers tem coluna `name` (não `full_name`).
// transactions.reference_id é uuid: comparar com customers.id (uuid) sem ::text.
// (karate_dojo_annuity_history.status é TEXTO e usa 'paid' — mantido.)
//
// NOTA (25/06): transactions.due_date é NOT NULL → todo lançamento exige data
// (default = hoje se não enviada). transactions.category é text livre.
// Saída (expense) entra como status='pending' (compat DRE/fluxo, que somam toda
// despesa). Entrada (income) entra como status='confirmed' para já contar como
// receita realizada no DRE (que só soma income confirmado). Anuidades NÃO passam
// por aqui — continuam vindo de karate_dojo_annuity_history / annuity_cpf.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

// Categorias de SAÍDA (despesa) — herdadas da aba "Saídas" original.
const EXPENSE_CATEGORIES = [
  'expense_cost',
  'expense_repasse',
  'expense_certificate',
  'expense_award',
  'expense_other',
];

// Categorias de ENTRADA (receita avulsa manual). Anuidades têm fonte própria.
const INCOME_CATEGORIES = [
  'income_event',
  'income_sponsorship',
  'income_donation',
  'income_sale',
  'income_other',
];

const VALID_CATEGORIES_BY_KIND = {
  expense: EXPENSE_CATEGORIES,
  income: INCOME_CATEGORIES,
};

// kind (FE) <-> type (DB)
function normalizeKind(raw) {
  if (raw === undefined || raw === null || raw === '') return 'expense'; // default seguro (compat)
  const k = String(raw).toLowerCase();
  if (k === 'income' || k === 'entrada') return 'income';
  if (k === 'expense' || k === 'saida' || k === 'saída') return 'expense';
  return null;
}

function rowToEntry(r) {
  return {
    id: r.id,
    kind: r.type, // 'income' | 'expense'
    amount: parseFloat(r.amount),
    category: r.category,
    description: r.description,
    due_date: r.due_date || null,
    reference_type: r.reference_type || null,
    reference_id: r.reference_id || null,
    status: r.status,
    created_at: r.created_at,
  };
}

const RETURNING_COLS =
  'id, type, category, amount, description, due_date, reference_type, reference_id, status, created_at';

// GET /financial/expenses
// Filtros (query): kind=income|expense, category, q (busca em description),
// from / to (YYYY-MM-DD, sobre due_date), page, pageSize.
router.get('/expenses', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;

  // type = 'expense' OR 'income' — manuais avulsos da federação.
  const where = [
    `company_id = $1`,
    `federation_id = $1`,
    `type IN ('income','expense')`,
  ];
  const params = [federationId];

  const kind = req.query.kind ? normalizeKind(req.query.kind) : null;
  if (req.query.kind && !kind) {
    return res.status(422).json({ error: "kind deve ser 'income' ou 'expense'", code: 'VALIDATION_ERROR' });
  }
  if (kind) { params.push(kind); where.push(`type = $${params.length}`); }

  if (req.query.category) { params.push(String(req.query.category)); where.push(`category = $${params.length}`); }
  if (req.query.q)        { params.push(`%${String(req.query.q).trim()}%`); where.push(`description ILIKE $${params.length}`); }
  if (req.query.from)     { params.push(String(req.query.from)); where.push(`due_date >= $${params.length}`); }
  if (req.query.to)       { params.push(String(req.query.to));   where.push(`due_date <= $${params.length}`); }

  const whereSql = where.join(' AND ');

  try {
    const dataParams = [...params, pageSize, offset];
    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) AS total FROM transactions WHERE ${whereSql}`, params),
      db.query(
        `SELECT ${RETURNING_COLS}
         FROM transactions
         WHERE ${whereSql}
         ORDER BY due_date DESC, created_at DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
        dataParams
      ),
    ]);

    const total = parseInt(countRes.rows[0].total, 10);
    res.json({ page, page_size: pageSize, total, data: dataRes.rows.map(rowToEntry) });
  } catch (err) {
    console.error('[karateExpenses] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar lançamentos' });
  }
});

// POST /financial/expenses
// Body: { kind?: 'income'|'expense' (default expense), amount, category, description,
//         due_date?, reference_type?, reference_id? }
router.post('/expenses', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { amount, category, description, due_date, reference_type, reference_id } = req.body;

  const kind = normalizeKind(req.body.kind);
  if (!kind) {
    return res.status(422).json({ error: "kind deve ser 'income' ou 'expense'", code: 'VALIDATION_ERROR' });
  }

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(422).json({ error: 'amount obrigatorio e deve ser > 0', code: 'VALIDATION_ERROR' });
  }
  const validCats = VALID_CATEGORIES_BY_KIND[kind];
  if (!category || !validCats.includes(category)) {
    return res.status(422).json({
      error: `category deve ser um de: ${validCats.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!description || !String(description).trim()) {
    return res.status(422).json({ error: 'description obrigatorio', code: 'VALIDATION_ERROR' });
  }

  // due_date é NOT NULL no schema → default hoje se não enviada.
  const dueDate = due_date || new Date().toISOString().slice(0, 10);
  // Entrada manual = receita realizada (conta no DRE, que só soma income confirmado).
  // Saída segue como pending (compat com somatórios de despesa existentes).
  const status = kind === 'income' ? 'confirmed' : 'pending';

  try {
    const { rows } = await db.query(
      `INSERT INTO transactions
         (company_id, federation_id, type, category, amount, description,
          due_date, reference_type, reference_id, status, created_at, updated_at)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING ${RETURNING_COLS}`,
      [
        federationId,
        kind,
        category,
        Number(amount),
        String(description).trim(),
        dueDate,
        reference_type || null,
        reference_id || null,
        status,
      ]
    );

    res.status(201).json(rowToEntry(rows[0]));
  } catch (err) {
    console.error('[karateExpenses] create error:', err.message);
    res.status(500).json({ error: 'Erro ao lançar', detail: err.message });
  }
});

// PATCH /financial/expenses/:entryId
// Body: campos editáveis { amount?, category?, description?, due_date? }.
// kind/type NÃO é alterável (entrada não vira saída). Só lançamentos manuais
// (type IN income/expense) desta federação.
router.patch('/expenses/:entryId', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { entryId } = req.params;

  try {
    const { rows: cur } = await db.query(
      `SELECT id, type, category FROM transactions
       WHERE id = $1 AND company_id = $2 AND federation_id = $2 AND type IN ('income','expense')
       LIMIT 1`,
      [entryId, federationId]
    );
    if (!cur.length) {
      return res.status(404).json({ error: 'Lançamento não encontrado', code: 'NOT_FOUND' });
    }
    const kind = cur[0].type;

    const sets = [];
    const params = [];

    if (req.body.amount !== undefined) {
      if (isNaN(Number(req.body.amount)) || Number(req.body.amount) <= 0) {
        return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
      }
      params.push(Number(req.body.amount)); sets.push(`amount = $${params.length}`);
    }
    if (req.body.category !== undefined) {
      const validCats = VALID_CATEGORIES_BY_KIND[kind];
      if (!validCats.includes(req.body.category)) {
        return res.status(422).json({
          error: `category deve ser um de: ${validCats.join(', ')}`,
          code: 'VALIDATION_ERROR',
        });
      }
      params.push(req.body.category); sets.push(`category = $${params.length}`);
    }
    if (req.body.description !== undefined) {
      if (!String(req.body.description).trim()) {
        return res.status(422).json({ error: 'description não pode ser vazio', code: 'VALIDATION_ERROR' });
      }
      params.push(String(req.body.description).trim()); sets.push(`description = $${params.length}`);
    }
    if (req.body.due_date !== undefined) {
      if (!req.body.due_date) {
        return res.status(422).json({ error: 'due_date não pode ser vazio', code: 'VALIDATION_ERROR' });
      }
      params.push(String(req.body.due_date)); sets.push(`due_date = $${params.length}`);
    }

    if (!sets.length) {
      return res.status(422).json({ error: 'Nada para atualizar', code: 'VALIDATION_ERROR' });
    }
    sets.push(`updated_at = NOW()`);

    params.push(entryId);
    params.push(federationId);
    const { rows } = await db.query(
      `UPDATE transactions SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND company_id = $${params.length} AND federation_id = $${params.length}
         AND type IN ('income','expense')
       RETURNING ${RETURNING_COLS}`,
      params
    );

    res.json(rowToEntry(rows[0]));
  } catch (err) {
    console.error('[karateExpenses] patch error:', err.message);
    res.status(500).json({ error: 'Erro ao editar lançamento', detail: err.message });
  }
});

// DELETE /financial/expenses/:entryId
// Remove um lançamento manual (entrada ou saída) desta federação.
router.delete('/expenses/:entryId', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { entryId } = req.params;

  try {
    const { rows } = await db.query(
      `DELETE FROM transactions
       WHERE id = $1 AND company_id = $2 AND federation_id = $2 AND type IN ('income','expense')
       RETURNING id`,
      [entryId, federationId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Lançamento não encontrado', code: 'NOT_FOUND' });
    }
    res.json({ deleted: true, id: rows[0].id });
  } catch (err) {
    console.error('[karateExpenses] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover lançamento' });
  }
});

// GET /financial/overdue
// Inadimplentes: dojôs com status overdue/defaulting/suspended (via annuity_history)
// + praticantes com anuidade vencida.
router.get('/overdue', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;

  try {
    const year = new Date().getFullYear().toString();
    const dayMs = 1000 * 60 * 60 * 24;
    const now = new Date();

    // Dojôs inadimplentes (via karate_dojo_annuity_history — status TEXTO 'paid')
    const { rows: dojoRows } = await db.query(
      `SELECT
         c.id AS target_id, c.name,
         h.amount, h.due_date, h.status AS annuity_status,
         h.paid_at
       FROM companies c
       JOIN karate_dojo_annuity_history h
         ON h.dojo_id = c.id AND h.reference_period = $2
       WHERE c.federation_id = $1
         AND c.vertical = 'karate_dojo'
         AND h.status != 'paid'
         AND h.due_date < CURRENT_DATE`,
      [federationId, year]
    );

    // Praticantes inadimplentes (via transactions — enum: em aberto = 'pending')
    const { rows: cpfRows } = await db.query(
      `SELECT
         cu.id AS target_id,
         cu.name AS name,
         t.amount, t.due_date, t.status AS tx_status
       FROM customers cu
       JOIN transactions t
         ON t.reference_type = 'customer'
         AND t.reference_id = cu.id
         AND t.category = 'annuity_cpf'
         AND t.federation_id = $1
         AND EXTRACT(YEAR FROM t.due_date) = $2
       WHERE cu.federation_id = $1
         AND t.status = 'pending'
         AND t.due_date < CURRENT_DATE`,
      [federationId, parseInt(year, 10)]
    );

    const overdueDojos = dojoRows.map(r => {
      const daysOverdue = Math.max(0, Math.round((now - new Date(r.due_date)) / dayMs));
      const annuityStatus = daysOverdue <= 90 ? 'overdue'
                          : daysOverdue <= 180 ? 'defaulting'
                          : 'suspended';
      return {
        target_type: 'dojo',
        target_id: r.target_id,
        name: r.name,
        amount: parseFloat(r.amount),
        days_overdue: daysOverdue,
        status: annuityStatus,
        last_reminder_at: null, // a implementar quando régua de cobrança for ativa (Fase 6)
      };
    });

    const overdueCpf = cpfRows.map(r => {
      const daysOverdue = Math.max(0, Math.round((now - new Date(r.due_date)) / dayMs));
      const annuityStatus = daysOverdue <= 90 ? 'overdue'
                          : daysOverdue <= 180 ? 'defaulting'
                          : 'suspended';
      return {
        target_type: 'cpf',
        target_id: r.target_id,
        name: r.name,
        amount: parseFloat(r.amount),
        days_overdue: daysOverdue,
        status: annuityStatus,
        last_reminder_at: null,
      };
    });

    // Ordena por dias de atraso desc
    const all = [...overdueDojos, ...overdueCpf]
      .sort((a, b) => b.days_overdue - a.days_overdue);

    res.json(all);
  } catch (err) {
    console.error('[karateExpenses] overdue error:', err.message);
    res.status(500).json({ error: 'Erro ao listar inadimplentes' });
  }
});

// POST /financial/overdue/:targetId/remind
// Enfileira cobrança (WhatsApp/e-mail). Régua completa fica na Fase 6.
// Por ora: apenas valida + retorna { queued: true } como stub.
router.post('/overdue/:targetId/remind', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, targetId } = req.params;
  const { channel, target_type } = req.body;

  if (!channel || !['whatsapp', 'email'].includes(channel)) {
    return res.status(422).json({
      error: 'channel obrigatorio: whatsapp ou email',
      code: 'VALIDATION_ERROR',
    });
  }
  if (!target_type || !['dojo', 'cpf'].includes(target_type)) {
    return res.status(422).json({
      error: 'target_type obrigatorio: dojo ou cpf',
      code: 'VALIDATION_ERROR',
    });
  }

  try {
    // Verifica que o target existe e é inadimplente
    let targetExists = false;
    if (target_type === 'dojo') {
      const { rows } = await db.query(
        `SELECT id FROM companies WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
        [targetId, federationId]
      );
      targetExists = rows.length > 0;
    } else {
      const { rows } = await db.query(
        `SELECT id FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
        [targetId, federationId]
      );
      targetExists = rows.length > 0;
    }

    if (!targetExists) {
      return res.status(404).json({ error: 'Alvo não encontrado', code: 'NOT_FOUND' });
    }

    // Stub: loga e retorna queued=true
    // Fase 6: integrar WhatsApp (webhookWhatsapp) e e-mail aqui.
    console.log(`[karateExpenses] remind queued: target_type=${target_type}, target_id=${targetId}, channel=${channel}, federation=${federationId}`);

    res.status(202).json({ queued: true });
  } catch (err) {
    console.error('[karateExpenses] remind error:', err.message);
    res.status(500).json({ error: 'Erro ao enfileirar cobrança' });
  }
});

module.exports = router;
