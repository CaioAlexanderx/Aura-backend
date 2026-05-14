// ============================================================
// AURA. - Vendedor IA - Guardrails
// ============================================================
// Verificacoes que rodam ANTES de qualquer chamada ao LLM ou
// disparo de mensagem. Fonte unica: tabela agent_settings (scope='aura').
//
// Hard rules (codigo, nao prompt):
//   - killswitch global       → bloqueia tudo
//   - horario comercial       → bloqueia outbound; inbound responde com snooze
//   - opt-out do lead         → bloqueia qualquer mensagem futura
//   - cap diario de outbound  → bloqueia novos disparos no dia
//   - cap por lead            → bloqueia se ja atingiu limite sem opt-in
//
// Armadilha 42P01 (armadilha_schema_pre_migration): durante deploy parcial
// da migration 113, tabelas podem nao existir. Em todos os helpers,
// tratar 42P01 retornando estado seguro (bloqueia outbound, mas nao quebra app).
//
// Doc: Aura/BACKLOG_VENDEDOR_IA_AURA.md secao 2.5
// ============================================================

const pool = require('../../config/database');

let cachedSettings = null;
let cachedAt = 0;
const CACHE_MS = 30000; // 30s

async function getAuraSettings() {
  const now = Date.now();
  if (cachedSettings && (now - cachedAt) < CACHE_MS) {
    return cachedSettings;
  }
  try {
    const result = await pool.query(
      "SELECT * FROM agent_settings WHERE scope = 'aura' LIMIT 1"
    );
    cachedSettings = result.rows[0] || null;
    cachedAt = now;
    return cachedSettings;
  } catch (err) {
    if (err.code === '42P01') {
      // armadilha_schema_pre_migration: migration 113 ainda nao aplicada
      console.warn('[agent/guardrails] agent_settings nao migrada (42P01) — retornando null');
      return null;
    }
    throw err;
  }
}

function invalidateCache() {
  cachedSettings = null;
  cachedAt = 0;
}

async function isKillswitchActive() {
  const s = await getAuraSettings();
  if (!s) return true; // sem settings disponivel = bloqueia por seguranca
  return s.killswitch_global === true;
}

async function isWithinBusinessHours(now) {
  const s = await getAuraSettings();
  if (!s) return false;
  const ref = now || new Date();
  const hhmm = ref.toTimeString().slice(0, 5); // 'HH:MM'
  const start = String(s.business_hours_start).slice(0, 5);
  const end   = String(s.business_hours_end).slice(0, 5);
  return hhmm >= start && hhmm <= end;
}

async function isLeadOptedOut(leadId) {
  if (!leadId) return false;
  try {
    const result = await pool.query(
      'SELECT opted_out_at FROM agent_leads WHERE id = $1',
      [leadId]
    );
    return !!(result.rows[0] && result.rows[0].opted_out_at);
  } catch (err) {
    if (err.code === '42P01') return false; // tabela ainda nao existe
    throw err;
  }
}

async function getDailyOutboundCount() {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM agent_outbound_queue
        WHERE status = 'sent'
          AND sent_at >= NOW() - INTERVAL '24 hours'`
    );
    return (result.rows[0] && result.rows[0].n) || 0;
  } catch (err) {
    if (err.code === '42P01') return 0;
    throw err;
  }
}

async function isDailyCapReached() {
  const s = await getAuraSettings();
  if (!s) return true;
  const sent = await getDailyOutboundCount();
  return sent >= s.daily_outbound_cap;
}

module.exports = {
  getAuraSettings,
  invalidateCache,
  isKillswitchActive,
  isWithinBusinessHours,
  isLeadOptedOut,
  getDailyOutboundCount,
  isDailyCapReached,
};
