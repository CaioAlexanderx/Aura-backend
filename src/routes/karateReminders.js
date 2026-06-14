// ============================================================
// AURA KARATÊ — Régua de anuidade: config + log + disparo (Track I)
// Montado sob /federation/:id. Guards de karateRoles.
//   GET  /reminder-config   (read)      — lê opt-in + offsets (default se vazio)
//   PUT  /reminder-config   (adminOnly) — liga/desliga + offsets
//   GET  /reminder-log      (read)      — histórico de envios
//   POST /reminders/run     (adminOnly) — dispara a régua desta federação agora
// Defensivo: tabelas 174/175 podem não existir ainda (42P01).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { runForFederation } = require('../services/karateReminderRunner');
const { DEFAULT_OFFSETS } = require('../services/karateReminderEngine');

const DEFAULT_CONFIG = { enabled: false, channel: 'email', offsets_days: DEFAULT_OFFSETS };

router.get('/reminder-config', ...guards.read(), async (req, res) => {
  const fed = req.params.id;
  try {
    const { rows } = await db.query(
      'SELECT enabled, channel, offsets_days, updated_at FROM karate_reminder_config WHERE federation_id = $1',
      [fed]
    );
    return res.json({ config: rows[0] || { ...DEFAULT_CONFIG } });
  } catch (e) {
    if (e.code === '42P01') return res.json({ config: { ...DEFAULT_CONFIG } });
    console.error('[karateReminders] get config:', e.message);
    return res.status(500).json({ error: 'Erro ao ler configuração' });
  }
});

router.put('/reminder-config', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  const body = req.body || {};
  const ch = body.channel === 'whatsapp' ? 'whatsapp' : 'email';
  const offs = (Array.isArray(body.offsets_days) && body.offsets_days.length)
    ? body.offsets_days.filter((n) => Number.isInteger(n)).slice(0, 12)
    : DEFAULT_OFFSETS;
  if (!offs.length) return res.status(400).json({ error: 'offsets_days inválido' });
  try {
    const { rows } = await db.query(
      `INSERT INTO karate_reminder_config (federation_id, enabled, channel, offsets_days, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (federation_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, channel = EXCLUDED.channel,
         offsets_days = EXCLUDED.offsets_days, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING enabled, channel, offsets_days, updated_at`,
      [fed, !!body.enabled, ch, offs, (req.user && req.user.id) || null]
    );
    return res.json({ config: rows[0] });
  } catch (e) {
    if (e.code === '42P01') return res.status(503).json({ error: 'Config da régua ainda não disponível (migração 175 pendente)' });
    console.error('[karateReminders] put config:', e.message);
    return res.status(500).json({ error: 'Erro ao salvar configuração' });
  }
});

router.get('/reminder-log', ...guards.read(), async (req, res) => {
  const fed = req.params.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const { rows } = await db.query(
      `SELECT id, annuity_id, dojo_id, channel, recipient, rule_code, status, provider_id, error, created_at
         FROM karate_reminder_log WHERE federation_id = $1
         ORDER BY created_at DESC LIMIT $2`,
      [fed, limit]
    );
    return res.json({ items: rows });
  } catch (e) {
    if (e.code === '42P01') return res.json({ items: [] });
    console.error('[karateReminders] get log:', e.message);
    return res.status(500).json({ error: 'Erro ao ler histórico' });
  }
});

// Disparo manual (admin): roda a régua só desta federação agora. Útil para
// testar e para "enviar agora". Funciona mesmo com enabled=false.
router.post('/reminders/run', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  let cfg = { federation_id: fed, channel: 'email', offsets_days: DEFAULT_OFFSETS };
  try {
    const { rows } = await db.query(
      'SELECT channel, offsets_days FROM karate_reminder_config WHERE federation_id = $1', [fed]
    );
    if (rows[0]) cfg = { federation_id: fed, channel: rows[0].channel, offsets_days: rows[0].offsets_days };
  } catch (e) {
    if (e.code !== '42P01') { console.error('[karateReminders] run cfg:', e.message); }
  }
  try {
    const result = await runForFederation(cfg, (req.body && req.body.today) || null);
    return res.json({ result });
  } catch (e) {
    console.error('[karateReminders] run:', e.message);
    return res.status(500).json({ error: 'Erro ao disparar régua' });
  }
});

module.exports = router;