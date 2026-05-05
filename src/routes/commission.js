// BE-19 — Comissão de vendas + BE-20 — Metas por funcionário

const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { calculateEmployeeCommission, getCommissionSummary } = require('../services/commission');

// ── Helpers ────────────────────────────────────────────────

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function parseMonth(str) {
  if (!str) return null;
  if (!/^\d{4}-\d{2}$/.test(str)) return null;
  const [y, m] = str.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  return str;
}

// ── BE-19: Configuração de comissão ───────────────────────

// PATCH /companies/:id/employees/:eid/commission
// Habilita/desabilita comissão e define o percentual
router.patch('/:eid/commission', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, eid: employee_id } = req.params;
  const { commission_enabled, commission_rate } = req.body;

  if (commission_enabled === undefined && commission_rate === undefined) {
    return res.status(400).json({ error: 'Informe commission_enabled e/ou commission_rate' });
  }

  if (commission_rate !== undefined) {
    const rate = parseFloat(commission_rate);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ error: 'commission_rate deve ser entre 0 e 100' });
    }
  }

  try {
    const fields = [];
    const values = [];
    let idx = 1;

    if (commission_enabled !== undefined) {
      fields.push(`commission_enabled = $${idx++}`);
      values.push(Boolean(commission_enabled));
    }
    if (commission_rate !== undefined) {
      fields.push(`commission_rate = $${idx++}`);
      values.push(parseFloat(commission_rate));
    }
    fields.push(`updated_at = NOW()`);
    values.push(company_id, employee_id);

    const result = await pool.query(
      `UPDATE employees SET ${fields.join(', ')}
       WHERE company_id = $${idx++} AND id = $${idx++} AND is_active = true
       RETURNING id, name, commission_enabled, commission_rate`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Funcionário não encontrado' });
    }

    res.json({ employee: result.rows[0] });
  } catch (err) {
    console.error('commission config error:', err);
    res.status(500).json({ error: 'Erro ao atualizar configuração de comissão' });
  }
});

// GET /companies/:id/employees/:eid/commission?month=YYYY-MM
// Comissão de um funcionário em um mês
router.get('/:eid/commission', requireAuth, async (req, res) => {
  const { id: company_id, eid: employee_id } = req.params;
  const month = parseMonth(req.query.month) || currentMonth();

  try {
    const data = await calculateEmployeeCommission(company_id, employee_id, month);
    if (!data) return res.status(404).json({ error: 'Funcionário não encontrado' });
    res.json(data);
  } catch (err) {
    console.error('commission calc error:', err);
    res.status(500).json({ error: 'Erro ao calcular comissão' });
  }
});

// GET /companies/:id/employees/commission/summary?month=YYYY-MM
// Resumo de todos os funcionários no mês
router.get('/commission/summary', requireAuth, async (req, res) => {
  const { id: company_id } = req.params;
  const month = parseMonth(req.query.month) || currentMonth();

  try {
    const data = await getCommissionSummary(company_id, month);
    const total_commission = data.reduce((sum, e) => sum + e.commission_amount, 0);

    res.json({
      reference_month: month,
      employees: data,
      totals: {
        commission_total: Math.round(total_commission * 100) / 100,
        employees_with_commission: data.filter(e => e.commission_enabled).length,
        employees_total: data.length,
      },
    });
  } catch (err) {
    console.error('commission summary error:', err);
    res.status(500).json({ error: 'Erro ao buscar resumo de comissões' });
  }
});

// ── BE-20: Metas por funcionário ──────────────────────────

