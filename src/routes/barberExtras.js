// ============================================================
// AURA. — S11 B-19: Loyalty Points Program
// B-20: Fractional stock usage
// B-21: Google Business Profile booking config
// Mounted at: /companies/:id/barbershop/extras
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// ===== B-19: LOYALTY POINTS =====

router.get('/loyalty/config', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM barber_loyalty_config WHERE company_id=$1', [req.params.id]);
    res.json({ config: rows[0] || null });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar config fidelidade' }); }
});

router.post('/loyalty/config', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { is_active, points_per_real, redemption_rate, welcome_points, birthday_bonus, referral_points, expiry_months } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO barber_loyalty_config (company_id, is_active, points_per_real, redemption_rate, welcome_points, birthday_bonus, referral_points, expiry_months)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id) DO UPDATE SET
         is_active=COALESCE($2, barber_loyalty_config.is_active),
         points_per_real=COALESCE($3, barber_loyalty_config.points_per_real),
         redemption_rate=COALESCE($4, barber_loyalty_config.redemption_rate),
         welcome_points=COALESCE($5, barber_loyalty_config.welcome_points),
         birthday_bonus=COALESCE($6, barber_loyalty_config.birthday_bonus),
         referral_points=COALESCE($7, barber_loyalty_config.referral_points),
         expiry_months=COALESCE($8, barber_loyalty_config.expiry_months),
         updated_at=NOW()
       RETURNING *`,
      [req.params.id, is_active??false, points_per_real||1, redemption_rate||100, welcome_points||0, birthday_bonus||0, referral_points||0, expiry_months||12]
    );
    res.json({ config: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar config' }); }
});

router.get('/loyalty/balance/:customerId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(points),0)::int AS balance,
              COALESCE(SUM(CASE WHEN type='earn' THEN points ELSE 0 END),0)::int AS total_earned,
              COALESCE(SUM(CASE WHEN type='redeem' THEN ABS(points) ELSE 0 END),0)::int AS total_redeemed
       FROM barber_loyalty_points WHERE company_id=$1 AND customer_id=$2`,
      [req.params.id, req.params.customerId]
    );
    const { rows: history } = await db.query(
      'SELECT * FROM barber_loyalty_points WHERE company_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 20',
      [req.params.id, req.params.customerId]
    );
    res.json({ ...rows[0], history });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar saldo' }); }
});

