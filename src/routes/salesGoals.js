// ============================================================
// AURA. — Sales Goals & Tracking
// CRUD de metas por vendedor + acompanhamento real vs meta
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// GET /goals — list goals for a reference_month (default: current)
router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { month } = req.query; // YYYY-MM
  const refMonth = month ? `${month}-01` : new Date().toISOString().slice(0, 7) + '-01';
  try {
    const { rows } = await db.query(
      `SELECT g.*, e.name AS employee_name, e.commission_rate,
         e.commission_enabled
       FROM employee_goals g
       JOIN employees e ON e.id = g.employee_id
       WHERE g.company_id = $1 AND g.reference_month = $2
       ORDER BY g.goal_amount DESC`, [cid, refMonth]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao listar metas' }); }
});

// GET /goals/tracking — goals vs actual performance
router.get('/tracking', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { month } = req.query;
  const refMonth = month ? `${month}-01` : new Date().toISOString().slice(0, 7) + '-01';
  const monthStart = refMonth;
  const monthEnd = new Date(new Date(refMonth).setMonth(new Date(refMonth).getMonth() + 1)).toISOString().slice(0, 10);

  try {
    // Goals
    const { rows: goals } = await db.query(
      `SELECT g.*, e.name AS employee_name, e.commission_rate, e.commission_enabled
       FROM employee_goals g
       JOIN employees e ON e.id = g.employee_id
       WHERE g.company_id = $1 AND g.reference_month = $2`, [cid, refMonth]);

    // Actual sales (UNION sales table + transactions with employee)
    const { rows: actual } = await db.query(
      `SELECT name, SUM(total_sales)::int AS vendas, SUM(total_revenue) AS faturamento
       FROM (
         SELECT COALESCE(e.name,'Sem vendedor') AS name, COUNT(s.id) AS total_sales, COALESCE(SUM(s.total_amount),0) AS total_revenue
         FROM sales s LEFT JOIN employees e ON e.id = s.employee_id
         WHERE s.company_id=$1 AND s.created_at >= $2 AND s.created_at < $3
         GROUP BY e.name
         UNION ALL
         SELECT COALESCE(t.employee_name,'Sem vendedor') AS name, COUNT(t.id), COALESCE(SUM(t.amount),0)
         FROM transactions t
         WHERE t.company_id=$1 AND t.type='income' AND t.employee_name IS NOT NULL
           AND t.created_at >= $2 AND t.created_at < $3
         GROUP BY t.employee_name
       ) combined GROUP BY name`, [cid, monthStart, monthEnd]);

    // Days info for projection
    const now = new Date();
    const monthDate = new Date(refMonth);
    const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
    const isCurrentMonth = now.getMonth() === monthDate.getMonth() && now.getFullYear() === monthDate.getFullYear();
    const dayOfMonth = isCurrentMonth ? now.getDate() : daysInMonth;

    // Merge goals with actual
    const tracking = goals.map(g => {
      const act = actual.find(a => a.name === g.employee_name) || { vendas: 0, faturamento: 0 };
      const faturamento = parseFloat(act.faturamento) || 0;
      const vendas = parseInt(act.vendas) || 0;
      const goalAmt = parseFloat(g.goal_amount) || 0;
      const goalUnits = parseInt(g.goal_units) || 0;
      const pctRevenue = goalAmt > 0 ? Math.round(faturamento / goalAmt * 100) : 0;
      const pctUnits = goalUnits > 0 ? Math.round(vendas / goalUnits * 100) : 0;

      // Project end-of-month
      const dailyRate = dayOfMonth > 0 ? faturamento / dayOfMonth : 0;
      const projected = Math.round(dailyRate * daysInMonth);
      const onTrack = projected >= goalAmt;

      // Commission
      const commRate = parseFloat(g.commission_rate) || 0;
      const commission = g.commission_enabled ? Math.round(faturamento * commRate / 100 * 100) / 100 : 0;

      return {
        employee_id: g.employee_id,
        employee_name: g.employee_name,
        goal_amount: goalAmt,
        goal_units: goalUnits,
        actual_revenue: faturamento,
        actual_units: vendas,
        pct_revenue: pctRevenue,
        pct_units: pctUnits,
        projected_revenue: projected,
        on_track: onTrack,
        remaining: Math.max(goalAmt - faturamento, 0),
        commission_rate: commRate,
        commission_amount: commission,
        days_remaining: daysInMonth - dayOfMonth,
        ticket_medio: vendas > 0 ? Math.round(faturamento / vendas * 100) / 100 : 0,
      };
    });

    // Team totals
    const teamRevenue = tracking.reduce((s, t) => s + t.actual_revenue, 0);
    const teamGoal = tracking.reduce((s, t) => s + t.goal_amount, 0);
    const teamCommission = tracking.reduce((s, t) => s + t.commission_amount, 0);

    res.json({
      month: refMonth,
      days_in_month: daysInMonth,
      day_of_month: dayOfMonth,
      is_current_month: isCurrentMonth,
      employees: tracking,
      team: {
        total_revenue: teamRevenue,
        total_goal: teamGoal,
        pct: teamGoal > 0 ? Math.round(teamRevenue / teamGoal * 100) : 0,
        total_commission: teamCommission,
      },
    });
  } catch (err) { console.error('goals tracking error:', err); res.status(500).json({ error: 'Erro ao carregar tracking' }); }
});

