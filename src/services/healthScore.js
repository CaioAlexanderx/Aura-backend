// ============================================================
// AURA. — Health score dos clientes (13/10/2026)
//
// O cálculo morava dentro de POST /admin/health/recalculate e só rodava
// quando alguém apertava o botão: a última vez tinha sido em 25/04. Agora a
// rota e o job diário do painel (jobs/painelDiarioScheduler.js) chamam a
// mesma função.
//
// Mesmos pesos e os mesmos níveis de risco de antes. O que mudou é a fonte:
//   - atividade: companies.last_active_at (gravado desde 13/10 por
//     requireCompanyAccess) e, na falta dele, a última venda em sales;
//   - uso: vendas dos últimos 30 dias em sales (antes era transactions, que
//     conta lançamento do financeiro e não o uso do Caixa).
//
// 17/10/2026 (card t2-08, pedido da CS): lançamento de crediário conta como
// movimento, com o MESMO peso de uma venda, na atividade e no uso. Loja que
// vive do crediário (lança dívida e recebe parcela sem passar pelo Caixa) caía
// em "atenção" mesmo trabalhando todo dia. Conta em customer_credit_transactions:
//   - type 'debit' (lançamento manual / dívida) e 'payment' (recebimento);
//   - NÃO conta 'refund' (estorno/devolução) nem source 'reschedule'
//     (renegociação do carnê gera débito/crédito sintético, não é movimento);
//   - NÃO conta a linha ligada a uma venda existente e não cancelada: a venda
//     no crediário pelo PDV já é uma linha em sales (a mesma operação), então
//     o débito dela fica de fora e a venda segue contando uma vez só.
// Cancelar/desfazer apaga a linha do razão, então estorno nunca chega aqui.
// O pagamento da assinatura (payment_score) não muda.
//
// A gravação é um único INSERT em lote: com ~190 ms por ida ao banco, um
// upsert por empresa custava mais de meio minuto.
// ============================================================
'use strict';

const pool = require('../config/database');

const DAY_MS = 86400000;

// Lançamento de crediário que conta como movimento (ver cabeçalho). `t` é o
// alias da linha de customer_credit_transactions.
const CREDITO_CONTA = `t.type IN ('debit', 'payment')
           AND COALESCE(t.source, 'sale') <> 'reschedule'
           AND NOT EXISTS (SELECT 1 FROM sales sv
                            WHERE sv.id = t.sale_id
                              AND COALESCE(sv.status, 'completed') <> 'cancelled')`;

// Pontuação de uma empresa. Pura: recebe a linha e o "agora".
function calcularScore(c, agora = new Date()) {
  // Na falta de last_active_at, o movimento mais recente: venda ou crediário.
  const lastMove = [c.last_sale_at, c.last_credit_at]
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] || null;
  const lastActive = c.last_active_at || lastMove;

  let activityScore = 0;
  if (lastActive) {
    const days = Math.ceil((agora - new Date(lastActive)) / DAY_MS);
    if (days <= 7) activityScore = 25;
    else if (days <= 14) activityScore = 15;
    else if (days <= 30) activityScore = 5;
  }

  // Venda e lançamento de crediário valem igual (o SQL já tirou a duplicata).
  const sales = parseInt(c.sales_30d || 0, 10) + parseInt(c.credit_30d || 0, 10);
  let usageScore = 0;
  if (sales >= 20) usageScore = 25;
  else if (sales >= 10) usageScore = 20;
  else if (sales >= 5) usageScore = 10;
  else if (sales >= 1) usageScore = 5;

  let paymentScore = 0;
  if (c.billing_status === 'active') paymentScore = 25;
  else if (c.billing_status === 'pending') paymentScore = 10;
  else if (c.billing_status === 'trial') paymentScore = 15;

  // Adoção: o plano como proxy.
  let adoptionScore = 0;
  if (c.plan === 'expansao') adoptionScore = 25;
  else if (c.plan === 'negocio') adoptionScore = 15;
  else if (c.plan === 'essencial') adoptionScore = 5;

  const score = activityScore + usageScore + paymentScore + adoptionScore;
  const riskLevel = score >= 70 ? 'healthy' : score >= 40 ? 'attention' : score >= 20 ? 'at_risk' : 'critical';

  return {
    company_id: c.id,
    score,
    activity_score: activityScore,
    usage_score: usageScore,
    payment_score: paymentScore,
    adoption_score: adoptionScore,
    risk_level: riskLevel,
    last_login: lastActive ? new Date(lastActive).toISOString() : null,
  };
}

async function recalculateAll({ db = pool, agora = new Date() } = {}) {
  const { rows: companies } = await db.query(
    `SELECT c.id, c.plan::text AS plan, c.billing_status, c.last_active_at,
       (SELECT MAX(s.created_at) FROM sales s WHERE s.company_id = c.id) AS last_sale_at,
       (SELECT COUNT(*) FROM sales s
         WHERE s.company_id = c.id
           AND s.created_at >= NOW() - INTERVAL '30 days'
           AND COALESCE(s.status, 'completed') <> 'cancelled') AS sales_30d,
       (SELECT MAX(t.created_at) FROM customer_credit_transactions t
         WHERE t.company_id = c.id AND ${CREDITO_CONTA}) AS last_credit_at,
       (SELECT COUNT(*) FROM customer_credit_transactions t
         WHERE t.company_id = c.id
           AND t.created_at >= NOW() - INTERVAL '30 days'
           AND ${CREDITO_CONTA}) AS credit_30d
     FROM companies c
     WHERE c.is_active = true AND (c.federation_id IS NULL OR c.federation_id = c.id)`
  );

  const scores = companies.map((c) => calcularScore(c, agora));
  if (scores.length) {
    await db.query(
      `INSERT INTO client_health_scores
         (company_id, score, activity_score, usage_score, payment_score, adoption_score, risk_level, last_login, calculated_at)
       SELECT x.company_id, x.score, x.activity_score, x.usage_score, x.payment_score, x.adoption_score,
              x.risk_level, x.last_login, NOW()
         FROM jsonb_to_recordset($1::jsonb) AS x(
           company_id uuid, score int, activity_score int, usage_score int,
           payment_score int, adoption_score int, risk_level text, last_login timestamptz)
       ON CONFLICT (company_id) DO UPDATE SET
         score = EXCLUDED.score,
         activity_score = EXCLUDED.activity_score,
         usage_score = EXCLUDED.usage_score,
         payment_score = EXCLUDED.payment_score,
         adoption_score = EXCLUDED.adoption_score,
         risk_level = EXCLUDED.risk_level,
         last_login = EXCLUDED.last_login,
         calculated_at = NOW()`,
      [JSON.stringify(scores)]
    );
  }

  return { updated: scores.length };
}

module.exports = { calcularScore, recalculateAll, CREDITO_CONTA };
