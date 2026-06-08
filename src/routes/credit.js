// ============================================================
// AURA. -- Crediario (fiado) por cliente
// GET    /companies/:id/credit/balances
// GET    /companies/:id/credit/customer/:cid
// POST   /companies/:id/credit/customer/:cid/payment
// POST   /companies/:id/credit/customer/:cid/accounts   (F3)
// DELETE /companies/:id/credit/transaction/:txid
// POST   /companies/:id/credit/manual-entry
//
// F2 (05/06/2026): PUT /customers/:cid/terms -- termos por cliente
// F3 (05/06/2026): POST /customer/:cid/accounts -- multiplos carnes
//                  GET  /customer/:cid agora retorna campo `accounts`
//                  POST /customer/:cid/payment aceita account_id / allocations
// Hub F1.4 (07/06/2026): open_installments inclui account_id
// F2 PR1 (08/06/2026): GET /customer/:cid enriquece open_installments com
//                  encargos lazy (mora/multa) + total_due. config/profile 1x.
// F2 PR2 (08/06/2026): POST /customer/:cid/payment carrega config/profile e
//                  os passa ao applyPayment para MATERIALIZAR encargos
//                  (encargos primeiro -> principal). Resposta expoe charges_paid.
//                  Defensivo 42703/42P01 -> config/profile undefined => OFF.
// ============================================================
const router      = require('express').Router({ mergeParams: true });
const db          = require('../config/database');
const creditLedger = require('../services/creditLedger');

async function assertCrediarioEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) {
    const err = new Error('Empresa nao encontrada');
    err.status = 404;
    throw err;
  }
  if (rows[0].enabled !== 'true') {
    const err = new Error('Modulo de crediario nao esta habilitado. Ative em Configuracoes > PDV > Politicas do Caixa.');
    err.status = 403;
    err.code = 'CREDIARIO_DISABLED';
    throw err;
  }
}

function normalizeBackdate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const todaySp = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  if (s >= todaySp) return null;
  return s;
}

// F2 PR2: carrega config (credit_plan_configs) + profile (customer_credit_profiles)
// do cliente de forma defensiva. Usados pelo applyPayment p/ MATERIALIZAR encargos.
// Em deploy parcial (42703/42P01) -> retorna undefined, e applyPayment cai no
// comportamento OFF (charges_paid: 0, zero queries novas).
async function loadLateChargesContext(client, companyId, customerId) {
  let config = undefined;
  let profile = undefined;
  try {
    const cfg = await client.query(`SELECT * FROM credit_plan_configs WHERE company_id = $1`, [companyId]);
    config = cfg.rows[0] || undefined;
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') throw e;
    config = undefined;
  }
  try {
    const prof = await client.query(
      `SELECT * FROM customer_credit_profiles WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
    profile = prof.rows[0] || undefined;
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') throw e;
    profile = undefined;
  }
  return { config, profile };
}

// GET /balances
router.get('/balances', async (req, res) => {
  const onlyOpen = req.query.only_open !== 'false';
  const q = req.query.q ? String(req.query.q).trim() : '';
  try {
    await assertCrediarioEnabled(req.params.id);
    const conditions = ['cb.company_id = $1'];
    const params = [req.params.id];
    let i = 2;
    if (onlyOpen) conditions.push('cb.balance > 0');
    if (q) {
      conditions.push(`(c.name ILIKE $${i} OR c.phone ILIKE $${i} OR c.cpf_cnpj ILIKE $${i})`);
      params.push(`%${q}%`);
      i++;
    }
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.phone, c.cpf_cnpj,
              cb.balance, cb.total_debited, cb.total_paid, cb.last_activity_at
         FROM customer_credit_balances cb
         JOIN customers c ON c.id = cb.customer_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY cb.balance DESC, cb.last_activity_at DESC NULLS LAST
        LIMIT 500`,
      params
    );
    const totals = rows.reduce(
      (acc, r) => ({
        total_open:     acc.total_open + Math.max(0, parseFloat(r.balance) || 0),
        customers_open: acc.customers_open + ((parseFloat(r.balance) || 0) > 0 ? 1 : 0),
      }),
      { total_open: 0, customers_open: 0 }
    );
    res.json({
      customers: rows.map(r => ({
        id: r.id, name: r.name, phone: r.phone, cpf_cnpj: r.cpf_cnpj,
        balance: parseFloat(r.balance) || 0,
        total_debited: parseFloat(r.total_debited) || 0,
        total_paid: parseFloat(r.total_paid) || 0,
        last_activity_at: r.last_activity_at,
      })),
      total_open: parseFloat(totals.total_open.toFixed(2)),
      customers_open: totals.customers_open,
    });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message, code: err.code });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[credit] balances error:', err.message);
    res.status(500).json({ error: 'Erro ao listar saldos de crediario' });
  }
});

