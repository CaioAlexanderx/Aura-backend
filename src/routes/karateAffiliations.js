// ============================================================
// AURA KARATÊ — Filiação de dojô (pré-aceite antes do pagamento), lado federação.
// Montado em /federation/:id. Migration 186 (karate_affiliation_requests).
//
// Fluxo DECIDIDO:
//   solicitada → em_análise → (aprovada → aguardando_pagamento → PIX → ativa)
//                            | recusada(motivo)
//
//   GET  /federation/:id/affiliation-requests              — inbox (read)
//   GET  /federation/:id/affiliation-requests/:reqId       — detalhe (read)
//   POST /federation/:id/affiliation-requests/:reqId/approve  (adminOnly)
//        → cria a company do dojô (is_active=false) + gera FPKT-NNN + lança a
//          1ª anuidade (pending) + status=awaiting_payment. A ATIVAÇÃO ocorre
//          no confirm do pagamento (hook idempotente em karateAnnuities).
//   POST /federation/:id/affiliation-requests/:reqId/reject   (adminOnly)
//        → status=rejected + motivo (feedback).
//
// A SOLICITAÇÃO em si é pública (microsite) — ver karateAffiliationsPublic.js.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { nextDojoAffiliationId, computeDojoStatus } = require('../services/karateService');

function shapeRequest(r) {
  return {
    id: r.id,
    federation_id: r.federation_id,
    dojo_id: r.dojo_id || null,
    dojo_name: r.dojo_name,
    cnpj: r.cnpj || null,
    sensei_name: r.sensei_name || null,
    sensei_cpf: r.sensei_cpf || null,
    contact_email: r.contact_email || null,
    contact_phone: r.contact_phone || null,
    region: r.region || null,
    affiliation_model: r.affiliation_model || null,
    status: r.status,
    fpkt_affiliation_id: r.fpkt_affiliation_id || null,
    annuity_history_id: r.annuity_history_id || null,
    rejection_reason: r.rejection_reason || null,
    reviewed_at: r.reviewed_at || null,
    activated_at: r.activated_at || null,
    created_at: r.created_at,
  };
}

// ── GET /affiliation-requests — inbox ───────────────────────
router.get('/affiliation-requests', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { status } = req.query;
  try {
    const params = [federationId];
    let where = `WHERE federation_id = $1`;
    if (status) { params.push(status); where += ` AND status = $2`; }
    const { rows } = await db.query(
      `SELECT * FROM karate_affiliation_requests ${where} ORDER BY created_at DESC LIMIT 200`,
      params
    );
    res.json({ requests: rows.map(shapeRequest), count: rows.length });
  } catch (err) {
    if (err.code === '42P01') return res.json({ requests: [], count: 0 });
    console.error('[karateAffiliations] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar solicitações' });
  }
});

// ── GET /affiliation-requests/:reqId — detalhe ──────────────
router.get('/affiliation-requests/:reqId', ...guards.read(), async (req, res) => {
  const { id: federationId, reqId } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT * FROM karate_affiliation_requests WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [reqId, federationId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Solicitação não encontrada', code: 'NOT_FOUND' });
    res.json(shapeRequest(rows[0]));
  } catch (err) {
    console.error('[karateAffiliations] detail error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar solicitação' });
  }
});

