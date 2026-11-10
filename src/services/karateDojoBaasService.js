// ============================================================
// AURA DOJÔ — F3b: Service da Conta Aura do dojô (BaaS via subconta Asaas)
//
// OPT-IN e atrás da feature flag DOJO_BAAS_ENABLED (env, default OFF —
// homologação regulatória Asaas pendente). Com a flag OFF: getStatus devolve
// enabled:false e o resto do billing (F3a, pix_manual) segue 100% intacto;
// activate → 503 BAAS_DISABLED; resolveActiveBaas nunca toca o banco.
//
// A subconta guarda a apiKey CIFRADA (dojoBaasCrypto, AES-256-GCM). NUNCA
// logamos apiKey/authToken em texto puro. O webhook da subconta autentica
// por HASH (SHA-256) do authToken (asaas-access-token) — só o hash é gravado.
//
// Margem Aura = split fixo de 0,5% pra wallet da conta-mãe
// (env ASAAS_DOJO_MOTHER_WALLET_ID) em cada cobrança PIX criada via subconta.
//
// Escopo SEMPRE por dojoId (o company do dojô) — nunca do body/query. As
// rotas tratam 42P01 (migration 244 pendente); aqui, nos caminhos de leitura,
// tratamos 42P01 como "sem conta" (BaaS indisponível), nunca 500.
// ============================================================
'use strict';

const nodeCrypto = require('crypto');
const db = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');
const asaasClient = require('./asaasClient');
const { encrypt, decrypt } = require('./dojoBaasCrypto');
// RA-05 (10/11/2026): helpers puros extraídos para baasShared.js (mesmo
// código, sem mudança de comportamento) — o varejo (companyBaasService) usa os
// mesmos.
const {
  svcError, flagOn, str, maskWallet, hashWebhookToken, validateKyc,
  buildAccountPayload, isAccountStatusEvent, mapAccountStatus, shouldApplyStatus,
} = require('./baasShared');

const env = validateRuntimeEnv();

// Eventos que a subconta deve empurrar pro nosso webhook. Pagamentos são os
// nomes canônicos da Asaas; os de status de conta têm nome PROVISÓRIO (a
// confirmar na homologação sandbox) — o handler do webhook também casa por
// heurística de prefixo/conteúdo, então nomes exatos não travam a conciliação.
const WEBHOOK_EVENTS = [
  'PAYMENT_RECEIVED',
  'PAYMENT_CONFIRMED',
  'ACCOUNT_STATUS_APPROVED',
  'ACCOUNT_STATUS_REJECTED',
  'ACCOUNT_STATUS_AWAITING_APPROVAL',
  'ACCOUNT_STATUS_PENDING',
];

function isEnabled() {
  return flagOn('DOJO_BAAS_ENABLED');
}

// URL pública do webhook desta subconta. env.API_URL já inclui /api/v1 no
// padrão do projeto; montamos defensivamente pra não duplicar o prefixo.
function resolveWebhookUrl() {
  const base = str(env.API_URL).replace(/\/+$/, '');
  if (!base) return 'https://aura-backend-production-f805.up.railway.app/api/v1/webhooks/asaas-dojo';
  return base.endsWith('/api/v1') ? `${base}/webhooks/asaas-dojo` : `${base}/api/v1/webhooks/asaas-dojo`;
}

function buildAsaasAccountPayload(kyc, webhookUrl, authToken) {
  return buildAccountPayload(kyc, [{
    name: 'Aura Dojô conciliação',
    url: webhookUrl,
    email: kyc.email,
    enabled: true,
    interrupted: false,
    authToken,
    sendType: 'SEQUENTIALLY',
    events: WEBHOOK_EVENTS,
  }]);
}

// ── GET /baas ──
async function getStatus(dojoId) {
  const enabled = isEnabled();
  let row = null;
  try {
    const { rows } = await db.query(
      `SELECT status, provider_selected, onboarding_url, agency, account, account_digit, wallet_id
         FROM karate_dojo_baas_accounts WHERE dojo_id = $1 LIMIT 1`,
      [dojoId]
    );
    row = rows[0] || null;
  } catch (e) {
    if (!(e && e.code === '42P01')) throw e; // migration 244 pendente → trata como sem conta
    row = null;
  }
  if (!row) {
    return { enabled, status: 'none', onboarding_url: null, provider: 'pix_manual', account: null };
  }
  return {
    enabled,
    status: row.status,
    onboarding_url: row.onboarding_url || null,
    provider: row.provider_selected || 'pix_manual',
    account: {
      agency: row.agency || null,
      account: row.account || null,
      account_digit: row.account_digit || null,
      wallet_id_masked: maskWallet(row.wallet_id),
    },
  };
}

