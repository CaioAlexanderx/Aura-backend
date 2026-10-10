// ============================================================
// AURA. -- Crediario: JUNTAR CARNES (10/10/2026)
//
// GET  /customers/:cid/accounts/merge/preview
//   Preview sem lock: o plano calculado pelo motor puro.
//   Query: account_ids=a,b[,general] & installments & first_due_date?
//          & period_unit? & period_count? & total? & name?
//
// POST /customers/:cid/accounts/merge
//   Aplica em transacao atomica.
//   Body: { account_ids: [..], installments, first_due_date?, period_unit?,
//           period_count?, total?, name? }
//   Header opcional `Idempotency-Key`: replay devolve o resultado da primeira
//   aplicacao sem re-executar.
//
// 'general' em account_ids = o grupo sem carne (compras antigas, account_id
// nulo) entra como mais uma origem.
//
// Regra, motor e decisoes: services/credit/mergeCarnes.js.
//
// Montado em private.js sob /credit (requireAuth + requireCompanyAccess +
// requirePlan('negocio','expansao') ja aplicados a montante).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { randomUUID } = require('crypto');
// 16/09/2026: cliente de outra loja do mesmo dono tambem vale (utils/customerScope.js).
const { findOwnerScopedCustomer, CUSTOMER_NOT_FOUND_BODY } = require('../utils/customerScope');
const mergeCarnes = require('../services/credit/mergeCarnes');

// Helper canonico (mesmo de creditUnify.js/creditReschedule.js).
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

