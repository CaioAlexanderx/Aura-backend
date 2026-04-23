// ============================================================
// AURA. — Servico Modulo Odontologia (BE-25)
// D-UNIFY: usa customers (is_patient=true). Agenda inclui practitioner_id
// + professional_name (LEFT JOIN dental_practitioners) pra mapear cadeira.
// ============================================================

const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

function calcAppointmentTotal(procedures, discountType, discountValue) {
  const subtotal = procedures.reduce((sum, p) => sum + parseFloat(p.price_total || 0), 0);
  let discount = 0;
  if (discountType === 'percent' && discountValue) discount = subtotal * (parseFloat(discountValue) / 100);
  else if (discountType === 'fixed' && discountValue) discount = parseFloat(discountValue);
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    total:    Math.round(Math.max(subtotal - discount, 0) * 100) / 100,
  };
}

async function listPatients(companyId, { search, page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const params = [companyId];
  let where = 'WHERE c.company_id = $1 AND c.is_patient = true AND c.is_active = true';
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (c.name ILIKE $${params.length} OR c.cpf_cnpj ILIKE $${params.length} OR c.phone ILIKE $${params.length})`;
  }
  const { rows } = await db.query(
    `SELECT c.id,
            c.name      AS full_name,
            c.birth_date,
            c.phone,
            c.email,
            c.cpf_cnpj  AS cpf,
            c.insurance_name,
            c.lgpd_consent,
            c.created_at,
            COUNT(a.id) FILTER (WHERE a.status NOT IN ('cancelado','faltou')) AS appointments_total,
            MAX(a.scheduled_at) FILTER (WHERE a.status = 'concluido') AS last_visit
     FROM customers c
     LEFT JOIN dental_appointments a ON a.customer_id = c.id
     ${where}
     GROUP BY c.id
     ORDER BY c.name ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return rows;
}

// D-UNIFY: agenda agora retorna practitioner_id + professional_name
async function getAgendaByPeriod(companyId, startDate, endDate) {
  const { rows } = await db.query(
    `SELECT a.id,
            a.scheduled_at, a.duration_min, a.status,
            a.chief_complaint, a.total,
            a.practitioner_id,
            c.id           AS patient_id,
            c.id           AS customer_id,
            c.name         AS patient_name,
            c.phone        AS patient_phone,
            c.insurance_name,
            pr.name        AS professional_name,
            pr.color       AS professional_color,
            COUNT(ap.id) AS procedure_count
     FROM dental_appointments a
     JOIN customers c ON c.id = a.customer_id
     LEFT JOIN dental_practitioners pr ON pr.id = a.practitioner_id
     LEFT JOIN dental_appointment_procedures ap ON ap.appointment_id = a.id
     WHERE a.company_id = $1 AND a.scheduled_at >= $2 AND a.scheduled_at < $3
       AND a.status != 'cancelado'
     GROUP BY a.id, c.id, pr.id
     ORDER BY a.scheduled_at ASC`,
    [companyId, startDate, endDate]
  );
  return rows;
}

async function updateAppointmentStatus(companyId, appointmentId, newStatus) {
  const validTransitions = {
    agendado:       ['avaliacao', 'em_atendimento', 'cancelado', 'faltou'],
    avaliacao:      ['aprovado', 'cancelado'],
    aprovado:       ['em_atendimento', 'cancelado'],
    em_atendimento: ['concluido', 'cancelado'],
  };
  const { rows: current } = await db.query(
    'SELECT status FROM dental_appointments WHERE id = $1 AND company_id = $2',
    [appointmentId, companyId]
  );
  if (!current.length) throw new Error('Agendamento nao encontrado');
  const currentStatus = current[0].status;
  const allowed = validTransitions[currentStatus] || [];
  if (!allowed.includes(newStatus)) throw new Error(`Transicao invalida: ${currentStatus} -> ${newStatus}`);

  const tsMap = { em_atendimento: 'started_at', concluido: 'concluded_at', cancelado: 'cancelled_at' };
  const tsField = tsMap[newStatus] ? `, ${tsMap[newStatus]} = NOW()` : '';

  const { rows } = await db.query(
    `UPDATE dental_appointments SET status=$1, updated_at=NOW()${tsField} WHERE id=$2 AND company_id=$3 RETURNING *`,
    [newStatus, appointmentId, companyId]
  );
  return rows[0];
}

async function addProcedureToAppointment(appointmentId, companyId, {
  procedure_id, procedure_name, quantity = 1, price_unit, tooth_number, tooth_face
}) {
  let name = procedure_name, codeTuss = null, category = null, unitPrice = price_unit;
  if (procedure_id) {
    const { rows } = await db.query(
      'SELECT name, code_tuss, category, price_private FROM dental_procedures WHERE id=$1 AND company_id=$2',
      [procedure_id, companyId]
    );
    if (rows.length) {
      name = name || rows[0].name;
      codeTuss = rows[0].code_tuss;
      category = rows[0].category;
      unitPrice = unitPrice ?? parseFloat(rows[0].price_private);
    }
  }
  const priceTotal = Math.round(quantity * parseFloat(unitPrice) * 100) / 100;
  const { rows } = await db.query(
    `INSERT INTO dental_appointment_procedures
       (appointment_id, procedure_id, procedure_name, code_tuss, category,
        quantity, price_unit, price_total, tooth_number, tooth_face)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [appointmentId, procedure_id||null, name, codeTuss, category,
     quantity, unitPrice, priceTotal, tooth_number||null, tooth_face||null]
  );
  await recalcAppointmentTotal(appointmentId);
  return rows[0];
}

async function recalcAppointmentTotal(appointmentId) {
  const { rows: procs } = await db.query(
    'SELECT price_total FROM dental_appointment_procedures WHERE appointment_id=$1', [appointmentId]
  );
  const { rows: appt } = await db.query(
    'SELECT discount_type, discount_value FROM dental_appointments WHERE id=$1', [appointmentId]
  );
  const { subtotal, discount, total } = calcAppointmentTotal(procs, appt[0]?.discount_type, appt[0]?.discount_value);
  await db.query(
    'UPDATE dental_appointments SET subtotal=$1, total=$2, updated_at=NOW() WHERE id=$3',
    [subtotal, total, appointmentId]
  );
  return { subtotal, discount, total };
}

async function generateWsToken(companyId, appointmentId) {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.query(
    'UPDATE dental_ws_tokens SET expires_at=NOW() WHERE appointment_id=$1 AND used_at IS NULL',
    [appointmentId]
  );
  const { rows } = await db.query(
    `INSERT INTO dental_ws_tokens (company_id, appointment_id, token, expires_at)
     VALUES ($1,$2,$3,$4) RETURNING id, token, expires_at`,
    [companyId, appointmentId, token, expiresAt]
  );
  return {
    token:      rows[0].token,
    expires_at: rows[0].expires_at,
    expires_in: 600,
    qr_payload: `${process.env.APP_URL || 'https://getaura.com.br'}/sign/${rows[0].token}`,
    note:       'WebSocket endpoint: ws://[host]/ws/sign/:token',
  };
}

async function validateWsToken(token) {
  const { rows } = await db.query(
    `SELECT t.*, a.company_id,
            a.customer_id,
            a.customer_id AS patient_id
     FROM dental_ws_tokens t
     JOIN dental_appointments a ON a.id = t.appointment_id
     WHERE t.token=$1 AND t.expires_at>NOW() AND t.used_at IS NULL`,
    [token]
  );
  return rows[0] || null;
}

module.exports = { listPatients, getAgendaByPeriod, updateAppointmentStatus,
  addProcedureToAppointment, recalcAppointmentTotal, calcAppointmentTotal,
  generateWsToken, validateWsToken };
