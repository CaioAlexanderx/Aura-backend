// ============================================================
// AURA KARATÊ — Ledger de pagamentos da anuidade (Fase F1)
//
// Por que um módulo separado de karateAnnuityService.js:
//   karateAnnuityService.js já é o motor de GERAÇÃO do plano de parcelas
//   (fees, datas de vencimento, criação de installments/transactions —
//   ver buildPlanSpecs/createInstallmentsForAnnuity). Este módulo é o
//   motor de BAIXA/RECEBIMENTO — responsabilidade diferente (aplicar
//   dinheiro que chegou sobre parcelas que já existem, distribuir FIFO,
//   aceitar parcial, gravar ledger de auditoria). Mantém
//   karateAnnuityService.js focado em geração de cobrança, evita inflar
//   ainda mais um arquivo que já concentra fee/plan/rollup, e dá a este
//   motor (o "coração" do F1, por spec) um arquivo e uma suíte de testes
//   próprios. Reaproveita karateAnnuityService.syncAnnuityHeaderRollup —
//   NÃO duplica a lógica de rollup do header (fonte única de verdade).
//
// Modelo de negócio (decisões fechadas com o Caio, F1):
//   Cada parcela (karate_annuity_installments) tem devido (amount) x
//   recebido (amount_paid, migration 247). A baixa aceita valor
//   livre/parcial. Cada recebimento aplicado por applyAnnuityPayment vira
//   uma linha no ledger karate_annuity_payments (extrato/auditoria — uma
//   parcela pode ter N linhas de N baixas parciais diferentes).
//
//   Renegociação do valor devido e carteira de crédito (saldo credor
//   reutilizável em cobranças futuras) estão FORA DE ESCOPO nesta fase —
//   por isso um pagamento que excede o saldo em aberto do recebível é
//   RECUSADO (AMOUNT_EXCEEDS_BALANCE), nunca gera sobra/crédito.
//
// FIFO (ordem de aplicação do valor sobre as parcelas em aberto):
//   due_date ASC NULLS FIRST, seq ASC — a parcela mais ANTIGA é quitada
//   primeiro. NULLS FIRST porque due_date nulo (parcela sem vencimento
//   definido, ex.: drift de dado legado) é tratada como "já vencida" para
//   fins de prioridade de baixa — mais correto do que mandá-la pro fim da
//   fila, onde poderia nunca ser quitada enquanto houver parcelas com
//   due_date preenchido. Em due_date empatado (mesma data), seq ASC
//   desempata pela ordem natural do plano.
//
// Atomicidade / idempotência (F1 não tem rota ainda — HTTP retry é
// problema de F3):
//   Toda a leitura+distribuição+escrita roda em UMA transação (BEGIN/
//   COMMIT), com `SELECT ... FOR UPDATE` travando as parcelas do
//   annuity_id logo no início — duas chamadas concorrentes de
//   applyAnnuityPayment na MESMA anuidade serializam (a segunda espera a
//   primeira liberar as linhas), então não há leitura de saldo
//   desatualizado nem dupla baixa sobre o mesmo saldo. Qualquer erro no
//   meio do caminho faz ROLLBACK — não existe estado "meio aplicado"
//   (installments atualizadas mas ledger não gravado, ou vice-versa). O
//   que este módulo NÃO resolve sozinho: um retry HTTP que reenvia a
//   MESMA requisição de baixa duas vezes vai aplicar o pagamento duas
//   vezes (do ponto de vista deste service são dois `amount` legítimos —
//   ele não tem como saber que é retry). Fica documentado aqui para a
//   F3: a rota deve gerar/aceitar um id de operação (idempotency key) e
//   usar um UNIQUE constraint (ex.: (annuity_id, idempotency_key) em
//   karate_annuity_payments, coluna a adicionar quando a rota existir)
//   para transformar retry em no-op — fora de escopo do F1 porque não há
//   rota nem cliente reenviando nada ainda.
//
// dry-run:
//   dryRun:true roda a MESMA leitura+distribuição (mesmo código, mesmo
//   `SELECT ... FOR UPDATE` dentro da transação, para refletir o saldo
//   real mesmo sob concorrência) mas termina em ROLLBACK em vez de
//   COMMIT — nenhuma linha de installment, ledger ou rollup do header é
//   alterada. O shape do retorno é idêntico ao do commit real (mesma
//   função monta os dois a partir da mesma distribuição) — é o que a
//   prévia da tela (F4) vai consumir.
//
// Armadilha CLAUDE.md nº1 (pg devolve date/timestamp como objeto Date):
//   due_date (coluna `date`) é serializado nas alocações via toIsoDate()
//   — nunca String(x).slice(0,10) (isso já causou um P0 de 500 em ~96%
//   das requisições em outro módulo deste repo — ver karateNetworkHealth.js
//   e karatePractitionerDedup.js).
// ============================================================
'use strict';