// ── POST /baas/activate ──
async function activate(dojoId, body) {
  if (!isEnabled()) {
    throw svcError(503, 'BAAS_DISABLED', 'A Conta Aura do dojô (BaaS) está em homologação e ainda não está disponível.');
  }
  const kyc = validateKyc(body); // 422 VALIDATION_ERROR

  let existing;
  try {
    const { rows } = await db.query(
      `SELECT id FROM karate_dojo_baas_accounts WHERE dojo_id = $1 LIMIT 1`,
      [dojoId]
    );
    existing = rows[0];
  } catch (e) {
    if (e && e.code === '42P01') throw svcError(503, 'SCHEMA_PENDING', 'Conta Aura do dojô ainda não disponível (migration 244 pendente)');
    throw e;
  }
  if (existing) throw svcError(409, 'BAAS_JA_ATIVADO', 'Este dojô já iniciou a ativação da Conta Aura.');

  // Token do webhook: cru só vai pra Asaas; guardamos só o hash.
  const authToken = nodeCrypto.randomBytes(32).toString('hex');
  const authTokenHash = hashWebhookToken(authToken);
  const webhookUrl = resolveWebhookUrl();

  let created;
  try {
    // Subconta é criada com a credencial da conta-MÃE (asaasClient default).
    created = await asaasClient.asaasRequest('POST', '/accounts', buildAsaasAccountPayload(kyc, webhookUrl, authToken));
  } catch (e) {
    console.error('[karateDojoBaas] falha ao criar subconta Asaas:', e.message); // nunca loga apiKey/authToken
    throw svcError(502, 'BAAS_INDISPONIVEL', 'Não foi possível criar a Conta Aura do dojô junto ao Asaas agora. Tente novamente em instantes.');
  }

  const apiKeyEnc = created && created.apiKey ? encrypt(created.apiKey) : null;
  const acctNum = (created && created.accountNumber) || {};
  // onboarding_url: a criação nem sempre traz. TODO(homologação): obter a URL
  // de onboarding/documentação via GET quando disponível.
  const onboardingUrl = (created && (created.onboardingUrl || created.onboarding_url)) || null;

  let inserted;
  try {
    const { rows } = await db.query(
      `INSERT INTO karate_dojo_baas_accounts
         (dojo_id, asaas_account_id, api_key_enc, wallet_id, agency, account, account_digit,
          status, onboarding_url, webhook_token_hash, provider_selected, kyc_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'created', $8, $9, 'pix_manual', $10)
       RETURNING onboarding_url`,
      [
        dojoId,
        (created && created.id) || null,
        apiKeyEnc,
        (created && created.walletId) || null,
        acctNum.agency || null,
        acctNum.account || null,
        acctNum.accountDigit || null,
        onboardingUrl,
        authTokenHash,
        JSON.stringify(kyc), // KYC ok guardar; sem dados de cartão
      ]
    );
    inserted = rows[0];
  } catch (e) {
    if (e && e.code === '23505') throw svcError(409, 'BAAS_JA_ATIVADO', 'Este dojô já iniciou a ativação da Conta Aura.');
    if (e && e.code === '42P01') throw svcError(503, 'SCHEMA_PENDING', 'Conta Aura do dojô ainda não disponível (migration 244 pendente)');
    throw e;
  }

  return { status: 'created', onboarding_url: (inserted && inserted.onboarding_url) || onboardingUrl || null };
}

// ── PUT /baas/provider ──
async function setProvider(dojoId, provider) {
  const p = str(provider);
  if (!['pix_manual', 'baas'].includes(p)) {
    throw svcError(422, 'VALIDATION_ERROR', "provider deve ser 'pix_manual' ou 'baas'");
  }
  if (p === 'pix_manual') {
    // Sempre permitido (volta pra chave própria). Sem registro → no-op.
    try {
      await db.query(
        `UPDATE karate_dojo_baas_accounts SET provider_selected = 'pix_manual', updated_at = now() WHERE dojo_id = $1`,
        [dojoId]
      );
    } catch (e) {
      if (!(e && e.code === '42P01')) throw e;
    }
    return { provider: 'pix_manual' };
  }

  // baas: só com subconta aprovada.
  let row;
  try {
    const { rows } = await db.query(
      `SELECT status FROM karate_dojo_baas_accounts WHERE dojo_id = $1 LIMIT 1`,
      [dojoId]
    );
    row = rows[0];
  } catch (e) {
    if (e && e.code === '42P01') throw svcError(409, 'PROVIDER_NAO_DISPONIVEL', 'A Conta Aura do dojô ainda não está disponível.');
    throw e;
  }
  if (!row || row.status !== 'approved') {
    throw svcError(409, 'PROVIDER_NAO_DISPONIVEL', 'A Conta Aura do dojô só pode ser usada como recebedor após a aprovação do Asaas.');
  }
  await db.query(
    `UPDATE karate_dojo_baas_accounts SET provider_selected = 'baas', updated_at = now() WHERE dojo_id = $1`,
    [dojoId]
  );
  return { provider: 'baas' };
}

