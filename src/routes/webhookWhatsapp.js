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

        // ── Fase 2: qualidade do número (phone_number_quality_update) ──
        // A Meta manda o campo quality_rating quando presente; nos anos
        // em que não manda, o SINAL é o event FLAGGED/UNFLAGGED. FLAGGED
        // já pausa a fila (QUALIDADE_BAIXA) — não faz sentido esperar o
        // próximo envio falhar para descobrir que a qualidade caiu.
        if (change.field === 'phone_number_quality_update') {
          let qCompanyId = companyId;
          if (!qCompanyId && entry.id) {
            const r = await db.query(
              'SELECT id FROM companies WHERE wa_waba_id=$1 LIMIT 1', [entry.id]
            ).catch(() => ({ rows: [] }));
            if (r.rows.length) qCompanyId = r.rows[0].id;
          }
          if (qCompanyId) {
            const quality = value.quality_rating
              || (value.event === 'FLAGGED' ? 'RED' : value.event === 'UNFLAGGED' ? 'GREEN' : null);
            try {
              if (quality) {
                await db.query('UPDATE companies SET wa_quality_rating=$2 WHERE id=$1', [qCompanyId, quality]);
              }
              if (value.event === 'FLAGGED') {
                await db.query(
                  'UPDATE companies SET wa_paused_reason=$2, wa_paused_at=NOW() WHERE id=$1',
                  [qCompanyId, 'QUALIDADE_BAIXA']
                );
              } else if (value.event === 'UNFLAGGED') {
                // Só destrava se a pausa ATUAL for de qualidade — uma
                // pausa manual ou de conta restrita não pode ser
                // destravada por um evento de qualidade voltando ao normal.
                await db.query(
                  `UPDATE companies SET wa_paused_reason=NULL, wa_paused_at=NULL
                    WHERE id=$1 AND wa_paused_reason='QUALIDADE_BAIXA'`,
                  [qCompanyId]
                );
              }
            } catch (e) {
              if (e.code !== '42703' && e.code !== '42P01') {
                console.error('[WA-WEBHOOK] quality update error:', e.message);
              }
            }
          }
          continue;
        }

        // ── Fase 2: conta restrita/desabilitada (account_update) ──
        if (change.field === 'account_update') {
          const RESTRICT_EVENTS = ['DISABLED_UPDATE', 'ACCOUNT_RESTRICTION', 'ACCOUNT_VIOLATION'];
          if (RESTRICT_EVENTS.includes(value.event)) {
            let aCompanyId = companyId;
            if (!aCompanyId && entry.id) {
              const r = await db.query(
                'SELECT id FROM companies WHERE wa_waba_id=$1 LIMIT 1', [entry.id]
              ).catch(() => ({ rows: [] }));
              if (r.rows.length) aCompanyId = r.rows[0].id;
            }
            if (aCompanyId) {
              await db.query(
                'UPDATE companies SET wa_paused_reason=$2, wa_paused_at=NOW() WHERE id=$1',
                [aCompanyId, 'CONTA_RESTRITA']
              ).catch((e) => {
                if (e.code !== '42703' && e.code !== '42P01') {
                  console.error('[WA-WEBHOOK] account update error:', e.message);
                }
              });
            }
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
          // Fase 2: telefone que a Meta recusou de vez (131026, não é
          // WhatsApp) nunca mais entra na fila automática — sem isto o
          // dojô paga chamada todo dia no mesmo número morto.
          //
          // Fase 7: 131049 é o limite de MARKETING por usuário e não diz
          // nada sobre o número — bloqueia só marketing, por 30 dias, e a
          // cobrança do mesmo cliente continua saindo.
          if (status.status === 'failed') {
            const errCode = status.errors && status.errors[0] && Number(status.errors[0].code);
            const recipient = waOutbox.normalizePhone(status.recipient_id) || status.recipient_id;
            if (errCode === 131026) {
              await waOutbox.markContactInvalid(companyId, recipient, status.errors[0].title || null)
                .catch((e) => console.error('[WA-WEBHOOK] contact invalid error:', e.message));
            } else if (errCode === 131049) {
              await waOutbox.markContactMarketingBlocked(companyId, recipient, waOutbox.MARKETING_BLOCK_DAYS)
                .catch((e) => console.error('[WA-WEBHOOK] marketing block error:', e.message));
            }
          }
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
