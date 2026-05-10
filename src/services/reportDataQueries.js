// ========================================================================
// AURA. — Report Data Queries
// Queries auxiliares exclusivas para o sistema de relatorios
// automaticos (semanal / mensal).
//
// Todas as datas em BRT (UTC-3 manual, sem ICU — Railway).
// ========================================================================

'use strict';

const db = require('../config/database');

// ------------------------------------------------------------------------
// Helpers BRT (replicado de salesAnalytics.js - UTC-3 manual sem ICU)
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
//   'weekly': seg-dom da semana passada
//   'monthly': mes anterior completo
// ------------------------------------------------------------------------

function resolvePeriodForReport(type) {
  if (type === 'weekly') {
    var today = todaySP();
    var utcDay = new Date(today + 'T00:00:00Z').getUTCDay();
    var dayOfWeek = (utcDay + 6) % 7; // 0=Mon, 6=Sun
    var daysToLastMonday = dayOfWeek + 7;
    var startDate = addDaysSP(today, -daysToLastMonday);
    var endDate = addDaysSP(today, -dayOfWeek);
    return { startDate, endDate };
  }

  if (type === 'monthly') {
    var todayStr = todaySP();
    var parts = todayStr.split('-');
    var year = parseInt(parts[0]);
    var month = parseInt(parts[1]);
    var currentMonthStart = year + '-' + String(month).padStart(2, '0') + '-01';
    var prevYear = month === 1 ? year - 1 : year;
    var prevMonth = month === 1 ? 12 : month - 1;
    var prevMonthStart = prevYear + '-' + String(prevMonth).padStart(2, '0') + '-01';
    return { startDate: prevMonthStart, endDate: currentMonthStart };
  }

  throw new Error(`resolvePeriodForReport: type desconhecido "${type}"`);
}

// ------------------------------------------------------------------------
// 2. fetchStaleProducts(companyId, days = 14)
// Retorna ate 3 produtos em estoque sem venda nos ultimos `days` dias
// Nota: coluna de estoque e stock_qty (nao stock_quantity)
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
// Retorna { count, topDormant[] } - clientes sumidos ha mais de 30 dias
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
    id, full_name, total_spent, last_purchase_at,
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
// Retorna ultimos 6 snapshots de company_health_snapshots
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
// 5. saveHealthSnapshot(companyId, score, label, period, drivers)
// Upsert em company_health_snapshots (period = 1o dia do mes atual)
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
  saveHealthSnapshot,
};
