// Cria 1 transaction por parcela (idempotente por annuity-{id}-p{seq}) e
// linka installments.transaction_id. Chamado dentro da MESMA transação do
// client. `kind`: 'dojo'|'cpf' — decide category/reference_type/reference_id.
// POST /financial/annuities/dojos/:dojoId/charge
// Fase F1: aceita `plan` (default 'anual'). Sem `amount` explícito, usa o
// preço vigente de karate_annual_fees para o plano (gera N parcelas —
// vencimento = último dia de cada mês do plano, no ano da temporada; se o
// dojô entra no meio do ano, só as parcelas restantes são geradas). Com
// `amount` explícito, mantém o contrato antigo — 1 parcela única no valor
// informado (override manual, comportamento idêntico ao pré-F1).
//
// Continuação F3 (PR #356): quando NÃO é amount manual, aceita `due_date`
// opcional (ISO AAAA-MM-DD) que sobrescreve o vencimento da parcela gerada
// (única em plano anual; primeira em semestral/trimestral — mesma
// semântica de /campaign e /batch, ver buildPlanSpecs em
// karateAnnuityService.js). Também aqui: se TODAS as parcelas do plano já
// venceram na temporada, não erramos mais com 422 "nada a lançar" — geramos
// a última parcela com due_date = último dia do mês corrente (default
// seguro, ou o `due_date` informado, se houver), igual à campanha/lote.
// Resposta inclui `due_date_ajustada` para a UI avisar o operador.
router.post('/annuities/dojos/:dojoId/charge', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const { amount, due_date, reference_period, plan: rawPlan } = req.body || {};

  if (!reference_period) {
    return res.status(422).json({ error: 'reference_period obrigatorio', code: 'VALIDATION_ERROR' });
  }
  // Valida rawPlan cedo SE foi informado (formato). A resolução final do
  // plano (precedência: rawPlan explícito > karate_annuity_plan do dojô >
  // bloqueia) só acontece depois de buscar o dojô, dentro da transação —
  // ver comentário mais abaixo, antes de montar as parcelas.
  if (HAS_INSTALLMENTS && rawPlan && !annuitySvc.VALID_PLANS.includes(rawPlan)) {
    return res.status(422).json({
      error: `plan inválido. Valores aceitos: ${annuitySvc.VALID_PLANS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  const manualAmount = amount !== undefined && amount !== null && String(amount).trim() !== '';
  if (manualAmount && (isNaN(Number(amount)) || Number(amount) <= 0)) {
    return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
  }
  if (manualAmount && !due_date) {
    return res.status(422).json({ error: 'due_date obrigatorio quando amount é manual', code: 'VALIDATION_ERROR' });
  }
  if (!manualAmount && !HAS_INSTALLMENTS) {
    return res.status(422).json({ error: 'amount obrigatorio e deve ser > 0', code: 'VALIDATION_ERROR' });
  }
  let dueDateOverride = null;
  if (!manualAmount) {
    const dueDateCheck = annuitySvc.validateDueDateOverride(due_date, parseInt(reference_period, 10) || new Date().getFullYear());
    if (!dueDateCheck.valid) {
      return res.status(422).json({ error: dueDateCheck.error, code: 'VALIDATION_ERROR' });
    }
    dueDateOverride = dueDateCheck.value;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica dojô (traz karate_annuity_plan defensivamente — Migration 226)
    const dojoRes = await fetchDojoForCharge(client, dojoId, federationId);
    if (!dojoRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }
    const dojoName = dojoRes.rows[0].name;
    const dojoAnnuityPlan = dojoRes.rows[0].karate_annuity_plan || null;
    // F2 — data de filiação (fonte do proporcional) e seletor de adesão
    // (fonte: companies.karate_charges_adhesion, marcado no cadastro/
    // reativação — ver karateDojos.js). parseDateParts nunca usa
    // `new Date(iso)` (armadilha CLAUDE.md: volta um dia no fuso BR).
    const dojoAffiliationSince = annuitySvc.parseDateParts(dojoRes.rows[0].affiliation_since);
    const dojoChargesAdhesion = dojoRes.rows[0].karate_charges_adhesion === true;

    // ── Resolução do plano (F2 do bug de produto: dojô trimestral cobrado
    // como anual) — precedência: plan explícito no request > plano
    // cadastrado no dojô (karate_annuity_plan) > NUNCA assume 'anual'
    // silenciosamente quando o valor vem da tabela de fees (gera N parcelas
    // reais). O override manual de amount continua aceitando o default
    // histórico 'anual' como RÓTULO (não dispara lookup de fee/parcelas —
    // o operador já informou o valor exato a cobrar).
    let plan;
    if (manualAmount) {
      plan = rawPlan || 'anual';
    } else {
      plan = rawPlan || dojoAnnuityPlan || null;
      if (!plan) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: 'Este dojô ainda não tem um plano de anuidade cadastrado. Informe "plan" explicitamente no request ou cadastre o plano no dojô (karate_annuity_plan) antes de lançar a cobrança.',
          code: 'PLANO_INDEFINIDO',
        });
      }
      if (HAS_INSTALLMENTS && !annuitySvc.VALID_PLANS.includes(plan)) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: `plan inválido. Valores aceitos: ${annuitySvc.VALID_PLANS.join(', ')}`,
          code: 'VALIDATION_ERROR',
        });
      }
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

    // Monta as parcelas: override manual (1 parcela) ou plano vigente (N parcelas,
    // com default seguro + due_date override — ver buildPlanSpecs).
    let specs;
    let dueDateAdjusted = false;
    // F2 — preenchido só quando a anuidade sai PROPORCIONAL (dojô filiado na
    // temporada corrente); null no caso normal (valor cheio) ou manualAmount.
    // Vai na resposta e no financeAudit para o operador auditar o cálculo.
    let proportionalInfo = null;
    if (manualAmount) {
      specs = [{ seq: 1, amount: Number(amount), due_date }];
    } else {
      const seasonYear = parseInt(reference_period, 10) || new Date().getFullYear();
      const fee = await annuitySvc.getVigentFee(client, federationId, 'dojo', plan);
      if (!fee) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: `Nenhuma fee configurada para o plano '${plan}' (karate_annual_fees). Informe amount manualmente ou configure a fee.`,
          code: 'VALIDATION_ERROR',
        });
      }

      // ── F2: anuidade PROPORCIONAL quando o dojô se filiou NA temporada
      // corrente (companies.affiliation_since no mesmo ano de reference_period).
      // Decisão fechada com o Caio: consolidada — calcula o valor proporcional
      // sobre o TOTAL ANUAL do plano e distribui igualmente pelas parcelas
      // (2 no semestral, 4 no trimestral) cujo vencimento ainda não passou —
      // ver buildProportionalPlanSpecs (regra completa + caso da parcela já
      // vencida documentados lá). Dojô filiado em ano anterior (renovação) ou
      // sem affiliation_since cadastrado: comportamento igual ao pré-F2
      // (buildPlanSpecs, valor cheio da fee, corte por "hoje").
      const isNewAffiliateThisSeason = !!(dojoAffiliationSince && dojoAffiliationSince.year === seasonYear);
      let built;
      if (isNewAffiliateThisSeason) {
        built = annuitySvc.buildProportionalPlanSpecs({
          plan, feeAmount: fee.amount, dueMonths: fee.due_months, seasonYear,
          affiliationMonth: dojoAffiliationSince.month, dueDateOverride,
        });
        proportionalInfo = {
          applied: true,
          affiliation_month: dojoAffiliationSince.month,
          remaining_months: built.remainingMonths,
          full_annual_amount: built.fullTotal,
          proportional_amount: built.proportionalTotal,
        };
      } else {
        built = annuitySvc.buildPlanSpecs({
          plan, amount: fee.amount, dueMonths: fee.due_months, seasonYear, fromDate: new Date(), dueDateOverride,
        });
      }
      specs = built.specs;
      dueDateAdjusted = built.dueDateAdjusted;
      if (!specs.length) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: `Não foi possível montar o plano de parcelas para '${plan}' (fee sem due_months válido).`,
          code: 'VALIDATION_ERROR',
        });
      }
    }

    // ── F2: parcela de ADESÃO (kind='filiacao', ADESAO_FEE_BRL, cobrança
    // única e À PARTE da anuidade). Seletor persistente
    // (companies.karate_charges_adhesion, Migration 248, marcado no
    // cadastro/reativação — karateDojos.js). Quando marcado, semeia a
    // parcela aqui, no MESMO annuity_id do lançamento corrente.
    // Guarda de unicidade (nunca 2 parcelas 'filiacao' abertas pro mesmo
    // dojô — reativar um dojô que já tem adesão lançada não duplica):
    // consulta via join (installments não guarda dojo_id direto), sob
    // advisory lock DEDICADO (adesão não é por período, não reaproveita o
    // lock acima). Só roda quando HAS_INSTALLMENTS — sem a infra de
    // parcelas (migration 222) não há onde semear a parcela de adesão.
    let adhesionCharged = false;
    if (HAS_INSTALLMENTS && dojoChargesAdhesion) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text || '-annuity-adhesion'))`,
        [dojoId]
      );
      const existingAdhesion = await client.query(
        `SELECT 1 FROM karate_annuity_installments i
           JOIN karate_dojo_annuity_history h ON h.id = i.annuity_id
          WHERE h.dojo_id = $1 AND i.kind = 'filiacao' LIMIT 1`,
        [dojoId]
      );
      const adhesionSpec = annuitySvc.buildAdhesionSpec({
        chargesAdhesion: dojoChargesAdhesion,
        alreadyHasAdhesionInstallment: existingAdhesion.rows.length > 0,
        affiliationSince: dojoAffiliationSince ? dojoAffiliationSince.iso : null,
        fallbackDueDate: new Date().toISOString().slice(0, 10),
      });
      if (adhesionSpec) {
        specs = [adhesionSpec, ...specs];
        adhesionCharged = true;
      }
    }

    if (HAS_INSTALLMENTS) {
      try {
        const histRes = await client.query(
          `INSERT INTO karate_dojo_annuity_history
             (dojo_id, federation_id, reference_period, plan, amount, due_date, status, created_at)
           VALUES ($1, $2, $3, $4, 0, $5, 'pending', NOW())
           RETURNING id`,
          [dojoId, federationId, reference_period, plan, specs[0].due_date]
        );
        const annuityId = histRes.rows[0].id;
        let installments = await annuitySvc.createInstallmentsForAnnuity(client, {
          annuityId, federationId, specs,
        });
        installments = await annuitySvc.createTransactionsForInstallments(client, {
          federationId, kind: 'dojo', refId: dojoId, refName: dojoName,
          referencePeriod: reference_period, installments,
        });
        const header = await annuitySvc.syncAnnuityHeaderRollup(client, annuityId);

        await client.query('COMMIT');

        await financeAudit.logFinanceAudit({
          federationId, action: 'charge_create', targetType: 'annuity', targetId: annuityId,
          dojoId, actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
          before: null,
          after: {
            plan, amount: parseFloat(header.amount), due_date: header.due_date, reference_period,
            installments_count: installments.length,
            proportional: proportionalInfo,
            adhesion_charged: adhesionCharged,
          },
        }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (charge dojo):', e.message));

        const { total, paid_total } = annuitySvc.computeTotals(installments);
        return res.status(201).json({
          dojo_id: dojoId,
          dojo_name: dojoName,
          fpkt_affiliation_id: null,
          annuity_id: annuityId,
          amount: parseFloat(header.amount),
          reference_period,
          due_date: header.due_date,
          paid_at: header.paid_at,
          status: 'due',
          days_overdue: 0,
          nfse_id: null,
          transaction_id: installments[0]?.transaction_id || null,
          annuity_history_id: annuityId,
          plan,
          installments: installments.map(i => ({
            id: i.id, seq: i.seq, kind: i.kind || 'anuidade', amount: parseFloat(i.amount), due_date: i.due_date,
            paid_at: i.paid_at, status: i.status, transaction_id: i.transaction_id,
          })),
          due_date_ajustada: dueDateAdjusted,
          // F2: null quando a anuidade não é proporcional (renovação / dojô
          // filiado em ano anterior / affiliation_since ausente / amount
          // manual); preenchido com o cálculo quando é (ver comentário acima,
          // buildProportionalPlanSpecs).
          proportional: proportionalInfo,
          // F2: true só quando a parcela de adesão (kind='filiacao') foi
          // efetivamente semeada NESTE lançamento — false tanto quando o
          // dojô não tem o seletor marcado quanto quando já existia adesão
          // (guarda de unicidade evitou duplicar).
          adhesion_charged: adhesionCharged,
          paid_total,
          total,
        });
      } catch (e) {
        await client.query('ROLLBACK');
        if (e.code === '42703' || e.code === '42P01') {
          HAS_INSTALLMENTS = false;
          console.warn('[karateAnnuities] charge: migration 222 ausente — fallback legado');
        } else {
          console.error('[karateAnnuities] charge error:', e.message);
          return res.status(500).json({ error: 'Erro ao lançar cobrança', detail: e.message });
        }
      }
    }

    // ── Fallback legado (migration 222 ainda não aplicada): 1 lançamento único,
    // idêntico ao comportamento pré-F1. Exige amount manual (sem tabela de fees).
    if (!manualAmount) {
      return res.status(422).json({ error: 'amount obrigatorio e deve ser > 0', code: 'VALIDATION_ERROR' });
    }
    await client.query('BEGIN');
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
      [federationId, Number(amount), due_date, `Anuidade dojô ${dojoName} — ${reference_period}`, idempotencyKey, dojoId, federationId]
    );
    let transactionId;
    if (!txRes.rows.length) {
      const existing = await client.query(`SELECT id FROM transactions WHERE idempotency_key = $1`, [idempotencyKey]);
      transactionId = existing.rows[0]?.id;
    } else {
      transactionId = txRes.rows[0].id;
    }
    const histRes = await client.query(
      `INSERT INTO karate_dojo_annuity_history
         (dojo_id, federation_id, reference_period, amount, due_date, status, transaction_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW())
       RETURNING id, dojo_id, reference_period, amount, due_date, status, paid_at`,
      [dojoId, federationId, reference_period, Number(amount), due_date, transactionId]
    );
    await client.query('COMMIT');
    const h = histRes.rows[0];
    await financeAudit.logFinanceAudit({
      federationId, action: 'charge_create', targetType: 'annuity', targetId: h.id,
      dojoId, actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: null,
      after: { amount: parseFloat(h.amount), due_date: h.due_date, reference_period: h.reference_period },
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (charge dojo legado):', e.message));
    res.status(201).json({
      dojo_id: dojoId,
      dojo_name: dojoName,
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
    await client.query('ROLLBACK').catch(() => {});
    console.error('[karateAnnuities] charge error:', err.message);
    res.status(500).json({ error: 'Erro ao lançar cobrança', detail: err.message });
  } finally {
    client.release();
  }
});
