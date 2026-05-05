// ============================================================
// AURA. -- Crediario (fiado) por cliente
// GET    /companies/:id/credit/balances             -- lista saldos
// GET    /companies/:id/credit/customer/:cid        -- saldo + historico
// POST   /companies/:id/credit/customer/:cid/payment -- registra pagamento
// DELETE /companies/:id/credit/transaction/:txid    -- desfaz lancamento
//
// Modelo: customer_credit_transactions (debit | payment), saldo via
// view customer_credit_balances. NAO integra com Financeiro/transactions.
// Escopo: por (company_id atual + customer_id) — saldo e por loja, mesmo
// que a lista de clientes do owner seja consolidada multi-CNPJ.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// GET /companies/:id/credit/balances?only_open=true&q=texto
router.get('/balances', async (req, res) => {
  const onlyOpen = req.query.only_open !== 'false'; // default true
  const q = req.query.q ? String(req.query.q).trim() : '';

  try {
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
        total_open: acc.total_open + Math.max(0, parseFloat(r.balance) || 0),
        customers_open: acc.customers_open + ((parseFloat(r.balance) || 0) > 0 ? 1 : 0),
      }),
      { total_open: 0, customers_open: 0 }
    );

    res.json({
      customers: rows.map(r => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        cpf_cnpj: r.cpf_cnpj,
        balance: parseFloat(r.balance) || 0,
        total_debited: parseFloat(r.total_debited) || 0,
        total_paid: parseFloat(r.total_paid) || 0,
        last_activity_at: r.last_activity_at,
      })),
      total_open: parseFloat(totals.total_open.toFixed(2)),
      customers_open: totals.customers_open,
    });
  } catch (err) {
    console.error('[credit] balances error:', err.message);
    res.status(500).json({ error: 'Erro ao listar saldos de crediario' });
  }
});

// GET /companies/:id/credit/customer/:cid
router.get('/customer/:cid', async (req, res) => {
  try {
    const { rows: cust } = await db.query(
      `SELECT id, name, phone, cpf_cnpj
         FROM customers
        WHERE id = $1 AND company_id = $2`,
      [req.params.cid, req.params.id]
    );
    if (!cust.length) return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });

    const { rows: balanceRows } = await db.query(
      `SELECT balance, total_debited, total_paid, last_activity_at
         FROM customer_credit_balances
        WHERE customer_id = $1 AND company_id = $2`,
      [req.params.cid, req.params.id]
    );
    const b = balanceRows[0] || {};

    const { rows: txs } = await db.query(
      `SELECT id, sale_id, type, amount, payment_method, notes, created_at
         FROM customer_credit_transactions
        WHERE customer_id = $1 AND company_id = $2
        ORDER BY created_at DESC
        LIMIT 200`,
      [req.params.cid, req.params.id]
    );

    res.json({
      customer: cust[0],
      balance: parseFloat(b.balance) || 0,
      total_debited: parseFloat(b.total_debited) || 0,
      total_paid: parseFloat(b.total_paid) || 0,
      last_activity_at: b.last_activity_at || null,
      transactions: txs.map(t => ({
        id: t.id,
        sale_id: t.sale_id,
        type: t.type,
        amount: parseFloat(t.amount),
        payment_method: t.payment_method,
        notes: t.notes,
        created_at: t.created_at,
      })),
    });
  } catch (err) {
    console.error('[credit] customer detail error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar historico do cliente' });
  }
});

// POST /companies/:id/credit/customer/:cid/payment
// body: { amount, payment_method?, notes? }
router.post('/customer/:cid/payment', async (req, res) => {
  const amount = parseFloat(req.body?.amount || 0);
  const method = req.body?.payment_method ? String(req.body.payment_method).trim() : null;
  const notes  = req.body?.notes ? String(req.body.notes).trim() : null;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount > 0 obrigatorio' });
  }

  try {
    const { rows: cust } = await db.query(
      `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
      [req.params.cid, req.params.id]
    );
    if (!cust.length) return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });

    const { rows: tx } = await db.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, sale_id, type, amount, payment_method, notes, created_by)
       VALUES ($1, $2, NULL, 'payment', $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, req.params.cid, amount, method, notes, req.user?.id || null]
    );

    const { rows: b } = await db.query(
      `SELECT balance FROM customer_credit_balances
        WHERE customer_id = $1 AND company_id = $2`,
      [req.params.cid, req.params.id]
    );

    res.status(201).json({
      transaction: {
        id: tx[0].id,
        type: tx[0].type,
        amount: parseFloat(tx[0].amount),
        payment_method: tx[0].payment_method,
        notes: tx[0].notes,
        created_at: tx[0].created_at,
      },
      new_balance: parseFloat(b[0]?.balance || 0),
    });
  } catch (err) {
    console.error('[credit] payment error:', err.message);
    res.status(500).json({ error: 'Erro ao registrar pagamento' });
  }
});

// DELETE /companies/:id/credit/transaction/:txid
// Permite desfazer um lancamento manual (pagamento criado por engano).
// Nao deleta lancamentos com sale_id — esses sao revertidos via cancel da venda.
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

module.exports = router;
