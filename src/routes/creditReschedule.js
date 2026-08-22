// ============================================================
// AURA. -- Crediario: RENEGOCIACAO de parcelas (Item 2, 16/06/2026)
//
// GET  /customers/:cid/accounts/:accountId/reschedule/preview
//   Preview sem lock: cronograma + delta de saldo calculados pelo motor puro.
//   Query: total?, installments, first_due_date?, period_unit?, period_count?
//   (total omitido => usa o saldo aberto atual = renegociacao sem mudar total)
//
// POST /customers/:cid/accounts/:accountId/reschedule
//   Aplica em transacao atomica. Body: { total?, installments, first_due_date?,
//   period_unit?, period_count? }
//   Header opcional `Idempotency-Key`: replay devolve o resultado da primeira
//   aplicacao sem re-executar (21/08/2026 -- ver bloco abaixo).
//
// :accountId === 'general' => account_id IS NULL (carne Conta Geral).
//
// Montado em private.js sob /credit (requireAuth + requireCompanyAccess +
// requirePlan('negocio','expansao') ja aplicados a montante).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { randomUUID } = require('crypto');
const { computeReschedulePlan, applyReschedule, loadOpenInstallments, sumRemaining, getUnscheduledBalance } = require('../services/credit/reschedule');

// Helper canonico (mesmo de creditUnify.js/creditRefund.js).
async function assertCrediarioEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) { const e = new Error('Empresa nao encontrada'); e.status = 404; throw e; }
  if (rows[0].enabled !== 'true') {
    const e = new Error('Modulo de crediario nao esta habilitado. Ative em Configuracoes > PDV > Politicas do Caixa.');
    e.status = 403; e.code = 'CREDIARIO_DISABLED'; throw e;
  }
}

// 'general' (ou vazio) => null (carne Conta Geral).
function resolveAccountId(raw) {
  if (!raw || raw === 'general') return null;
  return raw;
}

// ─── Idempotencia da aplicacao (21/08/2026) ─────────────────────────────
// Relato Valen: a MESMA renegociacao (54x) foi aplicada duas vezes com 33s de
// intervalo. O servidor aplicou e commitou nas duas; a resposta nao chegou no
// app na primeira, o lojista viu o toast generico de erro e clicou de novo.
// Cada clique cancela o carne inteiro e recria -- um cliente ja acumulou 91
// parcelas canceladas. O lancamento manual ja deduplicava por Idempotency-Key;
// aqui nao havia protecao nenhuma.
//
// O recibo guarda o payload da primeira aplicacao: replay devolve o mesmo
// resultado, sem tocar em parcela. Sem header, o comportamento e o de antes.
// Defensivo: se a migration 300 ainda nao rodou (42P01), segue sem protecao.
let receiptsTableAvailable = null; // null = ainda nao sabemos

/** Janela do clique duplo sem header, em segundos. */
const FINGERPRINT_WINDOW_SECONDS = 60;

/**
 * Impressao digital do pedido. Duas requisicoes com a mesma impressao dentro da
 * janela sao o mesmo clique repetido -- renegociar o mesmo carne para o mesmo
 * total, no mesmo numero de parcelas e mesma data duas vezes seguidas nao
 * significa nada alem de "a primeira resposta se perdeu".
 */
function rescheduleFingerprint({ accountId, total, installments, firstDueDate, periodUnit, periodCount }) {
  return JSON.stringify([
    accountId || 'general',
    total == null ? 'same' : Number(total).toFixed(2),
    installments,
    firstDueDate || 'auto',
    periodUnit || 'month',
    periodCount || 1,
  ]);
}

async function loadRescheduleReceipt(companyId, key, exec = db) {
  if (!key || receiptsTableAvailable === false) return null;
  try {
    const { rows } = await exec.query(
      `SELECT result FROM credit_reschedule_receipts
        WHERE company_id = $1 AND idempotency_key = $2
        LIMIT 1`,
      [companyId, key]
    );
    receiptsTableAvailable = true;
    return rows[0]?.result || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') { receiptsTableAvailable = false; return null; }
    throw e;
  }
}

/** Recibo recente com a MESMA impressao digital (app sem Idempotency-Key). */
async function loadRecentByFingerprint(companyId, customerId, fingerprint, exec = db) {
  if (receiptsTableAvailable === false) return null;
  try {
    const { rows } = await exec.query(
      `SELECT result FROM credit_reschedule_receipts
        WHERE company_id = $1 AND customer_id = $2 AND fingerprint = $3
          AND created_at > NOW() - ($4 || ' seconds')::interval
        ORDER BY created_at DESC
        LIMIT 1`,
      [companyId, customerId, fingerprint, String(FINGERPRINT_WINDOW_SECONDS)]
    );
    receiptsTableAvailable = true;
    return rows[0]?.result || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') { receiptsTableAvailable = false; return null; }
    throw e;
  }
}