// GET /customer/:cid
// F3: adiciona campo `accounts` com lista de carnes e saldo por carne.
// Hub F1.4: open_installments inclui account_id (defensivo 42703).
// F2 PR1: open_installments inclui encargos lazy (mora/multa) + total_due.
// Todos os campos pre-existentes sao mantidos intactos.
router.get('/customer/:cid', async (req, res) => {
  try {
    await assertCrediarioEnabled(req.params.id);
    const { rows: cust } = await db.query(
      `SELECT id, name, phone, cpf_cnpj FROM customers WHERE id = $1 AND company_id = $2`,
      [req.params.cid, req.params.id]
    );
    if (!cust.length) return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });

    const { rows: balanceRows } = await db.query(
      `SELECT balance, total_debited, total_paid, last_activity_at
         FROM customer_credit_balances WHERE customer_id = $1 AND company_id = $2`,
      [req.params.cid, req.params.id]
    );
    const b = balanceRows[0] || {};

    const { rows: txs } = await db.query(
      `SELECT id, sale_id, type, amount, payment_method, notes, created_at
         FROM customer_credit_transactions
        WHERE customer_id = $1 AND company_id = $2
        ORDER BY created_at DESC LIMIT 200`,
      [req.params.cid, req.params.id]
    );

    // Hub F1.4: inclui account_id nas parcelas abertas (defensivo: 42703 se coluna ainda nao existe)
    let installmentRows = [];
    try {
      const r = await db.query(
        `SELECT id, installment_number, total_installments,
                amount_due, covered_amount, due_date, status, late_fee, late_interest, account_id
           FROM credit_installments
          WHERE customer_id = $1 AND company_id = $2
            AND status IN ('pending','overdue')
          ORDER BY due_date ASC`,
        [req.params.cid, req.params.id]
      );
      installmentRows = r.rows;
    } catch (instErr) {
      if (instErr.code === '42703') {
        // account_id ainda nao existe — fallback sem a coluna
        const r = await db.query(
          `SELECT id, installment_number, total_installments,
                  amount_due, covered_amount, due_date, status, late_fee, late_interest
             FROM credit_installments
            WHERE customer_id = $1 AND company_id = $2
              AND status IN ('pending','overdue')
            ORDER BY due_date ASC`,
          [req.params.cid, req.params.id]
        ).catch(() => ({ rows: [] }));
        installmentRows = r.rows;
      } else if (instErr.code === '42P01') {
        installmentRows = [];
      } else throw instErr;
    }

    // F2 PR1: carrega config + profile do cliente 1x p/ o engine de encargos lazy.
    let lateConfig = null;
    try {
      const cfg = await db.query(`SELECT * FROM credit_plan_configs WHERE company_id = $1`, [req.params.id]);
      lateConfig = cfg.rows[0] || null;
    } catch (_) { lateConfig = null; }
    let lateProfile = null;
    try {
      const prof = await db.query(
        `SELECT * FROM customer_credit_profiles WHERE company_id = $1 AND customer_id = $2`,
        [req.params.id, req.params.cid]
      );
      lateProfile = prof.rows[0] || null;
    } catch (_) { lateProfile = null; }
    const lateTerms = creditLedger.resolveTerms(lateProfile, lateConfig);

    // F3: carnes do cliente (defensivo: tabela pode nao existir ainda)
    let accounts = [];
    try {
      const today = `(NOW() AT TIME ZONE 'America/Sao_Paulo')::date`;

      // Carnes cadastrados
      const { rows: accRows } = await db.query(
        `SELECT id, name, status,
                terms_snapshot->>'period_unit'  AS period_unit,
                terms_snapshot->>'period_count' AS period_count
           FROM credit_accounts
          WHERE company_id = $1 AND customer_id = $2
          ORDER BY created_at ASC`,
        [req.params.id, req.params.cid]
      );

      // Saldo + proxima parcela por carne (inclui legado account_id IS NULL)
      const { rows: accBalRows } = await db.query(
        `SELECT
           cct.account_id,
           COALESCE(SUM(CASE WHEN cct.type='debit' THEN cct.amount ELSE 0 END)
             - SUM(CASE WHEN cct.type='payment' THEN cct.amount ELSE 0 END), 0) AS balance,
           COUNT(ci.id) FILTER (WHERE ci.status IN ('pending','overdue'))        AS open_count,
           MIN(ci.due_date) FILTER (WHERE ci.status IN ('pending','overdue'))    AS next_due_date,
           BOOL_OR(ci.due_date < ${today} AND ci.status IN ('pending','overdue')) AS overdue
         FROM customer_credit_transactions cct
         LEFT JOIN credit_installments ci
           ON ci.company_id = cct.company_id
           AND ci.customer_id = cct.customer_id
           AND (ci.account_id = cct.account_id OR (ci.account_id IS NULL AND cct.account_id IS NULL))
         WHERE cct.company_id = $1 AND cct.customer_id = $2
         GROUP BY cct.account_id`,
        [req.params.id, req.params.cid]
      );

      // Mapa account_id -> balances
      const balMap = {};
      for (const r of accBalRows) {
        balMap[r.account_id ?? '__legacy__'] = r;
      }

      // Montar lista: carnes cadastrados
      for (const acc of accRows) {
        const bdata = balMap[acc.id] || {};
        accounts.push({
          id:           acc.id,
          name:         acc.name,
          status:       acc.status,
          balance:      parseFloat(bdata.balance || 0),
          open_count:   parseInt(bdata.open_count || 0),
          next_due_date: bdata.next_due_date ? String(bdata.next_due_date).split('T')[0] : null,
          overdue:      bdata.overdue || false,
          period_unit:  acc.period_unit || null,
          period_count: acc.period_count ? parseInt(acc.period_count) : null,
        });
      }

      // Conta geral (legado: transacoes sem account_id)
      const legacyBal = balMap['__legacy__'];
      if (legacyBal && parseFloat(legacyBal.balance) !== 0) {
        accounts.unshift({
          id:           null,
          name:         'Conta geral',
          status:       'open',
          balance:      parseFloat(legacyBal.balance),
          open_count:   parseInt(legacyBal.open_count || 0),
          next_due_date: legacyBal.next_due_date ? String(legacyBal.next_due_date).split('T')[0] : null,
          overdue:      legacyBal.overdue || false,
          period_unit:  null,
          period_count: null,
        });
      }
    } catch (accErr) {
      // 42P01 = credit_accounts nao existe ainda; 42703 = account_id nao existe
      if (accErr.code !== '42P01' && accErr.code !== '42703') {
        console.error('[credit] accounts fetch error:', accErr.message);
      }
      accounts = [];
    }

    res.json({
      customer:          cust[0],
      balance:           parseFloat(b.balance) || 0,
      total_debited:     parseFloat(b.total_debited) || 0,
      total_paid:        parseFloat(b.total_paid) || 0,
      last_activity_at:  b.last_activity_at || null,
      accounts,
      transactions: txs.map(t => ({
        id: t.id, sale_id: t.sale_id, type: t.type,
        amount: parseFloat(t.amount), payment_method: t.payment_method,
        notes: t.notes, created_at: t.created_at,
      })),
      // F2 PR1: encargos lazy (mora/multa) por parcela. Zero se capability OFF.
      open_installments: installmentRows.map(i => {
        const remaining = parseFloat((parseFloat(i.amount_due) - parseFloat(i.covered_amount || 0)).toFixed(2));
        const lc = creditLedger.computeLateCharges(i, lateTerms, lateConfig);
        return {
          id: i.id,
          installment_number:  i.installment_number,
          total_installments:  i.total_installments,
          amount_due:          parseFloat(i.amount_due),
          covered_amount:      parseFloat(i.covered_amount || 0),
          remaining,
          due_date:            i.due_date,
          status:              i.status,
          late_fee:            lc.late_fee,
          late_interest:       lc.late_interest,
          charges_total:       lc.charges_total,
          days_overdue:        lc.days_overdue,
          days_charged:        lc.days_charged,
          total_due:           parseFloat((remaining + lc.charges_total).toFixed(2)),
          account_id:          i.account_id || null,
        };
      }),
    });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message, code: err.code });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[credit] customer detail error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar historico do cliente' });
  }
});

