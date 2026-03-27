const jwt = require('jsonwebtoken');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permissão insuficiente' });
    }
    next();
  };
}

function requirePlan(...plans) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    if (!plans.includes(req.user.plan)) {
      return res.status(403).json({
        error: 'Plano atual não inclui esta funcionalidade',
        required_plans: plans,
        current_plan: req.user.plan,
      });
    }
    next();
  };
}

function requireFeature(feature) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    const features = req.user.features || [];
    if (!features.includes(feature)) {
      return res.status(403).json({
        error: 'Funcionalidade não disponível no plano atual',
        required_feature: feature,
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, requirePlan, requireFeature };
