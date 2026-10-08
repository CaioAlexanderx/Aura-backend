// ============================================================
// AURA -- Crediario: desfazer um RECEBIMENTO registrado em duplicidade.
//
// Caso Valen / jackson ICL (07/10/2026): o pagamento de R$260 foi lancado
// duas vezes e a segunda linha teve de ser revertida por SQL a mao -- parcela,
// Financeiro, sale_payments e credit_used, um a um. Em 90 dias havia 19 pares
// identicos (mesmo cliente, valor e minuto) em producao.
//
// Decisao de produto: PERDAO em vez de bloqueio. Receber parcela a parcela do
// mesmo valor e uso legitimo, entao o segundo recebimento igual nao e barrado;
// o lojista desfaz quando percebe.
//
// O que este modulo garante, dentro de UMA transacao do chamador:
//   1. So type='payment' com payment_method <> 'crediario_credito' (o credito
//      de troca tem outros efeitos). SEM PRAZO por padrao (08/10/2026, Looks
//      da Jenny): a janela de 24h contava de created_at, que no pagamento
//      retroativo e a data INFORMADA -- um recebimento lancado hoje com data
//      de tres dias atras ja nascia fora da janela, e erro de balcao so e
//      visto dias depois. `windowHours` continua aceito por quem quiser prazo.
//   2. Cada parcela da distribuicao (credit_payment_allocations, migration 335)
//      devolve o principal que este pagamento pos nela: covered_amount volta,
//      'paid' reabre como 'pending' (ou 'overdue' pela regra unica de
//      services/credit/overdue.js) e paid_at zera se foi ESTE pagamento que
//      quitou. Sem distribuicao gravada (pagamento anterior a migration 335)
//      nao se adivinha: 409 PAYMENT_WITHOUT_ALLOCATIONS.
//   3. Encargos: late_fee/late_interest estampados saem da parcela e a linha
//      'credit-charges-<txid>' sai do Financeiro.
//   4. Financeiro: os recebiveis que o FIFO deste pagamento liquidou (paid_at
//      igual ao instante do pagamento) voltam a 'A Receber'; a linha '-rest-'
//      de um pagamento parcial e reabsorvida pela original; a sobra
//      'credit-payment-<txid>-legacy' e apagada; os sale_payments gravados no
//      mesmo instante para essas vendas saem do caixa.
//   5. So entao o pagamento sai do razao (a distribuicao sai por CASCADE),
//      credit_used e score sao recalculados.
// ============================================================
'use strict';

const { overdueSql, signalGraceDays } = require('./overdue');
const { _recalculateScore } = require('./score');

/**
 * Janela (horas) para quem pedir prazo explicitamente via `windowHours`.
 * O padrao do undoPayment e SEM prazo (ver o cabecalho).
 */
