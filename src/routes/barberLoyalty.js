// ============================================================
// AURA. — S8: Barber Packages, Subscriptions, Gift Cards
// B-09, B-10, B-11 CRUD
// Mounted at: /companies/:id/barbershop/loyalty
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const crypto  = require('crypto');

// ===== B-09: PACKAGES =====

router.get('/packages', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM barber_packages WHERE company_id=$1 ORDER BY is_active DESC, name',
      [req.params.id]
    );
    res.json({ total: rows.length, packages: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar pacotes' }); }
});

router.post('/packages', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { name, description, services, total_sessions, price, original_price, validity_days } = req.body;
  if (!name || !price || !total_sessions) return res.status(400).json({ error: 'name, price e total_sessions obrigatorios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO barber_packages (company_id, name, description, services, total_sessions, price, original_price, validity_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, name, description||null, JSON.stringify(services||[]), total_sessions, price, original_price||null, validity_days||90]
    );
    res.status(201).json({ package: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao criar pacote' }); }
});

router.post('/packages/:pkgId/sell', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { customer_id, customer_name } = req.body;
  if (!customer_id && !customer_name) return res.status(400).json({ error: 'Informe customer_id ou customer_name' });
  try {
    const { rows: pkgs } = await db.query('SELECT * FROM barber_packages WHERE id=$1 AND company_id=$2', [req.params.pkgId, req.params.id]);
    if (!pkgs.length) return res.status(404).json({ error: 'Pacote nao encontrado' });
    const pkg = pkgs[0];
    const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + (pkg.validity_days || 90));
    const { rows } = await db.query(
      `INSERT INTO barber_package_purchases (company_id, package_id, customer_id, customer_name, sessions_total, amount_paid, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, pkg.id, customer_id||null, customer_name||null, pkg.total_sessions, pkg.price, expiresAt]
    );
    await db.query('UPDATE barber_packages SET sold_count=sold_count+1 WHERE id=$1', [pkg.id]);
    res.status(201).json({ purchase: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao vender pacote' }); }
});

router.patch('/purchases/:purchaseId/use', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE barber_package_purchases SET sessions_used=sessions_used+1,
       status=CASE WHEN sessions_used+1>=sessions_total THEN 'concluido' ELSE 'ativo' END
       WHERE id=$1 AND company_id=$2 AND status='ativo' RETURNING *`,
      [req.params.purchaseId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Compra nao encontrada ou ja concluida' });
    res.json({ purchase: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao usar sessao' }); }
});

// ===== B-10: SUBSCRIPTIONS =====

router.get('/subscriptions', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM barber_subscriptions WHERE company_id=$1 ORDER BY is_active DESC, name', [req.params.id]
    );
    res.json({ total: rows.length, subscriptions: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar assinaturas' }); }
});

router.post('/subscriptions', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { name, description, monthly_price, included_services } = req.body;
  if (!name || !monthly_price) return res.status(400).json({ error: 'name e monthly_price obrigatorios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO barber_subscriptions (company_id, name, description, monthly_price, included_services)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, name, description||null, monthly_price, JSON.stringify(included_services||[])]
    );
    res.status(201).json({ subscription: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao criar assinatura' }); }
});

router.post('/subscriptions/:subId/subscribe', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { customer_id, customer_name } = req.body;
  try {
    const nextBilling = new Date(); nextBilling.setMonth(nextBilling.getMonth() + 1);
    const { rows } = await db.query(
      `INSERT INTO barber_subscriber (company_id, subscription_id, customer_id, customer_name, next_billing)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, req.params.subId, customer_id||null, customer_name||null, nextBilling]
    );
    await db.query('UPDATE barber_subscriptions SET subscribers_count=subscribers_count+1 WHERE id=$1', [req.params.subId]);
    res.status(201).json({ subscriber: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao assinar' }); }
});

// ===== B-11: GIFT CARDS =====

router.get('/gift-cards', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM barber_gift_cards WHERE company_id=$1 ORDER BY created_at DESC', [req.params.id]
    );
    res.json({ total: rows.length, giftCards: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar gift cards' }); }
});

router.post('/gift-cards', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { initial_amount, buyer_name, recipient_name, message, expires_days = 365 } = req.body;
  if (!initial_amount || initial_amount <= 0) return res.status(400).json({ error: 'initial_amount obrigatorio e positivo' });
  const code = 'AURA-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + expires_days);
  try {
    const { rows } = await db.query(
      `INSERT INTO barber_gift_cards (company_id, code, initial_amount, balance, buyer_name, recipient_name, message, expires_at)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, code, initial_amount, buyer_name||null, recipient_name||null, message||null, expiresAt]
    );
    res.status(201).json({ giftCard: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao criar gift card' }); }
});

router.post('/gift-cards/redeem', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { code, amount } = req.body;
  if (!code || !amount) return res.status(400).json({ error: 'code e amount obrigatorios' });
  try {
    const { rows } = await db.query(
      `UPDATE barber_gift_cards SET balance=balance-$1,
       status=CASE WHEN balance-$1<=0 THEN 'usado' ELSE 'ativo' END,
       redeemed_at=CASE WHEN redeemed_at IS NULL THEN NOW() ELSE redeemed_at END
       WHERE code=$2 AND company_id=$3 AND status='ativo' AND balance>=$1 RETURNING *`,
      [amount, code, req.params.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'Gift card invalido, expirado ou saldo insuficiente' });
    res.json({ giftCard: rows[0], message: `R$ ${amount} debitado. Saldo restante: R$ ${rows[0].balance}` });
  } catch (err) { res.status(500).json({ error: 'Erro ao resgatar gift card' }); }
});

module.exports = router;
