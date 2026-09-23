// ============================================================
// AURA — Matcon M1 (352): orcamento vencido vira "expired"
//
// DIARIO, 00h05 BRT: todo orcamento `open` com valid_until ANTES de hoje
// (dia de Sao Paulo) passa a `expired`. Um UPDATE so, pra todas as lojas —
// status e dado, nao depende do toggle matcon_enabled estar ligado.
//
// Tambem roda uma vez ~1 min depois do boot: se o servidor estava fora a
// meia-noite, o dia nao fica pulado (o UPDATE e idempotente).
//
// Nao manda mensagem nenhuma: o aviso "vencendo" e da esteira (summary
// .expiring), o vendedor decide se cobra o cliente.
//
// Kill switch MATCON_QUOTE_EXPIRY_ENABLED=false.
// ============================================================
'use strict';

const db = require('../config/database');

function habilitado() {
  return String(process.env.MATCON_QUOTE_EXPIRY_ENABLED || 'true').toLowerCase() !== 'false';
}

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

/**
 * @returns {Promise<number|null>} quantos orcamentos venceram (null = tabela ausente)
 */
async function expireMatconQuotes() {
  try {
    const { rows } = await db.query(
      `-- matcon:orcamentos-vencidos
       WITH v AS (
         UPDATE matcon_quotes
            SET status = 'expired'
          WHERE status = 'open'
            AND valid_until < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          RETURNING id
       )
       SELECT COUNT(*)::int AS n FROM v`
    );
    const n = (rows && rows[0] && rows[0].n) || 0;
    if (n > 0) console.log(`[matconQuoteExpiry] ${n} orcamento(s) vencido(s)`);
    return n;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return null; // 352 pendente
    console.error('[matconQuoteExpiry] falhou:', e && e.message);
    return null;
  }
}

let _lastDate = null;

function tick() {
  if (!habilitado()) return;
  const now = nowBRT();
  const dateStr = now.toISOString().slice(0, 10);
  // Janela 00h05–00h09 BRT; trava por data garante 1x/dia.
  if (now.getUTCHours() === 0 && now.getUTCMinutes() >= 5 && now.getUTCMinutes() < 10 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    expireMatconQuotes().catch((e) => console.error('[matconQuoteExpiry] crash:', e.message));
  }
}

let _interval = null;
let _boot = null;

function initMatconQuoteExpiryJob() {
  if (_interval) return;
  if (!habilitado()) {
    console.log('[matconQuoteExpiry] desligado por MATCON_QUOTE_EXPIRY_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, 60 * 1000);
  _boot = setTimeout(() => {
    expireMatconQuotes().catch((e) => console.error('[matconQuoteExpiry] crash:', e.message));
  }, 60 * 1000);
  if (_boot.unref) _boot.unref();
  console.log('[matconQuoteExpiry] scheduler iniciado — diario 00h05 BRT (orcamento open vencido -> expired)');
}

function stopMatconQuoteExpiryJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_boot) { clearTimeout(_boot); _boot = null; }
}

module.exports = {
  initMatconQuoteExpiryJob,
  stopMatconQuoteExpiryJob,
  expireMatconQuotes,
  _tick: tick,
};
