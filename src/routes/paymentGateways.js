// ============================================================
// AURA. — Payment Gateways (Fase 0 Mercado Pago)
// GET    /companies/:id/payment-gateways          lista gateways (tokens mascarados)
// POST   /companies/:id/payment-gateways          upsert credenciais
// DELETE /companies/:id/payment-gateways/:gateway remove gateway
//
// Migration 121: companies_payment_gateways
// Fase 0: armazena access_token + public_key do MP por empresa.
// Fases 1-2 usam esta tabela para criar pagamentos Pix e cartão.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');

// Mascara o token deixando apenas os últimos 6 chars visíveis.
// Ex: "APP_USR-1234...abcdef" → "••••••••••••abcdef"
function maskToken(token) {
  if (!token || token.length <= 6) return '••••••';
  return '•'.repeat(Math.min(token.length - 6, 20)) + token.slice(-6);
}

// Valida formato básico de credenciais MP.
// Tokens de produção: APP_USR-...
// Tokens de sandbox:  TEST-...
// Public keys: APP_USR-... ou TEST-...
function validateMpCredentials(accessToken, publicKey, sandbox) {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length < 10) {
    return 'access_token inválido';
  }
  if (!publicKey || typeof publicKey !== 'string' || publicKey.trim().length < 10) {
    return 'public_key inválido';
  }
  if (sandbox === false) {
    // Produção: tokens devem começar com APP_USR
    if (!accessToken.trim().startsWith('APP_USR-')) {
      return 'Em modo produção, access_token deve começar com APP_USR-';
    }
    if (!publicKey.trim().startsWith('APP_USR-')) {
      return 'Em modo produção, public_key deve começar com APP_USR-';
    }
  }
  return null;
}

// GET /companies/:id/payment-gateways
// Retorna lista de gateways configurados para a empresa.
// Tokens são mascarados — nunca expõe o valor real.
router.get('/', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT id, gateway, public_key, sandbox, created_at, updated_at
       FROM companies_payment_gateways
       WHERE company_id = $1
       ORDER BY created_at ASC`,
      [cid]
    );
    // Inclui access_token mascarado (nunca o real)
    const { rows: full } = await db.query(
      `SELECT gateway, access_token
       FROM companies_payment_gateways
       WHERE company_id = $1`,
      [cid]
    );
    const tokenMap = {};
    for (const r of full) tokenMap[r.gateway] = r.access_token;

    const payload = rows.map(r => ({
      id: r.id,
      gateway: r.gateway,
      access_token_masked: maskToken(tokenMap[r.gateway]),
      public_key_masked: maskToken(r.public_key),
      sandbox: r.sandbox,
      configured: true,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    res.json({ gateways: payload });
  } catch (err) {
    console.error('[payment-gateways] GET error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar gateways de pagamento' });
  }
});

// POST /companies/:id/payment-gateways
// Upsert das credenciais de um gateway.
// Body: { gateway, access_token, public_key, sandbox }
router.post('/', requireRole('client', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { gateway = 'mercadopago', access_token, public_key, sandbox = true } = req.body;

  if (!['mercadopago'].includes(gateway)) {
    return res.status(400).json({ error: 'Gateway inválido. Use: mercadopago' });
  }

  const validationError = validateMpCredentials(access_token, public_key, sandbox);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO companies_payment_gateways
         (company_id, gateway, access_token, public_key, sandbox)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, gateway) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         public_key   = EXCLUDED.public_key,
         sandbox      = EXCLUDED.sandbox,
         updated_at   = NOW()
       RETURNING id, gateway, public_key, sandbox, created_at, updated_at`,
      [cid, gateway, access_token.trim(), public_key.trim(), sandbox]
    );
    const row = rows[0];
    res.json({
      gateway: row.gateway,
      access_token_masked: maskToken(access_token.trim()),
      public_key_masked: maskToken(row.public_key),
      sandbox: row.sandbox,
      configured: true,
      saved: true,
    });
  } catch (err) {
    console.error('[payment-gateways] POST error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar credenciais do gateway' });
  }
});

// DELETE /companies/:id/payment-gateways/:gateway
// Remove as credenciais de um gateway específico.
router.delete('/:gateway', requireRole('client', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { gateway } = req.params;

  if (!['mercadopago'].includes(gateway)) {
    return res.status(400).json({ error: 'Gateway inválido' });
  }

  try {
    const { rowCount } = await db.query(
      `DELETE FROM companies_payment_gateways
       WHERE company_id = $1 AND gateway = $2`,
      [cid, gateway]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Gateway não encontrado para esta empresa' });
    }
    res.json({ deleted: true, gateway });
  } catch (err) {
    console.error('[payment-gateways] DELETE error:', err.message);
    res.status(500).json({ error: 'Erro ao remover gateway' });
  }
});

module.exports = router;
