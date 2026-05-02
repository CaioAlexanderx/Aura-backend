// ============================================================
// AURA. — Pix Service para Canal Digital
// Gera cobrança Pix via Asaas (subconta) ou mock local
// ============================================================
'use strict';

const db = require('../config/database');

async function generatePix({ order, company_id, total }) {
  const { rows } = await db.query(
    `SELECT asaas_subconta_id, asaas_subconta_token FROM companies WHERE id = $1`, [company_id]);
  const co = rows[0];
  if (co && co.asaas_subconta_id && co.asaas_subconta_token) {
    return generateAsaasPix({ order, company: co, total });
  }
  return generateMockPix({ order, total });
}

async function generateAsaasPix({ order, company, total }) {
  const ASAAS_BASE = process.env.ASAAS_API_URL || 'https://api.asaas.com/api/v3';
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
    };
  } catch (err) {
    console.warn('[PIX] Asaas call falhou, usando mock:', err.message);
    return generateMockPix({ order, total });
  }
}

function generateMockPix({ order, total }) {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const ref       = order.order_number.replace('-', '').slice(0, 10).padEnd(10, '0');
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
  return { payment_id: `mock-${order.id}`, qrcode: null, payload, expires_at: expiresAt.toISOString() };
}

module.exports = { generatePix };