// Periodicidade padrao da loja (credit_plan_configs). O carne destino e novo,
// entao nao ha terms_snapshot de carne para consultar.
async function resolveStorePeriod(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT period_unit, period_count FROM credit_plan_configs WHERE company_id = $1`,
      [companyId]
    );
    return {
      periodUnit:  rows[0]?.period_unit || 'month',
      periodCount: parseInt(rows[0]?.period_count || 1, 10) || 1,
    };
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
    return { periodUnit: 'month', periodCount: 1 };
  }
}

function parseInput(src) {
  const hasTotal = src?.total != null && src?.total !== '';
  return {
    accountIds:   mergeCarnes.normalizeAccountIds(src?.account_ids),
    installments: parseInt(src?.installments, 10),
    total:        hasTotal ? parseFloat(src.total) : null,
    firstDueDate: src?.first_due_date ? String(src.first_due_date).trim() : null,
    periodUnit:   ['day', 'week', 'month'].includes(src?.period_unit) ? src.period_unit : null,
    periodCount:  src?.period_count ? (parseInt(src.period_count, 10) || null) : null,
    name:         src?.name ? String(src.name).trim().slice(0, 80) : null,
  };
}

// ─── Idempotencia ─────────────────────────────────────────────
// Mesmo desenho da renegociacao (creditReschedule.js, 21/08/2026) e a MESMA
// tabela de recibos (credit_reschedule_receipts, migration 300): Idempotency-Key
// + impressao digital do pedido dentro de uma janela. O app gera chave nova a
// cada clique, entao a chave sozinha nao deduplica o clique duplo -- a
// impressao digital sim. O prefixo 'merge:' impede a impressao de casar com a
// de uma renegociacao.
//
// A juncao ja se protege sozinha de aplicar duas vezes (a segunda encontra as
// origens fechadas e leva 409); o recibo existe para o segundo clique receber
// o MESMO resultado do primeiro em vez de um erro.
let receiptsTableAvailable = null; // null = ainda nao sabemos
const FINGERPRINT_WINDOW_SECONDS = 60;

function mergeFingerprint(input) {
  return 'merge:' + JSON.stringify([
    input.accountIds.slice().sort(),
    input.total == null ? 'same' : Number(input.total).toFixed(2),
    input.installments,
    input.firstDueDate || 'auto',
    input.periodUnit || 'loja',
    input.periodCount || 'loja',
    input.name || '',
  ]);
}

async function loadReceipt(companyId, customerId, key, fingerprint, exec = db) {
  if (receiptsTableAvailable === false) return null;
  try {
    if (key) {
      const { rows } = await exec.query(
        `SELECT result FROM credit_reschedule_receipts
          WHERE company_id = $1 AND idempotency_key = $2
          LIMIT 1`,
        [companyId, key]
      );
      receiptsTableAvailable = true;
      if (rows[0]?.result) return rows[0].result;
    }
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

function sendMergeError(res, err) {
  return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
}

// ---------------------------------------------------------------
// GET /customers/:cid/accounts/merge/preview
// ---------------------------------------------------------------
router.get('/customers/:cid/accounts/merge/preview', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const input = parseInput(req.query);

  try {
    if (!(await findOwnerScopedCustomer(db, companyId, customerId))) {
      return res.status(404).json(CUSTOMER_NOT_FOUND_BODY);
    }
  } catch (err) {
    console.error('[creditMerge] preview customer check:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao verificar cliente' });
  }

  try {
    const period = await resolveStorePeriod(companyId);
    const plan = await mergeCarnes.previewMerge(db, {
      companyId, customerId,
      accountIds:   input.accountIds,
      total:        input.total,
      installments: input.installments,
      firstDueDate: input.firstDueDate,
      periodUnit:   input.periodUnit  || period.periodUnit,
      periodCount:  input.periodCount || period.periodCount,
      name:         input.name,
    });
    return res.status(200).json(plan);
  } catch (err) {
    if (err.isMergeError) return sendMergeError(res, err);
    console.error('[creditMerge] preview error:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao calcular a juncao dos carnes' });
  }
});

// ---------------------------------------------------------------
// POST /customers/:cid/accounts/merge
// ---------------------------------------------------------------
router.post('/customers/:cid/accounts/merge', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const input = parseInput(req.body);
  const idempotencyKey = req.headers['idempotency-key']
    ? String(req.headers['idempotency-key']).trim()
    : null;
  const startedAt = Date.now();

  // Recusas que nao dependem do banco saem antes de qualquer consulta.
  if (input.accountIds.length < 2) {
    return res.status(400).json({ error: 'Escolha pelo menos dois carnes para juntar.', code: 'MERGE_NEEDS_TWO' });
  }
  try {
    mergeCarnes.validateTerms(input);
  } catch (err) {
    if (err.isMergeError) return sendMergeError(res, err);
    throw err;
  }

  try {
    if (!(await findOwnerScopedCustomer(db, companyId, customerId))) {
      return res.status(404).json(CUSTOMER_NOT_FOUND_BODY);
    }
  } catch (err) {
    console.error('[creditMerge] apply customer check:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao verificar cliente' });
  }

  try {
    await assertCrediarioEnabled(companyId);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }

  // Replay ANTES de qualquer escrita (chave e, depois, impressao digital).
  const fingerprint = mergeFingerprint(input);
  try {
    const prior = await loadReceipt(companyId, customerId, idempotencyKey, fingerprint);
    if (prior) {
      console.info('[creditMerge] replay', JSON.stringify({ companyId, customerId }));
      return res.status(200).json({ ...prior, replayed: true });
    }
  } catch (err) {
    console.error('[creditMerge] replay check:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao verificar juncao anterior' });
  }

  const period = await resolveStorePeriod(companyId).catch(() => ({ periodUnit: 'month', periodCount: 1 }));

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Mesmo lock da renegociacao (mesma chave): juncao e renegociacao do
    // mesmo cliente nunca correm juntas -- as duas reescrevem cronograma.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [companyId + ':' + customerId]);

    // Re-checagem DENTRO da transacao (o vencedor da corrida ja commitou).
    const priorInTx = await loadReceipt(companyId, customerId, idempotencyKey, fingerprint, client);
    if (priorInTx) {
      await client.query('ROLLBACK');
      return res.status(200).json({ ...priorInTx, replayed: true });
    }

    const result = await mergeCarnes.applyMerge(client, {
      companyId, customerId,
      accountIds:   input.accountIds,
      total:        input.total,
      installments: input.installments,
      firstDueDate: input.firstDueDate,
      periodUnit:   input.periodUnit  || period.periodUnit,
      periodCount:  input.periodCount || period.periodCount,
      name:         input.name,
      createdBy:    req.user?.id || null,
    });

    // Recibo na MESMA transacao. SAVEPOINT: tabela ausente (migration 300
    // pendente) nao aborta a juncao.
    let duplicateKey = false;
    if (receiptsTableAvailable !== false) {
      const receiptKey = idempotencyKey || ('auto-' + randomUUID());
      await client.query('SAVEPOINT merge_receipt');
      try {
        await client.query(
          `INSERT INTO credit_reschedule_receipts
             (company_id, customer_id, account_id, idempotency_key, fingerprint, result)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [companyId, customerId, result.account.id, receiptKey, fingerprint, JSON.stringify(result)]
        );
        receiptsTableAvailable = true;
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT merge_receipt');
        if (e.code === '23505') duplicateKey = true;
        else if (e.code === '42P01' || e.code === '42703') receiptsTableAvailable = false;
        else throw e;
      }
    }

    if (duplicateKey) {
      // Outra requisicao com a mesma chave venceu: desfaz esta e devolve a dela.
      await client.query('ROLLBACK');
      const prior = await loadReceipt(companyId, customerId, idempotencyKey, fingerprint);
      if (prior) return res.status(200).json({ ...prior, replayed: true });
      return res.status(409).json({
        error: 'Juncao ja em andamento para esta chave. Recarregue a ficha.',
        code:  'MERGE_IN_FLIGHT',
      });
    }

    await client.query('COMMIT');
    console.info('[creditMerge] aplicado', JSON.stringify({
      companyId, customerId,
      destino:      result.account.id,
      origens:      result.merged_account_ids.length + (result.included_general ? 1 : 0),
      installments: result.installments_count,
      total:        result.target_total,
      adjustment:   result.adjustment?.type || null,
      idempotent:   Boolean(idempotencyKey),
      ms:           Date.now() - startedAt,
    }));
    return res.status(200).json(result);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err.isMergeError) return sendMergeError(res, err);
    console.error('[creditMerge] apply error:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao juntar os carnes' });
  } finally {
    client.release();
  }
});

module.exports = router;
