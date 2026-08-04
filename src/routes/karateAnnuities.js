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
