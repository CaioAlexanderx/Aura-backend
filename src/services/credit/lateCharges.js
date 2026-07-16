// =============================================================
// AURA. -- Credito: motor de encargos lazy (mora/multa).
// Extraido de creditLedger.js (refactor 11/06/2026, sem mudanca de comportamento).
//
// computeLateCharges(installment, terms, config, asOf) -> encargos lazy.
// Contrato:
//   installment: { amount_due, covered_amount, due_date (DATE), status }
//   terms:       resolveTerms(profile, config) ou raw { late_fee_rate, late_interest_daily }
//                ou null (resolve internamente com config).
//   config:      credit_plan_configs (late_charges_enabled, late_grace_days).
//   asOf:        Date|string|undefined. Default agora; normalizado p/ dia em America/Sao_Paulo.
// Regras (imutaveis): opt-in via late_charges_enabled; so pending/overdue; carencia
//   late_grace_days (default 3); mora LINEAR; multa UNICA; TETO CDC sempre clampado;
//   defensivo (nunca lanca, em duvida zeros).
// =============================================================

const { resolveTerms, round2, LATE_FEE_MAX, LATE_INTEREST_DAILY_MAX } = require('./terms');

function computeLateCharges(installment, terms, config, asOf) {
  const ZERO = { late_fee: 0, late_interest: 0, days_overdue: 0, days_charged: 0, charges_total: 0 };
  try {
    if (!config || config.late_charges_enabled !== true) return { ...ZERO };

    const status = installment?.status;
    if (status !== 'pending' && status !== 'overdue') return { ...ZERO };

    const amountDue = Number(installment?.amount_due) || 0;
    const covered   = Number(installment?.covered_amount) || 0;
    const principalRemaining = Math.max(0, amountDue - covered);
    if (principalRemaining <= 0) return { ...ZERO };

    // due_date (DATE) -> 'YYYY-MM-DD'. node-pg entrega DATE como objeto Date.
    const dd = installment?.due_date;
    const dueYmd = dd instanceof Date ? dd.toISOString().slice(0, 10) : String(dd || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueYmd)) return { ...ZERO };

    // "hoje" (ou asOf) no dia-calendario de America/Sao_Paulo.
    const ref = asOf instanceof Date ? asOf : (asOf ? new Date(asOf) : new Date());
    if (isNaN(ref.getTime())) return { ...ZERO };
    const todayYmd = ref.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    const daysOverdue = Math.max(
      0,
      Math.round((Date.parse(todayYmd + 'T00:00:00Z') - Date.parse(dueYmd + 'T00:00:00Z')) / 86400000)
    );

    const grace = Number(config.late_grace_days ?? 3);
    const daysCharged = Math.max(0, daysOverdue - (Number.isFinite(grace) ? grace : 3));
    if (daysCharged <= 0) {
      return { late_fee: 0, late_interest: 0, days_overdue: daysOverdue, days_charged: 0, charges_total: 0 };
    }

    // Rates efetivas: aceita terms resolvido (.effective), raw, ou resolve aqui.
    const resolved = terms && terms.effective
      ? terms.effective
      : (terms && (terms.late_fee_rate != null || terms.late_interest_daily != null))
        ? terms
        : resolveTerms(null, config).effective;

    // TETO CDC (sempre clampado na leitura).
    const feeRate   = Math.min(Number(resolved.late_fee_rate) || 0, LATE_FEE_MAX);
    const dailyRate = Math.min(Number(resolved.late_interest_daily) || 0, LATE_INTEREST_DAILY_MAX);

    const late_fee      = round2(principalRemaining * feeRate);                 // multa unica
    const late_interest = round2(principalRemaining * dailyRate * daysCharged); // mora linear
    const charges_total = round2(late_fee + late_interest);

    return { late_fee, late_interest, days_overdue: daysOverdue, days_charged: daysCharged, charges_total };
  } catch (_) {
    return { late_fee: 0, late_interest: 0, days_overdue: 0, days_charged: 0, charges_total: 0 };
  }
}

module.exports = { computeLateCharges };
