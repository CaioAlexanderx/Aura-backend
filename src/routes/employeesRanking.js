// ============================================================
// AURA. — Ranking de Funcionários + Link PDV (BE-02 + BE-REV-04)
// GET /companies/:id/employees/ranking
// FIX: excludes cancelled sales, timezone SP, unassigned sales
//
// 12/05/2026 (Fase B troca cross-filial — PR Aura-backend#69):
//   - PURE SALES (type='sale') agrupados por employee_id como antes.
//     Filtro novo `COALESCE(s.type,'sale')='sale'` evita inflar com
//     newValue de trocas (memória armadilha_trocas_inflam_agregados).
//   - TROCAS atendidas creditam `netAmount` (= total_amount −
//     returnedValue) ao `COALESCE(exchange_employee_id, employee_id)`:
//       · cross-filial: exchange_employee_id = vendedor que atendeu
//       · same-filial:  employee_id (sem exchange_*, mantém comportamento)
//   - Subquery de trocas **NÃO** filtra company_id (cross-filial vive
//     em outra filial fiscalmente, mas o atendente é desta).
//     Filtro principal de `employees e` por company_id já garante que
//     só pessoas desta filial entram no ranking.
//   - `returnedValue` vem da soma de `troca_returned_items` (migration 101).
//   - Vendas "sem vendedor" continuam ignorando trocas (type='sale' only).
//   - NOTE: o crédito do vendedor original NÃO é debitado quando a troca
//     acontece (mantém comportamento atual). Refinamento futuro: descontar
//     returnedValue do original_employee via JOIN com exchange_of_sale_id.
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db = require('../config/database');

const VALID_PERIODS = ['week', 'month', 'year', 'custom'];
const CANCEL_FILTER = "AND COALESCE(s.status,'completed') != 'cancelled'";

function resolvePeriod(period, startDate, endDate) {
  const now = new Date();
  switch (period) {
    case 'week': {
      const spNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const start = new Date(spNow);
      start.setDate(spNow.getDate() - spNow.getDay());
      start.setHours(0,0,0,0);
      const startUTC = new Date(start.getTime() + 3 * 3600000);
      const endUTC = new Date(startUTC.getTime() + 7 * 86400000);
      return { startDate: startUTC.toISOString(), endDate: endUTC.toISOString() };
    }
    case 'year': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 3, 0, 0));
      const end = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1, 3, 0, 0));
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
    case 'custom':
      return { startDate: new Date(startDate).toISOString(), endDate: new Date(endDate).toISOString() };
    default: {
      const spNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const start = new Date(Date.UTC(spNow.getFullYear(), spNow.getMonth(), 1, 3, 0, 0));
      const end = new Date(Date.UTC(spNow.getFullYear(), spNow.getMonth() + 1, 1, 3, 0, 0));
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
  }
}

