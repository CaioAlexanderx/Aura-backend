// ============================================================
// AURA. — W2-02 F5: Rotas TISS 4.01 completas
//
// Substitui (gradualmente) dentalInsurance.js legado.
// Endpoints organizados em 5 grupos:
//
//   1. Catalogo de convenios globais (read-only, company_id NULL)
//      GET    /companies/:cid/dental/tiss/catalog
//      POST   /companies/:cid/dental/tiss/catalog/:gid/clone
//
//   2. Convenios da clinica (CRUD)
//      GET    /companies/:cid/dental/tiss/insurance
//      POST   /companies/:cid/dental/tiss/insurance
//      PATCH  /companies/:cid/dental/tiss/insurance/:iid
//      DELETE /companies/:cid/dental/tiss/insurance/:iid
//
//   3. Carteirinhas dos pacientes
//      GET    /companies/:cid/dental/tiss/patients/:pid/cards
//      POST   /companies/:cid/dental/tiss/patients/:pid/cards
//      PATCH  /companies/:cid/dental/tiss/cards/:cardId
//      DELETE /companies/:cid/dental/tiss/cards/:cardId
//
//   4. Guias TISS (4 tipos)
//      GET    /companies/:cid/dental/tiss/guides
//      POST   /companies/:cid/dental/tiss/guides
//      GET    /companies/:cid/dental/tiss/guides/:gid
//      PATCH  /companies/:cid/dental/tiss/guides/:gid    (PR13: + paid_value/paid_at)
//      DELETE /companies/:cid/dental/tiss/guides/:gid
//      GET    /companies/:cid/dental/tiss/guides/:gid/xml      (preview)
//
//   5. Lotes de faturamento
//      GET    /companies/:cid/dental/tiss/batches
//      POST   /companies/:cid/dental/tiss/batches              (cria + gera XML)
//      GET    /companies/:cid/dental/tiss/batches/:bid
//      GET    /companies/:cid/dental/tiss/batches/:bid/xml     (download)
//      POST   /companies/:cid/dental/tiss/batches/:bid/return  (parse retorno)
//      DELETE /companies/:cid/dental/tiss/batches/:bid
//
//   6. Tabelas de apoio
//      GET    /companies/:cid/dental/tiss/glosa-codes
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const tissXml = require('../services/tissXml');

const requireWrite = requireRole('client', 'analyst', 'admin');

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

async function getCompanyData(cid) {
  const { rows } = await db.query(
    `SELECT id, legal_name, trade_name, cnpj, address_state, cnes
       FROM companies WHERE id = $1`,
    [cid]
  );
  return rows[0] || null;
}

async function getInsurance(cid, iid) {
  const { rows } = await db.query(
    `SELECT * FROM dental_insurance
      WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)`,
    [iid, cid]
  );
  return rows[0] || null;
}

async function getCustomer(cid, customerId) {
  const { rows } = await db.query(
    `SELECT id, full_name, name, phone, email, cpf, birthday
       FROM customers WHERE id = $1 AND company_id = $2`,
    [customerId, cid]
  );
  return rows[0] || null;
}

async function nextGuideNumber(cid) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int + 1 AS next FROM dental_tiss_guides WHERE company_id = $1`,
    [cid]
  );
  return `GTO-${String(rows[0].next).padStart(8, '0')}`;
}

async function nextBatchNumber(cid, insuranceId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int + 1 AS next FROM dental_tiss_batches
      WHERE company_id = $1 AND insurance_id = $2`,
    [cid, insuranceId]
  );
  return `LOT-${String(rows[0].next).padStart(6, '0')}`;
}

// ============================================================
// 1. CATALOGO DE CONVENIOS GLOBAIS
// ============================================================

