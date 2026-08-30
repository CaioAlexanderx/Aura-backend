// ============================================================
// AURA. — hubSocial.js
// Hub social (aba Agentes do app): inbox unificado multicanal +
// controles da Aurinha. MVP: canal Instagram; o schema já é
// multicanal (channel em hub_conversations).
//
// Montado em private.js como /companies/:id/hub — herda requireAuth +
// requireCompanyAccess. SEM requirePlan de propósito: seguindo a
// decisão do WhatsApp Cloud (whatsappCloud.js), o gate comercial é o
// addon/billing, não o plano — hub_agent_settings.enabled controla.
//
// Guard 42P01 em tudo: migration 312 pode não estar aplicada ainda
// (regra nº 1 do CLAUDE.md — schema antes da migration).
// ============================================================
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../config/database');
const igOutbox = require('../services/igOutbox');

const CATEGORIES = ['produto', 'troca', 'entrega', 'pagamento', 'novidades'];
const STATUSES = ['ia', 'precisa_humano', 'humano', 'resolvida'];

function isMissingSchema(e) { return e && (e.code === '42P01' || e.code === '42703'); }

async function logEvent(companyId, conversationId, type, detail, userId) {
  await db.query(
    `INSERT INTO hub_agent_events (company_id, conversation_id, type, detail, user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [companyId, conversationId, type, detail ? JSON.stringify(detail) : null, userId || null]
  ).catch(() => {});
}

// ── GET /hub/conversations ──────────────────────────────────
// Filtros: ?channel= &status= &category= &limit=
router.get('/conversations', async (req, res) => {
  const cid = req.params.id;
  const { channel, status, category } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const where = ['c.company_id = $1'];
    const vals = [cid];
    if (channel) { vals.push(channel); where.push(`c.channel = $${vals.length}`); }
    if (status && STATUSES.includes(status)) { vals.push(status); where.push(`c.status = $${vals.length}`); }
    if (category && CATEGORIES.includes(category)) { vals.push(category); where.push(`c.category = $${vals.length}`); }
    vals.push(limit);

    const { rows } = await db.query(
      `-- hub:conversations
       SELECT c.id, c.channel, c.external_id, c.customer_id, c.customer_name,
              c.status, c.category, c.handoff_reason, c.last_inbound_at, c.last_message_at,
              (SELECT content FROM ig_messages m
                WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview,
              (SELECT COUNT(*)::int FROM ig_outbox o
                WHERE o.conversation_id = c.id AND o.status = 'pending_approval') AS pending_approvals
         FROM hub_conversations c
        WHERE ${where.join(' AND ')}
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT $${vals.length}`,
      vals
    );

    // Contadores para os chips do app (sempre do conjunto todo, sem filtro)
    const { rows: counts } = await db.query(
      `SELECT channel, status, COUNT(*)::int AS n
         FROM hub_conversations WHERE company_id = $1
        GROUP BY channel, status`,
      [cid]
    );
    res.json({ conversations: rows, counts });
  } catch (e) {
    if (isMissingSchema(e)) return res.json({ conversations: [], counts: [], schema_pending: true });
    console.error('[HUB] conversations error:', e.message);
    res.status(500).json({ error: 'Erro ao listar conversas' });
  }
});

// ── GET /hub/conversations/:convId/messages ─────────────────
router.get('/conversations/:convId/messages', async (req, res) => {
  const cid = req.params.id;
  const { convId } = req.params;
  try {
    const { rows: conv } = await db.query(
      `SELECT id, channel, external_id, customer_name, status, category, handoff_reason, last_inbound_at
         FROM hub_conversations WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [convId, cid]
    );
    if (!conv.length) return res.status(404).json({ error: 'Conversa não encontrada' });

    const { rows: messages } = await db.query(
      `SELECT id, direction, content, status, created_at, metadata->>'source_type' AS source_type
         FROM ig_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC LIMIT 200`,
      [convId]
    );
    // Sugestões da Aurinha aguardando aprovação aparecem no fim da thread
    const { rows: pending } = await db.query(
      `SELECT id, text_body, edited_body, status, source_type, created_at
         FROM ig_outbox
        WHERE conversation_id = $1 AND status = 'pending_approval'
        ORDER BY created_at ASC`,
      [convId]
    );
    res.json({ conversation: conv[0], messages, pending_approvals: pending });
  } catch (e) {
    if (isMissingSchema(e)) return res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });
    console.error('[HUB] messages error:', e.message);
    res.status(500).json({ error: 'Erro ao carregar conversa' });
  }
});

// ── Transições de estado da conversa ────────────────────────
async function setStatus(req, res, newStatus, eventType) {
  const cid = req.params.id;
  const { convId } = req.params;
  try {
    const { rows } = await db.query(
      `UPDATE hub_conversations
          SET status = $1,
              assigned_user_id = CASE WHEN $1 = 'humano' THEN $4 ELSE assigned_user_id END,
              updated_at = NOW()
        WHERE id = $2 AND company_id = $3
        RETURNING id, status`,
      [newStatus, convId, cid, req.user?.id || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Conversa não encontrada' });
    await logEvent(cid, convId, eventType, null, req.user?.id);
    res.json({ ok: true, status: rows[0].status });
  } catch (e) {
    if (isMissingSchema(e)) return res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });
    console.error('[HUB] setStatus error:', e.message);
    res.status(500).json({ error: 'Erro ao atualizar conversa' });
  }
}

