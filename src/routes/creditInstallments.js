/**
 * creditInstallments.js
 * Crediário parcelado — vendas a prazo, score interno, régua de cobrança, dashboard inadimplência.
 * Migrations: 115 (customer_credit_profiles), 116 (credit_plan_configs + credit_installments),
 *             117 (credit_collection_rules + credit_collection_events), 118 (sales columns).
 *
 * Montado em private.js:
 *   router.use('/credit', requirePlan('negocio', 'expansao'), require('./creditInstallments'));
 *
 * Rotas:
 *   GET    /customers/:cid/profile
 *   PUT    /customers/:cid/limit
 *   PATCH  /customers/:cid/block
 *   POST   /installments
 *   GET    /installments
 *   PATCH  /installments/:id/pay
 *   PATCH  /installments/:id/cancel
 *   GET    /dashboard
 *   GET    /dashboard/aging
 *   GET    /collection/rules
 *   PUT    /collection/rules
 *   POST   /collection/trigger/:installmentId
 */

const express = require('express');
const pool = require('../config/database');

const router = express.Router({ mergeParams: true });

// ─────────────────────────────────────────────
// Helpers de score
// ─────────────────────────────────────────────

function calcScore({ total_paid_count, total_paid_on_time, avg_days_late, total_purchases, relationship_months }) {
  const n = parseInt(total_paid_count) || 0;
  if (n === 0) return 500; // score neutro para clientes novos
  const onTimePts = (parseInt(total_paid_on_time) || 0) / n * 400;
  const latePts   = Math.max(0, 1 - (parseFloat(avg_days_late) || 0) / 90) * 300;
  const volPts    = Math.min(1, (parseFloat(total_purchases)  || 0) / 5000) * 150;
  const senPts    = Math.min(1, (parseInt(relationship_months) || 0) / 24) * 150;
  return Math.min(1000, Math.max(0, Math.round(onTimePts + latePts + volPts + senPts)));
}

function scoreLabel(score) {
  if (score >= 800) return 'premium';
  if (score >= 650) return 'bom';
  if (score >= 450) return 'regular';
  if (score >= 300) return 'restrito';
  return 'bloqueado';
}

// ─────────────────────────────────────────────
// Helpers de banco (defensivos contra 42P01/42703)
// ─────────────────────────────────────────────

async function getOrCreateProfile(client, companyId, customerId) {
  try {
    const res = await client.query(
      `INSERT INTO customer_credit_profiles
         (company_id, customer_id, credit_limit, credit_score, status)
       VALUES ($1, $2, 0, 500, 'active')
       ON CONFLICT (company_id, customer_id) DO UPDATE
         SET updated_at = NOW()
       RETURNING *`,
      [companyId, customerId]
    );
    return res.rows[0];
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return null;
    throw err;
  }
}

async function getOrCreatePlanConfig(client, companyId) {
  try {
    const res = await client.query(
      `INSERT INTO credit_plan_configs (company_id)
       VALUES ($1)
       ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [companyId]
    );
    return res.rows[0];
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return null;
    throw err;
  }
}

async function updateCreditUsed(client, companyId, customerId) {
  try {
    await client.query(
      `UPDATE customer_credit_profiles
         SET credit_used = COALESCE((
           SELECT SUM(amount_due - amount_paid)
           FROM credit_installments
           WHERE company_id = $1 AND customer_id = $2
             AND status IN ('pending','overdue')
         ), 0),
         updated_at = NOW()
       WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return;
    throw err;
  }
}

async function recalculateScore(client, companyId, customerId) {
  try {
    const res = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'paid')                          AS total_paid_count,
         COUNT(*) FILTER (WHERE status = 'paid' AND
           (paid_at::date <= due_date OR paid_at IS NULL))                AS total_paid_on_time,
         COALESCE(AVG(
           CASE WHEN status = 'paid' AND paid_at::date > due_date
             THEN (paid_at::date - due_date) END
         ), 0)                                                            AS avg_days_late,
         COALESCE(SUM(amount_due) FILTER (WHERE status = 'paid'), 0)     AS total_purchases
       FROM credit_installments
       WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
    const row = res.rows[0];

    // tempo de relacionamento em meses
    const relRes = await client.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - created_at))/2592000 AS months
       FROM customer_credit_profiles
       WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
    const months = parseFloat(relRes.rows[0]?.months) || 0;

    const newScore = calcScore({
      total_paid_count:   row.total_paid_count,
      total_paid_on_time: row.total_paid_on_time,
      avg_days_late:      row.avg_days_late,
      total_purchases:    row.total_purchases,
      relationship_months: months,
    });

    await client.query(
      `UPDATE customer_credit_profiles
         SET credit_score        = $3,
             total_paid_count    = $4,
             total_paid_on_time  = $5,
             avg_days_late       = $6,
             total_purchases     = $7,
             relationship_months = $8,
             score_updated_at    = NOW(),
             updated_at          = NOW()
       WHERE company_id = $1 AND customer_id = $2`,
      [
        companyId, customerId, newScore,
        parseInt(row.total_paid_count),
        parseInt(row.total_paid_on_time),
        parseFloat(row.avg_days_late),
        parseFloat(row.total_purchases),
        Math.round(months),
      ]
    );
    return newScore;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return null;
    throw err;
  }
}