// Periodicidade do carne (terms_snapshot) ou da empresa (credit_plan_configs).
// A renegociacao NAO adiciona juros (o total e explicito), entao so o periodo importa.
async function resolveReschedulePeriod(companyId, accountId) {
  let accountTerms = null;
  if (accountId) {
    try {
      const { rows } = await db.query(
        `SELECT terms_snapshot FROM credit_accounts WHERE id = $1 AND company_id = $2`,
        [accountId, companyId]
      );
      accountTerms = rows[0]?.terms_snapshot || null;
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }
  }
  let config = null;
  try {
    const { rows } = await db.query(
      `SELECT period_unit, period_count FROM credit_plan_configs WHERE company_id = $1`,
      [companyId]
    );
    config = rows[0] || null;
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  return {
    periodUnit:  accountTerms?.period_unit  || config?.period_unit  || 'month',
    periodCount: parseInt(accountTerms?.period_count || config?.period_count || 1),
  };
}

async function ensureCustomer(companyId, customerId) {
  const { rows } = await db.query(
    `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
    [customerId, companyId]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------
// GET .../reschedule/preview
// ---------------------------------------------------------------
router.get('/customers/:cid/accounts/:accountId/reschedule/preview', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const accountId  = resolveAccountId(req.params.accountId);

  const installments = parseInt(req.query.installments, 10);
  const hasTotal     = req.query.total != null && req.query.total !== '';
  const total        = hasTotal ? parseFloat(req.query.total) : null;
  const firstDueDate = req.query.first_due_date || null;
  const periodUnit   = req.query.period_unit  || null;
  const periodCount  = req.query.period_count ? parseInt(req.query.period_count, 10) : null;

  if (isNaN(installments) || installments < 1) {
    return res.status(400).json({ error: 'installments invalido (deve ser >= 1)' });
  }
  if (hasTotal && (isNaN(total) || total < 0)) {
    return res.status(400).json({ error: 'total invalido (deve ser >= 0)' });
  }

  try {
    if (!(await ensureCustomer(companyId, customerId))) {
      return res.status(404).json({ error: 'Cliente nao encontrado' });
    }
  } catch (err) {
    console.error('[creditReschedule] preview customer check:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao verificar cliente' });
  }

  try {
    const period   = await resolveReschedulePeriod(companyId, accountId);
    const openRows = await loadOpenInstallments(db, companyId, customerId, accountId, false);
    // Parcelar saldo (10/07): sem parcela aberta, base = saldo sem cronograma.
    let baseRemaining = sumRemaining(openRows);
    if (openRows.length === 0) {
      baseRemaining = await getUnscheduledBalance(db, companyId, customerId);
    }
    const plan = computeReschedulePlan({
      openRemaining: baseRemaining,
      total,
      installments,
      firstDueDate,
      periodUnit:  periodUnit  || period.periodUnit,
      periodCount: periodCount || period.periodCount,
    });
    return res.status(200).json({ ...plan, open_installments_count: openRows.length });
  } catch (err) {
    console.error('[creditReschedule] preview error:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao calcular preview da renegociacao' });
  }
});

// ---------------------------------------------------------------
// POST .../reschedule
// ---------------------------------------------------------------
router.post('/customers/:cid/accounts/:accountId/reschedule', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const accountId  = resolveAccountId(req.params.accountId);

  const installments = parseInt(req.body?.installments, 10);
  const hasTotal     = req.body?.total != null && req.body?.total !== '';
  const total        = hasTotal ? parseFloat(req.body.total) : null;
  const firstDueDate = req.body?.first_due_date || null;
  const periodUnit   = req.body?.period_unit  || null;
  const periodCount  = req.body?.period_count ? parseInt(req.body.period_count, 10) : null;
  const idempotencyKey = req.headers['idempotency-key']
    ? String(req.headers['idempotency-key']).trim()
    : null;
  const startedAt = Date.now();

  if (isNaN(installments) || installments < 1) {
    return res.status(400).json({ error: 'installments invalido (deve ser >= 1)' });
  }
  if (hasTotal && (isNaN(total) || total < 0)) {
    return res.status(400).json({ error: 'total invalido (deve ser >= 0)' });
  }

  try {
    if (!(await ensureCustomer(companyId, customerId))) {
      return res.status(404).json({ error: 'Cliente nao encontrado' });
    }
  } catch (err) {
    console.error('[creditReschedule] apply customer check:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao verificar cliente' });
  }

  try {
    await assertCrediarioEnabled(companyId);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }

  // Replay ANTES de qualquer escrita. As DUAS checagens rodam, nesta ordem:
  //
  //   1. Idempotency-Key, quando o caller manda uma chave ESTAVEL entre retries.
  //   2. Impressao digital do pedido dentro da janela -- rede de seguranca que
  //      vale SEMPRE, inclusive com header.
  //
  // O (2) nao e opcional: o app de hoje ja manda Idempotency-Key, mas gera uma
  // chave nova a cada clique (`resched-...-Date.now()`), entao a chave nunca
  // repete e sozinha nao deduplica nada -- foi assim que a renegociacao da
  // Valen entrou duas vezes. Renegociar o mesmo carne para o mesmo total, no
  // mesmo numero de parcelas e mesma data, duas vezes em menos de um minuto,
  // nunca e uma segunda intencao: e a primeira resposta que se perdeu.
  const fingerprint = rescheduleFingerprint({
    accountId, total, installments, firstDueDate, periodUnit, periodCount,
  });
  try {
    let by = 'key';
    let prior = await loadRescheduleReceipt(companyId, idempotencyKey);
    if (!prior) {
      by = 'fingerprint';
      prior = await loadRecentByFingerprint(companyId, customerId, fingerprint);
    }
    if (prior) {
      console.info('[creditReschedule] replay', JSON.stringify({
        companyId, customerId, accountId, by,
      }));
      return res.status(200).json({ ...prior, replayed: true });
    }
  } catch (err) {
    console.error('[creditReschedule] replay check:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao verificar renegociacao anterior' });
  }

  const period = await resolveReschedulePeriod(companyId, accountId).catch(() => ({
    periodUnit: 'month', periodCount: 1,
  }));

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Serializa renegociacoes do MESMO cliente. Sem isso, dois cliques
    // simultaneos passam os dois pela checagem de replay acima e aplicam duas
    // vezes; com o lock, o segundo espera o primeiro commitar e cai no replay
    // logo abaixo. Advisory lock de transacao: solta sozinho no COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [companyId + ':' + customerId]);

    // Re-checagem DENTRO da transacao (o vencedor da corrida ja commitou).
    // Mesmas duas checagens da entrada -- a impressao digital vale com header.
    const priorInTx = (await loadRescheduleReceipt(companyId, idempotencyKey, client))
      || (await loadRecentByFingerprint(companyId, customerId, fingerprint, client));
    if (priorInTx) {
      await client.query('ROLLBACK');
      console.info('[creditReschedule] replay (corrida)', JSON.stringify({
        companyId, customerId, accountId,
      }));
      return res.status(200).json({ ...priorInTx, replayed: true });
    }

    const result = await applyReschedule(client, {
      companyId,
      customerId,
      accountId,
      total,
      installments,
      firstDueDate,
      periodUnit:  periodUnit  || period.periodUnit,
      periodCount: periodCount || period.periodCount,
      createdBy:   req.user?.id || null,
    });
    // Recibo dentro da MESMA transacao: ou o carne novo e o recibo existem
    // juntos, ou nenhum dos dois. SAVEPOINT para que uma tabela ausente
    // (migration 300 pendente) nao aborte a renegociacao inteira.
    let duplicateKey = false;
    if (receiptsTableAvailable !== false) {
      // Sem header, a key e sintetica: o recibo existe pela impressao digital.
      const receiptKey = idempotencyKey || ('auto-' + randomUUID());
      await client.query('SAVEPOINT rsc_receipt');
      try {
        await client.query(
          `INSERT INTO credit_reschedule_receipts
             (company_id, customer_id, account_id, idempotency_key, fingerprint, result)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [companyId, customerId, accountId, receiptKey, fingerprint, JSON.stringify(result)]
        );
        receiptsTableAvailable = true;
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT rsc_receipt');
        if (e.code === '23505') {
          duplicateKey = true;              // outra requisicao com a mesma key ganhou
        } else if (e.code === '42P01' || e.code === '42703') {
          receiptsTableAvailable = false;   // migration pendente -- segue sem protecao
        } else throw e;
      }
    }

    if (duplicateKey) {
      // A corrida perdeu: desfaz esta aplicacao e devolve a que venceu.
      await client.query('ROLLBACK');
      const prior = await loadRescheduleReceipt(companyId, idempotencyKey);
      if (prior) return res.status(200).json({ ...prior, replayed: true });
      return res.status(409).json({
        error: 'Renegociacao ja em andamento para esta chave. Recarregue a ficha.',
        code:  'RESCHEDULE_IN_FLIGHT',
      });
    }

    await client.query('COMMIT');
    // Log de SUCESSO: ate 21/08/2026 so havia console.error aqui, entao uma
    // renegociacao aplicada nao deixava rastro nenhum -- "sem erro no Railway"
    // ficava indistinguivel de "a requisicao nunca chegou". Nao repetir isso.
    console.info('[creditReschedule] aplicado', JSON.stringify({
      companyId, customerId, accountId,
      installments: result.installments_count,
      total:        result.target_total,
      replaced:     (result.replaced_installment_ids || []).length,
      adjustment:   result.adjustment?.type || null,
      idempotent:   Boolean(idempotencyKey),
      ms:           Date.now() - startedAt,
    }));
    return res.status(200).json(result);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('[creditReschedule] apply error:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao renegociar parcelas' });
  } finally {
    client.release();
  }
});

module.exports = router;
