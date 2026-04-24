// ============================================================
// AURA. — Dental Booking Admin (W1-03)
//
// Lado autenticado da agenda online publica:
//   GET    /booking/config           le config (cria default se nao tem)
//   PUT    /booking/config           atualiza config (slug, horario, dias, etc)
//   GET    /booking/requests         lista requests pendentes/processadas
//   POST   /booking/requests/:rid/convert  converte request -> appointment
//   POST   /booking/requests/:rid/reject   marca request como rejeitada
//
// Rotas publicas (paciente sem login) ficam em routes/dentalBooking.js
// e sao montadas em routes/index.js em /dental/book/:slug.
//
// Tabelas usadas:
//   dental_booking_config     (1:1 company_id, slug UNIQUE)
//   dental_booking_requests   (1:N por company_id, status pendente|aprovado|rejeitado)
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// Slugify simples — minusculas, sem acentos, hifens
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remove acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'agenda';
}

// ── GET /booking/config ──
// Le config. Se nao existe, cria com defaults baseado no trade_name.
router.get('/booking/config', requireAuth, async (req, res) => {
  try {
    let { rows } = await db.query(
      'SELECT * FROM dental_booking_config WHERE company_id = $1',
      [req.params.id]
    );

    if (!rows.length) {
      // Cria default — slug a partir do trade_name + sufixo se conflito
      const { rows: comp } = await db.query(
        'SELECT trade_name FROM companies WHERE id = $1',
        [req.params.id]
      );
      const baseName = comp[0]?.trade_name || 'clinica';
      let slug = slugify(baseName);

      // Garante unicidade — adiciona -2, -3, ...
      let attempt = 1;
      let candidate = slug;
      while (true) {
        const { rows: hit } = await db.query(
          'SELECT 1 FROM dental_booking_config WHERE slug = $1',
          [candidate]
        );
        if (!hit.length) break;
        attempt++;
        candidate = `${slug}-${attempt}`;
      }
      slug = candidate;

      const { rows: created } = await db.query(
        `INSERT INTO dental_booking_config (company_id, slug, is_active)
         VALUES ($1, $2, false)
         RETURNING *`,
        [req.params.id, slug]
      );
      rows = created;
    }

    res.json({ config: rows[0] });
  } catch (err) {
    console.error('[dentalBookingAdmin GET config]', err.message);
    res.status(500).json({ error: 'Erro ao buscar configuracao' });
  }
});

