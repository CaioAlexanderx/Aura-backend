// ============================================================
// AURA. — hubWhatsapp.js
// WhatsApp da própria Aura no hub (Aurinha de plantão, fase 3).
//
// O webhook do WhatsApp (webhookWhatsapp.js) pergunta aqui, por
// phone_number_id, se o número é o do tenant Aura. Se for:
//  - mensagem recebida vira conversa no hub (canal 'whatsapp', identificada
//    pelo telefone do cliente) + hub_messages + evento 'mensagem_recebida';
//  - eco do app do celular (coexistência: o Caio respondeu na mão) vira
//    mensagem HUMANA — alimenta o relógio de plantão e cancela a resposta
//    da Aurinha que ainda estava na fila.
// Se não for, devolve null e o webhook segue o fluxo das lojas sem mudança.
//
// Trava dupla, DORMENTE por padrão: sem AURA_COMPANY_ID no ambiente nada
// aqui consulta o banco; e o número só roteia se hub_agent_settings da
// empresa Aura tiver exatamente aquele wa_phone_number_id (375). Esse
// campo não é editável pela API da loja — só por SQL/admin.
//
// Quem decide QUANDO a Aurinha fala é o plantao.js (relógio). O que ela
// diz é responderNoHub() — hoje um texto fixo (f3-05 troca por persona e
// ferramentas). O que não pode responder agora fica marcado em
// hub_conversations.aguardando_resposta_desde e o job por minuto
// (jobs/plantaoJob.js) reavalia.
//
// Guards 42P01/42703 em tudo (regra nº 1 do CLAUDE.md): o backend sobe
// antes da migration 375.
// ============================================================
'use strict';

const db = require('../config/database');
const waOutbox = require('./waOutbox');
const plantao = require('./plantao');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_MS = 24 * 3600 * 1000;

// Texto do stub (f3-05 substitui por persona de suporte + ferramentas).
const TEXTO_STUB = 'Oi! Aqui é a Aurinha, da Aura. Anotei sua mensagem e o Caio te responde às 8h.';
// Só do stub: o aviso é fixo, então não se repete a cada mensagem de uma
// rajada. Some junto com o stub.
const STUB_INTERVALO_MIN = 6 * 60;

function isMissingSchema(e) { return e && (e.code === '42P01' || e.code === '42703'); }

function auraCompanyId() {
  const v = String(process.env.AURA_COMPANY_ID || '').trim();
  return UUID_RE.test(v) ? v : null;
}

// Tenant do número, ou null. Sem consulta alguma quando dormente.
async function resolveTenant(phoneNumberId) {
  const companyId = auraCompanyId();
  if (!companyId || !phoneNumberId) return null;
  try {
    const { rows } = await db.query(
      `-- hubwa:tenant
       SELECT company_id, enabled, approval_mode, plantao
         FROM hub_agent_settings
        WHERE company_id = $1 AND wa_phone_number_id = $2 LIMIT 1`,
      [companyId, String(phoneNumberId)]
    );
    if (!rows.length) return null;
    return {
      companyId: rows[0].company_id,
      enabled: !!rows[0].enabled,
      plantao: rows[0].plantao || null,
    };
  } catch (e) {
    if (isMissingSchema(e)) return null;
    throw e;
  }
}