// ─────────────────────────────────────────────
// Helpers de mensagem / link
// ─────────────────────────────────────────────

function buildPixLink(installmentId) {
  const short = installmentId.replace(/-/g, '').slice(0, 12);
  return `https://pagar.getaura.com.br/parcela/${short}`;
}

function buildWhatsAppMessage(template, params = {}) {
  const { customerName = 'Cliente', storeName = 'Loja', amount = '0,00',
          dueDate = '', installmentNum = '', totalInstallments = '',
          pixLink = '', daysLate = '' } = params;
  const templates = {
    lembrete:     `Olá, ${customerName}! 👋 Lembrete amigável: a parcela ${installmentNum}/${totalInstallments} de R$ ${amount} vence em *${dueDate}*. Pague via PIX: ${pixLink} — *${storeName}*`,
    confirmacao:  `Olá, ${customerName}! Amanhã vence sua parcela ${installmentNum}/${totalInstallments} de R$ ${amount}. PIX rápido: ${pixLink} — *${storeName}*`,
    vencimento:   `${customerName}, a parcela ${installmentNum}/${totalInstallments} de R$ ${amount} vence *hoje*. Evite juros: ${pixLink} — *${storeName}*`,
    atraso_1:     `${customerName}, sua parcela ${installmentNum}/${totalInstallments} de R$ ${amount} está *${daysLate} dias* em atraso. Regularize agora: ${pixLink} — *${storeName}*`,
    atraso_2:     `${customerName}, identificamos débito de R$ ${amount} com *${daysLate} dias* de atraso. Acesse ${pixLink} ou entre em contato. — *${storeName}*`,
    bloqueio:     `${customerName}, seu crédito em *${storeName}* foi suspenso por inadimplência. Regularize: ${pixLink} ou fale com a loja.`,
  };
  return templates[template] || templates.lembrete;
}

// ─────────────────────────────────────────────
// Middleware: assertCrediarioEnabled
// FIX 26/05/2026: usa pdv_settings->>'crediario_enabled' via SQL (retorna
// sempre text) em vez de ler o JSONB inteiro e comparar com ===false.
// Alinha comportamento com credit.js e elimina o bug em que módulo ficava
// aberto quando crediario_enabled era undefined/null no JSONB.
// ─────────────────────────────────────────────

