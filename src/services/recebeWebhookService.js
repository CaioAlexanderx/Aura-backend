// ============================================================
// AURA. — Recebe na Aura: avisos da Asaas das SUBCONTAS (RA-07, 13/11/2026)
//
// Rota própria (routes/webhookRecebe.js, /webhooks/asaas-recebe), separada do
// webhook das assinaturas da Aura (webhookAsaas.js). Modelo A: a Asaas presta
// o serviço financeiro e a Aura integra; o dinheiro nunca passa pela Aura.
//
// AUTENTICAÇÃO. A Asaas manda o authToken do webhook no header
// `asaas-access-token` (docs.asaas.com, "Criar novo Webhook pela API"). O
// segredo é por ambiente:
//   RECEBE_ASAAS_WEBHOOK_TOKEN          produção
//   RECEBE_ASAAS_SANDBOX_WEBHOOK_TOKEN  quando ASAAS_ENV=sandbox
// Assim o token do sandbox nunca vale em produção e vice-versa. Sem segredo
// configurado (ou com menos de 32 caracteres, o mínimo da Asaas para o
// authToken), a rota RECUSA tudo: nunca aceita aviso sem prova. A comparação
// é por SHA-256 + timingSafeEqual (não vaza o tamanho). O token nunca é logado.
//
// IDEMPOTÊNCIA. A Asaas entrega "at least once" e o id do evento (evt_...) se
// repete no reenvio (docs.asaas.com, "Como implementar idempotência em
// Webhooks"). recebe_webhook_events (migration 449) tem UNIQUE em
// asaas_event_id; a reserva é INSERT ... ON CONFLICT DO NOTHING e só quem
// inseriu processa. Reenvio e corrida caem no conflito. Exceção: um evento em
// 'error' (ou em 'processing' parado há mais de 5 min, processo que morreu no
// meio) é retomado pelo reenvio, por UPDATE atômico (só uma entrega ganha).
//
// EVENTOS (docs.asaas.com, "Eventos para verificar situação da conta" e
// "Eventos para cobranças"):
//   ACCOUNT_STATUS_*  os 18 da Asaas, incluindo os de documentos
//     (ACCOUNT_STATUS_DOCUMENT_APPROVED | _AWAITING_APPROVAL | _PENDING |
//     _REJECTED). Gravam os 4 blocos de `accountStatus` pela função do RA-06
//     (companyBaasService.saveAccountStatus), com a data do evento
//     (dateCreated): retrato mais velho não sobrescreve um mais novo.
//   PAYMENT_*         só registrados (PAYMENT_CONFIRMED, PAYMENT_RECEIVED,
//     PAYMENT_REFUNDED, ...). O efeito no pedido/venda vem no RA-09/RA-10,
//     pela external_reference gravada.
//   qualquer outro    registrado como 'ignored'.
// Subconta desconhecida (account.id sem linha em company_baas_accounts):
// registra sem empresa e não processa.
//
// FLAG RECEBE_NA_AURA_ENABLED desligada: com o token válido, registra
// ('flag_off') e responde 200 sem processar, para a Asaas não reenviar.
//
// Respostas: 200 para tudo que foi registrado (inclusive reenvio). 500 quando
// o processamento falhou depois da reserva (fica 'error' e o reenvio da Asaas
// retoma). 503 com a flag ligada e a migration 449 pendente: sem a tabela não
// há como garantir que o evento não seja processado duas vezes.
// ============================================================
'use strict';

const nodeCrypto = require('crypto');
const db = require('../config/database');
const companyBaas = require('./companyBaasService');
const { str } = require('./baasShared');

const TOKEN_ENV = 'RECEBE_ASAAS_WEBHOOK_TOKEN';
const SANDBOX_TOKEN_ENV = 'RECEBE_ASAAS_SANDBOX_WEBHOOK_TOKEN';
// Mínimo da Asaas para o authToken do webhook (32 a 255 caracteres).
const MIN_TOKEN_LENGTH = 32;
// 'processing' parado há mais que isso = a entrega anterior morreu no meio.
const STALE_PROCESSING_MINUTES = 5;

