// ============================================================
// AURA. — Instagram Webhook Handler (Hub Social P11 S3)
// Receives: Instagram Business mentions, messages, story replies, comments
// Mounted at: /webhooks/instagram (PUBLIC, no auth)
// ============================================================

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || 'aura_instagram_verify_2026';

// GET /webhooks/instagram — Meta webhook verification
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('[IG-WEBHOOK] Verification attempt:', {
    mode, token_received: token, token_expected: VERIFY_TOKEN,
    token_match: token === VERIFY_TOKEN, challenge,
  });

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[IG-WEBHOOK] Verified OK — challenge:', challenge);
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).end(String(challenge));
  }

  console.warn('[IG-WEBHOOK] Verification FAILED');
  res.sendStatus(403);
});

// GET /webhooks/instagram/ping — diagnostico
router.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    verify_token_set:   !!process.env.IG_VERIFY_TOKEN,
    verify_token_value: VERIFY_TOKEN,
    timestamp: new Date().toISOString(),
  });
});

// POST /webhooks/instagram — Receive events
router.post('/', async (req, res) => {
  // Responde 200 imediatamente para evitar retries da Meta
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body?.object) return;

    const entries = body.entry || [];

    for (const entry of entries) {
      const igAccountId = entry.id;

      // Identifica empresa pelo ig_account_id
      let companyId = null;
      if (igAccountId) {
        const { rows } = await db.query(
          `SELECT id FROM companies WHERE ig_account_id = $1 LIMIT 1`,
          [igAccountId]
        ).catch(() => ({ rows: [] }));
        if (rows.length) companyId = rows[0].id;
      }

      // Mensagens diretas (DMs)
      const messaging = entry.messaging || [];
      for (const msg of messaging) {
        if (!msg.message) continue;
        const content = msg.message.text || `[${msg.message.attachments?.[0]?.type || 'attachment'}]`;
        if (companyId) {
          await db.query(
            `INSERT INTO ig_messages (company_id, direction, ig_message_id, from_ig_id, content, status, metadata)
             VALUES ($1,'inbound',$2,$3,$4,'received',$5)
             ON CONFLICT (ig_message_id) DO NOTHING`,
            [companyId, msg.message.mid, msg.sender?.id, content, JSON.stringify(msg)]
          ).catch(() => {});
        }
        console.log('[IG-WEBHOOK] DM received:', { igAccountId, companyId, content });
      }

      // Mencoes em Stories / Feed
      const changes = entry.changes || [];
      for (const change of changes) {
        const field = change.field;
        const val   = change.value;
        console.log('[IG-WEBHOOK] Change:', { field, igAccountId, companyId });

        if (field === 'mentions' && companyId) {
          await db.query(
            `INSERT INTO ig_mentions (company_id, ig_media_id, mentioned_by_ig_id, media_type, timestamp)
             VALUES ($1,$2,$3,$4,NOW())
             ON CONFLICT DO NOTHING`,
            [companyId, val.media_id, val.mentioned_user_id, val.media_type || 'unknown']
          ).catch(() => {});
        }

        if (field === 'comments' && companyId) {
          await db.query(
            `INSERT INTO ig_comments (company_id, ig_comment_id, ig_media_id, from_ig_id, text, timestamp)
             VALUES ($1,$2,$3,$4,$5,NOW())
             ON CONFLICT DO NOTHING`,
            [companyId, val.id, val.media_id, val.from?.id, val.text]
          ).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[IG-WEBHOOK] Error:', err.message);
  }
});

module.exports = router;
