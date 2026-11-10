// ============================================================
// AURA. — nfseNacional/config: regras da configuração por empresa
// (nfse_config, colunas da migration 429) — funções PURAS.
//
// Uma empresa está APTA a emitir pelo emissor nacional só com:
//   - certificado A1 válido em company_certificates (o MESMO cofre da
//     NFC-e própria — não existe "segundo certificado" para a NFS-e);
//   - CNPJ válido no cadastro da empresa;
//   - código IBGE do município emissor (7 dígitos);
//   - código de tributação nacional padrão (cTribNac, 6 dígitos);
//   - situação no Simples definida; para ME/EPP também o percentual
//     aproximado de tributos do Simples (pTotTribSN), que o leiaute
//     obriga em totTrib (E0712: ME/EPP não pode usar indTotTrib).
// Inscrição municipal é OPCIONAL (a API nacional não exige; o Sefin cobra
// só quando o município tem cadastro complementar no CNC — E0116).
// ============================================================
'use strict';

const { isValidCnpj } = require('../../utils/cpfCnpj');
const { cnpjDoCn } = require('../sefazSp/certCnpj');
const { normalizarSerie } = require('./dpsBuilder');
const { normalizarAliquotaIss } = require('../camposNfseDoItem');

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/**
 * Situação no Simples (opSimpNac 1/2/3) e regime de apuração.
 * Coluna explícita primeiro; senão deduz do regime_tributario/optante antigos.
 */
function resolverRegime(config = {}) {
  let op = config.op_simp_nac != null ? Number(config.op_simp_nac) : null;
  if (!op) {
    const r = String(config.regime_tributario || '').toLowerCase();
    if (r === 'mei') op = 2;
    else if (r === 'normal' || r === 'lucro_presumido' || r === 'lucro_real') op = 1;
    else if (r.startsWith('simples')) op = 3;
    else op = config.optante_simples_nacional === false ? 1 : 3;
  }
  let regAp = config.reg_ap_trib_sn != null ? Number(config.reg_ap_trib_sn) : null;
  if (op === 3 && !regAp) regAp = 1;
  if (op !== 3) regAp = null;
  const regEsp = config.reg_esp_trib != null ? Number(config.reg_esp_trib) : 0;
  return { opSimpNac: op, regApTribSN: regAp, regEspTrib: regEsp };
}

/**
 * @param {{ config, company, certInfo, now? }} p — certInfo = getCertificateInfo (sem segredo)
 * @returns {{ apta: boolean, pendencias: string[] }}
 */
function avaliarAptidao({ config, company, certInfo, now = new Date() }) {
  const pend = [];
  if (!config) return { apta: false, pendencias: ['Configuração de NFS-e não cadastrada.'] };
  if (config.provider !== 'nacional') pend.push('O emissor configurado não é o nacional.');
  if (!config.is_active) pend.push('A emissão de NFS-e está desativada nesta empresa.');

  const cnpj = onlyDigits(company && company.cnpj);
  if (!isValidCnpj(cnpj)) pend.push('CNPJ da empresa ausente ou inválido no cadastro.');

  if (!certInfo) {
    pend.push('Certificado digital A1 não enviado (Configurações > Nota Fiscal).');
  } else {
    if (certInfo.not_after && new Date(certInfo.not_after) <= now) pend.push('Certificado digital A1 vencido.');
    const doCert = cnpjDoCn(certInfo.subject_cn);
    if (doCert && cnpj && doCert !== cnpj) pend.push('O certificado A1 é de outro CNPJ.');
  }

  if (!/^\d{7}$/.test(onlyDigits(config.municipio_ibge))) pend.push('Código IBGE do município emissor (7 dígitos) não configurado.');
  if (!/^\d{6}$/.test(String(config.ctribnac_padrao || ''))) pend.push('Código de tributação nacional padrão (6 dígitos) não configurado.');

  const serie = normalizarSerie(config.serie || '1');
  if (!serie || Number(serie) < 1 || Number(serie) > 49999) pend.push('Série da DPS fora da faixa 1–49999.');

  const { opSimpNac } = resolverRegime(config);
  if (opSimpNac === 3) {
    const p = Number(config.p_tot_trib_sn);
    if (config.p_tot_trib_sn == null || !Number.isFinite(p) || p < 0 || p >= 100) {
      pend.push('Percentual aproximado de tributos do Simples (pTotTribSN) não configurado.');
    }
  }
  return { apta: pend.length === 0, pendencias: pend };
}

