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
const annuitySvc = require('../services/karateAnnuityService');
const paymentSvc = require('../services/karatePaymentService');

// ── Fase F1 (parcelas): schema pre-migration guard ──────────────
// Backend sobe antes da migration 222 ser aplicada (armadilha #1 do
// CLAUDE.md): cache module-level otimista, vira false em 42703/42P01 e as
// rotas caem para o comportamento antigo (single-row, sem plan/installments).
let HAS_INSTALLMENTS = true;

// ────────────────────────────────────────────────────────────────
const DOJO_ANNUITIES = true; // eslint-disable-line
// ────────────────────────────────────────────────────────────────
// DOJO ANNUITIES
// ────────────────────────────────────────────────────────────────

// GET /financial/annuities/dojos
// Fase F1: shape antigo 100% preservado (dojo_id, dojo_name, annuity_id,
// amount, reference_period, due_date, paid_at, status, days_overdue) — o
// front atual continua funcionando. Campos NOVOS (plan, installments[],
// paid_total, total) são aditivos, populados só quando a migration 222 já
// foi aplicada (HAS_INSTALLMENTS). amount/due_date/status continuam vindo
// do rollup do header (karate_dojo_annuity_history), mantido em sincronia
// com as parcelas por karateAnnuityService.syncAnnuityHeaderRollup.
//
// Fase F2 — paginação real: LIMIT/OFFSET + COUNT(*) no banco (não busca a
// tabela inteira pra fatiar em memória). `status` e a busca (`q`, por nome
// do dojô ou código FPKT) viram WHERE no banco via `computed_status` — um
// CASE que espelha karateFinanceService.computeAnnuityStatus() em SQL
// (mesmos limiares: due>hoje, <=90 overdue, <=180 defaulting, senão
// suspended). Os dois precisam ser mantidos em sincronia manualmente: sem
// isso não dá pra filtrar+paginar no banco, já que esse status não é uma
// coluna persistida.
// `status` aceita, além do vocabulário legado (paid|due|overdue|defaulting|
// suspended|no_charge), os alias agregados usados pelos KPIs do hub
// (GET /financial/annuities/summary — ver karateAnnuitySummary.js):
//   em_aberto = due ∪ overdue ∪ defaulting ∪ suspended (tudo não pago)
//   atrasado  = overdue ∪ defaulting ∪ suspended (não pago E já vencido)
// Isso garante que um clique num KPI do hub filtre esta lista com o MESMO
// nome de status que o KPI usa.
const STATUS_ALIASES = {
  em_aberto: ['due', 'overdue', 'defaulting', 'suspended'],
  atrasado: ['overdue', 'defaulting', 'suspended'],
};
function statusFilterValues(status) {
  if (!status) return null;
  return STATUS_ALIASES[status] || [status];
}

// SELECT list + WHERE compartilhados entre a query "com plan" (pós-migration
// 222) e o fallback legado (sem h.plan) — só o que muda é a coluna h.plan.
function dojosBaseSql(withPlan) {
  return `
    SELECT
      c.id AS dojo_id, c.name AS dojo_name, c.fpkt_affiliation_id,
      COALESCE(NULLIF(c.wa_phone_display, ''), c.phone) AS whatsapp,
      h.id AS annuity_id, h.reference_period, h.amount, h.due_date,
      h.paid_at, h.status AS annuity_status, h.transaction_id
      ${withPlan ? ', h.plan' : ''},
      CASE
        WHEN h.id IS NULL THEN 'no_charge'
        WHEN h.status = 'paid' THEN 'paid'
        WHEN h.due_date IS NULL THEN 'no_charge'
        WHEN h.due_date > CURRENT_DATE THEN 'due'
        WHEN CURRENT_DATE - h.due_date <= 90 THEN 'overdue'
        WHEN CURRENT_DATE - h.due_date <= 180 THEN 'defaulting'
        ELSE 'suspended'
      END AS computed_status,
      CASE WHEN h.due_date IS NOT NULL AND h.status <> 'paid' AND h.due_date <= CURRENT_DATE
           THEN (CURRENT_DATE - h.due_date) ELSE 0 END AS days_overdue
    FROM companies c
    LEFT JOIN karate_dojo_annuity_history h
      ON h.dojo_id = c.id AND h.reference_period = $2
    WHERE c.federation_id = $1 AND c.vertical_active = 'karate_dojo'
  `;
}

const DOJOS_FILTER_SQL = `
  WHERE ($3::text IS NULL OR dojo_name ILIKE '%' || $3 || '%' OR fpkt_affiliation_id ILIKE '%' || $3 || '%')
    AND ($4::text[] IS NULL OR computed_status = ANY($4::text[]))
`;