// POST /goals — create/update goal
router.post('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { employee_id, reference_month, goal_amount, goal_units, goal_type = 'revenue' } = req.body;
  if (!employee_id || !reference_month || !goal_amount) return res.status(400).json({ error: 'employee_id, reference_month e goal_amount obrigatorios' });
  const refDate = reference_month.length === 7 ? `${reference_month}-01` : reference_month;
  try {
    const { rows } = await db.query(
      `INSERT INTO employee_goals (company_id, employee_id, reference_month, goal_amount, goal_units, goal_type)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, employee_id, reference_month)
       DO UPDATE SET goal_amount = EXCLUDED.goal_amount, goal_units = EXCLUDED.goal_units,
         goal_type = EXCLUDED.goal_type, updated_at = NOW()
       RETURNING *`, [cid, employee_id, refDate, goal_amount, goal_units || null, goal_type]);
    res.status(201).json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao salvar meta' }); }
});

// POST /goals/batch — set goals for multiple employees at once
router.post('/batch', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { goals, reference_month } = req.body;
  if (!goals || !Array.isArray(goals) || !reference_month) return res.status(400).json({ error: 'goals[] e reference_month obrigatorios' });
  const refDate = reference_month.length === 7 ? `${reference_month}-01` : reference_month;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const g of goals) {
      const { rows } = await client.query(
        `INSERT INTO employee_goals (company_id, employee_id, reference_month, goal_amount, goal_units, goal_type)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (company_id, employee_id, reference_month)
         DO UPDATE SET goal_amount = EXCLUDED.goal_amount, goal_units = EXCLUDED.goal_units, updated_at = NOW()
         RETURNING *`,
        [cid, g.employee_id, refDate, g.goal_amount, g.goal_units || null, g.goal_type || 'revenue']);
      results.push(rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ saved: results.length, goals: results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Erro ao salvar metas' });
  } finally { client.release(); }
});

// DELETE /goals/:gid
router.delete('/:gid', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM employee_goals WHERE id=$1 AND company_id=$2', [req.params.gid, req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao remover meta' }); }
});

// POST /goals/calculate-commissions — calculate and store commission for a month
router.post('/calculate-commissions', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { reference_month } = req.body;
  if (!reference_month) return res.status(400).json({ error: 'reference_month obrigatorio' });
  const refDate = reference_month.length === 7 ? `${reference_month}-01` : reference_month;
  const monthEnd = new Date(new Date(refDate).setMonth(new Date(refDate).getMonth() + 1)).toISOString().slice(0, 10);

  try {
    // Get employees with commission enabled
    const { rows: employees } = await db.query(
      `SELECT id, name, commission_rate FROM employees
       WHERE company_id=$1 AND commission_enabled=TRUE AND is_active=TRUE`, [cid]);

    const results = [];
    for (const emp of employees) {
      // Get actual sales
      const { rows: sales } = await db.query(
        `SELECT COUNT(*)::int AS vendas, COALESCE(SUM(amount),0) AS faturamento
         FROM transactions
         WHERE company_id=$1 AND type='income' AND employee_name=$2
           AND created_at >= $3 AND created_at < $4`,
        [cid, emp.name, refDate, monthEnd]);

      const vendas = parseInt(sales[0]?.vendas) || 0;
      const faturamento = parseFloat(sales[0]?.faturamento) || 0;
      const rate = parseFloat(emp.commission_rate) || 0;
      const commission = Math.round(faturamento * rate / 100 * 100) / 100;

      // Get goal
      const { rows: goalRows } = await db.query(
        `SELECT goal_amount FROM employee_goals
         WHERE company_id=$1 AND employee_id=$2 AND reference_month=$3`,
        [cid, emp.id, refDate]);
      const goalAmt = parseFloat(goalRows[0]?.goal_amount) || 0;
      const achieved = goalAmt > 0 && faturamento >= goalAmt;

      // Upsert commission ledger
      const { rows: ledger } = await db.query(
        `INSERT INTO commission_ledger (company_id,employee_id,reference_month,total_sales,total_revenue,commission_rate,commission_amount,goal_amount,goal_achieved,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
         ON CONFLICT (company_id,employee_id,reference_month)
         DO UPDATE SET total_sales=EXCLUDED.total_sales, total_revenue=EXCLUDED.total_revenue,
           commission_amount=EXCLUDED.commission_amount, goal_amount=EXCLUDED.goal_amount,
           goal_achieved=EXCLUDED.goal_achieved, updated_at=NOW()
         RETURNING *`,
        [cid, emp.id, refDate, vendas, faturamento, rate, commission, goalAmt, achieved]);

      results.push({ ...ledger[0], employee_name: emp.name });
    }

    res.json({
      month: refDate,
      employees: results,
      total_commission: results.reduce((s, r) => s + parseFloat(r.commission_amount), 0),
      total_revenue: results.reduce((s, r) => s + parseFloat(r.total_revenue), 0),
    });
  } catch (err) { console.error('commission calc error:', err); res.status(500).json({ error: 'Erro ao calcular comissoes' }); }
});

// GET /goals/commissions — list commission ledger
router.get('/commissions', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { month } = req.query;
  const refDate = month ? (month.length === 7 ? `${month}-01` : month) : new Date().toISOString().slice(0, 7) + '-01';
  try {
    const { rows } = await db.query(
      `SELECT cl.*, e.name AS employee_name
       FROM commission_ledger cl
       JOIN employees e ON e.id = cl.employee_id
       WHERE cl.company_id=$1 AND cl.reference_month=$2
       ORDER BY cl.commission_amount DESC`, [cid, refDate]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao listar comissoes' }); }
});

module.exports = router;