// ── PUT /booking/config ──
router.put('/booking/config', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const {
    is_active, slug, welcome_msg,
    min_advance_hours, max_advance_days, slot_duration_min,
    available_days, start_hour, end_hour, require_phone,
  } = req.body;

  // Validacao do slug se vier
  let cleanSlug;
  if (slug !== undefined) {
    cleanSlug = slugify(slug);
    if (!cleanSlug || cleanSlug.length < 3) {
      return res.status(400).json({ error: 'Slug invalido — minimo 3 caracteres alfanumericos' });
    }

    // Confere se ja existe pra outra empresa
    const { rows: clash } = await db.query(
      'SELECT company_id FROM dental_booking_config WHERE slug = $1 AND company_id != $2',
      [cleanSlug, req.params.id]
    );
    if (clash.length) {
      return res.status(409).json({ error: `Slug "${cleanSlug}" ja esta em uso. Tente outro.` });
    }
  }

  // Validacoes basicas
  if (start_hour !== undefined && (start_hour < 0 || start_hour > 23)) {
    return res.status(400).json({ error: 'start_hour deve estar entre 0 e 23' });
  }
  if (end_hour !== undefined && (end_hour < 1 || end_hour > 24)) {
    return res.status(400).json({ error: 'end_hour deve estar entre 1 e 24' });
  }
  if (start_hour !== undefined && end_hour !== undefined && start_hour >= end_hour) {
    return res.status(400).json({ error: 'start_hour deve ser menor que end_hour' });
  }
  if (slot_duration_min !== undefined && ![15, 20, 30, 45, 60, 90, 120].includes(slot_duration_min)) {
    return res.status(400).json({ error: 'slot_duration_min deve ser um de: 15, 20, 30, 45, 60, 90, 120' });
  }
  if (available_days !== undefined) {
    if (!Array.isArray(available_days) || available_days.some(d => d < 0 || d > 6)) {
      return res.status(400).json({ error: 'available_days deve ser array de inteiros 0-6 (0=domingo)' });
    }
  }

  try {
    // Garante que existe (cria default se nao tem ainda)
    await db.query(
      `INSERT INTO dental_booking_config (company_id, slug, is_active)
       VALUES ($1, COALESCE($2, gen_random_uuid()::text), false)
       ON CONFLICT (company_id) DO NOTHING`,
      [req.params.id, cleanSlug || null]
    );

    // Build dynamic UPDATE
    const updates = [];
    const values  = [];
    const set = (col, val, cast) => {
      if (val === undefined) return;
      updates.push(`${col} = $${values.length + 1}${cast || ''}`);
      values.push(val);
    };
    set('is_active',         is_active);
    set('slug',              cleanSlug);
    set('welcome_msg',       welcome_msg);
    set('min_advance_hours', min_advance_hours);
    set('max_advance_days',  max_advance_days);
    set('slot_duration_min', slot_duration_min);
    set('available_days',    available_days ? JSON.stringify(available_days) : undefined, '::jsonb');
    set('start_hour',        start_hour);
    set('end_hour',          end_hour);
    set('require_phone',     require_phone);

    if (!updates.length) {
      const { rows } = await db.query(
        'SELECT * FROM dental_booking_config WHERE company_id = $1',
        [req.params.id]
      );
      return res.json({ config: rows[0] });
    }

    updates.push('updated_at = NOW()');
    values.push(req.params.id);

    const { rows } = await db.query(
      `UPDATE dental_booking_config
       SET ${updates.join(', ')}
       WHERE company_id = $${values.length}
       RETURNING *`,
      values
    );

    res.json({ config: rows[0] });
  } catch (err) {
    console.error('[dentalBookingAdmin PUT config]', err.message);
    res.status(500).json({ error: 'Erro ao salvar configuracao' });
  }
});

