// ============================================================
// AURA. — D-11: Dental Public Booking
// Public route for patients to request appointments
// Mounted at: /api/v1/dental/book/:slug
//
// Horário de funcionamento (17/09/2026): os horários oferecidos vêm de
// services/dentalHours.effectiveOnlineHours — horário da clínica, ou a
// interseção dele com a janela online. A resposta ganha `day_windows`
// ({ '0'..'6': [{start,end}] }, chave = Date.getDay(), 0 = domingo) e
// `hours_source`; start_hour/end_hour/available_days/slot_duration_min
// passam a ser os EFETIVOS (resumo) para o app antigo continuar funcionando.
// Sem horário da clínica salvo, tudo segue como antes (source 'legacy').
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const H       = require('../services/dentalHours');

async function effectiveFor(config) {
  let clinic = { configured: false, hours: null, default_interval_min: null };
  try {
    clinic = await H.loadClinicHours(db, config.company_id);
  } catch (err) {
    console.error('booking clinic hours error:', err.message);
  }
  return H.effectiveOnlineHours(clinic, config);
}

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
       AND status::text NOT IN ('cancelado','faltou','falta_justificada')`,
      [config.company_id, today.toISOString(), endDate.toISOString()]
    );

    const eff = await effectiveFor(config);
    const legacy = eff.source === 'legacy';
    const openDays = eff.hours.filter((d) => d.open);
    const allShifts = openDays.flatMap((d) => d.shifts);
    const summary = {
      available_days: openDays.map((d) => H.toJsDay(d.weekday)).sort((a, b) => a - b),
      start_hour: allShifts.length
        ? Math.floor(Math.min(...allShifts.map((x) => H.toMinutes(x.start))) / 60) : config.start_hour,
      end_hour: allShifts.length
        ? Math.ceil(Math.max(...allShifts.map((x) => H.toMinutes(x.end))) / 60) : config.end_hour,
    };

    res.json({
      company_name: config.company_name,
      welcome_msg: config.welcome_msg,
      slot_duration_min: eff.slot_duration_min,
      available_days: legacy ? config.available_days : summary.available_days,
      start_hour: legacy ? config.start_hour : summary.start_hour,
      end_hour: legacy ? config.end_hour : summary.end_hour,
      hours_source: eff.source,
      day_windows: H.toDayWindows(eff.hours),
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
      `SELECT bc.* FROM dental_booking_config bc WHERE bc.slug=$1 AND bc.is_active=true`,
      [req.params.slug]
    );
    if (!configs.length) return res.status(404).json({ error: 'Agenda nao encontrada' });

    const config = configs[0];
    if (config.require_phone && !patient_phone) {
      return res.status(400).json({ error: 'Telefone e obrigatorio' });
    }

    // Com horario da clinica (ou janela online), o pedido precisa cair num
    // dos horarios oferecidos. Sem horario salvo, segue como antes.
    const eff = await effectiveFor(config);
    if (eff.source !== 'legacy'
        && !H.isOfferedSlot(eff.hours, eff.slot_duration_min, preferred_date, preferred_time)) {
      return res.status(400).json({
        error: 'Esse horario nao esta disponivel para agendamento online. Escolha outro horario.',
        code: 'OUTSIDE_ONLINE_HOURS',
      });
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
