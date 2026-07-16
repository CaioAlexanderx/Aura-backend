// ============================================================
// AURA KARATÊ — Fase F4: e-mail de cobrança de anuidade (envio manual) +
// remoção de cobrança em lote.
//
//   POST /financial/annuities/installments/:installmentId/send-email
//        — envia (ou reenvia) o e-mail de cobrança de UMA parcela.
//          Reenvio manual é PERMITIDO — sem lock de idempotência (o índice
//          único de karate_reminder_log, migration 174, é sobre
//          rule_code — nossos envios manuais usam rule_code='manual' e a
//          migration 223 exclui 'manual' desse índice único).
//
//   POST /financial/annuities/send-email-batch { installment_ids: [] }
//        — mesmo envio, em lote. NUNCA all-or-nothing: cada alvo é
//          independente. Alvo sem e-mail cadastrado → `skipped` (motivo
//          claro), NÃO é erro — é o estado normal da maioria dos dojôs/
//          praticantes hoje (ver contexto de cobertura de contato no PR).
//
//   POST /financial/annuities/void-batch { annuity_ids: [] }
//        — retirada da cobrança em lote (é REMOÇÃO da cobrança — apaga o
//          header + parcelas em aberto — NÃO é estorno financeiro; a
//          transaction cancelada já preserva a trilha, ver voidAnnuityCore
//          em karateAnnuities.js, reusado aqui).
//        Escolha de granularidade (documentada, ver PR): `annuity_ids[]`,
//        não `installment_ids[]` — o void já existente opera no header
//        inteiro (apaga TODAS as parcelas daquele header em cascata,
//        migration 222 ON DELETE CASCADE), então "remover a cobrança" só
//        faz sentido como unidade de anuidade completa; um void parcial
//        (só 1 parcela de um plano parcelado) deixaria o rollup do header
//        inconsistente e exigiria uma lógica nova de void-parcial fora do
//        escopo desta fase.
//        Guard OBRIGATÓRIO por alvo (SAVEPOINT): pula (não remove, não
//        erra) anuidade com QUALQUER parcela já PAGA, ou com NFS-e
//        emitida/em processamento para qualquer transaction ligada —
//        mesma checagem já usada em PATCH /annuities/:annuityId/plan.
//
// Nada aqui altera is_active de ninguém. Ausência de e-mail nunca é
// inadimplência nem erro — é o estado normal da maioria dos alvos hoje
// (federação de referência: 2/549 faixas-pretas e 2/29 dojôs com e-mail).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const annuitySvc = require('../services/karateAnnuityService');
const billingMailer = require('../services/karateBillingMailer');
const financeAudit = require('../services/karateFinanceAudit');
// Reusa a MESMA lógica de estorno/remoção do void individual (ver
// router.__voidAnnuityCore em karateAnnuities.js) — void-batch NÃO
// reimplementa a lógica de apagar header+parcelas/cancelar transactions.
const voidAnnuityCore = require('./karateAnnuities').__voidAnnuityCore || null;

// ── Templates da régua: schema pre-migration guard (armadilha #1) ───────
// Backend pode subir antes da migration 223 ser aplicada — cache
// module-level, vira false em 42703/42P01 e as rotas caem para os
// templates default (comportamento idêntico a "sem customização").
let HAS_TEMPLATE_COLUMNS = true;
async function getReminderTemplates(federationId) {
  if (!HAS_TEMPLATE_COLUMNS) return { subject_template: null, body_template: null };
  try {
    const { rows } = await db.query(
      `SELECT subject_template, body_template FROM karate_reminder_config WHERE federation_id = $1`,
      [federationId]
    );
    return rows[0] || { subject_template: null, body_template: null };
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') {
      HAS_TEMPLATE_COLUMNS = false;
      return { subject_template: null, body_template: null };
    }
    throw e;
  }
}

