// ============================================================
// AURA -- Crediario: devolve ao FIFO a cobertura de parcelas canceladas.
//
// tq-21 (18/10/2026, achado do t3-08 / Aura-backend#858): cancelCreditSale
// cancelava as parcelas da venda com covered_amount = 0 e o dinheiro que
// estava nelas sumia das parcelas -- mas o pagamento continua no razao. O
// saldo do cliente caia (o debito da venda sai) e as parcelas abertas das
// OUTRAS compras seguiam cobrando o valor cheio: parcelas > razao.
//
// Regra (a mesma do applyPayment e do undoManualEntry):
//   1. A cobertura liberada cobre as demais parcelas abertas do cliente, da
//      que vence primeiro para a ultima (FIFO global: o razao e por cliente).
//   2. TETO: so ate onde as parcelas abertas passam do saldo do razao. Se o
//      cliente tem divida sem parcela (fiado 1x, venda sem data), o pagamento
//      e dela -- cobrir parcela de outra compra abriria a divergencia ao
//      contrario. O que nao cabe fica como credito no razao, que e o que a
//      view customer_credit_balances ja diz.
//   3. A distribuicao gravada (credit_payment_allocations, migration 335)
//      acompanha o dinheiro: a parte que muda de parcela sai da linha da
//      parcela cancelada e entra na linha da parcela nova, do MESMO
//      pagamento. Assim "Desfazer recebimento" depois continua tirando o
//      dinheiro de onde ele esta, e o total do pagamento nao muda.
//
// Limitacao conhecida (a mesma do #858): parcela orfa antiga (sem debito no
// razao) nao e distinguivel de forma barata e segura das parcelas legitimas
// sem vinculo, entao o FIFO nao a pula. O teto limita o efeito.
// ============================================================
'use strict';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.005;

// Quanto as parcelas abertas do cliente passam do saldo do razao.
async function openExcess(client, companyId, customerId) {
  const { rows } = await client.query(
    `SELECT COALESCE((SELECT SUM(GREATEST(amount_due - COALESCE(covered_amount, 0), 0))
                        FROM credit_installments
                       WHERE company_id = $1 AND customer_id = $2
                         AND status IN ('pending', 'overdue')), 0)
          - COALESCE((SELECT balance FROM customer_credit_balances
                       WHERE company_id = $1 AND customer_id = $2), 0) AS excess`,
    [companyId, customerId]
  );
  return round2(parseFloat(rows && rows[0] && rows[0].excess) || 0);
}

// De qual pagamento veio cada real liberado. Linhas da distribuicao primeiro
// (mais antigas antes), limitadas ao que a parcela ainda tinha; o resto
// (cobertura anterior a 335, ou realocada sem distribuicao) vai sem pagamento.
async function sourcesOf(client, companyId, released) {
  let allocs = [];
  try {
    const { rows } = await client.query(
      `SELECT transaction_id, installment_id, principal_paid
         FROM credit_payment_allocations
        WHERE company_id = $1 AND installment_id = ANY($2::uuid[])
        ORDER BY created_at ASC, id ASC
        FOR UPDATE`,
      [companyId, released.map((r) => r.installment_id)]
    );
    allocs = rows || [];
  } catch (err) {
    if (err.code !== '42P01') throw err; // tabela ausente = sem distribuicao
  }

  const chunks = [];
  for (const r of released) {
    let left = round2(r.covered);
    for (const a of allocs) {
      if (left <= EPS) break;
      if (a.installment_id !== r.installment_id) continue;
      const take = round2(Math.min(left, Number(a.principal_paid) || 0));
      if (take <= EPS) continue;
      chunks.push({ txId: a.transaction_id, from: r.installment_id, amount: take });
      left = round2(left - take);
    }
    if (left > EPS) chunks.push({ txId: null, from: r.installment_id, amount: left });
  }
  return chunks;
}

/**
 * Devolve ao FIFO a cobertura de parcelas que acabaram de ser canceladas.
 * Roda DENTRO da transacao do chamador, DEPOIS de cancelar as parcelas e de
 * mexer no razao (o teto le o saldo ja atualizado).
 *
 * @param released [{ installment_id, covered }] -- cobertura que cada parcela
 *                 cancelada tinha antes de zerar.
 * @returns { released, reallocated, credit_left, covered_installments }
 */
