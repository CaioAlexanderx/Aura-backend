// ============================================================
// AURA KARATÊ — Rotas de Anuidades (Track B)
//
// Anuidades Dojô:
//   GET  /financial/annuities/dojos                    — lista c/ status
//   POST /financial/annuities/dojos/:dojoId/charge     — lança cobrança
//   POST /financial/annuities/dojos/:dojoId/pix        — cria intent PIX
//   GET  /financial/payments/:intentId/status          — polling de status
//   POST /financial/payments/:intentId/confirm         — admin marca pago + NFS-e
//
// Anuidades CPF:
//   GET  /financial/annuities/cpf                      — lista praticantes
//   POST /financial/annuities/cpf/:practitionerId/charge
//   POST /financial/annuities/cpf/:practitionerId/pix
//
// Guards: adminOnly() em todas as rotas (RBAC §7.3).
// Idempotência via transactions.idempotency_key.
// Status do dojô deriva de karate_dojo_annuity_history (migration 152).
// ============================================================
'use strict';

const router  = require('express').Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db      = require('../config/database');
const { guards } = require('../config/karateRoles');
const { getDojoAnnuityStatus, computeAnnuityStatus } = require('../services/karateFinanceService');
const { createPixCharge, getStatus: providerGetStatus } = require('../services/karatePaymentProvider');

// ─────────────────────────────────────────────────────────────
// DOJO ANNUITIES
// ─────────────────────────────────────────────────────────────

// GET /financial/annuities/dojos
router.get('/annuities/dojos', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { status } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;
  const year     = new Date().getFullYear().toString();

  try {
    // Busca dojôs + sua cobrança do ano (via karate_dojo_annuity_history)
    const { rows: dojos } = await db.query(
      `SELECT
         c.id AS dojo_id, c.name AS dojo_name, c.fpkt_affiliation_id,
         h.id AS annuity_id, h.reference_period, h.amount, h.due_date,
         h.paid_at, h.status AS annuity_status, h.transaction_id
       FROM companies c
       LEFT JOIN karate_dojo_annuity_history h
         ON h.dojo_id = c.id AND h.reference_period = $2
       WHERE c.federation_id = $1 AND c.vertical = 'karate_dojo'
       ORDER BY c.fpkt_affiliation_id ASC NULLS LAST, c.name ASC`,
      [federationId, year]
    );

    const dayMs = 1000 * 60 * 60 * 24;
    const now = new Date();

    let enriched = dojos.map(d => {
      const computedStatus = computeAnnuityStatus(
        d.annuity_id ? { status: d.annuity_status, due_date: d.due_date } : null
      );
      const daysOverdue = (d.due_date && computedStatus !== 'paid' && computedStatus !== 'due')
        ? Math.max(0, Math.round((now - new Date(d.due_date)) / dayMs))
        : 0;
      return {
        dojo_id: d.dojo_id,
        dojo_name: d.dojo_name,
        fpkt_affiliation_id: d.fpkt_affiliation_id || null,
        amount: d.amount ? parseFloat(d.amount) : 0,
        reference_period: d.reference_period || year,
        due_date: d.due_date || null,
        paid_at: d.paid_at || null,
        status: computedStatus,
        days_overdue: daysOverdue,
        nfse_id: null, // populated from transaction if needed
      };
    });

    // Filter by status if requested
    if (status) {
      enriched = enriched.filter(d => d.status === status);
    }

    const total = enriched.length;
    const data  = enriched.slice(offset, offset + pageSize);

    res.json({ page, page_size: pageSize, total, data });
  } catch (err) {
    console.error('[karateAnnuities] list dojos error:', err.message);
    res.status(500).json({ error: 'Erro ao listar anuidades de dojôs' });
  }
});

