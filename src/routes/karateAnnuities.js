// ============================================================
// AURA KARATÊ — Rotas de Anuidades (Track B)
//
// Anuidades Dojô:
//   GET   /financial/annuities/dojos                    — lista c/ status
//   POST  /financial/annuities/dojos/:dojoId/charge     — lança cobrança
//   PATCH /financial/annuities/dojos/:dojoId/:annuityId — corrige cobrança NÃO paga
//   POST  /financial/annuities/dojos/:dojoId/:annuityId/void — estorna/cancela cobrança
//   POST  /financial/annuities/dojos/:dojoId/:annuityId/pay  — baixa manual de cobrança existente
//   POST  /financial/annuities/dojos/:dojoId/pay        — lança + baixa em um passo (período já pago)
//   POST  /financial/annuities/dojos/:dojoId/pix        — cria intent PIX
//   GET   /financial/payments/:intentId/status          — polling de status
//   POST  /financial/payments/:intentId/confirm         — admin marca pago + NFS-e
//
// Anuidades CPF:
//   GET  /financial/annuities/cpf                      — lista praticantes
//   POST /financial/annuities/cpf/:practitionerId/charge
//   POST /financial/annuities/cpf/:practitionerId/pix
//
// Guards: adminOnly() em todas as rotas (RBAC §7.3).
// Idempotência via transactions.idempotency_key.
// Status do dojô deriva de karate_dojo_annuity_history (migration 152).
// NFS-e: usa nfe_documents + fiscal.emitNfse (mesma tabela/serviço de nfe.js).
//        Emissão dedicada disponível em karateNfse.js.
//
// NOTA DE SCHEMA (23/06): transactions.status é o enum transaction_status
// (pending/confirmed/cancelled). "Recebido/pago" = 'confirmed'.
// transactions.reference_id é uuid: comparar com customers.id (uuid) sem ::text.
// (karate_dojo_annuity_history.status é TEXTO e usa 'paid' — mantido.)
//
// NOTA DE SCHEMA (25/06 — DOJO-RM): correção/estorno de lançamento de anuidade.
//   karate_dojo_annuity_history.status é TEXTO e o vocabulário em uso é
//   'pending'/'paid'/'overdue' (não há 'cancelled' reconhecido por
//   computeAnnuityStatus). Por isso o VOID APAGA a linha de
//   karate_dojo_annuity_history (volta ao estado "sem cobrança no período",
//   recobrável) e CANCELA a transaction conciliada (status='cancelled',
//   preservando a trilha financeira — a transaction NÃO é apagada).
//   karate_payment_intents.annuity_history_id é SET NULL → intents pendentes
//   ficam órfãos mas são marcados 'cancelled' aqui. Operação idempotente.
//
// NOTA (27/06 — BAIXA MANUAL):
//   POST .../dojos/:dojoId/:annuityId/pay — baixa manual de cobrança existente.
//   POST .../dojos/:dojoId/pay            — lança período já pago em um passo.
//   Ambos requerem migration 194 (payment_method TEXT em karate_dojo_annuity_history).
//   Conciliação de transaction: idêntica ao /confirm (status='confirmed', paid_at).
//   Idempotente: se a anuidade já está 'paid', retorna 200 sem efeito colateral.
// ============================================================
'use strict';

const router  = require('express').Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db      = require('../config/database');
const fiscal  = require('../services/nuvemfiscal');
const { guards } = require('../config/karateRoles');
const { getDojoAnnuityStatus, computeAnnuityStatus } = require('../services/karateFinanceService');
const { createPixCharge, getStatus: providerGetStatus } = require('../services/karatePaymentProvider');

// ────────────────────────────────────────────────────────────────
const DOJO_ANNUITIES = true; // eslint-disable-line
// ────────────────────────────────────────────────────────────────
// DOJO ANNUITIES
// ────────────────────────────────────────────────────────────────

