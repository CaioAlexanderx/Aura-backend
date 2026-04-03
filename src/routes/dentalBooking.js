// ============================================================
// AURA. — D-11: Dental Public Booking
// Public route for patients to request appointments
// Mounted at: /api/v1/dental/book/:slug
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

// GET /api/v1/dental/book/:slug — public booking page config
router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT bc.*, c.trade_name AS company_name, c.id AS company_id
       FROM dental_booking_config bc
       JOIN companies c ON c.id=bc.company_id
       WHERE bc.slug=$1 AND bc.is_active=true`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agenda online nao encontrada ou desativada' });

    const config = rows[0];

    // Get available slots for next 7 days
    const today = new Date();
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + Math.min(config.max_advance_days, 14));

    const { rows: existingAppts } = await db.query(
      `SELECT scheduled_at, duration_min FROM dental_appointments
       WHERE company_id=$1 AND scheduled_at >= $2 AND scheduled_at <= $3
       AND status NOT IN ('cancelado')`,
      [config.company_id, today.toISOString(), endDate.toISOString()]
    );

    res.json({
      company_name: config.company_name,
      welcome_msg: config.welcome_msg,
      slot_duration_min: config.slot_duration_min,
      available_days: config.available_days,
      start_hour: config.start_hour,
      end_hour: config.end_hour,
      require_phone: config.require_phone,
      min_advance_hours: config.min_advance_hours,
      max_advance_days: config.max_advance_days,
      booked_slots: existingAppts.map(a => ({
        start: a.scheduled_at,
        duration: a.duration_min,
      })),
    });
  } catch (err) {
    console.error('booking config error:', err);
    res.status(500).json({ error: 'Erro ao buscar configuracao' });
  }
});

// POST /api/v1/dental/book/:slug — submit booking request
router.post('/:slug', async (req, res) => {
  const { patient_name, patient_phone, patient_email, preferred_date, preferred_time, chief_complaint } = req.body;
  if (!patient_name || !preferred_date || !preferred_time) {
    return res.status(400).json({ error: 'Nome, data e horario sao obrigatorios' });
  }

  try {
    const { rows: configs } = await db.query(
      `SELECT bc.company_id, bc.require_phone FROM dental_booking_config bc WHERE bc.slug=$1 AND bc.is_active=true`,
      [req.params.slug]
    );
    if (!configs.length) return res.status(404).json({ error: 'Agenda nao encontrada' });

    const config = configs[0];
    if (config.require_phone && !patient_phone) {
      return res.status(400).json({ error: 'Telefone e obrigatorio' });
    }

    const { rows } = await db.query(
      `INSERT INTO dental_booking_requests
         (company_id, patient_name, patient_phone, patient_email, preferred_date, preferred_time, chief_complaint)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [config.company_id, patient_name, patient_phone || null, patient_email || null,
       preferred_date, preferred_time, chief_complaint || null]
    );

    res.status(201).json({
      request: rows[0],
      message: 'Solicitacao de agendamento enviada! A clinica entrara em contato para confirmar.',
    });
  } catch (err) {
    console.error('booking request error:', err);
    res.status(500).json({ error: 'Erro ao enviar solicitacao' });
  }
});

module.exports = router;
