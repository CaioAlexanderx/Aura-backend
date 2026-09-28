// ============================================================
// AURA Studio · vídeo do orçamento expira (migration 361, 28/09/2026)
//
// O vídeo do orçamento em vídeo 3D fica guardado 30 dias ("Manter por
// mais 30 dias" prorroga). Este job apaga do R2 o arquivo dos orçamentos
// com video_expira_em no passado e limpa as colunas — é ele, e não uma
// regra de ciclo de vida do bucket, que faz a expiração: a regra do R2
// conta a idade desde o upload e não sabe da prorrogação.
//
// DIÁRIO, 03h10 BRT, e uma vez ~2 min depois do boot (idempotente).
// Lotes de 200 por rodada. Kill switch STUDIO_QUOTE_VIDEO_EXPIRY_ENABLED=false.
// ============================================================
'use strict';

const db = require('../config/database');
const r2 = require('../utils/r2Storage');

const LOTE = 200;

function habilitado() {
  return String(process.env.STUDIO_QUOTE_VIDEO_EXPIRY_ENABLED || 'true').toLowerCase() !== 'false';
}

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

/**
 * @returns {Promise<number|null>} quantos vídeos saíram (null = 361 pendente ou erro)
 */
async function expirarVideosDeOrcamento() {
  try {
    const { rows } = await db.query(
      `-- studio:orcamento-video-vencido
       SELECT id, company_id, video_key
         FROM studio_quotes
        WHERE video_key IS NOT NULL
          AND video_expira_em < NOW()
        ORDER BY video_expira_em
        LIMIT ${LOTE}`
    );
    let n = 0;
    for (const q of rows) {
      const apagou = await r2.deleteFromR2(q.video_key);
      if (!apagou || !apagou.success) continue; // tenta de novo amanhã
      await db.query(
        `UPDATE studio_quotes
            SET video_key = NULL, video_content_type = NULL, video_bytes = NULL,
                video_formato = NULL, video_expira_em = NULL
          WHERE id = $1 AND company_id = $2 AND video_key = $3`,
        [q.id, q.company_id, q.video_key]
      );
      n += 1;
    }
    if (n > 0) console.log(`[orcamentoVideoExpiry] ${n} vídeo(s) de orçamento apagado(s)`);
    return n;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return null; // 361 pendente
    console.error('[orcamentoVideoExpiry] falhou:', e && e.message);
    return null;
  }
}

let _lastDate = null;

function tick() {
  if (!habilitado()) return;
  const now = nowBRT();
  const dateStr = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 3 && now.getUTCMinutes() >= 10 && now.getUTCMinutes() < 15 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    expirarVideosDeOrcamento().catch((e) => console.error('[orcamentoVideoExpiry] crash:', e.message));
  }
}

let _interval = null;

function initOrcamentoVideoExpiryJob() {
  if (_interval) return;
  if (!habilitado()) {
    console.log('[orcamentoVideoExpiry] desligado por STUDIO_QUOTE_VIDEO_EXPIRY_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, 60 * 1000);
  if (_interval.unref) _interval.unref();
  const boot = setTimeout(() => {
    expirarVideosDeOrcamento().catch((e) => console.error('[orcamentoVideoExpiry] crash:', e.message));
  }, 2 * 60 * 1000);
  if (boot.unref) boot.unref();
}

module.exports = { initOrcamentoVideoExpiryJob, expirarVideosDeOrcamento };
