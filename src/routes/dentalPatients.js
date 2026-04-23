// ============================================================
// AURA. — Dental Patients CRUD (D-UNIFY)
//
// Pacientes odonto agora sao customers com is_patient=true.
// Mesma entidade do CRM — usuario nao navega entre duas telas.
//
// Rotas:
//   GET    /patients            lista pacientes
//   GET    /patients/:pid       detalhe do paciente
//   POST   /patients            cria paciente (requer lgpd_consent=true)
//   PATCH  /patients/:pid       atualiza paciente
//
// Shape de resposta preserva os campos historicos (full_name, cpf)
// via alias para retrocompat com o frontend ate a migracao do FE.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { listPatients } = require('../services/dental');

// Converte registro customers -> shape paciente odonto
function patientShape(c) {
  if (!c) return null;
  return {
    id:              c.id,
    full_name:       c.name,
    name:            c.name,
    birth_date:      c.birth_date,
    cpf:             c.cpf_cnpj,
    cpf_cnpj:        c.cpf_cnpj,
    phone:           c.phone,
    email:           c.email,
    gender:          c.gender,
    allergies:       c.allergies,
    medical_history: c.medical_history,
    medications:     c.medications,
    notes:           c.notes,
    insurance_name:  c.insurance_name,
    insurance_card:  c.insurance_card,
    insurance_plan:  c.insurance_plan,
    insurance_exp:   c.insurance_exp,
    lgpd_consent:    c.lgpd_consent,
    lgpd_consent_at: c.lgpd_consent_at,
    is_active:       c.is_active,
    is_patient:      c.is_patient,
    created_at:      c.created_at,
    updated_at:      c.updated_at,
  };
}

// ── GET /patients ──
router.get('/patients', requireAuth, async (req, res) => {
  try {
    const { search, page, limit } = req.query;
    const patients = await listPatients(req.params.id, {
      search,
      page: parseInt(page) || undefined,
      limit: parseInt(limit) || undefined,
    });
    res.json({ total: patients.length, patients });
  } catch (err) {
    console.error('[dentalPatients GET /patients]', err.message);
    res.status(500).json({ error: 'Erro ao buscar pacientes' });
  }
});

// ── GET /patients/:pid ──
router.get('/patients/:pid', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM customers
       WHERE id = $1 AND company_id = $2 AND is_patient = true`,
      [req.params.pid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Paciente nao encontrado' });
    res.json({ patient: patientShape(rows[0]) });
  } catch (err) {
    console.error('[dentalPatients GET /patients/:pid]', err.message);
    res.status(500).json({ error: 'Erro ao buscar paciente' });
  }
});

// ── POST /patients ──
// Aceita cadastro novo OU converte customer existente em paciente (is_patient=true)
router.post('/patients', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const {
    // nome aceita full_name (legado) ou name
    full_name, name,
    birth_date, cpf, cpf_cnpj, phone, email, gender,
    allergies, medical_history, medications, notes,
    insurance_name, insurance_card, insurance_plan, insurance_exp,
    lgpd_consent = false,
    existing_customer_id, // opcional: converter cliente existente em paciente
  } = req.body;

  const finalName = (full_name || name || '').trim();
  const finalCpf  = cpf_cnpj || cpf || null;

  if (!finalName) return res.status(400).json({ error: 'Nome e obrigatorio' });
  if (!lgpd_consent) {
    return res.status(400).json({
      error: 'Consentimento LGPD Art.11 e obrigatorio para dados de saude',
    });
  }

  try {
    // Caso 1: converter customer existente em paciente
    if (existing_customer_id) {
      const { rows } = await db.query(
        `UPDATE customers SET
           is_patient      = true,
           lgpd_consent    = true,
           lgpd_consent_at = COALESCE(lgpd_consent_at, NOW()),
           birth_date      = COALESCE(birth_date, $1),
           cpf_cnpj        = COALESCE(cpf_cnpj, $2),
           phone           = COALESCE(phone, $3),
           email           = COALESCE(email, $4),
           gender          = COALESCE(gender, $5),
           allergies       = COALESCE($6, allergies),
           medical_history = COALESCE($7, medical_history),
           medications     = COALESCE($8, medications),
           insurance_name  = COALESCE($9, insurance_name),
           insurance_card  = COALESCE($10, insurance_card),
           insurance_plan  = COALESCE($11, insurance_plan),
           insurance_exp   = COALESCE($12, insurance_exp),
           notes           = COALESCE($13, notes),
           updated_at      = NOW()
         WHERE id = $14 AND company_id = $15
         RETURNING *`,
        [
          birth_date||null, finalCpf, phone||null, email||null, gender||null,
          allergies||null, medical_history||null, medications||null,
          insurance_name||null, insurance_card||null, insurance_plan||null, insurance_exp||null,
          notes||null, existing_customer_id, req.params.id,
        ]
      );
      if (!rows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
      return res.status(201).json({ patient: patientShape(rows[0]) });
    }

    // Caso 2: cadastro novo
    const { rows } = await db.query(
      `INSERT INTO customers (
         company_id, name, birth_date, cpf_cnpj, phone, email, gender,
         allergies, medical_history, medications, notes,
         insurance_name, insurance_card, insurance_plan, insurance_exp,
         is_patient, lgpd_consent, lgpd_consent_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11,
         $12, $13, $14, $15,
         true, true, NOW()
       ) RETURNING *`,
      [
        req.params.id, finalName, birth_date||null, finalCpf, phone||null, email||null, gender||null,
        allergies||null, medical_history||null, medications||null, notes||null,
        insurance_name||null, insurance_card||null, insurance_plan||null, insurance_exp||null,
      ]
    );
    res.status(201).json({ patient: patientShape(rows[0]) });
  } catch (err) {
    console.error('[dentalPatients POST /patients]', err.message);
    res.status(500).json({ error: 'Erro ao cadastrar paciente' });
  }
});

// ── PATCH /patients/:pid ──
router.patch('/patients/:pid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  // Mapeia campos de entrada -> colunas de customers
  const fieldMap = {
    full_name:       'name',
    name:            'name',
    birth_date:      'birth_date',
    cpf:             'cpf_cnpj',
    cpf_cnpj:        'cpf_cnpj',
    phone:           'phone',
    email:           'email',
    gender:          'gender',
    allergies:       'allergies',
    medical_history: 'medical_history',
    medications:     'medications',
    notes:           'notes',
    insurance_name:  'insurance_name',
    insurance_card:  'insurance_card',
    insurance_plan:  'insurance_plan',
    insurance_exp:   'insurance_exp',
  };

  const fields = [], values = [];
  let idx = 1;
  const seen = new Set();

  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[bodyKey] !== undefined && !seen.has(dbCol)) {
      fields.push(`${dbCol} = $${idx++}`);
      values.push(req.body[bodyKey]);
      seen.add(dbCol);
    }
  }

  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  fields.push('updated_at = NOW()');
  values.push(req.params.pid, req.params.id);

  try {
    const { rows } = await db.query(
      `UPDATE customers SET ${fields.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx} AND is_patient = true
       RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Paciente nao encontrado' });
    res.json({ patient: patientShape(rows[0]) });
  } catch (err) {
    console.error('[dentalPatients PATCH /patients/:pid]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar paciente' });
  }
});

module.exports = router;
