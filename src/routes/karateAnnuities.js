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
    // pg devolve `date` como objeto Date — toIsoDate() evita a armadilha
    // CLAUDE.md #1/#toIsoDate (reinterpretação de fuso ao serializar a
    // data pura como ISO datetime completo).
    due_date: toIsoDate(inst.due_date),
    paid_at: inst.paid_at,
    payment_method: inst.payment_method || null,
    transaction_id: inst.transaction_id || null,
  };
}

// ============================================================
// Editar/remover uma baixa já lançada (decisão do Caio, 23/07/2026): a
// federação precisa corrigir "todas as informações do pagamento" (valor,
// data, forma) e remover uma baixa lançada por engano, independente do
// status da parcela. Isto é a metade "pagamento" — a metade "anuidade"
// (editar valor devido/plano/vencimentos do HEADER) é um PR separado,
// fora de escopo aqui.
//
// Arquitetura: NUNCA um UPDATE/DELETE solto no ledger seguido de nada —
// isso desincroniza parcela/saldo/status/rollup/DRE (ver CLAUDE.md #6/#7
// e o histórico deste arquivo). As duas rotas abaixo só mutam a(s)
// linha(s) do ledger e, na MESMA transação, chamam
// recomputeAnnuityFromLedger (karateAnnuityLedger.js) — que reconstrói a
// anuidade INTEIRA a partir do ledger remanescente, re-rodando o mesmo
// FIFO do motor (ver o comentário de topo daquela função pra justificativa
// completa da escolha "rebuild global" em vez de "recompute local por
// linha"). Guard: adminOnly() — mesmo padrão de TODAS as outras rotas de
// baixa deste arquivo.
// ============================================================

// PATCH /financial/annuities/:annuityId/payments/:paymentId — corrige uma
// baixa já lançada. Body: { amount?, paid_at?, payment_method? } (ao menos
// um). amount > 0 se informado; paid_at aceita 'YYYY-MM-DD' (meio-dia BRT,
// mesma convenção de resolveReceivePaidAt) ou ISO completo, NUNCA vazio se
// informado; payment_method precisa estar em VALID_PAYMENT_METHODS
// (null explícito limpa o campo — coluna aceita NULL no ledger).
// 422 AMOUNT_EXCEEDS_BALANCE se o novo total recebido da anuidade
// ultrapassar o devido (mesma regra da baixa original — carteira de
// crédito fora de escopo, ver karateAnnuityLedger.computeDistribution,
// reusada por recomputeAnnuityFromLedger).
router.patch('/annuities/:annuityId/payments/:paymentId', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, annuityId, paymentId } = req.params;
  const body = req.body || {};
  const rawAmount = body.amount;
  const rawPaidAt = body.paid_at;
  const rawMethod = body.payment_method;

  let newAmount = null; // null = não mexe
  if (rawAmount !== undefined && rawAmount !== null && String(rawAmount).trim() !== '') {
    newAmount = Number(rawAmount);
    if (!Number.isFinite(newAmount) || newAmount <= 0) {
      return res.status(422).json({ error: 'amount deve ser um número > 0', code: 'VALIDATION_ERROR' });
    }
  }

  let newPaidAt; // undefined = não mexe
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

  let newMethod; // undefined = não mexe; null = limpa
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

// DELETE /financial/annuities/:annuityId/payments/:paymentId — remove uma
// baixa lançada por engano, independente do status atual da parcela
// (Caio, 23/07/2026). Uma baixa "lógica" (o clique da federação) pode ter
// virado várias linhas no ledger — split FIFO da MESMA baixa sobre mais de
// uma parcela (ver comentário de topo de applyAnnuityPayment). Se a linha
// tem operation_id (baixa livre por /receive, migration 249), remove o
// GRUPO inteiro (mesmo operation_id) — o usuário pensa "aquela baixa", não
// "aquela alocação". Sem operation_id (linha legada, ou lançada pela rota
// de baixa por parcela .../installments/:id/pay, que não usa
// operation_id), não há como agrupar com segurança — remove só a linha.
// Depois de remover, recomputeAnnuityFromLedger reabre a(s) parcela(s)
// afetada(s) e o saldo volta (rebuild global, mesmo motor do PATCH acima).
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
