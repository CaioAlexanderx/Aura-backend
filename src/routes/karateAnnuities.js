// ============================================================
// AURA KARATÊ — Rotas de Anuidades (Track B)
//
// Anuidades Dojô:
//   GET   /financial/annuities/dojos                    — lista c/ status
//         (?dojo_id= filtra UM único dojô — página de detalhe do dojô,
//          reusa a mesma listagem/mesmos componentes da aba de Anuidades;
//          AND adicional sobre o escopo de federação, nunca o substitui)
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
//   GET   /financial/annuities/cpf                      — lista praticantes
//         (?member_status=active|inactive|all — default active, espelha
//          dojo_status; ver seção CPF ANNUITIES abaixo)
//   POST  /financial/annuities/cpf/:practitionerId/charge
//   PATCH /financial/annuities/cpf/:practitionerId/:annuityId — corrige cobrança (amount/reference_period/due_date)
//   POST  /financial/annuities/cpf/:practitionerId/pix
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
const financeAudit = require('../services/karateFinanceAudit');

// Validação simples de uuid p/ query params opcionais (ex.: ?dojo_id=).
// Mesmo padrão de UUID_RE usado em karateDojoFederativeService.js.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const { applyAnnuityPayment, AnnuityPaymentError, toIsoDate, recomputeAnnuityFromLedger, round2 } = require('../services/karateAnnuityLedger');

// ── Fase F1 (parcelas): schema pre-migration guard ──────────────
// Backend sobe antes da migration 222 ser aplicada (armadilha #1 do
// CLAUDE.md): cache module-level otimista, vira false em 42703/42P01 e as
// rotas caem para o comportamento antigo (single-row, sem plan/installments).
let HAS_INSTALLMENTS = true;

// Migration 226 — companies.karate_annuity_plan (plano de anuidade REAL do
// dojô; NULL = federação ainda não definiu). Mesma armadilha_schema_pre_migration
// do CLAUDE.md: cache module-level otimista, vira false em 42703.
let HAS_DOJO_ANNUITY_PLAN_COL = true;

// Migration 248 (F2 da reforma da anuidade) — companies.karate_charges_adhesion
// (seletor "este dojô paga taxa de adesão?", marcado no cadastro/reativação
// — ver karateDojos.js). Mesma armadilha_schema_pre_migration do CLAUDE.md.
let HAS_CHARGES_ADHESION_COL = true;

