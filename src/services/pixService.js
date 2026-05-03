// ============================================================
// AURA. — Pix Service para Canal Digital
//
// Ordem de prioridade pra gerar cobranca Pix:
//   1. Pix MANUAL — chave Pix cadastrada em digital_channel_config (BR Code estatico)
//   2. Asaas subconta — fallback legado (gera cobranca via Asaas)
//   3. Mock — desenvolvimento/quando nada esta configurado
//
// Migration 088 adicionou pix_key/pix_key_type/pix_holder_name/pix_holder_city
// em digital_channel_config. Lojista cadastra a chave dele e a storefront
// gera o BR Code estatico apontando pra essa chave + valor + nome + cidade.
// Confirmacao deixa de ser via webhook Asaas e passa a ser manual pelo lojista
// (com comprovante anexado pelo cliente como nudge).
// ============================================================
'use strict';

const db = require('../config/database');
const { buildStaticBrCode, validatePixKey } = require('./staticPixService');

async function generatePix({ order, company_id, total }) {
  // 1. Pix MANUAL — chave do lojista cadastrada
  const { rows: configs } = await db.query(
    `SELECT pix_key, pix_key_type, pix_holder_name, pix_holder_city, site_name, address
     FROM digital_channel_config WHERE company_id = $1`,
    [company_id]
  );
  const cfg = configs[0];
  if (cfg && cfg.pix_key && String(cfg.pix_key).trim()) {
    try {
      return generateManualPix({ order, total, cfg });
    } catch (err) {
      console.warn('[PIX] Erro ao gerar Pix manual, usando fallback:', err.message);
    }
  }

  // 2. Asaas subconta (legado — empresas antigas que ainda usam)
  const { rows: companies } = await db.query(
    `SELECT asaas_subconta_id, asaas_subconta_token FROM companies WHERE id = $1`,
    [company_id]
  );
  const co = companies[0];
  if (co && co.asaas_subconta_id && co.asaas_subconta_token) {
    return generateAsaasPix({ order, company: co, total });
  }

  // 3. Mock — sem nada configurado
  return generateMockPix({ order, total });
}

function generateManualPix({ order, total, cfg }) {
  // Normaliza chave conforme tipo (remove acentos/mascaras quando aplicavel)
  const validation = validatePixKey(cfg.pix_key, cfg.pix_key_type);
  if (!validation.valid) {
    throw new Error('Chave Pix invalida: ' + validation.error);
  }
  const pixKey = validation.normalized;

  // Cidade: cai pro endereco da loja se pix_holder_city nao informado
  let city = cfg.pix_holder_city;
  if (!city && cfg.address) {
    // Tenta extrair cidade do address (formato livre — pega ultima virgula antes de UF)
    const parts = String(cfg.address).split(',').map(s => s.trim());
    city = parts[parts.length - 2] || parts[parts.length - 1] || '';
  }

  const payload = buildStaticBrCode({
    pixKey,
    amount: total,
    beneficiaryName: cfg.pix_holder_name || cfg.site_name || 'AURA NEGOCIO',
    beneficiaryCity: city || 'BRASIL',
    txid: order.order_number || order.id,
  });

  return {
    payment_id: 'manual-' + order.id,
    qrcode:     null,                  // frontend gera o QR a partir do payload
    payload:    payload,
    expires_at: null,                  // BR Code estatico nao expira
    mode:       'manual',
  };
}

async function generateAsaasPix({ order, company, total }) {
  const ASAAS_BASE = process.env.ASAAS_API_URL || 'https://api.asaas.com/v3';
  const dueDate    = new Date(Date.now() + 30 * 60 * 1000);
  const dueDateStr = dueDate.toISOString().split('T')[0];
  try {
    const payResp = await fetch(`${ASAAS_BASE}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'access_token': company.asaas_subconta_token },
      body: JSON.stringify({
        billingType:       'PIX',
        customer:          company.asaas_subconta_id,
        value:             total,
        dueDate:           dueDateStr,
        description:       `Pedido ${order.order_number}`,
        externalReference: `digital-order-${order.id}`,
      }),
    });
    const payData = await payResp.json();
    if (!payResp.ok) {
      console.warn('[PIX] Asaas payment error, usando mock:', JSON.stringify(payData));
      return generateMockPix({ order, total });
    }
    const qrResp = await fetch(`${ASAAS_BASE}/payments/${payData.id}/pixQrCode`, {
      headers: { 'access_token': company.asaas_subconta_token },
    });
    const qrData = await qrResp.json();
    return {
      payment_id: payData.id,
      qrcode:     qrData.encodedImage || null,
      payload:    qrData.payload      || null,
      expires_at: dueDate.toISOString(),
      mode:       'asaas',
    };
  } catch (err) {
    console.warn('[PIX] Asaas call falhou, usando mock:', err.message);
    return generateMockPix({ order, total });
  }
}

function generateMockPix({ order, total }) {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const ref       = (order.order_number || '').replace('-', '').slice(0, 10).padEnd(10, '0');
  const amt       = Number(total).toFixed(2);
  const payload   = [
    '000201',
    '26580014br.gov.bcb.pix',
    `0136mock-${order.id.slice(0, 22)}`,
    '520400005303986',
    `5406${amt}`,
    '5802BR',
    '5920AURA NEGOCIO DIGITAL',
    '6009SAO PAULO',
    `6214051006${ref}`,
    '6304MOCK',
  ].join('');
  return { payment_id: `mock-${order.id}`, qrcode: null, payload, expires_at: expiresAt.toISOString(), mode: 'mock' };
}

module.exports = { generatePix };