// ── Provider efetivo pra cobrança (usado por karateDojoBillingService) ──
// Retorna { apiKey, walletId, asaasAccountId } quando o dojô optou por baas E
// a subconta está aprovada E a flag está ligada; senão null. NÃO toca o banco
// quando a flag está desligada (mantém o caminho pix_manual do F3a intacto).
async function resolveActiveBaas(dojoId) {
  if (!isEnabled()) return null;
  let row;
  try {
    const { rows } = await db.query(
      `SELECT status, provider_selected, api_key_enc, wallet_id, asaas_account_id
         FROM karate_dojo_baas_accounts WHERE dojo_id = $1 LIMIT 1`,
      [dojoId]
    );
    row = rows[0];
  } catch (e) {
    if (e && e.code === '42P01') return null;
    throw e;
  }
  if (!row) return null;
  if (row.provider_selected !== 'baas' || row.status !== 'approved') return null;
  if (!row.api_key_enc) return null;
  let apiKey;
  try {
    apiKey = decrypt(row.api_key_enc);
  } catch (e) {
    throw svcError(502, 'BAAS_INDISPONIVEL', 'Não foi possível acessar a credencial da Conta Aura do dojô.');
  }
  return { apiKey, walletId: row.wallet_id, asaasAccountId: row.asaas_account_id };
}

// ── Cobrança PIX NA SUBCONTA do dojô (com split de 0,5% pra conta-mãe) ──
async function createChargePixViaBaas({ account, amount, chargeId, competence, dueDate }) {
  const motherWallet = str(process.env.ASAAS_DOJO_MOTHER_WALLET_ID);
  const body = {
    billingType: 'PIX',
    value: Number(amount),
    dueDate: dueDate || new Date().toISOString().split('T')[0],
    externalReference: chargeId,
    description: `Mensalidade ${competence}`,
  };
  if (motherWallet) {
    body.split = [{ walletId: motherWallet, percentualValue: 0.5 }];
  } else {
    console.warn('[karateDojoBaas] ASAAS_DOJO_MOTHER_WALLET_ID ausente — cobrança criada SEM split de margem Aura');
  }

  const payment = await asaasClient.asaasRequest('POST', '/payments', body, account.apiKey);
  if (!payment || !payment.id) throw svcError(502, 'BAAS_INDISPONIVEL', 'Asaas não retornou o pagamento da subconta.');

  const qr = await asaasClient.asaasRequest('GET', `/payments/${encodeURIComponent(payment.id)}/pixQrCode`, null, account.apiKey);
  const payload = qr && qr.payload;
  if (!payload) throw svcError(502, 'BAAS_INDISPONIVEL', 'Asaas não retornou o QR Code PIX da cobrança.');

  return { payment_id: payment.id, payload, qr_image: (qr && qr.encodedImage) || null };
}

// Re-busca o BR Code de um pagamento JÁ criado na subconta (por payment_id =
// pix_txid). Usado para NÃO criar uma segunda cobrança quando o pagamento já
// existe mas o pix_payload não persistiu (A1). É uma LEITURA, sem side-effect.
async function fetchChargePixViaBaas({ account, paymentId }) {
  const qr = await asaasClient.asaasRequest(
    'GET', `/payments/${encodeURIComponent(paymentId)}/pixQrCode`, null, account.apiKey
  );
  return { payment_id: paymentId, payload: (qr && qr.payload) || null, qr_image: (qr && qr.encodedImage) || null };
}

// ── Webhook: helpers de conciliação ──
async function findAccountByWebhookToken(token) {
  const t = str(token);
  if (!t) return null;
  const hash = hashWebhookToken(t);
  try {
    const { rows } = await db.query(
      `SELECT dojo_id, status FROM karate_dojo_baas_accounts WHERE webhook_token_hash = $1 LIMIT 1`,
      [hash]
    );
    return rows[0] || null;
  } catch (e) {
    if (e && e.code === '42P01') return null;
    throw e;
  }
}

async function applyAccountStatus(dojoId, newStatus) {
  if (!newStatus) return { changed: false, status: null };
  let cur;
  try {
    const { rows } = await db.query(
      `SELECT status FROM karate_dojo_baas_accounts WHERE dojo_id = $1 LIMIT 1`,
      [dojoId]
    );
    cur = rows[0] && rows[0].status;
  } catch (e) {
    if (e && e.code === '42P01') return { changed: false, status: null };
    throw e;
  }
  if (!cur) return { changed: false, status: null };
  if (!shouldApplyStatus(cur, newStatus)) return { changed: false, status: cur };
  await db.query(
    `UPDATE karate_dojo_baas_accounts SET status = $2, updated_at = now() WHERE dojo_id = $1`,
    [dojoId, newStatus]
  );
  return { changed: true, status: newStatus };
}

module.exports = {
  isEnabled,
  getStatus,
  activate,
  setProvider,
  resolveActiveBaas,
  createChargePixViaBaas,
  fetchChargePixViaBaas,
  findAccountByWebhookToken,
  isAccountStatusEvent,
  mapAccountStatus,
  applyAccountStatus,
  // exportados p/ teste
  validateKyc,
  shouldApplyStatus,
  WEBHOOK_EVENTS,
};
