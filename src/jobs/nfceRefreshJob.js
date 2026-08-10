// ============================================================
// AURA. — Job: retry de NFC-e própria em 'processando' (S2.4)
//
// Notas da emissão própria que ficaram 'processando' (timeout ambíguo,
// SEFAZ instável) são consultadas por chave com BACKOFF exponencial:
// tentativa N espera BASE_MS * 2^N (cap 30min), máximo 10 tentativas.
// - consulta diz autorizada (100) → nota vira autorizada (sucesso tardio)
// - consulta diz rejeitada (qualquer cStat definitivo != 100/217/101) →
//   nota vira 'rejeitada' JÁ NA PRIMEIRA consulta que detectar isso —
//   não espera MAX_ATTEMPTS (a resposta da SEFAZ já é terminal, não tem
//   por que continuar tentando)
// - consulta diz não consta (217) → continua processando; o PDV pode
//   reemitir a venda (mesmo número é reusado pela regra da rota)
// - 10 tentativas sem resposta definitiva → status 'erro' com orientação
//
// Mesmo padrão do reportScheduler (setInterval + init/stop). Tick
// injetável pra teste (deps {db, sefazSp}).
// ============================================================
'use strict';

const BASE_MS = 30 * 1000;          // 30s
const CAP_MS = 30 * 60 * 1000;      // 30min
const MAX_ATTEMPTS = 10;
const BATCH = 20;

function backoffMs(attempts) {
  return Math.min(BASE_MS * Math.pow(2, attempts), CAP_MS);
}

/**
 * Um ciclo da fila. @param deps {{ db, sefazSp, now? }} — injetável p/ teste.
 * @returns resumo { scanned, authorized, rejected, stillPending, exhausted, errors }
 */
async function tickNfceRefresh({ db, sefazSp, now = () => Date.now() }) {
  const summary = { scanned: 0, authorized: 0, rejected: 0, stillPending: 0, exhausted: 0, errors: 0 };

  const { rows: pending } = await db.query(
    `SELECT e.id, e.company_id, e.chave_acesso, e.refresh_attempts, e.last_refresh_at, e.created_at
       FROM nfce_emissions e
      WHERE e.status = 'processando' AND e.xml_signed IS NOT NULL
        AND e.refresh_attempts < $1
      ORDER BY e.created_at ASC
      LIMIT $2`,
    [MAX_ATTEMPTS, BATCH]
  );

  for (const em of pending) {
    const since = em.last_refresh_at ? new Date(em.last_refresh_at).getTime() : new Date(em.created_at).getTime();
    if (now() - since < backoffMs(em.refresh_attempts)) continue; // ainda no backoff
    summary.scanned++;

    try {
      const { rows: cfgs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [em.company_id]);
      if (!cfgs.length) { summary.errors++; continue; }

      const r = await sefazSp.queryNfce({
        chave: em.chave_acesso, config: cfgs[0], db, companyId: em.company_id,
      });

      if (r.status === 'autorizado') {
        await db.query(
          `UPDATE nfce_emissions
              SET status='autorizada', protocolo=COALESCE($1, protocolo),
                  authorized_at=COALESCE(authorized_at, NOW()), transmitted_at=COALESCE(transmitted_at, NOW()),
                  refresh_attempts=refresh_attempts+1, last_refresh_at=NOW()
            WHERE id=$2`,
          [r.protocolo, em.id]
        );
        summary.authorized++;
      } else if (r.status === 'rejeitado') {
        // Resposta terminal da SEFAZ (indSinc=1 nunca deixa "ainda
        // processando" de verdade) — persiste na primeira detecção, não
        // espera MAX_ATTEMPTS. Desbloqueia reemissão imediatamente.
        await db.query(
          `UPDATE nfce_emissions
              SET status='rejeitada', rejection_code=$1, error_message=$2,
                  refresh_attempts=refresh_attempts+1, last_refresh_at=NOW()
            WHERE id=$3`,
          [r.codigo_status || null, r.motivo_status || 'Rejeitada pela SEFAZ', em.id]
        );
        summary.rejected++;
      } else {
        const isLast = em.refresh_attempts + 1 >= MAX_ATTEMPTS;
        await db.query(
          `UPDATE nfce_emissions
              SET refresh_attempts=refresh_attempts+1, last_refresh_at=NOW()
                  ${isLast ? `, status='erro', error_message='Nota não localizada na SEFAZ após ${MAX_ATTEMPTS} consultas. Reemita a venda — o número será reaproveitado.'` : ''}
            WHERE id=$1`,
          [em.id]
        );
        if (isLast) summary.exhausted++; else summary.stillPending++;
      }
    } catch (err) {
      summary.errors++;
      // erro de transporte: conta tentativa pra não martelar a SEFAZ caída
      await db.query(
        `UPDATE nfce_emissions SET refresh_attempts=refresh_attempts+1, last_refresh_at=NOW() WHERE id=$1`,
        [em.id]
      ).catch(() => {});
    }
  }
  return summary;
}

let _interval = null;

function initNfceRefreshJob() {
  if (_interval) return;
  const db = require('../config/database');
  const sefazSp = require('../services/sefazSp');
  _interval = setInterval(() => {
    tickNfceRefresh({ db, sefazSp })
      .then((s) => {
        if (s.scanned > 0) console.log(`[nfceRefresh] scanned=${s.scanned} autorizada=${s.authorized} rejeitada=${s.rejected} pendente=${s.stillPending} esgotada=${s.exhausted} erros=${s.errors}`);
      })
      .catch((e) => console.error('[nfceRefresh] tick crash:', e.message));
  }, 2 * 60 * 1000); // a cada 2min (o backoff por nota decide quem consulta)
  console.log('[nfceRefresh] iniciado — fila de notas processando (emissão própria)');
}

function stopNfceRefreshJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { initNfceRefreshJob, stopNfceRefreshJob, tickNfceRefresh, backoffMs, MAX_ATTEMPTS };
