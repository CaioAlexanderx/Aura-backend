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
