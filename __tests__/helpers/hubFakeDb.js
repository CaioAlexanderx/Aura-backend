// ============================================================
// Banco FAKE em memória para os testes da Aurinha de plantão (375).
//
// Não é um Postgres: reconhece as consultas do hub pelos marcadores
// `-- hubwa:*` / `-- wa:*` que o código já carrega e guarda o estado
// mínimo (conversas, mensagens, eventos, fila) para que idempotência,
// claim e cancelamento sejam testados de verdade — duas entregas do
// mesmo webhook caem no MESMO estado, não em dois mocks soltos.
// ============================================================
'use strict';

function makeWorld(over = {}) {
  return {
    auraCompanyId: '11111111-1111-4111-8111-111111111111',
    // hub_agent_settings do tenant Aura
    settings: { enabled: true, plantao: null, waPhoneNumberId: 'PN_AURA' },
    // companies.wa_phone_number_id das lojas (fluxo atual)
    stores: { PN_LOJA: 'company-loja' },
    convs: [],
    messages: [],
    events: [],
    outbox: [],
    queries: [],
    // guardas da fila
    countToday: 0,
    templateStatus: null, // status do template em wa_templates
    pauseReason: null,
    contactInvalid: false,
    _seq: 0,
    ...over,
  };
}

function nextId(world, p) { world._seq += 1; return `${p}-${world._seq}`; }

