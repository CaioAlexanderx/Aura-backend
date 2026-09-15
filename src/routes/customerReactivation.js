// ============================================================
// AURA. — Customer Reactivation Engine
// Segments + win-back analysis for dormant clients
// ============================================================
var router = require('express').Router({ mergeParams: true });
var db = require('../config/database');
var { requireAuth } = require('../middleware/auth');
// FASE 7: a lista de quem sumiu deixa de ser só uma lista — ela envia.
var mkt = require('../services/marketing/marketingCommon');
var reactivationAuto = require('../services/marketing/reactivationAuto');

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

// ============================================================
// FASE 7 — envio de reativação pelo WhatsApp oficial (MARKETING)
//
// O PATCH /:customerId/contact acima continua sendo o registro do
// contato MANUAL e não mudou de comportamento. As rotas abaixo são a
// pista automática: cada mensagem é um template de categoria MARKETING
// na Meta e custa dinheiro — por isso a prévia existe, o limite por
// disparo é baixo e todas as guardas do waOutbox valem.
// ============================================================

// GET /reactivation/settings — estado do interruptor para a tela
router.get('/settings', requireAuth, async function (req, res) {
  try {
    var settings = await mkt.loadMarketingSettings(req.params.id);
    res.json({
      wa_reactivation_auto: settings.wa_reactivation_auto,
      wa_marketing_consent_at: settings.wa_marketing_consent_at,
      reactivation_coupon_defaults: {
        ...mkt.DEFAULTS[mkt.KIND_REATIVACAO],
        ...(settings.reactivation_coupon_defaults || {}),
      },
      template_name: mkt.TEMPLATE_REATIVACAO,
      schema_pending: settings.schema_pending,
    });
  } catch (err) {
    console.error('[reactivation] settings get:', err.message);
    res.status(500).json({ error: 'Erro ao carregar as configuracoes de reativacao' });
  }
});

// PUT /reactivation/settings — body { wa_reactivation_auto?, reactivation_coupon_defaults? }
// Ligar passa pelos quatro portões; DESLIGAR é sempre livre (travar quem
// quer parar de mandar mensagem seria o contrário do que a guarda serve).
router.put('/settings', requireAuth, async function (req, res) {
  var body = req.body || {};
  var querAuto = body.wa_reactivation_auto === true || body.wa_reactivation_auto === 'true';
  try {
    if (querAuto) {
      var gate = await mkt.marketingGate(req.params.id, mkt.TEMPLATE_REATIVACAO);
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });
    }

    if (body.reactivation_coupon_defaults !== undefined) {
      var limpo = {};
      for (var k of Object.keys(mkt.DEFAULTS[mkt.KIND_REATIVACAO])) {
        if (body.reactivation_coupon_defaults[k] !== undefined) {
          limpo[k] = body.reactivation_coupon_defaults[k];
        }
      }
      if (limpo.discount_type && ['percent', 'fixed'].indexOf(limpo.discount_type) === -1) {
        return res.status(400).json({ error: 'discount_type invalido' });
      }
      if (limpo.discount_value !== undefined && !(parseFloat(limpo.discount_value) > 0)) {
        return res.status(400).json({ error: 'discount_value deve ser > 0' });
      }
      try {
        await db.query(
          "-- mkt:react-defaults-set\n" +
          " UPDATE companies SET reactivation_coupon_defaults = $2 WHERE id = $1",
          [req.params.id, JSON.stringify(limpo)]
        );
      } catch (e) {
        if (!mkt.schemaMissing(e)) throw e;
        return res.status(503).json({
          error: 'A reativacao automatica ainda nao esta disponivel neste ambiente (migracao 331 pendente).',
          code: 'SCHEMA_PENDING',
        });
      }
    }

    if (body.wa_reactivation_auto !== undefined) {
      var ok = await mkt.setAutoFlag(req.params.id, 'wa_reactivation_auto', querAuto);
      if (!ok) {
        return res.status(503).json({
          error: 'A reativacao automatica ainda nao esta disponivel neste ambiente (migracao 331 pendente).',
          code: 'SCHEMA_PENDING',
        });
      }
    }

    var settings = await mkt.loadMarketingSettings(req.params.id);
    res.json({
      ok: true,
      wa_reactivation_auto: settings.wa_reactivation_auto,
      reactivation_coupon_defaults: settings.reactivation_coupon_defaults,
    });
  } catch (err) {
    console.error('[reactivation] settings put:', err.message);
    res.status(500).json({ error: 'Erro ao salvar as configuracoes de reativacao' });
  }
});

// GET /reactivation/preview?segment=&limit= — quem receberia HOJE, sem
// enfileirar nada. Mesmo shape das prévias do dojô e do crediário.
router.get('/preview', requireAuth, async function (req, res) {
  try {
    var r = await reactivationAuto.runForCompany(req.params.id, {
      today: req.query.date ? String(req.query.date).trim() : null,
      dryRun: true,
      segment: req.query.segment,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 30,
    });
    res.json({
      source: 'reativacao',
      segment: r.segment,
      template_name: mkt.TEMPLATE_REATIVACAO,
      would_send: r.enqueued || 0,
      skipped: r.skipped || {},
      skipped_reason: r.skipped_reason || null,
      items: (r.items || []).map(function (it) {
        return {
          customer_id: it.customer_id,
          customer_name: it.customer_name,
          phone_masked: maskPhone(it.phone),
          total_spent: it.total_spent,
          days_since: it.days_since,
          reason: it.reason,
        };
      }),
    });
  } catch (err) {
    console.error('[reactivation] preview:', err.message);
    res.status(500).json({ error: 'Erro ao montar a previa de reativacao' });
  }
});

// POST /reactivation/send — body { segment?, limit?, customer_ids? }
// Envio IMEDIATO (não é job): a confirmação de custo é feita na tela,
// que mostra a prévia antes. Teto de 50 por disparo — marketing em
// volume derruba a qualidade do número, e o que é enfileirado ainda
// passa pelo teto diário de marketing.
router.post('/send', requireAuth, async function (req, res) {
  var body = req.body || {};
  var ids = Array.isArray(body.customer_ids) && body.customer_ids.length
    ? body.customer_ids.map(String).slice(0, 50)
    : null;
  var limite = Math.min(parseInt(body.limit, 10) || 30, 50);
  try {
    var gate = await mkt.marketingGate(req.params.id, mkt.TEMPLATE_REATIVACAO);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });

    var r = await reactivationAuto.runForCompany(req.params.id, {
      today: body.date ? String(body.date).trim() : null,
      segment: body.segment,
      limit: ids ? ids.length : limite,
      customerIds: ids,
    });
    res.json({
      queued: r.enqueued || 0,
      segment: r.segment,
      skipped: r.skipped || {},
      skipped_reason: r.skipped_reason || null,
    });
  } catch (err) {
    console.error('[reactivation] send:', err.message);
    res.status(500).json({ error: 'Erro ao enviar as mensagens de reativacao' });
  }
});

// Só os 4 últimos dígitos: a prévia é sobre CONTAGEM, não sobre expor o
// telefone de cliente para quem abre a tela.
function maskPhone(p) {
  var d = String(p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length <= 4) return '***' + d;
  return '***' + d.slice(-4);
}

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