async function assertCrediarioEnabled(req, res, next) {
  try {
    const companyId = req.params.id;
    const result = await pool.query(
      `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
      [companyId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Empresa não encontrada.' });
    }
    const enabled = result.rows[0]?.enabled;
    if (enabled !== 'true') {
      return res.status(403).json({
        error: 'Crediário não habilitado para esta empresa. Ative em Configurações > PDV > Políticas do Caixa.',
        code: 'CREDIARIO_DISABLED',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.use(assertCrediarioEnabled);

// ─────────────────────────────────────────────
// GET /credit/customers/:cid/profile
// ─────────────────────────────────────────────

router.get('/customers/:cid/profile', async (req, res) => {
  const companyId   = req.params.id;
  const customerId  = req.params.cid;
  const client = await pool.connect();
  try {
    const profile = await getOrCreateProfile(client, companyId, customerId);
    if (!profile) return res.json({ score: 500, label: 'regular', credit_limit: 0, credit_used: 0, status: 'active' });

    const config = await getOrCreatePlanConfig(client, companyId);

    // parcelas abertas
    const installments = await client.query(
      `SELECT id, installment_number, total_installments, amount_due, amount_paid,
              due_date, status, pix_link, late_fee, late_interest, collection_stage
       FROM credit_installments
       WHERE company_id = $1 AND customer_id = $2
         AND status IN ('pending','overdue')
       ORDER BY due_date ASC`,
      [companyId, customerId]
    );

    res.json({
      ...profile,
      label: scoreLabel(parseInt(profile.credit_score)),
      config,
      open_installments: installments.rows,
    });
  } catch (err) {
    console.error('GET /credit/customers/:cid/profile', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// PUT /credit/customers/:cid/limit
// ─────────────────────────────────────────────

router.put('/customers/:cid/limit', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const { credit_limit } = req.body;
  if (credit_limit === undefined || isNaN(parseFloat(credit_limit))) {
    return res.status(400).json({ error: 'credit_limit é obrigatório e deve ser numérico.' });
  }
  const client = await pool.connect();
  try {
    await getOrCreateProfile(client, companyId, customerId);
    const r = await client.query(
      `UPDATE customer_credit_profiles
         SET credit_limit = $3, updated_at = NOW()
       WHERE company_id = $1 AND customer_id = $2
       RETURNING *`,
      [companyId, customerId, parseFloat(credit_limit)]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PUT /credit/customers/:cid/limit', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// PATCH /credit/customers/:cid/block
// ─────────────────────────────────────────────

router.patch('/customers/:cid/block', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const { action, reason } = req.body; // action: 'block' | 'unblock'
  if (!['block', 'unblock'].includes(action)) {
    return res.status(400).json({ error: 'action deve ser "block" ou "unblock".' });
  }
  const client = await pool.connect();
  try {
    const r = await client.query(
      `UPDATE customer_credit_profiles
         SET status         = $3,
             blocked_reason = $4,
             updated_at     = NOW()
       WHERE company_id = $1 AND customer_id = $2
       RETURNING *`,
      [companyId, customerId,
       action === 'block' ? 'blocked' : 'active',
       action === 'block' ? (reason || 'Bloqueio manual') : null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Perfil não encontrado.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PATCH /credit/customers/:cid/block', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// POST /credit/installments — criar venda parcelada
// Body: { customer_id, sale_id, total_amount, installments, first_due_date }
//
// FIX 26/05/2026: removidas validações de SCORE_TOO_LOW e LIMIT_EXCEEDED.
// Score é informativo e não bloqueia operações. Limite de crédito fora do
// escopo desta fase — será reintroduzido de forma opcional (fácil edição
// manual) em fase posterior. Único bloqueio que permanece: CUSTOMER_BLOCKED
// (bloqueio manual explícito pelo lojista).
// ─────────────────────────────────────────────

router.post('/installments', async (req, res) => {
  const companyId = req.params.id;
  const { customer_id, sale_id, total_amount, installments, first_due_date } = req.body;

  if (!customer_id || !total_amount || !installments || !first_due_date) {
    return res.status(400).json({ error: 'customer_id, total_amount, installments e first_due_date são obrigatórios.' });
  }

  const n = parseInt(installments);
  const total = parseFloat(total_amount);
  if (isNaN(n) || n < 1 || n > 36) return res.status(400).json({ error: 'installments deve ser entre 1 e 36.' });
  if (isNaN(total) || total <= 0)   return res.status(400).json({ error: 'total_amount inválido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const config = await getOrCreatePlanConfig(client, companyId);
    const profile = await getOrCreateProfile(client, companyId, customer_id);

    // Único bloqueio mantido: cliente com bloqueio manual explícito
    if (profile?.status === 'blocked') {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: `Cliente com crédito bloqueado. Motivo: ${profile.blocked_reason || 'Bloqueio manual'}.`,
        code: 'CUSTOMER_BLOCKED',
      });
    }

    if (config && n > parseInt(config.max_installments)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Máximo de ${config.max_installments} parcelas configurado.` });
    }

    // gerar parcelas com juros simples 0% (taxa configurável; MVP sem juros embutidos)
    const baseAmount = Math.floor((total / n) * 100) / 100;
    const remainder  = Math.round((total - baseAmount * n) * 100) / 100;

    const createdInstallments = [];
    for (let i = 1; i <= n; i++) {
      const amount = i === n ? baseAmount + remainder : baseAmount;
      const dueDate = new Date(first_due_date);
      dueDate.setMonth(dueDate.getMonth() + (i - 1));
      const dueDateStr = dueDate.toISOString().split('T')[0];

      const ins = await client.query(
        `INSERT INTO credit_installments
           (company_id, sale_id, customer_id, installment_number, total_installments,
            amount_due, due_date, status, pix_link)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
         RETURNING *`,
        [companyId, sale_id || null, customer_id, i, n, amount, dueDateStr,
         buildPixLink('tmp-' + companyId + '-' + i)]
      );
      const row = ins.rows[0];
      // atualiza pix_link com id real
      await client.query(
        `UPDATE credit_installments SET pix_link = $2 WHERE id = $1`,
        [row.id, buildPixLink(row.id)]
      );
      createdInstallments.push({ ...row, pix_link: buildPixLink(row.id) });
    }

    // marcar venda como parcelada
    if (sale_id) {
      try {
        await client.query(
          `UPDATE sales
             SET is_installment = true, total_installments = $2,
                 credit_plan_snapshot = $3
           WHERE id = $1 AND company_id = $4`,
          [sale_id, n, JSON.stringify({ installments: n, total_amount: total }), companyId]
        );
      } catch (e) {
        if (e.code !== '42703' && e.code !== '42P01') throw e;
      }
    }

    await updateCreditUsed(client, companyId, customer_id);
    await client.query('COMMIT');

    res.status(201).json({ installments: createdInstallments });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /credit/installments', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// GET /credit/installments
