// =============================================================
// AURA. -- Credito: score (label, aviso nao-impeditivo, recalculo).
// Extraido de creditLedger.js (refactor 11/06/2026, sem mudanca de comportamento).
//
// REGRA (imutavel): score baixo NUNCA bloqueia. scoreWarning so AVISA.
// =============================================================

const SP_DATE_COL = (col) => `(${col} AT TIME ZONE 'America/Sao_Paulo')::date`;

// Exportado para reuso nas rotas (GET /customers/:cid/profile, preview PDV).
function scoreLabel(score) {
  if (score >= 800) return 'premium';
  if (score >= 650) return 'bom';
  if (score >= 450) return 'regular';
  if (score >= 300) return 'restrito';
  return 'bloqueado';
}

// ─── Hub F1.4: scoreWarning ─────────────────────
// Aviso NAO-impeditivo. Retorna objeto se score < score_warn_min; senao null.
// score_warn_min null/0 = sem aviso. NUNCA bloqueia (unico impeditivo e o bloqueio MANUAL).
function scoreWarning(score, config) {
  const min = parseInt(config?.score_warn_min, 10) || 0;
  const s   = parseInt(score, 10);
  if (min > 0 && Number.isFinite(s) && s < min) {
    return { below_min: true, threshold: min, actual: s };
  }
  return null;
}

async function _recalculateScore(client, companyId, customerId) {
  try {
    const res = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'paid')                                           AS total_paid_count,
         COUNT(*) FILTER (WHERE status = 'paid'
           AND (${SP_DATE_COL('paid_at')} <= due_date OR paid_at IS NULL))                 AS total_paid_on_time,
         COALESCE(AVG(
           CASE WHEN status = 'paid'
                 AND ${SP_DATE_COL('paid_at')} > due_date
             THEN (${SP_DATE_COL('paid_at')} - due_date) END
         ), 0)                                                                              AS avg_days_late,
         COALESCE(SUM(amount_due) FILTER (WHERE status = 'paid'), 0)                       AS total_purchases
       FROM credit_installments
       WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
    const row = res.rows[0];

    const relRes = await client.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) / 2592000 AS months
       FROM customer_credit_profiles
       WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
    const months = parseFloat(relRes.rows[0]?.months) || 0;

    const n = parseInt(row.total_paid_count) || 0;
    let score = 500;
    if (n > 0) {
      const onTimePts = (parseInt(row.total_paid_on_time) || 0) / n * 400;
      const latePts   = Math.max(0, 1 - (parseFloat(row.avg_days_late) || 0) / 90) * 300;
      const volPts    = Math.min(1, (parseFloat(row.total_purchases)   || 0) / 5000) * 150;
      const senPts    = Math.min(1, months / 24) * 150;
      score = Math.min(1000, Math.max(0, Math.round(onTimePts + latePts + volPts + senPts)));
    }

    await client.query(
      `UPDATE customer_credit_profiles
         SET credit_score        = $3,
             total_paid_count    = $4,
             total_paid_on_time  = $5,
             avg_days_late       = $6,
             total_purchases     = $7,
             relationship_months = $8,
             score_updated_at    = NOW(),
             updated_at          = NOW()
       WHERE company_id = $1 AND customer_id = $2`,
      [
        companyId, customerId, score,
        parseInt(row.total_paid_count),
        parseInt(row.total_paid_on_time),
        parseFloat(row.avg_days_late),
        parseFloat(row.total_purchases),
        Math.round(months),
      ]
    );
    return score;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return null;
    throw err;
  }
}

module.exports = { scoreLabel, scoreWarning, _recalculateScore };