router.get('/annuities/dojos', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { status } = req.query;
  const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const offset   = (page - 1) * pageSize;
  const year     = (req.query.year && /^\d{4}$/.test(String(req.query.year)))
    ? String(req.query.year)
    : new Date().getFullYear().toString();
  const statusValues = statusFilterValues(status);
  const search = (req.query.q && String(req.query.q).trim()) ? String(req.query.q).trim() : null;

  try {
    let dojos;
    let total = 0;
    let selectedPlan = HAS_INSTALLMENTS;
    if (selectedPlan) {
      try {
        const countRes = await db.query(
          `SELECT COUNT(*)::int AS total FROM (${dojosBaseSql(true)}) base ${DOJOS_FILTER_SQL}`,
          [federationId, year, search, statusValues]
        );
        total = countRes.rows[0]?.total || 0;
        const r = await db.query(
          `SELECT * FROM (${dojosBaseSql(true)}) base ${DOJOS_FILTER_SQL}
           ORDER BY fpkt_affiliation_id ASC NULLS LAST, dojo_name ASC
           LIMIT $5 OFFSET $6`,
          [federationId, year, search, statusValues, pageSize, offset]
        );
        dojos = r.rows;
      } catch (e) {
        if (e.code === '42703' || e.code === '42P01') {
          HAS_INSTALLMENTS = false;
          selectedPlan = false;
          console.warn('[karateAnnuities] migration 222 ausente (plan/installments) — fallback legado');
        } else throw e;
      }
    }
    if (!selectedPlan) {
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS total FROM (${dojosBaseSql(false)}) base ${DOJOS_FILTER_SQL}`,
        [federationId, year, search, statusValues]
      );
      total = countRes.rows[0]?.total || 0;
      const r = await db.query(
        `SELECT * FROM (${dojosBaseSql(false)}) base ${DOJOS_FILTER_SQL}
         ORDER BY fpkt_affiliation_id ASC NULLS LAST, dojo_name ASC
         LIMIT $5 OFFSET $6`,
        [federationId, year, search, statusValues, pageSize, offset]
      );
      dojos = r.rows;
    }

    // Busca parcelas de todas as anuidades da PÁGINA em UMA query (evita N+1).
    let installmentsByAnnuity = {};
    if (selectedPlan) {
      const annuityIds = dojos.map(d => d.annuity_id).filter(Boolean);
      if (annuityIds.length) {
        const { rows: instRows } = await db.query(
          `SELECT id, annuity_id, seq, amount, due_date, paid_at, status, transaction_id
           FROM karate_annuity_installments
           WHERE annuity_id = ANY($1::uuid[])
           ORDER BY annuity_id, seq ASC`,
          [annuityIds]
        );
        for (const r of instRows) {
          (installmentsByAnnuity[r.annuity_id] = installmentsByAnnuity[r.annuity_id] || []).push(r);
        }
      }
    }

    const data = dojos.map(d => {
      const installments = d.annuity_id ? (installmentsByAnnuity[d.annuity_id] || []) : [];
      const out = {
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
        status: d.computed_status,
        days_overdue: d.days_overdue || 0,
        nfse_id: null, // populated from transaction if needed
      };
      if (selectedPlan) {
        const { total: instTotal, paid_total } = annuitySvc.computeTotals(installments);
        out.plan = d.plan || null;
        out.installments = installments.map(i => ({
          id: i.id,
          seq: i.seq,
          amount: parseFloat(i.amount),
          due_date: i.due_date,
          paid_at: i.paid_at,
          status: i.status,
          transaction_id: i.transaction_id,
        }));
        out.paid_total = paid_total;
        out.total = instTotal || out.amount;
      }
      return out;
    });

    res.json({ data, total, page, pageSize });
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
  const plan = rawPlan || 'anual';

  if (!reference_period) {
    return res.status(422).json({ error: 'reference_period obrigatorio', code: 'VALIDATION_ERROR' });
  }
  if (HAS_INSTALLMENTS && !annuitySvc.VALID_PLANS.includes(plan)) {
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

    // Verifica dojô
    const dojoRes = await client.query(
      `SELECT id, name FROM companies WHERE id = $1 AND federation_id = $2 AND vertical_active = 'karate_dojo' LIMIT 1`,
      [dojoId, federationId]
    );
    if (!dojoRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }
    const dojoName = dojoRes.rows[0].name;

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
      const built = annuitySvc.buildPlanSpecs({
        plan, amount: fee.amount, dueMonths: fee.due_months, seasonYear, fromDate: new Date(), dueDateOverride,
      });
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
            id: i.id, seq: i.seq, amount: parseFloat(i.amount), due_date: i.due_date,
            paid_at: i.paid_at, status: i.status, transaction_id: i.transaction_id,
          })),
          due_date_ajustada: dueDateAdjusted,
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
        const ps = await providerGetStatus({ payment_intent_id: intent.payment_intent_id, provider: intent.provider });
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
// Admin confirma pagamento manualmente. Delega pra
// services/karatePaymentService.confirmIntent (source='manual') — o mesmo
// caminho usado pelo webhook de pagamento (source='webhook'), garantindo
// que baixa manual e baixa automática produzam o efeito idêntico no
// Financeiro (transaction confirmed + NFS-e best-effort).
router.post('/payments/:intentId/confirm', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, intentId } = req.params;
  const { paid_at, emit_nfse = true } = req.body;

  try {
    const result = await paymentSvc.confirmIntent(intentId, {
      source: 'manual',
      federationId,
      paidAt: paid_at,
      emitNfse: emit_nfse,
    });

    if (result.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Intent não encontrado', code: 'NOT_FOUND' });
    }
    if (result.code === 'ALREADY_PAID') {
      return res.status(409).json({ error: 'Pagamento já confirmado', code: 'CONFLICT', idempotent_hit: true });
    }

    res.json({
      intent_id: intentId,
      transaction_id: result.transactionId,
      status: 'paid',
      paid_at: result.paidAt,
      nfse_ref: result.nfseRef,
      idempotent_hit: false,
    });
  } catch (err) {
    console.error('[karateAnnuities] confirm error:', err.message);
    res.status(500).json({ error: 'Erro ao confirmar pagamento', detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────────
// CPF ANNUITIES
// ────────────────────────────────────────────────────────────────

// GET /financial/annuities/cpf
// Fase F1: fonte primária vira karate_dojo_annuity_history (header,
// practitioner_id) + karate_annuity_installments — a migration 222 faz o
// backfill das 3.278 transactions legadas (category='annuity_cpf') para lá.
// Shape antigo preservado (amount/due_date/paid_at/status vêm do rollup do
// header); plan/installments/paid_total/total são aditivos. Fallback para a
// leitura direta de transactions se a migration ainda não foi aplicada.
//
// Fase F2 — paginação real (mesmo padrão de /annuities/dojos, ver os
// comentários lá): LIMIT/OFFSET + COUNT(*) no banco via `computed_status`
// calculado em SQL (devolve o MESMO vocabulário de status usado na listagem
// de dojôs, incluindo os alias `em_aberto`/`atrasado` usados pelos KPIs do
// summary). Busca (`q`) por nome ou número de matrícula.
function cpfBaseSql(withPlan) {
  return `
    SELECT
      cu.id AS practitioner_id, cu.name AS full_name,
      cu.karate_registration_number, cu.phone AS whatsapp,
      h.id AS annuity_id, h.reference_period, h.amount, h.due_date,
      h.paid_at, h.status AS annuity_status, h.transaction_id
      ${withPlan ? ', h.plan' : ''},
      CASE
        WHEN h.id IS NULL THEN 'no_charge'
        WHEN h.status = 'paid' THEN 'paid'
        WHEN h.due_date IS NULL THEN 'no_charge'
        WHEN h.due_date > CURRENT_DATE THEN 'due'
        WHEN CURRENT_DATE - h.due_date <= 90 THEN 'overdue'
        WHEN CURRENT_DATE - h.due_date <= 180 THEN 'defaulting'
        ELSE 'suspended'
      END AS computed_status,
      CASE WHEN h.due_date IS NOT NULL AND h.status <> 'paid' AND h.due_date <= CURRENT_DATE
           THEN (CURRENT_DATE - h.due_date) ELSE 0 END AS days_overdue
    FROM customers cu
    LEFT JOIN karate_dojo_annuity_history h
      ON h.practitioner_id = cu.id AND h.reference_period = $2
    WHERE cu.federation_id = $1
  `;
}

// Fallback legado (migration 222 ausente): computed_status direto sobre
// transactions (category='annuity_cpf'). Mesma regra canônica de "vencida"
// (due_date <= hoje) do restante da Fase F2 — CLAUDE.md #vencida.
const CPF_LEGACY_BASE_SQL = `
  SELECT
    cu.id AS practitioner_id, cu.name AS full_name,
    cu.karate_registration_number, cu.phone AS whatsapp,
    NULL::uuid AS annuity_id, NULL::text AS reference_period, t.amount, t.due_date,
    t.paid_at, NULL::text AS annuity_status, t.id AS transaction_id,
    CASE
      WHEN t.id IS NULL THEN 'no_charge'
      WHEN t.status = 'confirmed' OR t.paid_at IS NOT NULL THEN 'paid'
      WHEN t.due_date IS NULL THEN 'due'
      WHEN t.due_date > CURRENT_DATE THEN 'due'
      WHEN CURRENT_DATE - t.due_date <= 90 THEN 'overdue'
      WHEN CURRENT_DATE - t.due_date <= 180 THEN 'defaulting'
      ELSE 'suspended'
    END AS computed_status,
    CASE WHEN t.due_date IS NOT NULL AND t.status <> 'confirmed' AND t.paid_at IS NULL AND t.due_date <= CURRENT_DATE
         THEN (CURRENT_DATE - t.due_date) ELSE 0 END AS days_overdue
  FROM customers cu
  LEFT JOIN transactions t
    ON t.reference_type = 'customer' AND t.reference_id = cu.id
    AND t.category = 'annuity_cpf' AND EXTRACT(YEAR FROM t.due_date) = $2::int
    AND t.federation_id = $1
  WHERE cu.federation_id = $1
`;

const CPF_FILTER_SQL = `
  WHERE ($3::text IS NULL OR full_name ILIKE '%' || $3 || '%' OR karate_registration_number ILIKE '%' || $3 || '%')
    AND ($4::text[] IS NULL OR computed_status = ANY($4::text[]))
`;

router.get('/annuities/cpf', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { status } = req.query;
  const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const offset   = (page - 1) * pageSize;
  const year     = (req.query.year && /^\d{4}$/.test(String(req.query.year)))
    ? String(req.query.year)
    : new Date().getFullYear().toString();
  const statusValues = statusFilterValues(status);
  const search = (req.query.q && String(req.query.q).trim()) ? String(req.query.q).trim() : null;

  try {
    let rows;
    let total = 0;
    let selectedPlan = HAS_INSTALLMENTS;
    if (selectedPlan) {
      try {
        const countRes = await db.query(
          `SELECT COUNT(*)::int AS total FROM (${cpfBaseSql(true)}) base ${CPF_FILTER_SQL}`,
          [federationId, year, search, statusValues]
        );
        total = countRes.rows[0]?.total || 0;
        const r = await db.query(
          `SELECT * FROM (${cpfBaseSql(true)}) base ${CPF_FILTER_SQL}
           ORDER BY karate_registration_number ASC NULLS LAST, full_name ASC
           LIMIT $5 OFFSET $6`,
          [federationId, year, search, statusValues, pageSize, offset]
        );
        rows = r.rows;
      } catch (e) {
        if (e.code === '42703' || e.code === '42P01') {
          HAS_INSTALLMENTS = false;
          selectedPlan = false;
          console.warn('[karateAnnuities] cpf list: migration 222 ausente — fallback legado');
        } else throw e;
      }
    }

    let installmentsByAnnuity = {};
    if (selectedPlan) {
      const annuityIds = rows.map(r => r.annuity_id).filter(Boolean);
      if (annuityIds.length) {
        const { rows: instRows } = await db.query(
          `SELECT id, annuity_id, seq, amount, due_date, paid_at, status, transaction_id
           FROM karate_annuity_installments
           WHERE annuity_id = ANY($1::uuid[])
           ORDER BY annuity_id, seq ASC`,
          [annuityIds]
        );
        for (const r of instRows) {
          (installmentsByAnnuity[r.annuity_id] = installmentsByAnnuity[r.annuity_id] || []).push(r);
        }
      }
    }

    let data;
    if (selectedPlan) {
      data = rows.map(r => {
        const installments = r.annuity_id ? (installmentsByAnnuity[r.annuity_id] || []) : [];
        const { total: instTotal, paid_total } = annuitySvc.computeTotals(installments);
        return {
          practitioner_id: r.practitioner_id,
          full_name: r.full_name,
          karate_registration_number: r.karate_registration_number || null,
          whatsapp: r.whatsapp || null,
          annuity_id: r.annuity_id || null,
          amount: r.amount ? parseFloat(r.amount) : 0,
          reference_period: r.reference_period || year,
          due_date: r.due_date || null,
          paid_at: r.paid_at || null,
          status: r.computed_status,
          days_overdue: r.days_overdue || 0,
          transaction_id: r.transaction_id || null,
          plan: r.plan || null,
          installments: installments.map(i => ({
            id: i.id, seq: i.seq, amount: parseFloat(i.amount), due_date: i.due_date,
            paid_at: i.paid_at, status: i.status, transaction_id: i.transaction_id,
          })),
          paid_total,
          total: instTotal || (r.amount ? parseFloat(r.amount) : 0),
        };
      });
    } else {
      // Fallback legado (migration 222 ausente): transactions diretamente.
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS total FROM (${CPF_LEGACY_BASE_SQL}) base ${CPF_FILTER_SQL}`,
        [federationId, year, search, statusValues]
      );
      total = countRes.rows[0]?.total || 0;
      const r = await db.query(
        `SELECT * FROM (${CPF_LEGACY_BASE_SQL}) base ${CPF_FILTER_SQL}
         ORDER BY karate_registration_number ASC NULLS LAST, full_name ASC
         LIMIT $5 OFFSET $6`,
        [federationId, year, search, statusValues, pageSize, offset]
      );
      data = r.rows.map(row => ({
        practitioner_id: row.practitioner_id,
        full_name: row.full_name,
        karate_registration_number: row.karate_registration_number || null,
        whatsapp: row.whatsapp || null,
        amount: row.amount ? parseFloat(row.amount) : 0,
        reference_period: year,
        due_date: row.due_date || null,
        paid_at: row.paid_at || null,
        status: row.computed_status,
        days_overdue: row.days_overdue || 0,
      }));
    }

    res.json({ data, total, page, pageSize });
  } catch (err) {
    console.error('[karateAnnuities] list cpf error:', err.message);
    res.status(500).json({ error: 'Erro ao listar anuidades CPF' });
  }
});

