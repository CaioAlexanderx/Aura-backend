// ============================================================
// AURA KARATÊ — Régua de anuidade: config + log + disparo (Track I / F4)
// Montado sob /federation/:id. Guards de karateRoles.
//   GET  /reminder-config   (read)      — lê opt-in + offsets + template (default se vazio)
//   PUT  /reminder-config   (adminOnly) — liga/desliga + offsets + template (Fase F4)
//   GET  /reminder-log      (read)      — histórico de envios
//   POST /reminders/run     (adminOnly) — dispara a régua desta federação agora
// Defensivo: tabelas 174/175 podem não existir ainda (42P01); colunas
// subject_template/body_template da migration 223 podem não existir ainda
// (42703) — cai pro comportamento sem template (default hardcoded).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { runForFederation } = require('../services/karateReminderRunner');
const { DEFAULT_OFFSETS } = require('../services/karateReminderEngine');
const tpl = require('../services/karateReminderTemplate');

const DEFAULT_CONFIG = { enabled: false, channel: 'email', offsets_days: DEFAULT_OFFSETS, subject_template: null, body_template: null };

router.get('/reminder-config', ...guards.read(), async (req, res) => {
  const fed = req.params.id;
  try {
    const { rows } = await db.query(
      'SELECT enabled, channel, offsets_days, subject_template, body_template, updated_at FROM karate_reminder_config WHERE federation_id = $1',
      [fed]
    );
    return res.json({ config: rows[0] || { ...DEFAULT_CONFIG } });
  } catch (e) {
    if (e.code === '42703') {
      // Migração 223 (subject_template/body_template) ainda não aplicada.
      try {
        const { rows } = await db.query(
          'SELECT enabled, channel, offsets_days, updated_at FROM karate_reminder_config WHERE federation_id = $1',
          [fed]
        );
        const cfg = rows[0] ? { ...rows[0], subject_template: null, body_template: null } : { ...DEFAULT_CONFIG };
        return res.json({ config: cfg });
      } catch (e2) {
        if (e2.code === '42P01') return res.json({ config: { ...DEFAULT_CONFIG } });
        console.error('[karateReminders] get config (fallback 42703):', e2.message);
        return res.status(500).json({ error: 'Erro ao ler configuração' });
      }
    }
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

  // ── Fase F4: subject_template/body_template — texto livre com
  // {{nome}} {{competencia}} {{valor}} {{vencimento}} {{planos}}
  // {{pix_copia_cola}}. String vazia/ausente = volta pro default (NULL).
  // Variável desconhecida → 422 ANTES de tocar o banco.
  const rawSubject = body.subject_template;
  const rawBody = body.body_template;
  const subjectTemplate = (rawSubject === undefined || rawSubject === null || String(rawSubject).trim() === '')
    ? null : String(rawSubject);
  const bodyTemplate = (rawBody === undefined || rawBody === null || String(rawBody).trim() === '')
    ? null : String(rawBody);

  const fields = [['subject_template', subjectTemplate], ['body_template', bodyTemplate]];
  for (const [label, text] of fields) {
    if (text === null) continue;
    const unknown = tpl.findUnknownVars(text);
    if (unknown.length) {
      return res.status(422).json({
        error: `Variável desconhecida em ${label}: ${unknown.map((v) => `{{${v}}}`).join(', ')}. `
          + `Variáveis aceitas: ${tpl.KNOWN_VARS.map((v) => `{{${v}}}`).join(', ')}.`,
        code: 'VALIDATION_ERROR',
      });
    }
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO karate_reminder_config
         (federation_id, enabled, channel, offsets_days, subject_template, body_template, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (federation_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, channel = EXCLUDED.channel,
         offsets_days = EXCLUDED.offsets_days, subject_template = EXCLUDED.subject_template,
         body_template = EXCLUDED.body_template, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING enabled, channel, offsets_days, subject_template, body_template, updated_at`,
      [fed, !!body.enabled, ch, offs, subjectTemplate, bodyTemplate, (req.user && req.user.id) || null]
    );
    return res.json({ config: rows[0] });
  } catch (e) {
    if (e.code === '42703') {
      // Migração 223 ainda não aplicada — salva o resto da config sem
      // quebrar (defensivo, armadilha #1 do CLAUDE.md).
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
        return res.json({
          config: { ...rows[0], subject_template: null, body_template: null },
          _warn: 'Template de e-mail ainda não disponível nesta federação (migração 223 pendente)',
        });
      } catch (e2) {
        console.error('[karateReminders] put config (fallback 42703):', e2.message);
        return res.status(500).json({ error: 'Erro ao salvar configuração' });
      }
    }
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
      'SELECT channel, offsets_days, subject_template, body_template FROM karate_reminder_config WHERE federation_id = $1', [fed]
    );
    if (rows[0]) {
      cfg = {
        federation_id: fed, channel: rows[0].channel, offsets_days: rows[0].offsets_days,
        subject_template: rows[0].subject_template, body_template: rows[0].body_template,
      };
    }
  } catch (e) {
    if (e.code === '42703') {
      try {
        const { rows } = await db.query(
          'SELECT channel, offsets_days FROM karate_reminder_config WHERE federation_id = $1', [fed]
        );
        if (rows[0]) cfg = { federation_id: fed, channel: rows[0].channel, offsets_days: rows[0].offsets_days };
      } catch (e2) {
        if (e2.code !== '42P01') console.error('[karateReminders] run cfg (fallback 42703):', e2.message);
      }
    } else if (e.code !== '42P01') {
      console.error('[karateReminders] run cfg:', e.message);
    }
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