// GET /catalog — lista os 5 convenios pre-cadastrados (Bradesco, Amil, ...)
router.get('/catalog', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, razao_social, cnpj, ans_code,
              contact_phone, upload_portal_url, tiss_version,
              payment_deadline_days, notes_billing
         FROM dental_insurance
        WHERE company_id IS NULL AND is_active = true
        ORDER BY name`
    );
    res.json({ catalog: rows });
  } catch (err) {
    console.error('[tiss catalog]', err.message);
    res.status(500).json({ error: 'Erro ao buscar catalogo' });
  }
});

// POST /catalog/:gid/clone — clinica adiciona um global ao seu cadastro
router.post('/catalog/:gid/clone', requireAuth, requireWrite, async (req, res) => {
  const cid = req.params.id;
  const gid = req.params.gid;
  const { provider_code, contract_number, contract_start, default_discount_pct, notes } = req.body || {};

  if (!provider_code) {
    return res.status(400).json({ error: 'provider_code (codigo prestador no convenio) obrigatorio' });
  }

  try {
    const { rows: globalRows } = await db.query(
      `SELECT * FROM dental_insurance WHERE id = $1 AND company_id IS NULL`,
      [gid]
    );
    if (!globalRows[0]) return res.status(404).json({ error: 'Convenio global nao encontrado' });

    const g = globalRows[0];

    // Verifica se ja foi clonado pra esta clinica
    const { rows: existingRows } = await db.query(
      `SELECT id FROM dental_insurance
        WHERE company_id = $1 AND ans_code = $2 AND ans_code IS NOT NULL
        LIMIT 1`,
      [cid, g.ans_code]
    );
    if (existingRows[0]) {
      return res.status(409).json({
        error: 'Este convenio ja esta cadastrado na sua clinica',
        existing_id: existingRows[0].id,
      });
    }

    const { rows } = await db.query(
      `INSERT INTO dental_insurance (
        company_id, name, razao_social, cnpj, ans_code,
        contact_phone, upload_portal_url, tiss_version, reference_table_id,
        payment_deadline_days, provider_code, contract_number, contract_start,
        default_discount_pct, notes, notes_billing, is_active
      ) VALUES ($1,$2,$3,$4,$5, $6,$7,$8,$9, $10,$11,$12,$13, $14,$15,$16, true)
      RETURNING *`,
      [
        cid, g.name, g.razao_social, g.cnpj, g.ans_code,
        g.contact_phone, g.upload_portal_url, g.tiss_version, g.reference_table_id,
        g.payment_deadline_days, provider_code, contract_number || null, contract_start || null,
        default_discount_pct || 0, notes || null, g.notes_billing,
      ]
    );

    res.status(201).json({ insurance: rows[0] });
  } catch (err) {
    console.error('[tiss catalog clone]', err.message);
    res.status(500).json({ error: 'Erro ao adicionar convenio' });
  }
});

// ============================================================
// 2. CONVENIOS DA CLINICA
// ============================================================

router.get('/insurance', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT i.*,
              (SELECT COUNT(*)::int FROM dental_tiss_guides g
                WHERE g.insurance_id = i.id AND g.company_id = i.company_id) AS guides_count
         FROM dental_insurance i
        WHERE i.company_id = $1
        ORDER BY i.is_active DESC, i.name`,
      [req.params.id]
    );
    res.json({ insurance: rows });
  } catch (err) {
    console.error('[tiss insurance list]', err.message);
    res.status(500).json({ error: 'Erro ao buscar convenios' });
  }
});

router.post('/insurance', requireAuth, requireWrite, async (req, res) => {
  const {
    name, razao_social, cnpj, ans_code, registration,
    contact_phone, contact_email, upload_portal_url,
    tiss_version, provider_code, contract_number, contract_start, contract_end,
    default_discount_pct, payment_deadline_days, notes_billing,
  } = req.body || {};

  if (!name) return res.status(400).json({ error: 'name obrigatorio' });
  if (!provider_code) return res.status(400).json({ error: 'provider_code obrigatorio' });

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_insurance (
        company_id, name, razao_social, cnpj, ans_code, registration,
        contact_phone, contact_email, upload_portal_url,
        tiss_version, provider_code, contract_number, contract_start, contract_end,
        default_discount_pct, payment_deadline_days, notes_billing, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9, $10,$11,$12,$13,$14, $15,$16,$17, true)
      RETURNING *`,
      [
        req.params.id, name, razao_social || null, cnpj || null, ans_code || null, registration || null,
        contact_phone || null, contact_email || null, upload_portal_url || null,
        tiss_version || '4.01.00', provider_code, contract_number || null,
        contract_start || null, contract_end || null,
        default_discount_pct || 0, payment_deadline_days || 30, notes_billing || null,
      ]
    );
    res.status(201).json({ insurance: rows[0] });
  } catch (err) {
    console.error('[tiss insurance create]', err.message);
    res.status(500).json({ error: 'Erro ao criar convenio' });
  }
});

router.patch('/insurance/:iid', requireAuth, requireWrite, async (req, res) => {
  const ALLOWED = [
    'name', 'razao_social', 'cnpj', 'ans_code', 'registration',
    'contact_phone', 'contact_email', 'upload_portal_url',
    'tiss_version', 'provider_code', 'contract_number', 'contract_start', 'contract_end',
    'default_discount_pct', 'payment_deadline_days', 'notes_billing', 'is_active',
  ];
  const fields = [];
  const values = [];
  let idx = 1;
  for (const k of ALLOWED) {
    if (req.body[k] !== undefined) {
      fields.push(`${k} = $${idx++}`);
      values.push(req.body[k]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nada pra atualizar' });
  fields.push(`updated_at = NOW()`);
  values.push(req.params.iid, req.params.id);

  try {
    const { rows } = await db.query(
      `UPDATE dental_insurance SET ${fields.join(', ')}
        WHERE id = $${idx++} AND company_id = $${idx}
        RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Convenio nao encontrado' });
    res.json({ insurance: rows[0] });
  } catch (err) {
    console.error('[tiss insurance patch]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar convenio' });
  }
});