// POST /financial/annuities/dojos/:dojoId/charge
// Cria cobrança: INSERT em karate_dojo_annuity_history + transactions (pending)
router.post('/annuities/dojos/:dojoId/charge', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const { amount, due_date, reference_period } = req.body;

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(422).json({ error: 'amount obrigatorio e deve ser > 0', code: 'VALIDATION_ERROR' });
  }
  if (!due_date) {
    return res.status(422).json({ error: 'due_date obrigatorio', code: 'VALIDATION_ERROR' });
  }
  if (!reference_period) {
    return res.status(422).json({ error: 'reference_period obrigatorio', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica dojô
    const dojoRes = await client.query(
      `SELECT id, name FROM companies WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
      [dojoId, federationId]
    );
    if (!dojoRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }

    // Advisory lock por dojô para evitar cobrança dupla
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text || '-annuity-' || $2::text))`,
      [dojoId, reference_period]
    );

    // Verifica se já existe cobrança para esse período
    const existingRes = await client.query(
      `SELECT id FROM karate_dojo_annuity_history WHERE dojo_id = $1 AND reference_period = $2 LIMIT 1`,
      [dojoId, reference_period]
    );
    if (existingRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Já existe cobrança para este dojô no período ' + reference_period,
        code: 'CONFLICT',
      });
    }

    // Cria transaction (pending)
    const idempotencyKey = `dojo-annuity-${dojoId}-${reference_period}`;
    const txRes = await client.query(
      `INSERT INTO transactions
         (company_id, type, category, amount, status, due_date,
          description, idempotency_key, reference_type, reference_id,
          federation_id, created_at, updated_at)
       VALUES ($1, 'income', 'annuity_dojo', $2, 'pending', $3,
               $4, $5, 'karate_dojo', $6,
               $7, NOW(), NOW())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        federationId,
        Number(amount),
        due_date,
        `Anuidade dojô ${dojoRes.rows[0].name} — ${reference_period}`,
        idempotencyKey,
        dojoId,
        federationId,
      ]
    );

    // Idempotência: se já existe, busca o existente
    let transactionId;
    if (!txRes.rows.length) {
      const existing = await client.query(
        `SELECT id FROM transactions WHERE idempotency_key = $1`, [idempotencyKey]
      );
      transactionId = existing.rows[0]?.id;
    } else {
      transactionId = txRes.rows[0].id;
    }

    // Cria registro em karate_dojo_annuity_history
    const histRes = await client.query(
      `INSERT INTO karate_dojo_annuity_history
         (dojo_id, federation_id, reference_period, amount, due_date, status, transaction_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW())
       RETURNING id, dojo_id, reference_period, amount, due_date, status, paid_at`,
      [dojoId, federationId, reference_period, Number(amount), due_date, transactionId]
    );

    await client.query('COMMIT');

    const h = histRes.rows[0];
    res.status(201).json({
      dojo_id: dojoId,
      dojo_name: dojoRes.rows[0].name,
      fpkt_affiliation_id: null,
      amount: parseFloat(h.amount),
      reference_period: h.reference_period,
      due_date: h.due_date,
      paid_at: h.paid_at,
      status: 'due',
      days_overdue: 0,
      nfse_id: null,
      transaction_id: transactionId,
      annuity_history_id: h.id,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateAnnuities] charge error:', err.message);
    res.status(500).json({ error: 'Erro ao lançar cobrança', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /financial/annuities/dojos/:dojoId/pix
// Cria PIX intent para cobrança de dojô, salva em karate_payment_intents.
router.post('/annuities/dojos/:dojoId/pix', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const { annuity_history_id } = req.body;

  if (!annuity_history_id) {
    return res.status(422).json({ error: 'annuity_history_id obrigatorio', code: 'VALIDATION_ERROR' });
  }

  try {
    // Busca a cobrança
    const { rows } = await db.query(
      `SELECT h.*, c.name AS dojo_name
       FROM karate_dojo_annuity_history h
       JOIN companies c ON c.id = h.dojo_id
       WHERE h.id = $1 AND h.dojo_id = $2 AND h.federation_id = $3
       LIMIT 1`,
      [annuity_history_id, dojoId, federationId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Cobrança não encontrada', code: 'NOT_FOUND' });
    }
    const annuity = rows[0];
    if (annuity.status === 'paid') {
      return res.status(409).json({ error: 'Anuidade já paga', code: 'CONFLICT' });
    }

    // Verifica se já existe intent ativo
    const { rows: existingIntents } = await db.query(
      `SELECT id, payment_intent_id, payload, qr_image, status, expires_at, provider
       FROM karate_payment_intents
       WHERE annuity_history_id = $1 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [annuity_history_id]
    );
    if (existingIntents.length) {
      const intent = existingIntents[0];
      return res.json({
        intent_id: intent.id,
        payment_intent_id: intent.payment_intent_id,
        payload: intent.payload,
        qr_image: intent.qr_image,
        status: intent.status,
        expires_at: intent.expires_at,
        provider: intent.provider,
      });
    }

    const txid = `dojo-${dojoId.slice(0, 8)}-${annuity.reference_period}`;
    const pixResult = await createPixCharge({
      federationId,
      amount: parseFloat(annuity.amount),
      txid,
      description: `Anuidade ${annuity.dojo_name} — ${annuity.reference_period}`,
    });

    // Salva intent
    const { rows: intentRows } = await db.query(
      `INSERT INTO karate_payment_intents
         (federation_id, annuity_history_id, transaction_id, provider,
          payment_intent_id, payload, qr_image, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, NOW())
       RETURNING id`,
      [
        federationId,
        annuity_history_id,
        annuity.transaction_id,
        pixResult.provider,
        pixResult.payment_intent_id,
        pixResult.payload,
        pixResult.qr_image || null,
        pixResult.expires_at,
      ]
    );

    res.status(201).json({
      intent_id: intentRows[0].id,
      payment_intent_id: pixResult.payment_intent_id,
      payload: pixResult.payload,
      qr_image: pixResult.qr_image,
      status: pixResult.status,
      expires_at: pixResult.expires_at,
      provider: pixResult.provider,
      _warn: pixResult._warn,
    });
  } catch (err) {
    console.error('[karateAnnuities] pix error:', err.message);
    res.status(500).json({ error: 'Erro ao criar PIX intent', detail: err.message });
  }
});

