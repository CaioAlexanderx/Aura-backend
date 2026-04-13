// ============================================================
// AURA. -- Employees CRUD (fixed column mapping)
// GET/POST/PATCH/DELETE /companies/:id/employees
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

// GET / — list employees
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const includeInactive = req.query.include_inactive === 'true';
  try {
    const where = includeInactive
      ? 'WHERE company_id = $1'
      : 'WHERE company_id = $1 AND is_active = true';
    const { rows } = await db.query(
      `SELECT id, name, role, role_title, salary, base_salary, admission_date,
              cpf, pis, pis_pasep, status, phone, email, work_hours,
              commission_enabled, commission_rate, user_id, is_active,
              total_sales, total_revenue, created_at, updated_at
       FROM employees ${where}
       ORDER BY name ASC`,
      [cid]
    );
    const employees = rows.map(r => ({
      id: r.id,
      name: r.name || '',
      role: r.role || r.role_title || '',
      salary: parseFloat(r.salary || r.base_salary) || 0,
      admDate: r.admission_date ? new Date(r.admission_date).toLocaleDateString('pt-BR') : '',
      admission_date: r.admission_date,
      cpf: r.cpf || '',
      pis: r.pis || r.pis_pasep || '',
      status: r.status || (r.is_active ? 'active' : 'dismissed'),
      phone: r.phone || '',
      email: r.email || '',
      work_hours: parseInt(r.work_hours) || 220,
      commission_enabled: r.commission_enabled || false,
      commission_rate: parseFloat(r.commission_rate) || 0,
      total_sales: parseInt(r.total_sales) || 0,
      total_revenue: parseFloat(r.total_revenue) || 0,
      user_id: r.user_id,
      is_active: r.is_active !== false,
      created_at: r.created_at,
    }));
    res.json({ total: employees.length, employees });
  } catch (err) {
    console.error('[employees] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar funcionarios' });
  }
});

// POST / — create employee
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { name, role, salary, admission_date, cpf, pis, phone, email, work_hours, status } = req.body;

  // Validations
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nome e obrigatorio' });
  if (!cpf || !String(cpf).trim()) return res.status(400).json({ error: 'CPF e obrigatorio' });
  if (!admission_date) return res.status(400).json({ error: 'Data de admissao e obrigatoria (formato: YYYY-MM-DD)' });

  const salaryVal = parseFloat(salary) || 0;
  const cpfClean = String(cpf).replace(/\D/g, '');

  if (cpfClean.length !== 11) return res.status(400).json({ error: 'CPF deve ter 11 digitos' });

  try {
    // Check duplicate CPF in same company
    const { rows: existing } = await db.query(
      'SELECT id FROM employees WHERE company_id=$1 AND cpf=$2 AND is_active=true',
      [cid, cpfClean]
    );
    if (existing.length) return res.status(409).json({ error: 'Funcionario com este CPF ja cadastrado' });

    const { rows } = await db.query(
      `INSERT INTO employees
         (company_id, name, role, role_title, salary, base_salary, admission_date,
          cpf, pis, pis_pasep, phone, email, work_hours, status)
       VALUES ($1,$2,$3,$3,$4,$4,$5,$6,$7,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        cid, String(name).trim(), role || null,
        salaryVal, admission_date,
        cpfClean, pis || null, phone || null, email || null,
        parseInt(work_hours) || 220, status || 'active',
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[employees] create error:', err.message);
    res.status(500).json({ error: 'Erro ao cadastrar funcionario: ' + err.message });
  }
});

// PATCH /:eid — update employee
router.patch('/:eid', async (req, res) => {
  const { id: cid, eid } = req.params;
  const allowedFields = {
    name: 'name', role: 'role', salary: 'salary',
    admission_date: 'admission_date', cpf: 'cpf', pis: 'pis',
    phone: 'phone', email: 'email', work_hours: 'work_hours',
    status: 'status', is_active: 'is_active',
    commission_enabled: 'commission_enabled', commission_rate: 'commission_rate',
  };
  const numFields = ['salary', 'work_hours', 'commission_rate'];
  const updates = [], values = [];
  let idx = 1;
  for (const [bodyKey, dbCol] of Object.entries(allowedFields)) {
    if (req.body[bodyKey] !== undefined) {
      updates.push(`${dbCol} = $${idx}`);
      const val = numFields.includes(dbCol) ? parseFloat(req.body[bodyKey]) : req.body[bodyKey];
      values.push(val);
      // Sync dual columns
      if (dbCol === 'salary') { updates.push(`base_salary = $${idx}`); }
      if (dbCol === 'role') { updates.push(`role_title = $${idx}`); }
      if (dbCol === 'pis') { updates.push(`pis_pasep = $${idx}`); }
      idx++;
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()');
  values.push(eid, cid);
  try {
    const { rows } = await db.query(
      `UPDATE employees SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Funcionario nao encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[employees] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar funcionario' });
  }
});

// DELETE /:eid — soft delete
router.delete('/:eid', async (req, res) => {
  const { id: cid, eid } = req.params;
  try {
    const { rows } = await db.query(
      `UPDATE employees SET is_active = false, status = 'dismissed', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 RETURNING id, name`,
      [eid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Funcionario nao encontrado' });
    res.json({ deleted: true, id: eid, name: rows[0].name });
  } catch (err) {
    console.error('[employees] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover funcionario' });
  }
});

module.exports = router;