const UNDO_WINDOW_HOURS = 24;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function httpError(message, status, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

async function loadPlanConfig(client, companyId) {
  try {
    const { rows } = await client.query(
      `SELECT late_charges_enabled, late_grace_days FROM credit_plan_configs WHERE company_id = $1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return null;
    throw err;
  }
}

// ---------------------------------------------------------------
// Parcelas: devolve o principal e os encargos que este pagamento pos nelas.
// Retorna { reopened, saleIds }.
// ---------------------------------------------------------------
async function revertInstallments(client, companyId, tx, allocations, config) {
  const reopened = [];
  const saleIds  = new Set();

  for (const a of allocations) {
    const principal = round2(a.principal_paid);
    const charges   = round2(a.charges_paid);
    if (a.sale_id) saleIds.add(a.sale_id);

    const covered    = round2(a.covered_amount);
    const amountDue  = round2(a.amount_due);
    const newCovered = round2(Math.max(0, covered - principal));
    const reopens    = a.status === 'paid' && newCovered < amountDue - 0.005;
    const quitadaPorEste = a.status_after === 'paid';

    await client.query(
      `UPDATE credit_installments
          SET covered_amount = $3,
              status         = CASE WHEN $4 THEN 'pending' ELSE status END,
              paid_at        = CASE WHEN $5 THEN NULL ELSE paid_at END,
              updated_at     = NOW()
        WHERE id = $1 AND company_id = $2`,
      [a.installment_id, companyId, newCovered, reopens, quitadaPorEste]
    );
    if (reopens) reopened.push(a.installment_id);

    if (charges > 0.005) {
      // applyPayment estampa multa primeiro e mora com o resto; a volta tira
      // a mora primeiro e a multa com o que faltar. Colunas podem nao existir
      // num deploy parcial (42703): o total do encargo ja saiu do Financeiro.
      try {
        await client.query(
          `UPDATE credit_installments
              SET late_interest = GREATEST(0, COALESCE(late_interest, 0) - LEAST($3, COALESCE(late_interest, 0))),
                  late_fee      = GREATEST(0, COALESCE(late_fee, 0)
                                    - ($3 - LEAST($3, COALESCE(late_interest, 0)))),
                  updated_at    = NOW()
            WHERE id = $1 AND company_id = $2`,
          [a.installment_id, companyId, charges]
        );
      } catch (err) {
        if (err.code !== '42703') throw err;
      }
    }
  }

  // Regra unica de atraso: parcela reaberta ja vencida volta como 'overdue',
  // nao como 'pending' congelado.
  if (reopened.length) {
    await client.query(
      `UPDATE credit_installments
          SET status = 'overdue', updated_at = NOW()
        WHERE id = ANY($1) AND company_id = $2
          AND ${overdueSql({ graceDays: signalGraceDays(config) })}`,
      [reopened, companyId]
    );
  }

  return { reopened, saleIds };
}

// ---------------------------------------------------------------
// Financeiro: recebiveis que o FIFO deste pagamento liquidou voltam a
// 'A Receber'. O instante e comparado em SQL contra a linha do pagamento
// ($2): o Date do node-pg perde o microssegundo do timestamptz.
// Retorna { reverted, saleIds }.
// ---------------------------------------------------------------
async function revertReceivables(client, companyId, tx, principalTotal) {
  const { rows } = await client.query(
    `SELECT t.id, t.amount, t.category, t.idempotency_key, s.id AS sale_id
       FROM transactions t
       JOIN customer_credit_transactions p ON p.id = $2
       JOIN sales s ON t.idempotency_key LIKE 'pdv-credit-receivable-' || s.id::text || '%'
      WHERE t.company_id = $1
        AND t.status = 'confirmed'
        AND t.category IN ('Crediario - Recebido', 'Crediario - Recebido (parcial)')
        AND t.paid_at = p.created_at
        AND s.customer_id = p.customer_id
      ORDER BY t.updated_at DESC, t.idempotency_key DESC
      FOR UPDATE OF t`,
    [companyId, tx.id]
  );

  // Dois recebimentos retroativos para o mesmo dia compartilham o instante
  // (meio-dia SP). O que este pagamento liquidou soma exatamente o principal
  // dele; nao se desfaz mais do que isso.
  let budget = round2(principalTotal);
  const reverted = [];
  const saleIds  = new Set();

  for (const t of rows) {
    const amt = round2(t.amount);
    if (amt > budget + 0.005) continue;

    let restored = amt;
    if (t.category === 'Crediario - Recebido (parcial)') {
      // A sobra do pagamento parcial e reabsorvida pela linha original.
      const { rows: rest } = await client.query(
        `DELETE FROM transactions
          WHERE company_id = $1
            AND idempotency_key LIKE $2
            AND status = 'pending'
            AND id = (
              SELECT id FROM transactions
               WHERE company_id = $1 AND idempotency_key LIKE $2 AND status = 'pending'
               ORDER BY created_at DESC LIMIT 1
            )
          RETURNING amount`,
        [companyId, t.idempotency_key + '-rest-%']
      );
      if (rest.length) restored = round2(amt + Number(rest[0].amount));
    }

    await client.query(
      `UPDATE transactions
          SET status = 'pending', category = 'Crediario - A Receber',
              paid_at = NULL, payment_method = NULL, amount = $3, updated_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [t.id, companyId, restored]
    );

    reverted.push(t.id);
    saleIds.add(t.sale_id);
    budget = round2(budget - amt);
  }

  return { reverted, saleIds };
}

// ---------------------------------------------------------------
// undoPayment -- DENTRO de uma transacao do chamador.
// ---------------------------------------------------------------
async function undoPayment(client, { companyId, transactionId, windowHours = null }) {
  const hours = Number(windowHours);
  const comPrazo = windowHours !== null && windowHours !== undefined && Number.isFinite(hours) && hours > 0;
  const { rows: txRows } = await client.query(
    `SELECT id, customer_id, type, amount, payment_method, created_at,
            ($4::boolean AND created_at < NOW() - ($3::int * interval '1 hour')) AS too_old
       FROM customer_credit_transactions
      WHERE id = $1 AND company_id = $2
      FOR UPDATE`,
    [transactionId, companyId, comPrazo ? Math.floor(hours) : 0, comPrazo]
  );
  if (!txRows.length) {
    throw httpError('Recebimento nao encontrado', 404, 'NOT_FOUND');
  }
  const tx = txRows[0];

  if (tx.type !== 'payment') {
    throw httpError('So um recebimento pode ser desfeito por aqui.', 409, 'NOT_PAYMENT');
  }
  if (tx.payment_method === 'crediario_credito') {
    throw httpError(
      'Este lancamento e credito de troca, nao um recebimento. Cancele a troca no PDV.',
      409, 'EXCHANGE_CREDIT'
    );
  }
  if (tx.too_old) {
    throw httpError(
      `So e possivel desfazer um recebimento feito nas ultimas ${windowHours} horas.`,
      409, 'PAYMENT_TOO_OLD'
    );
  }

  // Distribuicao gravada pelo applyPayment (migration 335). Tabela ausente
  // num deploy parcial (42P01) equivale a "sem distribuicao".
  let allocations = [];
  try {
    const { rows } = await client.query(
      `SELECT a.installment_id, a.principal_paid, a.charges_paid, a.status_after,
              i.amount_due, i.covered_amount, i.status, i.sale_id
         FROM credit_payment_allocations a
         JOIN credit_installments i ON i.id = a.installment_id
        WHERE a.transaction_id = $1 AND a.company_id = $2
        ORDER BY i.due_date ASC, i.installment_number ASC
        FOR UPDATE OF i`,
      [tx.id, companyId]
    );
    allocations = rows;
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  if (!allocations.length) {
    throw httpError(
      'Este recebimento nao tem a distribuicao por parcela gravada e nao pode ser desfeito automaticamente.',
      409, 'PAYMENT_WITHOUT_ALLOCATIONS'
    );
  }

  const config = await loadPlanConfig(client, companyId);
  const principalTotal = round2(allocations.reduce((s, a) => s + (Number(a.principal_paid) || 0), 0));
  const chargesTotal   = round2(allocations.reduce((s, a) => s + (Number(a.charges_paid) || 0), 0));

  const inst = await revertInstallments(client, companyId, tx, allocations, config);
  const rec  = await revertReceivables(client, companyId, tx, principalTotal);

  let financeiroReverted = rec.reverted.length;

  // Sobra que nao achou recebivel (legado) e a linha de encargos.
  const keys = ['credit-payment-' + tx.id + '-legacy'];
  if (chargesTotal > 0.005) keys.push('credit-charges-' + tx.id);
  const { rowCount: deletedLines } = await client.query(
    `DELETE FROM transactions WHERE company_id = $1 AND idempotency_key = ANY($2)`,
    [companyId, keys]
  );
  financeiroReverted += deletedLines || 0;

  // Caixa: o dinheiro que este pagamento registrou nessas vendas, no mesmo
  // instante (principal dos recebiveis e encargos das parcelas).
  const saleIds = [...new Set([...inst.saleIds, ...rec.saleIds])];
  if (saleIds.length) {
    await client.query(
      `DELETE FROM sale_payments sp
        USING customer_credit_transactions p
        WHERE p.id = $2
          AND sp.company_id = $1
          AND sp.sale_id = ANY($3)
          AND sp.created_at = p.created_at`,
      [companyId, tx.id, saleIds]
    );
  }

  // Razao: o pagamento sai; credit_payment_allocations vai por CASCADE.
  await client.query(
    `DELETE FROM customer_credit_transactions WHERE id = $1 AND company_id = $2`,
    [tx.id, companyId]
  );

  // Lazy: ledger.js abre o pool do config no require; aqui so precisamos do
  // recalculo de credit_used (a mesma funcao que o applyPayment usa).
  await require('./ledger')._updateCreditUsed(client, companyId, tx.customer_id);
  await _recalculateScore(client, companyId, tx.customer_id);

  const { rows: bal } = await client.query(
    `SELECT balance FROM customer_credit_balances
      WHERE customer_id = $1 AND company_id = $2`,
    [tx.customer_id, companyId]
  );

  return {
    undone:                true,
    customer_id:           tx.customer_id,
    new_balance:           parseFloat(bal[0]?.balance || 0),
    installments_reopened: inst.reopened.length,
    financeiro_reverted:   financeiroReverted,
  };
}

module.exports = { undoPayment, UNDO_WINDOW_HOURS };