// POST /customer/:cid/accounts (F3)
// Cria um novo carne para o cliente.
router.post('/customer/:cid/accounts', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const {
    name,
    interest_rate,
    period_unit,
    period_count,
    due_day,
    max_installments,
    late_fee_rate,
    late_interest_daily,
  } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }

  try {
    await assertCrediarioEnabled(companyId);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }

  // Verificar cliente
  const { rows: custRows } = await db.query(
    `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
    [customerId, companyId]
  );
  if (!custRows.length) return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });

  // Montar terms_snapshot apenas com campos fornecidos
  const termsSnapshot = {};
  if (interest_rate      !== undefined) termsSnapshot.interest_rate       = parseFloat(interest_rate) || 0;
  if (period_unit        !== undefined) termsSnapshot.period_unit          = period_unit;
  if (period_count       !== undefined) termsSnapshot.period_count         = parseInt(period_count) || 1;
  if (due_day            !== undefined) termsSnapshot.due_day              = parseInt(due_day) || null;
  if (max_installments   !== undefined) termsSnapshot.max_installments     = parseInt(max_installments) || 12;
  if (late_fee_rate      !== undefined) termsSnapshot.late_fee_rate        = parseFloat(late_fee_rate) || 0;
  if (late_interest_daily !== undefined) termsSnapshot.late_interest_daily = parseFloat(late_interest_daily) || 0;

  try {
    const { rows } = await db.query(
      `INSERT INTO credit_accounts
         (company_id, customer_id, name, status, terms_snapshot)
       VALUES ($1, $2, $3, 'open', $4)
       RETURNING *`,
      [companyId, customerId, String(name).trim(), Object.keys(termsSnapshot).length ? JSON.stringify(termsSnapshot) : null]
    );
    return res.status(201).json({ account: rows[0] });
  } catch (err) {
    if (err.code === '42P01') return res.status(503).json({ error: 'Tabela credit_accounts ainda nao disponivel. Aguarde o deploy completo.' });
    console.error('[credit] create account error:', err.message);
    return res.status(500).json({ error: 'Erro ao criar carne' });
  }
});

// POST /customer/:cid/payment
// F3: aceita account_id (FIFO escopo) OU allocations [{account_id, amount}]
// 05/06/2026: aceita paid_at (YYYY-MM-DD) para recebimento retroativo.
// F2 PR2: carrega config/profile do cliente e os passa ao applyPayment, que
//   MATERIALIZA encargos (mora/multa) ANTES do principal quando
//   config.late_charges_enabled === true. Resposta expoe charges_paid.
router.post('/customer/:cid/payment', async (req, res) => {
  const amount      = parseFloat(req.body?.amount || 0);
  const method      = req.body?.payment_method ? String(req.body.payment_method).trim() : null;
  const notes       = req.body?.notes ? String(req.body.notes).trim() : null;
  const paidAt      = normalizeBackdate(req.body?.paid_at);
  const accountId   = req.body?.account_id || null;
  const allocations = Array.isArray(req.body?.allocations) ? req.body.allocations : null;

  // Validar allocations se fornecidas
  if (allocations) {
    if (!allocations.length) return res.status(400).json({ error: 'allocations nao pode ser array vazio' });
    const total = allocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
    if (Math.abs(total - amount) > 0.01 && amount > 0) {
      return res.status(400).json({ error: `Soma das allocations (${total.toFixed(2)}) deve ser igual a amount (${amount.toFixed(2)})` });
    }
    for (const a of allocations) {
      if (!a.account_id && a.account_id !== null) return res.status(400).json({ error: 'Cada allocation precisa de account_id (uuid ou null para Conta geral)' });
      if (!parseFloat(a.amount) || parseFloat(a.amount) <= 0) return res.status(400).json({ error: 'Cada allocation precisa de amount > 0' });
    }
  } else if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount > 0 obrigatorio' });
  }

  try {
    await assertCrediarioEnabled(req.params.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: cust } = await client.query(
      `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
      [req.params.cid, req.params.id]
    );
    if (!cust.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });
    }

    let activeSessaoId = null;
    try {
      const sessRes = await client.query(
        `SELECT id FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
        [req.params.id]
      );
      activeSessaoId = sessRes?.rows?.[0]?.id || null;
    } catch (_) {}

    // F2 PR2: carrega config + profile (defensivo). applyPayment usa para
    // materializar encargos quando late_charges_enabled === true.
    const { config: lateConfig, profile: lateProfile } =
      await loadLateChargesContext(client, req.params.id, req.params.cid);

    // Modo allocations: chama applyPayment uma vez por alocacao
    if (allocations) {
      const allResults = [];
      let totalChargesPaid = 0;
      for (const alloc of allocations) {
        const result = await creditLedger.applyPayment(client, {
          companyId:  req.params.id,
          customerId: req.params.cid,
          amount:     parseFloat(alloc.amount),
          method,
          sessaoId:   activeSessaoId,
          createdBy:  req.user?.id || null,
          paidAt,
          accountId:  alloc.account_id || null,
          config:     lateConfig,
          profile:    lateProfile,
        });
        totalChargesPaid += result.charges_paid || 0;
        allResults.push({ account_id: alloc.account_id || null, amount: parseFloat(alloc.amount), result });
      }

      await client.query('COMMIT');

      // Retorna novo saldo consolidado
      const { rows: balRows } = await db.query(
        `SELECT COALESCE(balance, 0) AS balance FROM customer_credit_balances
         WHERE customer_id = $1 AND company_id = $2`,
        [req.params.cid, req.params.id]
      );

      return res.status(201).json({
        mode: 'allocations',
        allocations: allResults.map(r => ({
          account_id: r.account_id,
          amount: r.amount,
          transaction: r.result.transaction ? {
            id: r.result.transaction.id,
            type: r.result.transaction.type,
            amount: parseFloat(r.result.transaction.amount),
            payment_method: r.result.transaction.payment_method,
            created_at: r.result.transaction.created_at,
          } : null,
          settled: r.result.settled_receivables,
          charges_paid: r.result.charges_paid || 0,
        })),
        new_balance: parseFloat(balRows[0]?.balance || 0),
        charges_paid: parseFloat(totalChargesPaid.toFixed(2)),
        notes,
      });
    }

    // Modo simples (account_id ou global)
    const result = await creditLedger.applyPayment(client, {
      companyId:  req.params.id,
      customerId: req.params.cid,
      amount,
      method,
      sessaoId:   activeSessaoId,
      createdBy:  req.user?.id || null,
      paidAt,
      accountId,
      config:     lateConfig,
      profile:    lateProfile,
    });

    await client.query('COMMIT');

    res.status(201).json({
      mode: accountId ? 'account' : 'global',
      account_id: accountId || null,
      transaction: result.transaction ? {
        id:             result.transaction.id,
        type:           result.transaction.type,
        amount:         parseFloat(result.transaction.amount),
        payment_method: result.transaction.payment_method,
        notes,
        created_at:     result.transaction.created_at,
      } : null,
      new_balance:   result.new_balance,
      settled:       result.settled_receivables,
      legacy_amount: result.legacy_amount || 0,
      charges_paid:  result.charges_paid || 0,
      charges_detail: result.charges_detail || [],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[credit] payment error:', err.message);
    res.status(500).json({ error: 'Erro ao registrar pagamento' });
  } finally {
    client.release();
  }
});

// DELETE /transaction/:txid
router.delete('/transaction/:txid', async (req, res) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM customer_credit_transactions
        WHERE id = $1 AND company_id = $2 AND sale_id IS NULL
        RETURNING id, customer_id`,
      [req.params.txid, req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({
        error: 'Lancamento nao encontrado ou vinculado a uma venda (cancele a venda no PDV)',
      });
    }
    const { rows: b } = await db.query(
      `SELECT balance FROM customer_credit_balances
        WHERE customer_id = $1 AND company_id = $2`,
      [rows[0].customer_id, req.params.id]
    );
    res.json({ deleted: true, new_balance: parseFloat(b[0]?.balance || 0) });
  } catch (err) {
    console.error('[credit] delete tx error:', err.message);
    res.status(500).json({ error: 'Erro ao desfazer lancamento' });
  }
});

