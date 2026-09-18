// ============================================================
// AURA — CRM Fase 1: rotas de CONSENTIMENTO de marketing (340)
//
// companyRouter — montado em /companies/:id (private.js, que já aplica
// requireAuth + requireCompanyAccess e carimba req.companyRole):
//   GET  /customers/:cid/consent        — status atual + últimos 20 eventos
//   POST /customers/:cid/consent        — grava opt-in/opt-out
//   GET  /whatsapp/consent/settings     — data de corte do opt-in
//   PUT  /whatsapp/consent/settings     — altera a data de corte (dono/admin)
//   GET  /whatsapp/consent/summary      — contagem por status + texto padrão
//
// meRouter — montado em /me (index.js), visão consolidada multi-CNPJ:
//   GET  /whatsapp/consent/summary      — soma das empresas + breakdown
//
// Sem requirePlan de propósito: registrar o consentimento no balcão ou no
// cadastro é obrigação de LGPD de qualquer plano (e GET nunca é gateado
// por plano — armadilha 3). Quem envia marketing continua no Negócio+.
// ============================================================
'use strict';

const express = require('express');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const consent = require('../services/customerConsent');

const companyRouter = express.Router({ mergeParams: true });
const meRouter = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function schemaPending(res) {
  return res.status(503).json({
    error: 'O consentimento por cliente ainda não está disponível neste ambiente (migração 340 pendente).',
    code: 'SCHEMA_PENDING',
  });
}

function badRequest(res, error) {
  return res.status(400).json({ error, code: 'VALIDATION_ERROR' });
}

// ── GET /customers/:cid/consent ─────────────────────────────
companyRouter.get('/customers/:cid/consent', async (req, res) => {
  const { id: companyId, cid } = req.params;
  if (!UUID_RE.test(String(cid))) return res.status(404).json({ error: 'Cliente não encontrado' });
  try {
    const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');
    const ids = await getOwnerScopedCompanyIds(companyId);
    const { rows } = await db.query(
      `-- consent:route-customer
       SELECT id, name, phone FROM customers WHERE id = $1 AND company_id = ANY($2) LIMIT 1`,
      [cid, ids]
    );
    const customer = rows[0];
    if (!customer) return res.status(404).json({ error: 'Cliente não encontrado' });

    const status = await consent.getConsentStatus({ companyId, customerId: cid, phone: customer.phone });
    const events = await consent.listEvents({ companyId, customerId: cid, phone: customer.phone, limit: 20 });
    return res.json({
      customer_id: cid,
      company_id: companyId,
      status: status.status,
      since: status.since,
      channel: status.channel,
      events,
    });
  } catch (e) {
    console.error('[consent] get:', e.message);
    return res.status(500).json({ error: 'Erro ao carregar o consentimento do cliente' });
  }
});

// ── POST /customers/:cid/consent ────────────────────────────
// body { action: 'opt_in'|'opt_out', channel, text? }
companyRouter.post('/customers/:cid/consent', async (req, res) => {
  const { id: companyId, cid } = req.params;
  const b = req.body || {};
  if (!UUID_RE.test(String(cid))) return res.status(404).json({ error: 'Cliente não encontrado' });
  if (!consent.ACTIONS.includes(b.action)) {
    return badRequest(res, `action deve ser ${consent.ACTIONS.join(' | ')}`);
  }
  if (!consent.CHANNELS.includes(b.channel)) {
    return badRequest(res, `channel deve ser ${consent.CHANNELS.join(' | ')}`);
  }
  if (b.text != null && typeof b.text !== 'string') {
    return badRequest(res, 'text deve ser texto');
  }
  if (typeof b.text === 'string' && b.text.length > 2000) {
    return badRequest(res, 'text deve ter no máximo 2000 caracteres');
  }
  try {
    let text = typeof b.text === 'string' && b.text.trim() ? b.text.trim() : null;
    // Opt-in sem texto: grava o texto padrão que a tela mostra — a prova
    // do consentimento é o texto que o cliente aceitou.
    if (!text && b.action === 'opt_in') {
      text = consent.defaultOptinText(await consent.loadStoreName(companyId));
    }
    const r = await consent.recordConsent({
      companyId, customerId: cid,
      action: b.action, channel: b.channel, text,
      userId: req.user && req.user.id,
    });
    if (!r.ok) return schemaPending(res);
    const status = await consent.getConsentStatus({ companyId, customerId: cid, phone: r.phone });
    return res.status(201).json({
      ok: true,
      customer_id: cid,
      company_id: companyId,
      status: status.status,
      since: status.since,
      channel: status.channel,
      propagated_company_ids: r.company_ids,
      event: r.events[0] || null,
    });
  } catch (e) {
    if (e.code === 'VALIDATION_ERROR') return badRequest(res, e.message);
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'Cliente não encontrado' });
    console.error('[consent] post:', e.message);
    return res.status(500).json({ error: 'Erro ao registrar o consentimento' });
  }
});