// POST /financial/annuities/cpf/:practitionerId/charge
// Fase F1: aceita `plan` (default 'anual' — hoje o único plano CPF, N=1).
// Sem `amount` explícito, usa a fee vigente ('cpf', plan) de
// karate_annual_fees. Cria header (practitioner_id) + N parcelas (mesmo
// mecanismo do dojô). Com `amount` explícito, mantém o contrato antigo (1
// parcela única no valor informado).
//
// Continuação F3 (PR #356): mesmas regras do /charge de dojô — `due_date`
// opcional sobrescreve o vencimento da parcela gerada, e "todas as
// parcelas já venceram" não erra mais com 422: gera a última parcela com
// due_date = fim do mês corrente (default seguro) ou o `due_date`
// informado. Ver buildPlanSpecs em karateAnnuityService.js.
router.post('/annuities/cpf/:practitionerId/charge', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  const { amount, due_date, reference_period, plan: rawPlan } = req.body || {};
  const plan = rawPlan || 'anual';

  if (!reference_period) {
    return res.status(422).json({ error: 'reference_period obrigatorio', code: 'VALIDATION_ERROR' });
  }
  if (HAS_INSTALLMENTS && !annuitySvc.VALID_PLANS.includes(plan)) {
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

    if (HAS_INSTALLMENTS) {
      try {
        // Advisory lock + checagem de duplicidade (header practitioner_id+período)
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1::text || '-cpf-annuity-' || $2::text))`,
          [practitionerId, reference_period]
        );
        const existingRes = await client.query(
          `SELECT id FROM karate_dojo_annuity_history WHERE practitioner_id = $1 AND reference_period = $2 LIMIT 1`,
          [practitionerId, reference_period]
        );
        if (existingRes.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'Já existe cobrança para este praticante no período ' + reference_period,
            code: 'CONFLICT',
          });
        }

        let specs;
        let dueDateAdjusted = false;
        if (manualAmount) {
          specs = [{ seq: 1, amount: Number(amount), due_date }];
        } else {
          const seasonYear = parseInt(reference_period, 10) || new Date().getFullYear();
          const fee = await annuitySvc.getVigentFee(client, federationId, 'cpf', plan);
          if (!fee) {
            await client.query('ROLLBACK');
            return res.status(422).json({
              error: `Nenhuma fee configurada para o plano '${plan}' (karate_annual_fees, fee_type='cpf').`,
              code: 'VALIDATION_ERROR',
            });
          }
          const built = annuitySvc.buildPlanSpecs({
            plan, amount: fee.amount, dueMonths: fee.due_months, seasonYear, fromDate: new Date(), dueDateOverride,
          });
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

        const histRes = await client.query(
          `INSERT INTO karate_dojo_annuity_history
             (dojo_id, federation_id, practitioner_id, reference_period, plan, amount, due_date, status, created_at)
           VALUES (NULL, $1, $2, $3, $4, 0, $5, 'pending', NOW())
           RETURNING id`,
          [federationId, practitionerId, reference_period, plan, specs[0].due_date]
        );
        const annuityId = histRes.rows[0].id;
        let installments = await annuitySvc.createInstallmentsForAnnuity(client, {
          annuityId, federationId, specs,
        });
        installments = await annuitySvc.createTransactionsForInstallments(client, {
          federationId, kind: 'cpf', refId: practitionerId, refName: pract.full_name,
          referencePeriod: reference_period, installments,
        });
        const header = await annuitySvc.syncAnnuityHeaderRollup(client, annuityId);
        await client.query('COMMIT');

        const { total, paid_total } = annuitySvc.computeTotals(installments);
        return res.status(201).json({
          practitioner_id: practitionerId,
          full_name: pract.full_name,
          amount: parseFloat(header.amount),
          reference_period,
          due_date: header.due_date,
          paid_at: header.paid_at,
          status: 'due',
          transaction_id: installments[0]?.transaction_id || null,
          annuity_id: annuityId,
          annuity_history_id: annuityId,
          plan,
          installments: installments.map(i => ({
            id: i.id, seq: i.seq, amount: parseFloat(i.amount), due_date: i.due_date,
            paid_at: i.paid_at, status: i.status, transaction_id: i.transaction_id,
          })),
          due_date_ajustada: dueDateAdjusted,
          paid_total,
          total,
        });
      } catch (e) {
        await client.query('ROLLBACK');
        if (e.code === '42703' || e.code === '42P01') {
          HAS_INSTALLMENTS = false;
          console.warn('[karateAnnuities] cpf charge: migration 222 ausente — fallback legado');
        } else {
          console.error('[karateAnnuities] cpf charge error:', e.message);
          return res.status(500).json({ error: 'Erro ao lançar cobrança CPF', detail: e.message });
        }
      }
    }

    // ── Fallback legado: 1 transaction direta, sem header/parcelas. ──
    if (!manualAmount) {
      return res.status(422).json({ error: 'amount obrigatorio e deve ser > 0', code: 'VALIDATION_ERROR' });
    }
    await client.query('BEGIN');
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
      [federationId, Number(amount), due_date, `Anuidade CPF ${pract.full_name} — ${reference_period}`, idempotencyKey, practitionerId, federationId]
    );
    let transactionId;
    if (!txRes.rows.length) {
      const ex = await client.query(`SELECT id FROM transactions WHERE idempotency_key = $1`, [idempotencyKey]);
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
    await client.query('ROLLBACK').catch(() => {});
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


// ────────────────────────────────────────────────────────────────
// Fase F1 — ROTAS SOBRE PARCELAS (funcionam para dojô E praticante)
// ────────────────────────────────────────────────────────────────

// Estorna/cancela TODA a anuidade (todas as parcelas) — generaliza o void
// legado (dojos/:dojoId/:annuityId/void) para qualquer header (dojo_id OU
// practitioner_id). Cancela as transactions de cada parcela (preserva
// trilha), cancela intents PIX pendentes (annuity_history_id legado E
// source_id por parcela — migration 213) e apaga o header (CASCADE apaga as
// parcelas). Idempotente.
async function voidAnnuityCore(client, { federationId, annuityId }) {
  const histRes = await client.query(
    `SELECT id, dojo_id, practitioner_id, federation_id, reference_period, plan, status, transaction_id
     FROM karate_dojo_annuity_history WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [annuityId, federationId]
  );
  if (!histRes.rows.length) return { found: false };
  const hist = histRes.rows[0];

  let installments = [];
  try {
    const r = await client.query(
      `SELECT id, transaction_id FROM karate_annuity_installments WHERE annuity_id = $1`,
      [annuityId]
    );
    installments = r.rows;
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }

  const txIds = new Set();
  installments.forEach((i) => { if (i.transaction_id) txIds.add(i.transaction_id); });
  if (hist.transaction_id) txIds.add(hist.transaction_id);

  for (const txId of txIds) {
    await client.query(
      `UPDATE transactions SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status <> 'cancelled'`,
      [txId]
    );
  }

  const installmentIds = installments.map((i) => i.id);
  await client.query(
    `UPDATE karate_payment_intents SET status = 'cancelled', updated_at = NOW()
     WHERE status = 'pending' AND (annuity_history_id = $1 OR source_id = ANY($2::uuid[]))`,
    [annuityId, installmentIds]
  );

  await client.query(`DELETE FROM karate_dojo_annuity_history WHERE id = $1`, [annuityId]);

  return {
    found: true,
    dojo_id: hist.dojo_id,
    practitioner_id: hist.practitioner_id,
    reference_period: hist.reference_period,
    transaction_ids: Array.from(txIds),
  };
}

