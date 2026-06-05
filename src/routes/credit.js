// ============================================================
// AURA. -- Crediario (fiado) por cliente
// GET    /companies/:id/credit/balances
// GET    /companies/:id/credit/customer/:cid
// POST   /companies/:id/credit/customer/:cid/payment
// DELETE /companies/:id/credit/transaction/:txid
//
// F1 (29/05/2026): POST /payment delega inteiramente a
// creditLedger.applyPayment. Logica FIFO movida para o servico
// unificado. Interface de resposta mantida para compatibilidade.
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

// Normaliza uma data de registro retroativo (recebimento/lancamento).
// Aceita apenas 'YYYY-MM-DD' estritamente ANTERIOR a hoje (America/Sao_Paulo).
// Retorna a string normalizada ou null (hoje/futuro/invalido -> usa NOW() no
// servico, preservando o comportamento padrao).
function normalizeBackdate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const todaySp = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  if (s >= todaySp) return null;
  return s;
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

    // Parcelas abertas com covered_amount
    const { rows: installments } = await db.query(
      `SELECT id, installment_number, total_installments,
              amount_due, covered_amount, due_date, status, late_fee, late_interest
         FROM credit_installments
        WHERE customer_id = $1 AND company_id = $2
          AND status IN ('pending','overdue')
        ORDER BY due_date ASC`,
      [req.params.cid, req.params.id]
    ).catch(() => ({ rows: [] }));

    res.json({
      customer:          cust[0],
      balance:           parseFloat(b.balance) || 0,
      total_debited:     parseFloat(b.total_debited) || 0,
      total_paid:        parseFloat(b.total_paid) || 0,
      last_activity_at:  b.last_activity_at || null,
      transactions: txs.map(t => ({
        id: t.id, sale_id: t.sale_id, type: t.type,
        amount: parseFloat(t.amount), payment_method: t.payment_method,
        notes: t.notes, created_at: t.created_at,
      })),
      open_installments: installments.map(i => ({
        id: i.id,
        installment_number:  i.installment_number,
        total_installments:  i.total_installments,
        amount_due:          parseFloat(i.amount_due),
        covered_amount:      parseFloat(i.covered_amount || 0),
        remaining:           parseFloat((parseFloat(i.amount_due) - parseFloat(i.covered_amount || 0)).toFixed(2)),
        due_date:            i.due_date,
        status:              i.status,
        late_fee:            parseFloat(i.late_fee || 0),
        late_interest:       parseFloat(i.late_interest || 0),
      })),
    });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message, code: err.code });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[credit] customer detail error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar historico do cliente' });
  }
});