// Carrega a parcela + alvo (dojô OU praticante) + e-mail/telefone. Runner
// aceita client de transação ou usa o pool direto (db).
async function loadInstallmentTarget(runner, { installmentId, federationId }) {
  const { rows } = await runner.query(
    `SELECT i.id, i.annuity_id, i.seq, i.amount, i.due_date, i.status, i.transaction_id,
            h.federation_id, h.dojo_id, h.practitioner_id, h.reference_period, h.plan,
            COALESCE(c1.name, c2.name)   AS ref_name,
            COALESCE(c1.email, c2.email) AS ref_email,
            COALESCE(c1.phone, c2.phone) AS ref_phone
       FROM karate_annuity_installments i
       JOIN karate_dojo_annuity_history h ON h.id = i.annuity_id
       LEFT JOIN companies c1 ON c1.id = h.dojo_id
       LEFT JOIN customers c2 ON c2.id = h.practitioner_id
      WHERE i.id = $1 AND h.federation_id = $2
      LIMIT 1`,
    [installmentId, federationId]
  );
  return rows[0] || null;
}

async function logReminder(runner, entry) {
  try {
    await runner.query(
      `INSERT INTO karate_reminder_log
         (federation_id, annuity_id, dojo_id, channel, recipient, rule_code, status, provider_id, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [entry.federationId, entry.annuityId, entry.dojoId || null, 'email',
       entry.recipient || null, 'manual', entry.status, entry.providerId || null, entry.error || null]
    );
  } catch (e) {
    if (e.code !== '42P01') console.error('[karateAnnuityBilling] log falhou:', e.message);
  }
}

// Envia (efetivamente) o e-mail de cobrança de UMA parcela já carregada
// (`inst`, shape de loadInstallmentTarget). Sempre loga em
// karate_reminder_log, sucesso ou falha. Lança em caso de falha de envio
// (quem chama decide o formato da resposta HTTP).
async function sendForInstallment(runner, { inst, federationId, federationMeta, templates }) {
  const kind = inst.dojo_id ? 'dojo' : 'cpf';
  try {
    const res = await billingMailer.sendBillingEmail(runner, {
      to: inst.ref_email,
      kind,
      nome: inst.ref_name,
      amount: parseFloat(inst.amount),
      dueDate: inst.due_date,
      referencePeriod: inst.reference_period,
      federationId,
      federationMeta,
      subjectTemplate: templates.subject_template,
      bodyTemplate: templates.body_template,
    });
    await logReminder(runner, {
      federationId, annuityId: inst.annuity_id, dojoId: inst.dojo_id,
      recipient: inst.ref_email, status: 'sent', providerId: res && res.id,
    });
    return { ok: true, providerId: res && res.id };
  } catch (err) {
    await logReminder(runner, {
      federationId, annuityId: inst.annuity_id, dojoId: inst.dojo_id,
      recipient: inst.ref_email, status: 'failed', error: err.message,
    });
    return { ok: false, error: err.message };
  }
}

// ────────────────────────────────────────────────────────────────
// POST /annuities/installments/:installmentId/send-email
// ────────────────────────────────────────────────────────────────
router.post('/annuities/installments/:installmentId/send-email', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, installmentId } = req.params;
  try {
    const inst = await loadInstallmentTarget(db, { installmentId, federationId });
    if (!inst) return res.status(404).json({ error: 'Parcela não encontrada', code: 'NOT_FOUND' });
    if (!inst.ref_email) {
      return res.status(422).json({
        error: 'Este dojô/praticante não tem e-mail cadastrado — use o WhatsApp ou cadastre um e-mail.',
        code: 'EMAIL_MISSING',
      });
    }

    const federationMeta = await billingMailer.getFederationMeta(db, federationId);
    const templates = await getReminderTemplates(federationId);
    const outcome = await sendForInstallment(db, { inst, federationId, federationMeta, templates });

    if (!outcome.ok) {
      return res.status(502).json({ error: 'Falha ao enviar e-mail de cobrança', detail: outcome.error });
    }

    await financeAudit.logFinanceAudit({
      federationId, action: 'email_send', targetType: 'installment', targetId: installmentId,
      dojoId: inst.dojo_id || null, practitionerId: inst.practitioner_id || null,
      actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'ui',
      before: null,
      after: { recipient: inst.ref_email, provider_id: outcome.providerId || null },
    }).catch((e) => console.error('[karateAnnuityBilling] financeAudit falhou (send-email):', e.message));

    return res.json({
      sent: true,
      installment_id: installmentId,
      annuity_id: inst.annuity_id,
      recipient: inst.ref_email,
      provider_id: outcome.providerId || null,
    });
  } catch (err) {
    console.error('[karateAnnuityBilling] send-email error:', err.message);
    return res.status(500).json({ error: 'Erro ao enviar e-mail de cobrança', detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────────
// POST /annuities/send-email-batch { installment_ids: [] }
// Nunca all-or-nothing. Resposta: { sent[], skipped[], errors[] } — arrays
// (mesma convenção de /annuities/campaign e /annuities/batch: created/
// skipped/errors), contagem = .length de cada lista.
// ────────────────────────────────────────────────────────────────
router.post('/annuities/send-email-batch', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { installment_ids: rawIds } = req.body || {};
  const ids = Array.isArray(rawIds) ? rawIds.filter((v) => typeof v === 'string' && v.trim()) : [];

  if (!ids.length) {
    return res.status(422).json({ error: 'installment_ids obrigatório (array não vazio)', code: 'VALIDATION_ERROR' });
  }

  const sent = [];
  const skipped = [];
  const errors = [];

  const federationMeta = await billingMailer.getFederationMeta(db, federationId);
  const templates = await getReminderTemplates(federationId);

  for (const installmentId of ids) {
    try {
      const inst = await loadInstallmentTarget(db, { installmentId, federationId });
      if (!inst) {
        errors.push({ installment_id: installmentId, reason: 'not_found' });
        continue;
      }
      if (!inst.ref_email) {
        skipped.push({ installment_id: installmentId, name: inst.ref_name, reason: 'sem_email' });
        continue;
      }
      if (inst.status === 'paid') {
        skipped.push({ installment_id: installmentId, name: inst.ref_name, reason: 'parcela_ja_paga' });
        continue;
      }

      const outcome = await sendForInstallment(db, { inst, federationId, federationMeta, templates });
      if (outcome.ok) {
        sent.push({ installment_id: installmentId, name: inst.ref_name, recipient: inst.ref_email, provider_id: outcome.providerId || null });
        await financeAudit.logFinanceAudit({
          federationId, action: 'email_send', targetType: 'installment', targetId: installmentId,
          dojoId: inst.dojo_id || null, practitionerId: inst.practitioner_id || null,
          actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'batch',
          before: null,
          after: { recipient: inst.ref_email, provider_id: outcome.providerId || null },
        }).catch((e) => console.error('[karateAnnuityBilling] financeAudit falhou (send-email-batch):', e.message));
      } else {
        errors.push({ installment_id: installmentId, name: inst.ref_name, reason: outcome.error });
      }
    } catch (err) {
      console.error('[karateAnnuityBilling] send-email-batch target failed:', installmentId, err.message);
      errors.push({ installment_id: installmentId, reason: err.message });
    }
  }

  return res.json({ sent, skipped, errors });
});

// ────────────────────────────────────────────────────────────────
// Guard de void em lote — mesma checagem de PATCH /annuities/:annuityId/plan:
//   HAS_PAID_INSTALLMENT — qualquer parcela já paga bloqueia.
//   HAS_NFSE             — NFS-e autorizada/em processamento pra qualquer
//                           transaction ligada (header OU parcelas) bloqueia.
// ────────────────────────────────────────────────────────────────
async function checkVoidGuard(client, { federationId, annuityId }) {
  const histRes = await client.query(
    `SELECT id, dojo_id, practitioner_id, transaction_id
     FROM karate_dojo_annuity_history WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [annuityId, federationId]
  );
  if (!histRes.rows.length) return { found: false };
  const hist = histRes.rows[0];

  let installments = [];
  try {
    const r = await client.query(
      `SELECT id, status, transaction_id FROM karate_annuity_installments WHERE annuity_id = $1`,
      [annuityId]
    );
    installments = r.rows;
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }

  if (installments.some((i) => i.status === 'paid')) {
    return { found: true, blocked: 'has_paid_installment' };
  }

  const txIds = new Set();
  installments.forEach((i) => { if (i.transaction_id) txIds.add(i.transaction_id); });
  if (hist.transaction_id) txIds.add(hist.transaction_id);

  if (txIds.size) {
    const nfseRes = await client.query(
      `SELECT id FROM nfe_documents
       WHERE type = 'nfse' AND status IN ('authorized','processing')
         AND (payload::jsonb ->> 'transaction_id') = ANY($1::text[])
       LIMIT 1`,
      [Array.from(txIds).map(String)]
    ).catch(() => ({ rows: [] }));
    if (nfseRes.rows.length) return { found: true, blocked: 'has_nfse' };
  }

  return { found: true, blocked: null, dojo_id: hist.dojo_id, practitioner_id: hist.practitioner_id };
}

async function withSavepoint(client, label, fn) {
  const sp = 'sp_voidbatch_' + label;
  await client.query('SAVEPOINT ' + sp);
  try {
    const result = await fn();
    await client.query('RELEASE SAVEPOINT ' + sp);
    return { ok: true, result };
  } catch (err) {
    try { await client.query('ROLLBACK TO SAVEPOINT ' + sp); } catch (_) { /* noop */ }
    return { ok: false, error: err };
  }
}

// ────────────────────────────────────────────────────────────────
// POST /annuities/void-batch { annuity_ids: [] }
// Resposta: { removed[], skipped[], errors[] } — mesma convenção de
// created/skipped/errors já usada por /annuities/campaign e /annuities/batch.
// ────────────────────────────────────────────────────────────────
router.post('/annuities/void-batch', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { annuity_ids: rawIds } = req.body || {};
  const ids = Array.isArray(rawIds) ? rawIds.filter((v) => typeof v === 'string' && v.trim()) : [];

  if (!ids.length) {
    return res.status(422).json({ error: 'annuity_ids obrigatório (array não vazio)', code: 'VALIDATION_ERROR' });
  }
  if (!voidAnnuityCore) {
    return res.status(500).json({ error: 'void-batch indisponível (voidAnnuityCore não exposto por karateAnnuities.js)' });
  }

  const client = await db.connect();
  const removed = [];
  const removedAudit = [];
  const skipped = [];
  const errors = [];
  let counter = 0;
  try {
    await client.query('BEGIN');

    for (const annuityId of ids) {
      const label = String(counter++);
      const outcome = await withSavepoint(client, label, async () => {
        const guard = await checkVoidGuard(client, { federationId, annuityId });
        if (!guard.found) return { status: 'skipped', reason: 'not_found' };
        if (guard.blocked === 'has_paid_installment') {
          return { status: 'skipped', reason: 'has_paid_installment' };
        }
        if (guard.blocked === 'has_nfse') return { status: 'skipped', reason: 'has_nfse' };
        const result = await voidAnnuityCore(client, { federationId, annuityId });
        return { status: 'removed', result };
      });

      if (!outcome.ok) {
        console.error('[karateAnnuityBilling] void-batch target failed:', annuityId, outcome.error.message);
        errors.push({ annuity_id: annuityId, reason: outcome.error.message });
        continue;
      }
      const r = outcome.result;
      if (r.status === 'removed') {
        removed.push({
          annuity_id: annuityId,
          dojo_id: r.result.dojo_id || null,
          practitioner_id: r.result.practitioner_id || null,
          reference_period: r.result.reference_period,
          transaction_ids: r.result.transaction_ids,
        });
        removedAudit.push({
          annuity_id: annuityId,
          dojo_id: r.result.dojo_id || null,
          practitioner_id: r.result.practitioner_id || null,
          before: { status: r.result.status, amount: r.result.amount, plan: r.result.plan },
        });
      } else {
        skipped.push({ annuity_id: annuityId, reason: r.reason });
      }
    }

    await client.query('COMMIT');

    for (const r of removedAudit) {
      await financeAudit.logFinanceAudit({
        federationId, action: 'void', targetType: 'annuity', targetId: r.annuity_id,
        dojoId: r.dojo_id || null, practitionerId: r.practitioner_id || null,
        actorUserId: financeAudit.actorFromReq(req).actorUserId, source: 'batch',
        before: r.before,
        after: null,
      }).catch((e) => console.error('[karateAnnuityBilling] financeAudit falhou (void-batch):', e.message));
    }

    return res.json({ removed, skipped, errors });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[karateAnnuityBilling] void-batch error:', err.message);
    return res.status(500).json({ error: 'Erro ao processar remoção em lote', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