async function logEvent(companyId, conversationId, type, detail, userId = null) {
  try {
    await db.query(
      `INSERT INTO hub_agent_events (company_id, conversation_id, type, detail, user_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [companyId, conversationId, type, detail ? JSON.stringify(detail) : null, userId]
    );
  } catch (e) {
    // Auditoria nunca derruba o fluxo (nem CHECK de tipo com a 375 pendente).
    if (!isMissingSchema(e) && e.code !== '23514') {
      console.error('[HUB-WA] evento não gravado:', e.message);
    }
  }
}

function dataDaMeta(ts, fallback) {
  const n = Number(ts);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

function textoDaMensagem(msg) {
  return (msg.text && msg.text.body)
    || msg.caption
    || (msg.button && msg.button.text)
    || (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title)
    || `[${msg.type || 'mensagem'}]`;
}

async function jaGravada(companyId, wamid) {
  const { rows } = await db.query(
    `-- hubwa:msg-dup
     SELECT 1 FROM hub_messages
      WHERE company_id = $1 AND channel = 'whatsapp' AND external_message_id = $2 LIMIT 1`,
    [companyId, wamid]
  );
  return rows.length > 0;
}

// ── Ponto de extensão da persona (f3-05) ─────────────────────
// Devolve o TEXTO que a Aurinha manda agora nesta conversa, ou null.
// Hoje: texto fixo, e só quando o relógio de plantão libera.
async function responderNoHub(conversa, { agora = new Date(), config = null } = {}) {
  const liberada = plantao.deveResponderAgora({
    agora,
    ultimaMensagemHumanaEm: conversa.ultima_mensagem_humana_em || null,
    ultimaMensagemClienteEm: conversa.last_inbound_at || null,
    config,
  });
  if (!liberada) return null;
  if (await jaAvisouRecentemente(conversa.id)) return null;
  return TEXTO_STUB;
}

async function jaAvisouRecentemente(conversationId) {
  try {
    const { rows } = await db.query(
      `-- hubwa:stub-recente
       SELECT 1 FROM wa_outbox
        WHERE hub_conversation_id = $1 AND source_type = 'aurinha'
          AND status <> 'skipped'
          AND created_at > NOW() - ($2 || ' minutes')::interval
        LIMIT 1`,
      [conversationId, String(STUB_INTERVALO_MIN)]
    );
    return rows.length > 0;
  } catch (e) {
    if (isMissingSchema(e)) return false;
    throw e;
  }
}

// Reavalia UMA conversa: responde agora ou deixa marcada para o job.
// conv: linha de hub_conversations (id, company_id, external_id, status,
// last_inbound_at, ultima_mensagem_humana_em, aguardando_resposta_desde).
async function avaliarConversa(conv, { companyId, plantao: config = null }, { agora = new Date(), registrarAgendamento = false } = {}) {
  const cfg = plantao.resolverConfig(config);
  const ctx = {
    agora,
    ultimaMensagemHumanaEm: conv.ultima_mensagem_humana_em || null,
    ultimaMensagemClienteEm: conv.last_inbound_at || null,
    config,
  };

  // Humano já falou depois do cliente: não há o que responder. Limpa a
  // pendência (senão o job pegaria a conversa de novo a cada minuto).
  const humano = conv.ultima_mensagem_humana_em ? new Date(conv.ultima_mensagem_humana_em) : null;
  const cliente = conv.last_inbound_at ? new Date(conv.last_inbound_at) : null;
  if (humano && cliente && humano.getTime() >= cliente.getTime()) {
    await db.query(
      `UPDATE hub_conversations SET aguardando_resposta_desde = NULL, updated_at = NOW()
        WHERE id = $1 AND aguardando_resposta_desde IS NOT NULL`,
      [conv.id]
    );
    return { respondeu: false, motivo: 'HUMANO_JA_RESPONDEU' };
  }

  if (!plantao.deveResponderAgora(ctx)) {
    if (registrarAgendamento) {
      const quando = plantao.proximaAvaliacaoEm(ctx);
      await logEvent(companyId, conv.id, 'resposta_agendada', {
        responder_a_partir_de: quando ? quando.toISOString() : null,
        motivo: cfg.ativo ? 'espera_do_humano' : 'plantao_desligado',
      });
    }
    return { respondeu: false, agendada: true };
  }

  const texto = await responderNoHub(conv, { agora, config });

  // Claim atômico: webhook e job nunca respondem a mesma fala duas vezes.
  const { rows: claim } = await db.query(
    `-- hubwa:claim
     UPDATE hub_conversations
        SET aguardando_resposta_desde = NULL, updated_at = NOW()
      WHERE id = $1 AND aguardando_resposta_desde IS NOT NULL
      RETURNING id`,
    [conv.id]
  );
  if (!claim.length) return { respondeu: false, motivo: 'JA_RESPONDIDA' };
  if (texto == null) return { respondeu: false, motivo: 'SEM_RESPOSTA' };

  const base = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
  let enq;
  try {
    enq = await waOutbox.enqueueHub({
      companyId,
      conversationId: conv.id,
      toPhone: conv.external_id,
      textBody: texto,
      sourceType: 'aurinha',
      dedupeKey: `hub:aurinha:${conv.id}:${base}`,
      lastInboundAt: conv.last_inbound_at,
      template: cfg.template,
    });
  } catch (e) {
    await restaurarPendencia(conv.id, conv.aguardando_resposta_desde);
    throw e;
  }
  if (enq.reason === 'SCHEMA_PENDENTE') {
    await restaurarPendencia(conv.id, conv.aguardando_resposta_desde);
    return { respondeu: false, motivo: 'SCHEMA_PENDENTE' };
  }
  await logEvent(companyId, conv.id, 'resposta_enfileirada', {
    outbox_id: enq.id || null, status: enq.status || null,
    motivo: enq.reason || null, parada: !!enq.held,
  });
  return { respondeu: !!enq.queued, enfileirada: !!enq.id, status: enq.status || null, motivo: enq.reason || null };
}

async function restaurarPendencia(conversationId, desde) {
  await db.query(
    `UPDATE hub_conversations
        SET aguardando_resposta_desde = COALESCE($2, NOW())
      WHERE id = $1 AND aguardando_resposta_desde IS NULL`,
    [conversationId, desde || null]
  ).catch(() => {});
}

// ── Mensagem do cliente (webhook) ────────────────────────────
// tenant: resultado de resolveTenant. Idempotente pelo id da Meta.
async function registrarInbound(tenant, msg, { nome = null, agora = new Date() } = {}) {
  const companyId = tenant.companyId;
  const phone = waOutbox.normalizePhone(msg && msg.from) || (msg && msg.from ? String(msg.from) : null);
  if (!msg || !msg.id || !phone) return { ok: false, reason: 'DADOS_INCOMPLETOS' };

  try {
    if (await jaGravada(companyId, msg.id)) return { ok: true, duplicate: true };

    const quando = dataDaMeta(msg.timestamp, agora);
    // Mensagem velha demais (webhook ficou fora do ar): grava, mas não
    // fica "aguardando" — responder a uma fala de dias atrás é pior que
    // deixar para o humano ver.
    const velha = agora.getTime() - quando.getTime() > WINDOW_MS;

    const { rows: convRows } = await db.query(
      `-- hubwa:conv-upsert
       INSERT INTO hub_conversations
         (company_id, channel, external_id, customer_name,
          last_inbound_at, last_message_at, aguardando_resposta_desde)
       VALUES ($1, 'whatsapp', $2, $3, $4, $4, $5)
       ON CONFLICT (company_id, channel, external_id) DO UPDATE SET
         customer_name = COALESCE(EXCLUDED.customer_name, hub_conversations.customer_name),
         last_inbound_at = GREATEST(COALESCE(hub_conversations.last_inbound_at, EXCLUDED.last_inbound_at), EXCLUDED.last_inbound_at),
         last_message_at = GREATEST(COALESCE(hub_conversations.last_message_at, EXCLUDED.last_message_at), EXCLUDED.last_message_at),
         aguardando_resposta_desde = COALESCE(hub_conversations.aguardando_resposta_desde, EXCLUDED.aguardando_resposta_desde),
         -- conversa resolvida que recebe mensagem nova reabre para a IA
         status = CASE WHEN hub_conversations.status = 'resolvida'
                       THEN 'ia' ELSE hub_conversations.status END,
         updated_at = NOW()
       RETURNING id, company_id, external_id, customer_name, status,
                 last_inbound_at, ultima_mensagem_humana_em, aguardando_resposta_desde`,
      [companyId, phone, nome || null, quando, velha ? null : quando]
    );
    const conv = convRows[0];
    if (!conv) return { ok: false, reason: 'SEM_CONVERSA' };

    const { rows: ins } = await db.query(
      `-- hubwa:msg-insert
       INSERT INTO hub_messages
         (company_id, conversation_id, channel, direction, author, external_message_id, content, metadata, created_at)
       VALUES ($1,$2,'whatsapp','inbound','cliente',$3,$4,$5,$6)
       ON CONFLICT (company_id, channel, external_message_id)
         WHERE external_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [companyId, conv.id, msg.id, textoDaMensagem(msg), JSON.stringify(msg), quando]
    );
    if (!ins.length) return { ok: true, duplicate: true, conversationId: conv.id };

    await logEvent(companyId, conv.id, 'mensagem_recebida', {
      canal: 'whatsapp', tipo: msg.type || null, external_message_id: msg.id,
    });

    // Resposta que ficou parada esperando template/janela perde o sentido
    // com fala nova: a avaliação abaixo decide o que dizer agora.
    await db.query(
      `-- hubwa:supersede
       UPDATE wa_outbox
          SET status = 'skipped', skip_reason = 'SUPERADA_POR_NOVA_MENSAGEM', updated_at = NOW()
        WHERE hub_conversation_id = $1 AND status = 'pending'
          AND next_attempt_at = 'infinity'::timestamptz`,
      [conv.id]
    ).catch((e) => { if (!isMissingSchema(e)) throw e; });

    if (!tenant.enabled) return { ok: true, conversationId: conv.id, avaliado: false, motivo: 'DESATIVADA' };
    if (conv.status !== 'ia') return { ok: true, conversationId: conv.id, avaliado: false, motivo: 'CONVERSA_NAO_IA' };
    if (velha) return { ok: true, conversationId: conv.id, avaliado: false, motivo: 'MENSAGEM_ANTIGA' };

    const r = await avaliarConversa(conv, tenant, { agora, registrarAgendamento: true });
    return { ok: true, conversationId: conv.id, avaliado: true, ...r };
  } catch (e) {
    if (isMissingSchema(e)) return { ok: false, reason: 'SCHEMA_PENDENTE' };
    throw e;
  }
}