// Os 18 eventos de situação da conta (docs.asaas.com, "Eventos para
// verificar situação da conta"). Qualquer ACCOUNT_STATUS_* novo também é
// tratado como evento de conta; a lista serve de referência e de teste.
const ACCOUNT_STATUS_EVENTS = [
  'ACCOUNT_STATUS_BANK_ACCOUNT_INFO_APPROVED',
  'ACCOUNT_STATUS_BANK_ACCOUNT_INFO_AWAITING_APPROVAL',
  'ACCOUNT_STATUS_BANK_ACCOUNT_INFO_PENDING',
  'ACCOUNT_STATUS_BANK_ACCOUNT_INFO_REJECTED',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_APPROVED',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_AWAITING_APPROVAL',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_PENDING',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_REJECTED',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_EXPIRING_SOON',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_EXPIRED',
  'ACCOUNT_STATUS_DOCUMENT_APPROVED',
  'ACCOUNT_STATUS_DOCUMENT_AWAITING_APPROVAL',
  'ACCOUNT_STATUS_DOCUMENT_PENDING',
  'ACCOUNT_STATUS_DOCUMENT_REJECTED',
  'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED',
  'ACCOUNT_STATUS_GENERAL_APPROVAL_AWAITING_APPROVAL',
  'ACCOUNT_STATUS_GENERAL_APPROVAL_PENDING',
  'ACCOUNT_STATUS_GENERAL_APPROVAL_REJECTED',
];

// Pagamentos que o RA-09/RA-10 vão usar (só registrados por enquanto).
const PAYMENT_EVENTS_OF_INTEREST = [
  'PAYMENT_CREATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE',
  'PAYMENT_DELETED', 'PAYMENT_RESTORED', 'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED',
  'PAYMENT_REFUND_IN_PROGRESS', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL', 'PAYMENT_SPLIT_DONE', 'PAYMENT_SPLIT_CANCELLED',
  'PAYMENT_SPLIT_DIVERGENCE_BLOCK', 'PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED',
];

function isSandbox() {
  return str(process.env.ASAAS_ENV).toLowerCase() === 'sandbox';
}

// Nome da variável que vale no ambiente atual (lida a cada chamada).
function secretEnvName() {
  return isSandbox() ? SANDBOX_TOKEN_ENV : TOKEN_ENV;
}

function sha256(v) {
  return nodeCrypto.createHash('sha256').update(String(v)).digest();
}

// { ok, reason }. reason só vai para o log, nunca para a resposta.
function checkToken(received) {
  const secret = str(process.env[secretEnvName()]);
  if (!secret) return { ok: false, reason: 'sem_segredo_configurado' };
  if (secret.length < MIN_TOKEN_LENGTH) return { ok: false, reason: 'segredo_curto_demais' };
  const got = str(Array.isArray(received) ? received[0] : received);
  if (!got) return { ok: false, reason: 'sem_token' };
  const ok = nodeCrypto.timingSafeEqual(sha256(got), sha256(secret));
  return ok ? { ok: true } : { ok: false, reason: 'token_invalido' };
}

// dateCreated da Asaas vem como "2024-06-12 16:45:03", no horário de
// Brasília. Aceita também ISO com fuso. null = sem data aproveitável.
function parseAsaasDate(v) {
  const s = str(v);
  if (!s) return null;
  let d;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/);
  if (m) d = new Date(`${m[1]}T${m[2]}${m[3] || ''}-03:00`);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(`${s}T00:00:00-03:00`);
  else d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function kindOf(event) {
  const e = str(event).toUpperCase();
  if (e.startsWith('ACCOUNT_STATUS_')) return 'account_status';
  if (e.startsWith('PAYMENT_')) return 'payment';
  return 'other';
}

function limit(v, n) {
  const s = str(v);
  return s ? s.slice(0, n) : null;
}

