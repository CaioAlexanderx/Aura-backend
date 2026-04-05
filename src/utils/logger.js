// ============================================================
// AURA. — BE-06: Structured Logger (Pino-compatible)
// Lightweight structured logging without external deps
// Replace console.log/error with logger.info/error
// ============================================================

const LOG_LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] || 30;
const IS_PROD = process.env.NODE_ENV === 'production';

function formatLog(level, msg, data = {}) {
  const entry = {
    level,
    time: new Date().toISOString(),
    msg,
    ...data,
  };

  // In production: JSON one-liner (parseable by log aggregators)
  if (IS_PROD) {
    return JSON.stringify(entry);
  }

  // In dev: human-readable with color
  const colors = { trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', fatal: '\x1b[35m' };
  const reset = '\x1b[0m';
  const color = colors[level] || '';
  const dataStr = Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
  return `${color}[${level.toUpperCase()}]${reset} ${entry.time.substring(11, 19)} ${msg}${dataStr}`;
}

function createLogger(context = {}) {
  const log = (level, msg, data = {}) => {
    if (LOG_LEVELS[level] < LEVEL) return;
    const merged = { ...context, ...data };
    // Mask PII
    if (merged.email) merged.email = merged.email.replace(/(.{2}).*(@.*)/, '$1***$2');
    if (merged.ip) merged.ip = merged.ip.replace(/(\d+\.\d+).*/, '$1.x.x');
    const line = formatLog(level, msg, merged);
    if (level === 'error' || level === 'fatal') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    trace: (msg, data) => log('trace', msg, data),
    debug: (msg, data) => log('debug', msg, data),
    info:  (msg, data) => log('info', msg, data),
    warn:  (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
    fatal: (msg, data) => log('fatal', msg, data),
    child: (childContext) => createLogger({ ...context, ...childContext }),
  };
}

const logger = createLogger({ service: 'aura-backend' });

// Express middleware for request logging
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode}`, {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration_ms: duration,
      ip: req.ip,
      user_id: req.user?.id,
    });
  });
  next();
}

module.exports = { logger, createLogger, requestLogger };
