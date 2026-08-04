      return res.json({ annuity_id: annuityId, dojo_id: null, practitioner_id: null, total: 0, count: 0, data: [] });
    }
    console.error('[karateAnnuities] extrato de anuidade error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar extrato da anuidade' });
  }
});

function round2ForResponse(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function mapInstallmentForResponse(inst) {
  if (!inst) return null;
  return {
    installment_id: inst.id,
    seq: inst.seq,
    kind: inst.kind,
    amount: parseFloat(inst.amount),
    amount_paid: inst.amount_paid != null ? parseFloat(inst.amount_paid) : 0,
    status: inst.status,
    due_date: toIsoDate(inst.due_date),
    paid_at: inst.paid_at,
    payment_method: inst.payment_method || null,
    transaction_id: inst.transaction_id || null,
  };
}

router.patch('/annuities/:annuityId/payments/:paymentId', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, annuityId, paymentId } = req.params;
  const body = req.body || {};
  const rawAmount = body.amount;
  const rawPaidAt = body.paid_at;
  const rawMethod = body.payment_method;

  let newAmount = null;
  if (rawAmount !== undefined && rawAmount !== null && String(rawAmount).trim() !== '') {
    newAmount = Number(rawAmount);
    if (!Number.isFinite(newAmount) || newAmount <= 0) {
      return res.status(422).json({ error: 'amount deve ser um número > 0', code: 'VALIDATION_ERROR' });
    }
  }

  let newPaidAt;
  if (rawPaidAt !== undefined) {
    if (rawPaidAt === null || String(rawPaidAt).trim() === '') {
      return res.status(422).json({ error: 'paid_at não pode ser vazio', code: 'VALIDATION_ERROR' });
    }
    const resolved = resolveReceivePaidAt(rawPaidAt);
    const parsed = resolved !== undefined ? new Date(resolved) : null;
    if (resolved === undefined || !parsed || Number.isNaN(parsed.getTime())) {
      return res.status(422).json({ error: 'paid_at inválido', code: 'VALIDATION_ERROR' });
    }
    newPaidAt = resolved;
  }

  let newMethod;
  if (rawMethod !== undefined) {
    if (rawMethod !== null && !annuitySvc.VALID_PAYMENT_METHODS.includes(rawMethod)) {
      return res.status(422).json({
        error: `payment_method inválido. Valores aceitos: ${annuitySvc.VALID_PAYMENT_METHODS.join(', ')}`,
        code: 'VALIDATION_ERROR',
      });
    }
    newMethod = rawMethod || null;
  }

  if (newAmount === null && newPaidAt === undefined && newMethod === undefined) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar (amount, paid_at ou payment_method)' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const before = await client.query(
      `SELECT p.*, h.dojo_id, h.practitioner_id
         FROM karate_annuity_payments p
         JOIN karate_dojo_annuity_history h ON h.id = p.annuity_id
        WHERE p.id = $1 AND p.annuity_id = $2 AND p.federation_id = $3
        FOR UPDATE OF p`,
      [paymentId, annuityId, federationId]
    );
    if (!before.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Baixa não encontrada', code: 'NOT_FOUND' });
    }
    const prev = before.rows[0];

    const sets = []; const vals = []; let i = 1;
    if (newAmount !== null) { sets.push(`amount = $${i}`); vals.push(newAmount); i++; }
    if (newPaidAt !== undefined) { sets.push(`paid_at = $${i}::timestamptz`); vals.push(newPaidAt); i++; }
    if (newMethod !== undefined) { sets.push(`payment_method = $${i}`); vals.push(newMethod); i++; }
    vals.push(paymentId);
    await client.query(`UPDATE karate_annuity_payments SET ${sets.join(', ')} WHERE id = $${i}`, vals);

    const result = await recomputeAnnuityFromLedger(client, { federation_id: federationId, annuity_id: annuityId });

    await client.query('COMMIT');

    reconcileInstallmentTransactions(result.installments).catch((e) =>
      console.error('[karateAnnuities] reconcileInstallmentTransactions falhou (patch payment):', e.message)
    );

    financeAudit.logFinanceAudit({
      federationId, action: 'payment_edit', targetType: 'annuity', targetId: annuityId,
      dojoId: prev.dojo_id || null, practitionerId: prev.practitioner_id || null,
      actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: {
        payment_id: paymentId,
        installment_id: prev.installment_id,
        amount: parseFloat(prev.amount),
        paid_at: prev.paid_at,
        payment_method: prev.payment_method || null,
      },
      after: {
        payment_id: paymentId,
        amount: newAmount !== null ? newAmount : parseFloat(prev.amount),
        paid_at: newPaidAt !== undefined ? newPaidAt : prev.paid_at,
        payment_method: newMethod !== undefined ? newMethod : (prev.payment_method || null),
        header_amount: result.header ? parseFloat(result.header.amount) : null,
        header_status: result.header ? result.header.status : null,
      },
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (edit payment):', e.message));

    res.json({
      annuity_id: annuityId,
      payment_id: paymentId,
      header: result.header ? {
        amount: parseFloat(result.header.amount),
        status: result.header.status,
        due_date: result.header.due_date,
        paid_at: result.header.paid_at,
      } : null,
      installments: result.installments.map(mapInstallmentForResponse),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    respondAnnuityPaymentError(res, err, 'Erro ao editar baixa da anuidade');
  } finally {
    client.release();
  }
});

router.delete('/annuities/:annuityId/payments/:paymentId', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, annuityId, paymentId } = req.params;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query(
      `SELECT p.*, h.dojo_id, h.practitioner_id
         FROM karate_annuity_payments p
         JOIN karate_dojo_annuity_history h ON h.id = p.annuity_id
        WHERE p.id = $1 AND p.annuity_id = $2 AND p.federation_id = $3
        FOR UPDATE OF p`,
      [paymentId, annuityId, federationId]
    );
    if (!target.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Baixa não encontrada', code: 'NOT_FOUND' });
    }
    const prev = target.rows[0];

    let deletedRows;
    if (prev.operation_id) {
      const del = await client.query(
        `DELETE FROM karate_annuity_payments
          WHERE annuity_id = $1 AND federation_id = $2 AND operation_id = $3
          RETURNING *`,
        [annuityId, federationId, prev.operation_id]
      );
      deletedRows = del.rows;
    } else {
      const del = await client.query(
        `DELETE FROM karate_annuity_payments WHERE id = $1 RETURNING *`,
        [paymentId]
      );
      deletedRows = del.rows;
    }

    const result = await recomputeAnnuityFromLedger(client, { federation_id: federationId, annuity_id: annuityId });

    await client.query('COMMIT');

    reconcileInstallmentTransactions(result.installments).catch((e) =>
      console.error('[karateAnnuities] reconcileInstallmentTransactions falhou (delete payment):', e.message)
    );

    financeAudit.logFinanceAudit({
      federationId, action: 'payment_delete', targetType: 'annuity', targetId: annuityId,
      dojoId: prev.dojo_id || null, practitionerId: prev.practitioner_id || null,
      actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: {
        payment_id: paymentId,
        operation_id: prev.operation_id || null,
        removed_group: deletedRows.length > 1,
        removed: deletedRows.map((r) => ({
          id: r.id, installment_id: r.installment_id, amount: parseFloat(r.amount),
          paid_at: r.paid_at, payment_method: r.payment_method || null,
        })),
      },
      after: {
        header_amount: result.header ? parseFloat(result.header.amount) : null,
        header_status: result.header ? result.header.status : null,
      },
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (delete payment):', e.message));

    res.json({
      annuity_id: annuityId,
      deleted: deletedRows.map((r) => ({ id: r.id, installment_id: r.installment_id, amount: parseFloat(r.amount) })),
      removed_group: deletedRows.length > 1,
      header: result.header ? {
        amount: parseFloat(result.header.amount),
        status: result.header.status,
        due_date: result.header.due_date,
        paid_at: result.header.paid_at,
      } : null,
      installments: result.installments.map(mapInstallmentForResponse),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    respondAnnuityPaymentError(res, err, 'Erro ao remover baixa da anuidade');
  } finally {
    client.release();
  }
});

router.post('/annuities/installments/:installmentId/pay', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, installmentId } = req.params;
  const { paid_at, payment_method = 'pix', amount: overrideAmount } = req.body || {};

  if (payment_method && !annuitySvc.VALID_PAYMENT_METHODS.includes(payment_method)) {
    return res.status(422).json({
      error: `payment_method inválido. Valores aceitos: ${annuitySvc.VALID_PAYMENT_METHODS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  try {
    const instRes = await db.query(
      `SELECT i.*, h.federation_id, h.dojo_id, h.practitioner_id, h.reference_period, h.plan,
              COALESCE(c1.name, c2.name) AS ref_name, c2.is_active AS practitioner_is_active
       FROM karate_annuity_installments i
       JOIN karate_dojo_annuity_history h ON h.id = i.annuity_id
       LEFT JOIN companies c1 ON c1.id = h.dojo_id
       LEFT JOIN customers c2 ON c2.id = h.practitioner_id
       WHERE i.id = $1 AND h.federation_id = $2
       LIMIT 1`,
      [installmentId, federationId]
    );
    if (!instRes.rows.length) {
      return res.status(404).json({ error: 'Parcela não encontrada', code: 'NOT_FOUND' });
    }
    const inst = instRes.rows[0];

    if (inst.status === 'paid') {
      return res.json({
        installment_id: inst.id, annuity_id: inst.annuity_id, seq: inst.seq,
        amount: parseFloat(inst.amount), paid_at: inst.paid_at, payment_method: inst.payment_method || null,
        status: 'paid', transaction_id: inst.transaction_id || null, idempotent_hit: true,
      });
    }

    if (inst.practitioner_id && inst.practitioner_is_active === false) {
      return res.status(409).json({
        error: 'Praticante inativo — não é possível registrar baixa',
        code: 'MEMBER_INACTIVE',
      });
    }

    const outstandingBalance = round2ForResponse(parseFloat(inst.amount) - parseFloat(inst.amount_paid || 0));
    const effectiveAmount = overrideAmount !== undefined ? Number(overrideAmount) : outstandingBalance;
    if (!Number.isFinite(effectiveAmount) || effectiveAmount <= 0) {
      return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
    }

    let transactionId = inst.transaction_id;
    if (!transactionId) {
      const kind = inst.dojo_id ? 'dojo' : 'cpf';
      const idempotencyKey = `annuity-manual-pay-${inst.id}`;
      const category = annuitySvc.categoryForKind(kind);
      const referenceType = kind === 'cpf' ? 'customer' : 'karate_dojo';
      const refId = inst.dojo_id || inst.practitioner_id;
      const txRes = await db.query(
        `INSERT INTO transactions
           (company_id, type, category, amount, status, due_date, description, idempotency_key,
            reference_type, reference_id, federation_id, created_at, updated_at)
         VALUES ($1,'income',$2,$3,'pending',$4,$5,$6,$7,$8,$9,NOW(),NOW())
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          federationId, category, parseFloat(inst.amount), inst.due_date,
          `Anuidade ${kind === 'cpf' ? '' : 'dojô '}${inst.ref_name} — ${inst.reference_period}`,
          idempotencyKey, referenceType, refId, federationId,
        ]
      );
      transactionId = txRes.rows[0]?.id;
      if (!transactionId) {
        const ex = await db.query(`SELECT id FROM transactions WHERE idempotency_key = $1`, [idempotencyKey]);
        transactionId = ex.rows[0]?.id || null;
      }
      if (transactionId) {
        await db.query(
          `UPDATE karate_annuity_installments SET transaction_id = $1 WHERE id = $2 AND transaction_id IS NULL`,
          [transactionId, installmentId]
        );
      }
    }

    const result = await applyAnnuityPayment({
      federation_id: federationId,
      annuity_id: inst.annuity_id,
      installment_id: installmentId,
      amount: effectiveAmount,
      payment_method,
      paid_at: resolveReceivePaidAt(paid_at),
      created_by: financeAudit.actorFromReq(req).actorUserId,
    });

    await reconcileClosedInstallmentTransactions(result.allocations, result.paid_at);

    db.query(
      `UPDATE karate_payment_intents SET status = 'cancelled', updated_at = NOW()
       WHERE source_id = $1 AND status = 'pending'`,
      [installmentId]
    ).catch((e) => console.error('[karateAnnuities] cancelar intents pendentes falhou (pay parcela):', e.message));

    const alloc = result.allocations.find((a) => String(a.installment_id) === String(installmentId)) || result.allocations[0];

    await financeAudit.logFinanceAudit({
      federationId, action: 'installment_pay', targetType: 'installment', targetId: installmentId,
      dojoId: inst.dojo_id || null, practitionerId: inst.practitioner_id || null,
      actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: { status: inst.status, amount: inst.amount != null ? parseFloat(inst.amount) : null, paid_at: inst.paid_at || null, payment_method: inst.payment_method || null },
      after: { status: alloc?.status_after || null, amount: effectiveAmount, paid_at: result.paid_at, payment_method, transaction_id: transactionId || null },
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (pay parcela):', e.message));

    res.json({
      installment_id: installmentId,
      annuity_id: inst.annuity_id,
      seq: inst.seq,
      amount: effectiveAmount,
      paid_at: result.paid_at,
      payment_method,
      status: alloc?.status_after || 'paid',
      transaction_id: transactionId || null,
      annuity_status: result.header?.status || null,
      idempotent_hit: false,
    });
  } catch (err) {
    respondAnnuityPaymentError(res, err, 'Erro ao registrar pagamento da parcela');
  }
});

router.post('/annuities/installments/:installmentId/pix', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, installmentId } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT i.*, h.dojo_id, h.practitioner_id, h.reference_period,
              COALESCE(c1.name, c2.name) AS ref_name
       FROM karate_annuity_installments i
       JOIN karate_dojo_annuity_history h ON h.id = i.annuity_id
       LEFT JOIN companies c1 ON c1.id = h.dojo_id
       LEFT JOIN customers c2 ON c2.id = h.practitioner_id
       WHERE i.id = $1 AND h.federation_id = $2
       LIMIT 1`,
      [installmentId, federationId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Parcela não encontrada', code: 'NOT_FOUND' });
    }
    const inst = rows[0];
    if (inst.status === 'paid') {
      return res.status(409).json({ error: 'Parcela já paga', code: 'CONFLICT' });
    }

    const existingIntents = await db.query(
      `SELECT id, payment_intent_id, payload, qr_image, status, expires_at, provider
       FROM karate_payment_intents
       WHERE source_id = $1 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [installmentId]
    );
    if (existingIntents.rows.length) {
      const intent = existingIntents.rows[0];
      return res.json({
        intent_id: intent.id, payment_intent_id: intent.payment_intent_id, payload: intent.payload,
        qr_image: intent.qr_image, status: intent.status, expires_at: intent.expires_at, provider: intent.provider,
      });
    }

    const kind = inst.dojo_id ? 'dojo' : 'cpf';
    const sourceType = kind === 'cpf' ? 'cpf_annuity' : 'dojo_annuity';
    const description = `Anuidade ${kind === 'cpf' ? '' : 'dojô '}${inst.ref_name} — ${inst.reference_period} (parcela ${inst.seq})`;
    const txid = `${kind}-${installmentId.slice(0, 8)}-p${inst.seq}`;
    const pixResult = await createPixCharge({ federationId, amount: parseFloat(inst.amount), txid, description });

    const { rows: intentRows } = await db.query(
      `INSERT INTO karate_payment_intents
         (federation_id, annuity_history_id, transaction_id, provider, payment_intent_id, payload, qr_image,
          status, expires_at, amount, source_type, source_id, description, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12,NOW())
       RETURNING id`,
      [
        federationId, inst.annuity_id, inst.transaction_id, pixResult.provider, pixResult.payment_intent_id,
        pixResult.payload, pixResult.qr_image || null, pixResult.expires_at,
        parseFloat(inst.amount), sourceType, installmentId, description,
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
    console.error('[karateAnnuities] installment pix error:', err.message);
    res.status(500).json({ error: 'Erro ao criar PIX intent', detail: err.message });
  }
});

