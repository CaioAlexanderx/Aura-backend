/**
 * creditInstallments.js
 * Crediario parcelado -- vendas a prazo, score interno, regua de cobranca, dashboard inadimplencia.
 *
 * F1 (29/05/2026): applyPayment unificado no ledger.
 * Hub F1 (05/06/2026): PUT /plan-config com period_unit/period_count.
 * F2 (05/06/2026):
 *   - PUT /customers/:cid/terms -- persiste overrides de termos por cliente
 *   - GET /customers/:cid/profile -- adiciona campo `terms: { overrides, effective }`
 * F3 (05/06/2026):
 *   - POST /installments aceita account_id para vincular parcelas a um carne
 * F3.1 (06/06/2026):
 *   - PATCH /installments/:id/due-date -- edita vencimento com cascata nas parcelas seguintes
 */

const express = require('express');
const pool = require('../config/database');
const creditLedger = require('../services/creditLedger');

const router = express.Router({ mergeParams: true });

const SP_DATE = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

const nz = (v) => (v === undefined || v === null || v === '') ? null : v;

function buildPixLink(id) {
  const short = id.replace(/-/g, '').slice(0, 12);
  return `https://pagar.getaura.com.br/parcela/${short}`;
}

function buildWhatsAppMessage(template, params = {}) {
  const { customerName = 'Cliente', storeName = 'Loja', amount = '0,00',
          dueDate = '', installmentNum = '', totalInstallments = '',
          pixLink = '', daysLate = '' } = params;
  const templates = {
    lembrete:    `Ola, ${customerName}! Lembrete: a parcela ${installmentNum}/${totalInstallments} de R$ ${amount} vence em *${dueDate}*. Pague via PIX: ${pixLink} -- *${storeName}*`,
    confirmacao: `Ola, ${customerName}! Amanha vence sua parcela ${installmentNum}/${totalInstallments} de R$ ${amount}. PIX rapido: ${pixLink} -- *${storeName}*`,
    vencimento:  `${customerName}, a parcela ${installmentNum}/${totalInstallments} de R$ ${amount} vence *hoje*. Evite juros: ${pixLink} -- *${storeName}*`,
    atraso_1:    `${customerName}, sua parcela ${installmentNum}/${totalInstallments} de R$ ${amount} esta *${daysLate} dias* em atraso. Regularize agora: ${pixLink} -- *${storeName}*`,
    atraso_2:    `${customerName}, identificamos debito de R$ ${amount} com *${daysLate} dias* de atraso. Acesse ${pixLink} ou entre em contato. -- *${storeName}*`,
    bloqueio:    `${customerName}, seu credito em *${storeName}* foi suspenso por inadimplencia. Regularize: ${pixLink} ou fale com a loja.`,
  };
  return templates[template] || templates.lembrete;
}

async function assertCrediarioEnabled(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Empresa nao encontrada.' });
    if (result.rows[0]?.enabled !== 'true') {
      return res.status(403).json({
        error: 'Crediario nao habilitado. Ative em Configuracoes > PDV > Politicas do Caixa.',
        code: 'CREDIARIO_DISABLED',
      });
    }
    next();
  } catch (err) { next(err); }
}

router.use(assertCrediarioEnabled);