// GET /companies/:id/employees/:eid/goals?month=YYYY-MM
router.get('/:eid/goals', requireAuth, async (req, res) => {
  const { id: company_id, eid: employee_id } = req.params;
  const month = parseMonth(req.query.month) || currentMonth();
  const [year, m] = month.split('-').map(Number);
  const reference_month = new Date(year, m - 1, 1);

  try {
    // Meta do mês
    const goalResult = await pool.query(
      `SELECT g.id, g.goal_amount, g.reference_month,
              e.name AS employee_name
       FROM employee_goals g
       JOIN employees e ON e.id = g.employee_id
       WHERE g.employee_id = $1 AND g.company_id = $2 AND g.reference_month = $3`,
      [employee_id, company_id, reference_month]
    );

    // Verificar funcionário
    const empResult = await pool.query(
      'SELECT name FROM employees WHERE id = $1 AND company_id = $2',
      [employee_id, company_id]
    );
    if (empResult.rows.length === 0) return res.status(404).json({ error: 'Funcionário não encontrado' });

    const { name } = empResult.rows[0];
    const startDate = reference_month;
    const endDate = new Date(year, m, 1);

    // Vendas do mês usando employee_id (join direto, sem depender de user_id)
    const salesResult = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS total
       FROM sales
       WHERE company_id = $1 AND employee_id = $2 AND created_at >= $3 AND created_at < $4`,
      [company_id, employee_id, startDate, endDate]
    );
    const achieved = parseFloat(salesResult.rows[0].total);

    const goal = goalResult.rows[0] || null;
    const goal_amount = goal ? parseFloat(goal.goal_amount) : null;
    const achievement_pct = goal_amount && goal_amount > 0
      ? Math.round((achieved / goal_amount) * 100)
      : null;

    res.json({
      employee_id,
      employee_name:   name,
      reference_month: month,
      goal_amount,
      achieved,
      achievement_pct,
      goal_id:         goal ? goal.id : null,
      status: !goal_amount ? 'no_goal'
        : achievement_pct >= 100 ? 'achieved'
        : achievement_pct >= 75  ? 'on_track'
        : 'behind',
    });
  } catch (err) {
    console.error('goals get error:', err);
    res.status(500).json({ error: 'Erro ao buscar meta' });
  }
});

// POST /companies/:id/employees/:eid/goals
// Cria ou substitui meta do mês
router.post('/:eid/goals', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, eid: employee_id } = req.params;
  const { month, goal_amount } = req.body;

  const targetMonth = parseMonth(month) || currentMonth();
  const [year, m] = targetMonth.split('-').map(Number);
  const reference_month = new Date(year, m - 1, 1);

  const amount = parseFloat(goal_amount);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'goal_amount deve ser maior que zero' });
  }

  try {
    // Verificar se funcionário pertence à empresa
    const empCheck = await pool.query(
      'SELECT id FROM employees WHERE id = $1 AND company_id = $2 AND is_active = true',
      [employee_id, company_id]
    );
    if (empCheck.rows.length === 0) return res.status(404).json({ error: 'Funcionário não encontrado' });

    // Upsert — atualiza se já existe meta para esse mês
    const result = await pool.query(
      `INSERT INTO employee_goals (company_id, employee_id, reference_month, goal_amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id, reference_month)
       DO UPDATE SET goal_amount = EXCLUDED.goal_amount, updated_at = NOW()
       RETURNING id, employee_id, reference_month, goal_amount`,
      [company_id, employee_id, reference_month, amount]
    );

    res.status(201).json({ goal: result.rows[0] });
  } catch (err) {
    console.error('goals post error:', err);
    res.status(500).json({ error: 'Erro ao salvar meta' });
  }
});

// DELETE /companies/:id/employees/:eid/goals?month=YYYY-MM
router.delete('/:eid/goals', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: company_id, eid: employee_id } = req.params;
  const month = parseMonth(req.query.month) || currentMonth();
  const [year, m] = month.split('-').map(Number);
  const reference_month = new Date(year, m - 1, 1);

  try {
    const result = await pool.query(
      `DELETE FROM employee_goals
       WHERE company_id = $1 AND employee_id = $2 AND reference_month = $3
       RETURNING id`,
      [company_id, employee_id, reference_month]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Meta não encontrada' });
    res.json({ message: 'Meta removida' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover meta' });
  }
});

// GET /companies/:id/employees/goals/summary?month=YYYY-MM
// Resumo de todas as metas + atingimento da empresa
router.get('/goals/summary', requireAuth, async (req, res) => {
  const { id: company_id } = req.params;
  const month = parseMonth(req.query.month) || currentMonth();
  const [year, m] = month.split('-').map(Number);
  const startDate = new Date(year, m - 1, 1);
  const endDate   = new Date(year, m, 1);

  try {
    const result = await pool.query(
      `SELECT
         e.id              AS employee_id,
         e.name            AS employee_name,
         g.goal_amount,
         COALESCE(SUM(s.total_amount), 0) AS achieved
       FROM employees e
       LEFT JOIN employee_goals g
         ON g.employee_id = e.id AND g.reference_month = $2
       LEFT JOIN sales s
         ON s.company_id  = e.company_id
        AND s.employee_id = e.id
        AND s.created_at >= $2
        AND s.created_at <  $3
       WHERE e.company_id = $1 AND e.is_active = true
       GROUP BY e.id, e.name, g.goal_amount
       ORDER BY achieved DESC`,
      [company_id, startDate, endDate]
    );

    const employees = result.rows.map(row => {
      const goal_amount = row.goal_amount ? parseFloat(row.goal_amount) : null;
      const achieved    = parseFloat(row.achieved);
      const pct = goal_amount && goal_amount > 0
        ? Math.round((achieved / goal_amount) * 100) : null;

      return {
        employee_id:     row.employee_id,
        employee_name:   row.employee_name,
        goal_amount,
        achieved,
        achievement_pct: pct,
        status: !goal_amount ? 'no_goal'
          : pct >= 100 ? 'achieved'
          : pct >= 75  ? 'on_track'
          : 'behind',
      };
    });

    res.json({
      reference_month: month,
      employees,
      summary: {
        total_employees:  employees.length,
        with_goal:        employees.filter(e => e.goal_amount).length,
        achieved:         employees.filter(e => e.status === 'achieved').length,
        on_track:         employees.filter(e => e.status === 'on_track').length,
        behind:           employees.filter(e => e.status === 'behind').length,
      },
    });
  } catch (err) {
    console.error('goals summary error:', err);
    res.status(500).json({ error: 'Erro ao buscar resumo de metas' });
  }
});

module.exports = router;
