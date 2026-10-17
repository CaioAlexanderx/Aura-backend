// ============================================================
// AURA. — SEC-05: Audit Log Middleware
// Logs sensitive actions to audit_log table
// Usage: router.post('/endpoint', auditLog('action_name'), handler)
// ============================================================
const net = require('net');
const db = require('../config/database');

/**
 * IP e user agent da requisicao, prontos para as colunas ip_address (INET) e
 * user_agent (VARCHAR 200) do audit_log. req.ip ja respeita o `trust proxy`
 * do app (app.js). Valor que nao e IP vira null: um INET invalido derrubaria
 * o INSERT inteiro e a linha de auditoria se perderia.
 */
function contextoDaRequisicao(req) {
  let ip = req && req.ip ? String(req.ip).trim() : '';
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  const ua = req && req.headers && req.headers['user-agent'];
  return {
    ip: net.isIP(ip) ? ip : null,
    userAgent: ua ? String(ua).substring(0, 200) : null,
  };
}

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
 *
 * `contexto` ({ ip, userAgent }, de contextoDaRequisicao) e opcional: sem ele o
 * INSERT e o de sempre (5 colunas); com ele grava tambem ip_address e user_agent.
 */
async function logAuditAction(userId, companyId, action, detail, metadata = {}, contexto = null) {
  try {
    if (contexto && (contexto.ip || contexto.userAgent)) {
      await db.query(
        `INSERT INTO audit_log (user_id, company_id, action, detail, metadata, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, companyId, action, String(detail).substring(0, 500), JSON.stringify(metadata),
          contexto.ip || null, contexto.userAgent || null]
      );
      return;
    }
    await db.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, companyId, action, String(detail).substring(0, 500), JSON.stringify(metadata)]
    );
  } catch (_) {}
}

module.exports = { auditLog, logAuditAction, contextoDaRequisicao };
