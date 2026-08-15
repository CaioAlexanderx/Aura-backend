// AURA. -- Crediario (fiado) por cliente
// GET    /companies/:id/credit/balances
// GET    /companies/:id/credit/customer/:cid
// POST   /companies/:id/credit/customer/:cid/payment
// POST   /companies/:id/credit/customer/:cid/accounts   (F3)
// DELETE /companies/:id/credit/transaction/:txid
// POST   /companies/:id/credit/manual-entry
// GET    /companies/:id/credit/customers/:cid/history    (B1)
// GET    /companies/:id/credit/customers/:cid/payments/preview (B3)
// POST   /companies/:id/credit/customers/:cid/payments         (B3)
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
// B1 (11/06/2026): GET /customers/:cid/history -- timeline de eventos do
//                  cliente (compras com itens, pagamentos, creditos de troca,
//                  debitos manuais) com paginacao por cursor.
// B2 (11/06/2026): manual-entry NAO grava mais link fake pagar.getaura.com.br;
//                  pix_link fica NULL e o Pix real (EMV) e gerado on-demand
//                  via GET /credit/installments/:iid/pix.
// B3 (11/06/2026): GET  /customers/:cid/payments/preview -- dry-run, zero escrita.
//                  POST /customers/:cid/payments         -- aplica de verdade,
//                  aceita Idempotency-Key. Shape identico ao preview.
//                  Overpay => credit_generated (NAO rejeita). Defensivo 42703/42P01.
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

