// ============================================================
// AURA — CRM Fase 1: CONSENTIMENTO DE MARKETING POR CLIENTE (340)
//
// Uma fonte só para "este cliente aceitou receber marketing desta loja?".
//
//  - recordConsent grava o EVENTO (customer_consent_events, append-only)
//    e sincroniza os dois espelhos que já existiam: wa_contacts
//    (opted_in_at/opted_out_at/opt_source, que a fila lê) e
//    customers.marketing_opt_out (que as listas de candidatos leem).
//  - OPT-OUT PROPAGA para todas as empresas do mesmo dono: o cliente é do
//    dono (lista única), e quem pediu para sair de uma loja não pode
//    continuar recebendo promoção da loja irmã. OPT-IN NÃO propaga: cada
//    CNPJ é um controlador na LGPD e o aceite é dado a uma loja.
//  - canSendMarketing é a regra que a fila aplica em TODO envio de
//    marketing (enqueue, simulate e despacho):
//      1. opt-out sempre bloqueia (evento, wa_contacts ou cadastro);
//      2. sem data de corte (companies.wa_optin_required_from NULL) ou
//         com corte ainda no futuro → regra antiga, o consentimento
//         declarado da empresa;
//      3. corte já alcançado → só sai para quem tem opt-in individual,
//         senão SEM_OPTIN_CLIENTE.
//    Cobrança e mensagens de utilidade NÃO passam por aqui.
//
// Deploy antes da migration: a tabela (42P01) e a coluna (42703) são
// guardadas com cache module-level. Sem a tabela não há opt-in
// individual registrado — mas também não há data de corte, então a
// regra antiga continua valendo e nada muda para quem já envia.
// ============================================================
'use strict';

const db = require('../config/database');
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');

// A fila (waOutbox) consulta este módulo nas guardas de marketing e este
// módulo usa a normalização/declaração da fila: require tardio para não
// criar ciclo de carregamento.
function outbox() {
  return require('./waOutbox');
}

const ACTIONS = ['opt_in', 'opt_out'];
const CHANNELS = [
  'pdv', 'cadastro', 'whatsapp', 'canal_digital', 'qr',
  'importacao', 'manual', 'legitimo_interesse',
];

const SKIP_SEM_OPTIN = 'SEM_OPTIN_CLIENTE';

// Palavras de ACEITE em resposta a uma mensagem da loja. Comparação
// exata depois de normalizar (minúsculas, sem acento, sem pontuação):
// "Sim!" vale, "sim, tem no M?" não vale — consentimento é a resposta,
// não uma frase que por acaso começa com sim.
const YES_WORDS = new Set([
  'sim', 'quero', 'aceito', 'sim quero', 'quero sim', 'sim aceito', 'aceito sim',
]);

// Saída que chega por BOTÃO (o touchInbound só lê text.body): o botão
// padrão de marketing da Meta é "Parar promoções". Mesmas palavras do
// waOutbox.OPT_OUT_WORDS, mais as do botão.
const OUT_WORDS = new Set([
  'sair', 'parar', 'cancelar', 'stop', 'descadastrar',
  'parar promocoes', 'stop promotions',
]);

// Janela em que um "SIM" ainda é resposta a uma mensagem da loja.
const REPLY_WINDOW_DAYS = 7;

// ── Esquema pendente (340) — cache module-level ──────────────
const schema = { eventsMissing: false, cutoffMissing: false };

function isMissing(e) {
  return !!e && (e.code === '42P01' || e.code === '42703');
}

function isSchemaPending() {
  return schema.eventsMissing || schema.cutoffMissing;
}

// Só para teste: o cache sobrevive entre casos.
function _resetSchemaCache() {
  schema.eventsMissing = false;
  schema.cutoffMissing = false;
}

