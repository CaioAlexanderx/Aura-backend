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
//
// FEAT 09/05/2026 (toggle crediario): rotas /balances, /customer/:cid e
// /customer/:cid/payment agora exigem pdv_settings.crediario_enabled=true.
// Companies sem crediario habilitado recebem 403 CREDIARIO_DISABLED. Frontend
// usa esse codigo pra mostrar mensagem amigavel direcionando para Configuracoes.
//
// FEAT 09/05/2026 (crediário Opção A — competência separada):
// POST /payment agora liquida em FIFO as transactions "Crediário - A
// Receber" pendentes do cliente (idempotency_key='pdv-credit-receivable-{saleId}'),
// marcando status=confirmed + paid_at=NOW e ajustando o valor caso o
// pagamento seja parcial (split em duas transactions: uma confirmada
// com o valor pago + uma pendente com o saldo). Em paralelo, cria
// sale_payments na sessao de caixa ativa apontando para a sale_id
// original da venda crediario (com method=payment_method), garantindo
// que o caixa fisico contabilize o recebimento por metodo (dinheiro/
// pix/cartao) na data correta. Sem caixa aberto, sale_payment fica com
// sessao_id=NULL e o caixaService cai no fallback de periodo.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// 09/05/2026 (toggle): bloqueia rotas se crediário não estiver habilitado
// no companies.pdv_settings.crediario_enabled. Espelha caixaService.assertCaixaEnabled.
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

// GET /companies/:id/credit/balances?only_open=true&q=texto
router.get('/balances', async (req, res) => {
  const onlyOpen = req.query.only_open !== 'false'; // default true
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
    if (err.status === 403) return res.status(403).json({ error: err.message, code: err.code });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[credit] balances error:', err.message);
    res.status(500).json({ error: 'Erro ao listar saldos de crediario' });
  }
});

// GET /companies/:id/credit/customer/:cid
router.get('/customer/:cid', async (req, res) => {
  try {
    await assertCrediarioEnabled(req.params.id);
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
    if (err.status === 403) return res.status(403).json({ error: err.message, code: err.code });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[credit] customer detail error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar historico do cliente' });
  }
});

