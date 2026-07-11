// ============================================================
// AURA KARATÊ — Payment Provider Abstraction (Track B)
//
// MVP = static_brcode (BR Code gerado localmente, sem webhook).
// Confirmação é manual pelo admin via POST /payments/:id/confirm.
//
// Fase F5 (conciliação automática): o provider agora pode ser
// configurado POR FEDERAÇÃO em digital_channel_config
// (karate_payment_provider + credenciais), com fallback pro env
// KARATE_PAYMENT_PROVIDER (comportamento anterior, global). Sem
// nenhuma das duas coisas configuradas, o provider default continua
// 'static_brcode' — nada muda pra quem não configurou.
//
// Interface estável:
//   createPixCharge({ federationId, amount, txid, description })
//     → { payment_intent_id, payload, qr_image|null, status:'pending', expires_at, provider }
//   getStatus({ payment_intent_id, provider?, federationId? })
//     → { status: 'pending'|'paid'|'expired', paid_at }
//     provider, quando informado (ex.: o provider já gravado no intent),
//     tem prioridade sobre a resolução por federationId/env — evita uma
//     consulta a mais e garante que o polling usa o MESMO provider que
//     originou o intent, mesmo que a config da federação mude depois.
//
// Como configurar a chave PIX da federação:
//   Insira (ou atualize) uma linha em digital_channel_config com
//   company_id = federationId e preencha pix_key, pix_key_type,
//   pix_holder_name, pix_holder_city.
//   Esses campos foram adicionados pela migration 088.
//
// Como configurar um provider dinâmico pra uma federação (Fase F5):
//   Preencha em digital_channel_config (migration 224):
//     karate_payment_provider              identificador do provider dinamico ja suportado pelo stub abaixo
//     karate_payment_provider_api_key      credencial da conta/subconta
//     karate_payment_provider_base_url     (opcional) override de URL base
//     karate_payment_provider_webhook_secret  usado pra validar o webhook
//   Sem isso, cai no fallback de env (KARATE_PAYMENT_PROVIDER + os envs
//   específicos do provider) e, sem nenhum dos dois, em static_brcode.
// ============================================================
'use strict';

const db = require('../config/database');
const { buildStaticBrCode, validatePixKey } = require('./staticPixService');

// ── Provider ativo default (env-driven) — usado quando a federação não
// tem override em digital_channel_config.karate_payment_provider ────
// SEAM DO BaaS (Fase 0): esta é a interface abstrata de pagamento. Hoje o
// provider ativo é 'static_brcode' (BR Code PIX local). Um provider 'baas'
// (Aura Banking) pluga aqui como novo case de createPixCharge/getStatus, sem
// tocar os call-sites. A reconciliação é agnóstica de provider via o ledger
// karate_payment_intents, que agora guarda amount + source_type/source_id
// (migration 213). BaaS permanece INATIVO até aprovação da federação.
const ACTIVE_PROVIDER = process.env.KARATE_PAYMENT_PROVIDER || 'static_brcode';

// ── Cache module-level: evita repetir o try/catch de coluna ausente
// (CLAUDE.md armadilha #1) a cada request depois que já sabemos se as
// colunas da Fase F5 existem no banco. ──────────────────────────────
let _f5ColumnsAvailable = null; // null=desconhecido, true/false=cacheado

/**
 * Busca a config da federação (chave PIX + provider dinâmico/credenciais)
 * via digital_channel_config. Retorna null se não houver linha.
 * Defensivo contra migration 224 ainda não aplicada (42703 — coluna
 * ausente): cai pro schema legado (só campos de PIX estático).
 */
