// ============================================================
// AURA. — SEC-05: Audit Log Middleware
// Logs sensitive actions to audit_log table
// Usage: router.post('/endpoint', auditLog('action_name'), handler)
// ============================================================
const db = require('../config/database');

/**
 * Creates audit log middleware for a specific action.
 * Logs after the response is sent (non-blocking).
 *
 * @param {string} action - Action name (e.g., 'create_transaction', 'delete_product')
 * @param {object} opts - Options
 * @param {function} opts.detail - Function (req, res) => string for detail field
 * @param {function} opts.metadata - Function (req, res) => object for extra metadata
 */
function auditLog(action, opts = {}) {
  return (req, res, next) => {
    // Capture original json method to log after response
    const originalJson = res.json.bind(res);
    res.json = function(body) {
      // Log asynchronously after response
      setImmediate(async () => {
        try {
          const userId = req.user?.id || null;
          const companyId = req.params?.id || req.user?.company || null;
          const detail = opts.detail
            ? opts.detail(req, body)
            : `${req.method} ${req.originalUrl}`;
          const metadata = opts.metadata
            ? opts.metadata(req, body)
            : {};

          await db.query(
            `INSERT INTO audit_log (user_id, company_id, action, detail, metadata, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              userId,
              companyId,
              action,
              String(detail).substring(0, 500),
              JSON.stringify({
                method: req.method,
                path: req.originalUrl,
                status: res.statusCode,
                body_keys: req.body ? Object.keys(req.body) : [],
                ...metadata,
              }),
              req.ip || req.headers['x-forwarded-for'] || null,
              (req.headers['user-agent'] || '').substring(0, 200),
            ]
          ).catch(err => {
            // Silently fail — audit should never break the app
            if (!err.message?.includes('does not exist')) {
              console.error('[audit]', err.message);
            }
          });
        } catch (_) {}
      });
      return originalJson(body);
    };
    next();
  };
}

/**
 * Standalone function to log an action directly (not as middleware).
 */
async function logAuditAction(userId, companyId, action, detail, metadata = {}) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, companyId, action, String(detail).substring(0, 500), JSON.stringify(metadata)]
    );
  } catch (_) {}
}

module.exports = { auditLog, logAuditAction };
