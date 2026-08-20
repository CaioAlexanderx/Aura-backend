// ============================================================
// AURA KARATÊ — Ledger de pagamentos da anuidade (Fase F1 + F3)
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
// Atomicidade / idempotência (F1 não tinha rota ainda — HTTP retry era
// escopo de F3, agora resolvido abaixo):
//   Toda a leitura+distribuição+escrita roda em UMA transação (BEGIN/
//   COMMIT), com `SELECT ... FOR UPDATE` travando as parcelas do
//   annuity_id logo no início — duas chamadas concorrentes de
//   applyAnnuityPayment na MESMA anuidade serializam (a segunda espera a
//   primeira liberar as linhas), então não há leitura de saldo
//   desatualizado nem dupla baixa sobre o mesmo saldo. Qualquer erro no
//   meio do caminho faz ROLLBACK — não existe estado "meio aplicado"
//   (installments atualizadas mas ledger não gravado, ou vice-versa).
//
// Dedup por operation_id (Fase F3, migration 249):
//   Um retry HTTP que reenvia a MESMA requisição de baixa duas vezes (ex.:
//   timeout + reenvio automático, duplo-clique) é um problema DIFERENTE de
//   concorrência — são dois `amount` legítimos do ponto de vista deste
//   motor, ele não tem como saber que é retry sem uma pista do cliente.
//   Se o caller passar `operation_id` (string opaca, gerada pelo
//   cliente/UI — idempotency key), a MESMA operation_id em duas chamadas
//   aplica o pagamento UMA vez só: a primeira reserva a chave em
//   karate_annuity_payment_operations (INSERT ... ON CONFLICT DO NOTHING,
//   operation_id é PRIMARY KEY) e grava o resultado completo nela antes do
//   COMMIT; a segunda perde a corrida no INSERT, não escreve nada de novo
//   (nem installments, nem ledger), e devolve o MESMO resultado da
//   primeira com `idempotent_hit:true`. Sem operation_id, comportamento
//   idêntico ao F1 (aplica normal, sem passar pela tabela). Ver migration
//   249 para o desenho completo (por que tabela dedicada em vez de UNIQUE
//   direto no ledger — uma operação pode gerar várias linhas de ledger).
//   Backend sobe antes da migration: cache module-level otimista
//   (HAS_OPERATION_ID_SUPPORT), cai pra "aplica sem dedup" em 42P01 em vez
//   de 500 — dedup ausente nunca bloqueia a baixa em si.
//
// dry-run:
//   dryRun:true roda a MESMA leitura+distribuição (mesmo código, mesmo
//   `SELECT ... FOR UPDATE` dentro da transação, para refletir o saldo
//   real mesmo sob concorrência) mas termina em ROLLBACK em vez de
//   COMMIT — nenhuma linha de installment, ledger ou rollup do header é
//   alterada, e `operation_id` é IGNORADO (preview nunca consome a chave
//   de idempotência — só o commit real participa do dedup). O shape do
//   retorno é idêntico ao do commit real (mesma função monta os dois a
//   partir da mesma distribuição, mesmos campos `idempotent_hit`/
//   `operation_id`) — é o que a prévia da tela (F4) vai consumir.
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

// Migration 249 (F3) — karate_annuity_payment_operations (dedup por
// operation_id). Mesma armadilha_schema_pre_migration do CLAUDE.md: cache
// module-level otimista, vira false em 42P01 (tabela ainda não existe).
let HAS_OPERATION_ID_SUPPORT = true;

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