// ============================================================
// B3: computePaymentPlan -- funcao PURA (zero efeito colateral).
//
// Recebe as parcelas abertas e calcula a distribuicao planejada
// seguindo EXATAMENTE a mesma ordem que o applyPayment usa:
//   1. Encargos por parcela (FIFO oldest-first) ate esgotar amount;
//   2. Principal FIFO oldest-first (o que sobrar apos encargos);
//   3. Excedente => credit_generated (saldo negativo = credito).
//
// Params:
//   openInstallments -- linhas da credit_installments abertas,
//                       ordenadas por due_date ASC (ja com account_id
//                       filtrado quando fornecido pelo chamador).
//   opts.amount      -- valor recebido (positivo).
//   opts.config      -- credit_plan_configs row (pode ser undefined => OFF).
//   opts.profile     -- customer_credit_profiles row (pode ser undefined).
//   opts.paidAt      -- YYYY-MM-DD ou null (para asOf dos encargos).
//
// Retorna o shape canonico B3:
//   { applied: [...], new_balance, credit_generated }
// "new_balance" aqui e o saldo ATUAL mais o pagamento (uma estimativa
// read-only baseada no saldo da view); o valor real pos-commit e
// retornado pelo applyPayment.
// ============================================================
function computePaymentPlan(openInstallments, currentBalance, opts) {
  const { amount, config, profile, paidAt } = opts;
  const round2 = creditLedger.round2;
  const computeLateCharges = creditLedger.computeLateCharges;
  const resolveTerms = creditLedger.resolveTerms;

  const terms = resolveTerms(profile || null, config || null);

  // -- Fase 1: Encargos FIFO oldest-first ------------------------------------
  let remaining = amount;
  const chargesPerInst = openInstallments.map((inst) => {
    const lc = computeLateCharges(inst, terms, config || null, paidAt ? new Date(paidAt + 'T12:00:00') : new Date());
    return { inst, lc };
  });

  // Encargos so sao consumidos quando config.late_charges_enabled === true
  const chargesEnabled = config && config.late_charges_enabled === true;
  const chargesAllocated = {}; // installment_id -> { late_fee_paid, late_interest_paid }

  if (chargesEnabled) {
    for (const { inst, lc } of chargesPerInst) {
      if (remaining <= 0.005) break;
      const instCharges = round2(lc.charges_total || 0);
      if (instCharges <= 0.005) continue;

      const portion     = round2(Math.min(remaining, instCharges));
      const stampFee    = round2(Math.min(portion, lc.late_fee || 0));
      const stampIntr   = round2(Math.max(0, portion - stampFee));

      chargesAllocated[inst.id] = { charges_paid: portion, late_fee_paid: stampFee, late_interest_paid: stampIntr };
      remaining = round2(remaining - portion);
    }
  }

  // -- Fase 2: Principal FIFO oldest-first -----------------------------------
  const principalAmount = remaining; // o que sobrou apos encargos
  let toAllocate = principalAmount;

  const applied = [];
  for (const inst of openInstallments) {
    const currentCovered = parseFloat(inst.covered_amount) || 0;
    const amountDue      = parseFloat(inst.amount_due) || 0;
    const uncovered      = round2(amountDue - currentCovered);
    const chargesEntry   = chargesAllocated[inst.id] || { charges_paid: 0, late_fee_paid: 0, late_interest_paid: 0 };

    // Mesmo que nao tenha principal a alocar, se houve encargos nesta parcela
    // ela aparece no applied.
    if (toAllocate <= 0.005 && chargesEntry.charges_paid <= 0.005) continue;
    if (uncovered <= 0.005 && chargesEntry.charges_paid <= 0.005) continue;

    let principalPaid = 0;
    if (toAllocate > 0.005 && uncovered > 0.005) {
      principalPaid = round2(Math.min(toAllocate, uncovered));
      toAllocate    = round2(toAllocate - principalPaid);
    }

    const newCovered   = round2(currentCovered + principalPaid);
    const statusAfter  = newCovered >= amountDue - 0.005 ? 'paid' : inst.status;

    applied.push({
      installment_id: inst.id,
      account_id:     inst.account_id || null,
      number:         inst.installment_number || null,
      charges_paid:   round2(chargesEntry.charges_paid),
      principal_paid: principalPaid,
      status_after:   statusAfter,
    });
  }

  // Parcelas com encargos que nao foram incluidas acima (sem uncovered mas com encargos)
  for (const [instId, chargesEntry] of Object.entries(chargesAllocated)) {
    if (!applied.find(a => a.installment_id === instId)) {
      const inst = openInstallments.find(i => i.id === instId);
      if (inst) {
        applied.push({
          installment_id: inst.id,
          account_id:     inst.account_id || null,
          number:         inst.installment_number || null,
          charges_paid:   round2(chargesEntry.charges_paid),
          principal_paid: 0,
          status_after:   inst.status,
        });
      }
    }
  }

  // -- Fase 3: Excedente => credit_generated ---------------------------------
  // O excedente e o principal que sobrou apos quitar todas as parcelas abertas.
  const creditGenerated = round2(Math.max(0, toAllocate));

  // new_balance estimado: saldo atual menos o pagamento todo (encargos nao
  // alteram o principal balance da view, mas o applyPayment materializa a
  // transacao de encargos como 'confirmed' separada). Para o preview,
  // o new_balance reflete a reducao de principal:
  const newBalance = round2(currentBalance - amount);

  return { applied, new_balance: newBalance, credit_generated: creditGenerated };
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
        // account_id ainda nao existe -- fallback sem a coluna
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

      // FIX: saldo por carne -- SO transacoes (sem JOIN com parcelas para evitar fan-out).
      // 1 debito de R$500 + 5 parcelas no JOIN antigo contava 500x5 = R$2.500 (errado).
      // FIX 03/07/2026 (bug Jennifer): subtracao so considerava type='payment', ignorando
      // type='refund' (devolucao). Isso fazia a ficha (que usa este balRows quando o cliente
      // tem 'Conta geral'/carne) ficar com saldo desatualizado apos uma devolucao, enquanto
      // o painel de crediario (GET /credit/balances, que le customer_credit_balances direto)
      // ja mostrava o valor certo -- duas formulas de saldo divergentes. Agora usa type<>'debit'
      // (payment + refund + qualquer tipo futuro), espelhando a view customer_credit_balances.
      const { rows: balRows } = await db.query(
        `SELECT account_id,
                COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END)
                       - SUM(CASE WHEN type<>'debit' THEN amount ELSE 0 END), 0) AS balance
           FROM customer_credit_transactions
          WHERE company_id = $1 AND customer_id = $2
          GROUP BY account_id`,
        [req.params.id, req.params.cid]
      );

      // Metricas de parcelas por carne -- SO credit_installments (sem JOIN com transacoes).
      const { rows: instRows } = await db.query(
        `SELECT account_id,
                COUNT(*) FILTER (WHERE status IN ('pending','overdue'))               AS open_count,
                MIN(due_date) FILTER (WHERE status IN ('pending','overdue'))          AS next_due_date,
                BOOL_OR(due_date < ${today} AND status IN ('pending','overdue'))      AS overdue
           FROM credit_installments
          WHERE company_id = $1 AND customer_id = $2
          GROUP BY account_id`,
        [req.params.id, req.params.cid]
      );

      // Dois mapas separados por account_id
      const balMap = {};
      for (const r of balRows) {
        balMap[r.account_id ?? '__legacy__'] = { balance: r.balance };
      }
      const instMap = {};
      for (const r of instRows) {
        instMap[r.account_id ?? '__legacy__'] = {
          open_count:    r.open_count,
          next_due_date: r.next_due_date,
          overdue:       r.overdue,
        };
      }

      // Montar lista: carnes cadastrados
      for (const acc of accRows) {
        const bd = balMap[acc.id] || {};
        const id = instMap[acc.id] || {};
        accounts.push({
          id:            acc.id,
          name:          acc.name,
          status:        acc.status,
          balance:       parseFloat(bd.balance || 0),
          open_count:    parseInt(id.open_count || 0),
          next_due_date: id.next_due_date ? String(id.next_due_date).split('T')[0] : null,
          overdue:       id.overdue || false,
          period_unit:   acc.period_unit || null,
          period_count:  acc.period_count ? parseInt(acc.period_count) : null,
        });
      }

      // Conta geral (legado: transacoes sem account_id)
      const legacyBal  = balMap['__legacy__'];
      const legacyInst = instMap['__legacy__'];
      if (legacyBal && parseFloat(legacyBal.balance) !== 0) {
        accounts.unshift({
          id:            null,
          name:          'Conta geral',
          status:        'open',
          balance:       parseFloat(legacyBal.balance),
          open_count:    parseInt(legacyInst?.open_count || 0),
          next_due_date: legacyInst?.next_due_date ? String(legacyInst.next_due_date).split('T')[0] : null,
          overdue:       legacyInst?.overdue || false,
          period_unit:   null,
          period_count:  null,
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
  // Auditoria 12/06: Idempotency-Key (mesma leitura da rota B3) -- retry de
  // rede nao aplica o pagamento duas vezes (ON CONFLICT DO NOTHING no ledger).
  const idempotencyKey = req.headers['idempotency-key']
    ? String(req.headers['idempotency-key']).trim()
    : null;

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
      let allocIndex = 0;
      for (const alloc of allocations) {
        // Idempotency-Key sufixada por alocacao: a MESMA key em 2 applyPayment
        // viraria replay no-op da segunda alocacao (ON CONFLICT na key).
        const allocKey = idempotencyKey ? `${idempotencyKey}-alloc-${allocIndex}` : null;
        allocIndex++;
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
          idempotencyKey: allocKey,
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
      idempotencyKey,
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

// ============================================================
// B1 (11/06/2026): GET /customers/:cid/history
// Timeline de eventos do cliente de crediario, paginada por cursor.
//
// Query params:
//   limit  -- default 30, max 100
//   cursor -- opaco: base64 de `created_at|id` (do ultimo evento da pagina)
//   types  -- csv opcional de: purchase, manual_debit, payment, exchange_credit, refund
//
// Mapeamento customer_credit_transactions -> evento:
//   debit   + sale_id        -> purchase        (items: join sale_items)
//   debit   sem sale_id      -> manual_debit
//   refund                   -> refund           (A4-BE: tipo proprio)
//   payment + crediario_credito -> exchange_credit (credito vindo de troca)
//   payment (demais)         -> payment         (payment: { method })
//
// amount com sinal: debito positivo, pagamento/credito negativo.
// Ordem estavel: created_at DESC, id DESC (cursor sobre o mesmo par).
// NOTA: distribuicao por parcela de pagamentos antigos NAO e reconstituivel
//       a partir do ledger atual -- `distribution` fica fora deste endpoint.
// Defensivo (padrao do repo, cache module-level):
//   42703 account_id (migration 163) / source (migration 144) /
//   product_name_snapshot em sale_items; 42P01 sale_items ausente -> sem itens.
// ============================================================
const HISTORY_EVENT_TYPES = ['purchase', 'manual_debit', 'payment', 'exchange_credit', 'refund'];

const HISTORY_TYPE_SQL = {
  purchase:        `(t.type = 'debit' AND t.sale_id IS NOT NULL)`,
  manual_debit:    `(t.type = 'debit' AND t.sale_id IS NULL)`,
  exchange_credit: `(t.type = 'payment' AND t.payment_method = 'crediario_credito')`,
  payment:         `(t.type = 'payment' AND t.payment_method IS DISTINCT FROM 'crediario_credito')`,
  refund:          `(t.type = 'refund')`,
};

// Cache module-level de colunas opcionais (evita repetir try/catch por request)
const historyTxCols = { account_id: true, source: true };
let historySaleItemsHasSnapshot = true;

function decodeHistoryCursor(raw) {
  try {
    const decoded = Buffer.from(String(raw), 'base64').toString('utf8');
    const sep = decoded.lastIndexOf('|');
    if (sep <= 0) return null;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch (_) {
    return null;
  }
}

function encodeHistoryCursor(row) {
  const ts = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : new Date(row.created_at).toISOString();
  return Buffer.from(`${ts}|${row.id}`, 'utf8').toString('base64');
}

async function fetchHistoryTransactions(conditions, params, limitPlusOne) {
  const optional = [];
  if (historyTxCols.account_id) optional.push('t.account_id');
  if (historyTxCols.source)     optional.push('t.source');
  const cols = ['t.id', 't.sale_id', 't.type', 't.amount', 't.payment_method', 't.notes', 't.created_at']
    .concat(optional)
    .join(', ');
  try {
    const { rows } = await db.query(
      `SELECT ${cols}
         FROM customer_credit_transactions t
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${limitPlusOne}`,
      params
    );
    return rows;
  } catch (e) {
    if (e.code === '42703' && historyTxCols.account_id) {
      historyTxCols.account_id = false; // migration 163 ainda nao aplicada
      return fetchHistoryTransactions(conditions, params, limitPlusOne);
    }
    if (e.code === '42703' && historyTxCols.source) {
      historyTxCols.source = false; // migration 144 ainda nao aplicada
      return fetchHistoryTransactions(conditions, params, limitPlusOne);
    }
    throw e;
  }
}

// Itens das vendas (eventos purchase). LEFT JOIN products preserva produtos
// deletados; nome preferencial e o snapshot gravado na venda.
async function fetchHistoryItems(companyId, saleIds) {
  if (!saleIds.length) return {};
  const nameExpr = historySaleItemsHasSnapshot
    ? `COALESCE(NULLIF(TRIM(si.product_name_snapshot), ''), p.name, 'Produto removido')`
    : `COALESCE(p.name, 'Produto removido')`;
  try {
    const { rows } = await db.query(
      `SELECT si.sale_id,
              ${nameExpr} AS product_name,
              si.quantity, si.unit_price, si.total_price
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id AND s.company_id = $1
         LEFT JOIN products p ON p.id = si.product_id
        WHERE si.sale_id = ANY($2::uuid[])
        ORDER BY si.sale_id`,
      [companyId, saleIds]
    );
    const map = {};
    for (const r of rows) {
      (map[r.sale_id] = map[r.sale_id] || []).push({
        product_name: r.product_name,
        quantity:     parseFloat(r.quantity) || 0,
        unit_price:   parseFloat(r.unit_price) || 0,
        total:        parseFloat(r.total_price) || 0,
      });
    }
    return map;
  } catch (e) {
    if (e.code === '42703' && historySaleItemsHasSnapshot) {
      historySaleItemsHasSnapshot = false;
      return fetchHistoryItems(companyId, saleIds);
    }
    if (e.code === '42P01') return {}; // deployment parcial: timeline segue sem itens
    throw e;
  }
}

router.get('/customers/:cid/history', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  try {
    await assertCrediarioEnabled(companyId);

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 30;
    if (limit > 100) limit = 100;

    let cursor = null;
    if (req.query.cursor) {
      cursor = decodeHistoryCursor(req.query.cursor);
      if (!cursor) return res.status(400).json({ error: 'cursor invalido' });
    }

    let requestedTypes = null;
    if (req.query.types) {
      requestedTypes = String(req.query.types).split(',').map(s => s.trim()).filter(Boolean);
      const invalid = requestedTypes.filter(t => !HISTORY_EVENT_TYPES.includes(t));
      if (invalid.length) {
        return res.status(400).json({
          error: `types invalido(s): ${invalid.join(', ')}. Validos: ${HISTORY_EVENT_TYPES.join(', ')}`,
        });
      }
      if (!requestedTypes.length) requestedTypes = null;
    }

    const { rows: cust } = await db.query(
      `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
      [customerId, companyId]
    );
    if (!cust.length) return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });

    const conditions = ['t.company_id = $1', 't.customer_id = $2'];
    const params = [companyId, customerId];
    let i = 3;
    if (cursor) {
      conditions.push(`(t.created_at, t.id) < ($${i}::timestamptz, $${i + 1}::uuid)`);
      params.push(cursor.createdAt, cursor.id);
      i += 2;
    }
    if (requestedTypes) {
      conditions.push(`(${requestedTypes.map(t => HISTORY_TYPE_SQL[t]).join(' OR ')})`);
    }

    const rows = await fetchHistoryTransactions(conditions, params, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const purchaseSaleIds = [...new Set(
      page.filter(r => r.type === 'debit' && r.sale_id).map(r => r.sale_id)
    )];
    const itemsBySale = await fetchHistoryItems(companyId, purchaseSaleIds);

    const events = page.map(r => {
      const amount = parseFloat(r.amount) || 0;
      let eventType;
      if (r.type === 'debit') {
        eventType = r.sale_id ? 'purchase' : 'manual_debit';
      } else if (r.type === 'refund') {
        eventType = 'refund';
      } else {
        eventType = r.payment_method === 'crediario_credito' ? 'exchange_credit' : 'payment';
      }
      const meta = {};
      if (r.source !== undefined && r.source !== null) meta.source = r.source;
      if (r.notes) meta.notes = r.notes;
      return {
        id:          r.id,
        type:        eventType,
        occurred_at: r.created_at,
        amount:      r.type === 'debit' ? amount : parseFloat((-amount).toFixed(2)),
        sale_id:     r.sale_id || null,
        account_id:  r.account_id || null,
        items:       eventType === 'purchase' ? (itemsBySale[r.sale_id] || []) : null,
        payment:     eventType === 'payment' ? { method: r.payment_method || null } : null,
        meta,
      };
    });

    res.json({
      events,
      next_cursor: hasMore ? encodeHistoryCursor(page[page.length - 1]) : null,
    });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message, code: err.code });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[credit] history error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar historico do cliente' });
  }
});

// ============================================================
// B3 (11/06/2026): GET /customers/:cid/payments/preview
//
// Dry-run ZERO escrita. Retorna a distribuicao planejada para um
// pagamento de valor livre, usando o mesmo engine (computePaymentPlan)
// que o POST usa antes de chamar applyPayment.
//
// Query params:
//   amount     -- obrigatorio, > 0
//   account_id -- opcional, UUID do carne (escopo FIFO)
//   paid_at    -- opcional, YYYY-MM-DD < hoje (retroativo)
//
// Shape de resposta:
//   {
//     applied: [{ installment_id, account_id, number,
//                 charges_paid, principal_paid, status_after }],
//     new_balance: N,
//     credit_generated: N
//   }
// ============================================================
router.get('/customers/:cid/payments/preview', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;

  const amount = parseFloat(req.query.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount > 0 obrigatorio' });
  }
  const accountId = req.query.account_id || null;
  const paidAt    = normalizeBackdate(req.query.paid_at);

  try {
    await assertCrediarioEnabled(companyId);

    // Verifica cliente
    const { rows: custRows } = await db.query(
      `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
      [customerId, companyId]
    );
    if (!custRows.length) return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });

    // Saldo atual (read-only)
    let currentBalance = 0;
    try {
      const { rows: balRows } = await db.query(
        `SELECT COALESCE(balance, 0) AS balance FROM customer_credit_balances
         WHERE customer_id = $1 AND company_id = $2`,
        [customerId, companyId]
      );
      currentBalance = parseFloat(balRows[0]?.balance || 0);
    } catch (_) {}

    // Parcelas abertas (read-only), filtradas por account_id se fornecido.
    // Defensivo 42703 (account_id pode nao existir em deploy parcial).
    let openInstallments = [];
    try {
      let instQuery;
      let instParams;
      if (accountId) {
        instQuery = `
          SELECT id, installment_number, total_installments,
                 amount_due, covered_amount, due_date, status, account_id
            FROM credit_installments
           WHERE company_id = $1 AND customer_id = $2
             AND account_id = $3
             AND status IN ('pending', 'overdue')
           ORDER BY due_date ASC`;
        instParams = [companyId, customerId, accountId];
      } else {
        instQuery = `
          SELECT id, installment_number, total_installments,
                 amount_due, covered_amount, due_date, status, account_id
            FROM credit_installments
           WHERE company_id = $1 AND customer_id = $2
             AND status IN ('pending', 'overdue')
           ORDER BY due_date ASC`;
        instParams = [companyId, customerId];
      }
      const { rows } = await db.query(instQuery, instParams);
      openInstallments = rows;
    } catch (e) {
      if (e.code === '42703') {
        // account_id ainda nao existe: FIFO global sem filtro de carne
        const { rows } = await db.query(
          `SELECT id, installment_number, total_installments,
                  amount_due, covered_amount, due_date, status
             FROM credit_installments
            WHERE company_id = $1 AND customer_id = $2
              AND status IN ('pending', 'overdue')
            ORDER BY due_date ASC`,
          [companyId, customerId]
        );
        openInstallments = rows;
      } else if (e.code === '42P01') {
        openInstallments = [];
      } else throw e;
    }

    // Config + profile (defensivo, mesmo padrao do loadLateChargesContext)
    let lateConfig = undefined;
    let lateProfile = undefined;
    try {
      const cfg = await db.query(`SELECT * FROM credit_plan_configs WHERE company_id = $1`, [companyId]);
      lateConfig = cfg.rows[0] || undefined;
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }
    try {
      const prof = await db.query(
        `SELECT * FROM customer_credit_profiles WHERE company_id = $1 AND customer_id = $2`,
        [companyId, customerId]
      );
      lateProfile = prof.rows[0] || undefined;
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }

    const plan = computePaymentPlan(openInstallments, currentBalance, {
      amount,
      config:  lateConfig,
      profile: lateProfile,
      paidAt,
    });

    return res.json(plan);
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message, code: err.code });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[credit] payment preview error:', err.message);
    return res.status(500).json({ error: 'Erro ao calcular preview de pagamento' });
  }
});

// ============================================================
// B3 (11/06/2026): POST /customers/:cid/payments
//
// Aplica o pagamento de valor livre. Usa applyPayment (logica
// identica ao POST /customer/:cid/payment) e mapeia o retorno
// para o shape canonico B3 (mesmo do preview).
//
// Body: { amount, account_id?, method, paid_at? }
// Header opcional: Idempotency-Key (repassado ao applyPayment)
//
// Idempotencia: Idempotency-Key e repassada ao applyPayment como
// idempotencyKey. ON CONFLICT DO NOTHING garante que um retry de
// rede nao aplique o pagamento duas vezes.
//
// Overpay: nao e rejeitado. O excedente de principal (apos quitar
// todas as parcelas abertas) gera credit_generated > 0, que equivale
// a um saldo negativo no ledger (credito a favor do cliente).
//
// Shape de resposta (identico ao preview):
//   {
//     applied: [{ installment_id, account_id, number,
//                 charges_paid, principal_paid, status_after }],
//     new_balance: N,
//     credit_generated: N
//   }
// ============================================================
router.post('/customers/:cid/payments', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;

  const amount    = parseFloat(req.body?.amount || 0);
  const method    = req.body?.method ? String(req.body.method).trim() : null;
  const accountId = req.body?.account_id || null;
  const paidAt    = normalizeBackdate(req.body?.paid_at);
  // Idempotency-Key do header (case-insensitive)
  const idempotencyKey = req.headers['idempotency-key']
    ? String(req.headers['idempotency-key']).trim()
    : null;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount > 0 obrigatorio' });
  }

  try {
    await assertCrediarioEnabled(companyId);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica cliente
    const { rows: cust } = await client.query(
      `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
      [customerId, companyId]
    );
    if (!cust.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });
    }

    // Sessao de caixa aberta (best-effort)
    let activeSessaoId = null;
    try {
      const sessRes = await client.query(
        `SELECT id FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
        [companyId]
      );
      activeSessaoId = sessRes?.rows?.[0]?.id || null;
    } catch (_) {}

    // Config + profile (defensivo)
    const { config: lateConfig, profile: lateProfile } =
      await loadLateChargesContext(client, companyId, customerId);

    // Aplica o pagamento via applyPayment (logica canonica)
    const result = await creditLedger.applyPayment(client, {
      companyId,
      customerId,
      amount,
      method,
      sessaoId:      activeSessaoId,
      createdBy:     req.user?.id || null,
      paidAt,
      accountId,
      config:        lateConfig,
      profile:       lateProfile,
      idempotencyKey,
    });

    // Monta o shape canonico B3 a partir do resultado do applyPayment.
    //
    // Garantia preview === aplicacao:
    //   O applyPayment faz FIFO por due_date ASC (encargos primeiro, depois
    //   principal) identico ao computePaymentPlan. O mapeamento abaixo reconstroi
    //   o campo `applied` a partir de covered_installments (principal) e
    //   charges_detail (encargos), fundindo pelo installment_id.
    //
    // Estrutura interna do applyPayment:
    //   result.covered_installments: [{ id, covered, status }]
    //   result.charges_detail:       [{ installment_id, late_fee, late_interest }]
    //   result.legacy_amount:        excedente de principal (overpay)

    // Mapa de encargos por installment_id
    const chargesMap = {};
    for (const cd of (result.charges_detail || [])) {
      chargesMap[cd.installment_id] = cd;
    }

    // Mapa de covered por installment id
    const coveredMap = {};
    for (const ci of (result.covered_installments || [])) {
      coveredMap[ci.id] = ci;
    }

    // Uniao de installment_ids que aparecem em qualquer dos dois mapas
    const allInstIds = new Set([
      ...Object.keys(chargesMap),
      ...Object.keys(coveredMap),
    ]);

    // Para montar number e account_id precisamos de um mini-lookup.
    // M6 fix (13/06): SELECT via client.query DENTRO da transacao (antes do
    // COMMIT) -- evita 500 pos-commit quando qualquer erro diferente de
    // 42703/42P01 ocorre na busca (pagamento ja commitado mas cliente recebia 500).
    let instMeta = {};
    if (allInstIds.size > 0) {
      try {
        const { rows: metaRows } = await client.query(
          `SELECT id, installment_number, account_id
             FROM credit_installments
            WHERE id = ANY($1::uuid[]) AND company_id = $2`,
          [[...allInstIds], companyId]
        );
        for (const r of metaRows) {
          instMeta[r.id] = { number: r.installment_number, account_id: r.account_id || null };
        }
      } catch (e) {
        if (e.code !== '42703' && e.code !== '42P01') throw e;
        // Defensivo: sem metadados de parcela, campos ficam null
      }
    }

    await client.query('COMMIT');

    const applied = [...allInstIds].map(instId => {
      const cd  = chargesMap[instId]  || {};
      const ci  = coveredMap[instId]  || {};
      const meta = instMeta[instId]   || {};
      const chargesPaid  = creditLedger.round2((cd.late_fee || 0) + (cd.late_interest || 0));
      const principalPaid = creditLedger.round2(ci.covered || 0);
      return {
        installment_id: instId,
        account_id:     meta.account_id || null,
        number:         meta.number || null,
        charges_paid:   chargesPaid,
        principal_paid: principalPaid,
        status_after:   ci.status || null,
      };
    });

    // credit_generated = excedente de principal (legacy_amount)
    const creditGenerated = creditLedger.round2(result.legacy_amount || 0);

    return res.status(201).json({
      applied,
      new_balance:      result.new_balance,
      credit_generated: creditGenerated,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[credit] payments post error:', err.message);
    return res.status(500).json({ error: 'Erro ao registrar pagamento' });
  } finally {
    client.release();
  }
});