// POST /companies/:id/credit/customer/:cid/payment
// body: { amount, payment_method?, notes? }
//
// 09/05/2026: alem de criar customer_credit_transactions credit (legado),
// liquida as transactions "Crediario - A Receber" pendentes (FIFO) do
// cliente, marcando-as como confirmed + criando sale_payments na sessao
// de caixa ativa. Tudo em uma unica transaction SQL para atomicidade.
router.post('/customer/:cid/payment', async (req, res) => {
  const amount = parseFloat(req.body?.amount || 0);
  const method = req.body?.payment_method ? String(req.body.payment_method).trim() : null;
  const notes  = req.body?.notes ? String(req.body.notes).trim() : null;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount > 0 obrigatorio' });
  }

  // 09/05/2026 (toggle crediario): valida feature antes de abrir transaction
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

    // 1) ledger legado — registra o pagamento no customer_credit_transactions
    const { rows: tx } = await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, sale_id, type, amount, payment_method, notes, created_by)
       VALUES ($1, $2, NULL, 'payment', $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, req.params.cid, amount, method, notes, req.user?.id || null]
    );

    // 2) Lookup da sessao de caixa ativa (best-effort)
    let activeSessaoId = null;
    try {
      const sessRes = await client.query(
        `SELECT id FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
        [req.params.id]
      );
      activeSessaoId = sessRes?.rows?.[0]?.id || null;
    } catch (sessErr) {
      // sem caixa habilitado — sale_payment fica sem sessao (cai no fallback)
    }

    // 3) FIFO liquidacao das transactions "Crediario - A Receber" pendentes
    //    do cliente. Match feito pelo idempotency_key 'pdv-credit-receivable-{saleId}'
    //    JOIN com sales para filtrar por customer_id.
    const fifoMethod = (method || 'dinheiro').toLowerCase();
    const settledTransactions = [];
    let remaining = amount;

    const { rows: pendingTxs } = await client.query(
      `SELECT t.id, t.amount, t.idempotency_key, s.id AS sale_id
       FROM transactions t
       JOIN sales s ON ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
       WHERE t.company_id = $1
         AND t.category = 'Crediário - A Receber'
         AND t.status = 'pending'
         AND s.customer_id = $2
         AND COALESCE(s.status, 'active') != 'cancelled'
       ORDER BY t.created_at ASC
       LIMIT 100`,
      [req.params.id, req.params.cid]
    );

    for (const pt of pendingTxs) {
      if (remaining <= 0.005) break;
      const ptAmount = parseFloat(pt.amount);

      if (ptAmount <= remaining + 0.005) {
        // Liquida totalmente esta transaction
        await client.query(
          `UPDATE transactions
             SET status = 'confirmed',
                 paid_at = NOW(),
                 payment_method = $1,
                 category = 'Crediário - Recebido',
                 updated_at = NOW()
           WHERE id = $2`,
          [fifoMethod, pt.id]
        );
        // sale_payment apontando para a sale original
        await client.query(
          `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [pt.sale_id, req.params.id, fifoMethod, ptAmount, activeSessaoId]
        );
        settledTransactions.push({ id: pt.id, sale_id: pt.sale_id, amount: ptAmount, partial: false });
        remaining = parseFloat((remaining - ptAmount).toFixed(2));
      } else {
        // Pagamento parcial — split em duas transactions:
        //   (a) confirmada com o valor pago (mantem idempotency_key original)
        //   (b) nova pendente com o saldo (idempotency_key '-rest-{ts}')
        const paidNow = parseFloat(remaining.toFixed(2));
        const restAmt = parseFloat((ptAmount - paidNow).toFixed(2));

        await client.query(
          `UPDATE transactions
             SET status = 'confirmed',
                 paid_at = NOW(),
                 payment_method = $1,
                 amount = $2,
                 category = 'Crediário - Recebido (parcial)',
                 updated_at = NOW()
           WHERE id = $3`,
          [fifoMethod, paidNow, pt.id]
        );
        await client.query(
          `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [pt.sale_id, req.params.id, fifoMethod, paidNow, activeSessaoId]
        );

        // Cria a nova A Receber para o saldo restante
        const restKey = pt.idempotency_key + '-rest-' + Date.now();
        await client.query(
          `INSERT INTO transactions
             (company_id, type, status, amount, description, category,
              due_date, paid_at, created_by, idempotency_key)
           VALUES ($1, 'income', 'pending', $2, $3, 'Crediário - A Receber',
                   (NOW() AT TIME ZONE 'America/Sao_Paulo')::date, NULL, $4, $5)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            req.params.id,
            restAmt,
            `Crediário - saldo venda ${pt.sale_id} (parcial)`,
            req.user?.id || null,
            restKey,
          ]
        );

        settledTransactions.push({ id: pt.id, sale_id: pt.sale_id, amount: paidNow, partial: true, rest: restAmt });
        remaining = 0;
      }
    }

    // 4) Sobra (pagamento maior que A Receber pendentes) — registra como
    //    transaction confirmada generica para o caixa nao perder a entrada.
    //    Pode ser zero se o cliente ainda tem debit no ledger legado sem
    //    A Receber correspondente (vendas crediario antigas pre-Opção A).
    if (remaining > 0.005) {
      await client.query(
        `INSERT INTO transactions
           (company_id, type, status, amount, description, category,
            due_date, paid_at, created_by, idempotency_key, payment_method)
         VALUES ($1, 'income', 'confirmed', $2, $3, 'Crediário - Recebido',
                 (NOW() AT TIME ZONE 'America/Sao_Paulo')::date, NOW(), $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          req.params.id,
          parseFloat(remaining.toFixed(2)),
          `Recebimento crediário - cliente ${req.params.cid} (saldo legado)`,
          req.user?.id || null,
          'credit-payment-' + tx[0].id + '-legacy',
          fifoMethod,
        ]
      );
    }

    await client.query('COMMIT');

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
      settled: settledTransactions,
      legacy_amount: remaining > 0.005 ? parseFloat(remaining.toFixed(2)) : 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[credit] payment error:', err.message);
    res.status(500).json({ error: 'Erro ao registrar pagamento' });
  } finally {
    client.release();
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
