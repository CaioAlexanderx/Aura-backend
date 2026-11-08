// ============================================================
// AURA. — sefazSp/respTec: dados do Responsável Técnico (grupo infRespTec,
// NT 2018.005) — a empresa que desenvolve o software emissor, ou seja, a
// própria Aura, NÃO a lojista.
//
// 08/11/2026 (MG): há relatos de rejeição 972 ("Obrigatória as informações
// do responsável técnico") em MG sem o grupo. O CNPJ da Aura não está no
// código e não deve ser inventado: os dados vêm SÓ de variáveis de ambiente.
// Sem as quatro variáveis válidas → null → o XML sai sem o grupo, como
// sempre saiu. O grupo só entra em UF cujo endpoint liga a flag infRespTec
// (hoje só MG) — SP/AP nunca leem isto.
//
//   AURA_RESP_TEC_CNPJ     CNPJ da Aura (14 dígitos, com ou sem máscara)
//   AURA_RESP_TEC_CONTATO  nome da pessoa de contato (2 a 60 caracteres)
//   AURA_RESP_TEC_EMAIL    e-mail de contato (6 a 60 caracteres)
//   AURA_RESP_TEC_FONE     telefone com DDD, só dígitos (6 a 14)
//
// Sem idCSRT/hashCSRT: MG não está entre as UFs que exigem o CSRT.
// ============================================================
'use strict';

const { isValidCnpj } = require('../../utils/cnpj');

function onlyDigits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

let _avisado = false;

/**
 * Lê e valida os dados do responsável técnico.
 * @param {object} [env=process.env]
 * @returns {{cnpj,xContato,email,fone}|null} null se faltar ou estiver inválido
 */
function loadRespTec(env = process.env) {
  const cnpj = onlyDigits(env.AURA_RESP_TEC_CNPJ);
  const xContato = String(env.AURA_RESP_TEC_CONTATO || '').trim();
  const email = String(env.AURA_RESP_TEC_EMAIL || '').trim();
  const fone = onlyDigits(env.AURA_RESP_TEC_FONE);

  const problemas = [];
  if (!isValidCnpj(cnpj)) problemas.push('AURA_RESP_TEC_CNPJ');
  if (xContato.length < 2 || xContato.length > 60) problemas.push('AURA_RESP_TEC_CONTATO');
  if (email.length < 6 || email.length > 60 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problemas.push('AURA_RESP_TEC_EMAIL');
  if (fone.length < 6 || fone.length > 14) problemas.push('AURA_RESP_TEC_FONE');

  if (problemas.length) {
    if (!_avisado) {
      _avisado = true;
      console.warn(`[sefazSp/respTec] infRespTec não enviado: falta ou inválido ${problemas.join(', ')}`);
    }
    return null;
  }
  return { cnpj, xContato, email, fone };
}

module.exports = { loadRespTec };