// ── Escrita da distribuição FIFO (parcela + ledger) sobre um `client` já em
// transação do CHAMADOR — write path ÚNICO de baixa. Extraído do laço inline
// de applyAnnuityPayment para ser reusado também por settlePeriodOnClient (o
// caminho do sync), garantindo que sync e /receive gravem parcela/ledger
// EXATAMENTE do mesmo jeito (mesmas colunas, mesma ordem — CLAUDE.md: evitar
// "segunda porta de baixa" com write path divergente). NÃO gerencia
// transação, lock nem dedup — isso é responsabilidade de quem chama.
async function writeDistribution(client, {
  federation_id, annuity_id, allocations, payment_method, paid_at_iso, created_by, operation_id,
}) {
  for (const a of allocations) {
    await client.query(
      `UPDATE karate_annuity_installments
          SET amount_paid = $1,
              status = $2,
              payment_method = COALESCE($3, payment_method),
              paid_at = CASE WHEN $2 = 'paid' THEN $4::timestamptz ELSE paid_at END,
              updated_at = NOW()
        WHERE id = $5`,
      [a.amount_paid_after, a.status_after, payment_method, paid_at_iso, a.installment_id]
    );

    await client.query(
      `INSERT INTO karate_annuity_payments
         (federation_id, installment_id, annuity_id, amount, paid_at, payment_method, created_by, operation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [federation_id, a.installment_id, annuity_id, a.amount_applied, paid_at_iso, payment_method, created_by, operation_id]
    );
  }
}

// ── settlePeriodOnClient — liquidação da anuidade do período pelo sync ────────
//
// Usado pelo consumidor de eventos annuity_paid (karateApplyEvent.settleAnnuity):
// liquida a(s) PARCELA(s) da anuidade pelo MESMO primitivo do /confirm (ledger
// karate_annuity_payments + amount_paid) e deixa syncAnnuityHeaderRollup DERIVAR
// o header — a fonte única de verdade passa a ser a parcela; o header é
// projeção. Isso elimina POR CONSTRUÇÃO a divergência header↔parcela (o summary
// lê parcela, não header) e o risco de um rollup futuro reverter um header
// 'paid' escrito à mão.
//
// Roda na transação que o CHAMADOR já abriu (o runner de sync) — NÃO gerencia
// BEGIN/COMMIT nem dedup por operation_id: a idempotência do sync é a claim em
// karate_sync_applied, na MESMA transação (ver karateApplyEvent.applyEvent).
//
// Diferença DELIBERADA vs. applyAnnuityPayment: aqui `amount` é um SINAL de
// conciliação vindo do dojô, não uma baixa precisa digitada por um operador.
//   • amount nulo/ausente  → liquida o SALDO EM ABERTO INTEIRO ("anuidade paga"
//                            sem valor detalhado — semântica histórica do evento).
//   • amount > saldo aberto → CAPA ao saldo (não lança AMOUNT_EXCEEDS_BALANCE;
//                            sobra NÃO vira crédito — mesma regra de escopo).
//   • amount parcial        → aplica FIFO só o valor informado; o header
//                            DERIVA 'pending' (nunca marca 'paid' um pagamento
//                            parcial — ver nota ASSOCIAÇÃO SIMÕES no PR).
//
// Retorno: { settled_amount, allocations, header } no caso normal;
//   { no_installments:true, header:null } quando o header existe mas não tem
//   NENHUMA parcela (anomalia de dado legado — o chamador decide o fallback);
//   { already_settled:true, settled_amount:0, header } quando o saldo já é zero.
async function settlePeriodOnClient(client, {
  federation_id, annuity_id, amount = null, payment_method = null, paid_at = null, created_by = null,
}) {
  const { rows: installments } = await client.query(
    `SELECT id, annuity_id, federation_id, seq, amount, amount_paid, status, due_date, kind
       FROM karate_annuity_installments
      WHERE annuity_id = $1 AND federation_id = $2
      ORDER BY due_date ASC NULLS FIRST, seq ASC
      FOR UPDATE`,
    [annuity_id, federation_id]
  );
  if (!installments.length) {
    return { no_installments: true, settled_amount: 0, allocations: [], header: null };
  }

  const balance = round2(
    installments.reduce((s, i) => s + Math.max(round2(i.amount) - round2(i.amount_paid), 0), 0)
  );
  const requested = amount == null ? balance : round2(Number(amount));
  const eff = round2(Math.min(Math.max(requested, 0), balance)); // capado ao saldo

  let paidAtIso;
  if (paid_at) {
    const d = paid_at instanceof Date ? paid_at : new Date(paid_at);
    paidAtIso = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } else {
    paidAtIso = new Date().toISOString();
  }

  if (eff <= EPSILON) {
    // Saldo já quitado → no-op idempotente. Ainda deriva o header para
    // devolvê-lo consistente, sem escrever parcela/ledger.
    const header = await syncAnnuityHeaderRollup(client, annuity_id);
    return { already_settled: true, settled_amount: 0, allocations: [], header };
  }

  const dist = computeDistribution(installments, eff); // eff<=balance → nunca estoura
  await writeDistribution(client, {
    federation_id,
    annuity_id,
    allocations: dist.allocations,
    payment_method,
    paid_at_iso: paidAtIso,
    created_by,
    operation_id: null,
  });
  const header = await syncAnnuityHeaderRollup(client, annuity_id);
  return { settled_amount: dist.total_applied, allocations: dist.allocations, header };
}

// ── applyAnnuityPayment — o motor de baixa FIFO (coração do F1, dedup do F3) ─
//
// { federation_id, annuity_id, amount, payment_method, paid_at,
//   created_by, dryRun, operation_id }
//
// Carrega as parcelas do annuity_id (FIFO), distribui `amount` sobre o
// saldo de cada uma da mais antiga pra mais nova, recusa excedente
// (AMOUNT_EXCEEDS_BALANCE), grava ledger + atualiza installment + rollup
// do header numa única transação. dryRun:true faz a mesma distribuição em
// memória e não grava nada (ROLLBACK sempre) — operation_id é ignorado no
// dry-run. Com operation_id no commit real, um retry com a MESMA chave não
// reaplica o pagamento (ver comentário de topo do arquivo).
async function applyAnnuityPayment({
  federation_id,
  annuity_id,
  amount,
  payment_method = null,
  paid_at,
  created_by = null,
  dryRun = false,
  operation_id = null,
  installment_id = null,
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

  const opId = operation_id != null && String(operation_id).trim() !== ''
    ? String(operation_id).trim()
    : null;
  if (opId !== null && opId.length > 200) {
    throw new AnnuityPaymentError('OPERATION_ID_INVALID', 'operation_id inválido (máx. 200 caracteres)', 422);
  }

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

    // Escopo opcional a UMA parcela específica (ex.: rota legada de baixa
    // por installmentId — ver karateAnnuities.js, consolidação F3). Reusa
    // TODO o resto do motor (lock, dedup, status, ledger, rollup) — só
    // restringe o array que entra em computeDistribution a essa parcela,
    // em vez do FIFO completo da anuidade. Continua vindo do MESMO
    // SELECT...FOR UPDATE acima (mesma trava, mesma atomicidade).
    let targetInstallments = installments;
    if (installment_id) {
      targetInstallments = installments.filter((i) => String(i.id) === String(installment_id));
      if (!targetInstallments.length) {
        throw new AnnuityPaymentError(
          'INSTALLMENT_NOT_FOUND',
          'Parcela não encontrada nesta anuidade',
          404
        );
      }
    }

    // ── Dedup por operation_id (F3, migration 249) — PRÉ-CHECAGEM ──────
    // Roda ANTES de computeDistribution de propósito: um retry genuíno
    // chega DEPOIS que a 1ª chamada já mudou o saldo das parcelas (ex.:
    // pagamento que quitou tudo) — se checássemos o operation_id só DEPOIS
    // de calcular a distribuição sobre o saldo JÁ ATUALIZADO, o retry
    // tomaria AMOUNT_EXCEEDS_BALANCE (saldo já é 0) em vez do replay
    // idempotente esperado. A pré-checagem é só leitura (SELECT), não
    // reserva nada — se não achar nada aqui, cai no fluxo normal e a
    // reserva de verdade (INSERT ON CONFLICT) acontece mais abaixo, já
    // depois da validação de saldo (assim uma tentativa que falha por
    // AMOUNT_EXCEEDS_BALANCE NÃO consome a chave — o cliente pode tentar
    // de novo com o valor corrigido usando o MESMO operation_id).
    async function replayFromRow(row) {
      if (
        String(row.annuity_id) !== String(annuity_id) ||
        Math.abs(round2(Number(row.amount)) - amt) > EPSILON
      ) {
        throw new AnnuityPaymentError(
          'OPERATION_ID_CONFLICT',
          'operation_id já foi usado para uma baixa diferente (annuity_id/amount não coincidem) — gere uma nova chave de operação.',
          409,
          { operation_id: opId }
        );
      }
      if (row.result == null) {
        // Reservado por uma transação concorrente que ainda não commitou
        // — sem snapshot pra devolver ainda (corrida rara).
        throw new AnnuityPaymentError(
          'OPERATION_IN_PROGRESS',
          'Esta operação já está sendo processada — tente novamente em instantes.',
          409
        );
      }
      return { ...row.result, idempotent_hit: true };
    }

    if (opId && !dryRun && HAS_OPERATION_ID_SUPPORT) {
      // SAVEPOINT: mesma razão do claim mais abaixo — um 42P01 aqui não
      // pode abortar a transação inteira (armadilha CLAUDE.md #10).
      await client.query('SAVEPOINT op_precheck');
      try {
        const existing = await client.query(
          `SELECT federation_id, annuity_id, amount, result
             FROM karate_annuity_payment_operations
            WHERE operation_id = $1`,
          [opId]
        );
        if (existing.rows.length) {
          const replay = await replayFromRow(existing.rows[0]);
          await client.query('ROLLBACK');
          return replay;
        }
      } catch (e) {
        if (e instanceof AnnuityPaymentError) throw e;
        if (e.code === '42P01') {
          await client.query('ROLLBACK TO SAVEPOINT op_precheck');
          HAS_OPERATION_ID_SUPPORT = false;
          console.warn(
            '[karateAnnuityLedger] migration 249 ausente (karate_annuity_payment_operations) — dedup por operation_id desativado, aplicando normalmente:',
            e.message
          );
        } else {
          throw e;
        }
      }
    }

    const dist = computeDistribution(targetInstallments, amt);

    if (dryRun) {
      await client.query('ROLLBACK');
      return {
        dry_run: true,
        federation_id,
        annuity_id,
        installment_id: installment_id || null,
        amount: amt,
        payment_method,
        paid_at: paidAtIso,
        operation_id: opId,
        idempotent_hit: false,
        ...dist,
        header: null,
      };
    }

    // ── Reserva de verdade (F3, migration 249) ──────────────────────────
    // Só chega aqui depois que amount JÁ passou pela validação de saldo —
    // uma AMOUNT_EXCEEDS_BALANCE nunca consome a chave (ver comentário
    // acima). INSERT ... ON CONFLICT DO NOTHING é o que resolve a corrida
    // real entre duas chamadas concorrentes com o MESMO operation_id (a
    // pré-checagem acima é só uma otimização de UX para o caso comum de
    // retry sequencial, não substitui esta reserva atômica).
    if (opId && HAS_OPERATION_ID_SUPPORT) {
      // SAVEPOINT: um 42P01 aqui (tabela ainda não migrada) NÃO pode
      // deixar a transação inteira "aborted" (Postgres aborta a TX inteira
      // no primeiro erro de statement, catch em JS sozinho não desfaz isso
      // — armadilha CLAUDE.md #10). ROLLBACK TO SAVEPOINT desfaz só a
      // tentativa de claim, preservando o FOR UPDATE/dist já obtidos.
      await client.query('SAVEPOINT op_claim');
      try {
        const claim = await client.query(
          `INSERT INTO karate_annuity_payment_operations
             (operation_id, federation_id, annuity_id, amount)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (operation_id) DO NOTHING
           RETURNING operation_id`,
          [opId, federation_id, annuity_id, amt]
        );

        if (!claim.rows.length) {
          // Perdeu a corrida — outra chamada (concorrente) reservou a
          // MESMA chave entre a pré-checagem e agora. Busca o resultado
          // gravado em vez de reaplicar o pagamento.
          const existing = await client.query(
            `SELECT federation_id, annuity_id, amount, result
               FROM karate_annuity_payment_operations
              WHERE operation_id = $1`,
            [opId]
          );
          await client.query('ROLLBACK');

          const row = existing.rows[0];
          if (!row) {
            // Corrida extrema (linha sumiu entre o INSERT e o SELECT).
            throw new AnnuityPaymentError(
              'OPERATION_IN_PROGRESS',
              'Esta operação já está sendo processada — tente novamente em instantes.',
              409
            );
          }
          return await replayFromRow(row);
        }
      } catch (e) {
        if (e instanceof AnnuityPaymentError) throw e;
        if (e.code === '42P01') {
          await client.query('ROLLBACK TO SAVEPOINT op_claim');
          HAS_OPERATION_ID_SUPPORT = false;
          console.warn(
            '[karateAnnuityLedger] migration 249 ausente (karate_annuity_payment_operations) — dedup por operation_id desativado, aplicando normalmente:',
            e.message
          );
        } else {
          throw e;
        }
      }
    }

    await writeDistribution(client, {
      federation_id,
      annuity_id,
      allocations: dist.allocations,
      payment_method,
      paid_at_iso: paidAtIso,
      created_by,
      operation_id: opId,
    });

    // Fonte única de verdade do rollup do header — reutiliza
    // karateAnnuityService.syncAnnuityHeaderRollup, não duplica a lógica.
    const header = await syncAnnuityHeaderRollup(client, annuity_id);

    const result = {
      dry_run: false,
      federation_id,
      annuity_id,
      installment_id: installment_id || null,
      amount: amt,
      payment_method,
      paid_at: paidAtIso,
      operation_id: opId,
      ...dist,
      header,
    };

    if (opId && HAS_OPERATION_ID_SUPPORT) {
      await client.query(
        `UPDATE karate_annuity_payment_operations SET result = $1::jsonb WHERE operation_id = $2`,
        [JSON.stringify(result), opId]
      );
    }

    await client.query('COMMIT');

    return { ...result, idempotent_hit: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// pg devolve timestamptz como Date -- normaliza pra ISO string (mesmo
// formato que applyAnnuityPayment grava/devolve em paid_at) sem reinterpretar
// fuso (nao e uma coluna `date` pura, e timestamptz -- .toISOString() aqui e
// seguro).
function toIsoDateTime(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// ============================================================
// recomputeAnnuityFromLedger -- Editar/remover uma baixa lancada por engano
//
// Decisao de FIFO (documentada aqui por pedido explicito do Caio,
// 23/07/2026 -- ver PR): o motor F1/F3 (applyAnnuityPayment) grava cada
// baixa como N linhas em karate_annuity_payments (uma por parcela tocada
// pelo FIFO daquele momento). Editar/remover UMA linha tem duas
// abordagens possiveis:
//
//   (a) Recompute LOCAL por linha: mexe so na parcela dona da linha
//       editada/removida (amount_paid = SUM das linhas QUE JA APONTAM
//       para aquela parcela). Simples, mas pode deixar o FIFO "impuro":
//       ex. baixa de R$500 zera parcela 1 (R$300) e deixa R$200 na
//       parcela 2; se a federacao depois EDITA a linha da parcela 1 para
//       R$100 (achou que era R$100, nao R$300), o motor original teria
//       estourado R$200 pra parcela 2 automaticamente -- o recompute local
//       NAO faz isso, a parcela 1 fica com saldo aberto de R$200 sem dono
//       e a parcela 2 continua com so R$200 aplicado, mesmo havendo R$200
//       "sobrando" que deveriam ter fluido pra ela. Estado diverge do que
//       o motor produziria numa baixa nova.
//
//   (b) Rebuild GLOBAL por anuidade (ESCOLHIDA): apaga TODA a distribuicao
//       atual, zera as parcelas em memoria, e RE-APLICA cada linha do
//       ledger remanescente (ja com a edicao/remocao feita) em ordem
//       cronologica de aplicacao original, rerodando o MESMO
//       computeDistribution do motor a cada linha -- reatribuindo
//       installment_id conforme o FIFO real pede. Mais codigo, mas o
//       estado pos-edicao fica IDENTICO ao que o motor produziria se as
//       baixas tivessem sido lancadas, desde o inicio, com os valores ja
//       corrigidos. E a opcao pedida explicitamente pelo Caio -- "manter o
//       FIFO integro e o estado identico ao motor" -- e e a unica que lida
//       corretamente com edicao pra CIMA que estoura o saldo da parcela
//       original (o excedente tem que fluir pra proxima parcela em aberto,
//       exatamente como aconteceria numa baixa nova).
//
// Ordem de replay: `created_at` ASC (a ordem REAL em que cada baixa foi
// efetivamente aplicada pelo motor -- NUNCA `paid_at`, que e a data
// NOMINAL do pagamento e pode ser retroativa/editada livremente sem mudar
// "quando" ela foi de fato lancada no sistema). Todas as linhas de UMA
// MESMA chamada de applyAnnuityPayment compartilham o EXATO MESMO
// created_at (grava dentro da mesma transacao -- `now()` do Postgres e
// fixo por transacao, nao por statement), entao o desempate secundario
// (due_date/seq da parcela a que a linha pertencia, id como desempate
// final) reconstroi a ordem FIFO INTRA-operacao em que o motor original
// alocou aquela baixa entre as parcelas que tocou. Isso e o que garante
// que aplicar as sub-parcelas de uma baixa dividida em sequencia (nesta
// ordem) reproduz exatamente o mesmo resultado que aplicar o valor total
// de uma vez (FIFO e associativo nesse sentido: dividir um valor em
// pedacos ordenados e aplica-los um a um nao muda quem recebe o que,
// desde que a ordem relativa dos pedacos seja preservada e nada mais se
// intercale no meio -- que e o caso aqui, dentro de uma unica transacao).
//
// Efeito colateral aceito e documentado: os `id` (uuid) das linhas do
// ledger NAO sobrevivem a um recompute -- a tabela inteira da anuidade e
// apagada e re-inserida com ids novos (created_at original e preservado
// para manter a ordem de replay estavel em recomputes futuros). Isso e
// seguro porque karate_annuity_payments e um ledger de AUDITORIA/EXTRATO
// (nada mais referencia payment_id como chave estrangeira) -- quem le o
// extrato depois de um recompute ve o estado novo, correto.
//
// AMOUNT_EXCEEDS_BALANCE "de graca": como o replay reusa computeDistribution
// (mesma validacao de saldo do motor), se o total editado ultrapassar o
// que a anuidade deve, o replay estoura e lanca AnnuityPaymentError
// AMOUNT_EXCEEDS_BALANCE no meio do rebuild -- a transacao inteira do
// caller deve dar ROLLBACK (nenhuma escrita parcial fica presa).
//
// Reconciliacao de `transactions` (bidirecional, diferente de
// reconcileClosedInstallmentTransactions do karateAnnuities.js, que so
// FECHA) fica a cargo do CALLER (rota) -- este motor so mexe em
// karate_annuity_payments/karate_annuity_installments/
// karate_dojo_annuity_history, nunca em `transactions` (mesma separacao de
// responsabilidade do resto deste arquivo).
//
// `client` ja deve estar dentro de um BEGIN do caller (mesmo padrao de
// syncAnnuityHeaderRollup -- este helper NAO abre/fecha transacao sozinho).
// A mutacao da(s) linha(s) editada(s)/removida(s) do ledger e
// responsabilidade do CALLER, ANTES de chamar este helper (UPDATE/DELETE
// direto em karate_annuity_payments) -- este helper so LE o ledger como
// esta no momento em que e chamado e reconstroi tudo a partir dali.
// ============================================================
async function recomputeAnnuityFromLedger(client, { federation_id, annuity_id }) {
  if (!federation_id) {
    throw new AnnuityPaymentError('FEDERATION_ID_REQUIRED', 'federation_id e obrigatorio', 422);
  }
  if (!annuity_id) {
    throw new AnnuityPaymentError('ANNUITY_ID_REQUIRED', 'annuity_id e obrigatorio', 422);
  }

  // Mesmo lock/mesma ordem FIFO do motor (SELECT ... FOR UPDATE) -- serializa
  // qualquer applyAnnuityPayment/recompute concorrente sobre a MESMA anuidade.
  const { rows: installments } = await client.query(
    `SELECT id, annuity_id, federation_id, seq, amount, amount_paid, status, due_date, kind, payment_method, paid_at
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

  const fifoOrder = installments.map((i) => String(i.id));
  const state = new Map();
  for (const inst of installments) {
    state.set(String(inst.id), {
      id: inst.id,
      seq: inst.seq,
      due_date: inst.due_date,
      kind: inst.kind,
      amount: round2(inst.amount),
      amount_paid: 0,
      status: 'pending',
      payment_method: null,
      paid_at: null,
    });
  }

  // Ledger remanescente (ja com a edicao/remocao do caller aplicada) --
  // ver comentario de topo sobre a ordem de replay.
  const { rows: ledgerRows } = await client.query(
    `SELECT p.id, p.installment_id, p.amount, p.paid_at, p.payment_method,
            p.created_by, p.operation_id, p.created_at
       FROM karate_annuity_payments p
       JOIN karate_annuity_installments i ON i.id = p.installment_id
      WHERE p.annuity_id = $1 AND p.federation_id = $2
      ORDER BY p.created_at ASC, i.due_date ASC NULLS FIRST, i.seq ASC, p.id ASC`,
    [annuity_id, federation_id]
  );

  const newLedgerRows = [];
  for (const row of ledgerRows) {
    const snapshot = fifoOrder.map((id) => {
      const s = state.get(id);
      return {
        id: s.id,
        annuity_id,
        seq: s.seq,
        due_date: s.due_date,
        kind: s.kind,
        amount: s.amount,
        amount_paid: s.amount_paid,
        status: s.status,
      };
    });

    const dist = computeDistribution(snapshot, round2(Number(row.amount)));
    const paidAtVal = toIsoDateTime(row.paid_at);

    for (const a of dist.allocations) {
      const s = state.get(String(a.installment_id));
      s.amount_paid = a.amount_paid_after;
      s.status = a.status_after;
      if (row.payment_method != null) s.payment_method = row.payment_method;
      if (a.status_after === 'paid') s.paid_at = paidAtVal;

      newLedgerRows.push({
        installment_id: a.installment_id,
        amount: a.amount_applied,
        paid_at: row.paid_at,
        payment_method: row.payment_method,
        created_by: row.created_by,
        operation_id: row.operation_id,
        created_at: row.created_at,
      });
    }
  }

  await client.query(
    `DELETE FROM karate_annuity_payments WHERE annuity_id = $1 AND federation_id = $2`,
    [annuity_id, federation_id]
  );
  for (const r of newLedgerRows) {
    await client.query(
      `INSERT INTO karate_annuity_payments
         (federation_id, installment_id, annuity_id, amount, paid_at, payment_method, created_by, operation_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [federation_id, r.installment_id, annuity_id, r.amount, r.paid_at, r.payment_method, r.created_by, r.operation_id, r.created_at]
    );
  }

  const updatedInstallments = [];
  for (const id of fifoOrder) {
    const s = state.get(id);
    const { rows } = await client.query(
      `UPDATE karate_annuity_installments
          SET amount_paid = $1,
              status = $2,
              payment_method = $3,
              paid_at = $4::timestamptz,
              updated_at = NOW()
        WHERE id = $5
        RETURNING *`,
      [s.amount_paid, s.status, s.payment_method, s.paid_at, id]
    );
    updatedInstallments.push(rows[0]);
  }

  // Fonte unica de verdade do rollup do header -- mesma funcao do motor.
  const header = await syncAnnuityHeaderRollup(client, annuity_id);

  return {
    federation_id,
    annuity_id,
    installments: updatedInstallments,
    ledger: newLedgerRows,
    header,
  };
}

module.exports = {
  AnnuityPaymentError,
  applyAnnuityPayment,
  settlePeriodOnClient,
  writeDistribution,
  computeDistribution,
  deriveStatusFromAmountPaid,
  toIsoDate,
  toIsoDateTime,
  round2,
  recomputeAnnuityFromLedger,
};