// ── Eco do app do celular (coexistência) ─────────────────────
// echo: item de value.message_echoes (smb_message_echoes).
async function registrarEcho(tenant, echo, { agora = new Date() } = {}) {
  const companyId = tenant.companyId;
  const phone = waOutbox.normalizePhone(echo && echo.to) || (echo && echo.to ? String(echo.to) : null);
  if (!echo || !echo.id || !phone) return { ok: false, reason: 'DADOS_INCOMPLETOS' };

  try {
    // Envio da própria fila (API) pode voltar como eco: não é humano.
    const { rows: own } = await db.query(
      `-- hubwa:echo-proprio
       SELECT 1 FROM wa_outbox WHERE company_id = $1 AND wa_message_id = $2 LIMIT 1`,
      [companyId, echo.id]
    );
    if (own.length) return { ok: true, proprio: true };
    if (await jaGravada(companyId, echo.id)) return { ok: true, duplicate: true };

    const quando = dataDaMeta(echo.timestamp, agora);
    const { rows: convRows } = await db.query(
      `-- hubwa:echo-conv-upsert
       INSERT INTO hub_conversations
         (company_id, channel, external_id, last_message_at, ultima_mensagem_humana_em)
       VALUES ($1, 'whatsapp', $2, $3, $3)
       ON CONFLICT (company_id, channel, external_id) DO UPDATE SET
         ultima_mensagem_humana_em = GREATEST(COALESCE(hub_conversations.ultima_mensagem_humana_em, EXCLUDED.ultima_mensagem_humana_em), EXCLUDED.ultima_mensagem_humana_em),
         last_message_at = GREATEST(COALESCE(hub_conversations.last_message_at, EXCLUDED.last_message_at), EXCLUDED.last_message_at),
         -- o humano falou depois do cliente: não há mais nada aguardando
         aguardando_resposta_desde = CASE
           WHEN hub_conversations.last_inbound_at IS NULL
             OR hub_conversations.last_inbound_at <= EXCLUDED.ultima_mensagem_humana_em
           THEN NULL ELSE hub_conversations.aguardando_resposta_desde END,
         updated_at = NOW()
       RETURNING id`,
      [companyId, phone, quando]
    );
    const convId = convRows[0] && convRows[0].id;
    if (!convId) return { ok: false, reason: 'SEM_CONVERSA' };

    await db.query(
      `-- hubwa:echo-msg-insert
       INSERT INTO hub_messages
         (company_id, conversation_id, channel, direction, author, external_message_id, content, metadata, created_at)
       VALUES ($1,$2,'whatsapp','outbound','humano',$3,$4,$5,$6)
       ON CONFLICT (company_id, channel, external_message_id)
         WHERE external_message_id IS NOT NULL DO NOTHING`,
      [companyId, convId, echo.id, textoDaMensagem(echo), JSON.stringify({ source: 'smb_app' }), quando]
    );

    await cancelarRespostasDaAurinha(convId);
    await logEvent(companyId, convId, 'mensagem_humana', { canal: 'whatsapp', origem: 'app_do_celular' });
    return { ok: true, conversationId: convId };
  } catch (e) {
    if (isMissingSchema(e)) return { ok: false, reason: 'SCHEMA_PENDENTE' };
    throw e;
  }
}