router.post('/conversations/:convId/assume', (req, res) => setStatus(req, res, 'humano', 'assumida'));
router.post('/conversations/:convId/resolve', (req, res) => setStatus(req, res, 'resolvida', 'resolvida'));
// Devolve a conversa para a Aurinha (ex.: depois de resolver a exceção)
router.post('/conversations/:convId/return-to-ai', (req, res) => setStatus(req, res, 'ia', 'reaberta'));

// ── PATCH categoria (correção manual da triagem) ────────────
router.patch('/conversations/:convId/category', async (req, res) => {
  const cid = req.params.id;
  const { convId } = req.params;
  const { category } = req.body || {};
  if (category !== null && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `categoria inválida (${CATEGORIES.join(', ')})` });
  }
  try {
    const { rows } = await db.query(
      `UPDATE hub_conversations SET category = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3 RETURNING id`,
      [category, convId, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Conversa não encontrada' });
    await logEvent(cid, convId, 'categorizada', { categoria: category, manual: true }, req.user?.id);
    res.json({ ok: true });
  } catch (e) {
    if (isMissingSchema(e)) return res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });
    res.status(500).json({ error: 'Erro ao atualizar categoria' });
  }
});

// ── POST resposta humana ────────────────────────────────────
router.post('/conversations/:convId/reply', async (req, res) => {
  const cid = req.params.id;
  const { convId } = req.params;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text obrigatório' });
  try {
    const { rows } = await db.query(
      `SELECT external_id, last_inbound_at, channel FROM hub_conversations
        WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [convId, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Conversa não encontrada' });
    const conv = rows[0];
    if (conv.channel !== 'instagram') {
      return res.status(400).json({ error: 'Canal ainda não suportado para envio' });
    }
    if (!igOutbox.windowOpen(conv.last_inbound_at)) {
      return res.status(422).json({
        error: 'Janela de 24h fechada — a Meta só aceita resposta até 24h após a última mensagem do cliente.',
        code: 'JANELA_FECHADA',
      });
    }
    const enq = await igOutbox.enqueue({
      companyId: cid, conversationId: convId, toIgId: conv.external_id,
      textBody: text, sourceType: 'humano', sourceId: req.user?.id || null,
    });
    res.json({ ok: true, outbox_id: enq.id || null, status: enq.status || null });
  } catch (e) {
    if (isMissingSchema(e)) return res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });
    console.error('[HUB] reply error:', e.message);
    res.status(500).json({ error: 'Erro ao enviar resposta' });
  }
});

// ── Modo aprovação ──────────────────────────────────────────
router.post('/outbox/:outboxId/approve', async (req, res) => {
  const cid = req.params.id;
  const edited = req.body?.text != null ? String(req.body.text).trim() : null;
  try {
    const row = await igOutbox.approve(cid, req.params.outboxId, req.user?.id || null, edited || null);
    if (!row) return res.status(404).json({ error: 'Sugestão não encontrada ou já processada' });
    await logEvent(cid, row.conversation_id, edited ? 'editada' : 'aprovada', { outbox_id: row.id }, req.user?.id);
    res.json({ ok: true });
  } catch (e) {
    if (isMissingSchema(e)) return res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });
    res.status(500).json({ error: 'Erro ao aprovar' });
  }
});

router.post('/outbox/:outboxId/reject', async (req, res) => {
  const cid = req.params.id;
  try {
    const row = await igOutbox.reject(cid, req.params.outboxId, req.user?.id || null);
    if (!row) return res.status(404).json({ error: 'Sugestão não encontrada ou já processada' });
    await logEvent(cid, row.conversation_id, 'rejeitada', { outbox_id: row.id }, req.user?.id);
    res.json({ ok: true });
  } catch (e) {
    if (isMissingSchema(e)) return res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });
    res.status(500).json({ error: 'Erro ao rejeitar' });
  }
});

// ── Settings da Aurinha ─────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT enabled, approval_mode, model, extra_instructions
         FROM hub_agent_settings WHERE company_id = $1 LIMIT 1`,
      [req.params.id]
    );
    res.json(rows[0] || { enabled: false, approval_mode: true, model: null, extra_instructions: null });
  } catch (e) {
    if (isMissingSchema(e)) return res.json({ enabled: false, approval_mode: true, schema_pending: true });
    res.status(500).json({ error: 'Erro ao carregar configurações' });
  }
});

router.put('/settings', async (req, res) => {
  const cid = req.params.id;
  const { enabled, approval_mode, extra_instructions } = req.body || {};
  try {
    const { rows } = await db.query(
      `INSERT INTO hub_agent_settings (company_id, enabled, approval_mode, extra_instructions)
       VALUES ($1, COALESCE($2, false), COALESCE($3, true), $4)
       ON CONFLICT (company_id) DO UPDATE SET
         enabled = COALESCE($2, hub_agent_settings.enabled),
         approval_mode = COALESCE($3, hub_agent_settings.approval_mode),
         extra_instructions = COALESCE($4, hub_agent_settings.extra_instructions),
         updated_at = NOW()
       RETURNING enabled, approval_mode, model, extra_instructions`,
      [cid,
       typeof enabled === 'boolean' ? enabled : null,
       typeof approval_mode === 'boolean' ? approval_mode : null,
       extra_instructions != null ? String(extra_instructions).slice(0, 2000) : null]
    );
    res.json(rows[0]);
  } catch (e) {
    if (isMissingSchema(e)) return res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});

module.exports = router;