// Campos que vão para as colunas (o corpo inteiro vai em payload).
function extract(body) {
  const b = body && typeof body === 'object' ? body : {};
  const payment = b.payment && typeof b.payment === 'object' ? b.payment : {};
  const account = b.account && typeof b.account === 'object' ? b.account : {};
  const accountStatus = b.accountStatus && typeof b.accountStatus === 'object' ? b.accountStatus : null;
  const event = limit(b.event, 120);
  const kind = kindOf(event);
  // account.id identifica a conta dona do aviso; nos de situação da conta,
  // accountStatus.id é o mesmo id (fallback).
  const accountId = limit(account.id, 120)
    || (kind === 'account_status' && accountStatus ? limit(accountStatus.id, 120) : null);
  return {
    eventId: limit(b.id, 200),
    event,
    kind,
    accountId,
    accountStatus,
    paymentId: limit(payment.id, 120),
    paymentStatus: limit(payment.status, 60),
    externalReference: limit(payment.externalReference, 200),
    eventAt: parseAsaasDate(b.dateCreated),
  };
}

// Reserva o evento. Devolve { id, fresh } ou null (já registrado/processado).
async function reserve(x, body, outcome) {
  const { rows } = await db.query(
    `INSERT INTO recebe_webhook_events
       (asaas_event_id, event, asaas_account_id, asaas_payment_id, external_reference,
        event_created_at, payload, outcome, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, CASE WHEN $8 = 'processing' THEN NULL ELSE now() END)
     ON CONFLICT (asaas_event_id) DO NOTHING
     RETURNING id`,
    [
      x.eventId, x.event || '(sem evento)', x.accountId, x.paymentId, x.externalReference,
      x.eventAt ? x.eventAt.toISOString() : null, JSON.stringify(body), outcome,
    ]
  );
  if (rows[0]) return { id: rows[0].id, fresh: true };
  if (outcome !== 'processing') return null;
  // Retomada: só o que falhou (ou parou no meio). UPDATE atômico: duas
  // entregas ao mesmo tempo, só uma recebe a linha de volta.
  const r = await db.query(
    `UPDATE recebe_webhook_events
        SET outcome = 'processing', attempts = attempts + 1, claimed_at = now(), detail = NULL
      WHERE asaas_event_id = $1
        AND (outcome = 'error'
             OR (outcome = 'processing' AND claimed_at < now() - ($2 || ' minutes')::interval))
      RETURNING id`,
    [x.eventId, String(STALE_PROCESSING_MINUTES)]
  );
  return r.rows[0] ? { id: r.rows[0].id, fresh: false } : null;
}

async function finish(id, outcome, detail, companyId) {
  await db.query(
    `UPDATE recebe_webhook_events
        SET outcome = $2, detail = $3, company_id = $4, processed_at = now()
      WHERE id = $1`,
    [id, outcome, detail ? String(detail).slice(0, 500) : null, companyId || null]
  );
}

async function findCompanyByAccountId(accountId) {
  if (!accountId) return null;
  try {
    const { rows } = await db.query(
      `SELECT company_id FROM company_baas_accounts WHERE asaas_account_id = $1 LIMIT 1`,
      [accountId]
    );
    return rows[0] ? rows[0].company_id : null;
  } catch (e) {
    if (e && e.code === '42P01') return null; // 436 pendente: nenhuma subconta
    throw e;
  }
}

