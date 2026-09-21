// ============================================================
// AURA. — Servico Modulo Odontologia (BE-25)
// D-UNIFY: usa customers (is_patient=true). Agenda inclui practitioner_id
// + professional_name (LEFT JOIN dental_practitioners) pra mapear cadeira.
//
// PR30 (2026-04-28): listPatients enriquecido com photo_url, last_visit_at,
// next_appointment_at, e filtros opcionais (has_allergies, has_insurance,
// inactive_days, convenio). Mantem retrocompat com chamadas existentes.
//
// PR33 (2026-04-28): qr_payload em generateWsToken corrigido. Antes
// apontava pra APP_URL/sign/<token> (frontend), mas frontend nao tinha
// rota /sign/:token e 404va. Agora aponta direto pro endpoint backend
// /api/v1/dental/sign/:token/pad que serve HTML completo com canvas.
// ============================================================

const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const {
  ScheduleError, assertTransition, timestampSetsFor, queryConflicts, NON_BLOCKING_STATUSES,
} = require('./dentalSchedule');

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

async function listPatients(companyId, opts = {}) {
  const {
    search,
    page = 1,
    limit = 20,
    hasAllergies, hasInsurance, inactiveDays, convenio,
  } = opts;
  const offset = (page - 1) * limit;
  const params = [companyId];
  let where = 'WHERE c.company_id = $1 AND c.is_patient = true AND c.is_active = true';

  if (search) {
    params.push(`%${search}%`);
    const p1 = params.length;
    let searchClause = `(c.name ILIKE $${p1} OR c.cpf_cnpj ILIKE $${p1} OR c.phone ILIKE $${p1})`;

    // 1.4: busca por telefone ignorando formatacao — "99999-0002" e
    // "(99) 99999-0002" devem achar o mesmo registro. So ativa quando o
    // termo tem 4+ digitos pra nao virar um LIKE '%%' largo demais.
    const digitsOnly = search.replace(/[^0-9]/g, '');
    if (digitsOnly.length >= 4) {
      params.push(`%${digitsOnly}%`);
      const p2 = params.length;
      searchClause += ` OR regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE $${p2}`;
      searchClause += ` OR regexp_replace(COALESCE(c.phone_secondary, ''), '[^0-9]', '', 'g') LIKE $${p2}`;
    }

    where += ` AND ${searchClause}`;
  }
  if (hasAllergies === true || hasAllergies === 'true' || hasAllergies === '1') {
    where += ` AND c.allergies IS NOT NULL AND TRIM(c.allergies) <> ''`;
  }
  if (hasInsurance === true || hasInsurance === 'true' || hasInsurance === '1') {
    where += ` AND c.insurance_name IS NOT NULL AND TRIM(c.insurance_name) <> ''`;
  }
  if (convenio) {
    params.push(`%${convenio}%`);
    where += ` AND c.insurance_name ILIKE $${params.length}`;
  }

  let sql = `
    SELECT c.id,
           c.name      AS full_name,
           c.birth_date,
           c.phone,
           c.email,
           c.cpf_cnpj  AS cpf,
           c.insurance_name,
           c.allergies,
           c.photo_url,
           c.lgpd_consent,
           c.created_at,
           COUNT(a.id) FILTER (WHERE a.status::text NOT IN ('cancelado','faltou','falta_justificada')) AS appointments_total,
           MAX(a.scheduled_at) FILTER (WHERE a.status = 'concluido' OR (a.status::text NOT IN ('cancelado','faltou','falta_justificada') AND a.scheduled_at < NOW())) AS last_visit_at,
           MIN(a.scheduled_at) FILTER (WHERE a.scheduled_at >= NOW() AND a.status::text NOT IN ('cancelado','faltou','falta_justificada','concluido')) AS next_appointment_at
    FROM customers c
    LEFT JOIN dental_appointments a ON a.customer_id = c.id
    ${where}
    GROUP BY c.id`;

  if (inactiveDays != null && inactiveDays !== '' && !isNaN(parseInt(inactiveDays))) {
    const days = parseInt(inactiveDays);
    sql += ` HAVING (MAX(a.scheduled_at) FILTER (WHERE a.status = 'concluido' OR (a.status::text NOT IN ('cancelado','faltou','falta_justificada') AND a.scheduled_at < NOW())) IS NULL
                    OR MAX(a.scheduled_at) FILTER (WHERE a.status = 'concluido' OR (a.status::text NOT IN ('cancelado','faltou','falta_justificada') AND a.scheduled_at < NOW())) < NOW() - INTERVAL '${days} days')`;
  }

  sql += `
    ORDER BY c.name ASC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  const { rows } = await db.query(sql, [...params, limit, offset]);
  return rows.map((r) => ({ ...r, last_visit: r.last_visit_at }));
}

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
            NULLIF(TRIM(c.allergies), '') AS allergies, -- a grade mostra o alerta de alergia no bloco
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

// QA odonto 16/09/2026: a tabela de transições saiu daqui para
// services/dentalSchedule.js (documentada lá). updateAppointment aplica status
// + demais campos NUMA transação — antes a rota descartava clinical_notes etc.
// quando o body trazia status — e devolve os conflitos de horário.
const PATCHABLE_FIELDS = [
  'chief_complaint', 'anamnesis', 'clinical_notes', 'discount_type', 'discount_value',
  'cancel_reason', 'practitioner_id', 'scheduled_at', 'duration_min',
];
const SCHEDULE_FIELDS = ['scheduled_at', 'duration_min', 'practitioner_id'];

async function updateAppointment(companyId, appointmentId, { status, fields = {}, rejectOnConflict = false } = {}) {
  const hasStatus = status !== undefined && status !== null && status !== '';
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(
      `SELECT id, status::text AS status, scheduled_at, duration_min, practitioner_id
         FROM dental_appointments
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [appointmentId, companyId]
    );
    if (!cur.length) throw new ScheduleError('Agendamento nao encontrado', 'NOT_FOUND', 404);
    const current = cur[0];

    if (hasStatus) assertTransition(current.status, status);
    const changingStatus = hasStatus && status !== current.status;

    const sets = [];
    const values = [];
    const push = (col, v) => { values.push(v); sets.push(`${col} = $${values.length}`); };
    for (const k of PATCHABLE_FIELDS) {
      if (fields[k] === undefined) continue;
      push(k, k === 'practitioner_id' ? (fields[k] || null) : fields[k]);
    }
    if (changingStatus) {
      push('status', status);
      sets.push(...timestampSetsFor(current.status, status));
    }
    if (!sets.length && !hasStatus) {
      throw new ScheduleError('Nenhum campo para atualizar', 'NO_FIELDS', 400);
    }

    const finalStatus = changingStatus ? status : current.status;
    const scheduleTouched = SCHEDULE_FIELDS.some((k) => fields[k] !== undefined)
      || (changingStatus && NON_BLOCKING_STATUSES.includes(current.status));
    let conflicts = [];
    if (scheduleTouched && !NON_BLOCKING_STATUSES.includes(finalStatus)) {
      conflicts = await queryConflicts(client, companyId, {
        id: appointmentId,
        scheduled_at: fields.scheduled_at !== undefined ? fields.scheduled_at : current.scheduled_at,
        duration_min: fields.duration_min !== undefined ? fields.duration_min : current.duration_min,
        practitioner_id: fields.practitioner_id !== undefined ? (fields.practitioner_id || null) : current.practitioner_id,
      });
      if (rejectOnConflict && conflicts.length) {
        throw new ScheduleError('Horario em conflito com outro agendamento', 'SCHEDULE_CONFLICT', 409, { conflicts });
      }
    }

    sets.push('updated_at = NOW()');
    values.push(appointmentId, companyId);
    const { rows } = await client.query(
      `UPDATE dental_appointments SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND company_id = $${values.length}
        RETURNING *, customer_id AS patient_id`,
      values
    );
    await client.query('COMMIT');
    return { appointment: rows[0], conflicts, previous_status: current.status };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Compat: só status.
async function updateAppointmentStatus(companyId, appointmentId, newStatus) {
  const { appointment } = await updateAppointment(companyId, appointmentId, { status: newStatus });
  return appointment;
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

  // PR33 fix: aponta pra endpoint backend do pad de assinatura.
  // Antes: APP_URL/sign/<token> (frontend) - mas frontend nao tinha rota
  // /sign/:token e dava 404. Agora vai direto pra rota REST que serve o
  // HTML do canvas + WebSocket (dentalSign.js GET /sign/:token/pad).
  //
  // API_URL fallback usa o host de prod no Railway. Em dev, defina API_URL=http://localhost:PORT
  const apiUrl = process.env.API_URL || process.env.APP_URL || 'https://aura-backend-production-f805.up.railway.app';
  const qrPayload = `${apiUrl.replace(/\/$/, '')}/api/v1/dental/sign/${rows[0].token}/pad`;

  return {
    token:      rows[0].token,
    expires_at: rows[0].expires_at,
    expires_in: 600,
    qr_payload: qrPayload,
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

module.exports = { listPatients, getAgendaByPeriod, updateAppointmentStatus, updateAppointment,
  addProcedureToAppointment, recalcAppointmentTotal, calcAppointmentTotal,
  generateWsToken, validateWsToken };
