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

// Ordem de progressão do onboarding (monotônica). rejected é terminal.
const STATUS_RANK = { created: 0, docs_pending: 1, under_review: 2, approved: 3, rejected: 4 };

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function isEnabled() {
  const v = String(process.env.DOJO_BAAS_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function str(v) {
  return v != null ? String(v).trim() : '';
}

function maskWallet(w) {
  const k = str(w);
  if (!k) return null;
  if (k.length <= 6) return '••••';
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

function hashWebhookToken(token) {
  return nodeCrypto.createHash('sha256').update(str(token)).digest('hex');
}

// URL pública do webhook desta subconta. env.API_URL já inclui /api/v1 no
// padrão do projeto; montamos defensivamente pra não duplicar o prefixo.
function resolveWebhookUrl() {
  const base = str(env.API_URL).replace(/\/+$/, '');
  if (!base) return 'https://aura-backend-production-f805.up.railway.app/api/v1/webhooks/asaas-dojo';
  return base.endsWith('/api/v1') ? `${base}/webhooks/asaas-dojo` : `${base}/api/v1/webhooks/asaas-dojo`;
}

// ── Validação de KYC (POST /baas/activate) ──
function validateKyc(body) {
  const b = body || {};
  const errors = [];
  const personType = str(b.person_type).toUpperCase();
  if (!['FISICA', 'JURIDICA'].includes(personType)) errors.push('person_type deve ser FISICA ou JURIDICA');

  const name = str(b.name);
  if (!name) errors.push('name é obrigatório');

  const digits = str(b.cpf_cnpj).replace(/\D/g, '');
  if (personType === 'FISICA' && digits.length !== 11) errors.push('cpf_cnpj deve ter 11 dígitos (CPF) para pessoa física');
  if (personType === 'JURIDICA' && digits.length !== 14) errors.push('cpf_cnpj deve ter 14 dígitos (CNPJ) para pessoa jurídica');
  if (!['FISICA', 'JURIDICA'].includes(personType) && !digits) errors.push('cpf_cnpj é obrigatório');

  const email = str(b.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('email inválido');

  const mobile = str(b.mobile_phone).replace(/\D/g, '');
  if (mobile.length < 10) errors.push('mobile_phone inválido (DDD + número)');

  const income = Number(b.income_value);
  if (!Number.isFinite(income) || income <= 0) errors.push('income_value deve ser maior que zero');

  const address = str(b.address);
  if (!address) errors.push('address é obrigatório');
  const addressNumber = str(b.address_number);
  if (!addressNumber) errors.push('address_number é obrigatório');
  const province = str(b.province);
  if (!province) errors.push('province (bairro) é obrigatório');
  const postal = str(b.postal_code).replace(/\D/g, '');
  if (postal.length !== 8) errors.push('postal_code deve ter 8 dígitos');

  const birthDate = str(b.birth_date);
  if (personType === 'FISICA' && (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate))) {
    errors.push('birth_date (YYYY-MM-DD) é obrigatório para pessoa física');
  }
  const companyType = str(b.company_type);
  if (personType === 'JURIDICA' && !companyType) {
    errors.push('company_type é obrigatório para pessoa jurídica');
  }

  if (errors.length) throw svcError(422, 'VALIDATION_ERROR', errors[0]);

  return {
    person_type: personType,
    name,
    cpf_cnpj: digits,
    company_type: companyType || null,
    birth_date: birthDate || null,
    email,
    mobile_phone: mobile,
    income_value: income,
    address,
    address_number: addressNumber,
    complement: str(b.complement) || null,
    province,
    postal_code: postal,
  };
}

function buildAsaasAccountPayload(kyc, webhookUrl, authToken) {
  const payload = {
    name: kyc.name,
    email: kyc.email,
    cpfCnpj: kyc.cpf_cnpj,
    mobilePhone: kyc.mobile_phone,
    incomeValue: kyc.income_value,
    address: kyc.address,
    addressNumber: kyc.address_number,
    province: kyc.province,
    postalCode: kyc.postal_code,
    webhooks: [{
      name: 'Aura Dojô conciliação',
      url: webhookUrl,
      email: kyc.email,
      enabled: true,
      interrupted: false,
      authToken,
      sendType: 'SEQUENTIALLY',
      events: WEBHOOK_EVENTS,
    }],
  };
  if (kyc.complement) payload.complement = kyc.complement;
  if (kyc.birth_date) payload.birthDate = kyc.birth_date;
  if (kyc.company_type) payload.companyType = kyc.company_type;
  return payload;
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

function isAccountStatusEvent(event, body) {
  const e = String(event || '').toUpperCase();
  if (e.includes('ACCOUNT_STATUS')) return true;
  if (body && (body.accountStatus || (body.account && body.account.status))) return true;
  return false;
}

function mapAccountStatus(event, body) {
  const acc = body && body.accountStatus;
  const hay = [
    event,
    body && body.status,
    typeof acc === 'string' ? acc : (acc && (acc.status || acc.general || acc.generalApproval)),
    body && body.account && body.account.status,
  ].map((x) => String(x || '').toUpperCase()).join(' ');
  if (/APPROVED|APROVAD/.test(hay)) return 'approved';
  if (/REJECT|RECUSAD|REPROVAD/.test(hay)) return 'rejected';
  if (/DOCUMENT|DOCUMENTAC/.test(hay)) return 'docs_pending';
  if (/AWAIT|PENDING|REVIEW|ANALISE|ANÁLISE/.test(hay)) return 'under_review';
  return null;
}

// Progressão monotônica + fora de ordem: nunca rebaixa 'approved' (só
// 'rejected' pode sobrescrever); 'rejected' é terminal; só avança no rank.
function shouldApplyStatus(cur, next) {
  if (!next || cur === next) return false;
  if (cur === 'rejected') return false;             // terminal
  if (next === 'rejected') return true;             // reprovação regulatória sempre aplica
  if (cur === 'approved') return false;             // nunca rebaixa aprovado (contrato)
  return (STATUS_RANK[next] || 0) > (STATUS_RANK[cur] || 0);
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
  findAccountByWebhookToken,
  isAccountStatusEvent,
  mapAccountStatus,
  applyAccountStatus,
  // exportados p/ teste
  validateKyc,
  shouldApplyStatus,
  WEBHOOK_EVENTS,
};