// Detecta se as colunas exchange_* da migration 111 já existem.
// Cache module-level (60s) — padrão armadilha_schema_pre_migration.
let _exchangeColsCheckedAt = 0;
let _exchangeColsAvailable = null;
async function hasExchangeCols() {
  const now = Date.now();
  if (_exchangeColsAvailable !== null && (now - _exchangeColsCheckedAt) < 60000) {
    return _exchangeColsAvailable;
  }
  try {
    const r = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_name='sales'
          AND column_name IN ('exchange_seller_id','exchange_employee_id')`
    );
    _exchangeColsAvailable = parseInt(r.rows[0]?.n || '0', 10) === 2;
  } catch (e) {
    console.warn('[employeesRanking] hasExchangeCols probe falhou:', e.message);
    _exchangeColsAvailable = false;
  }
  _exchangeColsCheckedAt = now;
  return _exchangeColsAvailable;
}

router.get('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { period = 'month', start_date, end_date } = req.query;

    if (!VALID_PERIODS.includes(period)) {
      return res.status(400).json({ error: `period inválido. Use: ${VALID_PERIODS.join(', ')}` });
    }
    if (period === 'custom' && (!start_date || !end_date)) {
      return res.status(400).json({ error: 'Para period=custom, informe start_date e end_date' });
    }

    const { startDate, endDate } = resolvePeriod(period, start_date, end_date);

    // Migration 111 status — controla se contamos trocas cross-filial via
    // exchange_employee_id. Se ainda não aplicou, caímos em fallback que
    // só conta same-filial via employee_id.
    const exchColsOk = await hasExchangeCols();

    // Resolução do "troca employee" — quem atendeu a troca:
    //   - migration 111 aplicada → COALESCE(exchange_employee_id, employee_id)
    //   - sem migration         → employee_id (same-filial only, comportamento legado)
    const trocaEmployeeExpr = exchColsOk
      ? "COALESCE(s.exchange_employee_id, s.employee_id)"
      : "s.employee_id";

    // 1. Employees com vendas + trocas vinculadas (exclui canceladas)
    //
    // pure: SUM/COUNT de vendas type='sale' (filtro novo). Garante que
    // total_amount inflado de trocas (=newValue) não conta aqui.
    //
    // troca: SUM(netAmount) onde netAmount = s.total_amount − returnedValue.
    // returnedValue vem de troca_returned_items (sum quantity*unit_price).
    // Não filtra por s.company_id — em cross-filial, troca vive em outra
    // filial mas o exchange_employee_id é desta. Filtro principal de
    // `employees e` por company_id já garante o escopo correto.
    //
    // prev: período anterior pra cálculo de trend_pct. Mantém regra pure
    // (só vendas, sem trocas) — comparação justa entre períodos.
    const { rows: employees } = await db.query(`
      SELECT
        e.id,
        e.name AS full_name,
        COALESCE(e.role, e.role_title, 'Vendedor') AS job_role,
        COALESCE(pure.total_sales, 0) + COALESCE(troca.troca_count, 0) AS total_sales,
        COALESCE(pure.total_revenue, 0) + COALESCE(troca.troca_revenue, 0) AS total_revenue,
        COALESCE(pure.total_sales, 0) AS pure_sales,
        COALESCE(pure.total_revenue, 0) AS pure_revenue,
        COALESCE(troca.troca_count, 0) AS troca_count,
        COALESCE(troca.troca_revenue, 0) AS troca_revenue,
        CASE
          WHEN (COALESCE(pure.total_sales, 0) + COALESCE(troca.troca_count, 0)) > 0
          THEN ROUND(
            (COALESCE(pure.total_revenue, 0) + COALESCE(troca.troca_revenue, 0))
            / (COALESCE(pure.total_sales, 0) + COALESCE(troca.troca_count, 0)),
            2
          )
          ELSE 0
        END AS avg_ticket,
        COALESCE(prev.prev_revenue, 0) AS prev_revenue
      FROM employees e
      LEFT JOIN LATERAL (
        SELECT
          COUNT(s.id) AS total_sales,
          COALESCE(SUM(s.total_amount), 0) AS total_revenue
        FROM sales s
        WHERE s.company_id = $1
          AND s.employee_id = e.id
          AND COALESCE(s.type,'sale') = 'sale'
          AND s.created_at >= $2
          AND s.created_at < $3
          ${CANCEL_FILTER}
      ) pure ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(s.id) AS troca_count,
          COALESCE(SUM(
            s.total_amount - COALESCE((
              SELECT SUM(tri.quantity * tri.unit_price)
              FROM troca_returned_items tri
              WHERE tri.troca_sale_id = s.id
            ), 0)
          ), 0) AS troca_revenue
        FROM sales s
        WHERE s.type = 'troca'
          AND ${trocaEmployeeExpr} = e.id
          AND s.created_at >= $2
          AND s.created_at < $3
          ${CANCEL_FILTER}
      ) troca ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(s2.total_amount), 0) AS prev_revenue
        FROM sales s2
        WHERE s2.company_id = $1
          AND s2.employee_id = e.id
          AND COALESCE(s2.type,'sale') = 'sale'
          AND s2.created_at >= ($2::timestamptz - ($3::timestamptz - $2::timestamptz))
          AND s2.created_at < $2
          AND COALESCE(s2.status,'completed') != 'cancelled'
      ) prev ON true
      WHERE e.company_id = $1 AND e.is_active = true
      ORDER BY (COALESCE(pure.total_revenue, 0) + COALESCE(troca.troca_revenue, 0)) DESC NULLS LAST
    `, [companyId, startDate, endDate]);

    // 2. Vendas SEM employee_id (orfas, exclui canceladas + exclui trocas
    //    — trocas sem vendedor não fazem sentido prático)
    const { rows: unassignedRows } = await db.query(`
      SELECT
        COUNT(s.id) AS total_sales,
        COALESCE(SUM(s.total_amount), 0) AS total_revenue
      FROM sales s
      WHERE s.company_id = $1
        AND s.employee_id IS NULL
        AND COALESCE(s.type,'sale') = 'sale'
        AND s.created_at >= $2
        AND s.created_at < $3
        ${CANCEL_FILTER}
    `, [companyId, startDate, endDate]);
    const unassigned = unassignedRows[0] || { total_sales: 0, total_revenue: 0 };
    const unassignedSales = parseInt(unassigned.total_sales) || 0;
    const unassignedRevenue = parseFloat(unassigned.total_revenue) || 0;

    // 3. Total geral
    const employeeTotalRevenue = employees.reduce((s, e) => s + parseFloat(e.total_revenue), 0);
    const totalRevenue = employeeTotalRevenue + unassignedRevenue;
    const employeeTotalSales = employees.reduce((s, e) => s + (parseInt(e.total_sales) || 0), 0);
    const totalSales = employeeTotalSales + unassignedSales;

    // 4. Montar ranking
    const ranking = employees.map((emp, index) => {
      const revenue = parseFloat(emp.total_revenue) || 0;
      const prevRevenue = parseFloat(emp.prev_revenue) || 0;
      const trend = prevRevenue > 0
        ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100)
        : (revenue > 0 ? 100 : 0);

      return {
        position: index + 1,
        id: emp.id,
        full_name: emp.full_name,
        job_role: emp.job_role,
        total_sales: parseInt(emp.total_sales) || 0,
        total_revenue: revenue,
        avg_ticket: parseFloat(emp.avg_ticket) || 0,
        trend_pct: trend,
        share_pct: totalRevenue > 0
          ? parseFloat(((revenue / totalRevenue) * 100).toFixed(1))
          : 0,
        is_top: index === 0,
        medal: index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : null,
        // Detalhamento Fase B — UI pode usar pra mostrar split em tooltips/drawer.
        // pure_sales/pure_revenue: vendas próprias.
        // troca_count/troca_revenue: trocas atendidas (netAmount).
        pure_sales: parseInt(emp.pure_sales) || 0,
        pure_revenue: parseFloat(emp.pure_revenue) || 0,
        troca_count: parseInt(emp.troca_count) || 0,
        troca_revenue: parseFloat(emp.troca_revenue) || 0,
      };
    });

    res.json({
      period: { start: startDate, end: endDate, label: period },
      total_revenue: totalRevenue,
      total_sales: totalSales,
      total_employees: ranking.length,
      ranking,
      unassigned: unassignedSales > 0 ? {
        total_sales: unassignedSales,
        total_revenue: unassignedRevenue,
        avg_ticket: unassignedSales > 0 ? Math.round((unassignedRevenue / unassignedSales) * 100) / 100 : 0,
        share_pct: totalRevenue > 0 ? parseFloat(((unassignedRevenue / totalRevenue) * 100).toFixed(1)) : 0,
      } : null,
      employee_of_month: ranking[0] || null,
    });

  } catch (err) {
    console.error('Erro em GET /employees/ranking:', err.message);
    res.status(500).json({ error: 'Erro ao buscar ranking de funcionários' });
  }
});

module.exports = router;
