// ============================================================
// AURA. — INF-03: Sentry Context Middleware
// Enriquece cada request com: userId, companyId, plan, role, route
// Aplicado como middleware global — captura o maximo possivel
// ============================================================
const { Sentry } = require('../config/sentry');

/**
 * sentryContext — middleware global
 * Injeta contexto do usuario autenticado no Sentry scope
 */
function sentryContext(req, res, next) {
  if (!Sentry || !Sentry.configureScope) return next();

  Sentry.configureScope(function(scope) {
    // Contexto de rota
    scope.setTag('http.method', req.method);
    scope.setTag('http.route',  (req.route && req.route.path) || req.path);
    scope.setTag('api.version', 'v1');

    // Contexto do usuario autenticado (disponivel apos requireAuth)
    if (req.user) {
      scope.setUser({
        id:    req.user.id,
        email: req.user.email,
        role:  req.user.role,
      });
      scope.setTag('user.role',  req.user.role);
      scope.setTag('user.plan',  req.user.plan);
      scope.setTag('company.id', req.user.company_id);
    }

    // Parametro de empresa da rota (ex: /companies/:id)
    var companyId = (req.params && req.params.id) || (req.user && req.user.company_id);
    if (companyId) scope.setTag('company.id', companyId);

    // Request ID para rastreamento
    var reqId = req.headers['x-request-id'] || req.headers['x-correlation-id'];
    if (reqId) scope.setTag('request.id', reqId);
  });

  next();
}

/**
 * sentryError — error handler para o final da chain do Express
 * Captura apenas 5xx com contexto completo do usuario
 */
function sentryError(err, req, res, next) {
  var status = err.status || err.statusCode || 500;
  if (status < 500) return next(err);

  if (Sentry && Sentry.withScope) {
    Sentry.withScope(function(scope) {
      if (req.user) {
        scope.setUser({ id: req.user.id, email: req.user.email });
        var cid = (req.params && req.params.id) || (req.user && req.user.company_id);
        if (cid) scope.setTag('company.id', cid);
        scope.setTag('user.plan', req.user.plan);
      }
      scope.setExtra('body',   JSON.stringify(req.body || {}).slice(0, 500));
      scope.setExtra('params', JSON.stringify(req.params || {}));
      scope.setExtra('query',  JSON.stringify(req.query || {}));
      Sentry.captureException(err);
    });
  }

  next(err);
}

module.exports = { sentryContext, sentryError };