// companies.affiliation_since é schema PRÉ-EXISTENTE (não é desta fase, não
// precisa de flag defensiva) — fonte da data de filiação usada pelo F2 para
// o cálculo proporcional (computeProportionalAnnuity) e para o due_date
// "na filiação" da parcela de adesão (buildAdhesionSpec).
//
// Busca { id, name, karate_annuity_plan, affiliation_since,
// karate_charges_adhesion } do dojô, defensivamente. Usado por
// POST /annuities/dojos/:dojoId/charge para resolver: (a) a ordem de
// precedência do plano (plan explícito no request > karate_annuity_plan do
// dojô > F2: nunca 'anual' silencioso); (b) se a anuidade deste lançamento
// deve ser PROPORCIONAL (dojô filiado no ano da temporada corrente — F2);
// (c) se deve semear a parcela de adesão (F2, karate_charges_adhesion).
async function fetchDojoForCharge(client, dojoId, federationId) {
  const cols = ['id', 'name', 'affiliation_since'];
  if (HAS_DOJO_ANNUITY_PLAN_COL) cols.push('karate_annuity_plan');
  if (HAS_CHARGES_ADHESION_COL) cols.push('karate_charges_adhesion');
  try {
    return await client.query(
      `SELECT ${cols.join(', ')} FROM companies
       WHERE id = $1 AND federation_id = $2 AND vertical_active = 'karate_dojo' AND karate_dojo_linked_at IS NOT NULL LIMIT 1`,
      [dojoId, federationId]
    );
  } catch (e) {
    if (e.code === '42703') {
      const msg = e.message || '';
      let disabled = false;
      if (HAS_DOJO_ANNUITY_PLAN_COL && /karate_annuity_plan/.test(msg)) { HAS_DOJO_ANNUITY_PLAN_COL = false; disabled = true; }
      if (HAS_CHARGES_ADHESION_COL && /karate_charges_adhesion/.test(msg)) { HAS_CHARGES_ADHESION_COL = false; disabled = true; }
      if (disabled) {
        console.warn('[karateAnnuities] coluna ausente em fetchDojoForCharge (migration pendente) — retry sem ela:', msg);
        return fetchDojoForCharge(client, dojoId, federationId);
      }
    }
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────
// ── Fase F3: reconcilia `transactions` (Financeiro/DRE geral, tabela
// cross-vertical) depois de uma baixa aplicada via applyAnnuityPayment.
//
// Por que isto existe: o motor de baixa (karateAnnuityLedger.js) só sabe
// sobre karate_annuity_installments/karate_annuity_payments — de propósito
// (não é module dele conhecer `transactions`, que é genérica de todas as
// verticais). Mas o Financeiro/DRE do produto lê `transactions.status`,
// não o ledger da anuidade. Sem isto, uma baixa aplicada só pelo motor
// nunca apareceria como "confirmado" no Financeiro — seria uma SEGUNDA
// divergência de fonte de verdade, do mesmo tipo que este PR existe pra
// eliminar (só que ao contrário: dado correto no ledger, desatualizado em
// `transactions`). Best-effort, roda DEPOIS do commit do motor (mesmo
// padrão de financeAudit/NFS-e neste arquivo — nunca desfaz uma baixa já
// commitada por falhar aqui).
//
// Só marca 'confirmed' as parcelas que FECHARAM nesta baixa
// (closes_installment=true, ou seja status_after='paid') — `transactions`
// não tem conceito de "parcial" (é status binário pending/confirmed/
// cancelled); o valor granular pago mora em installments.amount_paid e no
// ledger, não em transactions.amount.
async function reconcileClosedInstallmentTransactions(allocations, paidAtIso) {
  const closedIds = (allocations || [])
    .filter((a) => a.closes_installment)
    .map((a) => a.installment_id);
  if (!closedIds.length) return;
  try {
    await db.query(
      `UPDATE transactions t
          SET status = 'confirmed', paid_at = $1, updated_at = NOW()
         FROM karate_annuity_installments i
        WHERE i.id = ANY($2::uuid[]) AND t.id = i.transaction_id AND t.status <> 'confirmed'`,
      [paidAtIso, closedIds]
    );
  } catch (e) {
    console.error('[karateAnnuities] reconcileClosedInstallmentTransactions falhou (best-effort, Financeiro pode ficar temporariamente desatualizado):', e.message);
  }
}

// ── reconcileInstallmentTransactions — reconciliação BIDIRECIONAL de
// `transactions` usada pelas rotas de EDIÇÃO/REMOÇÃO de baixa (PATCH/DELETE
// .../payments/:paymentId, abaixo). Diferente de
// reconcileClosedInstallmentTransactions (acima, usada pelas baixas
// normais): aquela só FECHA (baixa nova nunca reabre uma parcela). Editar
// pra baixo ou remover uma baixa PODE reabrir uma parcela que estava
// 'paid' — a transaction vinculada precisa voltar pra 'pending' (paid_at
// NULL), senão o Financeiro mostra confirmado algo que a parcela não
// respalda mais. Recebe `installments` já no shape devolvido por
// recomputeAnnuityFromLedger (RETURNING * de karate_annuity_installments —
// tem status/paid_at/transaction_id atualizados). Best-effort (nunca
// desfaz o recompute já commitado por falhar aqui, mesmo padrão do resto
// deste arquivo) — roda DEPOIS do commit da transação principal.
// NUNCA mexe em transaction com status='cancelled' (void já é definitivo,
// reabrir uma parcela void'ada não deve reviver a transaction cancelada —
// mesma guarda usada em PATCH /installments/:installmentId, linha ~2374).
async function reconcileInstallmentTransactions(installments) {
  const toClose = (installments || []).filter((i) => i.status === 'paid' && i.transaction_id);
  const toReopen = (installments || []).filter((i) => i.status !== 'paid' && i.transaction_id);

  try {
    for (const inst of toClose) {
      await db.query(
        `UPDATE transactions SET status = 'confirmed', paid_at = $1, updated_at = NOW()
          WHERE id = $2 AND status <> 'confirmed'`,
        [inst.paid_at, inst.transaction_id]
      );
    }
    if (toReopen.length) {
      const ids = toReopen.map((i) => i.transaction_id);
      await db.query(
        `UPDATE transactions SET status = 'pending', paid_at = NULL, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND status = 'confirmed'`,
        [ids]
      );
    }
  } catch (e) {
    console.error('[karateAnnuities] reconcileInstallmentTransactions falhou (best-effort, Financeiro pode ficar temporariamente desatualizado):', e.message);
  }
}

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
//
// dojo_status (Caio, 21/07/2026): dojô inativo não é acionável — não dá
// pra cobrar nem controlar quem já saiu da federação. Por isso a listagem
// filtra por companies.is_active via $3 (array de boolean, ou NULL pra
// "todos"). Default do endpoint é [true] (só ativos) — ver route handler
// abaixo. c.is_active também é exposto no SELECT (dojo_is_active) pra UI
// poder rotular o dojô quando dojo_status=all/inactive trouxer os dois.
// MESMO critério usado pelo summary/KPIs (karateAnnuitySummary.js) — ver
// dojoStatusToIsActiveValues em karateAnnuityService.js, compartilhado
// pelos dois arquivos pra lista e KPI nunca divergirem.
//
// ⚠️ Numeração posicional: $1=federationId, $2=year, $3=dojoStatusValues,
// $4=dojoIdFilter. Isso empurra o resto pra baixo — search vira $5,
// statusValues $6, pageSize $7, offset $8 (ver DOJOS_FILTER_SQL e os 4 call
// sites da rota).
//
// dojo_id ($4, uuid ou NULL — Caio, 27/07/2026): filtro OPCIONAL por UM
// único dojô, usado pela página de detalhe do dojô (frontend:
// app/karate/(federation)/dojos/[dojoId].tsx) pra reusar esta MESMA rota/
// MESMOS componentes da aba de Anuidades do hub, em vez de duplicar a
// query. É um AND ADICIONAL sobre c.federation_id = $1 — NUNCA substitui o
// escopo de federação. dojo_id de outra federação não bate com nenhuma
// linha (c.federation_id = $1 já exclui) e a lista volta vazia, nunca
// vaza dado de outra federação.
function dojosBaseSql(withPlan) {
  return `
    SELECT
      c.id AS dojo_id, c.name AS dojo_name, c.fpkt_affiliation_id,
      c.is_active AS dojo_is_active,
      COALESCE(NULLIF(c.wa_phone_display, ''), c.phone) AS whatsapp,
      NULLIF(c.email, '') AS email,
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
      AND c.karate_dojo_linked_at IS NOT NULL
      AND ($3::boolean[] IS NULL OR c.is_active = ANY($3::boolean[]))
      AND ($4::uuid IS NULL OR c.id = $4)
  `;
}

const DOJOS_FILTER_SQL = `
  WHERE ($5::text IS NULL OR dojo_name ILIKE '%' || $5 || '%' OR fpkt_affiliation_id ILIKE '%' || $5 || '%')
    AND ($6::text[] IS NULL OR computed_status = ANY($6::text[]))
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
  // dojo_status: ativo/inativo do DOJÔ (companies.is_active) — NÃO confundir
  // com `status`, que é status de ANUIDADE (paid/overdue/em_aberto/...).
  // Default 'active' (Caio, 21/07/2026): inativo nunca infla a listagem
  // nem os KPIs por padrão. Ver dojoStatusToIsActiveValues (compartilhado
  // com o summary em karateAnnuityService.js).
  const dojoStatus = annuitySvc.parseDojoStatus(req.query.dojo_status);
  if (dojoStatus === null) {
    return res.status(422).json({
      error: `dojo_status inválido. Valores aceitos: ${annuitySvc.DOJO_STATUS_VALUES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  const dojoStatusValues = annuitySvc.dojoStatusToIsActiveValues(dojoStatus);
  // dojo_id (Caio, 27/07/2026): filtro OPCIONAL por um único dojô — ver
  // comentário em dojosBaseSql/DOJOS_FILTER_SQL acima. uuid inválido -> 422
  // (mesmo padrão de dojo_status logo acima), nunca chega ao banco.
  // Ausente/vazio -> dojoIdFilter fica null -> comportamento 100% idêntico
  // ao atual (o AND ($4::uuid IS NULL OR c.id = $4) vira no-op).
  const rawDojoId = req.query.dojo_id;
  let dojoIdFilter = null;
  if (rawDojoId !== undefined && rawDojoId !== null && String(rawDojoId).trim() !== '') {
    const trimmedDojoId = String(rawDojoId).trim();
    if (!UUID_RE.test(trimmedDojoId)) {
      return res.status(422).json({ error: 'dojo_id inválido (uuid esperado)', code: 'VALIDATION_ERROR' });
    }
    dojoIdFilter = trimmedDojoId;
  }

  try {
    let dojos;
    let total = 0;
    let selectedPlan = HAS_INSTALLMENTS;
    if (selectedPlan) {
      try {
        const countRes = await db.query(
          `SELECT COUNT(*)::int AS total FROM (${dojosBaseSql(true)}) base ${DOJOS_FILTER_SQL}`,
          [federationId, year, dojoStatusValues, dojoIdFilter, search, statusValues]
        );
        total = countRes.rows[0]?.total || 0;
        const r = await db.query(
          `SELECT * FROM (${dojosBaseSql(true)}) base ${DOJOS_FILTER_SQL}
           ORDER BY fpkt_affiliation_id ASC NULLS LAST, dojo_name ASC
           LIMIT $7 OFFSET $8`,
          [federationId, year, dojoStatusValues, dojoIdFilter, search, statusValues, pageSize, offset]
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
        [federationId, year, dojoStatusValues, dojoIdFilter, search, statusValues]
      );
      total = countRes.rows[0]?.total || 0;
      const r = await db.query(
        `SELECT * FROM (${dojosBaseSql(false)}) base ${DOJOS_FILTER_SQL}
         ORDER BY fpkt_affiliation_id ASC NULLS LAST, dojo_name ASC
         LIMIT $7 OFFSET $8`,
        [federationId, year, dojoStatusValues, dojoIdFilter, search, statusValues, pageSize, offset]
      );
      dojos = r.rows;
    }

    // Busca parcelas de todas as anuidades da PÁGINA em UMA query (evita N+1).
    let installmentsByAnnuity = {};
    if (selectedPlan) {
      const annuityIds = dojos.map(d => d.annuity_id).filter(Boolean);
      if (annuityIds.length) {
        const { rows: instRows } = await db.query(
          `SELECT id, annuity_id, seq, amount, amount_paid, due_date, paid_at, status, transaction_id
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
        // is_active: companies.is_active do dojô — pra UI rotular quando
        // dojo_status=all/inactive trouxer registros inativos na mesma lista.
        is_active: d.dojo_is_active !== false,
        whatsapp: d.whatsapp || null,
        email: d.email || null,
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
          amount_paid: i.amount_paid != null ? parseFloat(i.amount_paid) : 0,
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

// PATCH /financial/annuities/dojos/:dojoId/:annuityId — edita o HEADER da
// anuidade (valor total, plano, período de referência e vencimentos das
// parcelas). Decisão do Caio, 23/07/2026: ao contrário da versão antiga
// desta rota (que só corrigia lançamento AINDA NÃO pago, 409 ALREADY_PAID),
// esta edição funciona INDEPENDENTE do status — inclusive com pagamento já
// lançado. É a metade "anuidade" do que o PR #431 fez para "pagamento"
// (editar/remover baixa) — reusa a MESMA primitiva de reconciliação
// (recomputeAnnuityFromLedger).
//
// Contrato do body (todos os campos opcionais; ao menos um obrigatório):
//   {
//     amount?: number,                         // novo TOTAL da anuidade
//                                               // (só a porção kind='anuidade'
//                                               // — a parcela de adesão,
//                                               // kind='filiacao', nunca
//                                               // entra nesta soma nem é
//                                               // tocada por esta rota)
//     plan?: 'anual'|'semestral'|'trimestral',
//     reference_period?: string,
//     installments?: [{ seq: number, due_date: 'YYYY-MM-DD', amount: number }],
//   }
//
// Precedência de reestruturação das parcelas kind='anuidade' (a parcela de
// ADESÃO, kind='filiacao', NUNCA é tocada por esta rota — sobrevive intacta
// a qualquer edição):
//   1) `installments` explícito — define a estrutura inteira (substitui
//      plan/amount para fins de estrutura). Se `amount` também vier, tem
//      que bater com a soma das parcelas (tolerância de 1 centavo), senão
//      422 VALIDATION_ERROR — evita o front mandar dois valores
//      contraditórios sem perceber.
//   2) `plan` (sem installments) — busca a fee vigente do novo plano
//      (karate_annual_fees) e monta as parcelas nos meses de vencimento do
//      plano (mesmo motor de PATCH /annuities/:annuityId/plan e de
//      buildInstallmentPlan). Usa `amount` como o novo TOTAL, distribuído
//      igualmente pelas parcelas do plano, se informado — senão usa o
//      valor cheio da fee (fee.amount por parcela, mesmo padrão do resto
//      do serviço).
//   3) só `amount` (sem plan/installments) — mantém os MESMOS vencimentos/
//      nº de parcelas 'anuidade' atuais, só redistribui o novo total entre
//      elas (distributeAmountAcrossInstallments).
//   4) nem installments, nem plan, nem amount — não mexe em parcela
//      nenhuma (só reference_period, se informado).
//
// Preservação de pagamento (NUNCA perde dinheiro já recebido nem órfãos de
// ledger — CLAUDE.md "idempotência"): as parcelas 'anuidade' NOVAS são
// casadas com as ATUAIS por `seq`. Quando o seq sobrevive na estrutura
// nova, o ID da parcela é mantido — UPDATE in place (amount/due_date),
// NUNCA DELETE+INSERT — porque karate_annuity_payments.installment_id tem
// ON DELETE CASCADE em karate_annuity_installments: apagar a parcela
// apagaria o ledger dela junto. Quando uma parcela antiga NÃO sobrevive
// (ex.: trimestral 4x → anual 1x), o ledger dela é REALOCADO (UPDATE
// installment_id) para a parcela-âncora (menor seq da estrutura nova)
// ANTES do DELETE — o recomputeAnnuityFromLedger chamado no fim ignora
// para qual parcela cada linha do ledger apontava antes (ele reconstrói a
// distribuição do zero, em ordem cronológica, sobre a estrutura viva no
// momento da chamada) — a realocação só existe para a linha sobreviver à
// query de replay (que faz JOIN com a parcela) sem cair no CASCADE.
//
// 422 AMOUNT_BELOW_PAID: o novo total (só da porção kind='anuidade') não
// pode ficar abaixo do que JÁ foi efetivamente recebido nela — isso exigiria
// carteira de crédito (saldo credor reutilizável), que está fora de escopo
// nesta fase (mesma regra do motor F1/F3 — ver
// karateAnnuityLedger.computeDistribution/AMOUNT_EXCEEDS_BALANCE, a mesma
// restrição espelhada aqui na ponta de edição do valor devido).
//
// Transação atômica: header + parcelas + ledger + recompute, tudo dentro
// do MESMO BEGIN/COMMIT (o recompute já faz o próprio SELECT ... FOR
// UPDATE nas parcelas — reentrante dentro da mesma transação, não há lock
// duplicado/deadlock).
router.patch('/annuities/dojos/:dojoId/:annuityId', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId, annuityId } = req.params;
  const body = req.body || {};

  const hasAmount = body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== '';
  const hasPlan = body.plan !== undefined && body.plan !== null && String(body.plan).trim() !== '';
  const hasPeriod = body.reference_period !== undefined && body.reference_period !== null && String(body.reference_period).trim() !== '';
  const hasInstallments = Array.isArray(body.installments);

  if (!hasAmount && !hasPlan && !hasPeriod && !hasInstallments) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar (amount, plan, reference_period ou installments)' });
  }

  if (hasPlan && !annuitySvc.VALID_PLANS.includes(body.plan)) {
    return res.status(422).json({
      error: `plan inválido. Valores aceitos: ${annuitySvc.VALID_PLANS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  let bodyAmount = null;
  if (hasAmount) {
    bodyAmount = round2(Number(body.amount));
    if (!Number.isFinite(bodyAmount) || bodyAmount <= 0) {
      return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
    }
  }

  if (hasInstallments && !body.installments.length) {
    return res.status(422).json({ error: 'installments não pode ser vazio', code: 'VALIDATION_ERROR' });
  }

  const newPeriod = hasPeriod ? String(body.reference_period).trim() : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const histRes = await client.query(
      `SELECT id, dojo_id, federation_id, reference_period, plan, amount, due_date, status
       FROM karate_dojo_annuity_history
       WHERE id = $1 AND dojo_id = $2 AND federation_id = $3
       FOR UPDATE`,
      [annuityId, dojoId, federationId]
    );
    if (!histRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lançamento não encontrado', code: 'NOT_FOUND' });
    }
    const hist = histRes.rows[0];

    // Evita colidir com outra cobrança do mesmo período no dojô (mesma
    // checagem da rota antiga).
    if (hasPeriod) {
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
    }

    const instRes = await client.query(
      `SELECT * FROM karate_annuity_installments WHERE annuity_id = $1 AND federation_id = $2 ORDER BY seq ASC FOR UPDATE`,
      [annuityId, federationId]
    );
    const allInstallments = instRes.rows;
    // kind='filiacao' (parcela de adesão) NUNCA entra na reestruturação
    // desta rota — só a porção 'anuidade' é editável aqui.
    const anuidadeInstallments = allInstallments.filter((i) => i.kind !== 'filiacao');
    const paidTotal = round2(anuidadeInstallments.reduce((s, i) => s + Number(i.amount_paid || 0), 0));

    const seasonYear = parseInt(newPeriod || hist.reference_period, 10) || new Date().getFullYear();

    // ── Monta a nova estrutura de parcelas 'anuidade' (null = não reestrutura) ──
    let newSpecs = null;
    if (hasInstallments) {
      const seen = new Set();
      newSpecs = [];
      for (const item of body.installments) {
        const seq = Number(item && item.seq);
        const amt = Number(item && item.amount);
        if (!Number.isInteger(seq) || seq <= 0) {
          await client.query('ROLLBACK');
          return res.status(422).json({ error: `seq inválido em installments: ${item && item.seq}`, code: 'VALIDATION_ERROR' });
        }
        if (seen.has(seq)) {
          await client.query('ROLLBACK');
          return res.status(422).json({ error: `seq duplicado em installments: ${seq}`, code: 'VALIDATION_ERROR' });
        }
        seen.add(seq);
        if (!Number.isFinite(amt) || amt <= 0) {
          await client.query('ROLLBACK');
          return res.status(422).json({ error: `amount inválido na parcela seq=${seq}`, code: 'VALIDATION_ERROR' });
        }
        const dueCheck = annuitySvc.validateDueDateOverride(item && item.due_date, seasonYear);
        if (!dueCheck.valid || !dueCheck.value) {
          await client.query('ROLLBACK');
          return res.status(422).json({
            error: `due_date inválido na parcela seq=${seq}: ${dueCheck.error || 'obrigatório'}`,
            code: 'VALIDATION_ERROR',
          });
        }
        newSpecs.push({ seq, amount: round2(amt), due_date: dueCheck.value });
      }
      newSpecs.sort((a, b) => a.seq - b.seq);
      const explicitTotal = round2(newSpecs.reduce((s, x) => s + x.amount, 0));
      if (hasAmount && Math.abs(explicitTotal - bodyAmount) > 0.01) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: `amount (R$ ${bodyAmount.toFixed(2)}) não bate com a soma das installments (R$ ${explicitTotal.toFixed(2)})`,
          code: 'VALIDATION_ERROR',
        });
      }
    } else if (hasPlan) {
      const fee = await annuitySvc.getVigentFee(client, federationId, 'dojo', body.plan);
      if (!fee) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: `Nenhuma fee configurada para o plano '${body.plan}' (karate_annual_fees).`,
          code: 'VALIDATION_ERROR',
        });
      }
      const planSpecs = annuitySvc.buildInstallmentPlan({
        plan: body.plan, amount: fee.amount, dueMonths: fee.due_months, seasonYear,
      });
      if (!planSpecs.length) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: `Plano '${body.plan}' sem meses de vencimento configurados.`, code: 'VALIDATION_ERROR' });
      }
      if (hasAmount) {
        const amounts = annuitySvc.distributeAmountAcrossInstallments(bodyAmount, planSpecs.length);
        newSpecs = planSpecs.map((s, idx) => ({ seq: s.seq, amount: amounts[idx], due_date: s.due_date }));
      } else {
        newSpecs = planSpecs.map((s) => ({ seq: s.seq, amount: round2(s.amount), due_date: s.due_date }));
      }
    } else if (hasAmount) {
      if (!anuidadeInstallments.length) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: 'Anuidade sem parcelas de anuidade para redistribuir o novo valor — informe plan ou installments.',
          code: 'VALIDATION_ERROR',
        });
      }
      const amounts = annuitySvc.distributeAmountAcrossInstallments(bodyAmount, anuidadeInstallments.length);
      newSpecs = anuidadeInstallments.map((inst, idx) => ({
        seq: inst.seq,
        amount: amounts[idx],
        due_date: toIsoDate(inst.due_date),
      }));
    }

    if (newSpecs) {
      const newTotal = round2(newSpecs.reduce((s, x) => s + x.amount, 0));
      if (newTotal < paidTotal - 0.005) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: `Novo valor total (R$ ${newTotal.toFixed(2)}) é menor do que o já recebido nesta anuidade (R$ ${paidTotal.toFixed(2)}). Renegociação com crédito está fora de escopo nesta fase — ajuste o valor para, no mínimo, o valor já pago.`,
          code: 'AMOUNT_BELOW_PAID',
          details: { new_total: newTotal, paid_total: paidTotal },
        });
      }

      // ── Casa por seq: mantém o ID de toda parcela que sobrevive (nunca
      // DELETE+INSERT em cima de parcela com ledger — ver comentário de
      // topo da rota sobre ON DELETE CASCADE).
      const existingBySeq = new Map(anuidadeInstallments.map((i) => [Number(i.seq), i]));
      const newSeqSet = new Set(newSpecs.map((s) => s.seq));
      const newSeqToId = new Map();
      const insertedWithoutTx = [];

      for (const spec of newSpecs) {
        const existing = existingBySeq.get(spec.seq);
        if (existing) {
          await client.query(
            `UPDATE karate_annuity_installments SET amount = $1, due_date = $2, updated_at = NOW() WHERE id = $3`,
            [spec.amount, spec.due_date, existing.id]
          );
          newSeqToId.set(spec.seq, existing.id);
          if (existing.transaction_id) {
            await client.query(
              `UPDATE transactions SET amount = $1, due_date = $2, updated_at = NOW() WHERE id = $3 AND status <> 'cancelled'`,
              [spec.amount, spec.due_date, existing.transaction_id]
            );
          }
        } else {
          const ins = await client.query(
            `INSERT INTO karate_annuity_installments
               (annuity_id, federation_id, seq, amount, due_date, status, kind)
             VALUES ($1,$2,$3,$4,$5,'pending','anuidade')
             RETURNING id`,
            [annuityId, federationId, spec.seq, spec.amount, spec.due_date]
          );
          const newId = ins.rows[0].id;
          newSeqToId.set(spec.seq, newId);
          insertedWithoutTx.push({ id: newId, annuity_id: annuityId, seq: spec.seq, amount: spec.amount, due_date: spec.due_date, kind: 'anuidade' });
        }
      }

      // Transaction financeira para as parcelas NOVAS (que ainda não tinham).
      if (insertedWithoutTx.length) {
        const dojoRes = await client.query(`SELECT COALESCE(trade_name, legal_name) AS name FROM companies WHERE id = $1 LIMIT 1`, [dojoId]);
        const dojoName = dojoRes.rows[0]?.name || 'Dojô';
        await annuitySvc.createTransactionsForInstallments(client, {
          federationId, kind: 'dojo', refId: dojoId, refName: dojoName,
          referencePeriod: newPeriod || hist.reference_period, installments: insertedWithoutTx,
        });
      }

      // Parcelas antigas que não sobreviveram à estrutura nova: realoca o
      // ledger delas para a parcela-âncora (menor seq da estrutura nova)
      // ANTES de apagar — preserva o dinheiro (o recompute redistribui via
      // FIFO logo abaixo). Cancela a transaction (preserva a trilha, nunca
      // apaga) e qualquer PIX intent pendente da parcela removida.
      const surplus = anuidadeInstallments.filter((i) => !newSeqSet.has(Number(i.seq)));
      if (surplus.length) {
        const anchorSeq = Math.min(...newSpecs.map((s) => s.seq));
        const anchorId = newSeqToId.get(anchorSeq);
        for (const old of surplus) {
          await client.query(
            `UPDATE karate_annuity_payments SET installment_id = $1 WHERE installment_id = $2`,
            [anchorId, old.id]
          );
          if (old.transaction_id) {
            await client.query(
              `UPDATE transactions SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status <> 'cancelled'`,
              [old.transaction_id]
            );
          }
          await client.query(
            `UPDATE karate_payment_intents SET status = 'cancelled', updated_at = NOW() WHERE status = 'pending' AND source_id = $1`,
            [old.id]
          );
          await client.query(`DELETE FROM karate_annuity_installments WHERE id = $1`, [old.id]);
        }
      }
    }

    // ── Header: reference_period/plan são colunas que o rollup
    // (syncAnnuityHeaderRollup, chamado dentro de recomputeAnnuityFromLedger
    // logo abaixo) NÃO toca — atualizamos aqui, direto.
    if (hasPeriod || hasPlan) {
      const sets = []; const vals = []; let i = 1;
      if (hasPeriod) { sets.push(`reference_period = $${i}`); vals.push(newPeriod); i++; }
      if (hasPlan) { sets.push(`plan = $${i}`); vals.push(body.plan); i++; }
      sets.push('updated_at = NOW()');
      vals.push(annuityId);
      await client.query(`UPDATE karate_dojo_annuity_history SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    }

    // ── Reconcilia TUDO (parcelas/ledger/rollup do header) a partir do
    // ledger remanescente — mesma primitiva do PR #431 (editar/remover
    // baixa). Roda sempre (idempotente mesmo quando nenhuma parcela mudou
    // de estrutura — mantém uma única saída de escrita/consistência).
    const result = await recomputeAnnuityFromLedger(client, { federation_id: federationId, annuity_id: annuityId });

    await client.query('COMMIT');

    reconcileInstallmentTransactions(result.installments).catch((e) =>
      console.error('[karateAnnuities] reconcileInstallmentTransactions falhou (patch anuidade):', e.message)
    );

    financeAudit.logFinanceAudit({
      federationId, action: 'annuity_edit', targetType: 'annuity', targetId: annuityId,
      dojoId, actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: {
        amount: hist.amount != null ? parseFloat(hist.amount) : null,
        plan: hist.plan || null,
        reference_period: hist.reference_period,
        installments: anuidadeInstallments.map((i) => ({
          seq: i.seq, amount: parseFloat(i.amount), due_date: toIsoDate(i.due_date), amount_paid: parseFloat(i.amount_paid || 0),
        })),
      },
      after: {
        amount: result.header ? parseFloat(result.header.amount) : null,
        plan: result.header ? result.header.plan : null,
        reference_period: result.header ? result.header.reference_period : (newPeriod || hist.reference_period),
        installments: result.installments.filter((i) => i.kind !== 'filiacao').map((i) => ({
          seq: i.seq, amount: parseFloat(i.amount), due_date: toIsoDate(i.due_date), amount_paid: parseFloat(i.amount_paid || 0), status: i.status,
        })),
      },
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (patch anuidade):', e.message));

    const { total, paid_total } = annuitySvc.computeTotals(result.installments);
    res.json({
      annuity_id: annuityId,
      dojo_id: dojoId,
      reference_period: result.header ? result.header.reference_period : (newPeriod || hist.reference_period),
      plan: result.header ? result.header.plan || null : null,
      amount: result.header ? parseFloat(result.header.amount) : null,
      due_date: result.header ? toIsoDate(result.header.due_date) : null,
      status: result.header ? result.header.status : null,
      paid_at: result.header ? result.header.paid_at : null,
      installments: result.installments.map(mapInstallmentForResponse),
      total,
      paid_total,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof AnnuityPaymentError) {
      return res.status(err.status).json({ error: err.message, code: err.code, details: err.details || null });
    }
    console.error('[karateAnnuities] patch annuity error:', err.message);
    res.status(500).json({ error: 'Erro ao editar anuidade', detail: err.message });
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

    await financeAudit.logFinanceAudit({
      federationId, action: 'void', targetType: 'annuity', targetId: annuityId,
      dojoId, actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: { status: hist.status, amount: hist.amount != null ? parseFloat(hist.amount) : null, transaction_id: hist.transaction_id || null },
      after: null,
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (void dojo):', e.message));

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
//   payment_method?  — 'pix'|'dinheiro'|'transferencia'|'credito_cbkt'|'credito_exame'|'boleto'|'outro' (default: 'pix')
//   amount?          — valor recebido (default: amount da cobrança)
//
// Idempotente: se a anuidade já está 'paid', retorna 200 sem efeito colateral.
// Conciliação: sets karate_dojo_annuity_history.status='paid' + paid_at +
//   payment_method (via applyAnnuityPayment, F3); reconcilia
//   transactions.status='confirmed' + paid_at best-effort depois do commit.
// ────────────────────────────────────────────────────────────────
// CONSOLIDAÇÃO F3 (reforma da anuidade): esta rota parava de escrever
// direto em karate_dojo_annuity_history/transactions (a exata família de
// bug "segunda porta de baixa" que o CLAUDE.md pede pra evitar — write
// path divergindo do motor) e passa a delegar 100% da baixa para
// applyAnnuityPayment (karateAnnuityLedger.js). Mudanças de comportamento
// intencionais, documentadas no PR:
//   1) SEM override de amount, usava sempre h.amount (o TOTAL do header),
//      mesmo que parte já tivesse sido paga por outra via (ex.: /receive
//      parcial) — podia SOBRE-pagar em silêncio e ainda assim forçar
//      status='paid'. Agora usa o SALDO EM ABERTO real (soma de
//      amount-amount_paid das parcelas) e, com override, o motor RECUSA
//      excedente (AMOUNT_EXCEEDS_BALANCE, 422) em vez de aceitar qualquer
//      valor e declarar pago mesmo assim.
//   2) status da resposta agora reflete o header real pós-motor (só vira
//      'paid' quando TODAS as parcelas quitam) — antes era sempre 'paid'
//      hardcoded, mesmo com override menor que o saldo total.
//   3) Reconciliação de `transactions` (Financeiro/DRE) e cancelamento de
//      intents PIX pendentes viram passos best-effort DEPOIS do commit do
//      motor (mesmo padrão de financeAudit/NFS-e já usado neste arquivo).
// ────────────────────────────────────────────────────────────────
router.post('/annuities/dojos/:dojoId/:annuityId/pay', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId, annuityId } = req.params;
  const {
    paid_at,
    payment_method = 'pix',
    amount: overrideAmount,
  } = req.body || {};

  if (payment_method && !annuitySvc.VALID_PAYMENT_METHODS.includes(payment_method)) {
    return res.status(422).json({
      error: `payment_method inválido. Valores aceitos: ${annuitySvc.VALID_PAYMENT_METHODS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  try {
    // Busca e valida escopo (dojô pertence à federação)
    const histRes = await db.query(
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
      return res.status(404).json({ error: 'Cobrança não encontrada', code: 'NOT_FOUND' });
    }
    const hist = histRes.rows[0];

    // Idempotente: já está pago — retorna sem efeito colateral.
    if (hist.status === 'paid') {
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

    // Valor a aplicar: override explícito OU o saldo em aberto REAL das
    // parcelas (ver nota de consolidação acima).
    let effectiveAmount = overrideAmount !== undefined ? Number(overrideAmount) : null;
    if (effectiveAmount === null) {
      const balRes = await db.query(
        `SELECT COALESCE(SUM(amount - amount_paid), 0)::numeric AS balance
           FROM karate_annuity_installments
          WHERE annuity_id = $1 AND federation_id = $2`,
        [annuityId, federationId]
      );
      effectiveAmount = Number(balRes.rows[0].balance);
    }
    if (!Number.isFinite(effectiveAmount) || effectiveAmount <= 0) {
      return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
    }

    const result = await applyAnnuityPayment({
      federation_id: federationId,
      annuity_id: annuityId,
      amount: effectiveAmount,
      payment_method,
      paid_at: resolveReceivePaidAt(paid_at),
      created_by: financeAudit.actorFromReq(req).actorUserId,
    });

    await reconcileClosedInstallmentTransactions(result.allocations, result.paid_at);

    // Intents PIX pendentes não fazem mais sentido — best-effort.
    db.query(
      `UPDATE karate_payment_intents SET status = 'cancelled', updated_at = NOW()
        WHERE annuity_history_id = $1 AND status = 'pending'`,
      [annuityId]
    ).catch((e) => console.error('[karateAnnuities] cancelar intents pendentes falhou (pay dojo):', e.message));

    await financeAudit.logFinanceAudit({
      federationId, action: 'annuity_pay', targetType: 'annuity', targetId: annuityId,
      dojoId, actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: { status: hist.status, paid_at: hist.paid_at || null, amount: hist.amount != null ? parseFloat(hist.amount) : null },
      after: {
        status: result.header?.status || null, paid_at: result.paid_at, amount: result.amount,
        payment_method, transaction_id: result.header?.transaction_id || null,
      },
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (pay dojo):', e.message));

    res.json({
      annuity_id: annuityId,
      dojo_id: dojoId,
      dojo_name: hist.dojo_name,
      reference_period: hist.reference_period,
      amount: result.amount,
      paid_at: result.paid_at,
      payment_method,
      status: result.header?.status || 'paid',
      transaction_id: result.header?.transaction_id || null,
      idempotent_hit: false,
    });
  } catch (err) {
    respondAnnuityPaymentError(res, err, 'Erro ao registrar pagamento');
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
//   payment_method?  — 'pix'|'dinheiro'|'transferencia'|'credito_cbkt'|'credito_exame'|'boleto'|'outro' (default: 'pix')
//
// Idempotente: se já existe cobrança para o período retorna 409 com
//   { code:'CONFLICT', annuity_id } para que o caller possa redirecionar
//   para o endpoint /pay (com annuityId) se quiser baixar a existente.
// Conciliação: transaction criada já com status='confirmed' e paid_at.
// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// CONSOLIDAÇÃO F3: esta rota criava o header JÁ como 'paid' direto em
// karate_dojo_annuity_history, SEM NUNCA gerar uma linha em
// karate_annuity_installments (migration 222) nem em karate_annuity_payments
// (o ledger, migration 247) — anuidades lançadas por aqui ficavam
// invisíveis nas listagens/KPIs baseados em parcelas e sem NENHUM rastro
// no extrato. Agora: (1) cria o header 'pending' + 1 parcela, igual ao
// /charge; (2) a baixa em si passa pelo motor (applyAnnuityPayment) —
// mesmo "lança + baixa em um passo" da UI, mas as duas metades agora usam
// a MESMA maquinaria que /charge e /receive usam separadamente.
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
  if (payment_method && !annuitySvc.VALID_PAYMENT_METHODS.includes(payment_method)) {
    return res.status(422).json({
      error: `payment_method inválido. Valores aceitos: ${annuitySvc.VALID_PAYMENT_METHODS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  const period = String(reference_period).trim();
  const effectiveAmount = Number(amount);
  const resolvedPaidAt = resolveReceivePaidAt(paid_at) || new Date().toISOString();

  // due_date: usa o informado ou o mesmo dia do paid_at (sem hora)
  const effectiveDueDate = due_date || (paid_at || new Date().toISOString().slice(0, 10));

  // ── Fase 1: lança a cobrança (header + 1 parcela), MESMA transação ──
  const client = await db.connect();
  let annuityId, dojoName;
  try {
    await client.query('BEGIN');

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
    dojoName = dojoRes.rows[0].name;

    // Advisory lock para evitar duplicata concorrente
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text || '-annuity-' || $2::text))`,
      [dojoId, period]
    );

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

    const histRes = await client.query(
      `INSERT INTO karate_dojo_annuity_history
         (dojo_id, federation_id, reference_period, plan, amount, due_date, status, created_at)
       VALUES ($1, $2, $3, NULL, 0, $4, 'pending', NOW())
       RETURNING id`,
      [dojoId, federationId, period, effectiveDueDate]
    );
    annuityId = histRes.rows[0].id;

    let installments = await annuitySvc.createInstallmentsForAnnuity(client, {
      annuityId, federationId,
      specs: [{ seq: 1, amount: effectiveAmount, due_date: effectiveDueDate }],
    });
    installments = await annuitySvc.createTransactionsForInstallments(client, {
      federationId, kind: 'dojo', refId: dojoId, refName: dojoName,
      referencePeriod: period, installments,
    });
    await annuitySvc.syncAnnuityHeaderRollup(client, annuityId);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[karateAnnuities] direct pay (lançamento) error:', err.message);
    return res.status(500).json({ error: 'Erro ao lançar cobrança', detail: err.message });
  } finally {
    client.release();
  }

  // ── Fase 2: baixa — pelo motor (2ª transação; mesmo padrão de
  // /charge seguido de /receive, só que encadeados neste único request) ──
  try {
    const result = await applyAnnuityPayment({
      federation_id: federationId,
      annuity_id: annuityId,
      amount: effectiveAmount,
      payment_method,
      paid_at: resolvedPaidAt,
      created_by: financeAudit.actorFromReq(req).actorUserId,
    });

    await reconcileClosedInstallmentTransactions(result.allocations, result.paid_at);

    await financeAudit.logFinanceAudit({
      federationId, action: 'annuity_charge_and_pay', targetType: 'annuity', targetId: annuityId,
      dojoId, actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: null,
      after: {
        status: result.header?.status || null, amount: result.amount, due_date: effectiveDueDate,
        paid_at: result.paid_at, payment_method, transaction_id: result.header?.transaction_id || null,
        reference_period: period,
      },
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (lança+baixa dojo):', e.message));

    res.status(201).json({
      annuity_id: annuityId,
      dojo_id: dojoId,
      dojo_name: dojoName,
      reference_period: period,
      amount: result.amount,
      due_date: effectiveDueDate,
      paid_at: result.paid_at,
      payment_method,
      status: result.header?.status || 'paid',
      transaction_id: result.header?.transaction_id || null,
      idempotent_hit: false,
    });
  } catch (err) {
    // A cobrança JÁ foi lançada (commitada na fase 1) — se a baixa falhar
    // aqui (ex.: infra), a anuidade fica 'pending' com 1 parcela em
    // aberto, NÃO some: o 409 de "já existe cobrança pro período" acima
    // vira o guard natural contra duplicar o lançamento num retry, e o
    // operador pode completar a baixa depois via /receive.
    respondAnnuityPaymentError(res, err, 'Cobrança lançada, mas falhou ao aplicar a baixa — tente novamente via /receive');
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
      actorUserId: financeAudit.actorFromReq(req).actorUserId,
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
//
// member_status (mesmo padrão de dojo_status — ver seção DOJO ANNUITIES
// acima e parseMemberStatus/memberStatusToIsActiveValues em
// karateAnnuityService.js): agora espelha o dojô — default 'active' (só
// faixa-preta ATIVA entra, mesmo comportamento do BUGFIX P0 de
// 11/07/2026), com 'inactive'/'all' disponíveis pra listar/auditar
// praticante inativo sem que ele suma do sistema. `cb.belt_level = 'preta'`
// continua FIXO em todos os valores — este parâmetro só afrouxa o
// is_active, nunca a trava de faixa-preta (praticante que perdeu a faixa
// preta nunca aparece aqui, independente de member_status). Mesmo
// predicado espelhado no summary (karateAnnuitySummary.js) pra lista×KPI
// nunca divergirem.
//
// Proteção P0 separada (não é sobre listar, é sobre AGIR): rotas de
// mutação CPF (charge, pay de parcela) revalidam customers.is_active
// SERVER-SIDE mesmo com member_status=all/inactive na listagem — ver
// comentário 'MEMBER_INACTIVE' nessas rotas. Ver/listar inativo é ok;
// lançar cobrança ou dar baixa nele não.
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
//
// BUGFIX P0 (QA anuidades 11/07/2026): esta listagem devolvia TODOS os
// customers da federação (9.625 registros), sem nenhum filtro de
// elegibilidade — universo correto é só faixa-preta ATIVA (549), a MESMA
// regra que karate_member_standing e GET /financial/annuities/summary já
// aplicam (karateAnnuitySummary.js: `COALESCE(cu.is_active, true) AND
// cb.belt_level = 'preta'`, join com a view karate_current_belt). Sem esse
// filtro, praticante INATIVO ou não-preta aparecia na lista e podia
// receber baixa de pagamento manual — já causou marcação acidental de
// anuidades reais como pagas em produção (3 praticantes, 2 deles
// inativos). Conferido em prod via SELECT antes do fix: 549 elegíveis,
// 1 sem cobrança, 519 atrasado, R$ 31.105,00 em aberto — bate com os
// KPIs do summary. Ausência de cobrança (no_charge) continua NEUTRA (não
// é inadimplência) — este filtro só define quem ENTRA na lista, não
// reclassifica status.
function cpfBaseSql(withPlan, memberStatusParamIndex) {
  return `
    SELECT
      cu.id AS practitioner_id, cu.name AS full_name,
      cu.karate_registration_number, cu.phone AS whatsapp,
      NULLIF(cu.email, '') AS email,
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
    LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id
    LEFT JOIN karate_dojo_annuity_history h
      ON h.practitioner_id = cu.id AND h.reference_period = $2
    WHERE cu.federation_id = $1
      AND ($${memberStatusParamIndex}::boolean[] IS NULL OR COALESCE(cu.is_active, true) = ANY($${memberStatusParamIndex}::boolean[]))
      AND cb.belt_level = 'preta'
  `;
}

// Fallback legado (migration 222 ausente): computed_status direto sobre
// transactions (category='annuity_cpf'). Mesma regra canônica de "vencida"
// (due_date <= hoje) do restante da Fase F2 — CLAUDE.md #vencida.
// Mesmo fix de elegibilidade do cpfBaseSql acima (bug P0 11/07/2026): só
// faixa-preta ATIVA entra na listagem, mesmo no fallback legado.
function cpfLegacyBaseSql(memberStatusParamIndex) {
  return `
  SELECT
    cu.id AS practitioner_id, cu.name AS full_name,
    cu.karate_registration_number, cu.phone AS whatsapp,
    NULLIF(cu.email, '') AS email,
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
  LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id
  LEFT JOIN transactions t
    ON t.reference_type = 'customer' AND t.reference_id = cu.id
    AND t.category = 'annuity_cpf' AND EXTRACT(YEAR FROM t.due_date) = $2::int
    AND t.federation_id = $1
  WHERE cu.federation_id = $1
    AND ($${memberStatusParamIndex}::boolean[] IS NULL OR COALESCE(cu.is_active, true) = ANY($${memberStatusParamIndex}::boolean[]))
    AND cb.belt_level = 'preta'
`;
}

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
  // member_status: espelha dojo_status (companies.is_active), mas sobre
  // customers.is_active — ver comentário no topo da seção CPF ANNUITIES.
  // Default 'active' (só faixa-preta ATIVA, mesmo universo do BUGFIX P0).
  // Inválido -> 400 (não 422, por pedido explícito do escopo desta rota).
  const memberStatus = annuitySvc.parseMemberStatus(req.query.member_status);
  if (memberStatus === null) {
    return res.status(400).json({
      error: `member_status inválido. Valores aceitos: ${annuitySvc.MEMBER_STATUS_VALUES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  const memberStatusValues = annuitySvc.memberStatusToIsActiveValues(memberStatus);

  try {
    let rows;
    let total = 0;
    let selectedPlan = HAS_INSTALLMENTS;
    if (selectedPlan) {
      try {
        // ⚠️ Numeração posicional (CLAUDE.md #testes-jest-posicionais): NÃO
        // renumerar $1..$6 — o teste legado (__tests__/karate.
        // annuityF2Pagination.test.js) checa countParams[2]=search e
        // dataParams[5]=offset por índice. memberStatusValues vai SEMPRE no
        // FIM do array — vira $5 no COUNT (só 4 params antes) e $7 no
        // SELECT (6 params antes). O número do placeholder ($N) não
        // precisa bater com a ORDEM dos params no SQL escrito — cpfBaseSql
        // recebe o índice explícito e referencia $5/$7 onde for chamado.
        const countRes = await db.query(
          `SELECT COUNT(*)::int AS total FROM (${cpfBaseSql(true, 5)}) base ${CPF_FILTER_SQL}`,
          [federationId, year, search, statusValues, memberStatusValues]
        );
        total = countRes.rows[0]?.total || 0;
        const r = await db.query(
          `SELECT * FROM (${cpfBaseSql(true, 7)}) base ${CPF_FILTER_SQL}
           ORDER BY karate_registration_number ASC NULLS LAST, full_name ASC
           LIMIT $5 OFFSET $6`,
          [federationId, year, search, statusValues, pageSize, offset, memberStatusValues]
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
          `SELECT id, annuity_id, seq, amount, amount_paid, due_date, paid_at, status, transaction_id
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
          email: r.email || null,
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
            id: i.id, seq: i.seq, amount: parseFloat(i.amount),
            amount_paid: i.amount_paid != null ? parseFloat(i.amount_paid) : 0,
            due_date: i.due_date,
            paid_at: i.paid_at, status: i.status, transaction_id: i.transaction_id,
          })),
          paid_total,
          total: instTotal || (r.amount ? parseFloat(r.amount) : 0),
        };
      });
    } else {
      // Fallback legado (migration 222 ausente): transactions diretamente.
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS total FROM (${cpfLegacyBaseSql(5)}) base ${CPF_FILTER_SQL}`,
        [federationId, year, search, statusValues, memberStatusValues]
      );
      total = countRes.rows[0]?.total || 0;
      const r = await db.query(
        `SELECT * FROM (${cpfLegacyBaseSql(7)}) base ${CPF_FILTER_SQL}
         ORDER BY karate_registration_number ASC NULLS LAST, full_name ASC
         LIMIT $5 OFFSET $6`,
        [federationId, year, search, statusValues, pageSize, offset, memberStatusValues]
      );
      data = r.rows.map(row => ({
        practitioner_id: row.practitioner_id,
        full_name: row.full_name,
        karate_registration_number: row.karate_registration_number || null,
        whatsapp: row.whatsapp || null,
        email: row.email || null,
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
      `SELECT id, name AS full_name, cpf_cnpj, is_active
       FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [practitionerId, federationId]
    );
    if (!practRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }
    const pract = practRes.rows[0];

    // Proteção P0 (revalidação server-side, não confia no filtro da
    // listagem): praticante inativo não pode receber NOVA cobrança —
    // ver/listar inativo (member_status=all/inactive) continua ok, mas
    // lançar cobrança nele não. COALESCE porque is_active pode vir NULL
    // em linhas legadas (mesmo critério de COALESCE(cu.is_active, true)
    // usado no resto do arquivo).
    if (pract.is_active === false) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Praticante inativo — não é possível lançar cobrança',
        code: 'MEMBER_INACTIVE',
      });
    }

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

        await financeAudit.logFinanceAudit({
          federationId, action: 'charge_create', targetType: 'annuity', targetId: annuityId,
          practitionerId, actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
          before: null,
          after: { plan, amount: parseFloat(header.amount), due_date: header.due_date, reference_period, installments_count: installments.length },
        }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (charge cpf):', e.message));

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

// PATCH /financial/annuities/cpf/:practitionerId/:annuityId — edita o
// HEADER da anuidade de PRATICANTE. Metade "CPF" do PATCH
// .../annuities/dojos/:dojoId/:annuityId acima — MESMA primitiva de
// reconciliação (recomputeAnnuityFromLedger, karateAnnuityLedger.js),
// funciona INDEPENDENTE do status (inclusive já paga).
//
// Praticante só tem o plano 'anual' (parcela ÚNICA, N=1 — ver VALID_PLANS
// e a checagem em PATCH /annuities/:annuityId/plan, que já recusa troca de
// plano pra praticante). Por isso este PATCH é mais enxuto que o de dojô:
// não aceita `plan` nem `installments[]` (não há o que reestruturar com
// N=1) nem tem o conceito de parcela kind='filiacao' (adesão é só de
// dojô — buildAdhesionSpec amarra em h.dojo_id). Só edita:
//   { amount?: number, reference_period?: string, due_date?: 'YYYY-MM-DD' }
// (ao menos um obrigatório). `due_date` edita o vencimento da parcela
// única; `amount` o valor dela (sem redistribuição, já que N=1).
//
// 422 AMOUNT_BELOW_PAID: mesma regra do dojô — novo valor não pode ficar
// abaixo do que já foi recebido (sem carteira de crédito nesta fase).
// 409 CONFLICT: já existe outra cobrança do praticante no novo período
// (mesma checagem de duplicidade da rota de dojô, ~linha 953, espelhada
// aqui por practitioner_id).
// 404: anuidade não encontrada, ou não pertence a este practitionerId/
// federationId (WHERE id=$1 AND practitioner_id=$2 AND federation_id=$3 —
// nunca vaza dado de outro praticante/federação).
router.patch('/annuities/cpf/:practitionerId/:annuityId', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, practitionerId, annuityId } = req.params;
  const body = req.body || {};

  const hasAmount = body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== '';
  const hasPeriod = body.reference_period !== undefined && body.reference_period !== null && String(body.reference_period).trim() !== '';
  const hasDueDate = body.due_date !== undefined && body.due_date !== null && String(body.due_date).trim() !== '';

  if (!hasAmount && !hasPeriod && !hasDueDate) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar (amount, reference_period ou due_date)' });
  }

  let bodyAmount = null;
  if (hasAmount) {
    bodyAmount = round2(Number(body.amount));
    if (!Number.isFinite(bodyAmount) || bodyAmount <= 0) {
      return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
    }
  }

  const newPeriod = hasPeriod ? String(body.reference_period).trim() : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const histRes = await client.query(
      `SELECT id, practitioner_id, federation_id, reference_period, plan, amount, due_date, status
       FROM karate_dojo_annuity_history
       WHERE id = $1 AND practitioner_id = $2 AND federation_id = $3
       FOR UPDATE`,
      [annuityId, practitionerId, federationId]
    );
    if (!histRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lançamento não encontrado', code: 'NOT_FOUND' });
    }
    const hist = histRes.rows[0];

    // Evita colidir com outra cobrança do mesmo período no praticante
    // (mesma checagem da rota de dojô, ~linha 953).
    if (hasPeriod) {
      const dup = await client.query(
        `SELECT id FROM karate_dojo_annuity_history
         WHERE practitioner_id = $1 AND reference_period = $2 AND id <> $3 LIMIT 1`,
        [practitionerId, newPeriod, annuityId]
      );
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Já existe outra cobrança para este praticante no período ' + newPeriod,
          code: 'CONFLICT',
        });
      }
    }

    const instRes = await client.query(
      `SELECT * FROM karate_annuity_installments WHERE annuity_id = $1 AND federation_id = $2 ORDER BY seq ASC FOR UPDATE`,
      [annuityId, federationId]
    );
    const installments = instRes.rows; // praticante: plan='anual' -> sempre 1 parcela, sem kind='filiacao'
    const paidTotal = round2(installments.reduce((s, i) => s + Number(i.amount_paid || 0), 0));

    const seasonYear = parseInt(newPeriod || hist.reference_period, 10) || new Date().getFullYear();

    // ── Monta a nova parcela única (null = não mexe em amount/due_date) ──
    let newSpec = null;
    if (hasAmount || hasDueDate) {
      if (!installments.length) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: 'Anuidade sem parcela para editar — situação inesperada para praticante (plan sempre anual/N=1).',
          code: 'VALIDATION_ERROR',
        });
      }
      const inst = installments[0];
      let dueDateValue = toIsoDate(inst.due_date);
      if (hasDueDate) {
        const dueCheck = annuitySvc.validateDueDateOverride(body.due_date, seasonYear);
        if (!dueCheck.valid || !dueCheck.value) {
          await client.query('ROLLBACK');
          return res.status(422).json({
            error: `due_date inválido: ${dueCheck.error || 'obrigatório'}`,
            code: 'VALIDATION_ERROR',
          });
        }
        dueDateValue = dueCheck.value;
      }
      const amountValue = hasAmount ? bodyAmount : round2(Number(inst.amount));
      newSpec = { installmentId: inst.id, transactionId: inst.transaction_id, amount: amountValue, due_date: dueDateValue };
    }

    if (newSpec) {
      if (newSpec.amount < paidTotal - 0.005) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: `Novo valor total (R$ ${newSpec.amount.toFixed(2)}) é menor do que o já recebido nesta anuidade (R$ ${paidTotal.toFixed(2)}). Renegociação com crédito está fora de escopo nesta fase — ajuste o valor para, no mínimo, o valor já pago.`,
          code: 'AMOUNT_BELOW_PAID',
          details: { new_total: newSpec.amount, paid_total: paidTotal },
        });
      }
      await client.query(
        `UPDATE karate_annuity_installments SET amount = $1, due_date = $2, updated_at = NOW() WHERE id = $3`,
        [newSpec.amount, newSpec.due_date, newSpec.installmentId]
      );
      if (newSpec.transactionId) {
        await client.query(
          `UPDATE transactions SET amount = $1, due_date = $2, updated_at = NOW() WHERE id = $3 AND status <> 'cancelled'`,
          [newSpec.amount, newSpec.due_date, newSpec.transactionId]
        );
      }
    }

    // ── Header: reference_period é coluna que o rollup (syncAnnuityHeaderRollup,
    // chamado dentro de recomputeAnnuityFromLedger logo abaixo) NÃO toca.
    if (hasPeriod) {
      await client.query(
        `UPDATE karate_dojo_annuity_history SET reference_period = $1, updated_at = NOW() WHERE id = $2`,
        [newPeriod, annuityId]
      );
    }

    // ── Reconcilia TUDO (parcela/ledger/rollup do header) a partir do
    // ledger remanescente — mesma primitiva do PATCH de dojô/PR #431.
    const result = await recomputeAnnuityFromLedger(client, { federation_id: federationId, annuity_id: annuityId });

    await client.query('COMMIT');

    reconcileInstallmentTransactions(result.installments).catch((e) =>
      console.error('[karateAnnuities] reconcileInstallmentTransactions falhou (patch anuidade cpf):', e.message)
    );

    financeAudit.logFinanceAudit({
      federationId, action: 'annuity_edit', targetType: 'annuity', targetId: annuityId,
      practitionerId, actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: {
        amount: hist.amount != null ? parseFloat(hist.amount) : null,
        plan: hist.plan || null,
        reference_period: hist.reference_period,
        installments: installments.map((i) => ({
          seq: i.seq, amount: parseFloat(i.amount), due_date: toIsoDate(i.due_date), amount_paid: parseFloat(i.amount_paid || 0),
        })),
      },
      after: {
        amount: result.header ? parseFloat(result.header.amount) : null,
        plan: result.header ? result.header.plan : null,
        reference_period: result.header ? result.header.reference_period : (newPeriod || hist.reference_period),
        installments: result.installments.map((i) => ({
          seq: i.seq, amount: parseFloat(i.amount), due_date: toIsoDate(i.due_date), amount_paid: parseFloat(i.amount_paid || 0), status: i.status,
        })),
      },
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (patch anuidade cpf):', e.message));

    const { total, paid_total } = annuitySvc.computeTotals(result.installments);
    res.json({
      annuity_id: annuityId,
      practitioner_id: practitionerId,
      reference_period: result.header ? result.header.reference_period : (newPeriod || hist.reference_period),
      plan: result.header ? result.header.plan || null : null,
      amount: result.header ? parseFloat(result.header.amount) : null,
      due_date: result.header ? toIsoDate(result.header.due_date) : null,
      status: result.header ? result.header.status : null,
      paid_at: result.header ? result.header.paid_at : null,
      installments: result.installments.map(mapInstallmentForResponse),
      total,
      paid_total,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof AnnuityPaymentError) {
      return res.status(err.status).json({ error: err.message, code: err.code, details: err.details || null });
    }
    console.error('[karateAnnuities] patch annuity cpf error:', err.message);
    res.status(500).json({ error: 'Erro ao editar anuidade', detail: err.message });
  } finally {
    client.release();
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
    `SELECT id, dojo_id, practitioner_id, federation_id, reference_period, plan, status, amount, transaction_id
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
    status: hist.status,
    amount: hist.amount != null ? parseFloat(hist.amount) : null,
    plan: hist.plan,
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

    await financeAudit.logFinanceAudit({
      federationId, action: 'void', targetType: 'annuity', targetId: annuityId,
      dojoId: result.dojo_id || null, practitionerId: result.practitioner_id || null,
      actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: { status: result.status, amount: result.amount, plan: result.plan },
      after: null,
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (void generico):', e.message));

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

    await financeAudit.logFinanceAudit({
      federationId, action: 'plan_change', targetType: 'annuity', targetId: annuityId,
      dojoId: hist.dojo_id, actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: { plan: hist.plan },
      after: { plan, amount: parseFloat(header.amount), due_date: header.due_date },
    }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (troca de plano):', e.message));

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

// ============================================================
// Fase F3 da reforma da anuidade — BAIXA LIVRE CANÔNICA sobre o motor F1
// (applyAnnuityPayment / karateAnnuityLedger.js). Consolida em UMA porta
// de escrita o que antes eram baixas escrevendo direto em installments —
// ver notas de consolidação nas rotas antigas mais abaixo neste arquivo.
//
//   POST /financial/annuities/:annuityId/receive/preview — dry-run (NÃO
//     grava nada, mesmo shape do commit — a F4 usa isto pra prévia ao
//     vivo). Registrada ANTES de qualquer rota paramétrica que possa
//     capturar "preview" (armadilha CLAUDE.md: rota estática antes de
//     paramétrica, 3 ocorrências já — aqui não há colisão real de
//     segmentos com as rotas /annuities/dojos|cpf|installments/... porque
//     os últimos segmentos literais nunca coincidem, mas a ordem de
//     registro é mantida de propósito, defensivamente, pelo mesmo motivo).
//   POST /financial/annuities/:annuityId/receive — commit real. Aceita
//     operation_id opcional (dedup de retry HTTP — migration 249; ver
//     karateAnnuityLedger.js). Erros do motor (AnnuityPaymentError) viram
//     a resposta HTTP 1:1 (AMOUNT_EXCEEDS_BALANCE/OPERATION_ID_CONFLICT/
//     OPERATION_IN_PROGRESS → 422/409, ANNUITY_NOT_FOUND → 404).
//   GET  /financial/annuities/:annuityId/payments — extrato (ledger
//     karate_annuity_payments daquela anuidade), mais recente primeiro.
//
// Guard: adminOnly() — mesmo padrão de TODAS as outras rotas de baixa
// deste arquivo (RBAC §7.3, financeiro é sensível).
// ============================================================

// paid_at aceito como 'YYYY-MM-DD' (convertido pra meio-dia horário de
// Brasília, MESMO padrão das rotas de baixa legadas deste arquivo — evita
// a armadilha CLAUDE.md #1 de "dia trocado" que dar new Date('YYYY-MM-DD')
// direto causaria, já que meia-noite UTC = 21h do dia anterior em BRT) ou
// como ISO completo (passa direto — o motor valida). Ausente -> undefined,
// o motor usa "agora".
function resolveReceivePaidAt(paid_at) {
  if (paid_at === undefined || paid_at === null || String(paid_at).trim() === '') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(paid_at))) {
    return `${paid_at}T12:00:00-03:00`;
  }
  return paid_at;
}

function respondAnnuityPaymentError(res, err, fallbackMsg) {
  if (err instanceof AnnuityPaymentError) {
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details || null });
  }
  console.error('[karateAnnuities]', fallbackMsg, err.message);
  return res.status(500).json({ error: fallbackMsg, detail: err.message });
}

// POST /financial/annuities/:annuityId/receive/preview — dry-run (NÃO grava).
router.post('/annuities/:annuityId/receive/preview', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, annuityId } = req.params;
  const { amount, payment_method = null, paid_at } = req.body || {};

  if (payment_method && !annuitySvc.VALID_PAYMENT_METHODS.includes(payment_method)) {
    return res.status(422).json({
      error: `payment_method inválido. Valores aceitos: ${annuitySvc.VALID_PAYMENT_METHODS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  try {
    const result = await applyAnnuityPayment({
      federation_id: federationId,
      annuity_id: annuityId,
      amount,
      payment_method,
      paid_at: resolveReceivePaidAt(paid_at),
      dryRun: true,
    });
    res.json(result);
  } catch (err) {
    respondAnnuityPaymentError(res, err, 'Erro ao simular baixa da anuidade');
  }
});

// POST /financial/annuities/:annuityId/receive — baixa livre (commit real).
// Body: { amount, payment_method, paid_at?, operation_id? }.
router.post('/annuities/:annuityId/receive', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, annuityId } = req.params;
  const { amount, payment_method = null, paid_at, operation_id } = req.body || {};

  if (payment_method && !annuitySvc.VALID_PAYMENT_METHODS.includes(payment_method)) {
    return res.status(422).json({
      error: `payment_method inválido. Valores aceitos: ${annuitySvc.VALID_PAYMENT_METHODS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  try {
    const result = await applyAnnuityPayment({
      federation_id: federationId,
      annuity_id: annuityId,
      amount,
      payment_method,
      paid_at: resolveReceivePaidAt(paid_at),
      created_by: financeAudit.actorFromReq(req).actorUserId,
      operation_id,
      dryRun: false,
    });

    // idempotent_hit:true = retry — a baixa já foi auditada e reconciliada
    // na 1ª chamada, não duplica nenhum dos dois.
    if (!result.idempotent_hit) {
      await reconcileClosedInstallmentTransactions(result.allocations, result.paid_at);

      financeAudit.logFinanceAudit({
        federationId,
        action: 'annuity_receive',
        targetType: 'annuity',
        targetId: annuityId,
        dojoId: result.header?.dojo_id || null,
        practitionerId: result.header?.practitioner_id || null,
        actorUserId: financeAudit.actorFromReq(req).actorUserId,
        source: 'ui',
        before: { balance: result.balance_before },
        after: {
          balance: result.balance_after,
          amount: result.amount,
          payment_method: result.payment_method,
          operation_id: result.operation_id,
        },
      }).catch((e) => console.error('[karateAnnuities] financeAudit falhou (receive):', e.message));
    }

    res.json(result);
  } catch (err) {
    respondAnnuityPaymentError(res, err, 'Erro ao registrar baixa da anuidade');
  }
});

// GET /financial/annuities/:annuityId/payments — extrato (ledger
// karate_annuity_payments), mais recente primeiro (paid_at DESC; created_at
// DESC como desempate — "gerado por último, visualizado primeiro").
router.get('/annuities/:annuityId/payments', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, annuityId } = req.params;

  try {
    const headerRes = await db.query(
      `SELECT id, dojo_id, practitioner_id FROM karate_dojo_annuity_history
        WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [annuityId, federationId]
    );
    if (!headerRes.rows.length) {
      return res.status(404).json({ error: 'Anuidade não encontrada', code: 'NOT_FOUND' });
    }

    const { rows } = await db.query(
      `SELECT p.id, p.installment_id, p.annuity_id, p.amount, p.paid_at,
              p.payment_method, p.created_by, p.operation_id, p.created_at,
              i.seq, i.kind
         FROM karate_annuity_payments p
         JOIN karate_annuity_installments i ON i.id = p.installment_id
        WHERE p.annuity_id = $1 AND p.federation_id = $2
        ORDER BY p.paid_at DESC, p.created_at DESC`,
      [annuityId, federationId]
    );

    const data = rows.map((r) => ({
      id: r.id,
      installment_id: r.installment_id,
      annuity_id: r.annuity_id,
      seq: r.seq,
      kind: r.kind,
      amount: Number(r.amount),
      paid_at: r.paid_at,
      payment_method: r.payment_method,
      created_by: r.created_by,
      operation_id: r.operation_id,
      created_at: r.created_at,
    }));

    res.json({
      annuity_id: annuityId,
      dojo_id: headerRes.rows[0].dojo_id || null,
      practitioner_id: headerRes.rows[0].practitioner_id || null,
      total: round2ForResponse(data.reduce((s, r) => s + r.amount, 0)),
      count: data.length,
      data,
    });
  } catch (err) {
    if (err.code === '42703' || err.code === '42P01') {
      console.warn('[karateAnnuities] extrato: tabela/coluna ausente (migration 247/249 pendente) —', err.message);
