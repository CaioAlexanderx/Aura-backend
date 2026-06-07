// ============================================================
// AURA KARATÊ — Payment Provider Abstraction (Track B)
//
// MVP = static_brcode (BR Code gerado localmente, sem webhook).
// Confirmação é manual pelo admin via POST /payments/:id/confirm.
//
// Para habilitar Asaas no futuro:
//   1. Set env KARATE_PAYMENT_PROVIDER=asaas
//   2. Configure ASAAS_API_URL + ASAAS_API_KEY
//   3. O case 'asaas' abaixo já tem a interface pronta.
//
// Interface estável:
//   createPixCharge({ federationId, amount, txid, description })
//     → { payment_intent_id, payload, qr_image|null, status:'pending', expires_at, provider }
//   getStatus({ payment_intent_id })
//     → { status: 'pending'|'paid'|'expired', paid_at }
//
// Como configurar a chave PIX da federação:
//   Insira (ou atualize) uma linha em digital_channel_config com
//   company_id = federationId e preencha pix_key, pix_key_type,
//   pix_holder_name, pix_holder_city.
//   Esses campos foram adicionados pela migration 088.
// ============================================================
'use strict';

const db = require('../config/database');
const { buildStaticBrCode, validatePixKey } = require('./staticPixService');

// ── Provider ativo (env-driven, default: static_brcode) ────
const ACTIVE_PROVIDER = process.env.KARATE_PAYMENT_PROVIDER || 'static_brcode';

/**
 * Busca a chave PIX configurada para a federação via digital_channel_config.
 * Retorna null se não configurada.
 */
async function _fetchFederationPixConfig(federationId) {
  const { rows } = await db.query(
    `SELECT pix_key, pix_key_type, pix_holder_name, pix_holder_city
     FROM digital_channel_config
     WHERE company_id = $1
     LIMIT 1`,
    [federationId]
  );
  return rows[0] || null;
}

// ── static_brcode provider ─────────────────────────────────
async function _staticBrCodeCreate({ federationId, amount, txid, description }) {
  const cfg = await _fetchFederationPixConfig(federationId);

  if (!cfg || !cfg.pix_key || !String(cfg.pix_key).trim()) {
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

  const validation = validatePixKey(cfg.pix_key, cfg.pix_key_type);
  if (!validation.valid) {
    throw new Error('Chave PIX invalida na federacao: ' + validation.error);
  }

  const payload = buildStaticBrCode({
    pixKey: validation.normalized,
    amount,
    beneficiaryName: cfg.pix_holder_name || 'FEDERACAO KARATE',
    beneficiaryCity: cfg.pix_holder_city || 'BRASIL',
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

// ── Asaas provider (STUB — não ativo no MVP) ───────────────
// Para ativar: set KARATE_PAYMENT_PROVIDER=asaas + configure as env vars abaixo.
// A interface já está pronta para integração real.
async function _asaasCreate({ federationId, amount, txid, description }) {
  // Requer: ASAAS_API_URL, ASAAS_API_KEY (token da conta master ou subconta)
  const ASAAS_BASE = process.env.ASAAS_API_URL || 'https://api.asaas.com/v3';
  const ASAAS_KEY  = process.env.ASAAS_API_KEY;
  if (!ASAAS_KEY) throw new Error('ASAAS_API_KEY nao configurada');

  const dueDate = new Date(Date.now() + 30 * 60 * 1000).toISOString().split('T')[0];
  const resp = await fetch(`${ASAAS_BASE}/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_KEY },
    body: JSON.stringify({
      billingType: 'PIX',
      customer: federationId,  // customer Asaas da federação (configurar antes)
      value: amount,
      dueDate,
      description: description || 'Anuidade Karate',
      externalReference: txid,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Asaas error: ' + JSON.stringify(data));

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

async function _asaasGetStatus({ payment_intent_id }) {
  const ASAAS_BASE = process.env.ASAAS_API_URL || 'https://api.asaas.com/v3';
  const ASAAS_KEY  = process.env.ASAAS_API_KEY;
  if (!ASAAS_KEY) throw new Error('ASAAS_API_KEY nao configurada');

  const resp = await fetch(`${ASAAS_BASE}/payments/${payment_intent_id}`, {
    headers: { 'access_token': ASAAS_KEY },
  });
  const data = await resp.json();
  const ASAAS_PAID = ['CONFIRMED', 'RECEIVED'];
  const status = ASAAS_PAID.includes(data.status) ? 'paid'
               : data.status === 'OVERDUE'         ? 'expired'
               : 'pending';
  return {
    status,
    paid_at: data.paymentDate || data.clientPaymentDate || null,
  };
}

// ── Public interface ───────────────────────────────────────

async function createPixCharge({ federationId, amount, txid, description }) {
  switch (ACTIVE_PROVIDER) {
    case 'asaas':
      return _asaasCreate({ federationId, amount, txid, description });
    case 'static_brcode':
    default:
      return _staticBrCodeCreate({ federationId, amount, txid, description });
  }
}

async function getStatus({ payment_intent_id }) {
  switch (ACTIVE_PROVIDER) {
    case 'asaas':
      return _asaasGetStatus({ payment_intent_id });
    case 'static_brcode':
    default:
      return _staticBrCodeGetStatus({ payment_intent_id });
  }
}

module.exports = { createPixCharge, getStatus, ACTIVE_PROVIDER };