// GET /financial/annuities/dojos
router.get('/annuities/dojos', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { status } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;
  const year     = (req.query.year && /^\d{4}$/.test(String(req.query.year)))
    ? String(req.query.year)
    : new Date().getFullYear().toString();

  try {
    // Busca dojôs + sua cobrança do ano (via karate_dojo_annuity_history)
    const { rows: dojos } = await db.query(
      `SELECT
         c.id AS dojo_id, c.name AS dojo_name, c.fpkt_affiliation_id,
         COALESCE(NULLIF(c.wa_phone_display, ''), c.phone) AS whatsapp,
         h.id AS annuity_id, h.reference_period, h.amount, h.due_date,
         h.paid_at, h.status AS annuity_status, h.transaction_id
       FROM companies c
       LEFT JOIN karate_dojo_annuity_history h
         ON h.dojo_id = c.id AND h.reference_period = $2
       WHERE c.federation_id = $1 AND c.vertical_active = 'karate_dojo'
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
        whatsapp: d.whatsapp || null,
        annuity_id: d.annuity_id || null,
        // annuity_history_id: alias idêntico a annuity_id — mantido por
        // compatibilidade com os payloads de PATCH/pix que já usam esse nome.
        annuity_history_id: d.annuity_id || null,
        transaction_id: d.transaction_id || null,
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

// POST /financial/annuities/pix-brcode — copia-e-cola PIX p/ mensagem de cobrança
// (wa.me/e-mail). Gera o BR Code estático a partir da chave da federação SEM
// persistir intent (é uma cobrança manual/adicional, não um lançamento).
router.post('/annuities/pix-brcode', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const amount = parseFloat(req.body && req.body.amount);
  if (!(amount > 0)) return res.status(422).json({ error: 'amount inválido', code: 'VALIDATION_ERROR' });
  try {
    const txid = ('WA' + Date.now().toString(36)).replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
    const r = await createPixCharge({ federationId, amount, txid, description: 'Anuidade' });
    return res.json({ payload: r.payload || null, provider: r.provider || null });
  } catch (err) {
    console.error('[karateAnnuities] pix-brcode error:', err.message);
    return res.status(500).json({ error: 'Erro ao gerar PIX' });
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
      `SELECT id, name FROM companies WHERE id = $1 AND federation_id = $2 AND vertical_active = 'karate_dojo' LIMIT 1`,
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
      annuity_id: h.id,
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

// PATCH /financial/annuities/dojos/:dojoId/:annuityId
// 25/06/2026 — DOJO-RM: corrige um lançamento de anuidade AINDA NÃO pago.
// Campos: amount/value, due_date, reference_period/competência.
// Se já estiver 'paid', retorna 409 (não editar valor de algo conciliado).
// Mantém a transaction conciliada em sincronia (amount/due_date/description).
router.patch('/annuities/dojos/:dojoId/:annuityId', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId, annuityId } = req.params;
  const body = req.body || {};

  // Aceita `amount` ou `value` (alias). String vazia → ignora o campo.
  const rawAmount = body.amount !== undefined ? body.amount : body.value;
  const rawDueDate = body.due_date;
  const rawPeriod = body.reference_period !== undefined ? body.reference_period
                  : (body.competencia !== undefined ? body.competencia : undefined);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Busca o lançamento (escopo dojô + federação)
    const histRes = await client.query(
      `SELECT id, dojo_id, federation_id, reference_period, amount, due_date,
              status, transaction_id
       FROM karate_dojo_annuity_history
       WHERE id = $1 AND dojo_id = $2 AND federation_id = $3
       LIMIT 1`,
      [annuityId, dojoId, federationId]
    );
    if (!histRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lançamento não encontrado', code: 'NOT_FOUND' });
    }
    const hist = histRes.rows[0];

    // Não editar algo já pago/conciliado.
    if (hist.status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Lançamento já pago — não é possível editar o valor de algo conciliado. Use estorno (void) se precisar reverter.',
        code: 'ALREADY_PAID',
      });
    }

    // Monta os updates dinâmicos.
    const sets = [];
    const vals = [];
    let i = 1;
    let newAmount = null;
    let newDueDate = null;
    let newPeriod = null;

    if (rawAmount !== undefined && String(rawAmount).trim() !== '') {
      const amt = Number(rawAmount);
      if (isNaN(amt) || amt <= 0) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
      }
      newAmount = amt;
      sets.push(`amount = $${i}`); vals.push(amt); i++;
    }
    if (rawDueDate !== undefined && String(rawDueDate).trim() !== '') {
      newDueDate = rawDueDate;
      sets.push(`due_date = $${i}`); vals.push(rawDueDate); i++;
    }
    if (rawPeriod !== undefined && String(rawPeriod).trim() !== '') {
      newPeriod = String(rawPeriod).trim();

      // Evita colidir com outra cobrança do mesmo período no dojô.
      const dup = await client.query(
        `SELECT id FROM karate_dojo_annuity_history
         WHERE dojo_id = $1 AND reference_period = $2 AND id <> $3 LIMIT 1`,
        [dojoId, newPeriod, annuityId]
      );
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Já existe outra cobrança para este dojô no período ' + newPeriod,
          code: 'CONFLICT',
        });
      }
      sets.push(`reference_period = $${i}`); vals.push(newPeriod); i++;
    }

    if (sets.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    sets.push('updated_at = NOW()');
    vals.push(annuityId);

    const upd = await client.query(
      `UPDATE karate_dojo_annuity_history
       SET ${sets.join(', ')}
       WHERE id = $${i}
       RETURNING id, dojo_id, reference_period, amount, due_date, status, paid_at, transaction_id`,
      vals
    );
    const h = upd.rows[0];

    // Mantém a transaction conciliada em sincronia (se houver e não estiver cancelada).
    if (hist.transaction_id) {
      const txSets = [];
      const txVals = [];
      let j = 1;
      if (newAmount !== null) { txSets.push(`amount = $${j}`); txVals.push(newAmount); j++; }
      if (newDueDate !== null) { txSets.push(`due_date = $${j}`); txVals.push(newDueDate); j++; }
      // Atualiza descrição se o período mudou (mantém legível na trilha financeira).
      if (newPeriod !== null) {
        const dojoNameRes = await client.query(`SELECT name FROM companies WHERE id = $1 LIMIT 1`, [dojoId]);
        const dojoName = dojoNameRes.rows[0]?.name || 'Dojô';
        txSets.push(`description = $${j}`); txVals.push(`Anuidade dojô ${dojoName} — ${newPeriod}`); j++;
      }
      if (txSets.length) {
        txSets.push('updated_at = NOW()');
        txVals.push(hist.transaction_id);
        await client.query(
          `UPDATE transactions SET ${txSets.join(', ')}
           WHERE id = $${j} AND status <> 'cancelled'`,
          txVals
        );
      }
    }

    await client.query('COMMIT');

    res.json({
      annuity_id: h.id,
      dojo_id: h.dojo_id,
      reference_period: h.reference_period,
      amount: h.amount ? parseFloat(h.amount) : 0,
      due_date: h.due_date,
      status: h.status,
      paid_at: h.paid_at || null,
      transaction_id: h.transaction_id || null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateAnnuities] patch annuity error:', err.message);
    res.status(500).json({ error: 'Erro ao corrigir lançamento', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /financial/annuities/dojos/:dojoId/:annuityId/void
// 25/06/2026 — DOJO-RM: estorna/cancela um lançamento de anuidade.
//   - Cancela a transaction conciliada (status='cancelled') — NÃO apaga (preserva
//     a trilha financeira).
//   - Marca intents PIX pendentes desse lançamento como 'cancelled'.
//   - APAGA a linha de karate_dojo_annuity_history (volta ao estado "sem cobrança
//     no período"; status é TEXTO sem 'cancelled' reconhecido — apagar é mais
//     limpo do que deixar um status fantasma).
// Idempotente: se o lançamento não existir mais, responde 200 { voided:true,
// idempotent_hit:true }. Funciona mesmo para lançamentos já pagos (reverte a
// conciliação), pois a federação tem liberdade de corrigir erros.
router.post('/annuities/dojos/:dojoId/:annuityId/void', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId, annuityId } = req.params;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const histRes = await client.query(
      `SELECT id, dojo_id, federation_id, reference_period, amount, status, transaction_id
       FROM karate_dojo_annuity_history
       WHERE id = $1 AND dojo_id = $2 AND federation_id = $3
       LIMIT 1`,
      [annuityId, dojoId, federationId]
    );

    // Idempotência: lançamento já removido.
    if (!histRes.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ voided: true, idempotent_hit: true, annuity_id: annuityId });
    }
    const hist = histRes.rows[0];

    // Cancela a transaction conciliada (preserva trilha; não apaga).
    if (hist.transaction_id) {
      await client.query(
        `UPDATE transactions
         SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1 AND status <> 'cancelled'`,
        [hist.transaction_id]
      );
    }

    // Cancela intents PIX pendentes desse lançamento (annuity_history_id é SET NULL
    // ao apagar o histórico → marcamos como cancelados antes para não ficarem
    // "pending" órfãos eternos).
    await client.query(
      `UPDATE karate_payment_intents
       SET status = 'cancelled', updated_at = NOW()
       WHERE annuity_history_id = $1 AND status = 'pending'`,
      [annuityId]
    );

    // Apaga o lançamento de anuidade.
    await client.query(`DELETE FROM karate_dojo_annuity_history WHERE id = $1`, [annuityId]);

    await client.query('COMMIT');

    res.json({
      voided: true,
      idempotent_hit: false,
      annuity_id: annuityId,
      dojo_id: dojoId,
      reference_period: hist.reference_period,
      transaction_id: hist.transaction_id || null,
      transaction_cancelled: !!hist.transaction_id,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateAnnuities] void annuity error:', err.message);
    res.status(500).json({ error: 'Erro ao estornar lançamento', detail: err.message });
  } finally {
    client.release();
  }
});

// ────────────────────────────────────────────────────────────────
// POST /financial/annuities/dojos/:dojoId/:annuityId/pay
// 27/06/2026 — BAIXA MANUAL de cobrança existente.
//
// Registra pagamento manual de uma cobrança que já foi lançada
// (via /charge ou via UI). Requer migration 194 (payment_method).
//
// Body (todos opcionais):
//   paid_at?         — YYYY-MM-DD (default: hoje)
//   payment_method?  — 'pix'|'dinheiro'|'transferencia'|'outro' (default: 'pix')
//   amount?          — valor recebido (default: amount da cobrança)
//
// Idempotente: se a anuidade já está 'paid', retorna 200 sem efeito colateral.
// Conciliação: sets karate_dojo_annuity_history.status='paid' + paid_at +
//   payment_method; sets transactions.status='confirmed' + paid_at.
//   Se a cobrança não tem transaction_id (raro), cria uma nova já confirmada.
// ────────────────────────────────────────────────────────────────
router.post('/annuities/dojos/:dojoId/:annuityId/pay', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId, annuityId } = req.params;
  const {
    paid_at,
    payment_method = 'pix',
    amount: overrideAmount,
  } = req.body || {};

  const VALID_METHODS = ['pix', 'dinheiro', 'transferencia', 'outro'];
  if (payment_method && !VALID_METHODS.includes(payment_method)) {
    return res.status(422).json({
      error: `payment_method inválido. Valores aceitos: ${VALID_METHODS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Busca e valida escopo (dojô pertence à federação)
    const histRes = await client.query(
      `SELECT h.id, h.dojo_id, h.federation_id, h.reference_period,
              h.amount, h.due_date, h.status, h.paid_at,
              h.transaction_id, c.name AS dojo_name
       FROM karate_dojo_annuity_history h
       JOIN companies c ON c.id = h.dojo_id
       WHERE h.id = $1 AND h.dojo_id = $2 AND h.federation_id = $3
       LIMIT 1`,
      [annuityId, dojoId, federationId]
    );
    if (!histRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cobrança não encontrada', code: 'NOT_FOUND' });
    }
    const hist = histRes.rows[0];

    // Idempotente: já está pago — retorna sem efeito colateral.
    if (hist.status === 'paid') {
      await client.query('ROLLBACK');
      return res.json({
        annuity_id: hist.id,
        dojo_id: hist.dojo_id,
        reference_period: hist.reference_period,
        amount: parseFloat(hist.amount),
        paid_at: hist.paid_at,
        payment_method: hist.payment_method || null,
        status: 'paid',
        transaction_id: hist.transaction_id || null,
        idempotent_hit: true,
      });
    }

    // Normaliza paid_at (default: hoje ao meio-dia horário de Brasília)
    let paidAtValue;
    if (paid_at) {
      // Aceita YYYY-MM-DD; converte para timestamp meio-dia SP (UTC-3)
      paidAtValue = new Date(`${paid_at}T12:00:00-03:00`).toISOString();
    } else {
      paidAtValue = new Date().toISOString();
    }

    // Valor a registrar na transaction (usa override ou amount original)
    const effectiveAmount = overrideAmount !== undefined
      ? Number(overrideAmount)
      : parseFloat(hist.amount);

    if (isNaN(effectiveAmount) || effectiveAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
    }

    // ── Concilia/cria a transaction ──────────────────────────
    let transactionId = hist.transaction_id;

    if (transactionId) {
      // Cobrança já tem transaction: confirma (igual ao /confirm)
      await client.query(
        `UPDATE transactions
         SET status = 'confirmed', paid_at = $1, amount = $2, updated_at = NOW()
         WHERE id = $3`,
        [paidAtValue, effectiveAmount, transactionId]
      );
    } else {
      // Sem transaction (schema drift / cobrança antiga): cria uma nova já confirmada
      const idempotencyKey = `dojo-annuity-manual-pay-${annuityId}`;
      const txRes = await client.query(
        `INSERT INTO transactions
           (company_id, type, category, amount, status, due_date,
            description, idempotency_key, reference_type, reference_id,
            federation_id, paid_at, created_at, updated_at)
         VALUES ($1, 'income', 'annuity_dojo', $2, 'confirmed', $3,
                 $4, $5, 'karate_dojo', $6,
                 $7, $8, NOW(), NOW())
         ON CONFLICT (idempotency_key) DO UPDATE
           SET status = 'confirmed', paid_at = EXCLUDED.paid_at, updated_at = NOW()
         RETURNING id`,
        [
          federationId,
          effectiveAmount,
          hist.due_date,
          `Anuidade dojô ${hist.dojo_name} — ${hist.reference_period}`,
          idempotencyKey,
          dojoId,
          federationId,
          paidAtValue,
        ]
      );
      transactionId = txRes.rows[0].id;
    }

    // ── Atualiza karate_dojo_annuity_history ─────────────────
    await client.query(
      `UPDATE karate_dojo_annuity_history
       SET status = 'paid', paid_at = $1, payment_method = $2,
           transaction_id = $3, updated_at = NOW()
       WHERE id = $4`,
      [paidAtValue, payment_method, transactionId, annuityId]
    );

    // ── Cancela intents PIX pendentes (não fazem mais sentido) ─
    await client.query(
      `UPDATE karate_payment_intents
       SET status = 'cancelled', updated_at = NOW()
       WHERE annuity_history_id = $1 AND status = 'pending'`,
      [annuityId]
    );

    await client.query('COMMIT');

    res.json({
      annuity_id: annuityId,
      dojo_id: dojoId,
      dojo_name: hist.dojo_name,
      reference_period: hist.reference_period,
      amount: effectiveAmount,
      paid_at: paidAtValue,
      payment_method,
      status: 'paid',
      transaction_id: transactionId,
      idempotent_hit: false,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateAnnuities] pay annuity error:', err.message);
    res.status(500).json({ error: 'Erro ao registrar pagamento', detail: err.message });
  } finally {
    client.release();
  }
});

// ────────────────────────────────────────────────────────────────
// POST /financial/annuities/dojos/:dojoId/pay
// 27/06/2026 — LANÇAR + BAIXAR em um passo (período já pago).
//
// Cria a cobrança e já a marca como 'paid' em um único request,
// dispensando o ciclo /charge → /pay. Útil para registrar
// retroativamente pagamentos recebidos por fora (ex: depósito bancário).
//
// Body:
//   reference_period (obrig.) — ex: '2026'
//   amount           (obrig.) — valor recebido
//   paid_at?         — YYYY-MM-DD (default: hoje)
//   due_date?        — YYYY-MM-DD (default: paid_at)
//   payment_method?  — 'pix'|'dinheiro'|'transferencia'|'outro' (default: 'pix')
//
// Idempotente: se já existe cobrança para o período retorna 409 com
//   { code:'CONFLICT', annuity_id } para que o caller possa redirecionar
//   para o endpoint /pay (com annuityId) se quiser baixar a existente.
// Conciliação: transaction criada já com status='confirmed' e paid_at.
// ────────────────────────────────────────────────────────────────
router.post('/annuities/dojos/:dojoId/pay', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const {
    reference_period,
    amount,
    paid_at,
    due_date,
    payment_method = 'pix',
  } = req.body || {};

  // Validação
  if (!reference_period || String(reference_period).trim() === '') {
    return res.status(422).json({ error: 'reference_period obrigatorio', code: 'VALIDATION_ERROR' });
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(422).json({ error: 'amount obrigatorio e deve ser > 0', code: 'VALIDATION_ERROR' });
  }
  const VALID_METHODS = ['pix', 'dinheiro', 'transferencia', 'outro'];
  if (payment_method && !VALID_METHODS.includes(payment_method)) {
    return res.status(422).json({
      error: `payment_method inválido. Valores aceitos: ${VALID_METHODS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  const period = String(reference_period).trim();
  const effectiveAmount = Number(amount);

  // Normaliza paid_at
  let paidAtValue;
  if (paid_at) {
    paidAtValue = new Date(`${paid_at}T12:00:00-03:00`).toISOString();
  } else {
    paidAtValue = new Date().toISOString();
  }

  // due_date: usa o informado ou o mesmo dia do paid_at (sem hora)
  const effectiveDueDate = due_date || (paid_at || new Date().toISOString().slice(0, 10));

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica dojô e escopo
    const dojoRes = await client.query(
      `SELECT id, name FROM companies
       WHERE id = $1 AND federation_id = $2 AND vertical_active = 'karate_dojo'
       LIMIT 1`,
      [dojoId, federationId]
    );
    if (!dojoRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }
    const dojoName = dojoRes.rows[0].name;

    // Advisory lock para evitar duplicata concorrente
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text || '-annuity-' || $2::text))`,
      [dojoId, period]
    );

    // Verifica se já existe cobrança para o período
    const existingRes = await client.query(
      `SELECT id, status FROM karate_dojo_annuity_history
       WHERE dojo_id = $1 AND reference_period = $2
       LIMIT 1`,
      [dojoId, period]
    );
    if (existingRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Já existe cobrança para este dojô no período ${period}. Use POST .../dojos/${dojoId}/${existingRes.rows[0].id}/pay para baixar a existente.`,
        code: 'CONFLICT',
        annuity_id: existingRes.rows[0].id,
        existing_status: existingRes.rows[0].status,
      });
    }

    // Cria transaction já confirmada
    const idempotencyKey = `dojo-annuity-direct-pay-${dojoId}-${period}`;
    const txRes = await client.query(
      `INSERT INTO transactions
         (company_id, type, category, amount, status, due_date,
          description, idempotency_key, reference_type, reference_id,
          federation_id, paid_at, created_at, updated_at)
       VALUES ($1, 'income', 'annuity_dojo', $2, 'confirmed', $3,
               $4, $5, 'karate_dojo', $6,
               $7, $8, NOW(), NOW())
       ON CONFLICT (idempotency_key) DO UPDATE
         SET status = 'confirmed', paid_at = EXCLUDED.paid_at, updated_at = NOW()
       RETURNING id`,
      [
        federationId,
        effectiveAmount,
        effectiveDueDate,
        `Anuidade dojô ${dojoName} — ${period}`,
        idempotencyKey,
        dojoId,
        federationId,
        paidAtValue,
      ]
    );
    const transactionId = txRes.rows[0].id;

    // Insere em karate_dojo_annuity_history já como 'paid'
    const histRes = await client.query(
      `INSERT INTO karate_dojo_annuity_history
         (dojo_id, federation_id, reference_period, amount, due_date,
          status, paid_at, payment_method, transaction_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'paid', $6, $7, $8, NOW())
       RETURNING id, reference_period, amount, due_date, paid_at`,
      [
        dojoId,
        federationId,
        period,
        effectiveAmount,
        effectiveDueDate,
        paidAtValue,
        payment_method,
        transactionId,
      ]
    );

    await client.query('COMMIT');

    const h = histRes.rows[0];
    res.status(201).json({
      annuity_id: h.id,
      dojo_id: dojoId,
      dojo_name: dojoName,
      reference_period: h.reference_period,
      amount: parseFloat(h.amount),
      due_date: h.due_date,
      paid_at: h.paid_at,
      payment_method,
      status: 'paid',
      transaction_id: transactionId,
      idempotent_hit: false,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateAnnuities] direct pay error:', err.message);
    res.status(500).json({ error: 'Erro ao registrar pagamento direto', detail: err.message });
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
    // annuity.status vem de karate_dojo_annuity_history (TEXTO): 'paid' é legítimo.
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
// Reconcilia transaction (status=confirmed) + atualiza annuity_history.
// NFS-e: emite via nfe_documents + fiscal.emitNfse (best-effort, não bloqueia confirm).
router.post('/payments/:intentId/confirm', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, intentId } = req.params;
  const { paid_at, emit_nfse = true } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Busca intent
    const intentRes = await client.query(
      `SELECT kpi.*, kdah.dojo_id, kdah.reference_period, kdah.amount AS annuity_amount,
              kdah.status AS annuity_status, kdah.id AS annuity_history_id
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

    // Atualiza karate_dojo_annuity_history (coluna status é TEXTO → 'paid')
    await client.query(
      `UPDATE karate_dojo_annuity_history
       SET status = 'paid', paid_at = $1, updated_at = NOW()
       WHERE id = $2`,
      [paidAt, intent.annuity_history_id]
    );

    // Reconcilia transaction (status é o enum transaction_status → 'confirmed')
    if (intent.transaction_id) {
      await client.query(
        `UPDATE transactions
         SET status = 'confirmed', paid_at = $1, updated_at = NOW()
         WHERE id = $2`,
        [paidAt, intent.transaction_id]
      );
    }

    await client.query('COMMIT');

    // ── NFS-e: best-effort após commit (não bloqueia confirm se falhar) ──
    let nfseRef = null;
    if (emit_nfse && intent.transaction_id && intent.dojo_id) {
      try {
        // Busca dados fiscais da federação (prestador)
        const fedRes = await db.query(
          `SELECT id, legal_name, trade_name, name, cnpj, email, phone,
                  inscricao_municipal, focus_company_id, certificate_uploaded, tax_regime,
                  address_street, address_number, address_neighborhood,
                  address_city, address_state, address_zip, ibge_code, inscricao_estadual
           FROM companies WHERE id = $1 LIMIT 1`,
          [federationId]
        );
        const dojoRes = await db.query(
          `SELECT name, cnpj FROM companies WHERE id = $1 LIMIT 1`,
          [intent.dojo_id]
        );

        if (fedRes.rows.length && fedRes.rows[0].cnpj && fedRes.rows[0].inscricao_municipal) {
          const federation = fedRes.rows[0];
          const dojoName = dojoRes.rows[0]?.name || 'Dojô';
          const dojoCnpj = (dojoRes.rows[0]?.cnpj || '').replace(/\D/g, '');
          const serviceDesc = `Anuidade Dojô ${dojoName} — ${intent.reference_period}`;
          const serviceValue = parseFloat(intent.annuity_amount);
          const refCode = `nfse-karate-${(intent.annuity_history_id || '').slice(0, 8)}-${Date.now()}`;

          // Verifica idempotência: já existe NFS-e para este annuity_history_id?
          const existingRef = await db.query(
            `SELECT ref FROM nfe_documents
             WHERE company_id = $1 AND type = 'nfse'
               AND payload::jsonb ->> 'annuity_history_id' = $2
             LIMIT 1`,
            [federationId, intent.annuity_history_id]
          ).catch(() => ({ rows: [] }));

          if (!existingRef.rows.length) {
            // Insere pendente
            await db.query(
              `INSERT INTO nfe_documents
                 (company_id, ref, type, status, recipient_cnpj, recipient_name,
                  description, service_code, value, iss_rate, payload)
               VALUES ($1,$2,'nfse','pending',$3,$4,$5,$6,$7,$8,$9)`,
              [
                federationId, refCode, dojoCnpj, dojoName, serviceDesc, '', serviceValue, 2,
                JSON.stringify({
                  source: 'karate_annuity',
                  annuity_history_id: intent.annuity_history_id,
                  dojo_id: intent.dojo_id,
                  federation_id: federationId,
                  transaction_id: intent.transaction_id,
                  reference_period: intent.reference_period,
                }),
              ]
            );
            nfseRef = refCode;

            // Emite via Nuvem Fiscal (best-effort)
            try {
              const result = await fiscal.emitNfse(federation, {
                recipient_cnpj: dojoCnpj || undefined,
                recipient_name: dojoName,
                description: serviceDesc,
                service_code: '',
                value: serviceValue,
                iss_rate: 2,
              });
              const nfseStatus = result.status === 'autorizado' ? 'authorized'
                               : result.status === 'rejeitado'  ? 'error' : 'processing';
              await db.query(
                `UPDATE nfe_documents
                    SET status=$1, focus_id=$2, number=$3, xml_url=$4, pdf_url=$5,
                        error_message=$6,
                        issued_at=CASE WHEN $1='authorized' THEN NOW() ELSE NULL END,
                        updated_at=NOW()
                  WHERE ref=$7`,
                [nfseStatus, result.id||null, result.numero||null,
                 result.link_xml||null, result.link_pdf||null, result.mensagem||null, refCode]
              ).catch(() => {});
            } catch (fiscalErr) {
              await db.query(
                `UPDATE nfe_documents SET status='error', error_message=$1 WHERE ref=$2`,
                [fiscalErr.message, refCode]
              ).catch(() => {});
              console.warn('[karateAnnuities] nfse emit failed (best-effort):', fiscalErr.message);
            }
          } else {
            nfseRef = existingRef.rows[0].ref;
          }
        }
      } catch (nfseErr) {
        // NFS-e é best-effort: não bloqueia confirmação
        console.warn('[karateAnnuities] nfse block failed (best-effort):', nfseErr.message);
      }
    }

    res.json({
      intent_id: intentId,
      transaction_id: intent.transaction_id,
      status: 'paid',
      paid_at: paidAt,
      nfse_ref: nfseRef,
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

// ────────────────────────────────────────────────────────────────
// CPF ANNUITIES
// ────────────────────────────────────────────────────────────────

// GET /financial/annuities/cpf
router.get('/annuities/cpf', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { status } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;
  const year     = (req.query.year && /^\d{4}$/.test(String(req.query.year)))
    ? String(req.query.year)
    : new Date().getFullYear().toString();

  try {
    // Praticantes + sua cobrança anual (transactions com reference_type=customer)
    const { rows } = await db.query(
      `SELECT
         cu.id AS practitioner_id,
         cu.name AS full_name,
         cu.karate_registration_number,
         cu.phone AS whatsapp,
         t.id AS transaction_id,
         t.amount,
         t.due_date,
         t.status AS tx_status,
         t.paid_at
       FROM customers cu
       LEFT JOIN transactions t
         ON t.reference_type = 'customer'
         AND t.reference_id = cu.id
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
      // Sem cobrança lançada (sem transaction_id) é um estado NEUTRO
      // ('no_charge') — ausência de cobrança NÃO é inadimplência.
      // 'suspended' passa a significar apenas "tinha cobrança e venceu há
      // mais de 180 dias" (branch abaixo, com transaction_id presente).
      if (!r.transaction_id) annuityStatus = 'no_charge';
      // transactions.status é o enum: recebido = 'confirmed'
      else if (r.tx_status === 'confirmed' || r.paid_at) annuityStatus = 'paid';
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
        whatsapp: r.whatsapp || null,
        transaction_id: r.transaction_id || null,
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
      `SELECT id, name AS full_name, cpf_cnpj
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
      `SELECT t.*, cu.name AS pract_name
       FROM transactions t
       JOIN customers cu ON cu.id = $2
       WHERE t.id = $1 AND t.federation_id = $3 AND t.reference_id = $2
       LIMIT 1`,
      [transaction_id, practitionerId, federationId]
    );
    if (!txRows.length) {
      return res.status(404).json({ error: 'Cobrança não encontrada', code: 'NOT_FOUND' });
    }
    const tx = txRows[0];
    // transactions.status é o enum: pago = 'confirmed'
    if (tx.status === 'confirmed') {
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
