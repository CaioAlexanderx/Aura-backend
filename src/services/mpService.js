'use strict';

const https = require('https');

/**
 * createMpPixPayment — Gera cobrança Pix via Mercado Pago
 * Retorna { payment_id, qrcode, payload, expires_at, mode: 'mp' } ou lança erro.
 */
async function createMpPixPayment({ accessToken, total, orderId, orderNumber, customerEmail, description }) {
  const body = JSON.stringify({
    transaction_amount: parseFloat(total.toFixed(2)),
    description:        description || `Pedido #${orderNumber}`,
    payment_method_id:  'pix',
    payer: {
      email: customerEmail || 'cliente@aura.app',
    },
    external_reference: orderId,
    // Pix expira em 24h
    date_of_expiration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mercadopago.com',
      path:     '/v1/payments',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'Authorization':     `Bearer ${accessToken}`,
        'X-Idempotency-Key': orderId,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('MP API parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (result.status !== 201) {
    throw new Error(`MP API error ${result.status}: ${JSON.stringify(result.body)}`);
  }

  const p      = result.body;
  const txData = p?.point_of_interaction?.transaction_data;
  if (!txData?.qr_code) {
    throw new Error('MP API: qr_code não retornado');
  }

  return {
    payment_id: String(p.id),
    qrcode:     txData.qr_code_base64 || null,  // base64 para imagem QR
    payload:    txData.qr_code,                  // string copia-e-cola
    expires_at: p.date_of_expiration  || null,
    mode:       'mp',
  };
}

/**
 * createMpPreference — Cria preferência CheckoutPro (cartão, boleto, etc.)
 * Retorna { preference_id, init_point, sandbox_init_point } ou lança erro.
 *
 * Fase 2 (21/05/2026): usado para pagamento com cartão via hosted checkout.
 * O lojista configurou max 3 parcelas sem juros para o consumidor no painel MP.
 */
async function createMpPreference({
  accessToken,
  orderId,
  orderNumber,
  orderItems,         // array de { product_id, product_name, unit_price, quantity }
  customerEmail,
  notificationUrl,
  backUrlSuccess,
  backUrlFailure,
  backUrlPending,
}) {
  const preference = {
    items: orderItems.map(i => ({
      id:          String(i.product_id),
      title:       String(i.product_name || ('Pedido #' + orderNumber)).slice(0, 256),
      quantity:    i.quantity,
      unit_price:  parseFloat(Number(i.unit_price).toFixed(2)),
      currency_id: 'BRL',
    })),
    payment_methods: {
      installments:         3,
      default_installments: 1,
    },
    external_reference: orderId,
    statement_descriptor: 'AURA',
    back_urls: {
      success: backUrlSuccess || '',
      failure: backUrlFailure || '',
      pending: backUrlPending || '',
    },
    auto_return: 'approved',
  };

  if (customerEmail) preference.payer = { email: customerEmail };
  if (notificationUrl) preference.notification_url = notificationUrl;

  const body = JSON.stringify(preference);

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mercadopago.com',
      path:     '/checkout/preferences',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'Authorization':     `Bearer ${accessToken}`,
        'X-Idempotency-Key': `pref-${orderId}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('MP Preference API parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (result.status !== 201) {
    throw new Error(`MP Preference API error ${result.status}: ${JSON.stringify(result.body)}`);
  }

  return {
    preference_id:      result.body.id,
    init_point:         result.body.init_point,
    sandbox_init_point: result.body.sandbox_init_point || null,
  };
}

/**
 * getMpPayment — Busca status de um pagamento no MP (usado pelo webhook para verificar)
 */
async function getMpPayment({ accessToken, paymentId }) {
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mercadopago.com',
      path:     `/v1/payments/${paymentId}`,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('MP API parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.end();
  });

  return result.body;
}

module.exports = { createMpPixPayment, createMpPreference, getMpPayment };