// ============================================================
// Incidente Valen (13/08/2026): /manual-entry cria a divida inteira num loop
// sequencial de INSERTs (ate 100 parcelas), sem protecao de idempotencia.
// Um timeout de rede no cliente NAO interrompe a transacao no servidor -- ela
// segue rodando e comita normalmente. O usuario, ve a mensagem de timeout e
// tenta de novo, e cada retry cria uma conta+parcelas NOVAS e completas
// (5 duplicatas de R$25.000 em producao). Fix: mesmo padrao de
// Idempotency-Key + UNIQUE(idempotency_key) ja usado em /payment e
// /customers/:cid/payments (creditLedger.applyPayment).
//
// buildManualEntryReplay: dado uma Idempotency-Key ja processada, remonta a
// resposta original (customer/transaction/installments/new_balance) para
// devolver ao cliente em vez de duplicar o lancamento.
// ============================================================
async function buildManualEntryReplay(companyId, tx) {
  const { rows: custRows } = await db.query(
    `SELECT id, name FROM customers WHERE id = $1 AND company_id = $2`,
    [tx.customer_id, companyId]
  );
  const { rows: instRows } = await db.query(
    `SELECT * FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2 AND sale_id IS NULL
        AND account_id IS NOT DISTINCT FROM $3
      ORDER BY installment_number ASC`,
    [companyId, tx.customer_id, tx.account_id || null]
  );
  const { rows: balRows } = await db.query(
    `SELECT balance FROM customer_credit_balances WHERE customer_id = $1 AND company_id = $2`,
    [tx.customer_id, companyId]
  );
  return {
    replay: true,
    customer: custRows[0] || { id: tx.customer_id },
    transaction: { ...tx, amount: parseFloat(tx.amount) },
    account_id: tx.account_id || null,
    installments: instRows.map(r => ({
      ...r,
      amount_due:     parseFloat(r.amount_due),
      covered_amount: parseFloat(r.covered_amount || 0),
    })),
    new_balance: parseFloat(balRows[0]?.balance || 0),
  };
}

