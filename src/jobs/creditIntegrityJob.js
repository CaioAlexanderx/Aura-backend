// ============================================================
// AURA -- Alarme diario: parcela aberta acima do saldo do crediario
//
// Criado: 07/10/2026 (incidente Valen / jackson ICL).
//
// A divergencia entre razao e parcelas cresceu de agosto a outubro sem
// ninguem ver: 36 clientes, 7 lojas, R$65 mil. Este job faz a conferencia
// todo dia e escreve no log quando encontra alguma -- uma linha por loja.
// A regra e a consulta vivem em services/credit/integrity.js.
//
// Silencio quando esta tudo certo, pelo mesmo motivo do
// creditCollectionAutoJob: job que fala todo dia treina todo mundo a
// ignorar o log. No dia em que aparecer "[creditIntegrity]", tem caso novo.
//
// Mesmo padrao dos outros jobs (setInterval + guarda de hora + trava de
// "ja rodou hoje"). 08:00 BRT: antes de as lojas abrirem. So leitura.
// ============================================================
'use strict';

const integrity = require('../services/credit/integrity');

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

const brl = (n) => 'R$' + (Number(n) || 0).toFixed(2);

/**
 * Um ciclo da conferencia. @param deps {{ db, log }} -- injetavel p/ teste.
 * @returns {Promise<{customers:number, companies:number, hidden:number}|null>}
 */
async function triggerCreditIntegrityCheck({ db, log } = {}) {
  db = db || require('../config/database');
  log = log || ((m) => console.warn(m));
  try {
    const mismatches = await integrity.findLedgerMismatches(db);
    if (!mismatches.length) return { customers: 0, companies: 0, hidden: 0 };

    const lojas = integrity.summarizeByCompany(mismatches);
    const hidden = mismatches.filter((m) => m.hidden).length;
    log(`[creditIntegrity] ${mismatches.length} cliente(s) em ${lojas.length} loja(s) com parcelas abertas acima do saldo do razao (${hidden} com saldo <= 0)`);
    for (const l of lojas) {
      log(`[creditIntegrity]   ${l.company_name} (${l.company_id}): ${l.customers} cliente(s), diferenca ${brl(l.gap)}`);
    }
    return { customers: mismatches.length, companies: lojas.length, hidden };
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return null; // schema parcial
    console.error('[creditIntegrity] fatal:', e.message);
    return null;
  }
}

let _lastDate = null;

function tick() {
  const now = nowBRT();
  const dateStr = now.toISOString().slice(0, 10);
  // Janela 8h00-8h04 BRT; a trava por data garante 1x/dia.
  if (now.getUTCHours() === 8 && now.getUTCMinutes() < 5 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    triggerCreditIntegrityCheck().catch((e) => console.error('[creditIntegrity] crash:', e.message));
  }
}

let _interval = null;

function initCreditIntegrityJob() {
  if (_interval) return;
  _interval = setInterval(tick, 60 * 1000);
  if (typeof _interval.unref === 'function') _interval.unref();
}

function stopCreditIntegrityJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { initCreditIntegrityJob, stopCreditIntegrityJob, triggerCreditIntegrityCheck };
