// ============================================================
// AURA. — WhatsApp Webhook Handler
// Receives: message status updates, incoming messages
// Mounted at: /webhooks/whatsapp (PUBLIC, no auth)
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { validateWebhookSignature } = require('../utils/webhook');
const waOutbox = require('../services/waOutbox');

// Sem fallback hardcoded (era 'aura_whatsapp_verify_2026' — token previsível).
// O verify token PRECISA vir do ambiente; sem ele, a verificação da Meta falha.
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || null;
// App Secret da Meta — usado para validar X-Hub-Signature-256 no POST.
const APP_SECRET = process.env.WA_APP_SECRET || null;

// GET /webhooks/whatsapp — Meta webhook verification
// Meta envia: ?hub.mode=subscribe&hub.verify_token=TOKEN&hub.challenge=XXXX
// Servidor deve responder com hub.challenge em plain text, status 200.
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Log de diagnóstico SEM vazar os valores dos tokens (só o resultado).
  console.log('[WA-WEBHOOK] Verification attempt:', {
    mode,
    token_match:    !!VERIFY_TOKEN && token === VERIFY_TOKEN,
    verify_token_configured: !!VERIFY_TOKEN,
    host:           req.headers.host,
    user_agent:     req.headers['user-agent'],
  });

  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    console.log('[WA-WEBHOOK] Verification OK — returning challenge:', challenge);
    // Resposta deve ser EXATAMENTE o hub.challenge, sem JSON, sem newlines
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).end(String(challenge));
  }

  console.warn('[WA-WEBHOOK] Verification FAILED — token mismatch ou mode incorreto');
  res.sendStatus(403);
});

// GET /webhooks/whatsapp/ping — diagnóstico sem autenticação.
// NÃO expõe o valor do verify token (era um vazamento) — só se está setado.
router.get('/ping', (_req, res) => {
  res.json({
    status: 'ok',
    verify_token_set: !!process.env.WA_VERIFY_TOKEN,
    app_secret_set:   !!process.env.WA_APP_SECRET,
    timestamp: new Date().toISOString(),
  });
});

// POST /webhooks/whatsapp — Receive events
router.post('/', async (req, res) => {
  // A7 — valida a assinatura X-Hub-Signature-256 (HMAC-SHA256 do App Secret
  // sobre os BYTES crus do corpo). Sem isso, qualquer um que descubra a URL
  // injeta status/mensagens falsos em wa_messages. Constant-time no helper.
  if (APP_SECRET) {
    const sig = req.headers['x-hub-signature-256'];
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
    if (!sig || !validateWebhookSignature(raw, sig, APP_SECRET, 'sha256=')) {
      // 401 sem efeito: não é uma requisição legítima da Meta.
      return res.sendStatus(401);
    }
  } else {
    // Segredo não configurado (integração ainda dormente): não dá pra validar.
    // Responde 200 pra Meta não re-tentar e NÃO processa às cegas.
    console.warn('[WA-WEBHOOK] WA_APP_SECRET ausente — evento ignorado (sem validação de assinatura).');
    return res.sendStatus(200);
  }

  // Assinatura ok → 200 rápido e processa async.
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

        // ── ONDA 5b: aprovação/rejeição de template (o campo
        // message_template_status_update já está assinado na Meta).
        // O evento vem no nível do WABA — companyId pode ser null;
        // resolvemos pela company dona do waba_id quando preciso.
        if (change.field === 'message_template_status_update') {
          let tplCompanyId = companyId;
          if (!tplCompanyId && entry.id) {
            const r = await db.query(
              'SELECT id FROM companies WHERE wa_waba_id=$1 LIMIT 1', [entry.id]
            ).catch(() => ({ rows: [] }));
            if (r.rows.length) tplCompanyId = r.rows[0].id;
          }
          if (tplCompanyId) {
            await waOutbox.applyTemplateStatus(tplCompanyId, {
              name: value.message_template_name,
              language: value.message_template_language,
              status: value.event,                 // APPROVED | REJECTED | PAUSED...
              metaTemplateId: value.message_template_id != null ? String(value.message_template_id) : null,
            }).catch((e) => console.error('[WA-WEBHOOK] template status error:', e.message));
          }
          continue;
        }

        // Handle message status updates (sent → delivered → read)
        const statuses = value.statuses || [];
        for (const status of statuses) {
          if (!companyId) continue;
          await db.query(
            `UPDATE wa_messages SET status=$1, updated_at=NOW()
             WHERE wa_message_id=$2 AND company_id=$3`,
            [status.status, status.id, companyId]
          ).catch((e) => console.error('[WA-WEBHOOK] wa_messages write error:', e.message));
          // ONDA 5b: espelha na fila (delivered/read/failed por wamid).
          await waOutbox.applyStatusUpdate(
            companyId, status.id, status.status,
            status.errors && status.errors[0] && status.errors[0].title || null
          ).catch((e) => console.error('[WA-WEBHOOK] outbox status error:', e.message));
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
          ).catch((e) => console.error('[WA-WEBHOOK] wa_messages write error:', e.message));
          // ONDA 5b: abre a janela de 24h e processa SAIR/PARAR (opt-out)
          // e VOLTAR (opt-in) — opt-out sempre vence na fila.
          await waOutbox.touchInbound(companyId, msg.from, msg.text?.body)
            .catch((e) => console.error('[WA-WEBHOOK] contact touch error:', e.message));
        }
      }
    }
  } catch (err) {
    console.error('[WA-WEBHOOK] Error:', err.message);
  }
});

module.exports = router;