const AMBIENTES = new Set(['producao_restrita', 'homologacao', 'producao']);

/**
 * Valida (e normaliza) os campos do emissor nacional vindos no PUT /config.
 * Só olha o que veio. @returns {{ data: object, erros: string[] }}
 */
function validarCamposNacional(body = {}) {
  const data = {};
  const erros = [];
  if (body.ambiente !== undefined) {
    const a = String(body.ambiente || '').trim().toLowerCase();
    if (!AMBIENTES.has(a)) erros.push('ambiente deve ser producao_restrita ou producao.');
    else data.ambiente = a;
  }
  if (body.municipio_ibge !== undefined) {
    const v = onlyDigits(body.municipio_ibge);
    if (!/^\d{7}$/.test(v)) erros.push('municipio_ibge deve ter 7 dígitos.');
    else data.municipio_ibge = v;
  }
  if (body.ctribnac_padrao !== undefined) {
    const v = onlyDigits(body.ctribnac_padrao);
    if (!/^\d{6}$/.test(v)) erros.push('ctribnac_padrao deve ter 6 dígitos (ex.: 010501).');
    else data.ctribnac_padrao = v;
  }
  if (body.cnbs_padrao !== undefined) {
    const v = body.cnbs_padrao === null || body.cnbs_padrao === '' ? null : onlyDigits(body.cnbs_padrao);
    if (v !== null && !/^\d{9}$/.test(v)) erros.push('cnbs_padrao deve ter 9 dígitos.');
    else data.cnbs_padrao = v;
  }
  if (body.op_simp_nac !== undefined) {
    const v = body.op_simp_nac === null ? null : Number(body.op_simp_nac);
    if (v !== null && ![1, 2, 3].includes(v)) erros.push('op_simp_nac deve ser 1 (não optante), 2 (MEI) ou 3 (ME/EPP).');
    else data.op_simp_nac = v;
  }
  if (body.reg_ap_trib_sn !== undefined) {
    const v = body.reg_ap_trib_sn === null ? null : Number(body.reg_ap_trib_sn);
    if (v !== null && ![1, 2, 3].includes(v)) erros.push('reg_ap_trib_sn deve ser 1, 2 ou 3.');
    else data.reg_ap_trib_sn = v;
  }
  if (body.reg_esp_trib !== undefined) {
    const v = Number(body.reg_esp_trib);
    if (![0, 1, 2, 3, 4, 5, 6, 9].includes(v)) erros.push('reg_esp_trib inválido.');
    else data.reg_esp_trib = v;
  }
  if (body.p_tot_trib_sn !== undefined) {
    const v = body.p_tot_trib_sn === null ? null : Number(body.p_tot_trib_sn);
    if (v !== null && (!Number.isFinite(v) || v < 0 || v >= 100)) erros.push('p_tot_trib_sn deve ser um percentual entre 0 e 99,99.');
    else data.p_tot_trib_sn = v;
  }
  if (body.serie !== undefined) {
    const s = normalizarSerie(body.serie);
    if (!s || Number(s) < 1 || Number(s) > 49999) erros.push('serie deve estar entre 1 e 49999.');
    else data.serie = s;
  }
  if (body.next_dps_number !== undefined) {
    const v = Number(body.next_dps_number);
    if (!Number.isInteger(v) || v < 1 || v > 999999999999999) erros.push('next_dps_number deve ser inteiro positivo.');
    else data.next_dps_number = v;
  }
  // 10/11/2026 (migration 437): alíquota padrão do ISS da empresa, último
  // degrau de nota → item → empresa. Mesma régua do cadastro do item.
  if (body.default_iss_rate !== undefined) {
    const r = normalizarAliquotaIss(body.default_iss_rate);
    if (r.error || r.value === null) erros.push('default_iss_rate deve ser a alíquota do ISS em %, entre 0 e 5 (ex.: 2 ou 2,5).');
    else data.default_iss_rate = r.value;
  }
  return { data, erros };
}

module.exports = { resolverRegime, avaliarAptidao, validarCamposNacional };
