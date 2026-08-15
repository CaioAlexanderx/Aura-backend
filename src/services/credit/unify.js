// =============================================================
// AURA. -- Credito: motor PURO de unificacao de carne.
// Item 3 (13/06/2026): cliente com carne aberto faz nova compra -> o lojista
// pode UNIFICAR em vez de abrir carne novo. Soma o saldo em aberto + a nova
// compra e redivide no numero de parcelas escolhido pelo lojista.
//
// computeUnifyPlan(input) -> plano deterministico (sem I/O), reusado por
// preview E aplicacao (mesma garantia preview===apply do recebimento B3).
//
// Contrato:
//   openInstallments: parcelas ABERTAS (pending|overdue) do carne alvo,
//                     [{ id, amount_due, covered_amount }]. Carrega so o que
//                     sobra (amount_due - covered_amount) -- parcela paga em
//                     parte entra so com o restante.
//   newAmount:        principal da nova compra (reais).
//   installments:     N parcelas do carne unificado (escolha do lojista). 1..100.
//   interestRate:     juros mensais (decimal). Decisao Caio 13/06: "se houver
//                     juros, recalcular". Modelo: juros simples SO sobre a nova
//                     compra (newAmount * rate) -- nao re-cobra juros sobre
//                     saldo ja parcelado. 0 = sem juros (caso comum no fiado).
//   firstDueDate:     vencimento da 1a parcela do carne unificado (YYYY-MM-DD).
//   periodUnit/Count: periodicidade (mesma semantica de terms.resolvePeriod).
//
// Invariante: soma(schedule.amount_due) === total (centavo a centavo).
// =============================================================

const { round2, dueDateForIndex } = require('./terms');

function computeUnifyPlan({
  openInstallments = [],
  newAmount = 0,
  installments = 1,
  interestRate = 0,
  firstDueDate = null,
  periodUnit = 'month',
  periodCount = 1,
} = {}) {
  // N: numero de parcelas do carne unificado, clampado (igual createCreditSale).
  const N = Math.max(1, Math.min(parseInt(installments, 10) || 1, 100));

  // Saldo carregado: so o que SOBRA das parcelas abertas (face value, ja com
  // os juros que elas porventura ja carreguem). Parcela paga em parte entra so
  // com (amount_due - covered_amount).
  const openRemaining = round2(
    (openInstallments || []).reduce(
      (s, i) => s + Math.max(0, (Number(i.amount_due) || 0) - (Number(i.covered_amount) || 0)),
      0
    )
  );

  const newAmt = round2(Math.max(0, Number(newAmount) || 0));
  const rate   = parseFloat(interestRate) || 0;

  // 13/08/2026 (feedback Caio): juros total FLAT sobre a nova compra,
  // independente do numero de parcelas -- ANTES multiplicava por N (juros
  // linear por parcela), escalando o juros total junto com o parcelamento.
  // Mesma correcao aplicada em createCreditSale e /manual-entry.
  const interestAdded = rate > 0 ? round2(newAmt * rate) : 0;

  const total = round2(openRemaining + newAmt + interestAdded);

  // Distribuicao identica a createCreditSale: floor por parcela, resto na ultima.
  const base      = Math.floor((total / N) * 100) / 100;
  const remainder = round2(total - base * N);

  const due1 = firstDueDate || (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().split('T')[0];
  })();

  const schedule = [];
  for (let i = 1; i <= N; i++) {
    schedule.push({
      number:     i,
      amount_due: i === N ? round2(base + remainder) : base,
      due_date:   dueDateForIndex(due1, periodUnit, periodCount, i - 1),
    });
  }

  return {
    open_remaining:          openRemaining,
    new_amount:              newAmt,
    interest_added:          interestAdded,
    total,
    installments_count:      N,
    schedule,
    replaced_installment_ids: (openInstallments || []).map((i) => i.id).filter(Boolean),
  };
}

module.exports = { computeUnifyPlan };