// GET /customers/search?q=
router.get('/customers/search', async (req, res) => {
  const q = req.query.q ? String(req.query.q).trim() : '';
  if (!q || q.length < 2) return res.json({ customers: [] });
  try {
    const { rows } = await db.query(
      `SELECT id, name, phone, cpf_cnpj
         FROM customers
        WHERE company_id = $1
          AND (name ILIKE $2 OR phone ILIKE $2 OR cpf_cnpj ILIKE $2)
        ORDER BY name ASC
        LIMIT 20`,
      [req.params.id, `%${q}%`]
    );
    res.json({ customers: rows });
  } catch (err) {
    console.error('[credit] customers/search error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar clientes' });
  }
});

// POST /manual-entry
// F3: aceita account_id (anexa ao carne) OU new_account_name (cria carne e usa).
// F2: se carne tem terms_snapshot, usa como defaults de juros/periodicidade.
// 05/06/2026: aceita entry_date e period_unit/period_count.
router.post('/manual-entry', async (req, res) => {
  const companyId = req.params.id;
  const {
    customer_id,
    new_customer,
    amount,
    installments = 1,
    interest_rate,
    first_due_date,
    description,
    entry_date,
    period_unit,
    period_count,
    account_id,
    new_account_name,
  } = req.body || {};

  const total = parseFloat(amount);
  const n     = parseInt(installments) || 1;
  const entryDate = normalizeBackdate(entry_date);

  if (!total || total <= 0)
    return res.status(400).json({ error: 'amount invalido' });
  if (n < 1 || n > 36)
    return res.status(400).json({ error: 'installments deve ser entre 1 e 36' });
  if (!customer_id && !new_customer?.name)
    return res.status(400).json({ error: 'Informe customer_id ou new_customer.name' });
  if (!customer_id && !new_customer?.phone)
    return res.status(400).json({ error: 'Telefone do cliente e obrigatorio' });

  try {
    await assertCrediarioEnabled(companyId);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Resolve customer
    let custId = customer_id || null;
    if (!custId) {
      const phoneClean = String(new_customer.phone).trim();
      const { rows: existing } = await client.query(
        `SELECT id FROM customers WHERE company_id = $1 AND phone = $2 LIMIT 1`,
        [companyId, phoneClean]
      );
      if (existing.length) {
        custId = existing[0].id;
      } else {
        const { rows: created } = await client.query(
          `INSERT INTO customers (company_id, name, phone)
           VALUES ($1, $2, $3) RETURNING id`,
          [companyId, String(new_customer.name).trim(), phoneClean]
        );
        custId = created[0].id;
      }
    }

    const { rows: custRows } = await client.query(
      `SELECT id, name FROM customers WHERE id = $1 AND company_id = $2`,
      [custId, companyId]
    );
    if (!custRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });
    }

    // 2. F3: resolve account_id
    let resolvedAccountId = account_id || null;
    let accountTerms = null;

    if (!resolvedAccountId && new_account_name) {
      // Criar novo carne inline
      try {
        const { rows: newAccRows } = await client.query(
          `INSERT INTO credit_accounts (company_id, customer_id, name, status)
           VALUES ($1, $2, $3, 'open') RETURNING id`,
          [companyId, custId, String(new_account_name).trim()]
        );
        resolvedAccountId = newAccRows[0].id;
      } catch (e) {
        if (e.code === '42P01') {
          // tabela ainda nao existe -- ignora, usa Conta geral
          resolvedAccountId = null;
        } else throw e;
      }
    }

    if (resolvedAccountId) {
      try {
        const { rows: accRows } = await client.query(
          `SELECT terms_snapshot FROM credit_accounts WHERE id = $1 AND company_id = $2`,
          [resolvedAccountId, companyId]
        );
        accountTerms = accRows[0]?.terms_snapshot || null;
      } catch (e) {
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
    }

    // 3. Create debit transaction
    const notes = description ? String(description).trim() : 'Lancamento manual';
    let transaction;
    try {
      const { rows: txRows } = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, type, amount, notes, source, created_by, created_at, account_id)
         VALUES ($1, $2, 'debit', $3, $4, 'manual', $5,
                 COALESCE(($6::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo', NOW()), $7)
         RETURNING *`,
        [companyId, custId, total, notes, req.user?.id || null, entryDate, resolvedAccountId]
      );
      transaction = txRows[0];
    } catch (e) {
      if (e.code === '42703') {
        const { rows: txRows } = await client.query(
          `INSERT INTO customer_credit_transactions
             (company_id, customer_id, type, amount, notes, source, created_by, created_at)
           VALUES ($1, $2, 'debit', $3, $4, 'manual', $5,
                   COALESCE(($6::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo', NOW()))
           RETURNING *`,
          [companyId, custId, total, notes, req.user?.id || null, entryDate]
        );
        transaction = txRows[0];
        resolvedAccountId = null;
      } else throw e;
    }

    // 4. Resolve termos: valor explicito > carne (terms_snapshot) > config loja > default
    const config  = await creditLedger._getOrCreatePlanConfig(client, companyId);
    const period  = creditLedger.resolvePeriod(
      period_unit  || accountTerms?.period_unit,
      period_count || accountTerms?.period_count,
      config
    );
    const effectiveRate =
      interest_rate !== undefined && interest_rate !== null
        ? parseFloat(interest_rate)
        : parseFloat(accountTerms?.interest_rate != null ? accountTerms.interest_rate : config?.interest_rate) || 0;

    const totalWithInterest = effectiveRate > 0
      ? parseFloat((total * (1 + effectiveRate * n)).toFixed(2))
      : total;
    const baseAmount = Math.floor((totalWithInterest / n) * 100) / 100;
    const remainder  = Math.round((totalWithInterest - baseAmount * n) * 100) / 100;

    const firstDue = first_due_date || (() => {
      const d = new Date();
      d.setMonth(d.getMonth() + 1);
      return d.toISOString().split('T')[0];
    })();

    // 5. Criar parcelas
    const createdInstallments = [];
    for (let i = 1; i <= n; i++) {
      const instAmount = i === n ? baseAmount + remainder : baseAmount;
      const dueDateStr = creditLedger.dueDateForIndex(firstDue, period.unit, period.count, i - 1);

      let row;
      try {
        const ins = await client.query(
          `INSERT INTO credit_installments
             (company_id, sale_id, customer_id, installment_number, total_installments,
              amount_due, due_date, status, pix_link, covered_amount, account_id)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', $7, 0, $8) RETURNING *`,
          [companyId, custId, i, n, instAmount, dueDateStr,
           'https://pagar.getaura.com.br/parcela/tmp', resolvedAccountId]
        );
        row = ins.rows[0];
      } catch (e) {
        if (e.code === '42703') {
          const ins = await client.query(
            `INSERT INTO credit_installments
               (company_id, sale_id, customer_id, installment_number, total_installments,
                amount_due, due_date, status, pix_link, covered_amount)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', $7, 0) RETURNING *`,
            [companyId, custId, i, n, instAmount, dueDateStr,
             'https://pagar.getaura.com.br/parcela/tmp']
          );
          row = ins.rows[0];
        } else throw e;
      }
      const pixLink = `https://pagar.getaura.com.br/parcela/${row.id.replace(/-/g, '').slice(0, 12)}`;
      await client.query(`UPDATE credit_installments SET pix_link = $2 WHERE id = $1`, [row.id, pixLink]);
      createdInstallments.push({ ...row, pix_link: pixLink });
    }

    await creditLedger._updateCreditUsed(client, companyId, custId);
    await client.query('COMMIT');

    const { rows: balRows } = await db.query(
      `SELECT balance FROM customer_credit_balances WHERE customer_id = $1 AND company_id = $2`,
      [custId, companyId]
    );

    res.status(201).json({
      customer:     custRows[0],
      transaction:  { ...transaction, amount: parseFloat(transaction.amount) },
      account_id:   resolvedAccountId || null,
      installments: createdInstallments.map(r => ({
        ...r,
        amount_due:     parseFloat(r.amount_due),
        covered_amount: parseFloat(r.covered_amount || 0),
      })),
      new_balance: parseFloat(balRows[0]?.balance || 0),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[credit] manual-entry error:', err.message);
    res.status(500).json({ error: 'Erro ao criar lancamento manual' });
  } finally {
    client.release();
  }
});

module.exports = router;
