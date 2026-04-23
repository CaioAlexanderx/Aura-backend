// ============================================================
// AURA. — ODT-DASH: Dashboard agregado Odontologia
// GET /companies/:id/dental/dashboard
//
// Retorna KPIs do modulo odonto em UM request:
// - consultas_hoje / consultas_semana
// - faturamento_mes (concluido) + estimativa (agendado)
// - funil (leads por stage + total pipeline)
// - parcelas_vencidas + parcelas_proximas_7d
// - pacientes_recall (sem consulta 150+ dias)
// - repasse_mes (total a repassar)
// - top_procedimentos_mes
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/dashboard', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    // Paralelo — tudo com tratamento de erro individual
    const [
      todayRes, weekRes, monthRes, funnelRes,
      overdueRes, upcomingRes, recallRes, repasseRes, topProcsRes, patientsRes,
    ] = await Promise.all([
      // Consultas hoje (SP timezone + status PT-BR)
      db.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'confirmado')        AS confirmados,
                COUNT(*) FILTER (WHERE status = 'agendado')          AS pendentes,
                COUNT(*) FILTER (WHERE status = 'em_atendimento')    AS em_atendimento,
                COUNT(*) FILTER (WHERE status = 'concluido')         AS concluidos,
                COUNT(*) FILTER (WHERE status = 'faltou')            AS faltas,
                COUNT(*) FILTER (WHERE status = 'cancelado')         AS cancelados
         FROM dental_appointments
         WHERE company_id = $1
           AND (scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date
               = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
        [cid]
      ).catch(() => ({ rows: [{}] })),

      // Consultas semana (7 dias a frente)
      db.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status != 'cancelado') AS ativos
         FROM dental_appointments
         WHERE company_id = $1
           AND scheduled_at >= NOW()
           AND scheduled_at <  NOW() + INTERVAL '7 days'`,
        [cid]
      ).catch(() => ({ rows: [{}] })),

      // Faturamento do mes (concluido vs agendado/futuro)
      db.query(
        `SELECT
           COALESCE(SUM(total) FILTER (WHERE status='concluido'), 0) AS realizado,
           COALESCE(SUM(total) FILTER (WHERE status IN ('agendado','confirmado','em_atendimento','aprovado','avaliacao')), 0) AS previsto
         FROM dental_appointments
         WHERE company_id = $1
           AND (scheduled_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
           AND (scheduled_at AT TIME ZONE 'America/Sao_Paulo') <  date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month'`,
        [cid]
      ).catch(() => ({ rows: [{}] })),

      // Funil (ativos)
      db.query(
        `SELECT stage,
                COUNT(*)::int              AS qtd,
                COALESCE(SUM(treatment_value), 0)::numeric AS valor
         FROM dental_leads
         WHERE company_id = $1
           AND stage NOT IN ('completed','lost')
         GROUP BY stage`,
        [cid]
      ).catch(() => ({ rows: [] })),

      // Parcelas vencidas
      db.query(
        `SELECT COUNT(*)::int AS qtd,
                COALESCE(SUM(i.amount), 0)::numeric AS valor
         FROM dental_treatment_plan_installments i
         JOIN dental_treatment_plans t ON t.id = i.plan_id
         WHERE t.company_id = $1
           AND i.status = 'pending'
           AND i.due_date < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
        [cid]
      ).catch(() => ({ rows: [{}] })),

      // Parcelas vencendo nos proximos 7 dias
      db.query(
        `SELECT COUNT(*)::int AS qtd,
                COALESCE(SUM(i.amount), 0)::numeric AS valor
         FROM dental_treatment_plan_installments i
         JOIN dental_treatment_plans t ON t.id = i.plan_id
         WHERE t.company_id = $1
           AND i.status = 'pending'
           AND i.due_date >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
           AND i.due_date <  (NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '7 days'`,
        [cid]
      ).catch(() => ({ rows: [{}] })),

      // Pacientes recall (D-UNIFY: customers.is_patient=true + LEFT JOIN)
      db.query(
        `WITH last_visits AS (
           SELECT c.id,
                  c.name,
                  c.phone,
                  MAX(a.scheduled_at) FILTER (WHERE a.status = 'concluido') AS last_visit
           FROM customers c
           LEFT JOIN dental_appointments a
             ON a.customer_id = c.id AND a.company_id = c.company_id
           WHERE c.company_id = $1
             AND c.is_patient = true
             AND c.is_active  = true
           GROUP BY c.id, c.name, c.phone
         )
         SELECT COUNT(*)::int AS qtd
         FROM last_visits
         WHERE last_visit < NOW() - INTERVAL '150 days'`,
        [cid]
      ).catch(() => ({ rows: [{}] })),

      // Repasse do mes atual
      db.query(
        `SELECT
           COALESCE(SUM(repasse_amount) FILTER (WHERE status='pending'),   0)::numeric AS a_pagar,
           COALESCE(SUM(repasse_amount) FILTER (WHERE status='paid'),      0)::numeric AS pago,
           COALESCE(SUM(amount),                                           0)::numeric AS bruto
         FROM dental_repasse_ledger
         WHERE company_id = $1
           AND reference_month = TO_CHAR(NOW() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM')`,
        [cid]
      ).catch(() => ({ rows: [{}] })),

      // Top procedimentos do mes
      db.query(
        `SELECT ap.procedure_name AS nome,
                COUNT(*)::int                  AS qtd,
                COALESCE(SUM(ap.price_total), 0)::numeric AS receita
         FROM dental_appointment_procedures ap
         JOIN dental_appointments a ON a.id = ap.appointment_id
         WHERE a.company_id = $1
           AND a.status = 'concluido'
           AND (a.scheduled_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
         GROUP BY ap.procedure_name
         ORDER BY receita DESC
         LIMIT 5`,
        [cid]
      ).catch(() => ({ rows: [] })),

      // Total pacientes ativos
      db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')))::int AS novos_mes
         FROM customers
         WHERE company_id = $1
           AND is_patient = true
           AND is_active  = true`,
        [cid]
      ).catch(() => ({ rows: [{}] })),
    ]);

    const today = todayRes.rows[0] || {};
    const week  = weekRes.rows[0]  || {};
    const month = monthRes.rows[0] || {};
    const overdue  = overdueRes.rows[0]  || {};
    const upcoming = upcomingRes.rows[0] || {};
    const recall   = recallRes.rows[0]   || {};
    const repasse  = repasseRes.rows[0]  || {};
    const patients = patientsRes.rows[0] || {};

    // Funil: estrutura ordenada com stages vazios preenchidos
    const stages = ['lead','contacted','evaluation_scheduled','evaluation_done','budget_sent','budget_approved','in_treatment'];
    const funnelMap = {};
    for (const r of funnelRes.rows) funnelMap[r.stage] = { qtd: parseInt(r.qtd), valor: parseFloat(r.valor) };
    const funil = stages.map(s => ({
      stage: s,
      qtd:   funnelMap[s]?.qtd   || 0,
      valor: funnelMap[s]?.valor || 0,
    }));
    const pipeline_total = funil.reduce((s, r) => s + r.valor, 0);

    res.json({
      consultas_hoje: {
        total:          parseInt(today.total)          || 0,
        confirmados:    parseInt(today.confirmados)    || 0,
        pendentes:      parseInt(today.pendentes)      || 0,
        em_atendimento: parseInt(today.em_atendimento) || 0,
        concluidos:     parseInt(today.concluidos)     || 0,
        faltas:         parseInt(today.faltas)         || 0,
        cancelados:     parseInt(today.cancelados)     || 0,
      },
      consultas_semana: {
        total:  parseInt(week.total)  || 0,
        ativos: parseInt(week.ativos) || 0,
      },
      faturamento_mes: {
        realizado: parseFloat(month.realizado) || 0,
        previsto:  parseFloat(month.previsto)  || 0,
      },
      funil,
      pipeline_total,
      parcelas_vencidas: {
        qtd:   parseInt(overdue.qtd)     || 0,
        valor: parseFloat(overdue.valor) || 0,
      },
      parcelas_proximas_7d: {
        qtd:   parseInt(upcoming.qtd)     || 0,
        valor: parseFloat(upcoming.valor) || 0,
      },
      pacientes_recall: parseInt(recall.qtd) || 0,
      repasse_mes: {
        a_pagar: parseFloat(repasse.a_pagar) || 0,
        pago:    parseFloat(repasse.pago)    || 0,
        bruto:   parseFloat(repasse.bruto)   || 0,
      },
      top_procedimentos_mes: topProcsRes.rows.map(r => ({
        nome:    r.nome,
        qtd:     parseInt(r.qtd),
        receita: parseFloat(r.receita),
      })),
      pacientes: {
        total:     parseInt(patients.total)     || 0,
        novos_mes: parseInt(patients.novos_mes) || 0,
      },
    });
  } catch (err) {
    console.error('[dentalDashboard]', err.message);
    res.status(500).json({ error: 'Erro ao carregar dashboard odonto' });
  }
});

module.exports = router;
