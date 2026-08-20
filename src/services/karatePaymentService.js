// ============================================================
// AURA KARATÊ — Payment Reconciliation Service (Fase F5)
//
// confirmIntent(intentId, { source, federationId, paidAt, emitNfse })
//   Caminho único de baixa de pagamento: intent → parcela (ou header
//   legado) → transaction → NFS-e (best-effort). Extraído do handler
//   POST /financial/payments/:intentId/confirm (refactor puro — mesma
//   sequência de queries, mesmo efeito). Usado tanto pela confirmação
//   manual (source='manual') quanto pelo webhook de pagamento
//   (source='webhook'), garantindo que ambos produzam exatamente o
//   mesmo resultado no Financeiro.
//
// Contrato de retorno (NÃO lança pra fluxo de negócio esperado — só
// lança em erro inesperado de infra/DB, que o caller decide como
// responder):
//   { code: 'NOT_FOUND' }
//   { code: 'ALREADY_PAID', intent }
//   { code: 'OK', intentId, transactionId, federationId, status:'paid',
//     paidAt, nfseRef, source }
//
// federationId é OPCIONAL: quando informado (fluxo manual, vindo da
// URL /federation/:id/...), o SELECT do intent fica escopado por
// federation_id — preserva o comportamento atual (um admin não confirma
// intent de outra federação). Quando omitido (fluxo webhook, que só
// conhece o payment_intent_id do provedor), o intent é localizado só
// por id — a federação é derivada da própria linha (kpi.federation_id)
// pra tudo que vem depois (NFS-e etc.), então o resultado é idêntico.
// ============================================================
'use strict';

const db      = require('../config/database');
const fiscal  = require('../services/nuvemfiscal');
const annuitySvc = require('./karateAnnuityService');
const financeAudit = require('./karateFinanceAudit');

// ── NFS-e best-effort (idêntico ao bloco que existia inline no route) ──
async function _emitAnnuityNfseBestEffort(intent, paidAt) {
  let nfseRef = null;
  try {
    const federationId = intent.federation_id;

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
          console.warn('[karatePaymentService] nfse emit failed (best-effort):', fiscalErr.message);
        }
      } else {
        nfseRef = existingRef.rows[0].ref;
      }
    }
  } catch (nfseErr) {
    // NFS-e é best-effort: não bloqueia confirmação
    console.warn('[karatePaymentService] nfse block failed (best-effort):', nfseErr.message);
  }
  return nfseRef;
}

/**
 * Confirma o pagamento de um intent: intent → parcela (ou header legado)
 * → transaction → NFS-e (best-effort). Idempotente: se o intent já está
 * 'paid', não reaplica a baixa (retorna ALREADY_PAID) — é isso que garante
 * que um replay de webhook não baixa a parcela duas vezes.
 */
