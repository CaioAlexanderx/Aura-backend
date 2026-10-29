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
//
// tq-94 (29/10/2026, migration 419): conexão por OAuth.
// GET    /companies/:id/payment-gateways/mercadopago/oauth/start
//        → { url } da tela de autorização do Mercado Pago (só o dono;
//          ?sandbox=1 só para a equipe Aura; ?volta=<caminho do app>).
//        503 sem MP_CLIENT_ID/MP_CLIENT_SECRET/CERT_MASTER_KEY.
// O retorno chega em routes/mpOAuthCallback.js. O GET daqui passa a dizer
// como a loja está conectada (auth_method, "Conectado como", caiu) e se o
// botão pode aparecer (oauth_disponivel). Token por OAuth nunca sai daqui,
// nem mascarado.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');
const mpOAuth   = require('../services/mpOAuth');
const mpGateway = require('../services/mpGateway');

function ehDonoOuEquipe(req) {
  return req.companyRole === 'owner' || (req.user && req.user.role === 'admin');
}

// Pedidos da loja online com pagamento do Mercado Pago em andamento — o
// aviso de "Desconectar" conta estes (mockup da Nina, estado Desconectar).
async function pedidosEmAndamento(cid) {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM digital_orders
        WHERE company_id = $1 AND status = 'pending_payment'
          AND (payment_method = 'card' OR mp_payment_id IS NOT NULL)`,
      [cid]
    );
    return (rows[0] && rows[0].n) || 0;
  } catch (_) { return 0; }
}

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
    const hasOAuth  = await mpGateway.temColunasOAuth(db);
    const oauthCols = hasOAuth ? ', auth_method, mp_nickname, connection_status, connection_lost_at' : '';
    const cols = (hasSecret
      ? 'id, gateway, public_key, sandbox, webhook_secret, created_at, updated_at'
      : 'id, gateway, public_key, sandbox, created_at, updated_at') + oauthCols;
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

    const payload = rows.map(r => {
      const oauth = r.auth_method === 'oauth';
      return {
        id: r.id,
        gateway: r.gateway,
        // OAuth: nenhum token aparece, nem mascarado (decisão do desenho).
        access_token_masked: oauth ? null : maskToken(tokenMap[r.gateway]),
        public_key_masked: oauth ? null : maskToken(r.public_key),
        sandbox: r.sandbox,
        // Migration 121: webhook_secret cadastrado? (não retorna o valor real)
        webhook_secret_masked: hasSecret && !oauth ? maskSecret(r.webhook_secret) : null,
        webhook_secret_configured: hasSecret ? !!r.webhook_secret : false,
        // Migration 419 (tq-94)
        auth_method: r.auth_method || 'manual',
        account_name: oauth ? (r.mp_nickname || null) : null,
        connection_status: r.connection_status || 'ok',
        connection_lost_at: r.connection_lost_at || null,
        configured: true,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

    const temMp = payload.some(g => g.gateway === 'mercadopago');
    res.json({
      gateways: payload,
      oauth_disponivel: mpOAuth.oauthDisponivel() && hasOAuth,
      pode_conectar: ehDonoOuEquipe(req),
      pedidos_em_andamento: temMp ? await pedidosEmAndamento(cid) : 0,
    });
  } catch (err) {
    console.error('[payment-gateways] GET error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar gateways de pagamento' });
  }
});

// GET /mercadopago/oauth/start — monta a URL de autorização com state assinado.
router.get('/mercadopago/oauth/start', requireRole('client', 'admin'), async (req, res) => {
  const cid = req.params.id;
  if (!mpOAuth.oauthDisponivel() || !(await mpGateway.temColunasOAuth(db))) {
    return res.status(503).json({
      error: 'A conexão com o Mercado Pago ainda não está disponível.',
      code: 'MP_OAUTH_INDISPONIVEL',
    });
  }
  if (!ehDonoOuEquipe(req)) {
    return res.status(403).json({ error: 'Só o dono da conta conecta o Mercado Pago.' });
  }
  const querTeste = ['1', 'true'].includes(String(req.query.sandbox || '').toLowerCase());
  if (querTeste && !req.user.is_staff) {
    return res.status(403).json({ error: 'Modo de testes é só para a equipe Aura.' });
  }
  const state = mpOAuth.signState({
    companyId: cid,
    userId: req.user.id,
    sandbox: querTeste,
    returnPath: typeof req.query.volta === 'string' ? req.query.volta : null,
  });
  res.set('Cache-Control', 'no-store');
  res.json({ url: mpOAuth.buildAuthUrl({ state }), expires_in: mpOAuth.STATE_TTL_S });
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

    // Token colado por cima de uma conexão por OAuth: o registro volta a ser
    // manual (sem refresh_token cifrado nem user_id do OAuth sobrando).
    if (await mpGateway.temColunasOAuth(db)) {
      await db.query(
        `UPDATE companies_payment_gateways
            SET auth_method = 'manual', refresh_token = NULL, token_expires_at = NULL,
                mp_user_id = NULL, mp_nickname = NULL,
                connection_status = 'ok', connection_lost_at = NULL
          WHERE company_id = $1 AND gateway = $2 AND auth_method <> 'manual'`,
        [cid, gateway]
      );
    }

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