// ── POST /affiliation-requests/:reqId/approve ───────────────
// Cria o dojô (inativo) + 1ª anuidade (pending) + status=awaiting_payment.
router.post('/affiliation-requests/:reqId/approve', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, reqId } = req.params;
  const { amount, due_date } = req.body || {};
  const reference_period = req.body?.reference_period || String(new Date().getFullYear());

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(422).json({ error: 'amount (1ª anuidade) obrigatório e > 0', code: 'VALIDATION_ERROR' });
  }
  if (!due_date) {
    return res.status(422).json({ error: 'due_date (1ª anuidade) obrigatório', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const reqRes = await client.query(
      `SELECT * FROM karate_affiliation_requests
        WHERE id = $1 AND federation_id = $2 FOR UPDATE`,
      [reqId, federationId]
    );
    if (!reqRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Solicitação não encontrada', code: 'NOT_FOUND' });
    }
    const reqRow = reqRes.rows[0];
    if (!['requested', 'under_review'].includes(reqRow.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Solicitação já está em '${reqRow.status}'`, code: 'CONFLICT' });
    }

    const model = reqRow.affiliation_model || 'annual';

    // 1) Cria a company do dojô — INATIVA (ativa só no pagamento).
    const fpktId = await nextDojoAffiliationId(client, federationId);
    const dojoRes = await client.query(
      `INSERT INTO companies
         (name, cnpj, sensei_cpf, region, fpkt_affiliation_id, affiliation_model,
          affiliation_since, phone, email, federation_id,
          vertical, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, 'karate_dojo', false, NOW(), NOW())
       RETURNING id, name`,
      [reqRow.dojo_name, reqRow.cnpj || null, reqRow.sensei_cpf || null, reqRow.region || null,
       fpktId, model, reqRow.contact_phone || null, reqRow.contact_email || null, federationId]
    );
    const dojoId = dojoRes.rows[0].id;

    // 2) Lança a 1ª anuidade (transaction pending + annuity_history pending).
    const idempotencyKey = `dojo-annuity-${dojoId}-${reference_period}`;
    const txRes = await client.query(
      `INSERT INTO transactions
         (company_id, type, category, amount, status, due_date,
          description, idempotency_key, reference_type, reference_id,
          federation_id, created_at, updated_at)
       VALUES ($1, 'income', 'annuity_dojo', $2, 'pending', $3,
               $4, $5, 'karate_dojo', $6, $7, NOW(), NOW())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [federationId, Number(amount), due_date,
       `Anuidade dojô ${dojoRes.rows[0].name} — ${reference_period} (filiação)`,
       idempotencyKey, dojoId, federationId]
    );
    let transactionId = txRes.rows[0]?.id;
    if (!transactionId) {
      const ex = await client.query(`SELECT id FROM transactions WHERE idempotency_key = $1`, [idempotencyKey]);
      transactionId = ex.rows[0]?.id;
    }

    const histRes = await client.query(
      `INSERT INTO karate_dojo_annuity_history
         (dojo_id, federation_id, reference_period, amount, due_date, status, transaction_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW())
       RETURNING id`,
      [dojoId, federationId, reference_period, Number(amount), due_date, transactionId]
    );
    const annuityHistoryId = histRes.rows[0].id;

    // 3) Atualiza a solicitação → aguardando_pagamento.
    await client.query(
      `UPDATE karate_affiliation_requests
          SET status = 'awaiting_payment', dojo_id = $1, annuity_history_id = $2,
              fpkt_affiliation_id = $3, affiliation_model = $4,
              reviewed_by = $5, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $6`,
      [dojoId, annuityHistoryId, fpktId, model, req.user?.id || null, reqId]
    );

    await client.query('COMMIT');

    res.json({
      id: reqId,
      status: 'awaiting_payment',
      dojo_id: dojoId,
      fpkt_affiliation_id: fpktId,
      annuity_history_id: annuityHistoryId,
      first_annuity: { amount: Number(amount), reference_period, due_date, status: 'pending' },
      _note: 'Dojô criado inativo. O pagamento da 1ª anuidade ativa a filiação (hook no confirm).',
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[karateAffiliations] approve error:', err.message);
    res.status(500).json({ error: 'Erro ao aprovar filiação', detail: err.message });
  } finally {
    client.release();
  }
});

// ── POST /affiliation-requests/:reqId/reject ────────────────
router.post('/affiliation-requests/:reqId/reject', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, reqId } = req.params;
  const { reason } = req.body || {};
  try {
    const { rows } = await db.query(
      `UPDATE karate_affiliation_requests
          SET status = 'rejected', rejection_reason = $1,
              reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $3 AND federation_id = $4
          AND status IN ('requested','under_review')
        RETURNING id`,
      [reason || null, req.user?.id || null, reqId, federationId]
    );
    if (!rows.length) {
      return res.status(409).json({ error: 'Solicitação não encontrada ou não pode ser recusada', code: 'CONFLICT' });
    }
    res.json({ id: reqId, status: 'rejected', rejection_reason: reason || null });
  } catch (err) {
    console.error('[karateAffiliations] reject error:', err.message);
    res.status(500).json({ error: 'Erro ao recusar filiação' });
  }
});

module.exports = router;