async function confirmIntent(intentId, opts = {}) {
  const {
    source = 'manual',
    federationId = null,
    paidAt: paidAtInput = null,
    emitNfse = true,
  } = opts;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Busca intent. LEFT JOIN (não INNER): intents novos (Fase F1, criados via
    // /annuities/installments/:id/pix) sempre têm annuity_history_id, mas
    // mantém-se LEFT para não quebrar algum intent legado sem header.
    const params = federationId ? [intentId, federationId] : [intentId];
    const intentRes = await client.query(
      `SELECT kpi.*, kdah.dojo_id, kdah.practitioner_id, kdah.reference_period,
              kdah.amount AS annuity_amount, kdah.status AS annuity_status,
              kdah.id AS annuity_history_id
       FROM karate_payment_intents kpi
       LEFT JOIN karate_dojo_annuity_history kdah ON kdah.id = kpi.annuity_history_id
       WHERE kpi.id = $1${federationId ? ' AND kpi.federation_id = $2' : ''}
       LIMIT 1`,
      params
    );
    if (!intentRes.rows.length) {
      await client.query('ROLLBACK');
      return { code: 'NOT_FOUND' };
    }

    const intent = intentRes.rows[0];
    if (intent.status === 'paid') {
      await client.query('ROLLBACK');
      return { code: 'ALREADY_PAID', intent };
    }

    const paidAt = paidAtInput || new Date().toISOString();

    // Atualiza intent
    await client.query(
      `UPDATE karate_payment_intents SET status = 'paid', paid_at = $1, updated_at = NOW() WHERE id = $2`,
      [paidAt, intentId]
    );

    // Fase F1: intent aponta pra UMA PARCELA (source_type in dojo_annuity/
    // cpf_annuity + source_id=installmentId, migration 213/222). Confirma a
    // parcela — o header só vira 'paid' quando a ÚLTIMA parcela é paga
    // (annuitySvc.syncAnnuityHeaderRollup). Intents legados (sem source_id,
    // de antes da F1) continuam confirmando o header inteiro direto.
    const isInstallmentIntent = ['dojo_annuity', 'cpf_annuity'].includes(intent.source_type) && intent.source_id;

    // G3 (auditoria financeira): before/after são montados SEM nenhuma
    // query extra — `intent` já traz tudo que precisamos (foi SELECTado
    // antes de qualquer UPDATE nesta função). Isso preserva o número de
    // queries desta transação (nenhum teste existente quebra).
    let auditTargetType = null;
    let auditTargetId = null;
    let auditBefore = null;

    if (isInstallmentIntent) {
      auditTargetType = 'installment';
      auditTargetId = intent.source_id;
      auditBefore = { status: 'pending', amount: intent.amount != null ? Number(intent.amount) : null };

      await client.query(
        `UPDATE karate_annuity_installments
         SET status = 'paid', paid_at = $1, transaction_id = COALESCE($2, transaction_id), updated_at = NOW()
         WHERE id = $3`,
        [paidAt, intent.transaction_id, intent.source_id]
      );
      if (intent.annuity_history_id) {
        await annuitySvc.syncAnnuityHeaderRollup(client, intent.annuity_history_id);
      }
    } else if (intent.annuity_history_id) {
      auditTargetType = 'annuity';
      auditTargetId = intent.annuity_history_id;
      auditBefore = {
        status: intent.annuity_status || 'pending',
        amount: intent.annuity_amount != null ? Number(intent.annuity_amount) : null,
      };

      // Legado: confirma o header inteiro (comportamento pré-F1).
      await client.query(
        `UPDATE karate_dojo_annuity_history
         SET status = 'paid', paid_at = $1, updated_at = NOW()
         WHERE id = $2`,
        [paidAt, intent.annuity_history_id]
      );
    } else if (intent.source_type === 'event_registration' && intent.source_id) {
      // ── FIX (P0 Aura Pay): baixa da INSCRIÇÃO DE EVENTO ──────────────
      // O funil público (karatePublic POST /:slug/inscricao/:eventId) cria o
      // intent com source_type='event_registration' + source_id = id da
      // inscrição — mas este confirm só tratava anuidade, então o PIX pago
      // confirmava o intent e a inscrição ficava fee_paid=false para sempre
      // (o pending_payment_count do bracket nunca zerava sozinho).
      //
      // O source_id pode morar em QUALQUER uma das três tabelas de inscrição
      // (competição / exame-curso canônico / curso legado) — o intent não
      // guarda qual. Tenta as três em ordem de probabilidade e para na
      // primeira que atualizar. SAVEPOINT por tentativa: uma tabela ausente
      // (42P01, deploy parcial) não pode envenenar a transação do confirm
      // (armadilha_tx_poison_best_effort_savepoint do CLAUDE.md).
      // karate_event_enrollments não tem updated_at (migration 160) — por
      // isso o SET difere na terceira.
      const feePaidTargets = [
        `UPDATE karate_competition_entries    SET fee_paid = true, updated_at = NOW() WHERE id = $1 AND fee_paid = false`,
        `UPDATE karate_belt_exam_candidates   SET fee_paid = true, updated_at = NOW() WHERE id = $1 AND fee_paid = false`,
        `UPDATE karate_event_enrollments      SET fee_paid = true                     WHERE id = $1 AND fee_paid = false`,
      ];
      for (const sql of feePaidTargets) {
        await client.query('SAVEPOINT sp_event_fee');
        try {
          const upd = await client.query(sql, [intent.source_id]);
          await client.query('RELEASE SAVEPOINT sp_event_fee');
          if (upd.rowCount > 0) break;
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT sp_event_fee');
          if (e.code !== '42P01' && e.code !== '42703') throw e;
        }
      }
      // Sem financeAudit aqui de propósito: karate_finance_audit_log tem
      // CHECK target_type IN ('annuity','installment') (migration 227) — o
      // rastro de pagamento de evento nasce com trilha própria no P0 da
      // delegação, não remendado no log de anuidades.
    } else if (intent.source_type === 'delegation_order' && intent.source_id) {
      // ── P0 Hub de Campeonatos: baixa do PEDIDO DE DELEGAÇÃO ─────────
      // O submit da delegação (karateDelegations) cria o intent com
      // source_type='delegation_order' + source_id = pedido. PIX pago:
      // pedido → 'paid' + cascata fee_paid em TODAS as entries amarradas
      // ao pedido (individuais e de equipe). SAVEPOINT: 42P01 de deploy
      // parcial (migration 294 pendente) não envenena o confirm.
      await client.query('SAVEPOINT sp_delegation_paid');
      try {
        await client.query(
          `UPDATE karate_delegation_orders
              SET status = 'paid', confirmed_at = COALESCE(confirmed_at, NOW()), updated_at = NOW()
            WHERE id = $1 AND status NOT IN ('paid','cancelled')`,
          [intent.source_id]
        );
        await client.query(
          `UPDATE karate_competition_entries
              SET fee_paid = true, updated_at = NOW()
            WHERE delegation_order_id = $1 AND fee_paid = false`,
          [intent.source_id]
        );
        await client.query('RELEASE SAVEPOINT sp_delegation_paid');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_delegation_paid');
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
    }

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

    // G3: rastro de auditoria financeira (quem fez, quando, antes/depois).
    // Roda numa conexão PRÓPRIA do pool (db.query, não `client`), então
    // nunca envenena a transação que acabou de ser commitada — best-effort
    // de propósito, ver karateFinanceAudit.js.
    if (auditTargetId) {
      await financeAudit.logFinanceAudit({
        federationId: intent.federation_id,
        action: 'intent_confirm',
        targetType: auditTargetType,
        targetId: auditTargetId,
        dojoId: intent.dojo_id || null,
        practitionerId: intent.practitioner_id || null,
        actorUserId: source === 'webhook' ? null : (opts.actorUserId || null),
        actorLabel: source === 'webhook' ? 'webhook' : (opts.actorLabel || null),
        source: source === 'webhook' ? 'webhook' : 'ui',
        before: auditBefore,
        after: { status: 'paid', paid_at: paidAt, transaction_id: intent.transaction_id || null },
      }).catch((e) => console.error('[karatePaymentService] financeAudit falhou (best-effort):', e.message));
    }

    // ── NFS-e: best-effort após commit (não bloqueia confirm se falhar) ──
    let nfseRef = null;
    if (emitNfse && intent.transaction_id && intent.dojo_id) {
      nfseRef = await _emitAnnuityNfseBestEffort(intent, paidAt);
    }

    return {
      code: 'OK',
      intentId,
      transactionId: intent.transaction_id,
      federationId: intent.federation_id,
      status: 'paid',
      paidAt,
      nfseRef,
      source,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { confirmIntent };
