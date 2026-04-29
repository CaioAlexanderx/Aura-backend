// ============================================================
// AURA. — Cupons de aniversário + histórico de envios
// Mounted at: /companies/:id/birthday
//
// Rotas:
//   GET  /settings        — defaults editáveis + template de msg
//   PUT  /settings        — atualiza defaults (owner/admin)
//   POST /create-coupon   — cria cupom marcado como source='birthday'
//                           (owner/admin, vínculo customer_id)
//   POST /send-log        — registra envio (idempotente por
//                           company+customer+ano)
//   GET  /sent-this-year  — quem já recebeu este ano (pro card)
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// ── helpers ────────────────────────────────────────────────
const DEFAULTS_FALLBACK = {
  discount_type:    'percent',  // 'percent' | 'fixed'
  discount_value:   10,         // 10% ou R$ 10
  validity_days:    7,          // expires_at = today + 7
  min_order_value:  0,
  max_uses:         1,
};

const TEMPLATE_FALLBACK =
  'Oi, {{nome}}! 🎉\n' +
  'A {{empresa}} preparou um presente pelo seu aniversário: ' +
  '{{descricao_desconto}} usando o cupom *{{cupom}}*, válido até {{validade}}.\n' +
  'Conta com a gente pra comemorar!';

function requireOwnerOrAdmin(req, res, next) {
  // companyRole vem de requireCompanyAccess (já aplicado no private.js)
  if (req.companyRole !== 'owner' && req.companyRole !== 'admin') {
    return res.status(403).json({
      error: 'Apenas owner ou admin podem criar cupons de aniversário',
      your_role: req.companyRole,
    });
  }
  next();
}

// ── GET /settings ──────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT birthday_coupon_defaults, birthday_message_template, name
         FROM companies WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });

    const defaults = { ...DEFAULTS_FALLBACK, ...(rows[0].birthday_coupon_defaults || {}) };
    const template = rows[0].birthday_message_template || TEMPLATE_FALLBACK;

    res.json({
      defaults,
      template,
      // Flag pro front saber se já foi configurado uma vez
      configured: !!rows[0].birthday_message_template ||
                  Object.keys(rows[0].birthday_coupon_defaults || {}).length > 0,
    });
  } catch (err) {
    console.error('[birthday] settings get:', err.message);
    res.status(500).json({ error: 'Erro ao carregar configurações de aniversário' });
  }
});

