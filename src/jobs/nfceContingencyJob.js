// ============================================================
// AURA. — Job: retransmissão de NFC-e emitidas em contingência (S3.1)
//
// Drena nfce_pending_transmission dentro do PRAZO LEGAL (deadline_at):
// - SEFAZ autoriza (100/150) → reconciliação autorizada-tardia:
//   emissão vira 'autorizada', fila 'transmitted'.
// - SEFAZ rejeita → reconciliação REJEITADA-TARDIA (a parte que separa
//   adultos de amadores): emissão 'rejeitada' + rejection_code; fila
//   'rejected' — a telemetria/alertas (S3.3) sobem o aviso de
//   regularização pro lojista.
// - Estourou o prazo → fila 'expired', emissão 'erro' com orientação.
// - Transporte falhou → attempts++ com backoff (1min * 2^n, cap 15min).
//
// O XML transmitido é EXATAMENTE o xml_signed da contingência (tpEmis=9
// na chave e dhCont/xJust no ide) — nunca re-monta, nunca renumera.
// ============================================================
'use strict';

const BASE_MS = 60 * 1000;
const CAP_MS = 15 * 60 * 1000;
const BATCH = 10;

function backoffMs(attempts) {
  return Math.min(BASE_MS * Math.pow(2, attempts), CAP_MS);
}

/** @param deps {{ db, sefazSp, soap?, now? }} — injetável p/ teste */
async function tickContingency({ db, soap, certs, now = () => Date.now() }) {
  // deps reais resolvidas aqui (testes injetam tudo)
  const soapClient = soap || require('../services/sefazSp/soapClient');
  const certTools = certs || {
    loadCertificate: require('../services/sefazSp/certStore').loadCertificate,
  };
  const { getEndpoints } = require('../services/sefazSp/endpoints');

  const summary = { scanned: 0, transmitted: 0, rejectedLate: 0, expired: 0, retries: 0, errors: 0 };

  const { rows: queue } = await db.query(
    `SELECT q.*, e.xml_signed, e.numero, e.chave_acesso
       FROM nfce_pending_transmission q
       JOIN nfce_emissions e ON e.id = q.emission_id
      WHERE q.status = 'pending'
      ORDER BY q.queued_at ASC
      LIMIT $1`, [BATCH]);

  for (const item of queue) {
    const since = item.last_attempt_at ? new Date(item.last_attempt_at).getTime() : 0;
    if (now() - since < backoffMs(item.attempts)) continue;
    summary.scanned++;

    // prazo legal estourado
    if (now() > new Date(item.deadline_at).getTime()) {
      await db.query(`UPDATE nfce_pending_transmission SET status='expired', last_attempt_at=NOW() WHERE id=$1`, [item.id]);
      await db.query(
        `UPDATE nfce_emissions SET status='erro',
            error_message='Contingência não transmitida dentro do prazo legal. Procure seu contador para regularização.'
          WHERE id=$1`, [item.emission_id]);
      summary.expired++;
      continue;
    }

    try {
      const { rows: cfgs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [item.company_id]);
      if (!cfgs.length) { summary.errors++; continue; }
      const config = cfgs[0];
      const tpAmb = config.ambiente === 'producao' ? 1 : 2;
      const endpoints = getEndpoints(config.uf || 'SP', tpAmb);
      const { pfx, password } = await certTools.loadCertificate(db, item.company_id);

      const r = await soapClient.autorizar({
        signedNfeXml: item.xml_signed, idLote: String(item.numero), tpAmb, endpoints,
        pfx, passphrase: password,
      });

      if (r.autorizada) {
        await db.query(
          `UPDATE nfce_emissions SET status='autorizada', protocolo=$1,
              authorized_at=COALESCE(authorized_at, NOW()), transmitted_at=NOW()
            WHERE id=$2`, [r.protocolo, item.emission_id]);
        await db.query(
          `UPDATE nfce_pending_transmission SET status='transmitted', transmitted_at=NOW(),
              attempts=attempts+1, last_attempt_at=NOW() WHERE id=$1`, [item.id]);
        summary.transmitted++;
      } else if (r.rejeitada) {
        // rejeitada-tardia: venda já aconteceu — alerta de regularização
        await db.query(
          `UPDATE nfce_emissions SET status='rejeitada', rejection_code=$1,
              error_message=$2 WHERE id=$3`,
          [String(r.cStat).slice(0, 8), `[${r.cStat}] ${r.xMotivo || ''} (rejeição PÓS-VENDA em contingência — exige regularização)`, item.emission_id]);
        await db.query(
          `UPDATE nfce_pending_transmission SET status='rejected',
              attempts=attempts+1, last_attempt_at=NOW(), last_error=$2 WHERE id=$1`,
          [item.id, `[${r.cStat}] ${r.xMotivo || ''}`]);
        summary.rejectedLate++;
        console.warn(`[nfceContingency] REJEITADA-TARDIA nota ${item.numero} (${r.cStat}) — regularização necessária`);
      } else {
        // lote sem protocolo (ex.: 105 em processamento): tenta de novo
        await db.query(
          `UPDATE nfce_pending_transmission SET attempts=attempts+1, last_attempt_at=NOW(),
              last_error=$2 WHERE id=$1`, [item.id, `cStat lote ${r.cStatLote || r.cStat}`]);
        summary.retries++;
      }
    } catch (err) {
      summary.retries++;
      await db.query(
        `UPDATE nfce_pending_transmission SET attempts=attempts+1, last_attempt_at=NOW(),
            last_error=$2 WHERE id=$1`, [item.id, String(err.message).slice(0, 500)]
      ).catch(() => {});
    }
  }
  return summary;
}

let _interval = null;

function initNfceContingencyJob() {
  if (_interval) return;
  const db = require('../config/database');
  _interval = setInterval(() => {
    tickContingency({ db })
      .then((s) => {
        if (s.scanned > 0) console.log(`[nfceContingency] scanned=${s.scanned} transmitida=${s.transmitted} rejeitada-tardia=${s.rejectedLate} expirada=${s.expired} retry=${s.retries}`);
      })
      .catch((e) => console.error('[nfceContingency] tick crash:', e.message));
  }, 60 * 1000); // 1min — contingência tem prazo legal curto
  console.log('[nfceContingency] iniciado — retransmissão de notas tpEmis=9');
}

function stopNfceContingencyJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { initNfceContingencyJob, stopNfceContingencyJob, tickContingency, backoffMs };