// ─── GET /credit/customers/:cid/profile ──────────────────────────────────
// F2: adiciona campo `terms: { overrides, effective }` ao perfil.
router.get('/customers/:cid/profile', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const client = await pool.connect();
  try {
    const profile = await creditLedger._getOrCreateProfile(client, companyId, customerId);
    if (!profile) return res.json({ score: 500, label: 'regular', credit_limit: 0, credit_used: 0, status: 'active', terms: { overrides: {}, effective: {} } });
    const config = await creditLedger._getOrCreatePlanConfig(client, companyId);
    const installments = await client.query(
      `SELECT id, installment_number, total_installments, amount_due, covered_amount,
              due_date, status, pix_link, late_fee, late_interest, collection_stage
       FROM credit_installments
       WHERE company_id = $1 AND customer_id = $2 AND status IN ('pending','overdue')
       ORDER BY due_date ASC`,
      [companyId, customerId]
    );

    // F2: termos resolvidos
    const terms = creditLedger.resolveTerms(profile, config);

    res.json({
      ...profile,
      config,
      terms,
      open_installments: installments.rows.map(i => ({
        ...i,
        remaining: parseFloat((parseFloat(i.amount_due) - parseFloat(i.covered_amount || 0)).toFixed(2)),
      })),
    });
  } catch (err) {
    console.error('GET /credit/customers/:cid/profile', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── PUT /credit/customers/:cid/terms (F2) ────────────────────────────────
// Persiste overrides de termos por cliente. null limpa o override (volta ao padrao da loja).
router.put('/customers/:cid/terms', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const {
    interest_rate,
    max_installments,
    period_unit,
    period_count,
    due_day,
    late_fee_rate,
    late_interest_daily,
  } = req.body || {};

  // Valida period_unit se fornecido (nao null)
  if (period_unit !== undefined && period_unit !== null &&
      !['day', 'week', 'month'].includes(period_unit)) {
    return res.status(400).json({ error: 'period_unit deve ser day, week ou month' });
  }

  const client = await pool.connect();
  try {
    // Garante que perfil existe
    await creditLedger._getOrCreateProfile(client, companyId, customerId);

    // Monta SET dinamico apenas para os campos enviados no body
    // Se o campo vier como null -> NULL (limpa override)
    // Se o campo nao vier -> nao altera (COALESCE com valor atual)
    const setClauses = [];
    const params = [companyId, customerId];
    let idx = 3;

    const fieldMap = {
      interest_rate:       'term_interest_rate',
      max_installments:    'term_max_installments',
      period_unit:         'term_period_unit',
      period_count:        'term_period_count',
      due_day:             'term_due_day',
      late_fee_rate:       'term_late_fee_rate',
      late_interest_daily: 'term_late_interest_daily',
    };

    for (const [bodyField, dbCol] of Object.entries(fieldMap)) {
      if (req.body && bodyField in req.body) {
        setClauses.push(`${dbCol} = $${idx}`);
        params.push(req.body[bodyField] === null ? null : req.body[bodyField]);
        idx++;
      }
    }

    if (!setClauses.length) {
      return res.status(400).json({ error: 'Nenhum campo de termo fornecido' });
    }
    setClauses.push('updated_at = NOW()');

    let r;
    try {
      r = await client.query(
        `UPDATE customer_credit_profiles
           SET ${setClauses.join(', ')}
         WHERE company_id = $1 AND customer_id = $2
         RETURNING *`,
        params
      );
    } catch (e) {
      if (e.code === '42703') {
        // Colunas term_* ainda nao existem (deploy parcial)
        return res.status(503).json({ error: 'Colunas de termos ainda nao disponiveis. Aguarde o deploy completo.' });
      }
      throw e;
    }

    if (!r.rows.length) return res.status(404).json({ error: 'Perfil nao encontrado' });

    const profile = r.rows[0];
    const config = await creditLedger._getOrCreatePlanConfig(client, companyId);
    const terms = creditLedger.resolveTerms(profile, config);

    res.json({ ...profile, terms });
  } catch (err) {
    console.error('PUT /credit/customers/:cid/terms', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── PUT /credit/customers/:cid/limit ─────────────────────────────────────
router.put('/customers/:cid/limit', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const { credit_limit } = req.body;
  if (credit_limit === undefined || isNaN(parseFloat(credit_limit))) {
    return res.status(400).json({ error: 'credit_limit e obrigatorio e deve ser numerico.' });
  }
  const client = await pool.connect();
  try {
    await creditLedger._getOrCreateProfile(client, companyId, customerId);
    const r = await client.query(
      `UPDATE customer_credit_profiles
         SET credit_limit = $3, updated_at = NOW()
       WHERE company_id = $1 AND customer_id = $2 RETURNING *`,
      [companyId, customerId, parseFloat(credit_limit)]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PUT /credit/customers/:cid/limit', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── PATCH /credit/customers/:cid/block ──────────────────────────────────
router.patch('/customers/:cid/block', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const { action, reason } = req.body;
  if (!['block', 'unblock'].includes(action)) {
    return res.status(400).json({ error: 'action deve ser "block" ou "unblock".' });
  }
  const client = await pool.connect();
  try {
    const r = await client.query(
      `UPDATE customer_credit_profiles
         SET status = $3, blocked_reason = $4, updated_at = NOW()
       WHERE company_id = $1 AND customer_id = $2 RETURNING *`,
      [companyId, customerId,
       action === 'block' ? 'blocked' : 'active',
       action === 'block' ? (reason || 'Bloqueio manual') : null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Perfil nao encontrado.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PATCH /credit/customers/:cid/block', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── GET/PUT /credit/plan-config ───────────────────────────────────────────
router.get('/plan-config', async (req, res) => {
  const client = await pool.connect();
  try {
    const config = await creditLedger._getOrCreatePlanConfig(client, req.params.id);
    res.json(config || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

router.put('/plan-config', async (req, res) => {
  const { max_installments, min_installment_value, interest_rate,
          late_fee_rate, late_interest_daily, auto_block_days,
          require_score_min, period_unit, period_count } = req.body;
  const safeUnit = ['day', 'week', 'month'].includes(period_unit) ? period_unit : null;
  const client = await pool.connect();
  try {
    const r = await client.query(
      `INSERT INTO credit_plan_configs (company_id, max_installments, min_installment_value,
         interest_rate, late_fee_rate, late_interest_daily, auto_block_days,
         require_score_min, period_unit, period_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'month'),COALESCE($10,1))
       ON CONFLICT (company_id) DO UPDATE SET
         max_installments      = COALESCE($2, credit_plan_configs.max_installments),
         min_installment_value = COALESCE($3, credit_plan_configs.min_installment_value),
         interest_rate         = COALESCE($4, credit_plan_configs.interest_rate),
         late_fee_rate         = COALESCE($5, credit_plan_configs.late_fee_rate),
         late_interest_daily   = COALESCE($6, credit_plan_configs.late_interest_daily),
         auto_block_days       = COALESCE($7, credit_plan_configs.auto_block_days),
         require_score_min     = COALESCE($8, credit_plan_configs.require_score_min),
         period_unit           = COALESCE($9, credit_plan_configs.period_unit),
         period_count          = COALESCE($10, credit_plan_configs.period_count),
         updated_at            = NOW()
       RETURNING *`,
      [req.params.id,
       nz(max_installments), nz(min_installment_value), nz(interest_rate),
       nz(late_fee_rate), nz(late_interest_daily), nz(auto_block_days),
       nz(require_score_min), safeUnit, nz(period_count)]
    );
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── POST /credit/installments ───────────────────────────────────────────────
// F3: aceita account_id para vincular parcelas ao carne
router.post('/installments', async (req, res) => {
  const companyId = req.params.id;
  const { customer_id, sale_id, total_amount, installments, first_due_date,
          period_unit, period_count, account_id } = req.body;
  if (!customer_id || !total_amount || !installments || !first_due_date) {
    return res.status(400).json({ error: 'customer_id, total_amount, installments e first_due_date sao obrigatorios.' });
  }
  const n = parseInt(installments);
  const total = parseFloat(total_amount);
  if (isNaN(n) || n < 1 || n > 36) return res.status(400).json({ error: 'installments deve ser entre 1 e 36.' });
  if (isNaN(total) || total <= 0)   return res.status(400).json({ error: 'total_amount invalido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const profile = await creditLedger._getOrCreateProfile(client, companyId, customer_id);
    if (profile?.status === 'blocked') {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: `Cliente com credito bloqueado. Motivo: ${profile.blocked_reason || 'Bloqueio manual'}.`,
        code: 'CUSTOMER_BLOCKED',
      });
    }
    const config = await creditLedger._getOrCreatePlanConfig(client, companyId);
    if (config && n > parseInt(config.max_installments)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Maximo de ${config.max_installments} parcelas configurado.` });
    }

    const period = creditLedger.resolvePeriod(period_unit, period_count, config);
    const effectiveRate = parseFloat(config?.interest_rate) || 0;
    const totalWithInterest = effectiveRate > 0
      ? parseFloat((total * (1 + effectiveRate * n)).toFixed(2))
      : total;
    const baseAmount = Math.floor((totalWithInterest / n) * 100) / 100;
    const remainder  = Math.round((totalWithInterest - baseAmount * n) * 100) / 100;

    const createdInstallments = [];
    for (let i = 1; i <= n; i++) {
      const amount     = i === n ? baseAmount + remainder : baseAmount;
      const dueDateStr = creditLedger.dueDateForIndex(first_due_date, period.unit, period.count, i - 1);
      let row;
      try {
        const ins = await client.query(
          `INSERT INTO credit_installments
             (company_id, sale_id, customer_id, installment_number, total_installments,
              amount_due, due_date, status, pix_link, covered_amount, account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,0,$9) RETURNING *`,
          [companyId, sale_id || null, customer_id, i, n, amount, dueDateStr,
           'https://pagar.getaura.com.br/parcela/tmp', account_id || null]
        );
        row = ins.rows[0];
      } catch (e) {
        if (e.code === '42703') {
          const ins = await client.query(
            `INSERT INTO credit_installments
               (company_id, sale_id, customer_id, installment_number, total_installments,
                amount_due, due_date, status, pix_link, covered_amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,0) RETURNING *`,
            [companyId, sale_id || null, customer_id, i, n, amount, dueDateStr,
             'https://pagar.getaura.com.br/parcela/tmp']
          );
          row = ins.rows[0];
        } else throw e;
      }
      await client.query(`UPDATE credit_installments SET pix_link=$2 WHERE id=$1`,
        [row.id, buildPixLink(row.id)]);
      createdInstallments.push({ ...row, pix_link: buildPixLink(row.id) });
    }
    if (sale_id) {
      try {
        await client.query(
          `UPDATE sales SET is_installment=true, total_installments=$2, credit_plan_snapshot=$3
           WHERE id=$1 AND company_id=$4`,
          [sale_id, n, JSON.stringify({ installments: n, total_amount: total, interest_rate: effectiveRate,
                                        period_unit: period.unit, period_count: period.count }), companyId]
        );
      } catch (e) { if (e.code !== '42703' && e.code !== '42P01') throw e; }
    }
    await creditLedger._updateCreditUsed(client, companyId, customer_id);
    await client.query('COMMIT');
    res.status(201).json({ installments: createdInstallments });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /credit/installments', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── GET /credit/installments ────────────────────────────────────────────────────
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
    await pool.query(
      `UPDATE credit_installments SET status='overdue'
       WHERE company_id=$1 AND status='pending' AND due_date < ${SP_DATE}`,
      [companyId]
    );
    // Reverte status invalido: parcelas com due_date futura nunca devem ser overdue
    await pool.query(
      `UPDATE credit_installments SET status='pending'
       WHERE company_id=$1 AND status='overdue' AND due_date >= ${SP_DATE}`,
      [companyId]
    );
    const r = await pool.query(
      `SELECT ci.*,
              (ci.amount_due - ci.covered_amount) AS remaining_amount,
              COALESCE(c.name, c.phone) AS customer_name,
              c.phone AS customer_phone
       FROM credit_installments ci
       LEFT JOIN customers c ON c.id=ci.customer_id AND c.company_id=ci.company_id
       ${where}
       ORDER BY ci.due_date ASC
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...vals, parseInt(limit), offset]
    );
    const count = await pool.query(`SELECT COUNT(*) FROM credit_installments ci ${where}`, vals);
    res.json({ data: r.rows, total: parseInt(count.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('GET /credit/installments', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /credit/installments/:iid/pay ────────────────────────────────────────
router.patch('/installments/:iid/pay', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  const { amount_paid, payment_method } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT * FROM credit_installments WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [installmentId, companyId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parcela nao encontrada.' });
    }
    const ins = cur.rows[0];
    if (ins.status === 'paid')      { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Parcela ja paga.' }); }
    if (ins.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Parcela cancelada.' }); }

    let activeSessaoId = null;
    try {
      const sessRes = await pool.query(
        `SELECT id FROM caixa_sessoes WHERE company_id=$1 AND status='aberta' LIMIT 1`,
        [companyId]
      );
      activeSessaoId = sessRes?.rows?.[0]?.id || null;
    } catch (_) {}

    const uncovered = Math.max(0, parseFloat(ins.amount_due) - parseFloat(ins.covered_amount || 0));
    const payAmount = amount_paid !== undefined ? parseFloat(amount_paid) : uncovered;
    if (payAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Valor de pagamento deve ser > 0.' });
    }

    const result = await creditLedger.applyPayment(client, {
      companyId,
      customerId: ins.customer_id,
      amount:     payAmount,
      method:     payment_method || 'dinheiro',
      sessaoId:   activeSessaoId,
      createdBy:  req.user?.id || null,
      accountId:  ins.account_id || null,
    });

    await client.query('COMMIT');

    const { rows: updated } = await pool.query(
      `SELECT * FROM credit_installments WHERE id=$1`, [installmentId]
    );
    res.json({
      ...updated[0],
      remaining:   Math.max(0, parseFloat(updated[0].amount_due) - parseFloat(updated[0].covered_amount || 0)),
      new_balance: result.new_balance,
      settled:     result.settled_receivables,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /credit/installments/:iid/pay', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── PATCH /credit/installments/:iid/cancel ─────────────────────────────────────
router.patch('/installments/:iid/cancel', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE credit_installments
         SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND company_id=$2 AND status IN ('pending','overdue')
       RETURNING *`,
      [installmentId, companyId]
    );
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parcela nao encontrada ou nao pode ser cancelada.' });
    }
    await creditLedger._updateCreditUsed(client, companyId, r.rows[0].customer_id);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /credit/installments/:iid/cancel', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── PATCH /credit/installments/:iid/due-date ────────────────────────────────────
// F3.1: edita a data de vencimento de uma parcela com cascata nas parcelas seguintes
// do mesmo cliente+empresa que estejam pendentes/atrasadas.
router.patch('/installments/:iid/due-date', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  const { due_date } = req.body || {};

  // Validacao: due_date obrigatorio e deve ser uma data valida (YYYY-MM-DD ou ISO)
  if (!due_date) {
    return res.status(400).json({ error: 'due_date e obrigatorio.' });
  }
  const newDate = new Date(due_date);
  if (isNaN(newDate.getTime())) {
    return res.status(400).json({ error: 'due_date invalido. Use o formato YYYY-MM-DD.' });
  }
  // Normaliza para YYYY-MM-DD ignorando horario
  const newDateStr = due_date.slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Busca a parcela garantindo que pertence a empresa e pode ser alterada
    const cur = await client.query(
      `SELECT * FROM credit_installments
       WHERE id=$1 AND company_id=$2 AND status IN ('pending','overdue')
       FOR UPDATE`,
      [installmentId, companyId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parcela nao encontrada ou nao pode ser editada (status invalido).' });
    }
    const installment = cur.rows[0];
    const oldDateStr  = installment.due_date instanceof Date
      ? installment.due_date.toISOString().slice(0, 10)
      : String(installment.due_date).slice(0, 10);

    // Calcula delta em dias (pode ser negativo para antecipar)
    const oldMs   = new Date(oldDateStr).getTime();
    const newMs   = new Date(newDateStr).getTime();
    const deltaDays = Math.round((newMs - oldMs) / 86400000);

    // Atualiza a parcela selecionada
    await client.query(
      `UPDATE credit_installments
         SET due_date=$1, updated_at=NOW()
       WHERE id=$2`,
      [newDateStr, installmentId]
    );
    let updatedCount = 1;

    // Cascata: atualiza parcelas seguintes do mesmo cliente+empresa
    // Usa installment_number se disponivel, caso contrario due_date > old_due_date
    const hasInstallmentNumber = installment.installment_number !== null &&
                                  installment.installment_number !== undefined;
    if (deltaDays !== 0) {
      let cascadeResult;
      if (hasInstallmentNumber) {
        cascadeResult = await client.query(
          `UPDATE credit_installments
             SET due_date = due_date + ($1 * INTERVAL '1 day'), updated_at = NOW()
           WHERE company_id=$2
             AND customer_id=$3
             AND id != $4
             AND status IN ('pending','overdue')
             AND installment_number > $5`,
          [deltaDays, companyId, installment.customer_id, installmentId,
           installment.installment_number]
        );
      } else {
        cascadeResult = await client.query(
          `UPDATE credit_installments
             SET due_date = due_date + ($1 * INTERVAL '1 day'), updated_at = NOW()
           WHERE company_id=$2
             AND customer_id=$3
             AND id != $4
             AND status IN ('pending','overdue')
             AND due_date > $5`,
          [deltaDays, companyId, installment.customer_id, installmentId, oldDateStr]
        );
      }
      updatedCount += cascadeResult.rowCount || 0;
    }

    // Ajuste de status apos alterar datas:
    // pending com due_date passada -> overdue
    await client.query(
      `UPDATE credit_installments
         SET status='overdue', updated_at=NOW()
       WHERE company_id=$1
         AND customer_id=$2
         AND status='pending'
         AND due_date < ${SP_DATE}`,
      [companyId, installment.customer_id]
    );
    // overdue com due_date futura -> pending
    await client.query(
      `UPDATE credit_installments
         SET status='pending', updated_at=NOW()
       WHERE company_id=$1
         AND customer_id=$2
         AND status='overdue'
         AND due_date >= ${SP_DATE}`,
      [companyId, installment.customer_id]
    );

    await client.query('COMMIT');
    res.json({ success: true, updated_count: updatedCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /credit/installments/:iid/due-date', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── GET /credit/dashboard ────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const companyId = req.params.id;
  try {
    await pool.query(
      `UPDATE credit_installments SET status='overdue'
       WHERE company_id=$1 AND status='pending' AND due_date < ${SP_DATE}`,
      [companyId]
    );
    // Reverte status invalido: parcelas com due_date futura nunca devem ser overdue
    await pool.query(
      `UPDATE credit_installments SET status='pending'
       WHERE company_id=$1 AND status='overdue' AND due_date >= ${SP_DATE}`,
      [companyId]
    );

    const kpis = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending','overdue'))                                     AS total_open_count,
         COALESCE(SUM(amount_due - covered_amount) FILTER (WHERE status IN ('pending','overdue')), 0) AS total_open_amount,
         COUNT(*) FILTER (WHERE status='overdue')                                                     AS overdue_count,
         COALESCE(SUM(amount_due - covered_amount) FILTER (WHERE status='overdue'), 0)               AS overdue_amount,
         COUNT(*) FILTER (WHERE status='overdue'
           AND due_date < ${SP_DATE} - 30)                                                           AS critical_count,
         COALESCE(SUM(amount_due - covered_amount) FILTER (
           WHERE status='overdue' AND due_date < ${SP_DATE} - 30), 0)                                AS critical_amount,
         COUNT(DISTINCT customer_id) FILTER (WHERE status='overdue')                                 AS defaulting_customers,
         COUNT(*) FILTER (WHERE status='paid'
           AND DATE_TRUNC('month', paid_at AT TIME ZONE 'America/Sao_Paulo')
             = DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Sao_Paulo'))                          AS paid_this_month_count,
         COALESCE(SUM(covered_amount) FILTER (WHERE status='paid'
           AND DATE_TRUNC('month', paid_at AT TIME ZONE 'America/Sao_Paulo')
             = DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Sao_Paulo')), 0)                      AS paid_this_month_amount
       FROM credit_installments WHERE company_id=$1`,
      [companyId]
    );

    const top = await pool.query(
      `SELECT
         ci.customer_id,
         COALESCE(c.name, c.phone) AS customer_name, c.phone,
         COUNT(*) AS overdue_count,
         SUM(ci.amount_due - ci.covered_amount) AS total_overdue,
         MIN(ci.due_date) AS oldest_due_date,
         MAX(ci.collection_stage) AS collection_stage,
         ccp.credit_score, ccp.status AS credit_status
       FROM credit_installments ci
       LEFT JOIN customers c ON c.id=ci.customer_id AND c.company_id=ci.company_id
       LEFT JOIN customer_credit_profiles ccp
         ON ccp.customer_id=ci.customer_id AND ccp.company_id=ci.company_id
       WHERE ci.company_id=$1 AND ci.status='overdue'
       GROUP BY ci.customer_id, c.name, c.phone, ccp.credit_score, ccp.status
       ORDER BY total_overdue DESC LIMIT 20`,
      [companyId]
    );

    res.json({ kpis: kpis.rows[0], top_defaulters: top.rows });
  } catch (err) {
    console.error('GET /credit/dashboard', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /credit/dashboard/aging ──────────────────────────────────────────────────
router.get('/dashboard/aging', async (req, res) => {
  const companyId = req.params.id;
  try {
    const r = await pool.query(
      `SELECT
         CASE
           WHEN due_date >= ${SP_DATE}      THEN 'a_vencer'
           WHEN due_date >= ${SP_DATE} - 30 THEN '1_30_dias'
           WHEN due_date >= ${SP_DATE} - 60 THEN '31_60_dias'
           WHEN due_date >= ${SP_DATE} - 90 THEN '61_90_dias'
           ELSE                                  'acima_90'
         END AS faixa,
         COUNT(*) AS count,
         COALESCE(SUM(amount_due - covered_amount), 0) AS amount
       FROM credit_installments
       WHERE company_id=$1 AND status IN ('pending','overdue')
       GROUP BY faixa ORDER BY faixa`,
      [companyId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('GET /credit/dashboard/aging', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── collection/rules + collection/trigger (inalterados) ───────────────────────────
router.get('/collection/rules', async (req, res) => {
  const client = await pool.connect();
  try {
    let r;
    try {
      r = await client.query(`SELECT * FROM credit_collection_rules WHERE company_id=$1`, [req.params.id]);
    } catch (e) {
      if (e.code === '42P01') return res.json({ rules: [], enabled: false });
      throw e;
    }
    if (!r.rows.length) {
      const ins = await client.query(
        `INSERT INTO credit_collection_rules (company_id) VALUES ($1)
         ON CONFLICT (company_id) DO UPDATE SET updated_at=NOW() RETURNING *`,
        [req.params.id]
      );
      return res.json(ins.rows[0]);
    }
    res.json(r.rows[0]);
  } catch (err) {
    console.error('GET /credit/collection/rules', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

router.put('/collection/rules', async (req, res) => {
  const { enabled, whatsapp_connected, rules, pix_key } = req.body;
  const client = await pool.connect();
  try {
    const r = await client.query(
      `INSERT INTO credit_collection_rules (company_id, enabled, whatsapp_connected, rules, pix_key)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (company_id) DO UPDATE SET
         enabled=$2, whatsapp_connected=$3, rules=$4,
         pix_key=COALESCE($5, credit_collection_rules.pix_key), updated_at=NOW()
       RETURNING *`,
      [req.params.id,
       enabled !== undefined ? enabled : true,
       whatsapp_connected !== undefined ? whatsapp_connected : false,
       rules ? JSON.stringify(rules) : null,
       pix_key !== undefined ? String(pix_key).trim() : null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '42P01') return res.status(503).json({ error: 'Tabela de regua ainda nao disponivel.' });
    console.error('PUT /credit/collection/rules', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

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
       LEFT JOIN customers c ON c.id=ci.customer_id AND c.company_id=ci.company_id
       LEFT JOIN companies co ON co.id=ci.company_id
       WHERE ci.id=$1 AND ci.company_id=$2`,
      [installmentId, companyId]
    );
    if (!ins.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Parcela nao encontrada.' }); }
    const row = ins.rows[0];
    const daysLate = Math.max(0, Math.floor((Date.now() - new Date(row.due_date)) / 86400000));
    const message = buildWhatsAppMessage(template, {
      customerName:      row.customer_name,
      storeName:         row.store_name || 'Loja',
      amount:            parseFloat(row.amount_due).toFixed(2).replace('.', ','),
      dueDate:           new Date(row.due_date).toLocaleDateString('pt-BR'),
      installmentNum:    row.installment_number,
      totalInstallments: row.total_installments,
      pixLink:           row.pix_link || buildPixLink(row.id),
      daysLate:          String(daysLate),
    });
    try {
      await client.query(
        `INSERT INTO credit_collection_events
           (installment_id, channel, template, days_relative, status, message_preview)
         VALUES ($1,$2,$3,$4,'sent',$5)`,
        [installmentId, channel, template, daysLate, message.slice(0, 300)]
      );
      await client.query(
        `UPDATE credit_installments SET collection_stage=collection_stage+1, updated_at=NOW() WHERE id=$1`,
        [installmentId]
      );
    } catch (e) { if (e.code !== '42P01' && e.code !== '42703') throw e; }
    await client.query('COMMIT');
    res.json({ success: true, installment_id: installmentId, channel, template, message, phone: row.phone, days_late: daysLate });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /credit/collection/trigger/:iid', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
