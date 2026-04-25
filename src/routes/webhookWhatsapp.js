// ============================================================
// AURA. — WhatsApp Webhook Handler
// Receives: message status updates, incoming messages
// Mounted at: /webhooks/whatsapp (PUBLIC, no auth)
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../config/database');

const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'aura_whatsapp_verify_2026';

// GET /webhooks/whatsapp — Meta webhook verification
// Meta envia: ?hub.mode=subscribe&hub.verify_token=TOKEN&hub.challenge=XXXX
// Servidor deve responder com hub.challenge em plain text, status 200.
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Log completo para diagnostico via Railway
  console.log('[WA-WEBHOOK] Verification attempt:', {
    mode,
    token_received:  token,
    token_expected:  VERIFY_TOKEN,
    token_match:     token === VERIFY_TOKEN,
    challenge,
    headers: {
      host:       req.headers.host,
      user_agent: req.headers['user-agent'],
    },
    raw_query: req.query,
  });

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WA-WEBHOOK] Verification OK — returning challenge:', challenge);
    // Resposta deve ser EXATAMENTE o hub.challenge, sem JSON, sem newlines
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).end(String(challenge));
  }

  console.warn('[WA-WEBHOOK] Verification FAILED — token mismatch ou mode incorreto');
  res.sendStatus(403);
});

// GET /webhooks/whatsapp/ping — diagnostico sem autenticacao
router.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    verify_token_set: !!process.env.WA_VERIFY_TOKEN,
    verify_token_value: VERIFY_TOKEN, // Mostra o token em uso para comparar com Railway
    timestamp: new Date().toISOString(),
  });
});

// POST /webhooks/whatsapp — Receive events
router.post('/', async (req, res) => {
  // Always return 200 quickly to avoid Meta retries
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body?.object || body.object !== 'whatsapp_business_account') return;

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;

        // Find company by phone_number_id
        let companyId = null;
        if (phoneNumberId) {
          const { rows } = await db.query(
            'SELECT id FROM companies WHERE wa_phone_number_id=$1 LIMIT 1',
            [phoneNumberId]
          );
          if (rows.length) companyId = rows[0].id;
        }

        // Handle message status updates (sent → delivered → read)
        const statuses = value.statuses || [];
        for (const status of statuses) {
          if (!companyId) continue;
          await db.query(
            `UPDATE wa_messages SET status=$1, updated_at=NOW()
             WHERE wa_message_id=$2 AND company_id=$3`,
            [status.status, status.id, companyId]
          ).catch(() => {});
        }

        // Handle incoming messages
        const messages = value.messages || [];
        for (const msg of messages) {
          if (!companyId) continue;
          const content = msg.text?.body || msg.caption || `[${msg.type}]`;
          await db.query(
            `INSERT INTO wa_messages (company_id, direction, wa_message_id, from_phone, content, status, metadata)
             VALUES ($1,'inbound',$2,$3,$4,'received',$5)`,
            [companyId, msg.id, msg.from, content, JSON.stringify(msg)]
          ).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[WA-WEBHOOK] Error:', err.message);
  }
});

module.exports = router;