// Aplica o efeito do evento. Devolve { outcome, detail }.
async function apply(x, companyId) {
  if (x.kind === 'account_status') {
    if (!x.accountStatus) return { outcome: 'registered', detail: 'sem_accountStatus' };
    if (!x.eventAt) return { outcome: 'registered', detail: 'sem_data_do_evento' };
    const r = await companyBaas.saveAccountStatus(companyId, x.accountStatus, x.eventAt);
    if (r.changed) return { outcome: 'processed', detail: `status=${r.status}` };
    if (r.reason === 'retrato_mais_velho') return { outcome: 'stale', detail: r.reason };
    if (r.reason === 'sem_subconta') return { outcome: 'unknown_account', detail: r.reason };
    return { outcome: 'registered', detail: r.reason || null };
  }
  if (x.kind === 'payment') {
    // RA-07: só registro. O efeito no pedido/venda é do RA-09/RA-10.
    return {
      outcome: 'registered',
      detail: [x.paymentStatus && `status=${x.paymentStatus}`, x.externalReference ? 'com_referencia' : 'sem_referencia']
        .filter(Boolean).join(' '),
    };
  }
  return { outcome: 'ignored', detail: null };
}

// Trata um aviso JÁ AUTENTICADO. Devolve { status, body } para a rota.
async function handleEvent(body) {
  const x = extract(body);
  if (!x.eventId) {
    // Sem id não há idempotência: não registra e não processa. 200 para a
    // Asaas não insistir num corpo que nunca vai mudar.
    console.warn('[recebe-webhook] aviso sem id de evento, ignorado: event=' + (x.event || '(sem evento)'));
    return { status: 200, body: { received: true, handled: false, reason: 'sem_id' } };
  }
  const tag = `${x.event || '(sem evento)'} ${x.eventId}`;

  // Flag desligada: registra e não processa.
  if (!companyBaas.isEnabled()) {
    try {
      await reserve(x, body, 'flag_off');
    } catch (e) {
      console.warn(`[recebe-webhook] flag desligada; não deu para registrar ${tag}: ${e && (e.code || e.message)}`);
    }
    return { status: 200, body: { received: true, handled: false, reason: 'flag_off' } };
  }

  let claim;
  try {
    claim = await reserve(x, body, 'processing');
  } catch (e) {
    if (e && e.code === '42P01') {
      console.error(`[recebe-webhook] migration 449 pendente — ${tag} não registrado (503 para a Asaas reenviar)`);
      return { status: 503, body: { received: false, code: 'SCHEMA_PENDING' } };
    }
    console.error(`[recebe-webhook] falha ao registrar ${tag}: ${e && e.message}`);
    return { status: 500, body: { received: false, code: 'INTERNAL_ERROR' } };
  }
  if (!claim) {
    return { status: 200, body: { received: true, handled: false, duplicate: true } };
  }

  let companyId = null;
  try {
    companyId = await findCompanyByAccountId(x.accountId);
    if (!companyId) {
      await finish(claim.id, 'unknown_account', x.accountId ? 'subconta_desconhecida' : 'sem_account_id', null);
      console.warn(`[recebe-webhook] ${tag}: subconta desconhecida — registrado sem empresa`);
      return { status: 200, body: { received: true, handled: false, reason: 'unknown_account' } };
    }
    const r = await apply(x, companyId);
    await finish(claim.id, r.outcome, r.detail, r.outcome === 'unknown_account' ? null : companyId);
    console.log(`[recebe-webhook] ${tag} → ${r.outcome}${r.detail ? ' (' + r.detail + ')' : ''}`);
    return { status: 200, body: { received: true, handled: r.outcome === 'processed', outcome: r.outcome } };
  } catch (e) {
    console.error(`[recebe-webhook] falha ao processar ${tag}: ${e && (e.code || e.message)}`);
    try {
      await finish(claim.id, 'error', (e && (e.code || e.message)) || 'erro', companyId);
    } catch (_) { /* o 'processing' parado é retomado depois de 5 min */ }
    return { status: 500, body: { received: false, code: 'INTERNAL_ERROR' } };
  }
}

module.exports = {
  TOKEN_ENV,
  SANDBOX_TOKEN_ENV,
  MIN_TOKEN_LENGTH,
  ACCOUNT_STATUS_EVENTS,
  PAYMENT_EVENTS_OF_INTEREST,
  checkToken,
  secretEnvName,
  handleEvent,
  // exportados p/ teste
  parseAsaasDate,
  kindOf,
  extract,
};
