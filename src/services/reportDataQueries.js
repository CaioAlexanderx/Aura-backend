// ========================================================================
// AURA. — Report Data Queries
// Queries auxiliares exclusivas para o sistema de relatorios
// automaticos (semanal / mensal).
//
// Convencao de datas:
//   resolvePeriodForReport retorna { startDate, endDate } onde
//   endDate e INCLUSIVO (ultimo dia do periodo = sabado).
//   reportGenerator.js usa cursor <= endDate no loop de dias e
//   passa end_date = endDate direto para getSalesAnalytics (que
//   adiciona +1 internamente — trata como inclusivo).
//
// Todas as datas em BRT (UTC-3 manual, sem ICU — Railway).
// ========================================================================

'use strict';

const db = require('../config/database');

// ------------------------------------------------------------------------
// Helpers BRT
// ------------------------------------------------------------------------

function todaySP() {
  var d = new Date(Date.now() - 3 * 3600000);
  return d.toISOString().slice(0, 10);
}

function addDaysSP(dateStr, n) {
  var parts = dateStr.split('-');
  var y = parseInt(parts[0]), m = parseInt(parts[1]) - 1, day = parseInt(parts[2]);
  var dt = new Date(Date.UTC(y, m, day + n));
  return dt.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------------
// 1. resolvePeriodForReport(type)
// Retorna { startDate, endDate } em 'YYYY-MM-DD' (BRT)
//   'weekly': seg-sab da semana mais recente concluida (domingo excluido)
//             endDate = ultimo SABADO (inclusivo)
//
// Formula para 'weekly':
//   utcDay: 0=dom, 1=seg, ..., 6=sab (getUTCDay padrao)
//   daysSinceSat = (utcDay + 1) % 7   → 0 se hoje=sab, 1 se dom, 2 se seg...
//   endDate   = hoje - daysSinceSat    → ultimo sabado (inclusivo)
//   startDate = endDate - 5            → segunda daquela semana
//
//   Verificacao:
//     dom(0): daysSinceSat=1 → end=ontem(sab), start=end-5 ✓
//     seg(1): daysSinceSat=2 → end=ante-ontem(sab), start=end-5 ✓
//     ter(2): daysSinceSat=3 → end=sab passado, start=end-5 ✓
//     sab(6): daysSinceSat=0 → end=hoje(sab), start=end-5 ✓
//
//   Exemplo com hoje = dom 10/05/2026:
//     daysSinceSat = 1
//     endDate   = 09/05 (sab) ✓
//     startDate = 04/05 (seg) ✓
// ------------------------------------------------------------------------

function resolvePeriodForReport(type) {
  if (type === 'weekly') {
    var today = todaySP();
    var utcDay = new Date(today + 'T00:00:00Z').getUTCDay(); // 0=dom, 1=seg, ..., 6=sab
    var daysSinceSat = (utcDay + 1) % 7; // 0 se hoje=sab, 1 se dom, 2 se seg...
    var endDate   = addDaysSP(today, -daysSinceSat); // ultimo sabado (inclusivo)
    var startDate = addDaysSP(endDate, -5);           // segunda daquela semana
    return { startDate, endDate };
  }

  if (type === 'monthly') {
    var todayStr = todaySP();
    var parts = todayStr.split('-');
    var year = parseInt(parts[0]);
    var month = parseInt(parts[1]);
    var prevYear = month === 1 ? year - 1 : year;
    var prevMonth = month === 1 ? 12 : month - 1;
    var prevMonthStart = prevYear + '-' + String(prevMonth).padStart(2, '0') + '-01';
    var lastDay = new Date(Date.UTC(year, month - 1, 0));
    var endDate = prevYear + '-' + String(prevMonth).padStart(2, '0') + '-' + String(lastDay.getUTCDate()).padStart(2, '0');
    return { startDate: prevMonthStart, endDate };
  }

  throw new Error('resolvePeriodForReport: type desconhecido "' + type + '"');
}

// ------------------------------------------------------------------------
// 2. fetchStaleProducts(companyId, days = 14)
// Retorna ate 3 produtos em estoque sem venda nos ultimos `days` dias
// Nota: coluna de estoque = stock_qty
// ------------------------------------------------------------------------

async function fetchStaleProducts(companyId, days = 14) {
  const sql = `
  SELECT
    p.id, p.name, p.category, p.stock_qty,
    MAX(s.created_at AT TIME ZONE 'America/Sao_Paulo') AS last_sale_at,
    EXTRACT(DAY FROM NOW() - MAX(s.created_at))::int AS days_idle
  FROM products p
  LEFT JOIN sale_items si ON si.product_id = p.id
  LEFT JOIN sales s ON s.id = si.sale_id
    AND COALESCE(s.status, 'completed') != 'cancelled'
  WHERE p.company_id = $1
    AND p.stock_qty > 0
    AND p.is_active = true
  GROUP BY p.id, p.name, p.category, p.stock_qty
  HAVING MAX(s.created_at) < NOW() - ($2 || ' days')::INTERVAL
      OR MAX(s.created_at) IS NULL
  ORDER BY days_idle DESC NULLS FIRST
  LIMIT 3
  `;
  const result = await db.query(sql, [companyId, String(days)]);
  return result.rows;
}

// ------------------------------------------------------------------------
// 3. fetchDormantCustomers(companyId)
// Retorna { count, topDormant[] } — clientes sumidos ha mais de 30 dias
// Nota: coluna = name (nao full_name)
// ------------------------------------------------------------------------

async function fetchDormantCustomers(companyId) {
  const countSql = `
    SELECT COUNT(*)::int AS dormant_count
    FROM customers
    WHERE company_id = $1
      AND last_purchase_at < NOW() - INTERVAL '30 days'
      AND last_purchase_at IS NOT NULL
  `;
  const topSql = `
  SELECT
    id, name, total_spent, last_purchase_at,
    EXTRACT(DAY FROM NOW() - last_purchase_at)::int AS days_dormant
  FROM customers
  WHERE company_id = $1
    AND last_purchase_at < NOW() - INTERVAL '30 days'
    AND last_purchase_at IS NOT NULL
  ORDER BY total_spent DESC NULLS LAST
  LIMIT 3
  `;

  const [countRes, topRes] = await Promise.all([
    db.query(countSql, [companyId]),
    db.query(topSql, [companyId]),
  ]);

  return {
    count: countRes.rows[0].dormant_count,
    topDormant: topRes.rows,
  };
}

// ------------------------------------------------------------------------
// 4. fetchHealthHistory(companyId)
// ------------------------------------------------------------------------

async function fetchHealthHistory(companyId) {
  const sql = `
    SELECT
      period, score, label,
      driver_margem, driver_runway, driver_crescimento, driver_ticket
    FROM company_health_snapshots
    WHERE company_id = $1
    ORDER BY period DESC
    LIMIT 6
  `;
  const result = await db.query(sql, [companyId]);
  return result.rows;
}

// ------------------------------------------------------------------------
// 5. fetchSalesHeatmap(companyId, startDate, endDateInclusive)
// Retorna linhas { dow, hour, sale_count, revenue } para o periodo
// dow: 1=seg, 2=ter, ..., 6=sab (domingo=0 excluido)
// ------------------------------------------------------------------------

async function fetchSalesHeatmap(companyId, startDate, endDateInclusive) {
  var parts = endDateInclusive.split('-');
  var y = parseInt(parts[0]), m = parseInt(parts[1]) - 1, d = parseInt(parts[2]);
  var endExclusive = new Date(Date.UTC(y, m, d + 1)).toISOString().slice(0, 10);

  const sql = `
    SELECT
      EXTRACT(DOW FROM created_at AT TIME ZONE 'America/Sao_Paulo')::int AS dow,
      EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Sao_Paulo')::int AS hour,
      COUNT(*)::int AS sale_count,
      COALESCE(SUM(total_amount), 0) AS revenue
    FROM sales
    WHERE company_id = $1
      AND COALESCE(status, 'completed') != 'cancelled'
      AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= $2::timestamp
      AND (created_at AT TIME ZONE 'America/Sao_Paulo') <  $3::timestamp
      AND EXTRACT(DOW FROM created_at AT TIME ZONE 'America/Sao_Paulo') != 0
    GROUP BY dow, hour
    ORDER BY dow, hour
  `;
  const result = await db.query(sql, [companyId, startDate, endExclusive]);
  return result.rows;
}

// ------------------------------------------------------------------------
// 6. saveHealthSnapshot(companyId, score, label, period, drivers)
// ------------------------------------------------------------------------

async function saveHealthSnapshot(companyId, score, label, period, drivers = {}) {
  if (!period) {
    var todayStr = todaySP();
    var parts = todayStr.split('-');
    period = parts[0] + '-' + parts[1] + '-01';
  }

  const {
    driver_margem = null,
    driver_runway = null,
    driver_crescimento = null,
    driver_ticket = null,
  } = drivers;

  const sql = `
    INSERT INTO company_health_snapshots
      (company_id, period, score, label, driver_margem, driver_runway, driver_crescimento, driver_ticket)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (company_id, period) DO UPDATE
      SET
        score              = EXCLUDED.score,
        label              = EXCLUDED.label,
        driver_margem      = EXCLUDED.driver_margem,
        driver_runway      = EXCLUDED.driver_runway,
        driver_crescimento = EXCLUDED.driver_crescimento,
        driver_ticket      = EXCLUDED.driver_ticket
  `;

  await db.query(sql, [
    companyId, period, score, label,
    driver_margem, driver_runway, driver_crescimento, driver_ticket,
  ]);
}

// ------------------------------------------------------------------------

module.exports = {
  resolvePeriodForReport,
  fetchStaleProducts,
  fetchDormantCustomers,
  fetchHealthHistory,
  fetchSalesHeatmap,
  saveHealthSnapshot,
};