router.delete('/insurance/:iid', requireAuth, requireWrite, async (req, res) => {
  try {
    // Soft delete via is_active=false (preserva guias historicas)
    const { rows } = await db.query(
      `UPDATE dental_insurance SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND company_id = $2
        RETURNING id`,
      [req.params.iid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Convenio nao encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao desativar convenio' });
  }
});

// ============================================================
// 3. CARTEIRINHAS DO PACIENTE
// ============================================================

router.get('/patients/:pid/cards', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT pi.*, i.name AS insurance_name, i.razao_social
         FROM dental_patient_insurance pi
         JOIN dental_insurance i ON i.id = pi.insurance_id
        WHERE pi.company_id = $1 AND pi.customer_id = $2
        ORDER BY pi.is_primary DESC, pi.created_at DESC`,
      [req.params.id, req.params.pid]
    );
    res.json({ cards: rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar carteirinhas' });
  }
});

router.post('/patients/:pid/cards', requireAuth, requireWrite, async (req, res) => {
  const {
    insurance_id, card_number, plan_name, plan_code,
    card_valid_until, holder_name, holder_cpf, is_primary, notes,
  } = req.body || {};

  if (!insurance_id) return res.status(400).json({ error: 'insurance_id obrigatorio' });
  if (!card_number) return res.status(400).json({ error: 'card_number obrigatorio' });

  try {
    // Se is_primary = true, desmarca os outros
    if (is_primary) {
      await db.query(
        `UPDATE dental_patient_insurance SET is_primary = false
          WHERE company_id = $1 AND customer_id = $2`,
        [req.params.id, req.params.pid]
      );
    }

    const { rows } = await db.query(
      `INSERT INTO dental_patient_insurance (
        company_id, customer_id, insurance_id, card_number,
        plan_name, plan_code, card_valid_until,
        holder_name, holder_cpf, is_primary, notes
      ) VALUES ($1,$2,$3,$4, $5,$6,$7, $8,$9,$10,$11)
      RETURNING *`,
      [
        req.params.id, req.params.pid, insurance_id, card_number,
        plan_name || null, plan_code || null, card_valid_until || null,
        holder_name || null, holder_cpf || null, is_primary !== false, notes || null,
      ]
    );
    res.status(201).json({ card: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Esta carteirinha ja esta cadastrada' });
    }
    console.error('[tiss card create]', err.message);
    res.status(500).json({ error: 'Erro ao criar carteirinha' });
  }
});

router.patch('/cards/:cardId', requireAuth, requireWrite, async (req, res) => {
  const ALLOWED = [
    'card_number', 'plan_name', 'plan_code', 'card_valid_until',
    'holder_name', 'holder_cpf', 'is_primary', 'is_active', 'notes',
  ];
  const fields = [];
  const values = [];
  let idx = 1;
  for (const k of ALLOWED) {
    if (req.body[k] !== undefined) {
      fields.push(`${k} = $${idx++}`);
      values.push(req.body[k]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nada pra atualizar' });
  values.push(req.params.cardId, req.params.id);

  try {
    const { rows } = await db.query(
      `UPDATE dental_patient_insurance SET ${fields.join(', ')}
        WHERE id = $${idx++} AND company_id = $${idx}
        RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Carteirinha nao encontrada' });
    res.json({ card: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar carteirinha' });
  }
});

router.delete('/cards/:cardId', requireAuth, requireWrite, async (req, res) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM dental_patient_insurance
        WHERE id = $1 AND company_id = $2
        RETURNING id`,
      [req.params.cardId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Carteirinha nao encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao deletar carteirinha' });
  }
});

// ============================================================
// 4. GUIAS TISS (4 tipos)
// ============================================================

router.get('/guides', requireAuth, async (req, res) => {
  const { status, insurance_id, guide_type, customer_id, batch_id } = req.query;
  const params = [req.params.id];
  let where = 'WHERE g.company_id = $1';

  if (status) { params.push(status); where += ` AND g.status = $${params.length}`; }
  if (insurance_id) { params.push(insurance_id); where += ` AND g.insurance_id = $${params.length}`; }
  if (guide_type) { params.push(guide_type); where += ` AND g.guide_type = $${params.length}`; }
  if (customer_id) { params.push(customer_id); where += ` AND g.customer_id = $${params.length}`; }
  if (batch_id) {
    if (batch_id === 'null') {
      where += ` AND g.batch_id IS NULL`;
    } else {
      params.push(batch_id); where += ` AND g.batch_id = $${params.length}`;
    }
  }

  try {
    const { rows } = await db.query(
      `SELECT g.*, g.customer_id AS patient_id,
              c.name AS patient_name, c.full_name AS patient_full_name,
              i.name AS insurance_name
         FROM dental_tiss_guides g
         JOIN customers c ON c.id = g.customer_id
         JOIN dental_insurance i ON i.id = g.insurance_id
         ${where}
        ORDER BY g.created_at DESC
        LIMIT 100`,
      params
    );

    const { rows: stats } = await db.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_value),0)::numeric AS total
         FROM dental_tiss_guides WHERE company_id = $1
         GROUP BY status`,
      [req.params.id]
    );
    res.json({ guides: rows, stats });
  } catch (err) {
    console.error('[tiss guides list]', err.message);
    res.status(500).json({ error: 'Erro ao buscar guias' });
  }
});

