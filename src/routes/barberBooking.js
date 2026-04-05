// ============================================================
// AURA. — S8 B-12: Barber Public Booking
// Public routes for clients to request appointments
// Mounted at: /api/v1/barber/book/:slug
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

// GET /api/v1/barber/book/:slug
router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT bc.*, c.trade_name AS company_name
       FROM barber_booking_config bc
       JOIN companies c ON c.id=bc.company_id
       WHERE bc.slug=$1 AND bc.is_active=true`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agenda online nao encontrada' });
    const config = rows[0];

    // Professionals
    const { rows: pros } = await db.query(
      'SELECT id, name, color FROM barbershop_professionals WHERE company_id=$1 AND is_active=true ORDER BY name',
      [config.company_id]
    );
    // Services
    const { rows: services } = await db.query(
      'SELECT id, name, duration_min, price FROM barbershop_services WHERE company_id=$1 AND active=true ORDER BY name',
      [config.company_id]
    );

    res.json({
      company_name: config.company_name,
      welcome_msg: config.welcome_msg,
      professionals: pros,
      services,
      available_days: config.available_days,
      start_hour: config.start_hour,
      end_hour: config.end_hour,
      allow_professional_choice: config.allow_professional_choice,
      deposit_required: config.deposit_required,
      deposit_amount: config.deposit_amount,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar configuracao' });
  }
});

// POST /api/v1/barber/book/:slug
router.post('/:slug', async (req, res) => {
  const { customer_name, customer_phone, professional_id, service_id, service_name, preferred_date, preferred_time, notes } = req.body;
  if (!customer_name || !preferred_date || !preferred_time) {
    return res.status(400).json({ error: 'Nome, data e horario obrigatorios' });
  }
  try {
    const { rows: configs } = await db.query(
      'SELECT company_id, require_phone FROM barber_booking_config WHERE slug=$1 AND is_active=true', [req.params.slug]
    );
    if (!configs.length) return res.status(404).json({ error: 'Agenda nao encontrada' });
    if (configs[0].require_phone && !customer_phone) return res.status(400).json({ error: 'Telefone obrigatorio' });

    const { rows } = await db.query(
      `INSERT INTO barber_booking_requests
         (company_id, customer_name, customer_phone, professional_id, service_id, service_name, preferred_date, preferred_time, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [configs[0].company_id, customer_name, customer_phone||null, professional_id||null,
       service_id||null, service_name||null, preferred_date, preferred_time, notes||null]
    );
    res.status(201).json({ request: rows[0], message: 'Solicitacao enviada! Entraremos em contato para confirmar.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao enviar solicitacao' });
  }
});

module.exports = router;