// Query: customer_id?, status?, page, limit
// ─────────────────────────────────────────────

router.get('/installments', async (req, res) => {
  const companyId = req.params.id;
  const { customer_id, status, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = 'WHERE ci.company_id = $1';
  const vals = [companyId];
  let idx = 2;

  if (customer_id) { where += ` AND ci.customer_id = $${idx++}`; vals.push(customer_id); }
  if (status)      { where += ` AND ci.status = $${idx++}`;       vals.push(status); }

  try {
    // marcar overdue automaticamente
    await pool.query(
      `UPDATE credit_installments
         SET status = 'overdue'
       WHERE company_id = $1 AND status = 'pending' AND due_date < CURRENT_DATE`,
      [companyId]
    );

    const r = await pool.query(
      `SELECT ci.*,
              COALESCE(c.name, c.phone) AS customer_name,
              c.phone AS customer_phone
       FROM credit_installments ci
       LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ci.company_id
       ${where}
       ORDER BY ci.due_date ASC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...vals, parseInt(limit), offset]
    );
    const count = await pool.query(
      `SELECT COUNT(*) FROM credit_installments ci ${where}`,
      vals
    );
    res.json({ data: r.rows, total: parseInt(count.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('GET /credit/installments', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// PATCH /credit/installments/:id/pay
// Body: { amount_paid?, paid_at? } — pagamento total ou parcial
// ─────────────────────────────────────────────

router.patch('/installments/:id/pay', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.id2 || req.params.id;
  // mergeParams faz :id ser o da empresa — precisamos pegar pelo path
  const iId = req.path.split('/')[2]; // /installments/:id/pay
  // Na verdade o express mergeParams=true usa req.params corretamente
  // mas o :id da empresa sobrescreve o :id da parcela.
  // Usamos req.params['id'] = empresa, e precisamos do id da rota filha.
  // Como mergeParams true o Express combina — para evitar conflito,
  // o :id da parcela ficou sem conflito de nome se a rota usa :iid.
  // Reescrevemos a rota abaixo usando :iid.
  res.status(501).json({ error: 'use /installments/:iid/pay' });
});

// rota corrigida sem conflito de params
router.patch('/installments/:iid/pay', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  const { amount_paid, paid_at } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT * FROM credit_installments WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [installmentId, companyId]
    );
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Parcela não encontrada.' }); }
    const ins = cur.rows[0];
    if (ins.status === 'paid')      { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Parcela já paga.' }); }
    if (ins.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Parcela cancelada.' }); }

    const paidAt   = paid_at ? new Date(paid_at) : new Date();
    const dueDate  = new Date(ins.due_date);
    const daysLate = Math.max(0, Math.floor((paidAt - dueDate) / 86400000));

    // calcula juros e multa
    const config = await getOrCreatePlanConfig(client, companyId);
    const lateFeeRate   = parseFloat(config?.late_fee_rate   || 2)    / 100;
    const lateDailyRate = parseFloat(config?.late_interest_daily || 0.0333) / 100;
    const base = parseFloat(ins.amount_due);
    const lateFee      = daysLate > 0 ? Math.round(base * lateFeeRate * 100) / 100 : 0;
    const lateInterest = daysLate > 0 ? Math.round(base * lateDailyRate * daysLate * 100) / 100 : 0;
    const totalDue     = base + lateFee + lateInterest;
    const paid         = amount_paid !== undefined ? parseFloat(amount_paid) : totalDue;
    const newStatus    = paid >= totalDue ? 'paid' : 'pending';

    const r = await client.query(
      `UPDATE credit_installments
         SET amount_paid   = $3,
             paid_at       = $4,
             late_fee      = $5,
             late_interest = $6,
             status        = $7,
             updated_at    = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [installmentId, companyId, paid, paidAt.toISOString(), lateFee, lateInterest, newStatus]
    );

    if (newStatus === 'paid') {
      await recalculateScore(client, companyId, ins.customer_id);
    }
    await updateCreditUsed(client, companyId, ins.customer_id);
    await client.query('COMMIT');

    res.json({ ...r.rows[0], days_late: daysLate, total_due: totalDue });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /credit/installments/:iid/pay', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// PATCH /credit/installments/:iid/cancel
// ─────────────────────────────────────────────

router.patch('/installments/:iid/cancel', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE credit_installments
         SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status IN ('pending','overdue')
       RETURNING *`,
      [installmentId, companyId]
    );
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Parcela não encontrada ou não pode ser cancelada.' }); }
    await updateCreditUsed(client, companyId, r.rows[0].customer_id);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /credit/installments/:iid/cancel', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// GET /credit/dashboard
// ─────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  const companyId = req.params.id;
  try {
    // marcar overdue
    await pool.query(
      `UPDATE credit_installments SET status = 'overdue'
       WHERE company_id = $1 AND status = 'pending' AND due_date < CURRENT_DATE`,
      [companyId]
    );

    const kpis = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending','overdue'))                       AS total_open_count,
         COALESCE(SUM(amount_due - amount_paid) FILTER (WHERE status IN ('pending','overdue')), 0) AS total_open_amount,
         COUNT(*) FILTER (WHERE status = 'overdue')                                   AS overdue_count,
         COALESCE(SUM(amount_due - amount_paid) FILTER (WHERE status = 'overdue'), 0) AS overdue_amount,
         COUNT(*) FILTER (WHERE status = 'overdue' AND due_date < CURRENT_DATE - 30)  AS critical_count,
         COALESCE(SUM(amount_due - amount_paid) FILTER (
           WHERE status = 'overdue' AND due_date < CURRENT_DATE - 30), 0)             AS critical_amount,
         COUNT(DISTINCT customer_id) FILTER (WHERE status = 'overdue')                AS defaulting_customers,
         COUNT(*) FILTER (WHERE status = 'paid' AND
           DATE_TRUNC('month', paid_at) = DATE_TRUNC('month', NOW()))                 AS paid_this_month_count,
         COALESCE(SUM(amount_paid) FILTER (WHERE status = 'paid' AND
           DATE_TRUNC('month', paid_at) = DATE_TRUNC('month', NOW())), 0)             AS paid_this_month_amount
       FROM credit_installments
       WHERE company_id = $1`,
      [companyId]
    );

    // top inadimplentes
    const top = await pool.query(
      `SELECT
         ci.customer_id,
         COALESCE(c.name, c.phone) AS customer_name,
         c.phone,
         COUNT(*) AS overdue_count,
         SUM(ci.amount_due - ci.amount_paid) AS total_overdue,
         MIN(ci.due_date) AS oldest_due_date,
         MAX(ci.collection_stage) AS collection_stage,
         ccp.credit_score,
         ccp.status AS credit_status
       FROM credit_installments ci
       LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ci.company_id
       LEFT JOIN customer_credit_profiles ccp ON ccp.customer_id = ci.customer_id AND ccp.company_id = ci.company_id
       WHERE ci.company_id = $1 AND ci.status = 'overdue'
       GROUP BY ci.customer_id, c.name, c.phone, ccp.credit_score, ccp.status
       ORDER BY total_overdue DESC
       LIMIT 20`,
      [companyId]
    );

    res.json({ kpis: kpis.rows[0], top_defaulters: top.rows });
  } catch (err) {
    console.error('GET /credit/dashboard', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /credit/dashboard/aging
// Distribuição por faixas de atraso
// ─────────────────────────────────────────────

router.get('/dashboard/aging', async (req, res) => {
  const companyId = req.params.id;
  try {
    const r = await pool.query(
      `SELECT
         CASE
           WHEN due_date >= CURRENT_DATE                         THEN 'a_vencer'
           WHEN due_date >= CURRENT_DATE - 30                    THEN '1_30_dias'
           WHEN due_date >= CURRENT_DATE - 60                    THEN '31_60_dias'
           WHEN due_date >= CURRENT_DATE - 90                    THEN '61_90_dias'
           ELSE                                                       'acima_90'
         END AS faixa,
         COUNT(*) AS count,
         COALESCE(SUM(amount_due - amount_paid), 0) AS amount
       FROM credit_installments
       WHERE company_id = $1 AND status IN ('pending','overdue')
       GROUP BY faixa
       ORDER BY faixa`,
      [companyId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('GET /credit/dashboard/aging', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /credit/collection/rules
// ─────────────────────────────────────────────

router.get('/collection/rules', async (req, res) => {
  const companyId = req.params.id;
  const client = await pool.connect();
  try {
    let r;
    try {
      r = await client.query(
        `SELECT * FROM credit_collection_rules WHERE company_id = $1`,
        [companyId]
      );
    } catch (e) {
      if (e.code === '42P01') return res.json({ rules: [], enabled: false });
      throw e;
    }
    if (!r.rows.length) {
      // cria default
      const ins = await client.query(
        `INSERT INTO credit_collection_rules (company_id)
         VALUES ($1) ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [companyId]
      );
      return res.json(ins.rows[0]);
    }
    res.json(r.rows[0]);
  } catch (err) {
    console.error('GET /credit/collection/rules', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// PUT /credit/collection/rules
// Body: { enabled, whatsapp_connected, rules }
// ─────────────────────────────────────────────

router.put('/collection/rules', async (req, res) => {
  const companyId = req.params.id;
  const { enabled, whatsapp_connected, rules } = req.body;
  const client = await pool.connect();
  try {
    const r = await client.query(
      `INSERT INTO credit_collection_rules (company_id, enabled, whatsapp_connected, rules)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id) DO UPDATE
         SET enabled             = EXCLUDED.enabled,
             whatsapp_connected  = EXCLUDED.whatsapp_connected,
             rules               = EXCLUDED.rules,
             updated_at          = NOW()
       RETURNING *`,
      [companyId,
       enabled !== undefined ? enabled : true,
       whatsapp_connected !== undefined ? whatsapp_connected : false,
       rules ? JSON.stringify(rules) : null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '42P01') return res.status(503).json({ error: 'Tabela de régua ainda não disponível.' });
    console.error('PUT /credit/collection/rules', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// POST /credit/collection/trigger/:iid
// Dispara cobrança manual para uma parcela
// ─────────────────────────────────────────────

router.post('/collection/trigger/:iid', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  const { template = 'atraso_1', channel = 'whatsapp' } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ins = await client.query(
      `SELECT ci.*, COALESCE(c.name, c.phone) AS customer_name, c.phone,
              COALESCE(co.trade_name, co.legal_name) AS store_name
       FROM credit_installments ci
       LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ci.company_id
       LEFT JOIN companies co ON co.id = ci.company_id
       WHERE ci.id = $1 AND ci.company_id = $2`,
      [installmentId, companyId]
    );
    if (!ins.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Parcela não encontrada.' }); }

    const row = ins.rows[0];
    const daysLate = Math.max(0, Math.floor((Date.now() - new Date(row.due_date)) / 86400000));
    const message  = buildWhatsAppMessage(template, {
      customerName:      row.customer_name,
      storeName:         row.store_name || 'Loja',
      amount:            parseFloat(row.amount_due).toFixed(2).replace('.', ','),
      dueDate:           new Date(row.due_date).toLocaleDateString('pt-BR'),
      installmentNum:    row.installment_number,
      totalInstallments: row.total_installments,
      pixLink:           row.pix_link || buildPixLink(row.id),
      daysLate:          String(daysLate),
    });

    // registrar evento de cobrança
    try {
      await client.query(
        `INSERT INTO credit_collection_events
           (installment_id, channel, template, days_relative, status, message_preview)
         VALUES ($1, $2, $3, $4, 'sent', $5)`,
        [installmentId, channel, template, daysLate, message.slice(0, 300)]
      );
      // incrementar collection_stage
      await client.query(
        `UPDATE credit_installments
           SET collection_stage = collection_stage + 1, updated_at = NOW()
         WHERE id = $1`,
        [installmentId]
      );
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      installment_id: installmentId,
      channel,
      template,
      message,
      phone: row.phone,
      days_late: daysLate,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /credit/collection/trigger/:iid', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