router.post('/guides', requireAuth, requireWrite, async (req, res) => {
  const {
    customer_id, insurance_id, patient_insurance_id, guide_type = 'sp_sadt',
    treatment_plan_id, procedures,
    professional_id, professional_name, professional_cro, professional_council = 'CRO',
    professional_council_uf, professional_cbo,
    auth_password, auth_number, auth_validity,
    service_date, service_start_time, service_end_time,
    service_type, attendance_type, accident_indication,
    hospital_admission_at, hospital_discharge_at, hospital_regime,
    clinical_indication, cid_code,
  } = req.body || {};

  if (!customer_id || !insurance_id) {
    return res.status(400).json({ error: 'customer_id e insurance_id obrigatorios' });
  }
  if (!Array.isArray(procedures) || procedures.length === 0) {
    return res.status(400).json({ error: 'procedures vazio' });
  }
  if (!['consulta', 'sp_sadt', 'honorario', 'internacao'].includes(guide_type)) {
    return res.status(400).json({ error: 'guide_type invalido' });
  }

  try {
    // Snapshot da carteirinha (se patient_insurance_id fornecido)
    let cardSnapshot = {};
    if (patient_insurance_id) {
      const { rows: cardRows } = await db.query(
        `SELECT card_number, card_valid_until, holder_name
           FROM dental_patient_insurance
          WHERE id = $1 AND company_id = $2`,
        [patient_insurance_id, req.params.id]
      );
      if (cardRows[0]) cardSnapshot = cardRows[0];
    }

    const totalValue = procedures.reduce((s, p) =>
      s + ((p.unit_value || p.value) || 0) * (p.quantity || 1), 0
    );

    const guideNumber = await nextGuideNumber(req.params.id);

    const { rows } = await db.query(
      `INSERT INTO dental_tiss_guides (
        company_id, customer_id, insurance_id, patient_insurance_id, treatment_plan_id,
        guide_number, guide_type, status,
        procedures, total_value,
        professional_id, professional_cro, professional_council, professional_council_uf, professional_cbo,
        card_number, card_valid_until, holder_name,
        auth_password, auth_number, auth_validity,
        service_date, service_start_time, service_end_time,
        service_type, attendance_type, accident_indication,
        hospital_admission_at, hospital_discharge_at, hospital_regime,
        clinical_indication, cid_code
      ) VALUES (
        $1,$2,$3,$4,$5, $6,$7,'rascunho',
        $8,$9,
        $10,$11,$12,$13,$14,
        $15,$16,$17,
        $18,$19,$20,
        $21,$22,$23,
        $24,$25,$26,
        $27,$28,$29,
        $30,$31
      ) RETURNING *, customer_id AS patient_id`,
      [
        req.params.id, customer_id, insurance_id, patient_insurance_id || null, treatment_plan_id || null,
        guideNumber, guide_type,
        JSON.stringify(procedures), totalValue,
        professional_id || null, professional_cro, professional_council, professional_council_uf || 'SP', professional_cbo || '223208',
        cardSnapshot.card_number || null, cardSnapshot.card_valid_until || null, cardSnapshot.holder_name || null,
        auth_password || null, auth_number || null, auth_validity || null,
        service_date || new Date(), service_start_time || null, service_end_time || null,
        service_type || 'consulta', attendance_type || 'ambulatorial', accident_indication || 'sem_acidente',
        hospital_admission_at || null, hospital_discharge_at || null, hospital_regime || null,
        clinical_indication || null, cid_code || null,
      ]
    );
    res.status(201).json({ guide: rows[0] });
  } catch (err) {
    console.error('[tiss guide create]', err.message);
    res.status(500).json({ error: 'Erro ao criar guia' });
  }
});