// ── PUT /settings ──────────────────────────────────────────
router.put('/settings', requireOwnerOrAdmin, async (req, res) => {
  const { defaults, template } = req.body || {};
  const updates = []; const values = []; let idx = 1;

  if (defaults !== undefined) {
    // Sanitização: só aceita chaves conhecidas
    const clean = {};
    for (const k of Object.keys(DEFAULTS_FALLBACK)) {
      if (defaults[k] !== undefined) clean[k] = defaults[k];
    }
    // Validação leve
    if (clean.discount_type && !['percent', 'fixed'].includes(clean.discount_type)) {
      return res.status(400).json({ error: 'discount_type inválido' });
    }
    if (clean.discount_value !== undefined && (isNaN(parseFloat(clean.discount_value)) || parseFloat(clean.discount_value) <= 0)) {
      return res.status(400).json({ error: 'discount_value deve ser > 0' });
    }
    updates.push(`birthday_coupon_defaults = $${idx++}`);
    values.push(JSON.stringify(clean));
  }

  if (template !== undefined) {
    if (typeof template !== 'string' || template.length > 2000) {
      return res.status(400).json({ error: 'template inválido (máx 2000 chars)' });
    }
    updates.push(`birthday_message_template = $${idx++}`);
    values.push(template);
  }

  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar' });

  try {
    values.push(req.params.id);
    await db.query(
      `UPDATE companies SET ${updates.join(', ')} WHERE id = $${idx}`,
      values
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[birthday] settings put:', err.message);
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});

// ── POST /create-coupon ────────────────────────────────────
// Body: { customer_id, code?, description?, discount_type?,
//         discount_value?, validity_days?, min_order_value?, max_uses? }
//
// Cria cupom marcado com source='birthday'. Code é gerado se não
// vier (formato: ANIV-<PRIMEIRONOME>-<YY>). Validade calculada via
// validity_days se expires_at não vier explícito.
router.post('/create-coupon', requireOwnerOrAdmin, async (req, res) => {
  const { customer_id } = req.body || {};
  if (!customer_id) {
    return res.status(400).json({ error: 'customer_id obrigatório' });
  }

  try {
    // 1. Carrega cliente + defaults da empresa numa única round-trip
    const { rows: ctxRows } = await db.query(
      `SELECT
         c.id, c.name, c.marketing_opt_out,
         comp.birthday_coupon_defaults
       FROM customers c
       JOIN companies comp ON comp.id = c.company_id
       WHERE c.id = $1 AND c.company_id = $2 AND c.is_active = true`,
      [customer_id, req.params.id]
    );
    if (!ctxRows.length) {
      return res.status(404).json({ error: 'Cliente não encontrado' });
    }
    const customer = ctxRows[0];
    const defaults = { ...DEFAULTS_FALLBACK, ...(customer.birthday_coupon_defaults || {}) };

    // 2. Resolve campos do cupom (body > defaults)
    const discount_type   = req.body.discount_type   || defaults.discount_type;
    const discount_value  = parseFloat(req.body.discount_value ?? defaults.discount_value);
    const min_order_value = parseFloat(req.body.min_order_value ?? defaults.min_order_value ?? 0);
    const max_uses        = req.body.max_uses ?? defaults.max_uses ?? 1;
    const validity_days   = parseInt(req.body.validity_days ?? defaults.validity_days ?? 7);
    const description     = req.body.description || `Aniversário de ${customer.name}`;

    if (isNaN(discount_value) || discount_value <= 0) {
      return res.status(400).json({ error: 'discount_value inválido' });
    }
    if (!['percent', 'fixed'].includes(discount_type)) {
      return res.status(400).json({ error: 'discount_type inválido' });
    }

    // 3. expires_at = hoje + validity_days, fim do dia
    const expires = new Date();
    expires.setDate(expires.getDate() + validity_days);
    expires.setHours(23, 59, 59, 999);

    // 4. Gera código se não vier
    let code = req.body.code
      ? String(req.body.code).toUpperCase().trim()
      : generateBirthdayCode(customer.name);

    // Garante unicidade (até 5 tentativas com sufixo)
    let attempt = 0;
    while (attempt < 5) {
      const { rows: existing } = await db.query(
        `SELECT 1 FROM coupons WHERE company_id = $1 AND code = $2`,
        [req.params.id, code]
      );
      if (!existing.length) break;
      attempt++;
      code = generateBirthdayCode(customer.name, attempt);
    }

    // 5. INSERT
    const { rows } = await db.query(
      `INSERT INTO coupons (company_id, code, description, discount_type, discount_value,
                            min_order_value, max_uses, expires_at, customer_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'birthday')
       RETURNING *`,
      [req.params.id, code, description, discount_type, discount_value,
       min_order_value, max_uses, expires.toISOString(), customer_id]
    );

    res.status(201).json({
      coupon: rows[0],
      customer: { id: customer.id, name: customer.name, opted_out: customer.marketing_opt_out },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Não foi possível gerar código único — tente informar um manualmente' });
    }
    console.error('[birthday] create-coupon:', err.message);
    res.status(500).json({ error: 'Erro ao criar cupom de aniversário' });
  }
});

// ── POST /send-log ─────────────────────────────────────────
// Body: { customer_id, coupon_id?, method='wa_link', message? }
// Idempotente por (company_id, customer_id, birthday_year)
router.post('/send-log', async (req, res) => {
  const { customer_id, coupon_id, method = 'wa_link', message } = req.body || {};
  if (!customer_id) return res.status(400).json({ error: 'customer_id obrigatório' });
  if (!['wa_link', 'wa_api', 'sms', 'email'].includes(method)) {
    return res.status(400).json({ error: 'method inválido' });
  }

  const year = new Date().getFullYear();

  try {
    const { rows } = await db.query(
      `INSERT INTO birthday_messages_sent
         (company_id, customer_id, coupon_id, method, birthday_year, user_id, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, customer_id, birthday_year)
       DO UPDATE SET
         coupon_id = EXCLUDED.coupon_id,
         method    = EXCLUDED.method,
         message   = EXCLUDED.message,
         sent_at   = NOW()
       RETURNING *`,
      [req.params.id, customer_id, coupon_id || null, method, year,
       req.user?.id || null, message || null]
    );
    res.status(201).json({ log: rows[0] });
  } catch (err) {
    console.error('[birthday] send-log:', err.message);
    res.status(500).json({ error: 'Erro ao registrar envio' });
  }
});

// ── GET /sent-this-year ────────────────────────────────────
// Retorna IDs dos clientes que já receberam mensagem de aniversário
// no ano corrente. Usado pelo card pra mostrar badge ✓.
router.get('/sent-this-year', async (req, res) => {
  const year = new Date().getFullYear();
  try {
    const { rows } = await db.query(
      `SELECT customer_id, sent_at, method, coupon_id
         FROM birthday_messages_sent
        WHERE company_id = $1 AND birthday_year = $2`,
      [req.params.id, year]
    );
    res.json({ year, total: rows.length, sent: rows });
  } catch (err) {
    console.error('[birthday] sent-this-year:', err.message);
    res.status(500).json({ error: 'Erro ao listar envios' });
  }
});

// ── helpers internos ───────────────────────────────────────
function generateBirthdayCode(customerName, attempt = 0) {
  const raw = String(customerName || 'CLIENTE')
    .trim()
    .split(/\s+/)[0]
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // remove acentos (combining marks)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);
  const first = raw || 'CLIENTE';
  const yy = String(new Date().getFullYear()).slice(-2);
  const suffix = attempt > 0 ? `-${attempt + 1}` : '';
  return `ANIV-${first}-${yy}${suffix}`;
}

module.exports = router;