async function _fetchFederationConfig(federationId) {
  if (_f5ColumnsAvailable !== false) {
    try {
      const { rows } = await db.query(
        `SELECT pix_key, pix_key_type, pix_holder_name, pix_holder_city,
                karate_payment_provider, karate_payment_provider_api_key,
                karate_payment_provider_base_url, karate_payment_provider_webhook_secret
         FROM digital_channel_config
         WHERE company_id = $1
         LIMIT 1`,
        [federationId]
      );
      _f5ColumnsAvailable = true;
      return rows[0] || null;
    } catch (e) {
      if (e.code !== '42703') throw e;
      _f5ColumnsAvailable = false; // colunas da F5 ainda não migradas — cacheia e cai pro legado abaixo
    }
  }

  const { rows } = await db.query(
    `SELECT pix_key, pix_key_type, pix_holder_name, pix_holder_city
     FROM digital_channel_config
     WHERE company_id = $1
     LIMIT 1`,
    [federationId]
  );
  return rows[0] || null;
}

function _resolveProvider(cfg) {
  const configured = cfg && cfg.karate_payment_provider && String(cfg.karate_payment_provider).trim();
  return configured || ACTIVE_PROVIDER;
}

// ── static_brcode provider ─────────────────────────────────
async function _staticBrCodeCreate({ federationId, amount, txid, description, cfg }) {
  const resolvedCfg = cfg !== undefined ? cfg : await _fetchFederationConfig(federationId);

  if (!resolvedCfg || !resolvedCfg.pix_key || !String(resolvedCfg.pix_key).trim()) {
    // Fallback: mock payload (sem chave configurada)
    // Para configurar: INSERT INTO digital_channel_config
    //   (company_id, pix_key, pix_key_type, pix_holder_name, pix_holder_city)
    //   VALUES (<federationId>, '<chave>', 'CNPJ'|'CPF'|'EMAIL'|'PHONE'|'EVP',
    //           '<nome>', '<cidade>');
    const mockPayload = [
      '000201',
      '26580014br.gov.bcb.pix',
      `0136mock-${String(federationId).slice(0, 22)}`,
      '52040000',
      '5303986',
      `5406${Number(amount).toFixed(2)}`,
      '5802BR',
      '5920FEDERACAO KARATE',
      '6009BRASIL',
      `621405${String(txid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).padEnd(10, '0')}`,
      '6304MOCK',
    ].join('');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    return {
      payment_intent_id: `static-mock-${txid}`,
      payload: mockPayload,
      qr_image: null,
      status: 'pending',
      expires_at: expiresAt,
      provider: 'static_brcode',
      _warn: 'PIX nao configurado para esta federacao — use mock. Configure digital_channel_config.',
    };
  }

  const validation = validatePixKey(resolvedCfg.pix_key, resolvedCfg.pix_key_type);
  if (!validation.valid) {
    throw new Error('Chave PIX invalida na federacao: ' + validation.error);
  }

  const payload = buildStaticBrCode({
    pixKey: validation.normalized,
    amount,
    beneficiaryName: resolvedCfg.pix_holder_name || 'FEDERACAO KARATE',
    beneficiaryCity: resolvedCfg.pix_holder_city || 'BRASIL',
    txid: txid || 'karate',
  });

  // BR Code estático não expira — usamos 24h como convenção de display
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return {
    payment_intent_id: `static-${txid}`,
    payload,
    qr_image: null,   // frontend gera QR a partir do payload
    status: 'pending',
    expires_at: expiresAt,
    provider: 'static_brcode',
  };
}

async function _staticBrCodeGetStatus({ payment_intent_id }) {
  // BR Code estático sem webhook: status é sempre pending até admin confirmar.
  // O status real vem da tabela karate_payment_intents (atualizada pelo confirm).
  return { status: 'pending', paid_at: null };
}