// ── settings ────────────────────────────────────────────────
async function settingsPayload(companyId) {
  const cutoff = await consent.loadOptinRequiredFrom(companyId);
  let declaredAt = null;
  try {
    declaredAt = await require('../services/waOutbox').loadMarketingConsentAt(companyId);
  } catch (_) { declaredAt = null; }
  return {
    optin_required_from: cutoff,
    optin_required_active: consent.cutoffActive(cutoff),
    wa_marketing_consent_at: declaredAt,
    today: consent.todayBRT(),
    texto_optin_padrao: consent.defaultOptinText(await consent.loadStoreName(companyId)),
    schema_pending: consent.isSchemaPending(),
  };
}

companyRouter.get('/whatsapp/consent/settings', async (req, res) => {
  try {
    return res.json(await settingsPayload(req.params.id));
  } catch (e) {
    console.error('[consent] settings get:', e.message);
    return res.status(500).json({ error: 'Erro ao carregar a configuração de consentimento' });
  }
});

// body { optin_required_from: 'YYYY-MM-DD' (futura) | null }
companyRouter.put('/whatsapp/consent/settings', async (req, res) => {
  if (req.companyRole !== 'owner' && req.companyRole !== 'admin') {
    return res.status(403).json({
      error: 'Apenas o dono ou um admin pode mudar a data de corte do opt-in',
      your_role: req.companyRole || null,
    });
  }
  const b = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(b, 'optin_required_from')) {
    return badRequest(res, 'optin_required_from é obrigatório (data futura AAAA-MM-DD ou null)');
  }
  const v = b.optin_required_from;
  if (v !== null) {
    if (typeof v !== 'string' || !consent.isIsoDate(v)) {
      return badRequest(res, 'optin_required_from deve ser uma data AAAA-MM-DD ou null');
    }
    // Data FUTURA: a loja precisa de tempo para coletar os opt-ins antes
    // de o marketing parar para quem ainda não respondeu.
    if (v <= consent.todayBRT()) {
      return badRequest(res, 'optin_required_from deve ser uma data futura');
    }
  }
  try {
    const ok = await consent.setOptinRequiredFrom(req.params.id, v);
    if (!ok) return schemaPending(res);
    return res.json({ ok: true, ...(await settingsPayload(req.params.id)) });
  } catch (e) {
    console.error('[consent] settings put:', e.message);
    return res.status(500).json({ error: 'Erro ao salvar a configuração de consentimento' });
  }
});

// ── summary ─────────────────────────────────────────────────
companyRouter.get('/whatsapp/consent/summary', async (req, res) => {
  try {
    return res.json(await consent.getSummary(req.params.id));
  } catch (e) {
    console.error('[consent] summary:', e.message);
    return res.status(500).json({ error: 'Erro ao montar o resumo de consentimento' });
  }
});

// Mesma regra de acesso do /me/* (meAggregates): dono OU membro ativo.
async function getUserCompanies(userId) {
  const { rows } = await db.query(
    `-- consent:me-companies
     SELECT DISTINCT ON (c.id)
            c.id, c.legal_name, c.trade_name, c.is_primary, c.created_at
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id
        AND cm.user_id = $1
        AND cm.status = 'active'
        AND cm.is_active = true
      WHERE (c.owner_id = $1 OR cm.user_id = $1)
        AND c.is_active = true
      ORDER BY c.id, c.is_primary DESC NULLS LAST, c.created_at ASC`,
    [userId]
  );
  rows.sort((a, b) => {
    if (a.is_primary && !b.is_primary) return -1;
    if (!a.is_primary && b.is_primary) return 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  return rows;
}

meRouter.get('/whatsapp/consent/summary', requireAuth, async (req, res) => {
  try {
    const companies = await getUserCompanies(req.user.id);
    const breakdown = [];
    for (const c of companies) {
      const s = await consent.getSummary(c.id);
      breakdown.push({ ...s, company_name: c.trade_name || c.legal_name || 'Empresa' });
    }
    const tot = breakdown.reduce((acc, s) => ({
      total: acc.total + s.total_clientes_com_telefone,
      optIn: acc.optIn + s.opt_in,
      optOut: acc.optOut + s.opt_out,
    }), { total: 0, optIn: 0, optOut: 0 });
    return res.json({
      ...consent.shapeSummary(tot.total, tot.optIn, tot.optOut),
      company_count: companies.length,
      schema_pending: breakdown.some((s) => s.schema_pending),
      breakdown,
    });
  } catch (e) {
    console.error('[consent] me summary:', e.message);
    return res.status(500).json({ error: 'Erro ao montar o resumo consolidado de consentimento' });
  }
});

module.exports = { companyRouter, meRouter };