// POST /manual-entry
// F3: aceita account_id (anexa ao carne) OU new_account_name (cria carne e usa).
// F2: se carne tem terms_snapshot, usa como defaults de juros/periodicidade.
// 05/06/2026: aceita entry_date e period_unit/period_count.
// B2: pix_link fica NULL (link fake aposentado); Pix real e on-demand.
// 13/08/2026: aceita header Idempotency-Key -- retry de rede (timeout do
// cliente com a tx ja commitada no servidor) devolve o lancamento ja criado
// em vez de duplicar conta+parcelas. Ver buildManualEntryReplay acima.
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
  const idempotencyKey = req.headers['idempotency-key']
    ? String(req.headers['idempotency-key']).trim()
    : null;

  if (!total || total <= 0)
    return res.status(400).json({ error: 'amount invalido' });
  if (n < 1 || n > 100)
    return res.status(400).json({ error: 'installments deve ser entre 1 e 100' });
  if (!customer_id && !new_customer?.name)
    return res.status(400).json({ error: 'Informe customer_id ou new_customer.name' });
  if (!customer_id && !new_customer?.phone)
    return res.status(400).json({ error: 'Telefone do cliente e obrigatorio' });

  try {
    await assertCrediarioEnabled(companyId);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }

  // Replay check ANTES de qualquer escrita: se essa Idempotency-Key ja foi
  // processada com sucesso (o response original pode ter se perdido no
  // cliente por timeout), devolve o resultado existente em vez de duplicar.
  if (idempotencyKey) {
    try {
      const { rows: existingTx } = await db.query(
        `SELECT id, customer_id, account_id, amount, notes, created_at
           FROM customer_credit_transactions
          WHERE company_id = $1 AND idempotency_key = $2
          LIMIT 1`,
        [companyId, idempotencyKey]
      );
      if (existingTx.length) {
        return res.status(200).json(await buildManualEntryReplay(companyId, existingTx[0]));
      }
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
      // coluna/indice idempotency_key ainda nao existe (deploy parcial) -- segue sem protecao
    }
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
    // 13/08/2026: idempotency_key + ON CONFLICT DO NOTHING -- se outra
    // requisicao com a MESMA key venceu a corrida entre o check acima e este
    // INSERT (ex.: 2 retries quase simultaneos), aborta esta tx sem criar
    // conta/parcelas duplicadas e devolve o resultado da que ja foi processada.
    const notes = description ? String(description).trim() : 'Lancamento manual';
    let transaction;
    try {
      const { rows: txRows } = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, type, amount, notes, source, created_by, created_at, account_id, idempotency_key)
         VALUES ($1, $2, 'debit', $3, $4, 'manual', $5,
                 COALESCE(($6::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo', NOW()), $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [companyId, custId, total, notes, req.user?.id || null, entryDate, resolvedAccountId, idempotencyKey]
      );
      if (!txRows.length) {
        await client.query('ROLLBACK');
        const { rows: winnerTx } = await db.query(
          `SELECT id, customer_id, account_id, amount, notes, created_at
             FROM customer_credit_transactions
            WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [companyId, idempotencyKey]
        );
        if (winnerTx.length) {
          return res.status(200).json(await buildManualEntryReplay(companyId, winnerTx[0]));
        }
        return res.status(409).json({ error: 'Requisicao duplicada em processamento simultaneo -- tente novamente' });
      }
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

    // 13/08/2026 (feedback Caio): juros total FLAT sobre o valor do lancamento,
    // independente do numero de parcelas -- ANTES multiplicava por n (juros
    // linear por parcela), o que fazia o juros total escalar com o parcelamento
    // e confundia o lojista/cliente (ex: 10% em 10x cobrava 100% de juros).
    // Agora: total_com_juros = valor * (1 + taxa), sempre, seja 1x ou 50x.
    const totalWithInterest = effectiveRate > 0
      ? parseFloat((total * (1 + effectiveRate)).toFixed(2))
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
          [companyId, custId, i, n, instAmount, dueDateStr, null, resolvedAccountId]
        );
        row = ins.rows[0];
      } catch (e) {
        if (e.code === '42703') {
          const ins = await client.query(
            `INSERT INTO credit_installments
               (company_id, sale_id, customer_id, installment_number, total_installments,
                amount_due, due_date, status, pix_link, covered_amount)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', $7, 0) RETURNING *`,
            [companyId, custId, i, n, instAmount, dueDateStr, null]
          );
          row = ins.rows[0];
        } else throw e;
      }
      // B2: sem pix_link fake -- o campo fica NULL; o Pix real (EMV copia-e-cola)
      // e gerado on-demand via GET /credit/installments/:iid/pix.
      createdInstallments.push(row);
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