const db = require('../config/database');
const { syncAnnuityHeaderRollup } = require('./karateAnnuityService');

// pg devolve `date`/`timestamptz` como objeto Date — nunca fazer
// String(v).slice(0,10) (vira "Sun Apr 17", não "2026-04-17").
function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Evita acúmulo de lixo de ponto flutuante em soma de dinheiro
// (CLAUDE.md: nunca float solto acumulando centavo).
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Tolerância de meio centavo para comparações de saldo (arredondamento
// acumulado em somas de várias parcelas).
const EPSILON = 0.005;

class AnnuityPaymentError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.name = 'AnnuityPaymentError';
    this.code = code;
    this.status = status || 422;
    if (details) this.details = details;
  }
}

// ── Status derivado da parcela após aplicar um valor (regra F1, item 3) ──
//   amount_paid = 0            → pending
//   0 < amount_paid < amount   → partial
//   amount_paid >= amount      → paid
function deriveStatusFromAmountPaid(amountPaid, amountDue) {
  if (amountPaid <= EPSILON) return 'pending';
  if (amountPaid >= amountDue - EPSILON) return 'paid';
  return 'partial';
}

// ── Monta a distribuição FIFO de `amount` sobre as parcelas em aberto,
// SEM tocar no banco — usada tanto pelo dry-run quanto pelo commit real
// (garante que os dois caminhos produzem exatamente o mesmo resultado).
//
// installments: linhas de karate_annuity_installments já ordenadas FIFO
// (due_date ASC NULLS FIRST, seq ASC — feito na query).
function computeDistribution(installments, amount) {
  const withBalance = installments.map((i) => {
    const amountDue = round2(i.amount);
    const amountPaidBefore = round2(i.amount_paid);
    return {
      ...i,
      amount_due: amountDue,
      amount_paid_before: amountPaidBefore,
      balance_before: round2(amountDue - amountPaidBefore),
    };
  });

  const totalBalance = round2(
    withBalance.reduce((s, i) => s + Math.max(i.balance_before, 0), 0)
  );

  if (amount > totalBalance + EPSILON) {
    throw new AnnuityPaymentError(
      'AMOUNT_EXCEEDS_BALANCE',
      `Valor informado (${amount.toFixed(2)}) excede o saldo em aberto do recebível (${totalBalance.toFixed(2)}). ` +
        `Carteira de crédito está fora de escopo — não é possível gerar sobra.`,
      422,
      { amount, balance: totalBalance }
    );
  }

  let remaining = amount;
  const allocations = [];
  for (const inst of withBalance) {
    if (remaining <= EPSILON) break;
    if (inst.balance_before <= EPSILON) continue; // parcela já quitada — não participa

    const applied = round2(Math.min(remaining, inst.balance_before));
    remaining = round2(remaining - applied);

    const amountPaidAfter = round2(inst.amount_paid_before + applied);
    const statusBefore = inst.status;
    const statusAfter = deriveStatusFromAmountPaid(amountPaidAfter, inst.amount_due);

    allocations.push({
      installment_id: inst.id,
      annuity_id: inst.annuity_id,
      seq: inst.seq,
      kind: inst.kind,
      due_date: toIsoDate(inst.due_date),
      amount_due: inst.amount_due,
      amount_paid_before: inst.amount_paid_before,
      amount_applied: applied,
      amount_paid_after: amountPaidAfter,
      balance_after: round2(inst.amount_due - amountPaidAfter),
      status_before: statusBefore,
      status_after: statusAfter,
      closes_installment: statusAfter === 'paid' && statusBefore !== 'paid',
    });
  }

  return {
    allocations,
    total_applied: round2(amount - remaining), // == amount sempre que não estourou (validado acima)
    remaining_unapplied: remaining, // deve ficar ~0 — sobra só existiria com bug de saldo
    balance_before: totalBalance,
    balance_after: round2(totalBalance - round2(amount - remaining)),
  };
}

