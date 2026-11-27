'use strict';
// ============================================================
// AURA — alerta de mensagem do WhatsApp parada em 'sending'
//
// Desde o #1134 o despacho (waOutbox.processBatch) marca a linha como
// 'sending' ANTES de falar com a Meta, e linha 'sending' nunca e reenviada
// sozinha: melhor nao mandar do que mandar duas vezes. Duas situacoes deixam
// a linha ali para sempre:
//   1. o processo caiu no meio do envio (sem wa_message_id);
//   2. a Meta aceitou e so o registro 'sent' falhou
//      (wa_message_id gravado + last_error='ENVIADO_SEM_REGISTRO').
//
// Este job olha as linhas 'sending' ha mais de 15 min:
//   - COM wa_message_id: a Meta aceitou -> marca 'sent' (so o registro faltava);
//   - SEM wa_message_id: NAO reenvia (pode ter saido). Cria um alerta para a
//     equipe Aura em alert_history (mesmo canal do 'pacote aguardando
//     ativacao manual', whatsappSaldo.avisarSuportePacoteManual) e loga.
//
// Idempotente: a linha e carimbada (UPDATE ... RETURNING atomico) com
// last_error='SENDING_PARADA_ALERTADA' antes de alertar, entao duas rodadas,
// ou duas instancias, nunca alertam a mesma linha. Se gravar o alerta falha,
// o carimbo e desfeito e a proxima rodada tenta de novo. updated_at nao e
// tocado no carimbo. Kill switch: WA_SENDING_ALERT_ENABLED=false.
// ============================================================

const TICK_MS = 5 * 60 * 1000;
const PARADA_MIN = 15;
const MARCA_ALERTADA = 'SENDING_PARADA_ALERTADA';

const SQL_RECUPERA = `-- wa:sending-parada-recupera
  UPDATE wa_outbox
     SET status = 'sent', last_error = NULL, updated_at = NOW()
   WHERE status = 'sending'
     AND wa_message_id IS NOT NULL
     AND updated_at < NOW() - ($1 || ' minutes')::interval
  RETURNING id, company_id, wa_message_id`;

// Carimba (claim) e devolve as linhas ainda nao alertadas. O carimbo em
// last_error e o que torna o job idempotente; updated_at nao e tocado.
const SQL_CLAIM = `-- wa:sending-parada-claim
  UPDATE wa_outbox
     SET last_error = '${MARCA_ALERTADA}'
   WHERE status = 'sending'
     AND wa_message_id IS NULL
     AND updated_at < NOW() - ($1 || ' minutes')::interval
     AND last_error IS DISTINCT FROM '${MARCA_ALERTADA}'
  RETURNING id, company_id, kind, source_type, template_name, updated_at`;

const SQL_UNCLAIM = `-- wa:sending-parada-unclaim
  UPDATE wa_outbox SET last_error = NULL WHERE id = $1 AND last_error = '${MARCA_ALERTADA}'`;

const SQL_ALERTA = `-- wa:sending-parada-alerta
  INSERT INTO alert_history (company_id, alert_type, severity, title, message, data)
  VALUES ($1, 'wa_outbox_sending_parada', 'warning', $2, $3, $4)`;

/**
 * Um ciclo. @param deps {{ db, log }} injetavel para teste.
 * @returns {Promise<{recuperadas:number, alertadas:number}|null>}
 */
async function verificarSendingParadas({ db, log } = {}) {
  db = db || require('../config/database');
  log = log || ((m) => console.error(m));
  try {
    const rec = await db.query(SQL_RECUPERA, [String(PARADA_MIN)]);
    const recuperadas = (rec.rows || []);
    for (const r of recuperadas) {
      console.log(`[waSendingParada] outbox=${r.id} company=${r.company_id} estava em sending com wamid=${r.wa_message_id}: marcada sent`);
    }
    const al = await db.query(SQL_CLAIM, [String(PARADA_MIN)]);
    let alertadas = 0;
    for (const r of (al.rows || [])) {
      try {
        await db.query(SQL_ALERTA, [
          r.company_id,
          'Mensagem de WhatsApp parada em envio',
          `Uma mensagem (${r.source_type || r.kind || 'sem origem'}) ficou em "sending" por mais de ${PARADA_MIN} min sem confirmacao da Meta. Nao foi reenviada, para nao duplicar. Conferir se chegou ao cliente (outbox ${r.id}).`,
          JSON.stringify({ outbox_id: r.id, kind: r.kind, source_type: r.source_type, template_name: r.template_name, parada_desde: r.updated_at }),
        ]);
        alertadas++;
        log(`[waSendingParada] outbox=${r.id} company=${r.company_id} (${r.source_type || '-'}) parada em sending ha mais de ${PARADA_MIN} min, sem wamid: alerta criado, NAO reenviada`);
      } catch (eAlerta) {
        // Sem alerta gravado, desfaz o carimbo: a proxima rodada tenta de novo.
        await db.query(SQL_UNCLAIM, [r.id]).catch(() => {});
        throw eAlerta;
      }
    }
    return { recuperadas: recuperadas.length, alertadas };
  } catch (e) {
    // 42P01/42703: schema parcial (fila ou alert_history ainda nao existem).
    if (e && (e.code === '42P01' || e.code === '42703')) return null;
    console.error('[waSendingParada] erro:', e && e.message);
    return null;
  }
}

let _interval = null;
let _running = false;

async function tick() {
  if (_running) return;
  _running = true;
  try { await verificarSendingParadas(); } finally { _running = false; }
}

function initWaSendingParadaJob() {
  if (_interval) return;
  if (String(process.env.WA_SENDING_ALERT_ENABLED || 'true') === 'false') {
    console.log('[waSendingParada] desabilitado por WA_SENDING_ALERT_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, TICK_MS);
  console.log('[waSendingParada] iniciado — confere linhas em sending a cada 5 min');
}
function stopWaSendingParadaJob() { if (_interval) { clearInterval(_interval); _interval = null; } }

module.exports = { initWaSendingParadaJob, stopWaSendingParadaJob, verificarSendingParadas, tick, PARADA_MIN, MARCA_ALERTADA };