// POST /financial/annuities/:annuityId/void
router.post('/annuities/:annuityId/void', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, annuityId } = req.params;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await voidAnnuityCore(client, { federationId, annuityId });
    if (!result.found) {
      await client.query('ROLLBACK');
      return res.json({ voided: true, idempotent_hit: true, annuity_id: annuityId });
    }
    await client.query('COMMIT');
    res.json({
      voided: true,
      idempotent_hit: false,
      annuity_id: annuityId,
      dojo_id: result.dojo_id || null,
      practitioner_id: result.practitioner_id || null,
      reference_period: result.reference_period,
      transaction_ids: result.transaction_ids,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[karateAnnuities] void (generic) error:', err.message);
    res.status(500).json({ error: 'Erro ao estornar anuidade', detail: err.message });
  } finally {
    client.release();
  }
});

// PATCH /financial/annuities/:annuityId/plan
// Troca o plano de uma anuidade de DOJÔ (praticante só tem 'anual', N=1 —
// não se aplica). 409 HAS_PAID_INSTALLMENT se alguma parcela já foi paga.
// 409 HAS_NFSE se já existe NFS-e emitida/em processamento para alguma
// transaction das parcelas atuais (nota fiscal não se cancela por troca de
// plano — exige estorno). Recria as parcelas do zero (só as que ainda não
// venceram) com o preço vigente do novo plano.
router.patch('/annuities/:annuityId/plan', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, annuityId } = req.params;
  const { plan } = req.body || {};

  if (!plan || !annuitySvc.VALID_PLANS.includes(plan)) {
    return res.status(422).json({
      error: `plan inválido. Valores aceitos: ${annuitySvc.VALID_PLANS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const histRes = await client.query(
      `SELECT id, dojo_id, practitioner_id, federation_id, reference_period, plan
       FROM karate_dojo_annuity_history WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [annuityId, federationId]
    );
    if (!histRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Anuidade não encontrada', code: 'NOT_FOUND' });
    }
    const hist = histRes.rows[0];

    if (hist.practitioner_id) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Praticante só tem o plano anual (parcela única) — troca de plano não se aplica',
        code: 'VALIDATION_ERROR',
      });
    }

    const instRes = await client.query(
      `SELECT id, status, transaction_id FROM karate_annuity_installments WHERE annuity_id = $1`,
      [annuityId]
    );
    const installments = instRes.rows;

    if (installments.some((i) => i.status === 'paid')) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Já existe parcela paga — não é possível trocar o plano. Use estorno (void) se precisar reverter.',
        code: 'HAS_PAID_INSTALLMENT',
      });
    }

    const txIds = installments.map((i) => i.transaction_id).filter(Boolean);
    if (txIds.length) {
      const nfseRes = await client.query(
        `SELECT id FROM nfe_documents
         WHERE type = 'nfse' AND status IN ('authorized','processing')
           AND (payload::jsonb ->> 'transaction_id') = ANY($1::text[])
         LIMIT 1`,
        [txIds.map(String)]
      ).catch(() => ({ rows: [] }));
      if (nfseRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Já existe NFS-e emitida para esta anuidade — nota fiscal não se cancela por troca de plano, exige estorno.',
          code: 'HAS_NFSE',
        });
      }
    }

    // Cancela as transactions das parcelas atuais (preserva trilha) e apaga
    // as parcelas (nenhuma está paga — checado acima).
    for (const i of installments) {
      if (i.transaction_id) {
        await client.query(
          `UPDATE transactions SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status <> 'cancelled'`,
          [i.transaction_id]
        );
      }
    }
    await client.query(
      `UPDATE karate_payment_intents SET status = 'cancelled', updated_at = NOW()
       WHERE status = 'pending' AND source_id = ANY($1::uuid[])`,
      [installments.map((i) => i.id)]
    );
    await client.query(`DELETE FROM karate_annuity_installments WHERE annuity_id = $1`, [annuityId]);

    const seasonYear = parseInt(hist.reference_period, 10) || new Date().getFullYear();
    const fee = await annuitySvc.getVigentFee(client, federationId, 'dojo', plan);
    if (!fee) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: `Nenhuma fee configurada para o plano '${plan}' (karate_annual_fees).`,
        code: 'VALIDATION_ERROR',
      });
    }
    const specs = annuitySvc.buildInstallmentPlan({
      plan, amount: fee.amount, dueMonths: fee.due_months, seasonYear, fromDate: new Date(),
    });
    if (!specs.length) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Todas as parcelas do novo plano já venceram para este período — nada a lançar.',
        code: 'VALIDATION_ERROR',
      });
    }

    let newInstallments = await annuitySvc.createInstallmentsForAnnuity(client, {
      annuityId, federationId, specs,
    });
    const dojoRes = await client.query(`SELECT name FROM companies WHERE id = $1 LIMIT 1`, [hist.dojo_id]);
    newInstallments = await annuitySvc.createTransactionsForInstallments(client, {
      federationId,
      kind: 'dojo',
      refId: hist.dojo_id,
      refName: dojoRes.rows[0]?.name || 'Dojô',
      referencePeriod: hist.reference_period,
      installments: newInstallments,
    });

    await client.query(`UPDATE karate_dojo_annuity_history SET plan = $1, updated_at = NOW() WHERE id = $2`, [plan, annuityId]);
    const header = await annuitySvc.syncAnnuityHeaderRollup(client, annuityId);

    await client.query('COMMIT');

    const { total, paid_total } = annuitySvc.computeTotals(newInstallments);
    res.json({
      annuity_id: annuityId,
      dojo_id: hist.dojo_id,
      plan,
      amount: parseFloat(header.amount),
      due_date: header.due_date,
      installments: newInstallments.map((i) => ({
        id: i.id, seq: i.seq, amount: parseFloat(i.amount), due_date: i.due_date,
        paid_at: i.paid_at, status: i.status, transaction_id: i.transaction_id,
      })),
      paid_total,
      total,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[karateAnnuities] patch plan error:', err.message);
    res.status(500).json({ error: 'Erro ao trocar plano', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /financial/annuities/installments/:installmentId/pay — baixa manual
// de UMA parcela (dojô ou praticante). Idempotente.
router.post('/annuities/installments/:installmentId/pay', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, installmentId } = req.params;
  const { paid_at, payment_method = 'pix', amount: overrideAmount } = req.body || {};

  if (payment_method && !annuitySvc.VALID_PAYMENT_METHODS.includes(payment_method)) {
    return res.status(422).json({
      error: `payment_method inválido. Valores aceitos: ${annuitySvc.VALID_PAYMENT_METHODS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const instRes = await client.query(
      `SELECT i.*, h.federation_id, h.dojo_id, h.practitioner_id, h.reference_period, h.plan,
              COALESCE(c1.name, c2.name) AS ref_name
       FROM karate_annuity_installments i
       JOIN karate_dojo_annuity_history h ON h.id = i.annuity_id
       LEFT JOIN companies c1 ON c1.id = h.dojo_id
       LEFT JOIN customers c2 ON c2.id = h.practitioner_id
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
      return res.json({
        installment_id: inst.id, annuity_id: inst.annuity_id, seq: inst.seq,
        amount: parseFloat(inst.amount), paid_at: inst.paid_at, payment_method: inst.payment_method || null,
        status: 'paid', transaction_id: inst.transaction_id || null, idempotent_hit: true,
      });
    }

    let paidAtValue;
    if (paid_at) paidAtValue = new Date(`${paid_at}T12:00:00-03:00`).toISOString();
    else paidAtValue = new Date().toISOString();

    const effectiveAmount = overrideAmount !== undefined ? Number(overrideAmount) : parseFloat(inst.amount);
    if (isNaN(effectiveAmount) || effectiveAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
    }

    let transactionId = inst.transaction_id;
    if (transactionId) {
      await client.query(
        `UPDATE transactions SET status = 'confirmed', paid_at = $1, amount = $2, updated_at = NOW() WHERE id = $3`,
        [paidAtValue, effectiveAmount, transactionId]
      );
    } else {
      const kind = inst.dojo_id ? 'dojo' : 'cpf';
      const idempotencyKey = `annuity-manual-pay-${inst.id}`;
      const category = annuitySvc.categoryForKind(kind);
      const referenceType = kind === 'cpf' ? 'customer' : 'karate_dojo';
      const refId = inst.dojo_id || inst.practitioner_id;
      const txRes = await client.query(
        `INSERT INTO transactions
           (company_id, type, category, amount, status, due_date, description, idempotency_key,
            reference_type, reference_id, federation_id, paid_at, created_at, updated_at)
         VALUES ($1,'income',$2,$3,'confirmed',$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
         ON CONFLICT (idempotency_key) DO UPDATE SET status = 'confirmed', paid_at = EXCLUDED.paid_at, updated_at = NOW()
         RETURNING id`,
        [
          federationId, category, effectiveAmount, inst.due_date,
          `Anuidade ${kind === 'cpf' ? '' : 'dojô '}${inst.ref_name} — ${inst.reference_period}`,
          idempotencyKey, referenceType, refId, federationId, paidAtValue,
        ]
      );
      transactionId = txRes.rows[0].id;
    }

    await client.query(
      `UPDATE karate_annuity_installments
       SET status = 'paid', paid_at = $1, payment_method = $2, transaction_id = $3, updated_at = NOW()
       WHERE id = $4`,
      [paidAtValue, payment_method, transactionId, installmentId]
    );
    await client.query(
      `UPDATE karate_payment_intents SET status = 'cancelled', updated_at = NOW()
       WHERE source_id = $1 AND status = 'pending'`,
      [installmentId]
    );

    const header = await annuitySvc.syncAnnuityHeaderRollup(client, inst.annuity_id);
    await client.query('COMMIT');

    res.json({
      installment_id: installmentId,
      annuity_id: inst.annuity_id,
      seq: inst.seq,
      amount: effectiveAmount,
      paid_at: paidAtValue,
      payment_method,
      status: 'paid',
      transaction_id: transactionId,
      annuity_status: header?.status || null,
      idempotent_hit: false,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[karateAnnuities] installment pay error:', err.message);
    res.status(500).json({ error: 'Erro ao registrar pagamento da parcela', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /financial/annuities/installments/:installmentId/pix — cria intent PIX
// para UMA parcela. Preenche as colunas agnósticas de provider da migration
// 213 (amount, source_type='dojo_annuity'|'cpf_annuity', source_id=installmentId,
// description), além de annuity_history_id/transaction_id (legado, para
// compat com o /payments/:intentId/confirm existente).
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

// PATCH /financial/annuities/installments/:installmentId — corrige
// amount/due_date de UMA parcela AINDA NÃO paga. 409 se já paga.
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


// Exposto para reuso (Fase F4: POST /annuities/void-batch reusa a MESMA
// lógica de estorno/remoção do void individual — ver karateAnnuityBilling.js).
// Express Router é uma função; anexar uma propriedade nela não interfere
// na montagem via router.use(path, require('./karateAnnuities')).
router.__voidAnnuityCore = voidAnnuityCore;

module.exports = router;