// ── GET /booking/requests ──
router.get('/booking/requests', requireAuth, async (req, res) => {
  const { status } = req.query;  // pendente|aprovado|rejeitado|all
  const params = [req.params.id];
  let where = 'WHERE company_id = $1';

  if (status && status !== 'all') {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }

  try {
    const { rows } = await db.query(
      `SELECT id, patient_name, patient_phone, patient_email,
              preferred_date, preferred_time, chief_complaint,
              status, appointment_id, notes, created_at
       FROM dental_booking_requests
       ${where}
       ORDER BY
         CASE status WHEN 'pendente' THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 100`,
      params
    );

    // Conta agregado pra badge no FE
    const { rows: countRow } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pendente') AS pending_count,
         COUNT(*) FILTER (WHERE status = 'aprovado') AS approved_count,
         COUNT(*) FILTER (WHERE status = 'rejeitado') AS rejected_count
       FROM dental_booking_requests
       WHERE company_id = $1`,
      [req.params.id]
    );

    res.json({
      total: rows.length,
      counts: countRow[0] || { pending_count: 0, approved_count: 0, rejected_count: 0 },
      requests: rows,
    });
  } catch (err) {
    console.error('[dentalBookingAdmin GET requests]', err.message);
    res.status(500).json({ error: 'Erro ao buscar solicitacoes' });
  }
});

// ── POST /booking/requests/:rid/convert ──
// Converte request em appointment + customer (se nao existir).
// Procura customer existente por phone/email, senao cria novo.
router.post('/booking/requests/:rid/convert', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { practitioner_id, scheduled_at, duration_min } = req.body;

  try {
    // Busca request
    const { rows: reqRows } = await db.query(
      'SELECT * FROM dental_booking_requests WHERE id = $1 AND company_id = $2',
      [req.params.rid, req.params.id]
    );
    if (!reqRows.length) return res.status(404).json({ error: 'Solicitacao nao encontrada' });

    const bookingReq = reqRows[0];

    if (bookingReq.status !== 'pendente') {
      return res.status(400).json({
        error: `Solicitacao ja foi ${bookingReq.status}. Crie uma nova se necessario.`,
      });
    }

    // Procura customer existente por phone OU email
    let customerId = null;
    if (bookingReq.patient_phone) {
      const { rows: byPhone } = await db.query(
        `SELECT id FROM customers
         WHERE company_id = $1 AND phone = $2
         LIMIT 1`,
        [req.params.id, bookingReq.patient_phone]
      );
      if (byPhone.length) customerId = byPhone[0].id;
    }
    if (!customerId && bookingReq.patient_email) {
      const { rows: byEmail } = await db.query(
        `SELECT id FROM customers
         WHERE company_id = $1 AND email = $2
         LIMIT 1`,
        [req.params.id, bookingReq.patient_email]
      );
      if (byEmail.length) customerId = byEmail[0].id;
    }

    // Cria customer se nao achou (so colunas que existem em customers)
    if (!customerId) {
      const { rows: newCust } = await db.query(
        `INSERT INTO customers
           (company_id, name, phone, email, is_patient)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [
          req.params.id,
          bookingReq.patient_name,
          bookingReq.patient_phone || null,
          bookingReq.patient_email || null,
        ]
      );
      customerId = newCust[0].id;
    } else {
      // Garante que e patient
      await db.query(
        'UPDATE customers SET is_patient = true WHERE id = $1 AND is_patient = false',
        [customerId]
      );
    }

    // Monta scheduled_at — usa o do body OU combina preferred_date + preferred_time
    let finalScheduledAt = scheduled_at;
    if (!finalScheduledAt) {
      // Combina date + time (assumindo America/Sao_Paulo)
      finalScheduledAt = `${bookingReq.preferred_date}T${bookingReq.preferred_time}-03:00`;
    }

    // Cria appointment
    const { rows: appt } = await db.query(
      `INSERT INTO dental_appointments
         (company_id, customer_id, scheduled_at, duration_min,
          chief_complaint, practitioner_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'agendado')
       RETURNING id, scheduled_at, duration_min`,
      [
        req.params.id, customerId,
        finalScheduledAt,
        duration_min || 60,
        bookingReq.chief_complaint || null,
        practitioner_id || null,
      ]
    );

    // Marca request como aprovado + linka appointment
    await db.query(
      `UPDATE dental_booking_requests
       SET status = 'aprovado', appointment_id = $1
       WHERE id = $2`,
      [appt[0].id, req.params.rid]
    );

    res.json({
      message: 'Solicitacao convertida em agendamento',
      customer_id: customerId,
      appointment: appt[0],
    });
  } catch (err) {
    console.error('[dentalBookingAdmin POST convert]', err.message);
    res.status(500).json({ error: 'Erro ao converter solicitacao' });
  }
});

// ── POST /booking/requests/:rid/reject ──
router.post('/booking/requests/:rid/reject', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { notes } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE dental_booking_requests
       SET status = 'rejeitado', notes = COALESCE($1, notes)
       WHERE id = $2 AND company_id = $3 AND status = 'pendente'
       RETURNING id`,
      [notes || null, req.params.rid, req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Solicitacao nao encontrada ou ja processada' });
    }
    res.json({ message: 'Solicitacao rejeitada' });
  } catch (err) {
    console.error('[dentalBookingAdmin POST reject]', err.message);
    res.status(500).json({ error: 'Erro ao rejeitar solicitacao' });
  }
});

module.exports = router;
