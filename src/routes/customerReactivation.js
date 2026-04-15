// ============================================================
// AURA. — Customer Reactivation Engine
// Segments + win-back analysis for dormant clients
// ============================================================
var router = require('express').Router({ mergeParams: true });
var db = require('../config/database');
var { requireAuth } = require('../middleware/auth');

// Segment thresholds (days since last purchase)
var SEGMENTS = [
  { key: 'active', label: 'Ativo', maxDays: 30, color: '#059669' },
  { key: 'at_risk', label: 'Em risco', maxDays: 60, color: '#d97706' },
  { key: 'dormant', label: 'Inativo', maxDays: 120, color: '#dc2626' },
  { key: 'lost', label: 'Perdido', maxDays: 999999, color: '#6b7280' },
];

function getSegment(daysSince) {
  for (var i = 0; i < SEGMENTS.length; i++) {
    if (daysSince <= SEGMENTS[i].maxDays) return SEGMENTS[i];
  }
  return SEGMENTS[SEGMENTS.length - 1];
}

// GET /reactivation — full reactivation dashboard
router.get('/', requireAuth, async function(req, res) {
  var cid = req.params.id;
  try {
    // 1. All customers with purchase history
    var { rows: customers } = await db.query(
      "SELECT id, name, email, phone, total_spent, total_purchases, last_purchase_at, first_purchase_at, created_at, reactivation_status, reactivation_contacted_at" +
      " FROM customers WHERE company_id=$1 AND last_purchase_at IS NOT NULL" +
      " ORDER BY last_purchase_at ASC", [cid]);

    var now = new Date();
    var segmented = customers.map(function(c) {
      var daysSince = Math.floor((now - new Date(c.last_purchase_at)) / 86400000);
      var seg = getSegment(daysSince);
      var lifetimeDays = Math.max(Math.floor((now - new Date(c.first_purchase_at || c.created_at)) / 86400000), 1);
      var frequency = (parseInt(c.total_purchases) || 0) / (lifetimeDays / 30); // purchases per month
      var avgTicket = parseInt(c.total_purchases) > 0 ? parseFloat(c.total_spent) / parseInt(c.total_purchases) : 0;

      return {
        id: c.id, name: c.name, email: c.email, phone: c.phone,
        total_spent: parseFloat(c.total_spent) || 0,
        total_purchases: parseInt(c.total_purchases) || 0,
        last_purchase_at: c.last_purchase_at,
        days_since_purchase: daysSince,
        segment: seg.key, segment_label: seg.label, segment_color: seg.color,
        avg_ticket: Math.round(avgTicket * 100) / 100,
        monthly_frequency: Math.round(frequency * 10) / 10,
        reactivation_status: c.reactivation_status || 'active',
        contacted_at: c.reactivation_contacted_at,
        // Suggestion
        suggestion: buildSuggestion(seg.key, c, avgTicket, daysSince),
      };
    });

    // 2. Segment summary
    var summary = {};
    SEGMENTS.forEach(function(s) { summary[s.key] = { label: s.label, count: 0, revenue: 0, color: s.color }; });
    segmented.forEach(function(c) {
      if (summary[c.segment]) {
        summary[c.segment].count++;
        summary[c.segment].revenue += c.total_spent;
      }
    });

    // 3. High-value dormant (priority reactivation list)
    var priority = segmented
      .filter(function(c) { return c.segment === 'at_risk' || c.segment === 'dormant'; })
      .sort(function(a, b) { return b.total_spent - a.total_spent; })
      .slice(0, 20);

    // 4. Reactivation metrics
    var totalCustomers = customers.length;
    var activeCount = segmented.filter(function(c) { return c.segment === 'active'; }).length;
    var atRiskCount = segmented.filter(function(c) { return c.segment === 'at_risk'; }).length;
    var dormantCount = segmented.filter(function(c) { return c.segment === 'dormant'; }).length;
    var lostCount = segmented.filter(function(c) { return c.segment === 'lost'; }).length;
    var retentionRate = totalCustomers > 0 ? Math.round(activeCount / totalCustomers * 100) : 0;
    var atRiskRevenue = segmented.filter(function(c) { return c.segment === 'at_risk'; }).reduce(function(s, c) { return s + c.total_spent; }, 0);
    var dormantRevenue = segmented.filter(function(c) { return c.segment === 'dormant'; }).reduce(function(s, c) { return s + c.total_spent; }, 0);

    res.json({
      metrics: {
        total_customers: totalCustomers,
        active: activeCount, at_risk: atRiskCount, dormant: dormantCount, lost: lostCount,
        retention_rate: retentionRate,
        revenue_at_risk: Math.round(atRiskRevenue),
        revenue_dormant: Math.round(dormantRevenue),
        potential_recovery: Math.round((atRiskRevenue + dormantRevenue) * 0.15), // estimated 15% recovery
      },
      segments: Object.values(summary),
      priority_reactivation: priority,
      all_customers: segmented,
    });
  } catch (err) { console.error('reactivation error:', err); res.status(500).json({ error: 'Erro ao analisar reativacao' }); }
});

