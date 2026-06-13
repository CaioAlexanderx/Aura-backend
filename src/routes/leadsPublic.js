// ============================================================
// AURA. — Leads públicos do site (getaura.com.br)
// Recebe leads do formulário do site (via Cloudflare Worker) e
// grava em sales_leads (status='new') + 1 lead_interaction com os
// extras (e-mail, empresa, cargo, msg). Aparece no ProspecaoAdmin.
//
// Dois tipos:
//  • COMPLETO  (source='site')         — pessoa enviou o formulário.
//  • PARCIAL   (source='site_partial') — pessoa só deixou contato
//    (passo 1 / exit-intent) e ainda NÃO enviou o form completo.
//
// Dedup/upgrade por telefone (chave do CRM, phone-centric):
//  • parcial repetido p/ mesmo telefone → não duplica.
//  • submit COMPLETO com telefone de um parcial → PROMOVE o parcial
//    a 'site' e registra a interação (1 pessoa = 1 lead que amadurece).
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
  max: 120,
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
const onlyDigits = (v) => s(v).replace(/\D/g, '');

// POST /api/v1/public/leads
router.post('/', leadsLimiter, authSite, asyncHandler(async (req, res) => {
  const b = req.body || {};

  // Honeypot — finge sucesso pra não revelar detecção
  if (s(b._empresa) || s(b.honeypot)) {
    return res.json({ ok: true });
  }

  const partial = (b.partial === true || s(b.partial) === 'true');
  const source = partial ? 'site_partial' : 'site';

  const nameIn = s(b.nome || b.name);
  const phone = s(b.whatsapp || b.telefone || b.phone);
  const phoneDigits = onlyDigits(phone);
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

  // Validação: parcial exige telefone OU e-mail; completo exige nome.
  if (partial) {
    if (!phoneDigits && !email) throw new AppError('telefone ou e-mail obrigatorio', 400);
  } else {
    if (nameIn.length < 2) throw new AppError('nome obrigatorio', 400);
  }
  // name é NOT NULL: parcial sem nome usa e-mail/telefone como rótulo.
  const name = nameIn || email || phone || 'Lead do site';

  const interactionBody = (header) => {
    const parts = [header];
    if (email) parts.push(`E-mail: ${email}`);
    if (phone) parts.push(`WhatsApp: ${phone}`);
    if (empresa) parts.push(`Empresa: ${empresa}`);
    if (cargo) parts.push(`Cargo: ${cargo}`);
    if (tipo) parts.push(`Tipo de negocio: ${tipo}`);
    if (category) parts.push(`Vertical de interesse: ${category}`);
    if (mensagem) parts.push(`Mensagem: ${mensagem}`);
    return parts.join('\n');
  };
  const channel = email ? 'email' : 'outro';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Dedup/upgrade: casa por telefone com um lead 'new' do site (trava a linha).
    let existing = null;
    if (phoneDigits.length >= 8) {
      const { rows } = await client.query(
        `SELECT id, source
           FROM sales_leads
          WHERE status = 'new'
            AND source IN ('site', 'site_partial')
            AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [phoneDigits]
      );
      existing = rows[0] || null;
    }

    let leadId;
    let upgraded = false;
    let deduped = false;

    if (existing) {
      leadId = existing.id;
      if (!partial) {
        // Submit completo: promove o parcial (ou registra 2º contato no lead cheio).
        upgraded = (existing.source === 'site_partial');
        await client.query(
          `UPDATE sales_leads
              SET source = 'site',
                  name = $2,
                  city = COALESCE($3, city),
                  category = COALESCE($4, category),
                  expected_plan = COALESCE($5, expected_plan),
                  updated_at = NOW()
            WHERE id = $1`,
          [leadId, name, city, category, expected_plan]
        );
        await client.query(
          `INSERT INTO lead_interactions (lead_id, author_name, body, channel)
           VALUES ($1, 'Site', $2, $3)`,
          [leadId, interactionBody('Lead completou o formulario no site (getaura.com.br).'), channel]
        );
      } else {
        // Parcial repetido pro mesmo telefone: não duplica nem polui com interação.
        deduped = true;
      }
    } else {
      const { rows } = await client.query(
        `INSERT INTO sales_leads (name, phone, city, category, source, status, expected_plan)
         VALUES ($1, $2, $3, $4, $5, 'new', $6)
         RETURNING id`,
        [name, phone || null, city, category, source, expected_plan]
      );
      leadId = rows[0].id;

      const header = partial
        ? 'LEAD PARCIAL — deixou o contato no site mas ainda NAO enviou o formulario completo.'
        : 'Lead recebido pelo site (getaura.com.br).';
      await client.query(
        `INSERT INTO lead_interactions (lead_id, author_name, body, channel)
         VALUES ($1, 'Site', $2, $3)`,
        [leadId, interactionBody(header), channel]
      );
    }

    await client.query('COMMIT');
    res.status(existing ? 200 : 201).json({ ok: true, id: leadId, partial, upgraded, deduped });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