function handler(world) {
  return (sql, params = []) => {
    const s = String(sql);
    world.queries.push({ sql: s, params });
    const rows = (r) => Promise.resolve({ rows: r });

    // ── webhook (fluxo atual das lojas) ──
    if (/FROM companies WHERE wa_phone_number_id=\$1/.test(s)) {
      const id = world.stores[params[0]];
      return rows(id ? [{ id }] : []);
    }

    // ── tenant / conversa / mensagem ──
    if (s.includes('-- hubwa:tenant')) {
      const [cid, pn] = params;
      if (cid === world.auraCompanyId && pn === world.settings.waPhoneNumberId) {
        return rows([{
          company_id: cid, enabled: world.settings.enabled,
          approval_mode: false, plantao: world.settings.plantao,
        }]);
      }
      return rows([]);
    }
    if (s.includes('-- hubwa:msg-dup')) {
      return rows(world.messages.some((m) => m.external_message_id === params[1]) ? [{ '?column?': 1 }] : []);
    }
    if (s.includes('-- hubwa:conv-upsert')) {
      const [companyId, phone, nome, quando, aguard] = params;
      let c = world.convs.find((x) => x.external_id === phone && x.channel === 'whatsapp');
      if (!c) {
        c = {
          id: nextId(world, 'conv'), company_id: companyId, channel: 'whatsapp', external_id: phone,
          customer_name: nome, status: 'ia', last_inbound_at: quando, last_message_at: quando,
          aguardando_resposta_desde: aguard, ultima_mensagem_humana_em: null,
        };
        world.convs.push(c);
      } else {
        c.customer_name = nome || c.customer_name;
        if (!c.last_inbound_at || quando > c.last_inbound_at) c.last_inbound_at = quando;
        c.aguardando_resposta_desde = c.aguardando_resposta_desde || aguard;
        if (c.status === 'resolvida') c.status = 'ia';
      }
      return rows([{ ...c }]);
    }
    if (s.includes('-- hubwa:msg-insert')) {
      const [companyId, convId, wamid, content, metadata, quando] = params;
      if (world.messages.some((m) => m.company_id === companyId && m.external_message_id === wamid)) return rows([]);
      const m = {
        id: nextId(world, 'msg'), company_id: companyId, conversation_id: convId,
        direction: 'inbound', author: 'cliente', external_message_id: wamid, content, metadata, created_at: quando,
      };
      world.messages.push(m);
      return rows([{ id: m.id }]);
    }
    if (/INSERT INTO hub_agent_events/.test(s)) {
      world.events.push({ company_id: params[0], conversation_id: params[1], type: params[2], detail: params[3] ? JSON.parse(params[3]) : null });
      return rows([]);
    }
    if (s.includes('-- hubwa:supersede')) {
      for (const o of world.outbox) {
        if (o.hub_conversation_id === params[0] && o.status === 'pending' && o.held) {
          o.status = 'skipped'; o.skip_reason = 'SUPERADA_POR_NOVA_MENSAGEM';
        }
      }
      return rows([]);
    }
    if (s.includes('-- hubwa:stub-recente')) {
      const hit = world.outbox.some((o) => o.hub_conversation_id === params[0]
        && o.source_type === 'aurinha' && o.status !== 'skipped');
      return rows(hit ? [{ '?column?': 1 }] : []);
    }
    if (s.includes('-- hubwa:claim')) {
      const c = world.convs.find((x) => x.id === params[0]);
      if (c && c.aguardando_resposta_desde) { c.aguardando_resposta_desde = null; return rows([{ id: c.id }]); }
      return rows([]);
    }
    if (/SET aguardando_resposta_desde = NULL, updated_at = NOW\(\)\s+WHERE id = \$1/.test(s)) {
      const c = world.convs.find((x) => x.id === params[0]);
      if (c) c.aguardando_resposta_desde = null;
      return rows([]);
    }
    if (/SET aguardando_resposta_desde = COALESCE\(\$2, NOW\(\)\)/.test(s)) {
      const c = world.convs.find((x) => x.id === params[0]);
      if (c && !c.aguardando_resposta_desde) c.aguardando_resposta_desde = params[1] || new Date();
      return rows([]);
    }
    if (s.includes('-- hubwa:pendentes')) {
      const out = world.convs
        .filter((c) => c.company_id === params[0] && c.channel === 'whatsapp' && c.status === 'ia'
          && c.aguardando_resposta_desde && world.settings.enabled && world.settings.waPhoneNumberId)
        .map((c) => ({ ...c, plantao: world.settings.plantao }));
      return rows(out);
    }

    // ── eco do app do celular ──
    if (s.includes('-- hubwa:echo-proprio')) {
      return rows(world.outbox.some((o) => o.wa_message_id === params[1]) ? [{ '?column?': 1 }] : []);
    }
    if (s.includes('-- hubwa:echo-conv-upsert')) {
      const [companyId, phone, quando] = params;
      let c = world.convs.find((x) => x.external_id === phone && x.channel === 'whatsapp');
      if (!c) {
        c = {
          id: nextId(world, 'conv'), company_id: companyId, channel: 'whatsapp', external_id: phone,
          customer_name: null, status: 'ia', last_inbound_at: null, last_message_at: quando,
          aguardando_resposta_desde: null, ultima_mensagem_humana_em: quando,
        };
        world.convs.push(c);
      } else {
        if (!c.ultima_mensagem_humana_em || quando > c.ultima_mensagem_humana_em) c.ultima_mensagem_humana_em = quando;
        if (!c.last_inbound_at || c.last_inbound_at <= quando) c.aguardando_resposta_desde = null;
      }
      return rows([{ id: c.id }]);
    }
    if (s.includes('-- hubwa:echo-msg-insert')) {
      const [companyId, convId, wamid, content, metadata, quando] = params;
      if (!world.messages.some((m) => m.company_id === companyId && m.external_message_id === wamid)) {
        world.messages.push({
          id: nextId(world, 'msg'), company_id: companyId, conversation_id: convId,
          direction: 'outbound', author: 'humano', external_message_id: wamid, content, metadata, created_at: quando,
        });
      }
      return rows([]);
    }
    if (s.includes('-- hubwa:cancela-aurinha')) {
      for (const o of world.outbox) {
        if (o.hub_conversation_id === params[0] && o.status === 'pending' && o.source_type === 'aurinha') {
          o.status = 'skipped'; o.skip_reason = 'HUMANO_RESPONDEU';
        }
      }
      return rows([]);
    }
    if (/UPDATE hub_conversations\s+SET ultima_mensagem_humana_em = NOW\(\)/.test(s)) {
      const c = world.convs.find((x) => x.id === params[0]);
      if (c) { c.ultima_mensagem_humana_em = new Date(); c.aguardando_resposta_desde = null; }
      return rows([]);
    }

    // ── guardas e fila (waOutbox.enqueueHub) ──
    if (s.includes('-- wa:contact-get')) {
      return rows(world.contactInvalid ? [{ id: 'c1', invalid_at: new Date() }] : []);
    }
    if (s.includes('-- wa:guard-paused')) {
      return rows(world.pauseReason ? [{ wa_paused_reason: world.pauseReason }] : []);
    }
    if (s.includes('-- wa:guard-count-today')) {
      return rows([{ n: world.countToday }]);
    }
    if (s.includes('-- wa:guard-template')) {
      return rows(world.templateStatus ? [{ status: world.templateStatus }] : []);
    }
    if (s.includes('-- wa:outbox-enqueue-hub')) {
      const [companyId, phone, kind, templateName, templateLanguage, textBody,
        status, skipReason, sourceType, sourceId, dedupeKey, convId, held] = params;
      if (dedupeKey && world.outbox.some((o) => o.dedupe_key === dedupeKey)) return rows([]);
      const o = {
        id: nextId(world, 'out'), company_id: companyId, to_phone: phone, kind,
        template_name: templateName, template_language: templateLanguage, text_body: textBody,
        status, skip_reason: skipReason, source_type: sourceType, source_id: sourceId,
        dedupe_key: dedupeKey, hub_conversation_id: convId, held: !!held,
        next_attempt_at: held ? 'infinity' : 'now', created_at: new Date(), wa_message_id: null,
      };
      world.outbox.push(o);
      return rows([{ id: o.id, status: o.status }]);
    }

    return rows([]);
  };
}

module.exports = { makeWorld, handler };
