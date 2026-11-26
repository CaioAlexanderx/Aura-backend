// ============================================================
// AURA. — Validade do orcamento do Studio (B1c do QA de 26/11/2026)
//
// "Valido ate 25/11" vale ate o fim do dia 25/11 em Sao Paulo. Vencido e o
// dia de expires_at (em Sao Paulo) ser anterior a hoje (em Sao Paulo), a mesma
// regra do orcamento Matcon (valid_until < hoje). Funcoes puras, sem banco.
// ============================================================
'use strict';

const FUSO = 'America/Sao_Paulo';
const MSG_VENCIDO_CLIENTE = 'Este orçamento venceu. Fale com a loja para renovar.';
const MSG_VENCIDO_LOJA = 'Este orçamento venceu. Renove a validade antes de aprovar.';

/** 'YYYY-MM-DD' de um instante, no fuso de Sao Paulo. */
function diaEmSP(instante) {
  const d = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** O orcamento venceu? Sem validade (null), nunca vence. */
function vencido(expiresAt, agora = new Date()) {
  if (!expiresAt) return false;
  const dia = diaEmSP(expiresAt);
  return dia != null && dia < diaEmSP(agora);
}

/** Fim do dia (23:59:59 em Sao Paulo, UTC-3 sem horario de verao) como ISO. */
function fimDoDiaSP(dia) {
  return `${dia}T23:59:59-03:00`;
}

/** Soma dias a um 'YYYY-MM-DD' (calendario, sem fuso). */
function somarDias(dia, n) {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Dias de calendario entre dois 'YYYY-MM-DD'. */
function diasEntre(de, ate) {
  const t = (x) => { const [a, m, d] = x.split('-').map(Number); return Date.UTC(a, m - 1, d); };
  return Math.round((t(ate) - t(de)) / 86400000);
}

/** Existe no calendario? ('2026-02-30' nao). */
function diaExiste(dia) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia))) return false;
  const [a, m, d] = dia.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d));
  return t.getUTCFullYear() === a && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

module.exports = {
  FUSO, MSG_VENCIDO_CLIENTE, MSG_VENCIDO_LOJA,
  diaEmSP, vencido, fimDoDiaSP, somarDias, diasEntre, diaExiste,
};
