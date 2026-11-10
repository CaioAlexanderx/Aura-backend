// ============================================================
// AURA. — Telefone antes de gravar (users.phone, companies.phone,
// customers.phone) · 10/11/2026
//
// Por que existe: uma lojista digitou o número com o +55 na frente
// ("5566992384539", 13 dígitos) e o campo cortou em 11 ("55669923845"),
// perdendo o fim do número. O app e o site passam a normalizar antes de
// limitar o tamanho (utils/telefone.ts no app); este módulo faz o mesmo no
// backend para cobrir app antigo em cache, site e integrações.
//
// Formato padrão dos cadastros: 10 ou 11 dígitos, DDD + número, sem o 55.
//
// Regra (espelho de utils/telefone.ts do app):
//   1. só os dígitos contam; máscara, espaços, parênteses, hífen e "+" saem;
//   2. passou de 11 dígitos:
//        "00" na frente (discagem internacional) sai;
//        "55" na frente (código do país) sai;
//        "0" na frente (tronco) sai e, sobrando 12 ou 13, os dois primeiros
//        são o código da operadora ("0 15 11 99999-8888") e saem também;
//   3. continuou com mais de 11: NUNCA corta. Devolve erro gentil.
//
// O que fica igual: com até 11 dígitos o valor é gravado exatamente como
// veio (mesma grafia de sempre). Só o número que precisou perder o 55 (ou o
// 0) é gravado só com dígitos. Nenhum telefone já gravado é tocado aqui.
// ============================================================
'use strict';

const MAX_DIGITOS = 11;

const ERRO_TELEFONE_LONGO =
  'Esse telefone ficou com dígitos a mais. Confira, por favor: é o DDD e o número, como (66) 99238-4539.';

function soDigitos(v) {
  return String(v == null ? '' : v).replace(/\D+/g, '');
}

/** Dígitos nacionais (DDD + número), sem 55/00/0 na frente quando sobram dígitos. */
function digitosNacionais(bruto) {
  let d = soDigitos(bruto);
  if (d.length > MAX_DIGITOS && d.startsWith('00')) d = d.slice(2);
  if (d.length > MAX_DIGITOS && d.startsWith('55')) d = d.slice(2);
  if (d.length > MAX_DIGITOS && d.startsWith('0')) {
    d = d.slice(1);
    if (d.length === 12 || d.length === 13) d = d.slice(2);
  }
  return d;
}

/**
 * @param {*} bruto  telefone como veio do corpo da requisição
 * @returns {{ ok: true, valor: * } | { ok: false, code: 'PHONE_TOO_LONG', error: string }}
 *   valor: o próprio `bruto` quando já cabia (até 11 dígitos, ou vazio, ou
 *   tipo que não é texto/número); só dígitos quando perdeu o 55/0 da frente.
 */
function normalizarTelefone(bruto) {
  if (bruto === undefined || bruto === null) return { ok: true, valor: bruto };
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return { ok: true, valor: bruto };
  const todos = soDigitos(bruto);
  if (todos.length <= MAX_DIGITOS) return { ok: true, valor: bruto };
  const d = digitosNacionais(bruto);
  if (d.length > MAX_DIGITOS) return { ok: false, code: 'PHONE_TOO_LONG', error: ERRO_TELEFONE_LONGO };
  return { ok: true, valor: d };
}

/**
 * Versão que nunca recusa: para caminhos em que um telefone estranho não
 * pode derrubar a operação (cadastro com o interruptor do WhatsApp
 * desligado, por exemplo). Tira o 55 quando cabe; senão devolve como veio.
 */
function normalizarTelefoneSemRecusar(bruto) {
  const r = normalizarTelefone(bruto);
  return r.ok ? r.valor : bruto;
}

/** Mesmo número? Compara só os dígitos (para o PATCH que reenvia o que já está gravado). */
function mesmoTelefone(a, b) {
  return soDigitos(a) === soDigitos(b);
}

module.exports = {
  normalizarTelefone,
  normalizarTelefoneSemRecusar,
  digitosNacionais,
  mesmoTelefone,
  ERRO_TELEFONE_LONGO,
  MAX_DIGITOS,
};