// ── applyAnnuityPayment — o motor de baixa FIFO (coração do F1) ─────────
//
// { federation_id, annuity_id, amount, payment_method, paid_at,
//   created_by, dryRun }
//
// Carrega as parcelas do annuity_id (FIFO), distribui `amount` sobre o
// saldo de cada uma da mais antiga pra mais nova, recusa excedente
// (AMOUNT_EXCEEDS_BALANCE), grava ledger + atualiza installment + rollup
// do header numa única transação. dryRun:true faz a mesma distribuição em
// memória e não grava nada (ROLLBACK sempre).
async function applyAnnuityPayment({
  federation_id,
  annuity_id,
  amount,
  payment_method = null,
  paid_at,
  created_by = null,
  dryRun = false,
}) {
  if (!federation_id) {
    throw new AnnuityPaymentError('FEDERATION_ID_REQUIRED', 'federation_id é obrigatório', 422);
  }
  if (!annuity_id) {
    throw new AnnuityPaymentError('ANNUITY_ID_REQUIRED', 'annuity_id é obrigatório', 422);
  }

  const amt = round2(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new AnnuityPaymentError('AMOUNT_INVALID', 'amount deve ser um número > 0', 422);
  }

  let paidAtDate;
  if (paid_at) {
    paidAtDate = paid_at instanceof Date ? paid_at : new Date(paid_at);
    if (Number.isNaN(paidAtDate.getTime())) {
      throw new AnnuityPaymentError('PAID_AT_INVALID', 'paid_at inválido', 422);
    }
  } else {
    paidAtDate = new Date();
  }
  const paidAtIso = paidAtDate.toISOString();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE: serializa chamadas concorrentes sobre a MESMA anuidade —
    // essencial pra atomicidade (ver comentário de topo do arquivo).
    const { rows: installments } = await client.query(
      `SELECT id, annuity_id, federation_id, seq, amount, amount_paid, status, due_date, kind
         FROM karate_annuity_installments
        WHERE annuity_id = $1 AND federation_id = $2
        ORDER BY due_date ASC NULLS FIRST, seq ASC
        FOR UPDATE`,
      [annuity_id, federation_id]
    );

    if (!installments.length) {
      throw new AnnuityPaymentError(
        'ANNUITY_NOT_FOUND',
        'Nenhuma parcela encontrada para este annuity_id/federation_id',
        404
      );
    }

    const dist = computeDistribution(installments, amt);

    if (dryRun) {
      await client.query('ROLLBACK');
      return {
        dry_run: true,
        federation_id,
        annuity_id,
        amount: amt,
        payment_method,
        paid_at: paidAtIso,
        ...dist,
        header: null,
      };
    }

    for (const a of dist.allocations) {
      await client.query(
        `UPDATE karate_annuity_installments
            SET amount_paid = $1,
                status = $2,
                payment_method = COALESCE($3, payment_method),
                paid_at = CASE WHEN $2 = 'paid' THEN $4::timestamptz ELSE paid_at END,
                updated_at = NOW()
          WHERE id = $5`,
        [a.amount_paid_after, a.status_after, payment_method, paidAtIso, a.installment_id]
      );

      await client.query(
        `INSERT INTO karate_annuity_payments
           (federation_id, installment_id, annuity_id, amount, paid_at, payment_method, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [federation_id, a.installment_id, annuity_id, a.amount_applied, paidAtIso, payment_method, created_by]
      );
    }

    // Fonte única de verdade do rollup do header — reutiliza
    // karateAnnuityService.syncAnnuityHeaderRollup, não duplica a lógica.
    const header = await syncAnnuityHeaderRollup(client, annuity_id);

    await client.query('COMMIT');

    return {
      dry_run: false,
      federation_id,
      annuity_id,
      amount: amt,
      payment_method,
      paid_at: paidAtIso,
      ...dist,
      header,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  AnnuityPaymentError,
  applyAnnuityPayment,
  computeDistribution,
  deriveStatusFromAmountPaid,
  toIsoDate,
  round2,
};