// GET /financial/payments/:intentId/status
// Polling: consulta status do intent no provider.
router.get('/payments/:intentId/status', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, intentId } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT id, payment_intent_id, provider, status, expires_at, paid_at
       FROM karate_payment_intents
       WHERE id = $1 AND federation_id = $2
       LIMIT 1`,
      [intentId, federationId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Intent não encontrado', code: 'NOT_FOUND' });
    }

    const intent = rows[0];

    // Para static_brcode: status é sempre 'pending' até confirm manual.
    // Para Asaas: consulta o provider.
    let liveStatus = intent.status;
    let paid_at = intent.paid_at;

    if (intent.status === 'pending') {
      try {
        const ps = await providerGetStatus({ payment_intent_id: intent.payment_intent_id });
        liveStatus = ps.status;
        paid_at = ps.paid_at;
      } catch (_) {
        // Falha no provider: retorna cached status
      }
    }

    res.json({
      intent_id: intent.id,
      payment_intent_id: intent.payment_intent_id,
      provider: intent.provider,
      status: liveStatus,
      expires_at: intent.expires_at,
      paid_at: paid_at || null,
    });
  } catch (err) {
    console.error('[karateAnnuities] payment status error:', err.message);
    res.status(500).json({ error: 'Erro ao consultar status' });
  }
});

// POST /financial/payments/:intentId/confirm
// Admin confirma pagamento manualmente (ou webhook futuro chama este endpoint).
// Reconcilia transaction (status=paid) + atualiza annuity_history + emite NFS-e.
router.post('/payments/:intentId/confirm', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, intentId } = req.params;
  const { paid_at, emit_nfse = true } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Busca intent
    const intentRes = await client.query(
      `SELECT kpi.*, kdah.dojo_id, kdah.reference_period, kdah.amount AS annuity_amount,
              kdah.status AS annuity_status
       FROM karate_payment_intents kpi
       JOIN karate_dojo_annuity_history kdah ON kdah.id = kpi.annuity_history_id
       WHERE kpi.id = $1 AND kpi.federation_id = $2
       LIMIT 1`,
      [intentId, federationId]
    );
    if (!intentRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Intent não encontrado', code: 'NOT_FOUND' });
    }

    const intent = intentRes.rows[0];
    if (intent.status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Pagamento já confirmado', code: 'CONFLICT', idempotent_hit: true });
    }

    const paidAt = paid_at || new Date().toISOString();

    // Atualiza intent
    await client.query(
      `UPDATE karate_payment_intents SET status = 'paid', paid_at = $1, updated_at = NOW() WHERE id = $2`,
      [paidAt, intentId]
    );

    // Atualiza karate_dojo_annuity_history
    await client.query(
      `UPDATE karate_dojo_annuity_history
       SET status = 'paid', paid_at = $1, updated_at = NOW()
       WHERE id = $2`,
      [paidAt, intent.annuity_history_id]
    );

    // Reconcilia transaction
    let nfseId = null;
    if (intent.transaction_id) {
      await client.query(
        `UPDATE transactions
         SET status = 'paid', paid_at = $1, updated_at = NOW()
         WHERE id = $2`,
        [paidAt, intent.transaction_id]
      );

      // Emite NFS-e se solicitado
      if (emit_nfse) {
        try {
          // Verifica se já tem nfse_id
          const txRes = await client.query(
            `SELECT nfe_id FROM transactions WHERE id = $1`, [intent.transaction_id]
          );
          if (!txRes.rows[0]?.nfe_id) {
            // NFS-e: insere registro pendente (provider chamado assincronamente)
            const nfseInsert = await client.query(
              `INSERT INTO nfse
                 (company_id, payment_id, source_type, status,
                  service_amount, service_description,
                  recipient_name, recipient_doc,
                  rps_number, rps_serie, provider, created_at)
               SELECT
                 t.company_id, t.id, 'karate_annuity', 'pendente',
                 t.amount, t.description,
                 co.name, COALESCE(co.cnpj, 'nao-informado'),
                 nfse_next_rps(t.company_id), '1', 'mock', NOW()
               FROM transactions t
               JOIN companies co ON co.id = (SELECT dojo_id FROM karate_dojo_annuity_history WHERE transaction_id = t.id LIMIT 1)
               WHERE t.id = $1
               RETURNING id`,
              [intent.transaction_id]
            );
            if (nfseInsert.rows.length) {
              nfseId = nfseInsert.rows[0].id;
              await client.query(
                `UPDATE transactions SET nfe_id = $1 WHERE id = $2`,
                [nfseId, intent.transaction_id]
              );
            }
          } else {
            nfseId = txRes.rows[0].nfe_id;
          }
        } catch (nfseErr) {
          // NFS-e é best-effort: não bloqueia confirmação
          console.warn('[karateAnnuities] nfse insert failed (best-effort):', nfseErr.message);
        }
      }
    }

    await client.query('COMMIT');

    res.json({
      intent_id: intentId,
      transaction_id: intent.transaction_id,
      status: 'paid',
      paid_at: paidAt,
      nfse_id: nfseId,
      idempotent_hit: false,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateAnnuities] confirm error:', err.message);
    res.status(500).json({ error: 'Erro ao confirmar pagamento', detail: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────
// CPF ANNUITIES
// ─────────────────────────────────────────────────────────────

// GET /financial/annuities/cpf
router.get('/annuities/cpf', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { status } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;
  const year     = new Date().getFullYear().toString();

  try {
    // Praticantes + sua cobrança anual (transactions com reference_type=customer)
    const { rows } = await db.query(
      `SELECT
         cu.id AS practitioner_id,
         COALESCE(cu.full_name, cu.name) AS full_name,
         cu.karate_registration_number,
         t.id AS transaction_id,
         t.amount,
         t.due_date,
         t.status AS tx_status,
         t.paid_at
       FROM customers cu
       LEFT JOIN transactions t
         ON t.reference_type = 'customer'
         AND t.reference_id = cu.id::text
         AND t.category = 'annuity_cpf'
         AND EXTRACT(YEAR FROM t.due_date) = $2
         AND t.federation_id = $1
       WHERE cu.federation_id = $1
       ORDER BY cu.karate_registration_number ASC NULLS LAST, full_name ASC`,
      [federationId, parseInt(year, 10)]
    );

    const dayMs = 1000 * 60 * 60 * 24;
    const now = new Date();

    let enriched = rows.map(r => {
      let annuityStatus = 'due';
      if (!r.transaction_id) annuityStatus = 'suspended';
      else if (r.tx_status === 'paid') annuityStatus = 'paid';
      else if (r.due_date) {
        const daysUntil = Math.round((new Date(r.due_date) - now) / dayMs);
        if (daysUntil >= 0) annuityStatus = 'due';
        else {
          const daysOver = Math.abs(daysUntil);
          annuityStatus = daysOver <= 90 ? 'overdue' : daysOver <= 180 ? 'defaulting' : 'suspended';
        }
      }

      return {
        practitioner_id: r.practitioner_id,
        full_name: r.full_name,
        karate_registration_number: r.karate_registration_number || null,
        amount: r.amount ? parseFloat(r.amount) : 0,
        reference_period: year,
        due_date: r.due_date || null,
        paid_at: r.paid_at || null,
        status: annuityStatus,
      };
    });

    if (status) enriched = enriched.filter(p => p.status === status);

    const total = enriched.length;
    const data  = enriched.slice(offset, offset + pageSize);

    res.json({ page, page_size: pageSize, total, data });
  } catch (err) {
    console.error('[karateAnnuities] list cpf error:', err.message);
    res.status(500).json({ error: 'Erro ao listar anuidades CPF' });
  }
});

// POST /financial/annuities/cpf/:practitionerId/charge
router.post('/annuities/cpf/:practitionerId/charge', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  const { amount, due_date, reference_period } = req.body;

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(422).json({ error: 'amount obrigatorio e deve ser > 0', code: 'VALIDATION_ERROR' });
  }
  if (!due_date) {
    return res.status(422).json({ error: 'due_date obrigatorio', code: 'VALIDATION_ERROR' });
  }
  if (!reference_period) {
    return res.status(422).json({ error: 'reference_period obrigatorio', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const practRes = await client.query(
      `SELECT id, COALESCE(full_name, name) AS full_name, cpf_cnpj
       FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [practitionerId, federationId]
    );
    if (!practRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    const pract = practRes.rows[0];
    const idempotencyKey = `cpf-annuity-${practitionerId}-${reference_period}`;

    const txRes = await client.query(
      `INSERT INTO transactions
         (company_id, type, category, amount, status, due_date,
          description, idempotency_key, reference_type, reference_id,
          federation_id, created_at, updated_at)
       VALUES ($1, 'income', 'annuity_cpf', $2, 'pending', $3,
               $4, $5, 'customer', $6,
               $7, NOW(), NOW())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        federationId,
        Number(amount),
        due_date,
        `Anuidade CPF ${pract.full_name} — ${reference_period}`,
        idempotencyKey,
        practitionerId,
        federationId,
      ]
    );

    let transactionId;
    if (!txRes.rows.length) {
      const ex = await client.query(
        `SELECT id FROM transactions WHERE idempotency_key = $1`, [idempotencyKey]
      );
      transactionId = ex.rows[0]?.id;
    } else {
      transactionId = txRes.rows[0].id;
    }

    await client.query('COMMIT');

    res.status(201).json({
      practitioner_id: practitionerId,
      full_name: pract.full_name,
      amount: Number(amount),
      reference_period,
      due_date,
      paid_at: null,
      status: 'due',
      transaction_id: transactionId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateAnnuities] cpf charge error:', err.message);
    res.status(500).json({ error: 'Erro ao lançar cobrança CPF', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /financial/annuities/cpf/:practitionerId/pix
router.post('/annuities/cpf/:practitionerId/pix', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  const { transaction_id } = req.body;

  if (!transaction_id) {
    return res.status(422).json({ error: 'transaction_id obrigatorio', code: 'VALIDATION_ERROR' });
  }

  try {
    const { rows: txRows } = await db.query(
      `SELECT t.*, cu.full_name AS pract_name
       FROM transactions t
       JOIN customers cu ON cu.id = $2
       WHERE t.id = $1 AND t.federation_id = $3 AND t.reference_id = $2::text
       LIMIT 1`,
      [transaction_id, practitionerId, federationId]
    );
    if (!txRows.length) {
      return res.status(404).json({ error: 'Cobrança não encontrada', code: 'NOT_FOUND' });
    }
    const tx = txRows[0];
    if (tx.status === 'paid') {
      return res.status(409).json({ error: 'Anuidade já paga', code: 'CONFLICT' });
    }

    const txid = `cpf-${practitionerId.slice(0, 8)}-${tx.description?.match(/(\d{4})/) ? tx.description.match(/(\d{4})/)[1] : 'anual'}`;
    const pixResult = await createPixCharge({
      federationId,
      amount: parseFloat(tx.amount),
      txid,
      description: `Anuidade ${tx.pract_name}`,
    });

    // Salva intent sem annuity_history_id (CPF não usa essa tabela)
    const { rows: intentRows } = await db.query(
      `INSERT INTO karate_payment_intents
         (federation_id, transaction_id, provider,
          payment_intent_id, payload, qr_image, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW())
       RETURNING id`,
      [
        federationId,
        transaction_id,
        pixResult.provider,
        pixResult.payment_intent_id,
        pixResult.payload,
        pixResult.qr_image || null,
        pixResult.expires_at,
      ]
    );

    res.status(201).json({
      intent_id: intentRows[0].id,
      payment_intent_id: pixResult.payment_intent_id,
      payload: pixResult.payload,
      qr_image: pixResult.qr_image,
      status: pixResult.status,
      expires_at: pixResult.expires_at,
      provider: pixResult.provider,
    });
  } catch (err) {
    console.error('[karateAnnuities] cpf pix error:', err.message);
    res.status(500).json({ error: 'Erro ao criar PIX intent CPF', detail: err.message });
  }
});

module.exports = router;
