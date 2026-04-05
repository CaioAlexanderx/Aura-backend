// ============================================================
// AURA. — BE-07: Webhook HMAC-SHA256 Validation Helper
// Validates webhook signatures from Asaas, NFE.io, etc.
// ============================================================

const crypto = require('crypto');

/**
 * Validate a webhook signature using HMAC-SHA256
 * @param {string} payload - Raw request body (string)
 * @param {string} signature - Signature from webhook header
 * @param {string} secret - Webhook secret key
 * @param {string} [prefix] - Optional prefix to strip (e.g., 'sha256=')
 * @returns {boolean} Whether the signature is valid
 */
function validateWebhookSignature(payload, signature, secret, prefix = '') {
  if (!payload || !signature || !secret) return false;

  const cleanSignature = prefix ? signature.replace(prefix, '') : signature;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(cleanSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Express middleware for webhook signature validation
 * @param {Object} options
 * @param {string} options.headerName - Name of the signature header (e.g., 'x-hub-signature-256')
 * @param {string|Function} options.secret - Secret string or function(req) that returns secret
 * @param {string} [options.prefix] - Prefix to strip from signature (e.g., 'sha256=')
 */
function webhookValidator({ headerName, secret, prefix = '' }) {
  return async (req, res, next) => {
    const signature = req.headers[headerName.toLowerCase()];
    if (!signature) {
      return res.status(401).json({ error: 'Missing webhook signature header' });
    }

    // Get secret (can be async function for per-company secrets)
    const secretValue = typeof secret === 'function' ? await secret(req) : secret;
    if (!secretValue) {
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // Need raw body for signature validation
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    if (!validateWebhookSignature(rawBody, signature, secretValue, prefix)) {
      return res.status(403).json({ error: 'Invalid webhook signature' });
    }

    next();
  };
}

/**
 * Generate a webhook secret for a company
 * @returns {string} 64-char hex secret
 */
function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  validateWebhookSignature,
  webhookValidator,
  generateWebhookSecret,
};
