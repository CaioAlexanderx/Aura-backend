// =============================================================
// AURA. -- Credito: nucleo do ledger (venda, pagamento, cancelamento, preview).
// Extraido de creditLedger.js (refactor 11/06/2026, sem mudanca de comportamento).
// =============================================================

const pool = require('../../config/database');
const { resolvePeriod, dueDateForIndex, resolveTerms, round2 } = require('./terms');
const { computeLateCharges } = require('./lateCharges');
const { scoreLabel, scoreWarning, _recalculateScore } = require('./score');
const { computeUnifyPlan } = require('./unify');

const SP_DATE_NOW = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

// Expr SQL p/ backdate: converte o param (YYYY-MM-DD) num timestamptz ao
// meio-dia em America/Sao_Paulo. Se o param for NULL, cai em NOW().
const BACKDATE_TS = (p) =>
  `COALESCE((${p}::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo', NOW())`;

async function _getOrCreateProfile(client, companyId, customerId) {
  try {
    const r = await client.query(
      `INSERT INTO customer_credit_profiles
         (company_id, customer_id, credit_limit, credit_score, status)
       VALUES ($1, $2, 0, 500, 'active')
       ON CONFLICT (company_id, customer_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [companyId, customerId]
    );
    return r.rows[0] || null;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return null;
    throw err;
  }
}

async function _getOrCreatePlanConfig(client, companyId) {
  try {
    const r = await client.query(
      `INSERT INTO credit_plan_configs (company_id)
       VALUES ($1)
       ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [companyId]
    );
    return r.rows[0] || null;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return null;
    throw err;
  }
}

