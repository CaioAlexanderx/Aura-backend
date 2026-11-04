// ============================================================
// AURA. — Rajada de vendas: agrupa o aviso no celular (04/11/2026)
//
// Em produção, metade das lojas faz até 3 vendas por dia e 90% até 11. Mas
// duas passam de 20, e o pico foi 145 vendas num dia. Um push por venda
// nessas lojas é uma metralhadora no bolso da dona.
//
// A regra, por empresa:
//   - a primeira venda vai na hora;
//   - abre uma janela de 60s. O que vender dentro dela só soma;
//   - no fim da janela, se somou alguma coisa, sai UM resumo
//     ("5 vendas nos últimos minutos · R$ 1.240,00") e a janela reabre,
//     para uma sequência longa virar um aviso por minuto, com totais;
//   - janela que fecha sem nada: volta ao estado inicial.
//
// Estado em memória, por processo. Com mais de uma instância cada uma
// agrupa a sua parte — o pior caso é dois resumos em vez de um, nunca uma
// venda perdida. Os timers são unref() para não segurar o processo.
// ============================================================
'use strict';

const JANELA_MS = 60 * 1000;
const janelas = new Map(); // companyId -> { n, total, ultima, timer }

function abrir(companyId, enviarResumo) {
  const j = { n: 0, total: 0, ultima: null, timer: null };
  j.timer = setTimeout(() => fechar(companyId, enviarResumo), JANELA_MS);
  if (j.timer && typeof j.timer.unref === 'function') j.timer.unref();
  janelas.set(companyId, j);
}

function fechar(companyId, enviarResumo) {
  const j = janelas.get(companyId);
  janelas.delete(companyId);
  if (!j || j.n === 0) return;
  try {
    const r = enviarResumo({ n: j.n, total: Math.round(j.total * 100) / 100, ultima: j.ultima });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (_) { /* resumo nunca derruba nada */ }
  // Reabre: a sequência que continua vira um resumo por minuto.
  abrir(companyId, enviarResumo);
}

/**
 * Registra uma venda. Devolve 'agora' quando o aviso dela deve sair na
 * hora, ou 'agrupada' quando ficou para o resumo da janela.
 *
 * @param {string} companyId
 * @param {{ total:number, id?:string }} venda
 * @param {(resumo:{n:number,total:number,ultima:object}) => any} enviarResumo
 */
function registrar(companyId, venda, enviarResumo) {
  const j = janelas.get(companyId);
  if (!j) {
    abrir(companyId, enviarResumo);
    return 'agora';
  }
  j.n += 1;
  j.total += Number(venda && venda.total) || 0;
  j.ultima = venda || null;
  return 'agrupada';
}

/** Só para teste. */
function _reset() {
  for (const j of janelas.values()) clearTimeout(j.timer);
  janelas.clear();
}

module.exports = { registrar, JANELA_MS, _reset };
