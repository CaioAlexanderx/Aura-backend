// ============================================================
// AURA. — Instagram Webhook Handler (Hub Social / Aurinha)
// Receives: Instagram Business mentions, messages, story replies, comments
// Mounted at: /webhooks/instagram (PUBLIC, no auth)
//
// AURINHA (312): além de persistir a DM (comportamento original do P11
// S3), o inbound agora (1) faz upsert da conversa em hub_conversations,
// (2) liga a mensagem à conversa e (3) dispara o agente Aurinha async.
// Segurança: valida X-Hub-Signature-256 quando IG_APP_SECRET estiver
// setado (mesmo padrão do webhook WhatsApp). Sem o secret, mantém o
// comportamento legado (processa sem validar) COM warning — trocar para
// estrito assim que IG_APP_SECRET entrar no Railway.
// ============================================================

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const { validateWebhookSignature } = require('../utils/webhook');

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || 'aura_instagram_verify_2026';
const APP_SECRET   = process.env.IG_APP_SECRET || null;

// GET /webhooks/instagram — Meta webhook verification
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('[IG-WEBHOOK] Verification attempt:', {
    mode, token_match: token === VERIFY_TOKEN, challenge,
  });

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[IG-WEBHOOK] Verified OK — challenge:', challenge);
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).end(String(challenge));
  }

  console.warn('[IG-WEBHOOK] Verification FAILED');
  res.sendStatus(403);
});

// GET /webhooks/instagram/ping — diagnóstico.
// NÃO expõe o valor do verify token (era um vazamento) — só se está setado.
router.get('/ping', (_req, res) => {
  res.json({
    status: 'ok',
    verify_token_set: !!process.env.IG_VERIFY_TOKEN,
    app_secret_set:   !!APP_SECRET,
    timestamp: new Date().toISOString(),
  });
});

// POST /webhooks/instagram — Receive events
router.post('/', async (req, res) => {
  // Valida assinatura quando o secret existir (HMAC-SHA256 dos bytes crus).
  if (APP_SECRET) {
    const sig = req.headers['x-hub-signature-256'];
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
    if (!sig || !validateWebhookSignature(raw, sig, APP_SECRET, 'sha256=')) {
      return res.sendStatus(401);
    }
  } else {
    console.warn('[IG-WEBHOOK] IG_APP_SECRET ausente — processando SEM validação de assinatura (modo legado).');
  }

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
        // Echo = mensagem enviada PELA loja (inclusive pela própria API).
        // Não é inbound: ignorar evita a Aurinha responder a si mesma.
        if (msg.message.is_echo) continue;
        const content = msg.message.text || `[${msg.message.attachments?.[0]?.type || 'attachment'}]`;
        if (!companyId) {
          console.log('[IG-WEBHOOK] DM sem company (ig_account_id não vinculado):', igAccountId);
          continue;
        }

        // 1) Upsert da conversa (312). Guard 42P01: migration pendente →
        //    segue no comportamento legado (só loga a mensagem).
        let conversationId = null;
        try {
          const { rows: convRows } = await db.query(
            `-- aurinha:conv-upsert
             INSERT INTO hub_conversations
               (company_id, channel, external_id, last_inbound_at, last_message_at)
             VALUES ($1, 'instagram', $2, NOW(), NOW())
             ON CONFLICT (company_id, channel, external_id) DO UPDATE SET
               last_inbound_at = NOW(),
               last_message_at = NOW(),
               -- conversa resolvida que recebe DM nova reabre para a IA
               status = CASE WHEN hub_conversations.status = 'resolvida'
                             THEN 'ia' ELSE hub_conversations.status END,
               updated_at = NOW()
             RETURNING id`,
            [companyId, msg.sender?.id]
          );
          conversationId = convRows[0]?.id || null;
        } catch (e) {
          if (e.code !== '42P01') console.error('[IG-WEBHOOK] conv upsert error:', e.message);
        }

        // 2) Persiste a DM (comportamento original) já ligada à conversa.
        try {
          await db.query(
            `INSERT INTO ig_messages (company_id, direction, ig_message_id, from_ig_id, content, status, metadata, conversation_id)
             VALUES ($1,'inbound',$2,$3,$4,'received',$5,$6)
             ON CONFLICT (ig_message_id) DO NOTHING`,
            [companyId, msg.message.mid, msg.sender?.id, content, JSON.stringify(msg), conversationId]
          );
        } catch (e) {
          if (e.code === '42703') {
            // Coluna conversation_id ainda não existe (312 pendente) — INSERT legado.
            await db.query(
              `INSERT INTO ig_messages (company_id, direction, ig_message_id, from_ig_id, content, status, metadata)
               VALUES ($1,'inbound',$2,$3,$4,'received',$5)
               ON CONFLICT (ig_message_id) DO NOTHING`,
              [companyId, msg.message.mid, msg.sender?.id, content, JSON.stringify(msg)]
            ).catch(() => {});
          } else {
            console.error('[IG-WEBHOOK] ig_messages write error:', e.message);
          }
        }

        console.log('[IG-WEBHOOK] DM received:', { igAccountId, companyId, conversationId });

        // 3) Aurinha responde (async, nunca derruba o webhook).
        if (conversationId) {
          const { handleInbound } = require('../services/aurinhaAgent');
          handleInbound(companyId, conversationId)
            .catch((e) => console.error('[IG-WEBHOOK] aurinha error:', e.message));
        }
      }

      // Menções em Stories / Feed
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
