// ============================================================
// AURA. - Admin Vendedor IA Aura (SDR conversacional B2B)
// ============================================================
// Endpoints admin pra gerenciar o Vendedor IA Aura.
//
// Fase 0 entrega:
//   GET  /admin/agent/health    → status do modulo, killswitch, contadores
//   GET  /admin/agent/settings  → settings atuais (scope='aura')
//
// Fase 1 adiciona:
//   POST /admin/agent/killswitch     → toggle killswitch global
//   GET  /admin/agent/leads          → lista paginada
//   GET  /admin/agent/leads/:id      → detalhe + ultima conversa
//   GET  /admin/agent/conversations/:id/replay → replay turn-by-turn
//
// Doc: Aura/BACKLOG_VENDEDOR_IA_AURA.md
// ============================================================

const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const guardrails = require('../agent/core/guardrails');

// Middleware admin (TODO Fase 1: trocar pelo middleware admin canonico)
function requireAdmin(req, res, next) {
  // Stub Fase 0. Em Fase 1, amarra no middleware admin existente
  // (mesmo padrao das outras rotas /admin/*).
  next();
}

// GET /admin/agent/health
router.get('/agent/health', requireAdmin, async function(req, res) {
  try {
    const settings = await guardrails.getAuraSettings();

    let leadsTotal = 0;
    let activeConversations = 0;
    let lastActivity = null;
    let dailyOutboundSent = 0;

    // armadilha_schema_pre_migration: tabelas podem ainda nao existir
    try {
      const r1 = await pool.query('SELECT COUNT(*)::int AS n FROM agent_leads');
      leadsTotal = (r1.rows[0] && r1.rows[0].n) || 0;
    } catch (err) { if (err.code !== '42P01') throw err; }

    try {
      const r2 = await pool.query(
        `SELECT COUNT(*)::int AS n FROM agent_conversations WHERE closed_at IS NULL`
      );
      activeConversations = (r2.rows[0] && r2.rows[0].n) || 0;
    } catch (err) { if (err.code !== '42P01') throw err; }

    try {
      const r3 = await pool.query('SELECT MAX(created_at) AS last FROM agent_messages');
      lastActivity = (r3.rows[0] && r3.rows[0].last) || null;
    } catch (err) { if (err.code !== '42P01') throw err; }

    try {
      dailyOutboundSent = await guardrails.getDailyOutboundCount();
    } catch (err) { if (err.code !== '42P01') throw err; }

    res.json({
      module: 'agent',
      phase: 0,
      killswitch_active: settings ? settings.killswitch_global : null,
      settings_present: !!settings,
      stats: {
        leads_total: leadsTotal,
        active_conversations: activeConversations,
        last_activity: lastActivity,
        daily_outbound_sent: dailyOutboundSent,
        daily_outbound_cap: settings ? settings.daily_outbound_cap : null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[admin/agent/health]', err.message);
    res.status(500).json({ error: 'health check failed', detail: err.message });
  }
});

// GET /admin/agent/settings
router.get('/agent/settings', requireAdmin, async function(req, res) {
  try {
    const settings = await guardrails.getAuraSettings();
    if (!settings) {
      return res.status(404).json({
        error: 'agent_settings nao inicializado (migration 113 pendente?)',
      });
    }
    res.json(settings);
  } catch (err) {
    console.error('[admin/agent/settings]', err.message);
    res.status(500).json({ error: 'settings read failed' });
  }
});

module.exports = router;
