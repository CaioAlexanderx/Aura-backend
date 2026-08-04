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