async function returnReleasedCoverage(client, { companyId, customerId, released }) {
  const list = (released || [])
    .map((r) => ({ installment_id: r.installment_id, covered: round2(r.covered) }))
    .filter((r) => r.installment_id && r.covered > EPS);
  const total = round2(list.reduce((s, r) => s + r.covered, 0));
  const out = { released: total, reallocated: 0, credit_left: total, covered_installments: [] };
  if (!customerId || total <= EPS) return out;

  const cap = round2(Math.min(total, Math.max(0, await openExcess(client, companyId, customerId))));
  if (cap <= EPS) return out;

  const { rows: targets } = await client.query(
    `SELECT id, amount_due, covered_amount, status
       FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2
        AND status IN ('pending', 'overdue')
      ORDER BY due_date ASC, installment_number ASC
      FOR UPDATE`,
    [companyId, customerId]
  );

  const chunks = await sourcesOf(client, companyId, list);
  let budget = cap;
  let ci = 0;
  const moves = []; // { txId, from, to, amount, statusAfter }

  for (const t of targets || []) {
    if (budget <= EPS || ci >= chunks.length) break;
    const due     = Number(t.amount_due) || 0;
    let covered   = Number(t.covered_amount) || 0;
    let uncovered = round2(due - covered);
    if (uncovered <= EPS) continue;

    const startCovered = covered;
    const pieces = [];
    while (uncovered > EPS && budget > EPS && ci < chunks.length) {
      const ch   = chunks[ci];
      const take = round2(Math.min(uncovered, budget, ch.amount));
      if (take > EPS) {
        pieces.push({ txId: ch.txId, from: ch.from, amount: take });
        covered   = round2(covered + take);
        uncovered = round2(uncovered - take);
        budget    = round2(budget - take);
        ch.amount = round2(ch.amount - take);
      }
      if (ch.amount <= EPS) ci += 1;
    }
    if (!pieces.length) continue;

    const paid = covered >= due - EPS;
    const statusAfter = paid ? 'paid' : t.status;
    await client.query(
      `UPDATE credit_installments
          SET covered_amount = $3,
              status         = $4,
              paid_at        = CASE WHEN $5 THEN NOW() ELSE paid_at END,
              updated_at     = NOW()
        WHERE id = $1 AND company_id = $2`,
      [t.id, companyId, covered, statusAfter, paid]
    );
    out.covered_installments.push({ id: t.id, covered: round2(covered - startCovered), status: statusAfter });
    for (const p of pieces) moves.push({ ...p, to: t.id, statusAfter });
  }

  out.reallocated = round2(cap - budget);
  out.credit_left = round2(total - out.reallocated);

  // A distribuicao acompanha o dinheiro (so o que tem pagamento de origem).
  const tracked = moves.filter((m) => m.txId);
  if (tracked.length) {
    const tx   = tracked.map((m) => m.txId);
    const from = tracked.map((m) => m.from);
    const to   = tracked.map((m) => m.to);
    const amt  = tracked.map((m) => m.amount);
    const st   = tracked.map((m) => m.statusAfter);
    await client.query(
      `UPDATE credit_payment_allocations a
          SET principal_paid = GREATEST(0, a.principal_paid - x.amount)
         FROM (SELECT transaction_id, installment_id, SUM(amount) AS amount
                 FROM unnest($2::uuid[], $3::uuid[], $4::numeric[])
                      AS u(transaction_id, installment_id, amount)
                GROUP BY transaction_id, installment_id) x
        WHERE a.company_id = $1
          AND a.transaction_id = x.transaction_id
          AND a.installment_id = x.installment_id`,
      [companyId, tx, from, amt]
    );
    await client.query(
      `DELETE FROM credit_payment_allocations
        WHERE company_id = $1 AND installment_id = ANY($2::uuid[])
          AND principal_paid <= 0.005 AND COALESCE(charges_paid, 0) <= 0.005`,
      [companyId, [...new Set(from)]]
    );
    await client.query(
      `INSERT INTO credit_payment_allocations
         (company_id, transaction_id, installment_id, principal_paid, charges_paid, status_after)
       SELECT $1, x.transaction_id, x.installment_id, SUM(x.amount), 0, MAX(x.status_after)
         FROM unnest($2::uuid[], $3::uuid[], $4::numeric[], $5::text[])
              AS x(transaction_id, installment_id, amount, status_after)
        GROUP BY x.transaction_id, x.installment_id
       ON CONFLICT (transaction_id, installment_id) DO UPDATE
         SET principal_paid = credit_payment_allocations.principal_paid + EXCLUDED.principal_paid,
             status_after   = EXCLUDED.status_after`,
      [companyId, tx, to, amt, st]
    );
  }

  if (out.covered_installments.some((c) => c.status === 'paid')) {
    await require('./score')._recalculateScore(client, companyId, customerId);
  }
  return out;
}

module.exports = { returnReleasedCoverage, openExcess };