// POST /customer/:cid/payment
// F1 (29/05/2026): delega inteiramente a creditLedger.applyPayment.
// FIFO liquidacao + covered_amount + sale_payments tudo atomico no servico.
// 05/06/2026: aceita paid_at (YYYY-MM-DD) para recebimento retroativo.
router.post('/customer/:cid/payment', async (req, res) => {
  const amount = parseFloat(req.body?.amount || 0);
  const method = req.body?.payment_method ? String(req.body.payment_method).trim() : null;
  const notes  = req.body?.notes ? String(req.body.notes).trim() : null;
  const paidAt = normalizeBackdate(req.body?.paid_at);

  if (!amount || amount <= 0) {
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

    const result = await creditLedger.applyPayment(client, {
      companyId:  req.params.id,
      customerId: req.params.cid,
      amount,
      method,
      sessaoId:   activeSessaoId,
      createdBy:  req.user?.id || null,
      paidAt,
    });

    await client.query('COMMIT');

    res.status(201).json({
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

// ─────────────────────────────────────────────────────────────────────────
// GET /customers/search?q=
// Busca clientes da empresa por nome, telefone ou CPF/CNPJ.
// Retorna até 20 resultados. Mínimo 2 caracteres.
// ─────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────
// POST /manual-entry
// Cria lançamento de débito manual no crediário (sem venda vinculada).
// Aceita cliente existente (customer_id) ou criação inline (new_customer).
// Cria agenda de parcelas em credit_installments com juros simples opcionais.
// 05/06/2026: aceita entry_date (YYYY-MM-DD) para lançamento retroativo.
// ─────────────────────────────────────────────────────────────────────────
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
  } = req.body || {};

  const total = parseFloat(amount);
  const n     = parseInt(installments) || 1;
  const entryDate = normalizeBackdate(entry_date);

  if (!total || total <= 0)
    return res.status(400).json({ error: 'amount inválido' });
  if (n < 1 || n > 36)
    return res.status(400).json({ error: 'installments deve ser entre 1 e 36' });
  if (!customer_id && !new_customer?.name)
    return res.status(400).json({ error: 'Informe customer_id ou new_customer.name' });
  if (!customer_id && !new_customer?.phone)
    return res.status(400).json({ error: 'Telefone do cliente é obrigatório' });

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
      return res.status(404).json({ error: 'Cliente não encontrado nesta empresa' });
    }

    // 2. Create debit transaction (source = 'manual')
    // created_at backdatado quando entry_date for uma data passada (lançamento retroativo).
    const notes = description ? String(description).trim() : 'Lançamento manual';
    const { rows: txRows } = await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, type, amount, notes, source, created_by, created_at)
       VALUES ($1, $2, 'debit', $3, $4, 'manual', $5,
               COALESCE(($6::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo', NOW()))
       RETURNING *`,
      [companyId, custId, total, notes, req.user?.id || null, entryDate]
    );
    const transaction = txRows[0];

    // 3. Create installments schedule (juros simples)
    const config        = await creditLedger._getOrCreatePlanConfig(client, companyId);
    const effectiveRate =
      interest_rate !== undefined && interest_rate !== null
        ? parseFloat(interest_rate)
        : (parseFloat(config?.interest_rate) || 0);

    const totalWithInterest =
      effectiveRate > 0
        ? parseFloat((total * (1 + effectiveRate * n)).toFixed(2))
        : total;
    const baseAmount = Math.floor((totalWithInterest / n) * 100) / 100;
    const remainder  = Math.round((totalWithInterest - baseAmount * n) * 100) / 100;

    const firstDue = first_due_date || (() => {
      const d = new Date();
      d.setMonth(d.getMonth() + 1);
      return d.toISOString().split('T')[0];
    })();

    const createdInstallments = [];
    for (let i = 1; i <= n; i++) {
      const instAmount = i === n ? baseAmount + remainder : baseAmount;
      const dueDate    = new Date(firstDue);
      dueDate.setMonth(dueDate.getMonth() + (i - 1));
      const dueDateStr = dueDate.toISOString().split('T')[0];

      const ins = await client.query(
        `INSERT INTO credit_installments
           (company_id, sale_id, customer_id, installment_number, total_installments,
            amount_due, due_date, status, pix_link, covered_amount)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', $7, 0) RETURNING *`,
        [companyId, custId, i, n, instAmount, dueDateStr,
         'https://pagar.getaura.com.br/parcela/tmp']
      );
      const row     = ins.rows[0];
      const pixLink = `https://pagar.getaura.com.br/parcela/${row.id.replace(/-/g, '').slice(0, 12)}`;
      await client.query(`UPDATE credit_installments SET pix_link = $2 WHERE id = $1`, [row.id, pixLink]);
      createdInstallments.push({ ...row, pix_link: pixLink });
    }

    // 4. Update credit used
    await creditLedger._updateCreditUsed(client, companyId, custId);

    await client.query('COMMIT');

    const { rows: balRows } = await db.query(
      `SELECT balance FROM customer_credit_balances WHERE customer_id = $1 AND company_id = $2`,
      [custId, companyId]
    );

    res.status(201).json({
      customer:     custRows[0],
      transaction:  { ...transaction, amount: parseFloat(transaction.amount) },
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
    res.status(500).json({ error: 'Erro ao criar lançamento manual' });
  } finally {
    client.release();
  }
});

module.exports = router;