router.post('/loyalty/earn', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { customer_id, amount_spent, description, reference_id, type = 'earn' } = req.body;
  if (!customer_id) return res.status(400).json({ error: 'customer_id obrigatorio' });
  try {
    const { rows: configs } = await db.query('SELECT * FROM barber_loyalty_config WHERE company_id=$1', [req.params.id]);
    if (!configs.length || !configs[0].is_active) return res.status(400).json({ error: 'Programa de fidelidade nao ativo' });
    const points = type === 'earn' ? Math.floor((amount_spent || 0) * configs[0].points_per_real) : (req.body.points || 0);
    const expiresAt = new Date(); expiresAt.setMonth(expiresAt.getMonth() + configs[0].expiry_months);
    const { rows } = await db.query(
      `INSERT INTO barber_loyalty_points (company_id, customer_id, points, type, description, reference_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, customer_id, points, type, description||`${points} pontos`, reference_id||null, expiresAt]
    );
    res.status(201).json({ entry: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao creditar pontos' }); }
});

router.post('/loyalty/redeem', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { customer_id, points, description } = req.body;
  if (!customer_id || !points || points <= 0) return res.status(400).json({ error: 'customer_id e points obrigatorios' });
  try {
    const { rows: bal } = await db.query(
      'SELECT COALESCE(SUM(points),0)::int AS balance FROM barber_loyalty_points WHERE company_id=$1 AND customer_id=$2',
      [req.params.id, customer_id]
    );
    if (bal[0].balance < points) return res.status(400).json({ error: `Saldo insuficiente. Disponivel: ${bal[0].balance} pontos` });
    const { rows: configs } = await db.query('SELECT redemption_rate FROM barber_loyalty_config WHERE company_id=$1', [req.params.id]);
    const discount = Math.round(points / (configs[0]?.redemption_rate || 100) * 100) / 100;
    const { rows } = await db.query(
      `INSERT INTO barber_loyalty_points (company_id, customer_id, points, type, description)
       VALUES ($1,$2,$3,'redeem',$4) RETURNING *`,
      [req.params.id, customer_id, -points, description||`Resgate ${points} pts = R$ ${discount} desconto`]
    );
    res.status(201).json({ entry: rows[0], discount_value: discount, remaining_balance: bal[0].balance - points });
  } catch (err) { res.status(500).json({ error: 'Erro ao resgatar pontos' }); }
});

// Leaderboard
router.get('/loyalty/leaderboard', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT lp.customer_id, c.name AS customer_name, COALESCE(SUM(lp.points),0)::int AS balance
       FROM barber_loyalty_points lp
       JOIN customers c ON c.id=lp.customer_id
       WHERE lp.company_id=$1
       GROUP BY lp.customer_id, c.name
       HAVING SUM(lp.points) > 0
       ORDER BY balance DESC LIMIT 20`,
      [req.params.id]
    );
    res.json({ leaderboard: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar ranking' }); }
});

// ===== B-20: FRACTIONAL STOCK USAGE =====

router.post('/stock-usage', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { product_id, professional_id, appointment_id, quantity_used, unit, notes } = req.body;
  if (!product_id || !quantity_used || !unit) return res.status(400).json({ error: 'product_id, quantity_used e unit obrigatorios' });
  try {
    // Record usage
    const { rows } = await db.query(
      `INSERT INTO barber_stock_usage (company_id, product_id, professional_id, appointment_id, quantity_used, unit, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, product_id, professional_id||null, appointment_id||null, quantity_used, unit, notes||null]
    );
    // Debit from fractional stock
    await db.query(
      'UPDATE products SET stock_fraction=GREATEST(stock_fraction-$1,0), updated_at=NOW() WHERE id=$2 AND company_id=$3',
      [quantity_used, product_id, req.params.id]
    );
    res.status(201).json({ usage: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao registrar uso' }); }
});

router.get('/stock-usage', requireAuth, async (req, res) => {
  const { product_id, start, end } = req.query;
  try {
    const params = [req.params.id];
    let where = 'WHERE su.company_id=$1';
    if (product_id) { params.push(product_id); where += ` AND su.product_id=$${params.length}`; }
    if (start) { params.push(start); where += ` AND su.used_at>=$${params.length}`; }
    if (end) { params.push(end); where += ` AND su.used_at<=$${params.length}`; }
    const { rows } = await db.query(
      `SELECT su.*, p.name AS product_name, bp.name AS professional_name
       FROM barber_stock_usage su
       JOIN products p ON p.id=su.product_id
       LEFT JOIN barbershop_professionals bp ON bp.id=su.professional_id
       ${where} ORDER BY su.used_at DESC LIMIT 100`, params
    );
    // Summary by product
    const { rows: summary } = await db.query(
      `SELECT p.id, p.name, p.stock_fraction, p.fraction_unit,
              COALESCE(SUM(su.quantity_used),0)::numeric AS total_used
       FROM barber_stock_usage su
       JOIN products p ON p.id=su.product_id
       WHERE su.company_id=$1
       GROUP BY p.id, p.name, p.stock_fraction, p.fraction_unit
       ORDER BY total_used DESC`, [req.params.id]
    );
    res.json({ total: rows.length, usage: rows, summary });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar uso' }); }
});

// ===== B-21: GOOGLE BOOKING CONFIG =====

router.get('/google-booking', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM barber_google_booking WHERE company_id=$1', [req.params.id]);
    res.json({ config: rows[0] || null });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar config Google' }); }
});

router.post('/google-booking', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { is_active, google_place_id, business_name, business_url, sync_services, sync_availability, auto_accept } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO barber_google_booking (company_id, is_active, google_place_id, business_name, business_url, sync_services, sync_availability, auto_accept)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id) DO UPDATE SET
         is_active=COALESCE($2, barber_google_booking.is_active),
         google_place_id=COALESCE($3, barber_google_booking.google_place_id),
         business_name=COALESCE($4, barber_google_booking.business_name),
         business_url=COALESCE($5, barber_google_booking.business_url),
         sync_services=COALESCE($6, barber_google_booking.sync_services),
         sync_availability=COALESCE($7, barber_google_booking.sync_availability),
         auto_accept=COALESCE($8, barber_google_booking.auto_accept),
         updated_at=NOW()
       RETURNING *`,
      [req.params.id, is_active??false, google_place_id||null, business_name||null, business_url||null, sync_services??true, sync_availability??true, auto_accept??false]
    );
    res.json({ config: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar config Google' }); }
});

module.exports = router;
