// ============================================================
// AURA. — Telefone brasileiro normalizado (migration 341)
//
// customers.phone_e164 guarda o telefone SÓ COM DÍGITOS e DDI 55. É a chave
// da detecção de duplicados e do cruzamento com wa_outbox na linha do tempo.
//
// ESPELHO EXATO de public.aura_phone_e164_br (migration 341), que alimenta o
// backfill e o trigger. Mudou aqui, muda lá — o teste de paridade
// (__tests__/perfilCliente.migration.test.js) roda os dois na mesma lista.
//
// Regra:
//   a. só dígitos; vazio -> null
//   b. "00" (prefixo internacional) sai e o resto precisa começar com 55;
//      "0" (tronco) sai e, sobrando 12/13 dígitos, os 2 primeiros são o
//      código da operadora (0 XX DDD número)
//   c. 12/13 dígitos começando com 55 -> tira o DDI
//   d. sobra DDD (2 dígitos, nenhum 0) + número de 8 ou 9 dígitos
//   e. NONO DÍGITO: 9 dígitos precisa começar com 9; 8 dígitos começando
//      com 6-9 é celular no formato antigo e GANHA o 9; 8 dígitos com 2-5
//      é fixo; 8 dígitos com 0/1 é inválido
//   f. resultado: 55 + DDD + número
//
// Diferença para waOutbox.normalizePhone: aquele é o endereço de ENVIO da
// Cloud API (aceita número estrangeiro e não inventa o nono dígito); este é
// a IDENTIDADE do cliente, então só aceita Brasil e completa o 9.
// ============================================================
'use strict';

function onlyDigits(v) {
  return String(v == null ? '' : v).replace(/\D+/g, '');
}

/**
 * @param {*} raw  telefone como veio (com máscara, DDI, espaços...)
 * @returns {string|null}  '55' + DDD + número, ou null
 */
function toPhoneE164BR(raw) {
  let d = onlyDigits(raw);
  if (!d) return null;

  if (d.startsWith('00')) {
    d = d.slice(2);
    if (!d.startsWith('55')) return null;
  } else if (d.startsWith('0')) {
    d = d.slice(1);
    if (d.length === 12 || d.length === 13) d = d.slice(2);
  }

  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;

  const ddd = d.slice(0, 2);
  let num = d.slice(2);
  if (!/^[1-9][1-9]$/.test(ddd)) return null;

  const first = num[0];
  if (num.length === 9) {
    if (first !== '9') return null;
  } else if ('6789'.includes(first)) {
    num = '9' + num;
  } else if (!'2345'.includes(first)) {
    return null;
  }

  return `55${ddd}${num}`;
}

/**
 * Todas as grafias com que o mesmo número pode estar gravado em tabelas que
 * usam o formato de ENVIO (wa_outbox.to_phone): com e sem o nono dígito.
 * Usado para achar as mensagens de um cliente pelo telefone.
 *
 * @param {...*} phones
 * @returns {string[]}
 */
function phoneMatchCandidates(...phones) {
  const out = new Set();
  for (const p of phones) {
    const e164 = toPhoneE164BR(p);
    if (!e164) continue;
    out.add(e164);
    // Celular: a versão sem o 9 (formato antigo) também pode estar gravada.
    if (e164.length === 13) out.add(e164.slice(0, 4) + e164.slice(5));
  }
  return [...out];
}

module.exports = { toPhoneE164BR, phoneMatchCandidates, onlyDigits };