function normalizeText(t) {
  return String(t || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isYesReply(text) {
  return YES_WORDS.has(normalizeText(text));
}

// "Hoje" do lojista (America/Sao_Paulo), em YYYY-MM-DD.
function todayBRT(now = Date.now()) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}

function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function defaultOptinText(storeName) {
  const loja = String(storeName || '').trim() || 'nossa loja';
  return `Aceito receber ofertas e novidades da ${loja} pelo WhatsApp. Posso sair quando quiser respondendo SAIR.`;
}

function validationError(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  return e;
}

// ── Leituras ────────────────────────────────────────────────

async function loadStoreName(companyId) {
  try {
    const { rows } = await db.query(
      `-- consent:store-name
       SELECT COALESCE(trade_name, legal_name) AS store_name FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return (rows[0] && rows[0].store_name) || null;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

// Data de corte como 'YYYY-MM-DD' (o ::text evita o Date do node-pg,
// que interpretaria a data no fuso do servidor).
async function loadOptinRequiredFrom(companyId) {
  if (schema.cutoffMissing) return null;
  try {
    const { rows } = await db.query(
      `-- consent:cutoff-get
       SELECT wa_optin_required_from::text AS optin_required_from
         FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return (rows[0] && rows[0].optin_required_from) || null;
  } catch (e) {
    if (isMissing(e)) { schema.cutoffMissing = true; return null; }
    throw e;
  }
}

function cutoffActive(cutoff, now = Date.now()) {
  return !!cutoff && String(cutoff).slice(0, 10) <= todayBRT(now);
}

// Cliente dentro do grupo do dono (a lista é única entre os CNPJs).
async function loadCustomer(companyId, customerId) {
  if (!customerId) return null;
  const ids = await getOwnerScopedCompanyIds(companyId);
  const { rows } = await db.query(
    `-- consent:customer-get
     SELECT id, company_id, name, phone, marketing_opt_out
       FROM customers WHERE id = $1 AND company_id = ANY($2) LIMIT 1`,
    [customerId, ids]
  );
  return rows[0] || null;
}

// Clientes do grupo com este telefone (o cadastro guarda o telefone do
// jeito que foi digitado; compara só os dígitos, com e sem o 55).
async function findCustomerIdsByPhone(companyIds, phone) {
  if (!phone || !companyIds.length) return [];
  const { rows } = await db.query(
    `-- consent:customer-by-phone
     SELECT id FROM customers
      WHERE company_id = ANY($1)
        AND NULLIF(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
        AND (regexp_replace(phone, '[^0-9]', '', 'g') = $2
             OR '55' || regexp_replace(phone, '[^0-9]', '', 'g') = $2)`,
    [companyIds, phone]
  );
  return rows.map((r) => r.id);
}

// Estado atual do consentimento de UM cliente/telefone nesta empresa.
//   status: 'opt_in' | 'opt_out' | 'sem_registro'
// Opt-out vence mesmo quando o último EVENTO é opt-in: um opt-out gravado
// fora deste serviço (legado, antes da 340) continua valendo — o
// recordConsent de opt-in limpa os dois espelhos, então os três só
// divergem quando alguém saiu por um caminho que não gera evento.
async function getConsentStatus({ companyId, customerId = null, phone = null } = {}) {
  let p = outbox().normalizePhone(phone);
  let customer = null;
  if (customerId) {
    const { rows } = await db.query(
      `-- consent:status-customer
       SELECT id, phone, marketing_opt_out FROM customers WHERE id = $1 LIMIT 1`,
      [customerId]
    );
    customer = rows[0] || null;
    if (!p && customer) p = outbox().normalizePhone(customer.phone);
  }

  let ev = null;
  if (!schema.eventsMissing && (customerId || p)) {
    try {
      const { rows } = await db.query(
        `-- consent:status-event
         SELECT action, channel, created_at FROM customer_consent_events
          WHERE company_id = $1
            AND purpose = 'marketing'
            AND (($2::uuid IS NOT NULL AND customer_id = $2::uuid)
                 OR ($3::text IS NOT NULL AND phone = $3::text))
          ORDER BY created_at DESC
          LIMIT 1`,
        [companyId, customerId || null, p || null]
      );
      ev = rows[0] || null;
    } catch (e) {
      if (!isMissing(e)) throw e;
      schema.eventsMissing = true;
    }
  }

  let contact = null;
  if (p) {
    try {
      const { rows } = await db.query(
        `-- consent:status-contact
         SELECT opted_out_at, opt_source FROM wa_contacts
          WHERE company_id = $1 AND phone = $2 LIMIT 1`,
        [companyId, p]
      );
      contact = rows[0] || null;
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
  }

  if (ev && ev.action === 'opt_out') {
    return { status: 'opt_out', since: ev.created_at, channel: ev.channel };
  }
  if (contact && contact.opted_out_at) {
    return { status: 'opt_out', since: contact.opted_out_at, channel: contact.opt_source || null };
  }
  if (customer && customer.marketing_opt_out === true) {
    return { status: 'opt_out', since: null, channel: null };
  }
  if (ev && ev.action === 'opt_in') {
    return { status: 'opt_in', since: ev.created_at, channel: ev.channel };
  }
  return { status: 'sem_registro', since: null, channel: null };
}

// A REGRA de envio de marketing. Devolve { ok, reason }.
async function canSendMarketing({ companyId, customerId = null, phone = null } = {}) {
  const st = await getConsentStatus({ companyId, customerId, phone });
  if (st.status === 'opt_out') return { ok: false, reason: 'OPT_OUT' };

  const cutoff = await loadOptinRequiredFrom(companyId);
  if (cutoffActive(cutoff)) {
    return st.status === 'opt_in' ? { ok: true, reason: null } : { ok: false, reason: SKIP_SEM_OPTIN };
  }

  if (!(await outbox().hasMarketingConsent(companyId))) {
    return { ok: false, reason: 'SEM_CONSENTIMENTO' };
  }
  return { ok: true, reason: null };
}

async function listEvents({ companyId, customerId, phone = null, limit = 20 }) {
  if (schema.eventsMissing) return [];
  const p = outbox().normalizePhone(phone);
  try {
    const { rows } = await db.query(
      `-- consent:events-list
       SELECT id, company_id, customer_id, phone, action, channel, purpose,
              consent_text, collected_by, created_at
         FROM customer_consent_events
        WHERE company_id = $1
          AND (customer_id = $2::uuid OR ($3::text IS NOT NULL AND phone = $3::text))
        ORDER BY created_at DESC
        LIMIT $4`,
      [companyId, customerId, p || null, Math.max(1, Math.min(Number(limit) || 20, 100))]
    );
    return rows;
  } catch (e) {
    if (!isMissing(e)) throw e;
    schema.eventsMissing = true;
    return [];
  }
}

// ── Escrita ─────────────────────────────────────────────────

async function insertEvent({ companyId, customerId, phone, action, channel, text, userId }) {
  const { rows } = await db.query(
    `-- consent:event-insert
     INSERT INTO customer_consent_events
       (company_id, customer_id, phone, action, channel, purpose, consent_text, collected_by)
     VALUES ($1, $2, $3, $4, $5, 'marketing', $6, $7)
     RETURNING id, company_id, customer_id, phone, action, channel, purpose,
               consent_text, collected_by, created_at`,
    [companyId, customerId || null, phone || null, action, channel,
     text ? String(text).slice(0, 2000) : null, userId || null]
  );
  return rows[0] || null;
}

async function syncContact(companyId, phone, action, channel) {
  if (!phone) return;
  const optIn = action === 'opt_in';
  try {
    await db.query(
      `-- consent:contact-sync
       INSERT INTO wa_contacts (company_id, phone, opted_in_at, opted_out_at, opt_source)
       VALUES ($1, $2, CASE WHEN $3 THEN NOW() END, CASE WHEN $3 THEN NULL ELSE NOW() END, $4)
       ON CONFLICT (company_id, phone) DO UPDATE SET
         opted_in_at  = CASE WHEN $3 THEN NOW() ELSE NULL END,
         opted_out_at = CASE WHEN $3 THEN NULL ELSE NOW() END,
         opt_source = $4,
         updated_at = NOW()`,
      [companyId, phone, optIn, channel]
    );
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
}

async function syncCustomerFlag(customerIds, optOut) {
  if (!customerIds.length) return;
  try {
    await db.query(
      `-- consent:customer-flag
       UPDATE customers SET marketing_opt_out = $2, updated_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [customerIds, !!optOut]
    );
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
}

// Grava um opt-in/opt-out. Lança VALIDATION_ERROR para entrada inválida
// e NOT_FOUND para cliente fora do grupo; devolve
// { ok:false, code:'SCHEMA_PENDING' } com a 340 pendente.
//
// Sem transação de propósito: o EVENTO é a prova e vai primeiro; os
// espelhos são idempotentes e a próxima gravação os corrige. Uma
// transação aqui faria um erro no espelho apagar a prova.
async function recordConsent({
  companyId, customerId = null, phone = null, action, channel,
  text = null, userId = null,
} = {}) {
  if (!companyId) throw validationError('companyId obrigatório');
  if (!ACTIONS.includes(action)) throw validationError(`action deve ser ${ACTIONS.join(' | ')}`);
  if (!CHANNELS.includes(channel)) throw validationError(`channel deve ser ${CHANNELS.join(' | ')}`);

  let p = outbox().normalizePhone(phone);
  if (phone && !p) throw validationError('telefone inválido');

  let customer = null;
  if (customerId) {
    customer = await loadCustomer(companyId, customerId);
    if (!customer) {
      const e = new Error('Cliente não encontrado');
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (!p) p = outbox().normalizePhone(customer.phone);
  }
  if (!customer && !p) throw validationError('customerId ou telefone obrigatório');

  if (schema.eventsMissing) return { ok: false, code: 'SCHEMA_PENDING' };

  const optOut = action === 'opt_out';
  // Opt-out vale para o grupo inteiro do dono; opt-in só para esta loja.
  const companyIds = optOut ? await getOwnerScopedCompanyIds(companyId) : [companyId];
  if (!companyIds.includes(companyId)) companyIds.unshift(companyId);
  // A empresa pedida grava primeiro (é a que responde à tela).
  companyIds.sort((a, b) => (a === companyId ? -1 : b === companyId ? 1 : 0));

  // Quem é este telefone no cadastro: o evento do webhook chega só com
  // o número, e o opt-out precisa marcar todos os cadastros dele.
  let customerIds = customer ? [customer.id] : [];
  if (p && (optOut || !customer)) {
    const ownerIds = optOut ? companyIds : await getOwnerScopedCompanyIds(companyId);
    const found = await findCustomerIdsByPhone(ownerIds, p);
    customerIds = Array.from(new Set([...customerIds, ...found]));
  }
  const eventCustomerId = customer ? customer.id : (customerIds.length === 1 ? customerIds[0] : null);

  const events = [];
  for (const cid of companyIds) {
    try {
      const ev = await insertEvent({
        companyId: cid, customerId: eventCustomerId, phone: p, action, channel, text, userId,
      });
      if (ev) events.push(ev);
    } catch (e) {
      if (!isMissing(e)) throw e;
      schema.eventsMissing = true;
      return { ok: false, code: 'SCHEMA_PENDING' };
    }
    await syncContact(cid, p, action, channel);
  }

  // O flag do cadastro é do dono (lista única): opt-out liga para todos
  // os cadastros do telefone; opt-in desliga só o cadastro aceito — o
  // opt-out das outras lojas continua valendo pelos eventos delas.
  if (optOut) await syncCustomerFlag(customerIds, true);
  else if (eventCustomerId) await syncCustomerFlag([eventCustomerId], false);

  return {
    ok: true,
    action,
    channel,
    phone: p,
    customer_id: eventCustomerId,
    company_ids: companyIds,
    events,
  };
}

// ── WhatsApp (webhook) ──────────────────────────────────────

// A loja mandou algo para este telefone há pouco? É o que torna um "SIM"
// resposta a uma mensagem da loja, e não uma palavra solta na conversa.
async function hasRecentStoreMessage(companyId, phone, days = REPLY_WINDOW_DAYS) {
  try {
    const { rows } = await db.query(
      `-- consent:recent-store-outbox
       SELECT 1 FROM wa_outbox
        WHERE company_id = $1 AND to_phone = $2
          AND status IN ('sent','delivered','read')
          AND created_at > NOW() - ($3::int || ' days')::interval
        LIMIT 1`,
      [companyId, phone, days]
    );
    if (rows.length) return true;
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
  try {
    const { rows } = await db.query(
      `-- consent:recent-store-message
       SELECT 1 FROM wa_messages
        WHERE company_id = $1 AND direction = 'outbound'
          AND regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g') = $2
          AND created_at > NOW() - ($3::int || ' days')::interval
        LIMIT 1`,
      [companyId, phone, days]
    );
    return rows.length > 0;
  } catch (e) {
    if (!isMissing(e)) throw e;
    return false;
  }
}

// Chamado pelo webhook DEPOIS do touchInbound (que já cuidou da janela
// de 24h e das palavras SAIR/VOLTAR no wa_contacts). Aqui essas mesmas
// palavras viram EVENTO, e o "SIM" em resposta à loja vira opt-in.
//   touched: retorno do waOutbox.touchInbound ({ opt_out, opt_in }).
//   isReply: a mensagem do cliente cita uma mensagem (context.id) ou é
//            clique num botão de template.
async function handleInboundReply({ companyId, phone, text, touched = null, isReply = false }) {
  const p = outbox().normalizePhone(phone);
  if (!companyId || !p) return { recorded: false };
  const raw = text ? String(text).slice(0, 500) : null;

  if ((touched && touched.opt_out) || OUT_WORDS.has(normalizeText(text))) {
    const r = await recordConsent({ companyId, phone: p, action: 'opt_out', channel: 'whatsapp', text: raw });
    return { recorded: !!r.ok, action: 'opt_out' };
  }
  if (touched && touched.opt_in) {
    const r = await recordConsent({ companyId, phone: p, action: 'opt_in', channel: 'whatsapp', text: raw });
    return { recorded: !!r.ok, action: 'opt_in' };
  }
  if (!isYesReply(text)) return { recorded: false };

  // "SIM" não desfaz um opt-out: para voltar, o cliente usa as palavras
  // de retorno (VOLTAR). Opt-out sempre vence.
  const st = await getConsentStatus({ companyId, phone: p });
  if (st.status === 'opt_out') return { recorded: false, reason: 'OPT_OUT' };
  if (st.status === 'opt_in') return { recorded: false, reason: 'JA_OPTIN' };
  if (!isReply && !(await hasRecentStoreMessage(companyId, p))) {
    return { recorded: false, reason: 'SEM_MENSAGEM_DA_LOJA' };
  }
  const r = await recordConsent({ companyId, phone: p, action: 'opt_in', channel: 'whatsapp', text: raw });
  return { recorded: !!r.ok, action: 'opt_in' };
}

// ── Configuração e resumo ───────────────────────────────────

async function setOptinRequiredFrom(companyId, value) {
  try {
    await db.query(
      `-- consent:cutoff-set
       UPDATE companies SET wa_optin_required_from = $2::date WHERE id = $1`,
      [companyId, value || null]
    );
    schema.cutoffMissing = false;
    return true;
  } catch (e) {
    if (isMissing(e)) { schema.cutoffMissing = true; return false; }
    throw e;
  }
}

function summarySql(withEvents) {
  const lastAction = withEvents
    ? `(SELECT e.action FROM customer_consent_events e
          WHERE e.company_id = $1 AND e.purpose = 'marketing'
            AND (e.customer_id = b.id OR e.phone = b.phone)
          ORDER BY e.created_at DESC LIMIT 1)`
    : 'NULL::text';
  return `-- consent:summary
    WITH base AS (
      SELECT c.id, c.marketing_opt_out,
             CASE WHEN length(c.d) = 10 THEN '55' || c.d
                  WHEN length(c.d) = 11 AND substr(c.d, 3, 1) = '9' THEN '55' || c.d
                  ELSE c.d END AS phone
        FROM (SELECT id, marketing_opt_out, is_active, company_id,
                     regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') AS d
                FROM customers) c
       WHERE c.company_id = $1
         AND c.is_active IS NOT FALSE
         AND length(c.d) BETWEEN 10 AND 15
    ), st AS (
      SELECT b.id,
             (COALESCE(b.marketing_opt_out, false)
              OR EXISTS (SELECT 1 FROM wa_contacts w
                          WHERE w.company_id = $1 AND w.phone = b.phone
                            AND w.opted_out_at IS NOT NULL)) AS saiu,
             ${lastAction} AS last_action
        FROM base b
    )
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE saiu OR last_action = 'opt_out')::int AS opt_out,
           COUNT(*) FILTER (WHERE NOT saiu AND last_action = 'opt_in')::int AS opt_in
      FROM st`;
}

function shapeSummary(total, optIn, optOut) {
  const t = Number(total) || 0;
  const i = Number(optIn) || 0;
  const o = Number(optOut) || 0;
  return {
    total_clientes_com_telefone: t,
    opt_in: i,
    opt_out: o,
    sem_registro: Math.max(0, t - i - o),
    pct_opt_in: t > 0 ? Math.round((i / t) * 1000) / 10 : 0,
  };
}

// Resumo de UMA empresa. A base é a mesma das rotinas de marketing: os
// clientes cadastrados nesta empresa, ativos, com telefone válido.
async function getSummary(companyId) {
  let row;
  let schemaPending = schema.eventsMissing;
  try {
    ({ rows: [row] } = await db.query(summarySql(!schema.eventsMissing), [companyId]));
  } catch (e) {
    if (!isMissing(e) || schema.eventsMissing) throw e;
    schema.eventsMissing = true;
    schemaPending = true;
    ({ rows: [row] } = await db.query(summarySql(false), [companyId]));
  }
  const r = row || {};
  const [storeName, cutoff] = await Promise.all([
    loadStoreName(companyId),
    loadOptinRequiredFrom(companyId),
  ]);
  return {
    company_id: companyId,
    ...shapeSummary(r.total, r.opt_in, r.opt_out),
    optin_required_from: cutoff,
    optin_required_active: cutoffActive(cutoff),
    texto_optin_padrao: defaultOptinText(storeName),
    schema_pending: schemaPending,
  };
}

module.exports = {
  ACTIONS, CHANNELS, SKIP_SEM_OPTIN, YES_WORDS, REPLY_WINDOW_DAYS,
  normalizeText, isYesReply, todayBRT, isIsoDate, defaultOptinText,
  loadStoreName, loadOptinRequiredFrom, cutoffActive, setOptinRequiredFrom,
  getConsentStatus, canSendMarketing, listEvents,
  recordConsent, handleInboundReply, hasRecentStoreMessage,
  getSummary, shapeSummary,
  isSchemaPending, _resetSchemaCache,
};
