// ============================================================
// AURA KARATÊ — Rotas da Federação (Track A)
// POST /karate/federation/setup
// GET  /federation/:id/dashboard
// GET  /federation/:id/belt-distribution
//
// Nota de roteamento: :id nos params é o federationId (reaproveitando
// requireCompanyAccess que lê req.params.id).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { guards } = require('../config/karateRoles');

// ── POST /karate/federation/setup ──────────────────────────
// Cria a empresa-federação com vertical=karate_federation e semeia
// os 12 critérios FPKT na mesma transação.
// Idempotente por slug: retorna 409 se slug já existe.
// Auth: requireAuth apenas (sem requireCompanyAccess — não existe empresa ainda).
router.post('/federation/setup', requireAuth, async (req, res) => {
  const { name, slug, logo_url } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(422).json({ error: 'Campo name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!slug || !String(slug).trim()) {
    return res.status(422).json({ error: 'Campo slug é obrigatório', code: 'VALIDATION_ERROR' });
  }

  const cleanSlug = String(slug).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!cleanSlug) {
    return res.status(422).json({ error: 'Slug inválido (use apenas letras, números, hífens e underscores)', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Idempotência por slug
    const existing = await client.query(
      `SELECT id, name, slug, vertical FROM companies WHERE slug = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [cleanSlug]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Federação com este slug já existe',
        code: 'CONFLICT',
        existing: { id: existing.rows[0].id, name: existing.rows[0].name, slug: existing.rows[0].slug },
      });
    }

    const newId = uuidv4();
    const ownerId = req.user.id;

    // Cria a empresa-federação
    const insertRes = await client.query(
      `INSERT INTO companies
         (id, name, slug, vertical, owner_id, karate_logo_url, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, 'karate_federation', $4, $5, true, NOW(), NOW())
       RETURNING id, name, slug, vertical`,
      [newId, String(name).trim(), cleanSlug, ownerId, logo_url || null]
    );

    const company = insertRes.rows[0];

    // Semeia os 12 critérios FPKT
    await client.query(
      `SELECT karate_seed_fpkt_requirements($1)`,
      [newId]
    );

    // Conta para confirmar os 12
    const countRes = await client.query(
      `SELECT COUNT(*) AS cnt FROM karate_belt_requirements WHERE federation_id = $1`,
      [newId]
    );
    const requirementsSeeded = parseInt(countRes.rows[0].cnt, 10);

    await client.query('COMMIT');

    res.status(201).json({
      id: company.id,
      name: company.name,
      slug: company.slug,
      vertical: company.vertical,
      requirements_seeded: requirementsSeeded,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateFederation] setup error:', err.message);
    res.status(500).json({ error: 'Erro ao criar federação', detail: err.message });
  } finally {
    client.release();
  }
});

// ── GET /federation/:id/dashboard ──────────────────────────
// overdue_dojos e kpis.overdue_rate derivam da tabela karate_dojo_annuity_history
// (migration 152) em vez do heurístico affiliation_since.
// Uma única query de agregação faz o JOIN dojô × anuidade do período corrente,
// evitando N+1 e stubs de amount/days_overdue.
router.get('/dashboard', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const currentYear = new Date().getFullYear().toString();

  try {
    // ── 1. KPIs principais (paralelo) ────────────────────────
    const [dojoRes, practRes, revenueRes] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS dojo_count FROM companies
         WHERE federation_id = $1 AND vertical = 'karate_dojo' AND is_active = true`,
        [federationId]
      ),
      db.query(
        `SELECT COUNT(*) AS practitioner_count FROM customers
         WHERE federation_id = $1`,
        [federationId]
      ),
      // revenue_ytd: soma de transações do tipo income do ano corrente da federação
      // (tabela transactions scoped by company_id = federationId)
      db.query(
        `SELECT COALESCE(SUM(amount), 0) AS revenue_ytd
         FROM transactions
         WHERE company_id = $1
           AND type = 'income'
           AND EXTRACT(YEAR FROM due_date) = EXTRACT(YEAR FROM NOW())
           AND status = 'paid'`,
        [federationId]
      ),
    ]);

    const dojoCount = parseInt(dojoRes.rows[0].dojo_count, 10);
    const practCount = parseInt(practRes.rows[0].practitioner_count, 10);
    const revenueYtd = parseFloat(revenueRes.rows[0].revenue_ytd) || 0;

    // ── 2. Status de anuidade dos dojôs (tabela karate_dojo_annuity_history) ──
    // Para cada dojô da federação, busca o registro de anuidade do período
    // corrente (ou o mais recente) em uma única query de agregação com DISTINCT ON.
    // O status e days_overdue são derivados em SQL seguindo a mesma lógica de
    // computeAnnuityStatus() de karateFinanceService.js:
    //   paid       → status = 'paid'
    //   due        → due_date >= hoje
    //   overdue    → vencida há <= 90 dias
    //   defaulting → vencida há 91–180 dias
    //   suspended  → vencida há > 180 dias OU sem registro de anuidade
    const annuityRes = await db.query(
      `WITH latest_annuity AS (
         SELECT DISTINCT ON (h.dojo_id)
           h.dojo_id,
           h.amount,
           h.due_date,
           h.status AS raw_status,
           GREATEST(0, EXTRACT(DAY FROM (NOW() - h.due_date))::int) AS days_since_due
         FROM karate_dojo_annuity_history h
         JOIN companies c ON c.id = h.dojo_id
           AND c.federation_id = $1
           AND c.vertical = 'karate_dojo'
         ORDER BY
           h.dojo_id,
           CASE WHEN h.reference_period = $2 THEN 0 ELSE 1 END,
           h.reference_period DESC
       )
       SELECT
         c.id                  AS dojo_id,
         c.name,
         la.amount,
         la.due_date,
         la.days_since_due,
         CASE
           WHEN la.dojo_id IS NULL                          THEN 'suspended'
           WHEN la.raw_status = 'paid'                      THEN 'paid'
           WHEN la.due_date IS NULL                         THEN 'suspended'
           WHEN la.due_date >= NOW()                        THEN 'due'
           WHEN la.days_since_due <= 90                     THEN 'overdue'
           WHEN la.days_since_due <= 180                    THEN 'defaulting'
           ELSE                                                  'suspended'
         END                   AS annuity_status
       FROM companies c
       LEFT JOIN latest_annuity la ON la.dojo_id = c.id
       WHERE c.federation_id = $1
         AND c.vertical = 'karate_dojo'`,
      [federationId, currentYear]
    );

    const allDojos = annuityRes.rows;
    const OVERDUE_STATUSES = ['overdue', 'defaulting', 'suspended'];

    const overdueDojosDetail = allDojos
      .filter(d => OVERDUE_STATUSES.includes(d.annuity_status))
      .map(d => ({
        dojo_id:      d.dojo_id,
        name:         d.name,
        amount:       parseFloat(d.amount) || 0,
        days_overdue: parseInt(d.days_since_due, 10) || 0,
      }));

    const overdueRate = allDojos.length > 0
      ? parseFloat((overdueDojosDetail.length / allDojos.length).toFixed(4))
      : 0;

    // Upcoming events (stub — events table a implementar na Fase 2)
    const upcomingEvents = [];

    // ── 3. Distribuição de faixas ────────────────────────────
    const beltRes = await db.query(
      `SELECT cb.belt_level, cb.belt_name, COUNT(*) AS count
       FROM karate_current_belt cb
       JOIN customers c ON c.id = cb.student_id
       WHERE c.federation_id = $1
       GROUP BY cb.belt_level, cb.belt_name
       ORDER BY cb.belt_level`,
      [federationId]
    );

    const beltDistribution = beltRes.rows.map(r => ({
      belt_level: r.belt_level,
      belt_name:  r.belt_name,
      count:      parseInt(r.count, 10),
    }));

    res.json({
      kpis: {
        dojo_count:        dojoCount,
        practitioner_count: practCount,
        revenue_ytd:       revenueYtd,
        overdue_rate:      overdueRate,
      },
      upcoming_events:  upcomingEvents,
      overdue_dojos:    overdueDojosDetail,
      belt_distribution: beltDistribution,
    });
  } catch (err) {
    console.error('[karateFederation] dashboard error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// ── GET /federation/:id/belt-distribution ──────────────────
router.get('/belt-distribution', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;

  try {
    const { rows } = await db.query(
      `SELECT cb.belt_level, cb.belt_name, COUNT(*) AS count
       FROM karate_current_belt cb
       JOIN customers c ON c.id = cb.student_id
       WHERE c.federation_id = $1
       GROUP BY cb.belt_level, cb.belt_name
       ORDER BY cb.belt_level`,
      [federationId]
    );

    res.json(rows.map(r => ({
      belt_level: r.belt_level,
      belt_name:  r.belt_name,
      count:      parseInt(r.count, 10),
    })));
  } catch (err) {
    console.error('[karateFederation] belt-distribution error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar distribuição de faixas' });
  }
});

module.exports = router;