router.get('/guides/:gid', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT g.*, g.customer_id AS patient_id,
              c.full_name, c.name AS patient_name, c.cpf, c.phone, c.birthday,
              i.name AS insurance_name, i.ans_code, i.upload_portal_url
         FROM dental_tiss_guides g
         JOIN customers c ON c.id = g.customer_id
         JOIN dental_insurance i ON i.id = g.insurance_id
        WHERE g.id = $1 AND g.company_id = $2`,
      [req.params.gid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Guia nao encontrada' });
    res.json({ guide: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar guia' });
  }
});

// PATCH /guides/:gid
//
// PR13 (2026-04-26): expandido com paid_value, paid_at, glossed_value,
// glossed_codes pra suportar reconciliacao manual de pagamento.
// Trigger 067 (dental_tiss_guide_to_transaction) escuta paid_at e
// dispara criacao automatica de transaction (income, receita_tiss).
//
// Auto-status: se body NAO especifica status mas informa paid_value
// e/ou glossed_value, deduz:
//   - paid_value > 0 e glossed_value === 0/ausente → 'paga'
//   - paid_value > 0 e glossed_value > 0           → 'paga_parcial'
//   - paid_value === 0 e glossed_value > 0         → 'negada'
router.patch('/guides/:gid', requireAuth, requireWrite, async (req, res) => {
  const ALLOWED = [
    'status', 'auth_password', 'auth_number', 'auth_validity',
    'service_date', 'service_start_time', 'service_end_time',
    'professional_cro', 'professional_council_uf', 'professional_cbo',
    'attendance_type', 'accident_indication',
    'hospital_admission_at', 'hospital_discharge_at', 'hospital_regime',
    'clinical_indication', 'cid_code',
    'authorized_value', 'denied_reason',
    // PR13: reconciliacao manual de pagamento
    'paid_value', 'paid_at', 'glossed_value', 'glossed_codes',
  ];

  // Auto-status quando body informa pagamento sem status explicito
  const body = { ...req.body };
  const hasPaidInfo = body.paid_value !== undefined || body.glossed_value !== undefined;
  if (hasPaidInfo && body.status === undefined) {
    const paid    = parseFloat(body.paid_value || 0) || 0;
    const glossed = parseFloat(body.glossed_value || 0) || 0;
    if (paid > 0 && glossed === 0)      body.status = 'paga';
    else if (paid > 0 && glossed > 0)   body.status = 'paga_parcial';
    else if (paid === 0 && glossed > 0) body.status = 'negada';
    // (paid==0 e glossed==0 → nao muda status)
  }

  // Auto-paid_at: se status=paga/paga_parcial e paid_at nao foi fornecido
  if (
    (body.status === 'paga' || body.status === 'paga_parcial') &&
    body.paid_at === undefined
  ) {
    body.paid_at = new Date().toISOString();
  }

  // Serializa glossed_codes se vier como array/objeto (jsonb)
  if (body.glossed_codes !== undefined && typeof body.glossed_codes !== 'string') {
    body.glossed_codes = JSON.stringify(body.glossed_codes);
  }

  const fields = [];
  const values = [];
  let idx = 1;
  for (const k of ALLOWED) {
    if (body[k] !== undefined) {
      fields.push(`${k} = $${idx++}`);
      values.push(body[k]);
    }
  }
  if (body.status === 'autorizada') fields.push(`authorized_at = NOW()`);
  if (body.status === 'enviada') fields.push(`sent_at = NOW()`);
  if (!fields.length) return res.status(400).json({ error: 'Nada pra atualizar' });
  fields.push(`updated_at = NOW()`);
  values.push(req.params.gid, req.params.id);

  try {
    const { rows } = await db.query(
      `UPDATE dental_tiss_guides SET ${fields.join(', ')}
        WHERE id = $${idx++} AND company_id = $${idx}
        RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Guia nao encontrada' });
    res.json({ guide: rows[0] });
  } catch (err) {
    console.error('[tiss guide patch]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar guia' });
  }
});

