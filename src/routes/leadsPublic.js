// ============================================================
// AURA. — Leads públicos do site (getaura.com.br)
// Recebe leads do formulário do site (via Cloudflare Worker) e
// grava em sales_leads (source='site', status='new') + 1
// lead_interaction com os extras (e-mail, empresa, cargo, msg).
// Aparece automaticamente no ProspecaoAdmin (CRM comercial).
//
// Auth: header x-site-token === env.SITE_LEADS_TOKEN (o Worker é o
// único chamador). Em produção, sem token configurado => 503
// (falha fechada, não deixa o endpoint aberto).
// ============================================================
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const { getOptionalEnv } = require('../config/env');

const VALID_PLANS = ['essencial', 'negocio', 'expansao'];
const SITE_LEADS_TOKEN = getOptionalEnv('SITE_LEADS_TOKEN', '');
const IS_PROD = (process.env.NODE_ENV === 'production');

// Defesa extra (as chamadas vêm do Worker; ainda assim limitamos).
const leadsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

function authSite(req, res, next) {
  if (!SITE_LEADS_TOKEN) {
    if (IS_PROD) {
      return res.status(503).json({ ok: false, error: 'lead intake nao configurado' });
    }
    return next(); // dev/test: permite sem token
  }
  if ((req.get('x-site-token') || '') !== SITE_LEADS_TOKEN) {
    return res.status(401).json({ ok: false, error: 'nao autorizado' });
  }
  next();
}

const s = (v) => (v == null ? '' : String(v)).trim();

// POST /api/v1/public/leads
router.post('/', leadsLimiter, authSite, asyncHandler(async (req, res) => {
  const b = req.body || {};

  // Honeypot — finge sucesso pra não revelar detecção
  if (s(b._empresa) || s(b.honeypot)) {
    return res.json({ ok: true });
  }

  const name = s(b.nome || b.name);
  const phone = s(b.whatsapp || b.telefone || b.phone);
  if (name.length < 2) throw new AppError('nome obrigatorio', 400);

  const email = s(b.email);
  const empresa = s(b.empresa);
  const cargo = s(b.cargo);
  const tipo = s(b.tipo);
  const mensagem = s(b.mensagem || b.message).slice(0, 2000);
  const city = s(b.city) || null;
  // "vertical de interesse" / tipo de negócio -> category
  const category = s(b.vertical || b.category || tipo) || null;

  let expected_plan = s(b.expected_plan).toLowerCase();
  if (!VALID_PLANS.includes(expected_plan)) expected_plan = null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO sales_leads (name, phone, city, category, source, status, expected_plan)
       VALUES ($1, $2, $3, $4, 'site', 'new', $5)
       RETURNING id`,
      [name, phone || null, city, category, expected_plan]
    );
    const leadId = rows[0].id;

    const parts = ['Lead recebido pelo site (getaura.com.br).'];
    if (email) parts.push(`E-mail: ${email}`);
    if (phone) parts.push(`WhatsApp: ${phone}`);
    if (empresa) parts.push(`Empresa: ${empresa}`);
    if (cargo) parts.push(`Cargo: ${cargo}`);
    if (tipo) parts.push(`Tipo de negocio: ${tipo}`);
    if (category) parts.push(`Vertical de interesse: ${category}`);
    if (mensagem) parts.push(`Mensagem: ${mensagem}`);

    await client.query(
      `INSERT INTO lead_interactions (lead_id, author_name, body, channel)
       VALUES ($1, 'Site', $2, $3)`,
      [leadId, parts.join('\n'), email ? 'email' : 'outro']
    );

    await client.query('COMMIT');
    res.status(201).json({ ok: true, id: leadId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