router.patch('/annuities/installments/:installmentId', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, installmentId } = req.params;
  const body = req.body || {};
  const rawAmount = body.amount;
  const rawDueDate = body.due_date;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const instRes = await client.query(
      `SELECT i.* FROM karate_annuity_installments i
       JOIN karate_dojo_annuity_history h ON h.id = i.annuity_id
       WHERE i.id = $1 AND h.federation_id = $2
       LIMIT 1`,
      [installmentId, federationId]
    );
    if (!instRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parcela não encontrada', code: 'NOT_FOUND' });
    }
    const inst = instRes.rows[0];

    if (inst.status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Parcela já paga — não é possível editar. Use estorno (void) se precisar reverter.',
        code: 'ALREADY_PAID',
      });
    }

    const sets = []; const vals = []; let i = 1;
    let newAmount = null; let newDueDate = null;

    if (rawAmount !== undefined && String(rawAmount).trim() !== '') {
      const amt = Number(rawAmount);
      if (isNaN(amt) || amt <= 0) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
      }
      newAmount = amt; sets.push(`amount = $${i}`); vals.push(amt); i++;
    }
    if (rawDueDate !== undefined && String(rawDueDate).trim() !== '') {
      newDueDate = rawDueDate; sets.push(`due_date = $${i}`); vals.push(rawDueDate); i++;
    }
    if (!sets.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }
    sets.push('updated_at = NOW()'); vals.push(installmentId);

    const upd = await client.query(
      `UPDATE karate_annuity_installments SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    const updated = upd.rows[0];

    if (inst.transaction_id) {
      const txSets = []; const txVals = []; let j = 1;
      if (newAmount !== null) { txSets.push(`amount = $${j}`); txVals.push(newAmount); j++; }
      if (newDueDate !== null) { txSets.push(`due_date = $${j}`); txVals.push(newDueDate); j++; }
      if (txSets.length) {
        txSets.push('updated_at = NOW()'); txVals.push(inst.transaction_id);
        await client.query(
          `UPDATE transactions SET ${txSets.join(', ')} WHERE id = $${j} AND status <> 'cancelled'`,
          txVals
        );
      }
    }

    const header = await annuitySvc.syncAnnuityHeaderRollup(client, inst.annuity_id);
    await client.query('COMMIT');

    await financeAudit.logFinanceAudit({
      federationId, action: 'installment_patch', targetType: 'installment', targetId: installmentId,
      actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: { amount: inst.amount != null ? parseFloat(inst.amount) : null, due_date: inst.due_date },
      after: { amount: parseFloat(updated.amount), due_date: updated.due_date },
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (patch parcela):', e.message));

    res.json({
      installment_id: updated.id,
      annuity_id: updated.annuity_id,
      seq: updated.seq,
      amount: parseFloat(updated.amount),
      due_date: updated.due_date,
      status: updated.status,
      transaction_id: updated.transaction_id,
      annuity_amount: header ? parseFloat(header.amount) : null,
      annuity_due_date: header ? header.due_date : null,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[karateAnnuities] patch installment error:', err.message);
    res.status(500).json({ error: 'Erro ao corrigir parcela', detail: err.message });
  } finally {
    client.release();
  }
});

router.__voidAnnuityCore = voidAnnuityCore;

module.exports = router;
