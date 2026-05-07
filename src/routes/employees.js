// ============================================================
// AURA. -- Employees CRUD (fixed parameter types)
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
//
// FIX 06/05/2026: a constraint UNIQUE (company_id, cpf) nao filtra por
// is_active, entao um funcionario soft-deleted (DELETE faz is_active=false)
// ainda bloqueia recadastro com mesmo CPF. O pre-check antes filtrava
// is_active=true e deixava passar -> INSERT explodia em 500 com mensagem
// crua do Postgres. Agora detecta inativo e reativa em vez de erro.
//
// FIX 06/05/2026 (v2): UPDATE de reativacao reusava params em colunas de
// tipos diferentes (role varchar + role_title text com mesmo $2; etc),
// disparando "inconsistent types deduced for parameter $2". Cada coluna
// agora ganha seu proprio param (mesma estrategia do INSERT).
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { name, role, salary, admission_date, cpf, pis, phone, email, work_hours, status } = req.body;

  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nome e obrigatorio' });
  if (!cpf || !String(cpf).trim()) return res.status(400).json({ error: 'CPF e obrigatorio' });
  if (!admission_date) return res.status(400).json({ error: 'Data de admissao e obrigatoria (formato: YYYY-MM-DD)' });

  const salaryVal = parseFloat(salary) || 0;
  const cpfClean = String(cpf).replace(/\D/g, '');
  const roleVal = role || 'Colaborador';
  const pisVal = pis || null;

  if (cpfClean.length !== 11) return res.status(400).json({ error: 'CPF deve ter 11 digitos' });

  try {
    // Inclui inativos pra detectar soft-deleted com mesmo CPF.
    const { rows: existing } = await db.query(
      'SELECT id, name, is_active FROM employees WHERE company_id=$1 AND cpf=$2',
      [cid, cpfClean]
    );

    if (existing.length) {
      const old = existing[0];
      if (old.is_active) {
        return res.status(409).json({ error: 'Funcionario com este CPF ja cadastrado' });
      }
      // Inativo (soft-deleted): reativa com os novos dados em vez de erro.
      // Mantem o id pra preservar historico (sales_count, total_revenue, etc).
      //
      // IMPORTANTE: cada coluna recebe seu PROPRIO parametro (sem reuso) pra
      // evitar "inconsistent types deduced for parameter $X" — o pg driver
      // falha em inferir o tipo quando o mesmo $N alimenta colunas de tipos
      // distintos (varchar vs text vs numeric). Mesma logica do INSERT abaixo.
      const { rows: reactivated } = await db.query(
        `UPDATE employees SET
           name           = $1,
           role           = $2,
           role_title     = $3,
           salary         = $4,
           base_salary    = $5,
           admission_date = $6,
           pis            = $7,
           pis_pasep      = $8,
           phone          = $9,
           email          = $10,
           work_hours     = $11,
           status         = $12,
           is_active      = true,
           updated_at     = NOW()
         WHERE id = $13 AND company_id = $14
         RETURNING *`,
        [
          String(name).trim(),         // $1  -> name (text)
          roleVal,                     // $2  -> role (varchar)
          roleVal,                     // $3  -> role_title (text)
          salaryVal,                   // $4  -> salary (numeric nullable)
          salaryVal,                   // $5  -> base_salary (numeric NOT NULL)
          admission_date,              // $6  -> admission_date (date)
          pisVal,                      // $7  -> pis (text)
          pisVal,                      // $8  -> pis_pasep (text)
          phone || null,               // $9  -> phone (varchar)
          email || null,               // $10 -> email (varchar)
          parseInt(work_hours) || 220, // $11 -> work_hours (integer)
          status || 'active',          // $12 -> status (varchar)
          old.id,                      // $13 -> id (uuid)
          cid,                         // $14 -> company_id (uuid)
        ]
      );
      return res.status(200).json({ ...reactivated[0], reactivated: true, previous_name: old.name });
    }

    // Each column gets its own parameter (no reuse) to avoid type conflicts
    const { rows } = await db.query(
      `INSERT INTO employees
         (company_id, name, role, role_title, salary, base_salary, admission_date,
          cpf, pis, pis_pasep, phone, email, work_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        cid,                        // $1
        String(name).trim(),        // $2
        roleVal,                    // $3 -> role (varchar)
        roleVal,                    // $4 -> role_title (text)
        salaryVal,                  // $5 -> salary (numeric nullable)
        salaryVal,                  // $6 -> base_salary (numeric NOT NULL)
        admission_date,             // $7
        cpfClean,                   // $8
        pisVal,                     // $9  -> pis (text)
        pisVal,                     // $10 -> pis_pasep (text)
        phone || null,              // $11
        email || null,              // $12
        parseInt(work_hours) || 220,// $13
        status || 'active',         // $14
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    // Catch defensivo: se constraint UNIQUE escapou do pre-check (race
    // condition entre 2 abas, ou constraint nova adicionada no futuro),
    // converte em 409 amigavel em vez de 500 cru.
    if (err && err.code === '23505') {
      const constraintName = (err.constraint || '').toLowerCase();
      if (constraintName.includes('cpf')) {
        return res.status(409).json({ error: 'Funcionario com este CPF ja cadastrado' });
      }
      return res.status(409).json({ error: 'Registro duplicado: ' + (err.constraint || 'constraint nao identificada') });
    }
    console.error('[employees] create error:', err.message);
    res.status(500).json({ error: 'Erro ao cadastrar funcionario: ' + err.message });
  }
});

// PATCH /:eid — update employee
router.patch('/:eid', async (req, res) => {
  const { id: cid, eid } = req.params;
  const updates = [], values = [];
  let idx = 1;

  // Build dynamic SET clause — sync dual columns with separate params
  function addField(bodyKey, dbCol, transform) {
    if (req.body[bodyKey] === undefined) return;
    const val = transform ? transform(req.body[bodyKey]) : req.body[bodyKey];
    updates.push(`${dbCol} = $${idx}`);
    values.push(val);
    idx++;
    // Sync dual columns with a NEW param index
    if (dbCol === 'salary') { updates.push(`base_salary = $${idx}`); values.push(val); idx++; }
    if (dbCol === 'role') { updates.push(`role_title = $${idx}`); values.push(val); idx++; }
    if (dbCol === 'pis') { updates.push(`pis_pasep = $${idx}`); values.push(val); idx++; }
  }

  addField('name', 'name');
  addField('role', 'role');
  addField('salary', 'salary', v => parseFloat(v));
  addField('admission_date', 'admission_date');
  addField('cpf', 'cpf');
  addField('pis', 'pis');
  addField('phone', 'phone');
  addField('email', 'email');
  addField('work_hours', 'work_hours', v => parseInt(v));
  addField('status', 'status');
  addField('is_active', 'is_active');
  addField('commission_enabled', 'commission_enabled');
  addField('commission_rate', 'commission_rate', v => parseFloat(v));

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
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Conflito: ja existe outro funcionario com esses dados' });
    }
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
