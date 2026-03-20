const crypto = require('crypto');

function generatePaymentToken(linkId, secret, days = 7) {
  if (!linkId || !secret) throw new Error('linkId e secret são obrigatórios');
  if (days <= 0) throw new Error('days deve ser maior que zero');

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);

  const payload = Buffer.from(
    JSON.stringify({ linkId, exp: expiresAt.getTime() })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  return { token: `${payload}.${signature}`, expiresAt };
}

function validatePaymentToken(token, secret) {
  if (!token || !secret) return { valid: false, error: 'Token ou secret ausente' };
  try {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return { valid: false, error: 'Formato inválido' };

    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('base64url');

    if (signature !== expectedSig) return { valid: false, error: 'Assinatura inválida' };

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const now = Date.now();
    const secondsRemaining = Math.floor((decoded.exp - now) / 1000);

    if (secondsRemaining <= 0) {
      return { valid: false, expired: true, linkId: decoded.linkId, secondsRemaining: 0 };
    }

    return { valid: true, linkId: decoded.linkId, secondsRemaining, expired: false };
  } catch {
    return { valid: false, error: 'Token malformado' };
  }
}

function validateWebhookSignature(payload, signature, secret) {
  if (!payload || !signature || !secret) return false;
  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);

    // timingSafeEqual exige buffers do mesmo tamanho
    if (sigBuf.length !== expBuf.length) return false;

    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

function calculatePaymentFee(amount, method = 'pix') {
  const fees = {
    pix:    { rate: 0.0099, fixed: 0    },
    boleto: { rate: 0,      fixed: 1.99 },
    debito: { rate: 0.0189, fixed: 0    },
  };
  const fee_config = fees[method] || fees.pix;
  const fee = parseFloat((amount * fee_config.rate + fee_config.fixed).toFixed(2));
  const net = parseFloat((amount - fee).toFixed(2));
  return { gross: amount, fee, net };
}

module.exports = {
  generatePaymentToken, validatePaymentToken,
  validateWebhookSignature, calculatePaymentFee,
};