router.delete('/guides/:gid', requireAuth, requireWrite, async (req, res) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM dental_tiss_guides
        WHERE id = $1 AND company_id = $2 AND status IN ('rascunho','negada')
        RETURNING id`,
      [req.params.gid, req.params.id]
    );
    if (!rows.length) {
      return res.status(409).json({ error: 'Guia ja foi enviada e nao pode ser deletada. Use cancelamento.' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao deletar guia' });
  }
});

// GET /guides/:gid/xml — preview do XML de uma guia (para debug/inspecao)
router.get('/guides/:gid/xml', requireAuth, async (req, res) => {
  try {
    const { rows: gRows } = await db.query(
      `SELECT * FROM dental_tiss_guides WHERE id = $1 AND company_id = $2`,
      [req.params.gid, req.params.id]
    );
    if (!gRows[0]) return res.status(404).json({ error: 'Guia nao encontrada' });
    const guide = gRows[0];
    guide.procedures = typeof guide.procedures === 'string'
      ? JSON.parse(guide.procedures) : (guide.procedures || []);

    const insurance = await getInsurance(req.params.id, guide.insurance_id);
    if (!insurance) return res.status(404).json({ error: 'Convenio nao encontrado' });

    const company = await getCompanyData(req.params.id);
    if (!company) return res.status(500).json({ error: 'Empresa nao encontrada' });

    const customer = await getCustomer(req.params.id, guide.customer_id);

    const xmlFragment = tissXml.buildSingleGuideXml(guide, customer, insurance, company);

    res.json({
      xml: xmlFragment,
      validation_errors: tissXml.validateGuide(guide, insurance, company),
      note: 'Preview de uma guia individual. Para envio real, gere via lote (POST /batches).',
    });
  } catch (err) {
    console.error('[tiss guide xml]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao gerar XML' });
  }
});

// ============================================================
// 5. LOTES DE FATURAMENTO
// ============================================================

router.get('/batches', requireAuth, async (req, res) => {
  const { status, insurance_id } = req.query;
  const params = [req.params.id];
  let where = 'WHERE b.company_id = $1';
  if (status) { params.push(status); where += ` AND b.status = $${params.length}`; }
  if (insurance_id) { params.push(insurance_id); where += ` AND b.insurance_id = $${params.length}`; }

  try {
    const { rows } = await db.query(
      `SELECT b.*, i.name AS insurance_name
         FROM dental_tiss_batches b
         JOIN dental_insurance i ON i.id = b.insurance_id
         ${where}
        ORDER BY b.reference_month DESC, b.created_at DESC
        LIMIT 50`,
      params
    );
    res.json({ batches: rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar lotes' });
  }
});

router.get('/batches/:bid', requireAuth, async (req, res) => {
  try {
    const { rows: bRows } = await db.query(
      `SELECT b.*, i.name AS insurance_name, i.upload_portal_url
         FROM dental_tiss_batches b
         JOIN dental_insurance i ON i.id = b.insurance_id
        WHERE b.id = $1 AND b.company_id = $2`,
      [req.params.bid, req.params.id]
    );
    if (!bRows[0]) return res.status(404).json({ error: 'Lote nao encontrado' });

    const { rows: gRows } = await db.query(
      `SELECT g.id, g.guide_number, g.guide_type, g.status, g.total_value,
              g.paid_value, g.glossed_value, c.name AS patient_name
         FROM dental_tiss_guides g
         JOIN customers c ON c.id = g.customer_id
        WHERE g.batch_id = $1
        ORDER BY g.guide_number`,
      [req.params.bid]
    );

    res.json({ batch: bRows[0], guides: gRows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar lote' });
  }
});

// POST /batches — cria lote agrupando guias e GERA O XML
router.post('/batches', requireAuth, requireWrite, async (req, res) => {
  const { insurance_id, guide_ids, reference_month } = req.body || {};

  if (!insurance_id) return res.status(400).json({ error: 'insurance_id obrigatorio' });
  if (!Array.isArray(guide_ids) || guide_ids.length === 0) {
    return res.status(400).json({ error: 'guide_ids vazio' });
  }
  if (!reference_month || !/^\d{4}-\d{2}$/.test(reference_month)) {
    return res.status(400).json({ error: 'reference_month no formato YYYY-MM obrigatorio' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Carrega convenio
    const { rows: iRows } = await client.query(
      `SELECT * FROM dental_insurance
        WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)`,
      [insurance_id, req.params.id]
    );
    if (!iRows[0]) throw new Error('Convenio nao encontrado');
    const insurance = iRows[0];

    // Carrega clinica
    const { rows: coRows } = await client.query(
      `SELECT id, legal_name, trade_name, cnpj, address_state, cnes
         FROM companies WHERE id = $1`,
      [req.params.id]
    );
    if (!coRows[0]) throw new Error('Empresa nao encontrada');
    const company = coRows[0];

    // Carrega guias com snapshot do paciente
    const { rows: guides } = await client.query(
      `SELECT g.*, c.full_name AS customer_full_name, c.name AS customer_name,
              c.cpf AS customer_cpf
         FROM dental_tiss_guides g
         JOIN customers c ON c.id = g.customer_id
        WHERE g.id = ANY($1::uuid[])
          AND g.company_id = $2
          AND g.insurance_id = $3
          AND g.batch_id IS NULL
          AND g.status IN ('rascunho','autorizada','pendente_auth')`,
      [guide_ids, req.params.id, insurance_id]
    );

    if (guides.length !== guide_ids.length) {
      throw new Error(`Algumas guias nao foram encontradas ou ja estao em outro lote (${guides.length} de ${guide_ids.length} encontradas)`);
    }

    // Prepara para o builder XML
    const builderInput = guides.map(g => ({
      guide: {
        ...g,
        procedures: typeof g.procedures === 'string' ? JSON.parse(g.procedures) : g.procedures,
      },
      customer: {
        full_name: g.customer_full_name,
        name:      g.customer_name,
        cpf:       g.customer_cpf,
      },
    }));

    const batchNumber = await nextBatchNumber(req.params.id, insurance_id);
    const totalValue = guides.reduce((s, g) => s + parseFloat(g.total_value || 0), 0);

    // Gera XML (pode lancar erro se alguma guia for invalida)
    const xmlResult = tissXml.buildBatchXml({
      batch: { batch_number: batchNumber, reference_month },
      guides: builderInput,
      insurance,
      company,
    });

    // Persiste lote
    const { rows: bRows } = await client.query(
      `INSERT INTO dental_tiss_batches (
        company_id, insurance_id, batch_number, reference_month,
        total_value, guide_count, status, xml_content
      ) VALUES ($1,$2,$3,$4, $5,$6,'rascunho',$7)
      RETURNING *`,
      [
        req.params.id, insurance_id, batchNumber, reference_month,
        totalValue, guides.length, xmlResult.xml,
      ]
    );
    const batch = bRows[0];

    // Vincula guias ao lote
    await client.query(
      `UPDATE dental_tiss_guides
          SET batch_id = $1, updated_at = NOW()
        WHERE id = ANY($2::uuid[]) AND company_id = $3`,
      [batch.id, guide_ids, req.params.id]
    );

    await client.query('COMMIT');

    res.status(201).json({
      batch,
      hash:        xmlResult.hash,
      sequencial:  xmlResult.sequencial,
      total_guias: xmlResult.totalGuias,
      message:     'Lote criado com sucesso. Use GET /batches/:bid/xml pra baixar o XML.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[tiss batch create]', err.message);
    res.status(400).json({ error: err.message || 'Erro ao criar lote' });
  } finally {
    client.release();
  }
});

// GET /batches/:bid/xml — download do XML do lote
router.get('/batches/:bid/xml', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT batch_number, xml_content FROM dental_tiss_batches
        WHERE id = $1 AND company_id = $2`,
      [req.params.bid, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Lote nao encontrado' });
    if (!rows[0].xml_content) {
      return res.status(409).json({ error: 'Lote sem XML gerado' });
    }

    const filename = `tiss_${rows[0].batch_number}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(rows[0].xml_content);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao baixar XML' });
  }
});

// POST /batches/:bid/return — parsear XML de retorno da operadora
router.post('/batches/:bid/return', requireAuth, requireWrite, async (req, res) => {
  const { xml_content } = req.body || {};
  if (!xml_content) return res.status(400).json({ error: 'xml_content obrigatorio' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: bRows } = await client.query(
      `SELECT id FROM dental_tiss_batches WHERE id = $1 AND company_id = $2`,
      [req.params.bid, req.params.id]
    );
    if (!bRows[0]) throw new Error('Lote nao encontrado');

    const parsed = tissXml.parseReturnXml(xml_content);

    if (parsed.errors.length > 0) {
      throw new Error('XML de retorno invalido: ' + parsed.errors.join('; '));
    }

    let totalPaid = 0;
    let totalGlossed = 0;

    // Atualiza cada guia processada
    for (const g of parsed.guides) {
      totalPaid += g.paid_value;
      totalGlossed += g.glossed_value;

      await client.query(
        `UPDATE dental_tiss_guides
            SET status = $1,
                paid_value = $2,
                paid_at = CASE WHEN $1 IN ('paga','paga_parcial') THEN NOW() ELSE paid_at END,
                glossed_value = $3,
                glossed_codes = $4,
                authorized_value = COALESCE(authorized_value, $5),
                updated_at = NOW()
          WHERE batch_id = $6 AND guide_number = $7 AND company_id = $8`,
        [
          g.status, g.paid_value, g.glossed_value,
          JSON.stringify(g.glosas),
          g.processed_value,
          req.params.bid, g.guide_number, req.params.id,
        ]
      );
    }

    // Atualiza lote
    await client.query(
      `UPDATE dental_tiss_batches
          SET status = 'processado',
              processed_at = NOW(),
              total_paid = $1,
              total_glossed = $2,
              protocol_number = COALESCE($3, protocol_number),
              updated_at = NOW()
        WHERE id = $4 AND company_id = $5`,
      [totalPaid, totalGlossed, parsed.protocol, req.params.bid, req.params.id]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      protocol: parsed.protocol,
      processed_guides: parsed.guides.length,
      total_paid: totalPaid,
      total_glossed: totalGlossed,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[tiss batch return]', err.message);
    res.status(400).json({ error: err.message || 'Erro ao processar retorno' });
  } finally {
    client.release();
  }
});

router.delete('/batches/:bid', requireAuth, requireWrite, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // So permite deletar lote em rascunho
    const { rows } = await client.query(
      `SELECT status FROM dental_tiss_batches WHERE id = $1 AND company_id = $2`,
      [req.params.bid, req.params.id]
    );
    if (!rows[0]) throw new Error('Lote nao encontrado');
    if (rows[0].status !== 'rascunho') {
      throw new Error('So e possivel deletar lote em rascunho. Use cancelamento se ja foi enviado.');
    }

    // Desvincula guias (FK ON DELETE SET NULL ja faz, mas explicitamos)
    await client.query(
      `UPDATE dental_tiss_guides SET batch_id = NULL, updated_at = NOW()
        WHERE batch_id = $1 AND company_id = $2`,
      [req.params.bid, req.params.id]
    );

    await client.query(
      `DELETE FROM dental_tiss_batches WHERE id = $1 AND company_id = $2`,
      [req.params.bid, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================
// 6. TABELAS DE APOIO
// ============================================================

router.get('/glosa-codes', requireAuth, async (req, res) => {
  const { search, category } = req.query;
  const params = [];
  let where = 'WHERE is_active = true';
  if (category) { params.push(category); where += ` AND category = $${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (code ILIKE $${params.length} OR description ILIKE $${params.length})`;
  }
  try {
    const { rows } = await db.query(
      `SELECT * FROM dental_tiss_glosa_codes ${where} ORDER BY code LIMIT 100`,
      params
    );
    res.json({ codes: rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar codigos de glosa' });
  }
});

module.exports = router;
