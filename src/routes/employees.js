// ============================================================
// AURA. -- Employees CRUD
// GET/POST/PATCH/DELETE /companies/:id/employees
//
// 12/05/2026 -- PLAN-02: CRUD basico movido pro Essencial.
// Mudancas:
//   - cpf e admission_date sao OPCIONAIS no POST (pra Essencial cadastrar
//     so nome+cargo). Quando preenchidos, validados normalmente.
//   - base_salary salva 0 quando ausente (campo agora nullable no schema).
//   - getPlanLimit() conta ativos do owner inteiro:
//       essencial = 3
//       negocio   = 50
//       expansao/personalizado = ilimitado
//   - 403 no POST quando atinge limite retorna body { error, limit, current }
//     pra FE montar mensagem contextual de upgrade.
//
// Folha de pagamento real (salario, holerite, comissao, eSocial) continua
// Negocio+ via mounts em private.js. Esta rota e apenas CRUD da pessoa.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');

function getPlanLimit(plan) {
  switch ((plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 999999;
    case 'negocio':       return 50;
    default:              return 3; // essencial / trial / unknown
  }
}

// GET / -- list employees
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const includeInactive = req.query.include_inactive === 'true';
  const planLimit = getPlanLimit(req.user?.plan);
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
    res.json({ total: employees.length, employees, plan_limit: planLimit });
  } catch (err) {
    console.error('[employees] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar funcionarios' });
  }
});

// POST / -- create employee
//
// PLAN-02 (12/05/2026): cpf e admission_date agora OPCIONAIS. Quando
// preenchidos, validados. Pre-check de duplicata so dispara quando CPF
// existe (constraint UNIQUE virou partial: WHERE cpf IS NOT NULL).
//
// Plan limit conta funcionarios ATIVOS do owner inteiro (todas as
// empresas do dono), igual customers. Permite Essencial=3 distribuir
// entre suas lojas se tiver Multi-CNPJ.
//
// Soft-deleted (is_active=false) com mesmo CPF reativa em vez de erro.
// Funcionarios sem CPF nao tem essa logica de reativacao -- novo cadastro
// sempre cria registro novo (sem chave natural pra detectar).
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { name, role, salary, admission_date, cpf, pis, phone, email, work_hours, status } = req.body;

  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nome e obrigatorio' });

  // Plan limit: conta ativos do owner inteiro.
  try {
    const planLimit = getPlanLimit(req.user?.plan);
    if (planLimit < 999999) {
      const ownerCompanyIds = await getOwnerScopedCompanyIds(cid);
      if (ownerCompanyIds.length > 0) {
        const { rows: cntRows } = await db.query(
          'SELECT COUNT(*)::int AS total FROM employees WHERE company_id = ANY($1) AND is_active = true',
          [ownerCompanyIds]
        );
        const current = cntRows[0]?.total || 0;
        if (current >= planLimit) {
          return res.status(403).json({
            error: `Limite de funcionarios atingido para o seu plano (${planLimit} ativos). Faca upgrade para continuar.`,
            limit: planLimit, current,
          });
        }
      }
    }
  } catch (err) {
    console.error('[employees] count check error:', err.message);
    // Nao bloqueia se a checagem falhar -- prefere salvar a perder dado.
  }

  const salaryVal = parseFloat(salary) || 0;
  const cpfRaw = cpf ? String(cpf).replace(/\D/g, '') : null;
  const cpfClean = cpfRaw && cpfRaw.length > 0 ? cpfRaw : null;
  const roleVal = role || 'Colaborador';
  const pisVal = pis || null;
  const admDateVal = admission_date || null;

  // Quando CPF foi fornecido, valida 11 digitos.
  if (cpfClean !== null && cpfClean.length !== 11) {
    return res.status(400).json({ error: 'CPF deve ter 11 digitos quando preenchido' });
  }

  try {
    // Detecta soft-deleted com mesmo CPF SO quando CPF foi fornecido
    // (sem CPF, nao da pra dedupar -- novo cadastro cria registro novo).
    if (cpfClean) {
      const { rows: existing } = await db.query(
        'SELECT id, name, is_active FROM employees WHERE company_id=$1 AND cpf=$2',
        [cid, cpfClean]
      );

      if (existing.length) {
        const old = existing[0];
        if (old.is_active) {
          return res.status(409).json({ error: 'Funcionario com este CPF ja cadastrado' });
        }
        // Reativa com novos dados.
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
            String(name).trim(),         // $1
            roleVal,                     // $2
            roleVal,                     // $3
            salaryVal,                   // $4
            salaryVal,                   // $5
            admDateVal,                  // $6
            pisVal,                      // $7
            pisVal,                      // $8
            phone || null,               // $9
            email || null,               // $10
            parseInt(work_hours) || 220, // $11
            status || 'active',          // $12
            old.id,                      // $13
            cid,                         // $14
          ]
        );
        return res.status(200).json({ ...reactivated[0], reactivated: true, previous_name: old.name });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO employees
         (company_id, name, role, role_title, salary, base_salary, admission_date,
          cpf, pis, pis_pasep, phone, email, work_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        cid,                        // $1
        String(name).trim(),        // $2
        roleVal,                    // $3
        roleVal,                    // $4
        salaryVal,                  // $5
        salaryVal,                  // $6
        admDateVal,                 // $7
        cpfClean,                   // $8 -- pode ser NULL agora
        pisVal,                     // $9
        pisVal,                     // $10
        phone || null,              // $11
        email || null,              // $12
        parseInt(work_hours) || 220,// $13
        status || 'active',         // $14
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
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

// PATCH /:eid -- update employee
router.patch('/:eid', async (req, res) => {
  const { id: cid, eid } = req.params;
  const updates = [], values = [];
  let idx = 1;

  // Build dynamic SET clause -- sync dual columns with separate params
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
  // CPF: aceita string vazia (limpar) ou string com digitos.
  addField('cpf', 'cpf', v => {
    if (v === null || v === '' || v === undefined) return null;
    const digits = String(v).replace(/\D/g, '');
    return digits.length === 0 ? null : digits;
  });
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

// DELETE /:eid -- soft delete
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