// ── Provider dinâmico (STUB — não ativo até haver credenciais) ────
// Ativa por federação (digital_channel_config.karate_payment_provider) ou
// globalmente (env KARATE_PAYMENT_PROVIDER). Credenciais: por federação
// (karate_payment_provider_api_key/_base_url) com fallback pros envs
// especificos do provider dinamico ja configurados no stub abaixo. A
// interface já está pronta pra integração real — sem nenhuma credencial
// configurada, nunca é chamada (o provider resolvido cai em 'static_brcode').
async function _asaasCreate({ federationId, amount, txid, description, apiKey, baseUrl }) {
  const ASAAS_BASE = baseUrl || process.env.ASAAS_API_URL || 'https://api.asaas.com/v3';
  const ASAAS_KEY  = apiKey || process.env.ASAAS_API_KEY;
  if (!ASAAS_KEY) throw new Error('Credencial do provedor dinamico nao configurada');

  const dueDate = new Date(Date.now() + 30 * 60 * 1000).toISOString().split('T')[0];
  const resp = await fetch(`${ASAAS_BASE}/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_KEY },
    body: JSON.stringify({
      billingType: 'PIX',
      customer: federationId,  // customer do provedor pra federação (configurar antes)
      value: amount,
      dueDate,
      description: description || 'Anuidade Karate',
      externalReference: txid,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Erro do provedor dinamico: ' + JSON.stringify(data));

  const qrResp = await fetch(`${ASAAS_BASE}/payments/${data.id}/pixQrCode`, {
    headers: { 'access_token': ASAAS_KEY },
  });
  const qrData = await qrResp.json();

  return {
    payment_intent_id: data.id,
    payload: qrData.payload || null,
    qr_image: qrData.encodedImage || null,
    status: 'pending',
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    provider: 'asaas',
  };
}

async function _asaasGetStatus({ payment_intent_id, apiKey, baseUrl }) {
  const ASAAS_BASE = baseUrl || process.env.ASAAS_API_URL || 'https://api.asaas.com/v3';
  const ASAAS_KEY  = apiKey || process.env.ASAAS_API_KEY;
  if (!ASAAS_KEY) throw new Error('Credencial do provedor dinamico nao configurada');

  const resp = await fetch(`${ASAAS_BASE}/payments/${payment_intent_id}`, {
    headers: { 'access_token': ASAAS_KEY },
  });
  const data = await resp.json();
  const PAID_STATUSES = ['CONFIRMED', 'RECEIVED'];
  const status = PAID_STATUSES.includes(data.status) ? 'paid'
               : data.status === 'OVERDUE'           ? 'expired'
               : 'pending';
  return {
    status,
    paid_at: data.paymentDate || data.clientPaymentDate || null,
  };
}

// ── Public interface ───────────────────────────────────────

async function createPixCharge({ federationId, amount, txid, description }) {
  const cfg = await _fetchFederationConfig(federationId);
  const provider = _resolveProvider(cfg);

  switch (provider) {
    case 'asaas':
      return _asaasCreate({
        federationId, amount, txid, description,
        apiKey: cfg && cfg.karate_payment_provider_api_key,
        baseUrl: cfg && cfg.karate_payment_provider_base_url,
      });
    case 'static_brcode':
    default:
      return _staticBrCodeCreate({ federationId, amount, txid, description, cfg });
  }
}

async function getStatus({ payment_intent_id, provider, federationId }) {
  let resolvedProvider = provider;
  let cfg = null;
  if (!resolvedProvider) {
    if (federationId) {
      cfg = await _fetchFederationConfig(federationId);
      resolvedProvider = _resolveProvider(cfg);
    } else {
      resolvedProvider = ACTIVE_PROVIDER;
    }
  }

  switch (resolvedProvider) {
    case 'asaas':
      if (!cfg && federationId) cfg = await _fetchFederationConfig(federationId);
      return _asaasGetStatus({
        payment_intent_id,
        apiKey: cfg && cfg.karate_payment_provider_api_key,
        baseUrl: cfg && cfg.karate_payment_provider_base_url,
      });
    case 'static_brcode':
    default:
      return _staticBrCodeGetStatus({ payment_intent_id });
  }
}

module.exports = { createPixCharge, getStatus, ACTIVE_PROVIDER };
