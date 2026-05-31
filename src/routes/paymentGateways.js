// ============================================================
// AURA. — Payment Gateways (Fase 0 Mercado Pago)
// GET    /companies/:id/payment-gateways          lista gateways (tokens mascarados)
// POST   /companies/:id/payment-gateways          upsert credenciais
// DELETE /companies/:id/payment-gateways/:gateway remove gateway
//
// Migration 121: companies_payment_gateways
// Fase 0: armazena access_token + public_key do MP por empresa.
// Fases 1-2 usam esta tabela para criar pagamentos Pix e cartão.
// Migration 121 (21/05/2026): adiciona webhook_secret para validação
// HMAC x-signature do webhook MP. Opcional (NULL = fallback legado).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');

function maskToken(token) {
  if (!token || token.length <= 6) return '••••••';
  return '•'.repeat(Math.min(token.length - 6, 20)) + token.slice(-6);
}

function maskSecret(secret) {
  if (!secret) return null;
  if (secret.length <= 4) return '••••';
  return '•'.repeat(Math.min(secret.length - 4, 16)) + secret.slice(-4);
}

function validateMpCredentials(accessToken, publicKey, sandbox) {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length < 10) {
    return 'access_token inválido';
  }
  if (!publicKey || typeof publicKey !== 'string' || publicKey.trim().length < 10) {
    return 'public_key inválido';
  }
  if (sandbox === false) {
    if (!accessToken.trim().startsWith('APP_USR-')) {
      return 'Em modo produção, access_token deve começar com APP_USR-';
    }
    if (!publicKey.trim().startsWith('APP_USR-')) {
      return 'Em modo produção, public_key deve começar com APP_USR-';
    }
  }
  return null;
}

// Cache da existência da coluna webhook_secret (migration 121).
let _webhookSecretColumnCache = null;
async function hasWebhookSecretColumn() {
  if (_webhookSecretColumnCache !== null) return _webhookSecretColumnCache;
  try {
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'companies_payment_gateways'
         AND column_name = 'webhook_secret'
    `);
    _webhookSecretColumnCache = rows.length === 1;
  } catch { _webhookSecretColumnCache = false; }
  return _webhookSecretColumnCache;
}

router.get('/', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  try {
    const hasSecret = await hasWebhookSecretColumn();
    const cols = hasSecret
      ? 'id, gateway, public_key, sandbox, webhook_secret, created_at, updated_at'
      : 'id, gateway, public_key, sandbox, created_at, updated_at';
    const { rows } = await db.query(
      `SELECT ${cols} FROM companies_payment_gateways WHERE company_id = $1 ORDER BY created_at ASC`,
      [cid]
    );
    const { rows: full } = await db.query(
      `SELECT gateway, access_token FROM companies_payment_gateways WHERE company_id = $1`,
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
      // Migration 121: webhook_secret cadastrado? (não retorna o valor real)
      webhook_secret_masked: hasSecret ? maskSecret(r.webhook_secret) : null,
      webhook_secret_configured: hasSecret ? !!r.webhook_secret : false,
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

// POST upsert
// Body: { gateway, access_token, public_key, sandbox, webhook_secret? }
// webhook_secret é opcional. String vazia ou null limpa o campo.
router.post('/', requireRole('client', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const {
    gateway = 'mercadopago',
    access_token,
    public_key,
    sandbox = true,
    webhook_secret,  // opcional
  } = req.body;

  if (!['mercadopago'].includes(gateway)) {
    return res.status(400).json({ error: 'Gateway inválido. Use: mercadopago' });
  }

  const validationError = validateMpCredentials(access_token, public_key, sandbox);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  // webhook_secret: sanitiza para null quando vazio. Quando presente, exige
  // mínimo de 16 chars (chaves MP têm 64+ chars; abaixo disso é claramente
  // input errado tipo Client ID).
  let webhookSecretClean = undefined; // undefined = não passar pro UPDATE
  if (webhook_secret !== undefined) {
    if (webhook_secret === null || (typeof webhook_secret === 'string' && webhook_secret.trim() === '')) {
      webhookSecretClean = null;
    } else if (typeof webhook_secret === 'string' && webhook_secret.trim().length >= 16) {
      webhookSecretClean = webhook_secret.trim();
    } else {
      return res.status(400).json({ error: 'webhook_secret muito curto. Cole a chave secreta completa do painel MP (Webhooks → Configuração de chave secreta).' });
    }
  }

  try {
    const hasSecret = await hasWebhookSecretColumn();
    const includeSecret = hasSecret && webhookSecretClean !== undefined;

    let sql, params;
    if (includeSecret) {
      sql = `INSERT INTO companies_payment_gateways
               (company_id, gateway, access_token, public_key, sandbox, webhook_secret)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (company_id, gateway) DO UPDATE SET
               access_token   = EXCLUDED.access_token,
               public_key     = EXCLUDED.public_key,
               sandbox        = EXCLUDED.sandbox,
               webhook_secret = EXCLUDED.webhook_secret,
               updated_at     = NOW()
             RETURNING id, gateway, public_key, sandbox, webhook_secret, created_at, updated_at`;
      params = [cid, gateway, access_token.trim(), public_key.trim(), sandbox, webhookSecretClean];
    } else {
      sql = `INSERT INTO companies_payment_gateways
               (company_id, gateway, access_token, public_key, sandbox)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (company_id, gateway) DO UPDATE SET
               access_token = EXCLUDED.access_token,
               public_key   = EXCLUDED.public_key,
               sandbox      = EXCLUDED.sandbox,
               updated_at   = NOW()
             RETURNING id, gateway, public_key, sandbox, created_at, updated_at`;
      params = [cid, gateway, access_token.trim(), public_key.trim(), sandbox];
    }
    const { rows } = await db.query(sql, params);
    const row = rows[0];

    res.json({
      gateway: row.gateway,
      access_token_masked: maskToken(access_token.trim()),
      public_key_masked: maskToken(row.public_key),
      sandbox: row.sandbox,
      webhook_secret_masked: includeSecret ? maskSecret(row.webhook_secret) : null,
      webhook_secret_configured: includeSecret ? !!row.webhook_secret : false,
      configured: true,
      saved: true,
    });
  } catch (err) {
    if (err.code === '42703') {
      _webhookSecretColumnCache = null;
      return res.status(503).json({ error: 'Schema da migration 121 ainda não aplicado. Aguarde alguns minutos e tente novamente.' });
    }
    console.error('[payment-gateways] POST error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar credenciais do gateway' });
  }
});

router.delete('/:gateway', requireRole('client', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { gateway } = req.params;

  if (!['mercadopago'].includes(gateway)) {
    return res.status(400).json({ error: 'Gateway inválido' });
  }

  try {
    const { rowCount } = await db.query(
      `DELETE FROM companies_payment_gateways WHERE company_id = $1 AND gateway = $2`,
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
