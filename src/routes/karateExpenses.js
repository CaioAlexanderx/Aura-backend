// ============================================================
// AURA KARATÊ — Rotas de Saídas + Inadimplência (Track B)
//
// GET  /financial/expenses           — lista saídas (despesas)
// POST /financial/expenses           — lança saída
// GET  /financial/overdue            — inadimplentes (dojôs + CPF)
// POST /financial/overdue/:targetId/remind — enfileira cobrança (stub Fase 6)
//
// Guard: adminOnly() — financeiro é sensível.
//
// NOTA DE SCHEMA (23/06): transactions.status é o enum transaction_status
// (pending/confirmed/cancelled). "Em aberto/vencido" = status='pending' com
// due_date no passado. customers tem coluna `name` (não `full_name`).
// transactions.reference_id é uuid: comparar com customers.id (uuid) sem ::text.
// (karate_dojo_annuity_history.status é TEXTO e usa 'paid' — mantido.)
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

const VALID_CATEGORIES = [
  'expense_cost',
  'expense_repasse',
  'expense_certificate',
  'expense_award',
  'expense_other',
];

// GET /financial/expenses
router.get('/expenses', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;

  try {
    const [countRes, dataRes] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS total FROM transactions
         WHERE company_id = $1 AND type = 'expense' AND federation_id = $1`,
        [federationId]
      ),
      db.query(
        `SELECT id, category, amount, description, due_date,
                reference_type, reference_id, status, created_at
         FROM transactions
         WHERE company_id = $1 AND type = 'expense' AND federation_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [federationId, pageSize, offset]
      ),
    ]);

    const total = parseInt(countRes.rows[0].total, 10);
    const data  = dataRes.rows.map(r => ({
      id: r.id,
      amount: parseFloat(r.amount),
      category: r.category,
      description: r.description,
      due_date: r.due_date || null,
      reference_type: r.reference_type || null,
      reference_id: r.reference_id || null,
      status: r.status,
      created_at: r.created_at,
    }));

    res.json({ page, page_size: pageSize, total, data });
  } catch (err) {
    console.error('[karateExpenses] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar saídas' });
  }
});

// POST /financial/expenses
router.post('/expenses', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { amount, category, description, due_date, reference_type, reference_id } = req.body;

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(422).json({ error: 'amount obrigatorio e deve ser > 0', code: 'VALIDATION_ERROR' });
  }
  if (!category || !VALID_CATEGORIES.includes(category)) {
    return res.status(422).json({
      error: `category deve ser um de: ${VALID_CATEGORIES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!description || !String(description).trim()) {
    return res.status(422).json({ error: 'description obrigatorio', code: 'VALIDATION_ERROR' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO transactions
         (company_id, federation_id, type, category, amount, description,
          due_date, reference_type, reference_id, status, created_at, updated_at)
       VALUES ($1, $1, 'expense', $2, $3, $4, $5, $6, $7, 'pending', NOW(), NOW())
       RETURNING id, category, amount, description, due_date, reference_type, reference_id, status, created_at`,
      [
        federationId,
        category,
        Number(amount),
        String(description).trim(),
        due_date || null,
        reference_type || null,
        reference_id || null,
      ]
    );

    const r = rows[0];
    res.status(201).json({
      id: r.id,
      amount: parseFloat(r.amount),
      category: r.category,
      description: r.description,
      due_date: r.due_date || null,
      reference_type: r.reference_type || null,
      reference_id: r.reference_id || null,
      status: r.status,
      created_at: r.created_at,
    });
  } catch (err) {
    console.error('[karateExpenses] create error:', err.message);
    res.status(500).json({ error: 'Erro ao lançar saída', detail: err.message });
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