// Humano falou pelo painel (POST /hub/.../reply): mesmo efeito do eco.
async function marcarRespostaHumana(companyId, conversationId, userId = null) {
  try {
    await db.query(
      `UPDATE hub_conversations
          SET ultima_mensagem_humana_em = NOW(), aguardando_resposta_desde = NULL,
              last_message_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [conversationId, companyId]
    );
    await cancelarRespostasDaAurinha(conversationId);
    await logEvent(companyId, conversationId, 'mensagem_humana', { canal: 'whatsapp', origem: 'painel' }, userId);
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
  }
}

// O que a Aurinha tinha na fila para esta conversa e ainda não saiu.
async function cancelarRespostasDaAurinha(conversationId) {
  try {
    await db.query(
      `-- hubwa:cancela-aurinha
       UPDATE wa_outbox
          SET status = 'skipped', skip_reason = 'HUMANO_RESPONDEU', updated_at = NOW()
        WHERE hub_conversation_id = $1 AND status = 'pending' AND source_type = 'aurinha'`,
      [conversationId]
    );
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
  }
}

// ── Job por minuto: reavalia o que ficou esperando ───────────
async function processarPendentes({ agora = new Date(), limit = 50 } = {}) {
  const out = { picked: 0, respondidas: 0, aguardando: 0, outras: 0, erros: 0 };
  const companyId = auraCompanyId();
  if (!companyId) return { ...out, dormente: true };

  let rows;
  try {
    ({ rows } = await db.query(
      `-- hubwa:pendentes
       SELECT c.id, c.company_id, c.external_id, c.customer_name, c.status,
              c.last_inbound_at, c.ultima_mensagem_humana_em, c.aguardando_resposta_desde,
              s.plantao
         FROM hub_conversations c
         JOIN hub_agent_settings s ON s.company_id = c.company_id
        WHERE c.company_id = $1
          AND c.channel = 'whatsapp'
          AND c.status = 'ia'
          AND c.aguardando_resposta_desde IS NOT NULL
          AND s.enabled = true
          AND s.wa_phone_number_id IS NOT NULL
        ORDER BY c.aguardando_resposta_desde ASC
        LIMIT $2`,
      [companyId, limit]
    ));
  } catch (e) {
    if (isMissingSchema(e)) return { ...out, dormente: true };
    throw e;
  }

  out.picked = rows.length;
  for (const conv of rows) {
    try {
      const r = await avaliarConversa(
        conv, { companyId: conv.company_id, plantao: conv.plantao }, { agora }
      );
      if (r.respondeu || r.enfileirada) out.respondidas++;
      else if (r.agendada) out.aguardando++;
      else out.outras++;
    } catch (e) {
      out.erros++;
      console.error('[HUB-WA] reavaliação falhou conv=%s: %s', conv.id, e.message);
      await logEvent(conv.company_id, conv.id, 'erro', { message: String(e.message).slice(0, 500) });
    }
  }
  return out;
}

module.exports = {
  auraCompanyId, resolveTenant,
  registrarInbound, registrarEcho, marcarRespostaHumana,
  responderNoHub, avaliarConversa, processarPendentes,
  TEXTO_STUB,
};
