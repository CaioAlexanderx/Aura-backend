// ============================================================
// AURA — WhatsApp: scheduler das automáticas (tela nova, 26/11/2026)
//
// DIÁRIO, 10h BRT (janela 10h00-10h04, trava por data). Passa por cada
// loja com a automática LIGADA e chama o executor, que corta a lista e
// enfileira (a reserva do saldo mora no waOutbox.enqueue, na mesma
// transação do INSERT).
//
//   aniversario       todo dia (cada passo olha o aniversário de hoje +/- N)
//   crediario_cobrar  todo dia (avisos de parcela)
//   venda_mais        dia 1º, só se "automatico" (mesmo grupo e presente)
//   crediario_vender  no dia do mês escolhido (padrão 10)
//
// TRAVA: kill switch WA_AUTOMATICAS_ENABLED, DESLIGADO por padrão.
// Ligar para as lojas é PR próprio, com o OK do Caio. Cada automática
// também nasce desligada por loja (wa_automaticas.ligada = false).
// ============================================================
'use strict';

const db = require('../config/database');
const executor = require('../services/waAutomaticas/executor');
const publico = require('../services/waAutomaticas/publico');

function habilitado() {
  return ['1', 'true', 'sim', 'on'].includes(String(process.env.WA_AUTOMATICAS_ENABLED || '').trim().toLowerCase());
}

function devidaHoje(linha, hoje) {
  const dia = Number(hoje.slice(8, 10));
  if (linha.automatica === 'venda_mais') return dia === 1 && !!(linha.config && linha.config.automatico);
  if (linha.automatica === 'crediario_vender') return dia === Number((linha.config && linha.config.dia_do_mes) || 10);
  return true;
}

async function triggerWaAutomaticas(hoje = publico.hojeBRT()) {
  const agg = { lojas: 0, enfileiradas: 0, falhas: 0 };
  let linhas = [];
  try {
    const r = await db.query(
      `-- wa:auto-job-linhas
       SELECT company_id, automatica, config FROM wa_automaticas WHERE ligada = true ORDER BY company_id`
    );
    linhas = r.rows;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return agg;
    console.error('[waAutomaticas] fatal:', e.message);
    return agg;
  }
  const lojas = new Set();
  for (const l of linhas) {
    if (!devidaHoje(l, hoje)) continue;
    try {
      const r = await executor.rodar(l.company_id, l.automatica, { hoje });
      lojas.add(l.company_id);
      agg.enfileiradas += r.enfileiradas;
    } catch (e) {
      agg.falhas++;
      console.error('[waAutomaticas]', l.company_id, l.automatica, 'falhou:', e.message);
    }
  }
  agg.lojas = lojas.size;
  if (agg.lojas > 0) console.log(`[waAutomaticas] lojas=${agg.lojas} enfileiradas=${agg.enfileiradas} falhas=${agg.falhas}`);
  return agg;
}

let _lastDate = null;
let _interval = null;

function tick() {
  if (!habilitado()) return;
  const now = new Date(Date.now() - 3 * 3600000);
  const dateStr = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 10 && now.getUTCMinutes() < 5 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    triggerWaAutomaticas(dateStr).catch((e) => console.error('[waAutomaticas] crash:', e.message));
  }
}

function initWaAutomaticasJob() {
  if (_interval) return;
  if (!habilitado()) {
    console.log('[waAutomaticas] desligado (WA_AUTOMATICAS_ENABLED não está ligado)');
    return;
  }
  _interval = setInterval(tick, 60 * 1000);
  console.log('[waAutomaticas] scheduler iniciado — diário, 10h BRT');
}

function stopWaAutomaticasJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { initWaAutomaticasJob, stopWaAutomaticasJob, triggerWaAutomaticas, devidaHoje, habilitado };