// GET /reactivation/segments — just the segments summary
router.get('/segments', requireAuth, async function(req, res) {
  var cid = req.params.id;
  try {
    var { rows } = await db.query(
      "SELECT" +
      " COUNT(*) FILTER(WHERE last_purchase_at >= NOW()-INTERVAL '30 days')::int AS active," +
      " COUNT(*) FILTER(WHERE last_purchase_at >= NOW()-INTERVAL '60 days' AND last_purchase_at < NOW()-INTERVAL '30 days')::int AS at_risk," +
      " COUNT(*) FILTER(WHERE last_purchase_at >= NOW()-INTERVAL '120 days' AND last_purchase_at < NOW()-INTERVAL '60 days')::int AS dormant," +
      " COUNT(*) FILTER(WHERE last_purchase_at < NOW()-INTERVAL '120 days')::int AS lost," +
      " COUNT(*) FILTER(WHERE last_purchase_at IS NULL)::int AS never_bought" +
      " FROM customers WHERE company_id=$1", [cid]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// PATCH /reactivation/:customerId/contact — mark customer as contacted
router.patch('/:customerId/contact', requireAuth, async function(req, res) {
  var cid = req.params.id;
  var custId = req.params.customerId;
  var { method, notes } = req.body; // whatsapp | phone | email
  try {
    await db.query(
      "UPDATE customers SET reactivation_status='contacted', reactivation_contacted_at=NOW() WHERE id=$1 AND company_id=$2",
      [custId, cid]);
    // Log in alert history
    await db.query(
      "INSERT INTO alert_history (company_id, alert_type, severity, title, message, data) VALUES ($1, 'reactivation_contact', 'info', $2, $3, $4)",
      [cid, 'Cliente contatado', 'Reativacao: cliente contatado via ' + (method || 'outro'), JSON.stringify({ customer_id: custId, method: method || 'outro', notes: notes || '' })]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// Helper: Build reactivation suggestion
function buildSuggestion(segment, customer, avgTicket, daysSince) {
  var hasPhone = !!customer.phone;
  var hasEmail = !!customer.email;
  var channel = hasPhone ? 'WhatsApp' : hasEmail ? 'Email' : 'Contato direto';

  switch (segment) {
    case 'at_risk':
      return {
        action: 'Enviar mensagem de reativacao',
        channel: channel,
        offer: avgTicket > 100 ? 'Oferecer 10% de desconto na proxima compra' : 'Lembrar dos produtos favoritos',
        urgency: 'media',
        template: hasPhone
          ? 'Ola ' + customer.name + '! Sentimos sua falta. Preparamos uma condicao especial para voce. Quando podemos te atender?'
          : 'Que tal voltar? Temos novidades para voce!',
      };
    case 'dormant':
      return {
        action: 'Campanha de recuperacao',
        channel: channel,
        offer: 'Desconto de 15% ou brinde na proxima visita',
        urgency: 'alta',
        template: hasPhone
          ? 'Ola ' + customer.name + '! Faz ' + daysSince + ' dias que nao te vemos. Preparamos um desconto especial de 15% para sua volta!'
          : 'Volte com 15% de desconto! Valido por 7 dias.',
      };
    case 'lost':
      return {
        action: 'Ultima tentativa de contato',
        channel: channel,
        offer: 'Desconto agressivo de 20% ou beneficio exclusivo',
        urgency: 'baixa',
        template: 'Sentimos muito sua falta, ' + customer.name + '. Gostavamos de te reconquistar com uma oferta exclusiva.',
      };
    default:
      return null;
  }
}

module.exports = router;