async function _updateCreditUsed(client, companyId, customerId) {
  try {
    await client.query(
      `UPDATE customer_credit_profiles
         SET credit_used = COALESCE((
           SELECT GREATEST(0, balance)
           FROM customer_credit_balances
           WHERE company_id = $1 AND customer_id = $2
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

async function createCreditSale(client, {
  companyId, customerId, saleId, amount,
  installments = 1, firstDueDate = null,
  interestRate = 0, productNames = [], createdBy = null,
  periodUnit = null, periodCount = null,
  accountId = null,
}) {
  // 0. Bloqueio manual (UNICO impeditivo) + aviso de score (NAO-impeditivo).
  //    Carrega profile/config de forma defensiva (tabela/coluna podem faltar
  //    em deploy parcial -- nesse caso seguimos sem bloqueio nem aviso).
  let _profile = null;
  let _config  = null;
  try {
    _profile = await _getOrCreateProfile(client, companyId, customerId);
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  if (_profile?.status === 'blocked') {
    const err = new Error(
      `Cliente com credito bloqueado. Motivo: ${_profile.blocked_reason || 'Bloqueio manual'}.`
    );
    err.statusCode = 422;
    err.code       = 'CUSTOMER_BLOCKED';
    err.reason     = _profile.blocked_reason || 'Bloqueio manual';
    throw err;
  }
  try {
    _config = await _getOrCreatePlanConfig(client, companyId);
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  const _warn = scoreWarning(parseInt(_profile?.credit_score, 10) || 500, _config);
  // Score NUNCA bloqueia: apenas anexa aviso ao retorno de sucesso.
  const warnings = _warn
    ? [{ code: 'SCORE_BELOW_MIN', threshold: _warn.threshold, actual: _warn.actual }]
    : [];

  // 1. Ledger: debit (com account_id defensivo)
  let debitRows;
  try {
    const r = await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, sale_id, type, amount, notes, created_by, account_id)
       VALUES ($1, $2, $3, 'debit', $4, $5, $6, $7)
       RETURNING *`,
      [
        companyId, customerId, saleId, amount,
        `Venda no crediario (${productNames.slice(0, 2).join(', ') || 'Venda'})`,
        createdBy, accountId,
      ]
    );
    debitRows = r.rows;
  } catch (err) {
    if (err.code === '42703') {
      // account_id ainda nao existe (deploy parcial) -- fallback sem coluna
      const r = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, sale_id, type, amount, notes, created_by)
         VALUES ($1, $2, $3, 'debit', $4, $5, $6)
         RETURNING *`,
        [companyId, customerId, saleId, amount,
          `Venda no crediario (${productNames.slice(0, 2).join(', ') || 'Venda'})`,
          createdBy]
      );
      debitRows = r.rows;
    } else throw err;
  }

  // 2. Financeiro: A Receber pending
  //
  // 17/08/2026: o due_date era SEMPRE ${SP_DATE_NOW} -- o A Receber nascia
  // vencendo HOJE, mesmo quando a venda combinava um vencimento futuro. Quem
  // olhasse "A Receber vencido" via a linha estourada no mesmo dia da venda.
  // Agora, quando o caller informa `firstDueDate`, ela manda. Sem ela o
  // comportamento antigo fica intacto.
  const arDueExpr = firstDueDate ? '$6::date' : SP_DATE_NOW;
  const arParams = [
    companyId, amount,
    `Crediario - venda ${saleId}`,
    createdBy,
    'pdv-credit-receivable-' + saleId,
  ];
  if (firstDueDate) arParams.push(firstDueDate);
  await client.query(
    `INSERT INTO transactions
       (company_id, type, status, amount, description, category,
        due_date, paid_at, created_by, idempotency_key)
     VALUES ($1, 'income', 'pending', $2, $3, 'Crediario - A Receber',
             ${arDueExpr}, NULL, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    arParams
  );

  // 3. Agenda de parcelas
  //
  // 17/08/2026: o bloco era `if (installments > 1)` -- uma venda 1x NAO
  // gerava nenhuma linha em credit_installments. Sem parcela nao existe
  // due_date, nem Pix da parcela (GET /credit/installments/:iid/pix), nem
  // regua de cobranca, nem inadimplencia: o saldo virava um A Receber solto.
  //
  // Agora 1x TAMBEM gera a parcela, mas SO quando o caller informa
  // `firstDueDate` explicitamente. O gate e deliberado: preserva o
  // comportamento do PDV do Negocio (venda 1x no crediario, sem data
  // combinada, continua sem parcela e sem mexer em relatorio/teste existente)
  // e atende quem pede vencimento -- a venda com sinal do Studio.
  const nRequested = Math.max(1, parseInt(installments, 10) || 1);
  const schedule = [];
  if (nRequested > 1 || firstDueDate) {
    // Hub F1.4: reusa profile/config ja carregados no topo (evita queries duplicadas).
    const config = _config;

    // F3: se accountId aponta para um carne com terms_snapshot, usar como defaults
    let accountTerms = null;
    if (accountId) {
      try {
        const { rows: accRows } = await client.query(
          `SELECT terms_snapshot FROM credit_accounts WHERE id = $1 AND company_id = $2`,
          [accountId, companyId]
        );
        accountTerms = accRows[0]?.terms_snapshot || null;
      } catch (e) {
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
    }

    const maxN = parseInt(accountTerms?.max_installments || config?.max_installments) || 12;
    const effectiveRate = parseFloat(interestRate) > 0
      ? parseFloat(interestRate)
      : parseFloat(accountTerms?.interest_rate || config?.interest_rate) || 0;
    const n = Math.min(nRequested, maxN, 100);
    const period = resolvePeriod(
      periodUnit || accountTerms?.period_unit,
      periodCount || accountTerms?.period_count,
      config
    );

    const due1 = firstDueDate || (() => {
      const d = new Date();
      d.setMonth(d.getMonth() + 1);
      return d.toISOString().split('T')[0];
    })();

    // 13/08/2026 (feedback Caio): juros total FLAT sobre o valor da venda,
    // independente do numero de parcelas -- ANTES multiplicava por n (juros
    // linear por parcela), o que escalava o juros total junto com o
    // parcelamento (ex: 10% em 10x cobrava 100% de juros). Mesma correcao
    // aplicada em /manual-entry e computeUnifyPlan.
    const totalWithInterest = effectiveRate > 0
      ? parseFloat((amount * (1 + effectiveRate)).toFixed(2))
      : amount;

    const baseAmount = Math.floor((totalWithInterest / n) * 100) / 100;
    const remainder  = Math.round((totalWithInterest - baseAmount * n) * 100) / 100;

    for (let i = 1; i <= n; i++) {
      const amt        = i === n ? baseAmount + remainder : baseAmount;
      const dueDateStr = dueDateForIndex(due1, period.unit, period.count, i - 1);

      let iid;
      try {
        const { rows: insRows } = await client.query(
          `INSERT INTO credit_installments
             (company_id, sale_id, customer_id, installment_number, total_installments,
              amount_due, due_date, status, covered_amount, account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8)
           RETURNING id`,
          [companyId, saleId, customerId, i, n, amt, dueDateStr, accountId]
        );
        iid = insRows[0].id;
      } catch (err) {
        if (err.code === '42703') {
          const { rows: insRows } = await client.query(
            `INSERT INTO credit_installments
               (company_id, sale_id, customer_id, installment_number, total_installments,
                amount_due, due_date, status, covered_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0)
             RETURNING id`,
            [companyId, saleId, customerId, i, n, amt, dueDateStr]
          );
          iid = insRows[0].id;
        } else throw err;
      }
      // B2: sem UPDATE de pix_link -- o campo fica NULL (link fake aposentado).
      // O Pix real (EMV) e gerado on-demand via GET /credit/installments/:iid/pix.
      schedule.push({ id: iid, installment_number: i, amount_due: amt, due_date: dueDateStr });
    }

    try {
      await client.query(
        // 17/08/2026: `is_installment` passa a ser $5 em vez de `true` fixo.
        // Com a agenda de 1x, marcar a venda como parcelada mudaria o que
        // relatorios e filtros existentes consideram "parcelado". 1x com
        // vencimento tem parcela, mas NAO e venda parcelada.
        `UPDATE sales
           SET is_installment = $5, total_installments = $2,
               credit_plan_snapshot = $3
         WHERE id = $1 AND company_id = $4`,
        [saleId, n,
         JSON.stringify({ installments: n, total_amount: amount, interest_rate: effectiveRate,
                          period_unit: period.unit, period_count: period.count }),
         companyId, n > 1]
      );
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }
  }

  // M1 (auditoria 12/06): credit_used atualizado no caminho COMUM -- venda 1x
  // (sem agenda de parcelas) tambem conta; antes so installments > 1 atualizava.
  await _updateCreditUsed(client, companyId, customerId);

  return { debited: debitRows[0], schedule, warnings };
}

async function applyPayment(client, {
  companyId, customerId, amount, method = null,
  sessaoId = null, createdBy = null, idempotencyKey = null,
  paidAt = null,
  accountId = null,
  config = undefined,
  profile = undefined,
}) {
  // 1. Ledger: payment
  // isNewPayment: true quando o INSERT do payment efetivamente inseriu uma linha
  // (NAO em replay idempotente via ON CONFLICT DO NOTHING). So materializamos
  // encargos quando o pagamento e novo, garantindo idempotencia.
  let txRow;
  let isNewPayment = true;
  if (idempotencyKey) {
    let r;
    try {
      r = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, type, amount, payment_method, created_by, idempotency_key, created_at, account_id)
         VALUES ($1, $2, 'payment', $3, $4, $5, $6, ${BACKDATE_TS('$7')}, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [companyId, customerId, amount, method, createdBy, idempotencyKey, paidAt, accountId]
      );
    } catch (err) {
      if (err.code === '42703') {
        r = await client.query(
          `INSERT INTO customer_credit_transactions
             (company_id, customer_id, type, amount, payment_method, created_by, idempotency_key, created_at)
           VALUES ($1, $2, 'payment', $3, $4, $5, $6, ${BACKDATE_TS('$7')})
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING *`,
          [companyId, customerId, amount, method, createdBy, idempotencyKey, paidAt]
        );
      } else throw err;
    }
    if (!r.rows.length) {
      isNewPayment = false; // replay idempotente: pagamento ja existia
      const { rows: ex } = await client.query(
        `SELECT * FROM customer_credit_transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      txRow = ex[0];
    } else {
      txRow = r.rows[0];
    }
  } else {
    let r;
    try {
      r = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, type, amount, payment_method, created_by, created_at, account_id)
         VALUES ($1, $2, 'payment', $3, $4, $5, ${BACKDATE_TS('$6')}, $7)
         RETURNING *`,
        [companyId, customerId, amount, method, createdBy, paidAt, accountId]
      );
    } catch (err) {
      if (err.code === '42703') {
        r = await client.query(
          `INSERT INTO customer_credit_transactions
             (company_id, customer_id, type, amount, payment_method, created_by, created_at)
           VALUES ($1, $2, 'payment', $3, $4, $5, ${BACKDATE_TS('$6')})
           RETURNING *`,
          [companyId, customerId, amount, method, createdBy, paidAt]
        );
      } else throw err;
    }
    txRow = r.rows[0];
  }

  // --- C1-BE (auditoria 11/06): REPLAY IDEMPOTENTE E NO-OP ---
  // Quando isNewPayment=false o pagamento JA foi aplicado na 1a chamada. Seguir
  // daqui re-executaria o FIFO (covered_amount dobrado, sale_payments duplicado,
  // receita 2x no caixa). Retorna o resultado reconstruido (saldo atual + a
  // transacao existente), sem nenhuma escrita.
  if (!isNewPayment) {
    const { rows: balRows } = await client.query(
      `SELECT balance FROM customer_credit_balances
       WHERE customer_id = $1 AND company_id = $2`,
      [customerId, companyId]
    );
    return {
      new_balance:          parseFloat(balRows[0]?.balance || 0),
      settled_receivables:  [],
      covered_installments: [],
      transaction:          txRow,
      legacy_amount:        0,
      charges_paid:         0,
      charges_detail:       [],
      replayed:             true,
    };
  }

  // --- Comunicacao clara no Financeiro (16/06, feedback Caio) ---
  // As descricoes dos lancamentos usam o NOME do cliente -- o lojista nao
  // decodifica UUID. LAZY + memoizado: so consulta o customers QUANDO uma
  // descricao com nome e efetivamente emitida (encargos / "Recebido" legado).
  // Assim o caminho comum (liquidacao casada de A Receber) nao ganha query
  // nova. Cai no id curto se a query falhar. A DATA ja vai no paid_at.
  let _whoCache;
  async function getWho() {
    if (_whoCache !== undefined) return _whoCache;
    let nm = null;
    try {
      const { rows: _cn } = await client.query(
        `SELECT name FROM customers WHERE id = $1 AND company_id = $2`,
        [customerId, companyId]
      );
      nm = _cn[0]?.name || null;
    } catch (_) {}
    _whoCache = nm || ('cliente ' + String(customerId).slice(0, 8));
    return _whoCache;
  }

  // --- F2 PR2: MATERIALIZACAO DE ENCARGOS (mora/multa) ---
  // GATED: so executa quando config.late_charges_enabled === true E o pagamento
  // e novo (isNewPayment). Caso contrario NENHUMA query nova roda e o
  // comportamento e EXATAMENTE o atual (principalAmount === amount).
  //
  // Ordem (decisao do dono, imutavel): ENCARGOS PRIMEIRO, depois principal.
  // Invariante: encargos NUNCA viram customer_credit_transactions 'debit', logo
  // o saldo de principal (customer_credit_balances) NUNCA e inflado por encargos.
  const fifoMethodForCharges = (method || 'dinheiro').toLowerCase();
  let chargesPaid     = 0;
  const chargesDetail = [];
  let principalAmount = amount;

  if (config && config.late_charges_enabled === true && isNewPayment) {
    // 1.1. Parcelas em aberto (pending/overdue), oldest-first.
    //      Escopo por carne quando accountId fornecido (mesma regra do FIFO).
    let chargeInstQuery;
    let chargeInstParams;
    if (accountId) {
      chargeInstQuery = `
        SELECT id, sale_id, amount_due, covered_amount, status, due_date
        FROM credit_installments
        WHERE company_id = $1 AND customer_id = $2
          AND account_id = $3
          AND status IN ('pending', 'overdue')
        ORDER BY due_date ASC`;
      chargeInstParams = [companyId, customerId, accountId];
    } else {
      chargeInstQuery = `
        SELECT id, sale_id, amount_due, covered_amount, status, due_date
        FROM credit_installments
        WHERE company_id = $1 AND customer_id = $2
          AND status IN ('pending', 'overdue')
        ORDER BY due_date ASC`;
      chargeInstParams = [companyId, customerId];
    }

    let openInst = [];
    try {
      const r = await client.query(chargeInstQuery, chargeInstParams);
      openInst = r.rows;
    } catch (err) {
      if (err.code === '42703') {
        const r = await client.query(
          `SELECT id, sale_id, amount_due, covered_amount, status, due_date
           FROM credit_installments
           WHERE company_id = $1 AND customer_id = $2
             AND status IN ('pending', 'overdue')
           ORDER BY due_date ASC`,
          [companyId, customerId]
        );
        openInst = r.rows;
      } else throw err;
    }

    // 1.2. Encargos por parcela (engine puro, principal RESTANTE no momento).
    //      Calculado ANTES do FIFO de principal (que roda depois com principalAmount).
    //      A2 (auditoria 12/06): paidAt string vira Date ao MEIO-DIA local --
    //      new Date('YYYY-MM-DD') seria meia-noite UTC = dia ANTERIOR em
    //      America/Sao_Paulo, divergindo do preview (computePaymentPlan).
    const terms = resolveTerms(profile || null, config);
    const perInst = openInst.map((inst) => {
      const lc = computeLateCharges(inst, terms, config, paidAt ? new Date(paidAt + 'T12:00:00') : new Date());
      return { inst, lc };
    });
    const totalCharges = round2(perInst.reduce((sum, p) => sum + (p.lc.charges_total || 0), 0));

    // 1.3. chargesPaid = min(amount, totalCharges).
    chargesPaid = round2(Math.min(amount, totalCharges));

    if (chargesPaid > 0) {
      // 1.4. UMA transacao income confirmada (Financeiro) -- sem cron.
      //      idempotency_key derivado do txRow.id evita duplicar em retry.
      await client.query(
        `INSERT INTO transactions
           (company_id, type, status, amount, description, category,
            due_date, paid_at, created_by, idempotency_key, payment_method)
         VALUES ($1, 'income', 'confirmed', $2, $3, 'Crediario - Encargos (mora/multa)',
                 COALESCE($6::date, ${SP_DATE_NOW}), ${BACKDATE_TS('$6')}, $4, $5, $7)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          companyId,
          chargesPaid,
          `Encargos crediario - ${await getWho()}`,
          createdBy,
          'credit-charges-' + txRow.id,
          paidAt,
          fifoMethodForCharges,
        ]
      );

      // 1.5. Aloca chargesPaid as parcelas oldest-first. Para cada parcela,
      //      porcao = min(restante, charges_total da parcela). Stampa late_fee
      //      depois late_interest, consumindo a porcao (parcial => proporcional
      //      por consumo: multa primeiro, mora com o que sobrar). Reflete o
      //      dinheiro no caixa via sale_payments.
      let remainingCharges = chargesPaid;
      for (const { inst, lc } of perInst) {
        if (remainingCharges <= 0.005) break;
        const instCharges = round2(lc.charges_total || 0);
        if (instCharges <= 0.005) continue;

        const portion = round2(Math.min(remainingCharges, instCharges));

        // Stampa late_fee primeiro, late_interest com o restante da porcao.
        const stampFee      = round2(Math.min(portion, lc.late_fee || 0));
        const stampInterest = round2(Math.max(0, portion - stampFee));

        try {
          await client.query(
            `UPDATE credit_installments
               SET late_fee      = COALESCE(late_fee, 0) + $3,
                   late_interest = COALESCE(late_interest, 0) + $4,
                   updated_at    = NOW()
             WHERE id = $1 AND company_id = $2`,
            [inst.id, companyId, stampFee, stampInterest]
          );
        } catch (err) {
          // late_fee/late_interest podem nao existir em deploy parcial.
          if (err.code !== '42703' && err.code !== '42P01') throw err;
        }

        // Reflete o dinheiro de encargos no caixa.
        if (inst.sale_id) {
          await client.query(
            `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id, created_at)
             VALUES ($1, $2, $3, $4, $5, ${BACKDATE_TS('$6')}) ON CONFLICT DO NOTHING`,
            [inst.sale_id, companyId, fifoMethodForCharges, portion, sessaoId, paidAt]
          );
        }

        chargesDetail.push({ installment_id: inst.id, late_fee: stampFee, late_interest: stampInterest });
        remainingCharges = round2(remainingCharges - portion);
      }
    }

    // 1.6. Principal e o que sobra apos os encargos.
    principalAmount = round2(amount - chargesPaid);
  }

  // 2. FIFO liquidacao das transactions 'A Receber' pendentes
  // Se accountId fornecido: filtra por carne via JOIN com customer_credit_transactions
  const fifoMethod = (method || 'dinheiro').toLowerCase();
  const settledReceivables = [];
  let remaining = principalAmount;

  // Para FIFO escopo por carne, precisamos do sale_id das transacoes do carne
  // O filtro de carne e feito via account_id na customer_credit_transactions (debit)
  let pendingTxsQuery;
  let pendingTxsParams;
  if (accountId) {
    pendingTxsQuery = `
      SELECT t.id, t.amount, t.idempotency_key, s.id AS sale_id
      FROM transactions t
      JOIN sales s ON ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
      JOIN customer_credit_transactions cct
        ON cct.sale_id = s.id AND cct.company_id = $1
        AND cct.type = 'debit' AND cct.account_id = $3
      WHERE t.company_id = $1
        AND t.category ILIKE 'Crediario%A Receber%'
        AND t.status = 'pending'
        AND s.customer_id = $2
        AND COALESCE(s.status, 'active') != 'cancelled'
      ORDER BY t.created_at ASC
      LIMIT 100
      FOR UPDATE OF t`;
    pendingTxsParams = [companyId, customerId, accountId];
  } else {
    pendingTxsQuery = `
      SELECT t.id, t.amount, t.idempotency_key, s.id AS sale_id
      FROM transactions t
      JOIN sales s ON ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
      WHERE t.company_id = $1
        AND t.category ILIKE 'Crediario%A Receber%'
        AND t.status = 'pending'
        AND s.customer_id = $2
        AND COALESCE(s.status, 'active') != 'cancelled'
      ORDER BY t.created_at ASC
      LIMIT 100
      FOR UPDATE OF t`;
    pendingTxsParams = [companyId, customerId];
  }

  let pendingTxs;
  try {
    const r = await client.query(pendingTxsQuery, pendingTxsParams);
    pendingTxs = r.rows;
  } catch (err) {
    if (err.code === '42703' || err.code === '42P01') {
      // fallback: FIFO global sem filtro de carne
      const r = await client.query(
        `SELECT t.id, t.amount, t.idempotency_key, s.id AS sale_id
         FROM transactions t
         JOIN sales s ON ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
         WHERE t.company_id = $1
           AND t.category ILIKE 'Crediario%A Receber%'
           AND t.status = 'pending'
           AND s.customer_id = $2
           AND COALESCE(s.status, 'active') != 'cancelled'
         ORDER BY t.created_at ASC
         LIMIT 100
         FOR UPDATE OF t`,
        [companyId, customerId]
      );
      pendingTxs = r.rows;
    } else throw err;
  }

  for (const pt of pendingTxs) {
    if (remaining <= 0.005) break;
    const ptAmount = parseFloat(pt.amount);

    if (ptAmount <= remaining + 0.005) {
      await client.query(
        `UPDATE transactions
           SET status = 'confirmed', paid_at = ${BACKDATE_TS('$3')}, payment_method = $1,
               category = 'Crediario - Recebido', updated_at = NOW()
         WHERE id = $2`,
        [fifoMethod, pt.id, paidAt]
      );
      await client.query(
        `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id, created_at)
         VALUES ($1, $2, $3, $4, $5, ${BACKDATE_TS('$6')}) ON CONFLICT DO NOTHING`,
        [pt.sale_id, companyId, fifoMethod, ptAmount, sessaoId, paidAt]
      );
      settledReceivables.push({ id: pt.id, sale_id: pt.sale_id, amount: ptAmount, partial: false });
      remaining = parseFloat((remaining - ptAmount).toFixed(2));
    } else {
      const paidNow = parseFloat(remaining.toFixed(2));
      const restAmt = parseFloat((ptAmount - paidNow).toFixed(2));

      await client.query(
        `UPDATE transactions
           SET status = 'confirmed', paid_at = ${BACKDATE_TS('$4')}, payment_method = $1,
               amount = $2, category = 'Crediario - Recebido (parcial)', updated_at = NOW()
         WHERE id = $3`,
        [fifoMethod, paidNow, pt.id, paidAt]
      );
      await client.query(
        `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id, created_at)
         VALUES ($1, $2, $3, $4, $5, ${BACKDATE_TS('$6')}) ON CONFLICT DO NOTHING`,
        [pt.sale_id, companyId, fifoMethod, paidNow, sessaoId, paidAt]
      );

      const restKey = pt.idempotency_key + '-rest-' + Date.now();
      await client.query(
        `INSERT INTO transactions
           (company_id, type, status, amount, description, category,
            due_date, paid_at, created_by, idempotency_key)
         VALUES ($1, 'income', 'pending', $2, $3, 'Crediario - A Receber',
                 ${SP_DATE_NOW}, NULL, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          companyId, restAmt,
          `Crediario - saldo venda ${pt.sale_id} (parcial)`,
          createdBy, restKey,
        ]
      );

      settledReceivables.push({ id: pt.id, sale_id: pt.sale_id, amount: paidNow, partial: true, rest: restAmt });
      remaining = 0;
    }
  }

  // Sobra: pagamento maior que A Receber pendentes
  if (remaining > 0.005) {
    await client.query(
      `INSERT INTO transactions
         (company_id, type, status, amount, description, category,
          due_date, paid_at, created_by, idempotency_key, payment_method)
       VALUES ($1, 'income', 'confirmed', $2, $3, 'Crediario - Recebido',
               COALESCE($7::date, ${SP_DATE_NOW}), ${BACKDATE_TS('$7')}, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        companyId,
        parseFloat(remaining.toFixed(2)),
        `Recebimento crediario - ${await getWho()}`,
        createdBy,
        'credit-payment-' + txRow.id + '-legacy',
        fifoMethod,
        paidAt,
      ]
    );
  }

  // 3. FIFO covered_amount nas credit_installments (escopo por carne se accountId)
  const coveredInstallments = [];
  let toAllocate = principalAmount;

  let instQuery;
  let instParams;
  if (accountId) {
    instQuery = `
      SELECT id, amount_due, covered_amount, status, due_date
      FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2
        AND account_id = $3
        AND status IN ('pending', 'overdue')
      ORDER BY due_date ASC
      FOR UPDATE`;
    instParams = [companyId, customerId, accountId];
  } else {
    instQuery = `
      SELECT id, amount_due, covered_amount, status, due_date
      FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2
        AND status IN ('pending', 'overdue')
      ORDER BY due_date ASC
      FOR UPDATE`;
    instParams = [companyId, customerId];
  }

  let installments;
  try {
    const r = await client.query(instQuery, instParams);
    installments = r.rows;
  } catch (err) {
    if (err.code === '42703') {
      // account_id nao existe ainda: FIFO global
      const r = await client.query(
        `SELECT id, amount_due, covered_amount, status, due_date
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND status IN ('pending', 'overdue')
         ORDER BY due_date ASC
         FOR UPDATE`,
        [companyId, customerId]
      );
      installments = r.rows;
    } else throw err;
  }

  for (const inst of installments) {
    if (toAllocate <= 0.005) break;
    const currentCovered = parseFloat(inst.covered_amount);
    const amountDue      = parseFloat(inst.amount_due);
    const uncovered      = amountDue - currentCovered;
    if (uncovered <= 0.005) continue;

    const coverNow   = Math.min(toAllocate, uncovered);
    const newCovered = Math.round((currentCovered + coverNow) * 100) / 100;
    const newStatus  = newCovered >= amountDue - 0.005 ? 'paid' : inst.status;

    await client.query(
      `UPDATE credit_installments
         SET covered_amount = $3,
             status         = $4,
             paid_at        = CASE WHEN $5 THEN ${BACKDATE_TS('$6')} ELSE paid_at END,
             updated_at     = NOW()
       WHERE id = $1 AND company_id = $2`,
      [inst.id, companyId, newCovered, newStatus, newStatus === 'paid', paidAt]
    );

    coveredInstallments.push({ id: inst.id, covered: coverNow, status: newStatus });
    toAllocate = Math.round((toAllocate - coverNow) * 100) / 100;
  }

  if (coveredInstallments.some(c => c.status === 'paid')) {
    await _recalculateScore(client, companyId, customerId);
  }
  await _updateCreditUsed(client, companyId, customerId);

  const { rows: balRows } = await client.query(
    `SELECT balance FROM customer_credit_balances
     WHERE customer_id = $1 AND company_id = $2`,
    [customerId, companyId]
  );

  return {
    new_balance:          parseFloat(balRows[0]?.balance || 0),
    settled_receivables:  settledReceivables,
    covered_installments: coveredInstallments,
    transaction:          txRow,
    legacy_amount:        remaining > 0.005 ? parseFloat(remaining.toFixed(2)) : 0,
    charges_paid:         chargesPaid,
    charges_detail:       chargesDetail,
  };
}

async function cancelCreditSale(client, { companyId, saleId }) {
  const { rows: saleRows } = await client.query(
    `SELECT customer_id FROM sales WHERE id = $1 AND company_id = $2`,
    [saleId, companyId]
  );
  const customerId = saleRows[0]?.customer_id;

  await client.query(
    `DELETE FROM customer_credit_transactions
     WHERE sale_id = $1 AND company_id = $2 AND type = 'debit'`,
    [saleId, companyId]
  );

  await client.query(
    `DELETE FROM transactions
     WHERE idempotency_key = $1 AND company_id = $2`,
    ['pdv-credit-receivable-' + saleId, companyId]
  );
  await client.query(
    `DELETE FROM transactions
     WHERE company_id = $1
       AND idempotency_key LIKE $2
       AND status = 'pending'`,
    [companyId, 'pdv-credit-receivable-' + saleId + '-%']
  );

  await client.query(
    `UPDATE credit_installments
       SET status = 'cancelled', covered_amount = 0, updated_at = NOW()
     WHERE sale_id = $1 AND company_id = $2
       AND status IN ('pending', 'overdue')`,
    [saleId, companyId]
  );

  if (customerId) {
    await _updateCreditUsed(client, companyId, customerId);
  }

  return { ok: true };
}

async function getCustomerCreditPreview(companyId, customerId) {
  const today = `(NOW() AT TIME ZONE 'America/Sao_Paulo')::date`;
  try {
    const [balRes, profileRes, instRes, configRes, overdueRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(balance, 0) AS balance
         FROM customer_credit_balances
         WHERE company_id = $1 AND customer_id = $2`,
        [companyId, customerId]
      ),
      pool.query(
        `SELECT credit_score, credit_limit, credit_used, status, blocked_reason,
                term_late_fee_rate, term_late_interest_daily
         FROM customer_credit_profiles
         WHERE company_id = $1 AND customer_id = $2`,
        [companyId, customerId]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT COUNT(*) AS open_count,
                MIN(due_date) AS next_due_date,
                COUNT(*) FILTER (WHERE due_date < ${today}) AS overdue_count
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND status IN ('pending', 'overdue')`,
        [companyId, customerId]
      ),
      pool.query(
        `SELECT score_warn_min, late_charges_enabled, late_grace_days,
                late_fee_rate, late_interest_daily
         FROM credit_plan_configs WHERE company_id = $1`,
        [companyId]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT amount_due, covered_amount, due_date, status
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND status IN ('pending', 'overdue')`,
        [companyId, customerId]
      ).catch(() => ({ rows: [] })),
    ]);

    const balance    = parseFloat(balRes.rows[0]?.balance || 0);
    const profile    = profileRes.rows[0] || {};
    const inst       = instRes.rows[0] || {};
    const config     = configRes.rows[0] || {};
    const score      = parseInt(profile.credit_score) || 500;
    const limit      = parseFloat(profile.credit_limit) || 0;
    const over_limit = limit > 0 && balance >= limit;

    // F2 PR1: encargos lazy agregados (sempre 0 se capability OFF).
    let total_late_charges = 0;
    try {
      const terms = resolveTerms(profile, config);
      total_late_charges = round2(
        (overdueRes.rows || []).reduce(
          (sum, r) => sum + (computeLateCharges(r, terms, config).charges_total || 0),
          0
        )
      );
    } catch (_) { total_late_charges = 0; }

    return {
      balance,
      open_installments_count: parseInt(inst.open_count) || 0,
      overdue_count:           parseInt(inst.overdue_count) || 0,
      next_due_date:           inst.next_due_date || null,
      score,
      score_label:             scoreLabel(score),
      score_warning:           scoreWarning(score, config),
      credit_limit:            limit,
      credit_used:             parseFloat(profile.credit_used) || balance,
      over_limit,
      status:                  profile.status || 'active',
      blocked_reason:          profile.blocked_reason || null,
      total_late_charges,
    };
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      return {
        balance: 0, open_installments_count: 0, overdue_count: 0,
        next_due_date: null, score: 500, score_label: 'regular',
        score_warning: null,
        credit_limit: 0, credit_used: 0, over_limit: false,
        status: 'active', blocked_reason: null,
        total_late_charges: 0,
      };
    }
    throw err;
  }
}

