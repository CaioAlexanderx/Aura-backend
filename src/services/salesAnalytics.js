// ============================================================
// AURA. — Servico de Analytics de Vendas (BE-01)
// FIX: summary + series leem de transactions (income) para refletir
//      Financeiro completo (PDV + lancamentos manuais do Financeiro).
//      Timezone: AT TIME ZONE 'America/Sao_Paulo' em todas as
//      comparacoes de datas — corrige drift UTC-3 no servidor Railway.
// FIX 2: resolvePeriod agora usa calculo UTC-3 direto em vez de
//      toLocaleDateString('en-CA', {timeZone}) que depende de ICU.
//      Railway pode nao ter ICU completo, retornando formatos errados.
// ============================================================

const db = require('../config/database');

// Calcula data SP sem depender de ICU/locale
// Brazil (SP) = UTC-3 sempre (sem horario de verao desde 2019)
function todaySP() {
  var d = new Date(Date.now() - 3 * 3600000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function addDaysSP(dateStr, n) {
  var parts = dateStr.split('-');
  var y = parseInt(parts[0]), m = parseInt(parts[1]) - 1, day = parseInt(parts[2]);
  var dt = new Date(Date.UTC(y, m, day + n));
  return dt.toISOString().slice(0, 10);
}

async function getSalesAnalytics(companyId, options = {}) {
  const { period = 'month', group_by = 'day', start_date, end_date } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);

  const [summary, series, top_products, top_employees, by_payment] = await Promise.all([
    getSummary(companyId, startDate, endDate),
    getTimeSeries(companyId, startDate, endDate, group_by),
    getTopProducts(companyId, startDate, endDate),
    getTopEmployees(companyId, startDate, endDate),
    getByPaymentMethod(companyId, startDate, endDate),
  ]);

  return {
    period: { start: startDate, end: endDate, label: period },
    summary,
    series,
    top_products,
    top_employees,
    by_payment,
  };
}

/**
 * Resumo do periodo:
 * - Receita total: le de transactions (type='income') para refletir
 *   todos os lancamentos do Financeiro, nao so PDV.
 * - Contagem de vendas PDV: le de sales (cada venda no caixa = 1).
 * - Ticket medio: receita / vendas PDV (fallback: receita / total tx).
 */
async function getSummary(companyId, startDate, endDate) {
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  const [txRes, salesRes] = await Promise.all([
    db.query(`
      SELECT
        COALESCE(SUM(amount), 0)                                        AS total_revenue,
        COALESCE(AVG(amount), 0)                                        AS avg_per_tx,
        COUNT(*)::int                                                   AS total_tx,
        COUNT(DISTINCT (created_at ${SP})::date)::int                  AS active_days
      FROM transactions
      WHERE company_id = $1
        AND type = 'income'
        AND status != 'cancelled'
        AND (created_at ${SP}) >= $2::timestamp
        AND (created_at ${SP}) <  $3::timestamp
    `, [companyId, startDate, endDate]),

    db.query(`
      SELECT
        COUNT(*)::int                     AS total_sales,
        COALESCE(SUM(discount_amount), 0) AS total_discounts,
        COUNT(DISTINCT customer_id)::int  AS unique_customers
      FROM sales
      WHERE company_id = $1
        AND (created_at ${SP}) >= $2::timestamp
        AND (created_at ${SP}) <  $3::timestamp
    `, [companyId, startDate, endDate]),
  ]);

  const tx = txRes.rows[0];
  const sl = salesRes.rows[0];
  const totalRevenue = parseFloat(tx.total_revenue);
  const totalSales   = sl.total_sales;

  const avgTicket = totalSales > 0
    ? parseFloat((totalRevenue / totalSales).toFixed(2))
    : parseFloat(parseFloat(tx.avg_per_tx).toFixed(2));

  return {
    total_sales:      totalSales,
    total_revenue:    totalRevenue,
    avg_ticket:       avgTicket,
    total_discounts:  parseFloat(sl.total_discounts),
    unique_customers: sl.unique_customers,
    active_days:      tx.active_days,
  };
}

/**
 * Serie temporal — receita agrupada por dia/semana/mes via transactions.
 * Reflete todos os lancamentos de receita (PDV + manual).
 */
async function getTimeSeries(companyId, startDate, endDate, groupBy) {
  const SP  = `AT TIME ZONE 'America/Sao_Paulo'`;
  const spCol = `(created_at ${SP})`;

  const formats = {
    day:   `${spCol}::date`,
    week:  `DATE_TRUNC('week',  ${spCol})`,
    month: `DATE_TRUNC('month', ${spCol})`,
  };

  const groupExpr = formats[groupBy] || formats.day;

  const { rows } = await db.query(`
    SELECT
      ${groupExpr}             AS period,
      COUNT(*)::int            AS total_sales,
      COALESCE(SUM(amount), 0) AS total_revenue
    FROM transactions
    WHERE company_id = $1
      AND type = 'income'
      AND status != 'cancelled'
      AND ${spCol} >= $2::timestamp
      AND ${spCol} <  $3::timestamp
    GROUP BY 1
    ORDER BY 1
  `, [companyId, startDate, endDate]);

  return rows.map(r => ({
    period:        r.period,
    total_sales:   r.total_sales,
    total_revenue: parseFloat(r.total_revenue),
  }));
}

/**
 * Top 10 produtos mais vendidos — mantem leitura de sales/sale_items
 * (unico lugar com granularidade por item).
 */
async function getTopProducts(companyId, startDate, endDate) {
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  const { rows } = await db.query(`
    SELECT
      p.id,
      p.name,
      p.category,
      SUM(si.quantity)::float              AS total_qty,
      COALESCE(SUM(si.total_price), 0)     AS total_revenue,
      COUNT(DISTINCT s.id)::int            AS appearances
    FROM sale_items si
    JOIN sales    s ON s.id  = si.sale_id
    JOIN products p ON p.id  = si.product_id
    WHERE s.company_id = $1
      AND (s.created_at ${SP}) >= $2::timestamp
      AND (s.created_at ${SP}) <  $3::timestamp
    GROUP BY p.id, p.name, p.category
    ORDER BY total_revenue DESC
    LIMIT 10
  `, [companyId, startDate, endDate]);

  return rows.map(r => ({
    id:            r.id,
    name:          r.name,
    category:      r.category,
    total_qty:     parseFloat(r.total_qty),
    total_revenue: parseFloat(r.total_revenue),
    appearances:   r.appearances,
  }));
}

/**
 * Ranking de funcionarios por vendas no periodo — mantem leitura de sales.
 */
async function getTopEmployees(companyId, startDate, endDate) {
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  const { rows } = await db.query(`
    SELECT
      u.id,
      u.full_name,
      COUNT(s.id)::int                    AS total_sales,
      COALESCE(SUM(s.total_amount), 0)    AS total_revenue,
      COALESCE(AVG(s.total_amount), 0)    AS avg_ticket
    FROM sales s
    JOIN users u ON u.id = s.seller_id
    WHERE s.company_id = $1
      AND (s.created_at ${SP}) >= $2::timestamp
      AND (s.created_at ${SP}) <  $3::timestamp
      AND s.seller_id IS NOT NULL
    GROUP BY u.id, u.full_name
    ORDER BY total_revenue DESC
    LIMIT 10
  `, [companyId, startDate, endDate]);

  return rows.map(r => ({
    id:            r.id,
    full_name:     r.full_name,
    total_sales:   r.total_sales,
    total_revenue: parseFloat(r.total_revenue),
    avg_ticket:    parseFloat(parseFloat(r.avg_ticket).toFixed(2)),
  }));
}

/**
 * Vendas por metodo de pagamento — mantem leitura de sales.
 */
async function getByPaymentMethod(companyId, startDate, endDate) {
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  const { rows } = await db.query(`
    SELECT
      COALESCE(payment_method, 'nao informado') AS method,
      COUNT(*)::int                              AS total_sales,
      COALESCE(SUM(total_amount), 0)             AS total_revenue
    FROM sales
    WHERE company_id = $1
      AND (created_at ${SP}) >= $2::timestamp
      AND (created_at ${SP}) <  $3::timestamp
    GROUP BY payment_method
    ORDER BY total_revenue DESC
  `, [companyId, startDate, endDate]);

  return rows.map(r => ({
    method:        r.method,
    total_sales:   r.total_sales,
    total_revenue: parseFloat(r.total_revenue),
  }));
}

/**
 * Resolve periodo para datas de inicio e fim em horario de Brasilia.
 *
 * FIX: Usa calculo UTC-3 direto + toISOString().slice(0,10) em vez de
 * toLocaleDateString('en-CA', {timeZone}) que depende de ICU completo.
 * Railway Node.js pode nao ter ICU, fazendo toLocaleDateString retornar
 * formatos nao-ISO (ex: "4/16/2026" em vez de "2026-04-16"), quebrando
 * o split('-') no addDays e gerando "Invalid Date" no SQL → endpoint 500.
 */
function resolvePeriod(period, start_date, end_date) {
  var today = todaySP();
  var parts = today.split('-');
  var y = parseInt(parts[0]);
  var m = parseInt(parts[1]);

  var tomorrow     = addDaysSP(today, 1);
  var yesterday    = addDaysSP(today, -1);
  var weekStart    = addDaysSP(today, -6);
  var firstOfMonth = y + '-' + String(m).padStart(2, '0') + '-01';
  var firstOfYear  = y + '-01-01';

  var periods = {
    today:     { startDate: today,        endDate: tomorrow    },
    yesterday: { startDate: yesterday,    endDate: today       },
    week:      { startDate: weekStart,    endDate: tomorrow    },
    month:     { startDate: firstOfMonth, endDate: tomorrow    },
    year:      { startDate: firstOfYear,  endDate: tomorrow    },
    custom: {
      startDate: start_date || firstOfMonth,
      endDate:   end_date   ? addDaysSP(end_date, 1) : tomorrow,
    },
  };

  return periods[period] || periods.month;
}

module.exports = {
  getSalesAnalytics,
  getSummary,
  getTimeSeries,
  getTopProducts,
  getTopEmployees,
  getByPaymentMethod,
  resolvePeriod,
};