// =============================================================
// applyUnify (Item 3, 13/06/2026)
// Cancela as parcelas abertas do carne alvo e insere o novo schedule
// unificado (saldo em aberto + nova compra + juros sobre a nova).
//
// FRONTEIRA: esta funcao SO reescreve o SCHEDULE de credit_installments.
// O lancamento de debito (customer_credit_transactions) e o A Receber
// (transactions) da nova compra SAO CRIADOS pelo fluxo normal de venda
// (createCreditSale ou PDV). O FE chama POST /unify APOS registrar a
// venda, passando o sale_id opcional para rastrear as novas parcelas.
// =============================================================
async function applyUnify(client, {
  companyId,
  customerId,
  accountId = null,
  newAmount,
  installments,
  firstDueDate = null,
  periodUnit = null,
  periodCount = null,
  interestRate = 0,
  saleId = null,
}) {
  // 1. Carrega parcelas abertas do carne alvo FOR UPDATE (lock otimista).
  //    Escopo: account_id = valor OU account_id IS NULL (carne geral).
  let openRows;
  try {
    if (accountId) {
      const r = await client.query(
        `SELECT id, amount_due, covered_amount
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND account_id = $3
           AND status IN ('pending', 'overdue')
         ORDER BY due_date ASC
         FOR UPDATE`,
        [companyId, customerId, accountId]
      );
      openRows = r.rows;
    } else {
      const r = await client.query(
        `SELECT id, amount_due, covered_amount
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND account_id IS NULL
           AND status IN ('pending', 'overdue')
         ORDER BY due_date ASC
         FOR UPDATE`,
        [companyId, customerId]
      );
      openRows = r.rows;
    }
  } catch (err) {
    if (err.code === '42703') {
      // account_id nao existe ainda: FIFO global do cliente
      const r = await client.query(
        `SELECT id, amount_due, covered_amount
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND status IN ('pending', 'overdue')
         ORDER BY due_date ASC
         FOR UPDATE`,
        [companyId, customerId]
      );
      openRows = r.rows;
    } else throw err;
  }

  // 2. Motor puro: calcula o novo schedule (determinista, sem I/O).
  const plan = computeUnifyPlan({
    openInstallments: openRows,
    newAmount,
    installments,
    interestRate,
    firstDueDate,
    periodUnit,
    periodCount,
  });

  // 3. Cancela as parcelas substituidas (preserva covered_amount -- historico).
  if (plan.replaced_installment_ids.length > 0) {
    await client.query(
      `UPDATE credit_installments
         SET status = 'cancelled', updated_at = NOW()
       WHERE id = ANY($1) AND company_id = $2`,
      [plan.replaced_installment_ids, companyId]
    );
  }

  // 4. Insere as N novas parcelas do schedule unificado.
  //    Espelha o INSERT de createCreditSale (com fallback 42703 sem account_id).
  const appliedIds = [];
  for (const slot of plan.schedule) {
    let iid;
    try {
      const { rows: insRows } = await client.query(
        `INSERT INTO credit_installments
           (company_id, sale_id, customer_id, installment_number, total_installments,
            amount_due, due_date, status, covered_amount, account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8)
         RETURNING id`,
        [companyId, saleId, customerId, slot.number, plan.installments_count,
         slot.amount_due, slot.due_date, accountId]
      );
      iid = insRows[0].id;
    } catch (err) {
      if (err.code === '42703') {
        // account_id ainda nao existe: fallback sem coluna
        const { rows: insRows } = await client.query(
          `INSERT INTO credit_installments
             (company_id, sale_id, customer_id, installment_number, total_installments,
              amount_due, due_date, status, covered_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0)
           RETURNING id`,
          [companyId, saleId, customerId, slot.number, plan.installments_count,
           slot.amount_due, slot.due_date]
        );
        iid = insRows[0].id;
      } else throw err;
    }
    appliedIds.push(iid);
  }

  return { ...plan, applied_installment_ids: appliedIds };
}

module.exports = {
  _getOrCreateProfile,
  _getOrCreatePlanConfig,
  _updateCreditUsed,
  createCreditSale,
  applyPayment,
  cancelCreditSale,
  getCustomerCreditPreview,
  applyUnify,
};
